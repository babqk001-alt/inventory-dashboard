/* ═══════════════════════════════════════════════════════════════════
   auth.js — Firebase Auth + Role-Based UI Bridge
   v1.1 — 기존 AppState.assigneeName / worker-badge 완전 호환 유지

   CRITICAL 준수 사항:
   - CRITICAL 1: initFirebase()는 반드시 로그인 성공 후에만 호출
   - CRITICAL 2: rows/{fbKey}/updatedBy, done/{fbKey}/by 기존 필드 보존
   - CRITICAL 3: #worker-badge 재사용, 신규 배지 생성 금지

   XSS 수정 (v1.1):
   - loadUserList()의 onchange/onclick inline handler → data-* 속성 + 이벤트 위임

   초기화 순서:
   DOMContentLoaded
   → initFirebaseAuth()                       ← 이 파일에서 처리
      → onAuthStateChanged(user)
         → 로그인 시:
            1) loadUserProfile(uid)
            2) bridgeAuthToLegacy(user, profile)
            3) hideLoginOverlay()
            4) applyRoleBasedUI(role)
            5) updateAuthHeader()
            6) initFirebase()                 ← firebase-sync.js 함수 호출
         → 비로그인 시:
            AppState.currentUser = null
            showLoginOverlay()
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

// ══════════════════════════════════════════════════════════
// 1. 로그인 오버레이 표시/숨김
// ══════════════════════════════════════════════════════════

function showLoginOverlay() {
    const el = document.getElementById('login-overlay');
    if (el) el.style.display = 'flex';
    AppState.currentUser = null;
    document.body.style.overflow = 'hidden';

    // 재표시 시 버튼/에러/입력 상태 초기화
    const submitBtn = document.getElementById('login-submit-btn');
    if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-right-to-bracket"></i> 로그인';
    }
    const errorEl = document.getElementById('login-error');
    if (errorEl) { errorEl.textContent = ''; errorEl.style.display = 'none'; }
    const emailEl = document.getElementById('login-email');
    const pwEl    = document.getElementById('login-password');
    if (emailEl) emailEl.value = '';
    if (pwEl)    pwEl.value    = '';
}

function hideLoginOverlay() {
    const el = document.getElementById('login-overlay');
    if (el) el.style.display = 'none';
    document.body.style.overflow = '';
}

// ══════════════════════════════════════════════════════════
// 2. 사용자 프로필 로드 (/users/{uid})
// ══════════════════════════════════════════════════════════

/**
 * Firebase DB의 /users/{uid}를 읽어 프로필 반환
 * 없으면 기본 worker 프로필 자동 생성
 * @param {string} uid
 * @param {object} [_db] - firebase.database() 인스턴스 (초기화 전 임시 주입용)
 */
async function loadUserProfile(uid, _db) {
    const db = _db || (window.FirebaseSync && FirebaseSync.db) || (window.firebase && firebase.database());
    if (!db) {
        return { uid, displayName: '사용자', role: 'worker', email: '' };
    }
    try {
        const snap = await db.ref(`users/${uid}`).once('value');
        if (snap.exists()) {
            return { uid, ...snap.val() };
        } else {
            // 신규 사용자: 기본 worker 프로필 생성
            // nameSet: false → 첫 로그인 이름 설정 화면 트리거
            const authUser = window.firebase ? firebase.auth().currentUser : null;
            const defaultProfile = {
                uid,
                displayName: authUser?.displayName || authUser?.email?.split('@')[0] || '사용자',
                email:       authUser?.email || '',
                role:        'worker',
                nameSet:     false,
                createdAt:   Date.now(),
            };
            await db.ref(`users/${uid}`).set(defaultProfile);
            console.log('[Auth] 신규 프로필 생성 (이름 설정 필요):', defaultProfile.displayName);
            return defaultProfile;
        }
    } catch (e) {
        console.warn('[Auth] loadUserProfile 실패:', e.message);
        const authUser = window.firebase ? firebase.auth().currentUser : null;
        return {
            uid,
            displayName: authUser?.email?.split('@')[0] || '사용자',
            email:       authUser?.email || '',
            role:        'worker',
        };
    }
}

// ══════════════════════════════════════════════════════════
// 3. 브리지 패턴 — Auth → 기존 AppState 연결 (CRITICAL 2 준수)
// ══════════════════════════════════════════════════════════

/**
 * 로그인 성공 직후 호출.
 * 기존 AppState.assigneeName 기반 코드가 그대로 동작하도록 브리지.
 */
function bridgeAuthToLegacy(user, userProfile) {
    AppState.currentUser = {
        uid:         user.uid,
        email:       user.email,
        displayName: userProfile.displayName,
        role:        userProfile.role,
    };

    // 기존 assigneeName 기반 코드와 완전 호환
    AppState.assigneeName = userProfile.displayName;

    // localStorage에 저장된 workers/zones 마이그레이션
    const saved = localStorage.getItem('inventory_assignee_v1');
    if (saved) {
        try {
            const data = JSON.parse(saved);
            AppState.workers       = data.workers || [];
            AppState.zoneAssignees = data.zones   || {};
        } catch (_) {}
    }
    // 로그인 사용자 이름이 workers 목록에 없으면 추가
    if (!AppState.workers.includes(userProfile.displayName)) {
        AppState.workers.push(userProfile.displayName);
    }

    // localStorage 동기화 (assignee 관련 함수들이 참조)
    try {
        localStorage.setItem('inventory_assignee_v1', JSON.stringify({
            name:    AppState.assigneeName,
            workers: AppState.workers,
            zones:   AppState.zoneAssignees,
        }));
    } catch (_) {}

    console.log('[Auth] Bridge 완료 — assigneeName:', AppState.assigneeName, '/ role:', AppState.currentUser.role);
}

// ══════════════════════════════════════════════════════════
// 4. 헤더 배지 갱신 — 기존 #worker-badge 재사용 (CRITICAL 3)
// ══════════════════════════════════════════════════════════

/**
 * 기존 #worker-badge/#worker-badge-name을 Auth 사용자 정보로 갱신.
 * 새 배지를 따로 만들지 않고 기존 요소를 재사용한다 (CRITICAL 3).
 */
function updateAuthHeader() {
    const badge     = document.getElementById('worker-badge');
    const badgeName = document.getElementById('worker-badge-name');

    if (badge && badgeName && AppState.currentUser) {
        badgeName.textContent = AppState.currentUser.displayName;
        badge.style.display   = 'flex';

        const roleLabel = { admin: '관리자', teamlead: '팀장', worker: '작업자' };
        badge.title = `${AppState.currentUser.email} · ${roleLabel[AppState.currentUser.role] || AppState.currentUser.role}`;

        // 역할 태그 (1회만 생성)
        let roleTag = document.getElementById('auth-role-tag');
        if (!roleTag) {
            roleTag = document.createElement('span');
            roleTag.id        = 'auth-role-tag';
            roleTag.className = 'auth-role-tag';
            badge.appendChild(roleTag);
        }
        roleTag.textContent = roleLabel[AppState.currentUser.role] || AppState.currentUser.role;
        roleTag.className   = `auth-role-tag role-tag-${AppState.currentUser.role}`;

        // 로그아웃 버튼 — 1회만 생성 (중복 방지)
        if (!document.getElementById('auth-logout-btn')) {
            const logoutBtn     = document.createElement('button');
            logoutBtn.id        = 'auth-logout-btn';
            logoutBtn.className = 'auth-logout-btn';
            logoutBtn.title     = '로그아웃';
            logoutBtn.innerHTML = '<i class="fas fa-right-from-bracket"></i>';
            logoutBtn.addEventListener('click', handleLogout);
            badge.parentNode.insertBefore(logoutBtn, badge.nextSibling);
        }
    }

    // 담당자 패널 칩 목록/구역 배정 동기화
    if (typeof renderAssigneePanel === 'function') {
        renderAssigneePanel();
    }
}

// ══════════════════════════════════════════════════════════
// 5. 역할 기반 UI 분기
// ══════════════════════════════════════════════════════════

/**
 * role에 따라 버튼/패널 표시/숨김 적용.
 * 기존 요소를 삭제하지 않고 display만 제어.
 */
function applyRoleBasedUI(role) {
    const isWorker = (role === 'worker');
    const isAdmin  = (role === 'admin');

    // Worker에게 숨길 버튼 목록
    const workerHideIds = [
        'export-csv-btn',
        'export-excel-btn',
        'export-recount-btn',
        'export-adjustment-btn',
        'emp-refresh-btn',
        'new-comparison-btn',
        'adj-export-recount-btn',
        'adj-export-adjust-btn',
        'btn-drive-upload',
        'assignee-reset-btn',
    ];
    workerHideIds.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.display = isWorker ? 'none' : '';
    });

    // Admin 전용: 사용자 관리 버튼
    const userMgmtBtn = document.getElementById('user-manage-btn');
    if (userMgmtBtn) {
        userMgmtBtn.style.display = isAdmin ? 'inline-flex' : 'none';
    }

    // Worker: 담당자 패널 입력 잠금 (이름은 Auth 계정으로 고정)
    const assigneeInput   = document.getElementById('assignee-name-input');
    const assigneeSaveBtn = document.getElementById('assignee-save-btn');
    if (isWorker) {
        if (assigneeInput) {
            assigneeInput.disabled    = true;
            assigneeInput.placeholder = '로그인 계정으로 고정됩니다';
        }
        if (assigneeSaveBtn) assigneeSaveBtn.disabled = true;
    } else {
        if (assigneeInput) {
            assigneeInput.disabled    = false;
            assigneeInput.placeholder = '이름 입력 후 + 버튼...';
        }
        if (assigneeSaveBtn) assigneeSaveBtn.disabled = false;
    }

    // body에 role class 추가 (CSS 레벨 제어용)
    document.body.classList.remove('role-admin', 'role-teamlead', 'role-worker');
    document.body.classList.add(`role-${role}`);
}

// ══════════════════════════════════════════════════════════
// 6. Presence — 세션 접속자 등록
// ══════════════════════════════════════════════════════════

/**
 * 세션에 접속 중인 사용자를 /sessions/{id}/presence/{uid}에 기록.
 * .info/connected 리스너로 연결 끊기면 onDisconnect()로 자동 삭제.
 * @param {string} sessionId
 */
function setupPresence(sessionId) {
    if (!AppState.currentUser || !sessionId) return;
    const db = (window.FirebaseSync && FirebaseSync.db) || (window.firebase && firebase.database());
    if (!db) return;

    const uid         = AppState.currentUser.uid;
    const presenceRef = db.ref(`sessions/${sessionId}/presence/${uid}`);

    db.ref('.info/connected').on('value', snap => {
        if (!snap.val()) return;
        presenceRef.onDisconnect().remove();
        presenceRef.set({
            uid:      uid,
            name:     AppState.currentUser.displayName,
            role:     AppState.currentUser.role,
            joinedAt: Date.now(),
        }).catch(e => console.warn('[Auth] presence 등록 실패:', e.message));
    });

    console.log('[Auth] Presence 등록:', AppState.currentUser.displayName);
}

// ══════════════════════════════════════════════════════════
// 7. 첫 로그인 이름 설정 오버레이
// ══════════════════════════════════════════════════════════

function showNameSetupOverlay() {
    const el = document.getElementById('name-setup-overlay');
    if (el) el.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    setTimeout(() => {
        const input = document.getElementById('name-setup-input');
        if (input) input.focus();
    }, 150);
}

function hideNameSetupOverlay() {
    const el = document.getElementById('name-setup-overlay');
    if (el) el.style.display = 'none';
    document.body.style.overflow = '';
}

/**
 * 이름 설정 폼 제출 처리
 * DB /users/{uid}/displayName, nameSet 업데이트 후 대시보드 진입
 */
async function handleNameSetup(e) {
    e.preventDefault();
    const input     = document.getElementById('name-setup-input');
    const errorEl   = document.getElementById('name-setup-error');
    const submitBtn = document.getElementById('name-setup-submit-btn');
    const name      = (input?.value || '').trim();

    if (!name) {
        if (errorEl) { errorEl.textContent = '이름을 입력해 주세요.'; errorEl.style.display = 'block'; }
        return;
    }
    if (name.length < 2) {
        if (errorEl) { errorEl.textContent = '이름은 2글자 이상 입력해 주세요.'; errorEl.style.display = 'block'; }
        return;
    }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 저장 중...'; }
    if (errorEl) errorEl.style.display = 'none';

    try {
        const db  = (window.FirebaseSync && FirebaseSync.db) || (window.firebase && firebase.database());
        const uid = AppState.currentUser?.uid;
        if (!db || !uid) throw new Error('DB 또는 사용자 정보 없음');

        await db.ref(`users/${uid}`).update({
            displayName: name,
            nameSet:     true,
        });

        AppState.currentUser.displayName = name;
        AppState.assigneeName = name;

        if (!AppState.workers.includes(name)) {
            AppState.workers.push(name);
        }
        try {
            localStorage.setItem('inventory_assignee_v1', JSON.stringify({
                name:    name,
                workers: AppState.workers,
                zones:   AppState.zoneAssignees,
            }));
        } catch (_) {}

        hideNameSetupOverlay();
        updateAuthHeader();

        if (typeof toast === 'function') toast(`안녕하세요, ${name}님! 🎉`, 'success');
        console.log('[Auth] 이름 설정 완료:', name);

    } catch (err) {
        if (errorEl) { errorEl.textContent = '저장 실패: ' + err.message; errorEl.style.display = 'block'; }
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-check"></i> 시작하기'; }
    }
}

// ══════════════════════════════════════════════════════════
// 8. 로그인 / 로그아웃 핸들러
// ══════════════════════════════════════════════════════════

function handleLoginSubmit(e) {
    e.preventDefault();
    const email     = (document.getElementById('login-email')?.value || '').trim();
    const password  = document.getElementById('login-password')?.value || '';
    const errorEl   = document.getElementById('login-error');
    const submitBtn = document.getElementById('login-submit-btn');

    if (!email || !password) return;

    if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 로그인 중...'; }
    if (errorEl)   { errorEl.style.display = 'none'; }

    firebase.auth().signInWithEmailAndPassword(email, password)
        .catch(err => {
            let msg = '로그인 실패. 이메일/비밀번호를 확인하세요.';
            if (err.code === 'auth/user-not-found'     ||
                err.code === 'auth/wrong-password'     ||
                err.code === 'auth/invalid-credential') {
                msg = '이메일 또는 비밀번호가 올바르지 않습니다.';
            } else if (err.code === 'auth/too-many-requests') {
                msg = '너무 많은 시도. 잠시 후 다시 시도하세요.';
            } else if (err.code === 'auth/invalid-email') {
                msg = '유효하지 않은 이메일 형식입니다.';
            } else if (err.code === 'auth/user-disabled') {
                msg = '비활성화된 계정입니다. 관리자에게 문의하세요.';
            }
            if (errorEl)   { errorEl.textContent = msg; errorEl.style.display = 'block'; }
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-right-to-bracket"></i> 로그인'; }
        });
}

function handleLogout() {
    if (!confirm('로그아웃 하시겠습니까?')) return;
    // 세션 presence 정리
    if (window.FirebaseSync && FirebaseSync.sessionId && AppState.currentUser) {
        const db = FirebaseSync.db;
        if (db) {
            db.ref(`sessions/${FirebaseSync.sessionId}/presence/${AppState.currentUser.uid}`)
              .remove()
              .catch(() => {});
        }
        if (typeof leaveSession === 'function') leaveSession();
    }
    firebase.auth().signOut().catch(e => console.warn('[Auth] 로그아웃 실패:', e.message));
    // onAuthStateChanged가 null user를 받아서 showLoginOverlay() 호출
}

// ══════════════════════════════════════════════════════════
// 9. Admin 사용자 관리
// ══════════════════════════════════════════════════════════

function openUserManageModal() {
    const modal = document.getElementById('user-manage-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    loadUserList();
}

function closeUserManageModal() {
    const modal = document.getElementById('user-manage-modal');
    if (modal) modal.style.display = 'none';
}

async function loadUserList() {
    const listEl = document.getElementById('user-manage-list');
    if (!listEl) return;
    const db = (window.FirebaseSync && FirebaseSync.db) || (window.firebase && firebase.database());
    if (!db) {
        listEl.innerHTML = '<p style="color:var(--only-emp);">Firebase 연결 안됨</p>';
        return;
    }

    listEl.innerHTML = '<p style="color:var(--text-muted);padding:12px 0;">로드 중...</p>';

    try {
        const snap = await db.ref('users').once('value');
        if (!snap.exists()) {
            listEl.innerHTML = '<p style="color:var(--text-muted);">등록된 사용자가 없습니다.</p>';
            return;
        }

        const roleLabel = { admin: '관리자', teamlead: '팀장', worker: '작업자' };
        let html = '';
        snap.forEach(child => {
            const u      = child.val();
            const key    = child.key;
            const isSelf = AppState.currentUser?.uid === key;

            // XSS 수정: key를 inline onclick/onchange 에서 data-* 속성으로 이동
            html += `
            <div class="user-manage-row${isSelf ? ' is-self' : ''}">
                <div class="user-manage-info">
                    <span class="user-manage-name">${esc(u.displayName || '-')}${isSelf ? ' <span class="user-me-badge">(나)</span>' : ''}</span>
                    <span class="user-manage-email">${esc(u.email || key)}</span>
                </div>
                <div class="user-manage-actions">
                    <select class="sidebar-select user-role-select"
                        ${isSelf ? 'disabled title="본인 역할은 변경 불가"' : `data-uid="${esc(key)}"`}>
                        <option value="worker"   ${u.role === 'worker'   ? 'selected' : ''}>작업자</option>
                        <option value="teamlead" ${u.role === 'teamlead' ? 'selected' : ''}>팀장</option>
                        <option value="admin"    ${u.role === 'admin'    ? 'selected' : ''}>관리자</option>
                    </select>
                    ${isSelf ? '' : `<button class="user-delete-btn"
                        data-uid="${esc(key)}"
                        data-name="${esc(u.displayName || key)}"
                        title="DB에서 제거"><i class="fas fa-trash-alt"></i></button>`}
                </div>
            </div>`;
        });
        listEl.innerHTML = html;

        // XSS 수정: 이벤트 위임 (listEl에 1회 등록)
        listEl.querySelectorAll('.user-role-select[data-uid]').forEach(select => {
            select.addEventListener('change', (e) => {
                const uid = e.target.getAttribute('data-uid');
                updateUserRole(uid, e.target.value);
            });
        });
        listEl.querySelectorAll('.user-delete-btn[data-uid]').forEach(btn => {
            btn.addEventListener('click', () => {
                const uid  = btn.getAttribute('data-uid');
                const name = btn.getAttribute('data-name');
                deleteUserFromDB(uid, name);
            });
        });

    } catch (e) {
        listEl.innerHTML = `<p style="color:var(--only-emp);">로드 실패: ${esc(e.message)}</p>`;
    }
}

async function updateUserRole(uid, newRole) {
    const db = (window.FirebaseSync && FirebaseSync.db) || (window.firebase && firebase.database());
    if (!db) return;
    try {
        await db.ref(`users/${uid}/role`).set(newRole);
        const roleLabel = { admin: '관리자', teamlead: '팀장', worker: '작업자' };
        if (typeof toast === 'function') toast(`역할이 "${roleLabel[newRole] || newRole}"로 업데이트됐습니다.`, 'success');
    } catch (e) {
        if (typeof toast === 'function') toast('역할 업데이트 실패: ' + e.message, 'error');
    }
}

async function deleteUserFromDB(uid, displayName) {
    if (!confirm(`"${displayName}" 계정을 목록에서 제거할까요?\n\n(Firebase Auth 계정은 유지됩니다. DB 레코드만 삭제됩니다.)`)) return;
    const db = (window.FirebaseSync && FirebaseSync.db) || (window.firebase && firebase.database());
    if (!db) return;
    try {
        await db.ref(`users/${uid}`).remove();
        if (typeof toast === 'function') toast(`"${displayName}" 계정이 목록에서 제거됐습니다.`, 'success');
        loadUserList();
    } catch (e) {
        if (typeof toast === 'function') toast('제거 실패: ' + e.message, 'error');
    }
}

// ══════════════════════════════════════════════════════════
// 10. 핵심 진입점 — initFirebaseAuth() (CRITICAL 1)
//     반드시 DOMContentLoaded 맨 앞에서 호출
// ══════════════════════════════════════════════════════════

function initFirebaseAuth() {
    // Firebase SDK 없으면 기존 방식으로 폴백 (개발/테스트 환경 대비)
    if (!window.firebase) {
        console.warn('[Auth] Firebase SDK 없음 — Auth 없이 초기화');
        if (typeof initFirebase === 'function') initFirebase();
        return;
    }

    // Firebase App 초기화 (constants.js의 FIREBASE_CONFIG 참조)
    if (!firebase.apps.length) {
        firebase.initializeApp(FIREBASE_CONFIG);
    }

    // onAuthStateChanged 리스너 등록
    firebase.auth().onAuthStateChanged(async (user) => {
        if (user) {
            console.log('[Auth] ✅ 로그인 감지:', user.email);

            // [1] 사용자 프로필 로드 (/users/{uid})
            //     initFirebase() 호출 전이므로 직접 DB 참조 생성
            const _tempDb = firebase.database();
            const profile = await loadUserProfile(user.uid, _tempDb);

            // [2] 브리지: Auth → 기존 AppState (assigneeName, workers, zoneAssignees)
            bridgeAuthToLegacy(user, profile);

            // [3] 로그인 오버레이 숨김
            hideLoginOverlay();

            // [4] 첫 로그인 감지 — nameSet이 false면 이름 설정 화면 표시
            //     오버레이는 UI만 덮는 방식 — 뒤 초기화는 병렬 진행
            if (!profile.nameSet) {
                console.log('[Auth] 첫 로그인 — 이름 설정 화면 표시');
                showNameSetupOverlay();
            }

            // [5] 역할 기반 UI 적용
            applyRoleBasedUI(profile.role);

            // [6] 헤더 배지 갱신 (CRITICAL 3: 기존 #worker-badge 재사용)
            //     첫 로그인 시에는 handleNameSetup() 완료 후 재호출됨
            if (profile.nameSet) {
                updateAuthHeader();
            }

            // [7] Firebase DB 초기화 (CRITICAL 1: 반드시 여기서)
            //     내부에서 joinSession(urlSession) 도 호출됨
            if (typeof initFirebase === 'function') initFirebase();

            // [8] URL 세션 파라미터가 있으면 presence 등록
            const urlSession = new URLSearchParams(window.location.search).get('session');
            if (urlSession) {
                setupPresence(urlSession);
            }

        } else {
            // 비로그인
            console.log('[Auth] 비로그인 — 로그인 화면 표시');
            AppState.currentUser = null;
            showLoginOverlay();
        }
    });

    // 로그인 폼 이벤트 등록
    const loginForm = document.getElementById('login-form');
    if (loginForm) loginForm.addEventListener('submit', handleLoginSubmit);

    // 이름 설정 폼 이벤트 등록
    const nameSetupForm = document.getElementById('name-setup-form');
    if (nameSetupForm) nameSetupForm.addEventListener('submit', handleNameSetup);

    // 사용자 관리 모달 버튼 이벤트
    const userMgmtBtn   = document.getElementById('user-manage-btn');
    const userMgmtClose = document.getElementById('user-manage-close-btn');
    if (userMgmtBtn)   userMgmtBtn.addEventListener('click',   openUserManageModal);
    if (userMgmtClose) userMgmtClose.addEventListener('click', closeUserManageModal);
}
