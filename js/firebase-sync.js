/* ═══════════════════════════════════════════════════════════════════
   firebase-sync.js — Firebase Realtime Database 동기화

   의존: constants.js (FIREBASE_CONFIG, DB_PATH, ERROR_MESSAGES)
         state.js     (AppState, notifySubscribers)
         utils.js     (esc, toast, debounce, formatNum)

   포함 항목:
   · FirebaseSync 상태 객체
   · initFirebase()          — Firebase 초기화 (로그인 후 호출)
   · 세션 관리               — createFirebaseSession, joinSession, leaveSession
   · 행 push/수신            — pushRowToFirebase, debouncedPushRow
   · 행 잠금                 — acquireLock, releaseLock
   · 완료 처리               — toggleRowDone, _pushDoneStatus
   · UI 갱신                 — updateFirebaseSyncUI, copySessionUrl, handleFirebaseSyncBtn
   · 헬퍼                    — getFirebaseKey, findRowByFirebaseKey

   [CRITICAL 1] initFirebase()는 반드시 로그인 성공 후에만 호출하세요.
                auth.js의 bridgeAuthToLegacy() 안에서 호출됩니다.
   [CRITICAL 2] updatedBy / by 필드는 하위 호환을 위해 절대 제거하지 마세요.

   [C5] Firebase Security Rules 권장 설정 (Firebase Console에서 적용 필요):
   ─────────────────────────────────────────────────────────────────
   {
     "rules": {
       "sessions": {
         "$sessionId": {
           ".read": "auth != null",
           "meta":     { ".write": "auth != null" },
           "rows":     { ".write": "auth != null" },
           "locks":    { ".write": "auth != null" },
           "done":     { ".write": "auth != null" },
           "presence": {
             "$uid": { ".write": "auth != null && auth.uid === $uid" }
           }
         }
       },
       "users": {
         "$uid": {
           ".read":  "auth != null",
           ".write": "auth != null && (auth.uid === $uid || root.child('users/' + auth.uid + '/role').val() === 'admin')"
         }
       },
       "_ping": { ".write": "auth != null" }
     }
   }
   ─────────────────────────────────────────────────────────────────
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

// ── FirebaseSync 상태 ─────────────────────────────────────

const FirebaseSync = {
    app:             null,
    db:              null,
    sessionId:       null,
    listeners:       [],          // 해제할 리스너 함수 목록
    enabled:         false,
    lockedRows:      {},          // { fbKey: workerName | { name, ts } }
    myLockedRowId:   null,        // 내가 현재 잠근 행의 _rowId
    remoteCompleted: {},          // { fbKey: { done, by, at } }
    _pendingDoneKeys: new Set(),  // in-flight done/undone fbKey 추적 (레이스 컨디션 방지)
    _processingPaused: false,     // [C7] 비교 분석 중 원격 수신 일시 정지
    // 이름 미설정 시 세션 간 일관성 유지용 기기 고유 ID
    _deviceId: 'dev_' + Math.random().toString(36).slice(2, 8),
};

// ── Firebase 초기화 ───────────────────────────────────────

/**
 * Firebase SDK를 초기화합니다.
 * [CRITICAL 1] 이 함수는 반드시 로그인 성공 후(bridgeAuthToLegacy)에만 호출하세요.
 */
function initFirebase() {
    try {
        if (!window.firebase) {
            return;
        }
        if (!firebase.apps.length) {
            FirebaseSync.app = firebase.initializeApp(FIREBASE_CONFIG);
        } else {
            FirebaseSync.app = firebase.app();
        }
        FirebaseSync.db      = firebase.database();
        FirebaseSync.enabled = true;

        // 연결 상태 표시
        FirebaseSync.db.ref('.info/connected').on('value', snap => {
            const connected = snap.val();
            const indicator = document.getElementById('firebase-sync-indicator');
            if (indicator) {
                indicator.style.background = connected ? '#22c55e' : '#ef4444';
            }
        });

        // 쓰기 권한 테스트
        FirebaseSync.db.ref('_ping').set({ t: Date.now() })
            .catch(() => {
                toast(ERROR_MESSAGES.FB_WRITE_FAIL, 'error');
            });

        // URL 파라미터에 세션 ID가 있으면 자동 참가 (worker는 session-discovery에서 처리)
        // [H9 수정] 세션 존재 여부를 Firebase에서 확인 후 조인
        const urlSession = new URLSearchParams(window.location.search).get('session');
        const isWorker = AppState.currentUser?.role === 'worker';
        if (urlSession && !isWorker) {
            FirebaseSync.db.ref(`sessions/${urlSession}/meta`).once('value').then(snap => {
                if (snap.exists()) {
                    joinSession(urlSession, false);
                } else {
                    toast('유효하지 않은 세션 URL입니다.', 'warning');
                    const url = new URL(window.location);
                    url.searchParams.delete('session');
                    window.history.replaceState({}, '', url);
                }
            }).catch(() => joinSession(urlSession, false));  // 네트워크 오류 시 기존 동작 유지
        }

    } catch (e) {
        toast(ERROR_MESSAGES.FB_INIT_FAIL + ': ' + e.message, 'error');
    }
}

// ── 세션 관리 ─────────────────────────────────────────────

/**
 * 새 Firebase 세션을 생성합니다.
 * 비교 결과가 없으면 토스트 경고를 표시하고 중단합니다.
 */
function createFirebaseSession() {
    if (!FirebaseSync.enabled) return;
    if (!AppState.comparisonResult?.length) {
        toast(ERROR_MESSAGES.NO_COMPARISON, 'warning');
        return;
    }

    if (!FirebaseSync.sessionId) {
        const d     = new Date();
        const stamp = `${String(d.getFullYear()).slice(-2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
        FirebaseSync.sessionId = `${stamp}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    }
    localStorage.setItem('lastSessionId', FirebaseSync.sessionId);

    _setSessionUrl(FirebaseSync.sessionId);

    // 세션 메타 (데이터 소스 정보 포함 — worker 자동 접속용)
    const sessionMeta = {
        createdAt: Date.now(),
        createdBy: AppState.assigneeName || '알 수 없음',
        totalRows: AppState.comparisonResult.length,
        dataSource: {
            empUrl: typeof GSHEET_CSV_URL !== 'undefined' ? GSHEET_CSV_URL : null,
            mode: AppState.isEmpOnly ? 'emp_only' : 'emp_physical',
        },
    };
    FirebaseSync.db.ref(DB_PATH.meta(FirebaseSync.sessionId)).set(sessionMeta)
        .catch(() => toast('세션 메타 등록 실패. 재시도해주세요.', 'error'));

    _startListeners();
    updateFirebaseSyncUI();

    const copyBtn = document.getElementById('btn-copy-session');
    if (copyBtn) copyBtn.style.display = 'inline-flex';
    toast('✅ 세션 시작! 🔗 링크 버튼으로 팀원에게 공유하세요.', 'success');
}

/**
 * 기존 세션에 참가합니다.
 * @param {string}  sessionId
 * @param {boolean} [showToast=true]
 */
function joinSession(sessionId, showToast = true) {
    if (!FirebaseSync.enabled || !sessionId) return;
    FirebaseSync.sessionId = sessionId;
    localStorage.setItem('lastSessionId', sessionId);
    _setSessionUrl(sessionId);
    _startListeners();
    updateFirebaseSyncUI();
    const copyBtn = document.getElementById('btn-copy-session');
    if (copyBtn) copyBtn.style.display = 'flex';

    // Worker: 세션 참가 시 세션 전환 버튼 표시
    if (AppState.currentUser?.role === 'worker') {
        const switchBtn = document.getElementById('session-switch-btn');
        if (switchBtn) switchBtn.style.display = '';
    }

    if (showToast) toast(`세션 ${sessionId} 참가 — 실시간 동기화 중`, 'success');
}

/**
 * 현재 세션에서 나갑니다.
 */
function leaveSession() {
    if (!FirebaseSync.sessionId) return;

    // ── presence 제거: 이전 세션에 "접속 중" 표시가 남지 않도록 즉시 삭제 ──
    const oldSessionId = FirebaseSync.sessionId;
    const uid = AppState.currentUser?.uid;
    if (uid && FirebaseSync.db) {
        const presenceRef = FirebaseSync.db.ref(`sessions/${oldSessionId}/presence/${uid}`);
        presenceRef.onDisconnect().cancel();
        presenceRef.remove().catch(() => {});
    }

    _stopListeners();

    // 내가 잠근 행 모두 해제
    Object.keys(FirebaseSync.lockedRows).forEach(rowId => releaseLock(rowId));

    FirebaseSync.sessionId       = null;
    FirebaseSync.lockedRows      = {};
    AppState.remoteProgress      = {};

    const url = new URL(window.location.href);
    url.searchParams.delete('session');
    window.history.replaceState({}, '', url.toString());

    updateFirebaseSyncUI();

    const copyBtn = document.getElementById('btn-copy-session');
    if (copyBtn) copyBtn.style.display = 'none';

    // Worker: 세션 전환 버튼 숨기기 (세션 종료 시)
    const switchBtn = document.getElementById('session-switch-btn');
    if (switchBtn) switchBtn.style.display = 'none';

    // 테이블/진행률 패널 재렌더 (presence.js가 제공)
    if (typeof renderMainTable === 'function')    renderMainTable();
    if (typeof renderZoneProgress === 'function') renderZoneProgress();

    toast('실시간 동기화 종료', 'info');
}

/** URL의 session 파라미터를 갱신합니다. */
function _setSessionUrl(sessionId) {
    const url = new URL(window.location.href);
    url.searchParams.set('session', sessionId);
    window.history.replaceState({}, '', url.toString());
}

// ── 리스너 ───────────────────────────────────────────────

function _startListeners() {
    _stopListeners();
    const sid = FirebaseSync.sessionId;
    const db  = FirebaseSync.db;

    // 1) 행 변경 수신
    const rowsRef = db.ref(DB_PATH.rows(sid));
    rowsRef.on('child_changed', snap => _applyRemoteRow(snap.key, snap.val()));
    rowsRef.on('child_added',   snap => _applyRemoteRow(snap.key, snap.val()));
    FirebaseSync.listeners.push(() => rowsRef.off());

    // 2) 행 잠금 수신
    const locksRef = db.ref(DB_PATH.locks(sid));
    locksRef.on('value', snap => {
        FirebaseSync.lockedRows = snap.val() || {};
        _applyLocksToTable();
    });
    FirebaseSync.listeners.push(() => locksRef.off());

    // 3) 완료 상태 수신
    const doneRef = db.ref(DB_PATH.done(sid));
    doneRef.on('value', snap => {
        FirebaseSync.remoteCompleted = snap.val() || {};
        _syncRemoteCompletedToLocal();
        if (typeof renderMainTable === 'function') renderMainTable();
    });
    FirebaseSync.listeners.push(() => doneRef.off());
}

function _stopListeners() {
    FirebaseSync.listeners.forEach(fn => fn());
    FirebaseSync.listeners = [];
}

// ── 원격 변경 수신 ────────────────────────────────────────

/**
 * Firebase에서 수신한 행 데이터를 로컬 AppState에 적용합니다.
 * echo 방지(2초 이내 내가 push한 데이터) 및 편집 중인 행 무시 처리 포함.
 */
function _applyRemoteRow(fbKey, data) {
    // [C7] 비교 분석 중에는 원격 변경 수신을 건너뜁니다
    if (FirebaseSync._processingPaused) return;
    if (!data) return;

    const row = findRowByFirebaseKey(fbKey);
    if (!row) {
        return;
    }

    const myName = AppState.assigneeName || FirebaseSync._deviceId;

    // echo 방지: 내가 push한 데이터이고 2초 이내면 무시
    if (data.updatedBy === myName && Date.now() - (data.updatedAt || 0) < 2000) return;

    // 내가 편집 중인 행이면 무시 (잠금 기준)
    const myFbKey = getFirebaseKey(row);
    if (FirebaseSync.lockedRows[myFbKey] === myName) return;

    let changed = false;
    if (typeof data.physicalQty === 'number' && row.physicalQty !== data.physicalQty) {
        row.physicalQty = data.physicalQty;
        row.difference  = data.physicalQty - row.empQty;
        row.status      = data.status || row.status;
        changed = true;
    }
    if (data.reason !== undefined && row.reason !== data.reason) {
        row.reason = data.reason;
        changed = true;
    }
    if (data.memo !== undefined && row.memo !== data.memo) {
        row.memo = data.memo;
        changed = true;
    }

    if (!changed) return;

    // DOM 부분 업데이트
    const localId = row._rowId;
    const input = document.querySelector(`.live-qty-input[data-row-id="${localId}"]`);
    if (input && document.activeElement !== input) {
        input.value = row.physicalQty;
        input.classList.add('remote-update');
        setTimeout(() => input.classList.remove('remote-update'), 800);
    }
    const diffCell = document.querySelector(`[data-diff-cell="${localId}"]`);
    if (diffCell) {
        diffCell.className   = getDiffClass(row.difference);
        diffCell.textContent = (row.difference > 0 ? '+' : '') + formatNum(row.difference);
    }
    const statusCell = document.querySelector(`[data-status-cell="${localId}"]`);
    if (statusCell) statusCell.innerHTML = statusBadge(row.status);
    const tr = document.getElementById(`row-${localId}`);
    if (tr) tr.className = getRowClass(row.status);

    const reasonSel = document.querySelector(`.reason-select[data-row-id="${localId}"]`);
    if (reasonSel && document.activeElement !== reasonSel) reasonSel.value = row.reason || '';
    const memoInp = document.querySelector(`.memo-input[data-row-id="${localId}"]`);
    if (memoInp && document.activeElement !== memoInp) memoInp.value = row.memo || '';

    // KPI/차트 디바운스 갱신
    _debouncedRefreshKPI();
}

/** 원격 완료 상태를 로컬 completedRows에 반영합니다. */
function _syncRemoteCompletedToLocal() {
    AppState.comparisonResult.forEach(r => {
        const fbKey = getFirebaseKey(r);
        // in-flight 변경 중인 키는 로컬 상태를 신뢰 (optimistic concurrency)
        if (FirebaseSync._pendingDoneKeys.has(fbKey)) return;

        if (FirebaseSync.remoteCompleted[fbKey]) {
            AppState.completedRows.add(r._rowId);
        } else {
            AppState.completedRows.delete(r._rowId);
        }
    });
    notifySubscribers('completedRows', AppState.completedRows, null);
}

// ── 로컬 → Firebase push ─────────────────────────────────

/**
 * 단일 행을 Firebase에 push합니다. (SKU + 위치 기반 stableKey 사용)
 * @param {string} rowId - AppState row의 _rowId
 */
function pushRowToFirebase(rowId) {
    if (!FirebaseSync.enabled || !FirebaseSync.sessionId) return;
    const row = AppState.comparisonResult.find(r => r._rowId === rowId);
    if (!row) return;

    const fbKey = getFirebaseKey(row);

    FirebaseSync.db.ref(DB_PATH.rowItem(FirebaseSync.sessionId, fbKey)).update({
        physicalQty: row.physicalQty,
        status:      row.status,
        reason:      row.reason || '',
        memo:        row.memo   || '',
        sku:         row.sku    || '',
        location:    row.location || '',
        // [CRITICAL 2] 하위 호환 필드 — 절대 제거 금지
        updatedBy:         AppState.assigneeName || FirebaseSync._deviceId,
        updatedAt:         Date.now(),
        // [Auth v1.0] 신규 필드 (기존 필드 대체 아님)
        lastUpdatedByUid:  AppState.currentUser?.uid         || null,
        lastUpdatedByName: AppState.currentUser?.displayName || null,
    })
    .catch(() => {
        toast('동기화 실패 — 네트워크/권한 확인', 'error');
    });
}

/** 행 push 디바운스 (400ms). 빠른 타이핑 시 과도한 write 방지. */
const _rowPushTimers = {};
function debouncedPushRow(rowId) {
    clearTimeout(_rowPushTimers[rowId]);
    _rowPushTimers[rowId] = setTimeout(() => pushRowToFirebase(rowId), 400);
}

/** 구역 진행률 push — 행 단위 push로 대체됨 (no-op 유지, 외부 호출 호환). */
function debouncedPushToFirebase() { /* no-op */ }

// ── 헬퍼 ─────────────────────────────────────────────────

/**
 * 행에 대한 Firebase 안정 키를 생성합니다.
 * SKU + 위치 + 구역 기반 → 기기가 달라도 동일한 키 보장.
 * Firebase 키 사용 불가 문자(. # $ / [ ]) 제거.
 * @param   {Object} row
 * @returns {string}
 */
function getFirebaseKey(row) {
    const raw = `${row.sku || ''}_${row.location || ''}_${row.warehouseZone || ''}`;
    const cleaned = raw.replace(/[.#$\/\[\]\s]/g, '_');
    // [C2 수정] 100자 이하면 그대로, 초과 시 djb2 해시 접미사로 고유성 보장
    if (cleaned.length <= 100) return cleaned || row._rowId;
    let hash = 5381;
    for (let i = 0; i < cleaned.length; i++) {
        hash = ((hash << 5) + hash + cleaned.charCodeAt(i)) >>> 0;
    }
    return (cleaned.slice(0, 80) + '_' + hash.toString(16).padStart(8, '0')) || row._rowId;
}

/**
 * Firebase 키에 해당하는 로컬 row를 반환합니다.
 * 1) stableKey 매칭 → 2) _rowId 폴백
 * @param   {string}      fbKey
 * @returns {Object|null}
 */
function findRowByFirebaseKey(fbKey) {
    const byStable = AppState.comparisonResult.find(r => getFirebaseKey(r) === fbKey);
    if (byStable) return byStable;
    return AppState.comparisonResult.find(r => r._rowId === fbKey) || null;
}

// ── Firebase → 로컬 일괄 복원 ────────────────────────────

/**
 * 세션의 Firebase rows 데이터를 일괄 읽어 로컬 comparisonResult에 병합합니다.
 * 세션 재접속 시 비교 분석 후 physicalQty/reason/memo를 복원하는 데 사용합니다.
 * @param {string} sessionId
 * @returns {Promise<number>} 복원된 행 수
 */
async function restoreRowsFromFirebase(sessionId) {
    if (!FirebaseSync.db || !sessionId) return 0;
    if (!AppState.comparisonResult?.length) return 0;

    try {
        const snap = await FirebaseSync.db.ref(DB_PATH.rows(sessionId)).once('value');
        const allRows = snap.val();
        if (!allRows) {
            console.warn('[FB] restoreRowsFromFirebase: Firebase rows 비어있음 (sessionId:', sessionId, ')');
            return 0;
        }

        const fbKeys = Object.keys(allRows);
        console.log(`[FB] restoreRowsFromFirebase: Firebase에 ${fbKeys.length}건 rows 발견`);

        let restored = 0;
        let notMatched = 0;
        fbKeys.forEach(fbKey => {
            const data = allRows[fbKey];
            if (!data) return;

            const row = findRowByFirebaseKey(fbKey);
            if (!row) {
                notMatched++;
                return;
            }

            // physicalQty 복원 (0이 아닌 값만 — 0은 초기값이므로 덮어쓸 필요 없음)
            if (typeof data.physicalQty === 'number' && data.physicalQty !== 0) {
                row.physicalQty = data.physicalQty;
                row.difference  = data.physicalQty - (row.empQty || 0);
                row.status      = data.physicalQty === row.empQty ? 'MATCH' : 'MISMATCH';
                restored++;
            }
            // reason / memo 복원
            if (data.reason) row.reason = data.reason;
            if (data.memo)   row.memo   = data.memo;
        });

        if (notMatched > 0) {
            console.warn(`[FB] restoreRowsFromFirebase: ${notMatched}건 키 매칭 실패`);
        }

        // filteredResult도 동기화
        if (restored > 0) {
            AppState.filteredResult = [...AppState.comparisonResult];
        }

        return restored;
    } catch (e) {
        console.warn('[FB] restoreRowsFromFirebase 실패:', e.message);
        return 0;
    }
}

// ── 행 잠금 ─────────────────────────────────────────────

/**
 * 행 편집 잠금을 획득합니다.
 * - 다른 사람이 잠금 중: false 반환 (토스트 표시)
 * - 내가 이전 행 잠금 중: 이전 행 즉시 해제
 * - Firebase 세션 없음: 항상 true
 * @param   {string}  rowId
 * @returns {boolean}
 */
function acquireLock(rowId) {
    if (!FirebaseSync.enabled || !FirebaseSync.sessionId) return true;

    const LOCK_TTL = 5 * 60 * 1000;  // [C6] 5분 TTL
    const myName   = AppState.assigneeName || FirebaseSync._deviceId;
    const lockRow  = AppState.comparisonResult.find(r => r._rowId === rowId);
    const fbLockKey = lockRow ? getFirebaseKey(lockRow) : rowId;
    const currentLock = FirebaseSync.lockedRows[fbLockKey];

    // [C6 수정] 잠금 확인 시 TTL 적용 (오브젝트/문자열 호환)
    if (currentLock) {
        const lockerName = typeof currentLock === 'object' ? currentLock.name : currentLock;
        const lockTs     = typeof currentLock === 'object' ? currentLock.ts   : 0;
        if (lockerName && lockerName !== myName) {
            // TTL 초과한 stale 잠금은 강제 해제
            if (lockTs && Date.now() - lockTs > LOCK_TTL) {
                // stale lock — TTL 초과, 강제 해제
            } else {
                toast(`${lockerName}님이 수정 중입니다.`, 'warning');
                return false;
            }
        }
    }

    // 다른 행에서 이 행으로 이동한 경우 이전 행 잠금 해제
    if (FirebaseSync.myLockedRowId && FirebaseSync.myLockedRowId !== rowId) {
        releaseLock(FirebaseSync.myLockedRowId);
    }

    FirebaseSync.myLockedRowId = rowId;

    // [C6] timestamp 포함 잠금 데이터 저장
    FirebaseSync.db
        .ref(DB_PATH.lockItem(FirebaseSync.sessionId, fbLockKey))
        .set({ name: myName, ts: Date.now() });

    return true;
}

/**
 * 행 편집 잠금을 즉시 해제합니다.
 * 내가 잠근 행만 해제합니다.
 * @param {string} rowId
 */
function releaseLock(rowId) {
    if (!FirebaseSync.enabled || !FirebaseSync.sessionId) return;
    const myName   = AppState.assigneeName || FirebaseSync._deviceId;
    const lockRow  = AppState.comparisonResult.find(r => r._rowId === rowId);
    const fbLockKey = lockRow ? getFirebaseKey(lockRow) : rowId;
    const currentLock = FirebaseSync.lockedRows[fbLockKey];

    // [C6] 오브젝트/문자열 호환
    const lockerName = typeof currentLock === 'object' ? currentLock?.name : currentLock;
    if (!lockerName || lockerName === myName) {
        FirebaseSync.db
            .ref(DB_PATH.lockItem(FirebaseSync.sessionId, fbLockKey))
            .remove();
    }
    if (FirebaseSync.myLockedRowId === rowId) {
        FirebaseSync.myLockedRowId = null;
    }
}

/** 잠금 상태를 현재 렌더링된 테이블 행에 반영합니다. */
function _applyLocksToTable() {
    const myName = AppState.assigneeName || FirebaseSync._deviceId;
    const locks  = FirebaseSync.lockedRows || {};

    document.querySelectorAll('#main-table-body tr').forEach(tr => {
        const rowId = tr.id?.replace('row-', '');
        if (!rowId) return;

        const row        = AppState.comparisonResult.find(r => r._rowId === rowId);
        const fbKey      = row ? getFirebaseKey(row) : rowId;
        const lockVal    = locks[fbKey];
        // [C6] 오브젝트({ name, ts }) / 문자열 호환 처리
        const locker     = typeof lockVal === 'object' ? lockVal?.name : lockVal;
        const lockedByOther = !!(locker && locker !== myName);

        tr.classList.toggle('row-locked', lockedByOther);
        tr.title = lockedByOther ? `${locker}님이 수정 중` : '';

        tr.querySelectorAll('.live-qty-input, .qty-btn, .reason-select, .memo-input').forEach(el => {
            el.disabled = lockedByOther;
        });

        const existingBadge = tr.querySelector('.lock-badge');
        if (lockedByOther) {
            if (!existingBadge) {
                const badge = document.createElement('div');
                badge.className   = 'lock-badge';
                badge.innerHTML   = `<i class="fas fa-lock"></i> ${esc(locker)}`;
                tr.style.position = 'relative';
                tr.appendChild(badge);
            } else {
                existingBadge.innerHTML = `<i class="fas fa-lock"></i> ${esc(locker)}`;
            }
        } else if (existingBadge) {
            existingBadge.remove();
        }
    });
}

// ── 완료 처리 ────────────────────────────────────────────

/**
 * 행 완료 상태를 토글합니다.
 * - 완료: 잠금 해제 → Firebase 저장 → 성공 비프
 * - 완료 취소: Firebase 제거
 * @param {string} rowId
 */
function toggleRowDone(rowId) {
    const isDone = AppState.completedRows.has(rowId);
    const row    = AppState.comparisonResult.find(r => r._rowId === rowId);
    if (!row) return;

    // 스크롤 위치 보존
    const scrollParent  = document.querySelector('.main-content') || document.documentElement;
    const savedScrollTop = scrollParent.scrollTop;

    // 완료 전 편집 중인 수량을 먼저 AppState에 반영
    const pendingInput = document.querySelector(`.live-qty-input[data-row-id="${rowId}"]`);
    if (pendingInput) {
        const pendingQty  = Math.max(0, safeInt(pendingInput.value));
        row.physicalQty   = pendingQty;
        row.difference    = pendingQty - row.empQty;
        row._touched      = true;
        if (row.status !== 'ONLY_IN_PHYSICAL' && row.status !== 'LOCATION_SHIFT') {
            row.status = row.difference === 0 ? 'MATCH' : 'MISMATCH';
        }
        pendingInput.blur();
    } else {
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT')) {
            activeEl.blur();
        }
    }

    if (isDone) {
        AppState.completedRows.delete(rowId);
        notifySubscribers('completedRows', AppState.completedRows, null);
        _pushDoneStatus(row, false);
        toast(`"${row.sku}" 완료 취소`, 'info');
    } else {
        // 수량 0 경고
        if (row.physicalQty === 0 && row.empQty > 0) {
            if (!window.confirm(`"${row.sku}" 실사 수량이 0입니다.\n수량을 입력하지 않았을 수 있습니다.\n그래도 0으로 완료하시겠습니까?`)) {
                const qtyInput = document.querySelector(`.live-qty-input[data-row-id="${rowId}"]`);
                if (qtyInput) { qtyInput.focus(); qtyInput.select(); }
                return;
            }
        }
        AppState.completedRows.add(rowId);
        notifySubscribers('completedRows', AppState.completedRows, null);
        releaseLock(rowId);
        _pushDoneStatus(row, true);
        toast(`✅ "${row.sku}" 완료!`, 'success');
        playBeepSuccess();
    }

    _rerenderDoneRow(rowId);
    triggerAutoSave();
    debouncedPushRow(rowId);

    requestAnimationFrame(() => { scrollParent.scrollTop = savedScrollTop; });
}

/**
 * Firebase에 완료 상태를 push 또는 제거합니다.
 * @param {Object}  row
 * @param {boolean} done
 */
function _pushDoneStatus(row, done) {
    if (!FirebaseSync.enabled || !FirebaseSync.sessionId) return;
    const fbKey = getFirebaseKey(row);
    FirebaseSync._pendingDoneKeys.add(fbKey);
    if (done) {
        FirebaseSync.db.ref(DB_PATH.doneItem(FirebaseSync.sessionId, fbKey)).set({
            done: true,
            // [CRITICAL 2] 하위 호환 필드 — 절대 제거 금지
            by:   AppState.assigneeName || FirebaseSync._deviceId,
            at:   Date.now(),
            // [Auth v1.0] 신규 필드
            uid:  AppState.currentUser?.uid         || null,
            name: AppState.currentUser?.displayName || null,
        })
        .then(() => FirebaseSync._pendingDoneKeys.delete(fbKey))
        .catch(() => {
            FirebaseSync._pendingDoneKeys.delete(fbKey);
            toast('완료 상태 동기화 실패.', 'error');
        });
    } else {
        FirebaseSync.db.ref(DB_PATH.doneItem(FirebaseSync.sessionId, fbKey))
            .remove()
            .then(() => FirebaseSync._pendingDoneKeys.delete(fbKey))
            .catch(() => {
                FirebaseSync._pendingDoneKeys.delete(fbKey);
                toast('완료 취소 동기화 실패.', 'error');
            });
    }
}

/**
 * 완료 상태 변경 후 해당 행의 live-qty-cell만 재렌더합니다.
 * table-renderer.js의 renderMainTable() 호출 없이 부분 업데이트합니다.
 * @param {string} rowId
 */
function _rerenderDoneRow(rowId) {
    const row = AppState.comparisonResult.find(r => r._rowId === rowId);
    const tr  = document.getElementById(`row-${rowId}`);
    if (!row || !tr) {
        if (typeof renderMainTable === 'function') renderMainTable();
        return;
    }

    const isDone = AppState.completedRows.has(rowId)
                || !!(FirebaseSync.remoteCompleted && FirebaseSync.remoteCompleted[getFirebaseKey(row)]);

    tr.classList.toggle('row-done', isDone);

    const cell = tr.querySelector('.live-qty-cell');
    if (!cell) return;

    if (isDone) {
        cell.innerHTML = `
            <span class="done-qty">${formatNum(row.physicalQty)}</span>
            <button type="button" class="qty-btn qty-done is-done" data-row-id="${rowId}" title="완료 취소">✓</button>`;
        tr.querySelector('.reason-select')?.setAttribute('disabled', '');
        tr.querySelector('.memo-input')?.setAttribute('disabled', '');
    } else {
        cell.innerHTML = `
            <button type="button" class="qty-btn qty-minus" data-row-id="${rowId}" title="−1">−</button>
            <input type="number" class="live-qty-input" data-row-id="${rowId}" value="${row.physicalQty}" min="0" step="1">
            <button type="button" class="qty-btn qty-plus"  data-row-id="${rowId}" title="+1">+</button>
            <button type="button" class="qty-btn qty-done"  data-row-id="${rowId}" title="완료">✓</button>`;
        tr.querySelector('.reason-select')?.removeAttribute('disabled');
        tr.querySelector('.memo-input')?.removeAttribute('disabled');
    }
    // tbody 위임 리스너(initMainTableDelegation)가 버블링으로 이벤트 처리 — 재연결 불필요
}

// ── UI 갱신 ──────────────────────────────────────────────

/** Firebase 동기화 버튼 및 세션 레이블 UI를 갱신합니다. */
function updateFirebaseSyncUI() {
    const btn          = document.getElementById('firebase-sync-btn');
    const indicator    = document.getElementById('firebase-sync-indicator');
    const sessionLabel = document.getElementById('firebase-session-label');
    const active = !!FirebaseSync.sessionId;

    if (btn) {
        btn.innerHTML = active
            ? '<i class="fas fa-tower-broadcast"></i> 동기화 중'
            : '<i class="fas fa-tower-broadcast"></i> 실시간 동기화';
        btn.classList.toggle('syncing', active);
    }
    if (indicator)    indicator.style.display    = active ? 'inline-block' : 'none';
    if (sessionLabel) sessionLabel.textContent   = active ? `세션: ${FirebaseSync.sessionId}` : '';
}

/**
 * 현재 세션 URL을 클립보드에 복사합니다.
 * 클립보드 API 미지원 시 prompt()로 폴백합니다.
 */
function copySessionUrl() {
    if (!FirebaseSync.sessionId) { toast('먼저 동기화를 시작하세요.', 'warning'); return; }
    const url = new URL(window.location.href);
    url.searchParams.set('session', FirebaseSync.sessionId);
    navigator.clipboard.writeText(url.toString())
        .then(() => toast('세션 URL 복사됨! 팀원에게 공유하세요.', 'success'))
        .catch(() => prompt('URL을 복사하세요:', url.toString()));
}

/**
 * 동기화 버튼 클릭 핸들러.
 * 세션 중: 복사 또는 종료 선택 / 미세션: 세션 생성
 */
function handleFirebaseSyncBtn() {
    if (!FirebaseSync.enabled) { toast('Firebase를 사용할 수 없습니다.', 'error'); return; }
    if (FirebaseSync.sessionId) {
        const action = window.confirm(
            `현재 세션: ${FirebaseSync.sessionId}\n\n` +
            `[확인] 세션 URL 복사 (팀원 공유)\n[취소] 동기화 종료`
        );
        action ? copySessionUrl() : leaveSession();
    } else {
        // 오늘 날짜의 이전 세션이 있으면 복귀 선택지 제공
        const last = localStorage.getItem('lastSessionId');
        const d = new Date();
        const todayPrefix = `${String(d.getFullYear()).slice(-2)}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
        if (last && last.startsWith(todayPrefix)) {
            const choice = confirm(
                `이전 세션(${last})이 있습니다.\n\n` +
                `[확인] 이전 세션 복귀\n[취소] 새 세션 생성`
            );
            if (choice) {
                joinSession(last);
                if (typeof setupPresence === 'function') setupPresence(last);
                return;
            }
        }
        createFirebaseSession();
    }
}

// ── KPI 디바운스 갱신 ────────────────────────────────────
// 원격 수신 시 빈번한 KPI/차트 리렌더를 방지합니다.

const _debouncedRefreshKPI = debounce(() => {
    if (typeof renderKPIs === 'function')        renderKPIs(AppState.comparisonResult);
    if (typeof renderZoneProgress === 'function') renderZoneProgress();
    triggerAutoSave();
}, 300);
