/**
 * session-discovery.js
 * 작업자(worker) 로그인 시 활성 세션을 자동 검색하고 연결하는 모듈.
 * - 로그인 후 동기화 오버레이 표시 → 세션 목록 → 선택 → 자동 접속
 * - 작업 중 세션 전환 모달 지원
 */

// ── 상수 ──────────────────────────────────────────────────
const SESSION_DISCOVER_TIMEOUT = 8000; // 세션 검색 타임아웃 (ms)
const PRESENCE_STALE_LIMIT = 2 * 60 * 60 * 1000; // 2시간 (stale presence 필터)

// ── 세션 검색 ─────────────────────────────────────────────

/**
 * Firebase에서 오늘 날짜의 활성 세션을 검색합니다.
 * @returns {Promise<Array<{sessionId, meta, onlineCount}>>}
 */
async function discoverActiveSessions() {
    const db = firebase.database();
    const now = Date.now();

    // 오늘 날짜 YYMMDD 접두사
    const d = new Date();
    const todayPrefix = `${String(d.getFullYear()).slice(-2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

    try {
        const result = await Promise.race([
            db.ref('sessions').once('value'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), SESSION_DISCOVER_TIMEOUT))
        ]);

        const allSessions = result.val();
        if (!allSessions) return [];

        const sessions = [];

        Object.keys(allSessions).forEach(sessionId => {
            // 오늘 날짜 세션만 필터
            if (!sessionId.startsWith(todayPrefix)) return;

            const session = allSessions[sessionId];
            const meta = session.meta || {};

            // meta가 없으면 유효한 세션이 아님
            if (!meta.createdAt) return;

            // presence 카운트 (stale 항목 제외)
            let onlineCount = 0;
            const presence = session.presence || {};
            Object.values(presence).forEach(p => {
                const joinedAt = p.joinedAt || 0;
                if (now - joinedAt < PRESENCE_STALE_LIMIT) {
                    onlineCount++;
                }
            });

            sessions.push({
                sessionId,
                meta: {
                    createdAt: meta.createdAt,
                    createdBy: meta.createdBy || '알 수 없음',
                    totalRows: meta.totalRows || 0,
                },
                onlineCount,
            });
        });

        // 온라인 인원 많은 순 → 생성시간 최신 순
        sessions.sort((a, b) => {
            if (b.onlineCount !== a.onlineCount) return b.onlineCount - a.onlineCount;
            return b.meta.createdAt - a.meta.createdAt;
        });

        return sessions;
    } catch (e) {
        return [];
    }
}

// ── 동기화 오버레이 UI ────────────────────────────────────

function showSyncOverlay() {
    const overlay = document.getElementById('session-sync-overlay');
    if (overlay) {
        overlay.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }
    // 초기 상태 리셋
    const loading = document.getElementById('sync-loading');
    const list = document.getElementById('sync-session-list');
    const noSession = document.getElementById('sync-no-session');
    if (loading) loading.style.display = '';
    if (list) list.style.display = 'none';
    if (noSession) noSession.style.display = 'none';

    // 단계 인디케이터 리셋
    document.querySelectorAll('#sync-steps .sync-step').forEach(el => {
        el.classList.remove('active', 'done');
    });
}

function hideSyncOverlay() {
    const overlay = document.getElementById('session-sync-overlay');
    if (overlay) overlay.style.display = 'none';
    document.body.style.overflow = '';
}

/**
 * 단계 인디케이터 업데이트
 * @param {number} stepIndex - 현재 활성 단계 (0~3)
 */
function updateSyncStep(stepIndex) {
    const steps = document.querySelectorAll('#sync-steps .sync-step');
    const title = document.getElementById('sync-step-title');

    steps.forEach((el, i) => {
        el.classList.remove('active', 'done');
        if (i < stepIndex) el.classList.add('done');
        if (i === stepIndex) el.classList.add('active');
    });

    // 타이틀 업데이트
    const titles = ['로그인 확인 중...', '세션 검색 중...', '세션 연결 중...', 'EMP 데이터 로딩 중...', '비교 분석 중...', '연결 완료!'];
    if (title && titles[stepIndex]) title.textContent = titles[stepIndex];
}

// ── 세션 피커 렌더링 ──────────────────────────────────────

/**
 * 세션 목록 카드 렌더링
 * @param {Array} sessions - discoverActiveSessions 결과
 * @param {string|null} currentSessionId - 현재 세션 ID (전환 모달용)
 * @param {HTMLElement} containerEl - 렌더링 대상 요소
 * @param {'overlay'|'modal'} mode - 오버레이 모드 vs 전환 모달 모드
 */
function renderSessionPicker(sessions, currentSessionId, containerEl, mode) {
    if (!containerEl) return;

    let html = '';

    if (mode === 'overlay') {
        html += '<p class="sync-picker-label">참여할 세션을 선택하세요</p>';
    }

    sessions.forEach(s => {
        const isCurrent = s.sessionId === currentSessionId;
        const timeAgo = _formatTimeAgo(s.meta.createdAt);
        const statusBadge = s.onlineCount > 0
            ? `<span class="sync-session-badge"><span class="sync-badge-dot active"></span>${s.onlineCount}명 접속 중</span>`
            : `<span class="sync-session-badge"><span class="sync-badge-dot waiting"></span>대기 중</span>`;
        const currentTag = isCurrent
            ? '<span class="sync-session-current-tag">현재 세션</span>'
            : '';

        html += `<div class="sync-session-item${isCurrent ? ' current' : ''}"
                      data-session-id="${s.sessionId}"
                      data-mode="${mode}"
                      onclick="handleSessionItemClick(this)">
            <div class="sync-session-info">
                <div class="sync-session-id">${_esc(s.sessionId)} ${currentTag}</div>
                <div class="sync-session-meta">
                    <span><i class="fas fa-user-shield"></i> ${_esc(s.meta.createdBy)}</span>
                    <span><i class="fas fa-clock"></i> ${timeAgo}</span>
                    <span><i class="fas fa-table-list"></i> ${s.meta.totalRows.toLocaleString()}건</span>
                </div>
            </div>
            ${statusBadge}
        </div>`;
    });

    containerEl.innerHTML = html;
    containerEl.style.display = '';
}

// ── 세션 선택 핸들러 ──────────────────────────────────────

/**
 * 세션 카드 클릭 핸들러 (동기화 오버레이 & 전환 모달 공통)
 */
function handleSessionItemClick(el) {
    const sessionId = el.dataset.sessionId;
    const mode = el.dataset.mode;

    if (!sessionId) return;

    if (mode === 'modal') {
        // 전환 모달: 현재 세션이면 무시
        if (sessionId === FirebaseSync.sessionId) return;
        switchToSession(sessionId);
    } else {
        // 오버레이: 세션 선택 → 연결
        selectSession(sessionId);
    }
}

/**
 * 오버레이에서 세션 선택 → 연결 → 데이터 자동 로딩
 */
async function selectSession(sessionId) {
    const loading = document.getElementById('sync-loading');
    const list = document.getElementById('sync-session-list');
    if (loading) loading.style.display = '';
    if (list) list.style.display = 'none';

    const spinner = loading ? loading.querySelector('.sync-spinner') : null;
    if (spinner) spinner.style.display = '';

    updateSyncStep(2); // "세션 연결 중..."

    try {
        // [1] 세션 참가 + presence 등록
        if (typeof joinSession === 'function') joinSession(sessionId, false);
        if (typeof setupPresence === 'function') setupPresence(sessionId);

        // 세션 전환 버튼 표시
        const switchBtn = document.getElementById('session-switch-btn');
        if (switchBtn) switchBtn.style.display = '';

        // [2] 세션 메타에서 dataSource 확인 → EMP 자동 로딩
        updateSyncStep(3); // "EMP 데이터 로딩 중..."
        const dataLoaded = await _autoLoadSessionData(sessionId);

        if (dataLoaded) {
            // [3] 비교 분석 자동 실행
            updateSyncStep(4); // "비교 분석 중..."
            await _autoRunComparison();
        }

        updateSyncStep(5); // "완료!"
        await _delay(500);
        hideSyncOverlay();

        // [항상] 세션 참가 후 대시보드로 이동 (작업자는 업로드 화면 불필요)
        if (typeof switchPhase === 'function') switchPhase('dashboard');
        if (typeof switchView === 'function') switchView('scoreboard');

        if (dataLoaded && AppState.comparisonResult?.length) {
            // EMP 자동 로딩 성공 → 전체 렌더링
            if (typeof populateZoneFilter === 'function') populateZoneFilter(AppState.comparisonResult);
            if (typeof renderMainTable === 'function') renderMainTable();
            if (typeof renderKPIs === 'function') renderKPIs(AppState.comparisonResult);
            if (typeof renderZoneProgress === 'function') renderZoneProgress();
        } else if (!dataLoaded) {
            // EMP 로딩 실패 (구 세션 or fetch 오류) → 대시보드는 진입하되 경고 안내
            if (typeof toast === 'function') {
                toast('EMP 데이터를 불러오지 못했습니다. 관리자에게 문의하세요.', 'warning');
            }
        }

        if (typeof toast === 'function') {
            toast(`세션 ${sessionId} 연결 완료`, 'success');
        }
    } catch (e) {
        if (typeof toast === 'function') {
            toast('세션 연결에 실패했습니다: ' + e.message, 'error');
        }
        hideSyncOverlay();
    }
}

/**
 * 세션 메타의 dataSource를 읽어 EMP 데이터를 자동 fetch
 * @returns {boolean} 데이터 로딩 성공 여부
 */
async function _autoLoadSessionData(sessionId) {
    try {
        const db = firebase.database();
        const metaSnap = await db.ref(`sessions/${sessionId}/meta`).once('value');
        const meta = metaSnap.val();

        if (!meta?.dataSource?.empUrl) {
            return false;
        }

        const empUrl = meta.dataSource.empUrl;

        // XLSX 라이브러리 로드
        if (typeof loadXLSX === 'function') await loadXLSX();

        // EMP CSV 다운로드 + 파싱
        const response = await fetch(empUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const csvText = await response.text();
        if (!csvText || csvText.trim().length === 0) throw new Error('빈 데이터');

        const workbook = XLSX.read(csvText, { type: 'string', codepage: 65001 });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
        if (jsonData.length === 0) throw new Error('파싱 결과 0행');

        AppState.empRawData = jsonData;
        AppState.empColumns = Object.keys(jsonData[0]);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * 컬럼 자동 매핑 + 비교 분석 자동 실행
 * [FIX] 비교 전 기존 실사 데이터를 맵에 보존 → 비교 후 복원 + Firebase 보강
 */
async function _autoRunComparison() {
    try {
        if (!AppState.empRawData?.length || !AppState.empColumns?.length) return;

        // [FIX] 비교 분석 중 원격 수신 일시 정지 (race condition 방지)
        if (typeof FirebaseSync !== 'undefined') FirebaseSync._processingPaused = true;

        // ── [FIX 핵심] 비교 실행 전 기존 physicalQty를 SKU+위치 키로 보존 ──
        // localStorage 복구 데이터 또는 이전 세션 데이터를 잃지 않기 위함
        const savedQtyMap = new Map();
        if (AppState.comparisonResult?.length && typeof getFirebaseKey === 'function') {
            AppState.comparisonResult.forEach(r => {
                // [BUG2 FIX] _touched 또는 physicalQty > 0인 행은 모두 보존
                if (r.physicalQty != null && (r.physicalQty !== 0 || r._touched)) {
                    const key = getFirebaseKey(r);
                    savedQtyMap.set(key, {
                        physicalQty: r.physicalQty,
                        reason:      r.reason || '',
                        memo:        r.memo   || '',
                    });
                }
            });
        }
        const savedCompletedRows = AppState.completedRows
            ? new Set(AppState.completedRows)
            : new Set();

        // 컬럼 자동 매핑 (guessColumn 사용)
        const empMapping = {};
        const fields = ['sku', 'barcode', 'name', 'qty', 'location'];
        fields.forEach(field => {
            empMapping[field] = typeof guessColumn === 'function'
                ? guessColumn(AppState.empColumns, field)
                : '';
        });

        // SKU와 Location은 필수
        if (!empMapping.sku || !empMapping.location) {
            return;
        }

        const mappings = {
            emp: empMapping,
            physical: { sku: '', barcode: '', name: '', qty: '', location: '' },
        };

        // EMP-only 모드로 비교 실행 (physicalQty=0으로 초기화됨)
        AppState.physicalRawData = null;
        if (typeof runComparison === 'function') {
            const result = runComparison(mappings);
            AppState.comparisonResult = result || [];
            AppState.filteredResult   = [...AppState.comparisonResult];
        }

        // ── [FIX 1단계] 로컬 맵에서 physicalQty 복원 (localStorage 복구 데이터) ──
        let localRestored = 0;
        if (savedQtyMap.size > 0 && AppState.comparisonResult?.length) {
            AppState.comparisonResult.forEach(r => {
                const key = typeof getFirebaseKey === 'function' ? getFirebaseKey(r) : null;
                if (!key) return;
                const saved = savedQtyMap.get(key);
                if (saved) {
                    r.physicalQty = saved.physicalQty;
                    r.difference  = saved.physicalQty - (r.empQty || 0);
                    r.status      = saved.physicalQty === r.empQty ? 'MATCH' : 'MISMATCH';
                    if (saved.reason) r.reason = saved.reason;
                    if (saved.memo)   r.memo   = saved.memo;
                    localRestored++;
                }
            });
            // completedRows도 복원 (rowId가 변경되었으므로 키 기반으로 재매핑)
            if (savedCompletedRows.size > 0) {
                // 구 rowId → 신 rowId 매핑은 불가하므로, Firebase done 상태에서 복원
            }
            if (localRestored > 0) {
                AppState.filteredResult = [...AppState.comparisonResult];
                console.log(`[Session] 로컬 맵에서 ${localRestored}건 실사 데이터 복원`);
            }
        }

        // ── [FIX 2단계] Firebase rows에서 추가 복원 (다른 작업자 데이터 포함) ──
        const sessionId = window.FirebaseSync?.sessionId;
        if (sessionId && typeof restoreRowsFromFirebase === 'function') {
            const fbRestored = await restoreRowsFromFirebase(sessionId);
            if (fbRestored > 0) {
                AppState.filteredResult = [...AppState.comparisonResult];
                console.log(`[Session] Firebase에서 ${fbRestored}건 실사 데이터 복원`);
            }
        }
    } catch (e) {
        console.warn('[Session] 자동 비교 분석 실패:', e.message);
    } finally {
        // [FIX] 원격 수신 재개
        if (typeof FirebaseSync !== 'undefined') {
            FirebaseSync._processingPaused = false;
            // [FIX C 보완] paused 중 done 리스너가 건너뛴 동기화를 여기서 1회 실행
            if (typeof _syncRemoteCompletedToLocal === 'function') _syncRemoteCompletedToLocal();
        }
    }
}

/**
 * 작업 중 세션 전환
 * [BUG3 FIX] 기존: leaveSession + joinSession만 실행 → 데이터 오염
 *            수정: flush → leave → 초기화 → EMP 재로딩 → 비교 재실행 → Firebase 복원 → 렌더
 */
async function switchToSession(newSessionId) {
    const hasUnsaved = AppState.completedRows && AppState.completedRows.size > 0;
    if (hasUnsaved) {
        const confirmed = window.confirm(
            '세션을 전환하시겠습니까?\n현재 세션의 동기화된 데이터는 유지됩니다.'
        );
        if (!confirmed) return;
    }

    // [FIX A] 현재 세션의 수정된 행만 Firebase에 강제 push
    // handleLiveQtyInput()은 메모리만 갱신하고 debouncedPushRow를 호출하지 않으므로
    // blur 이벤트 없이 전환하면 Firebase에 기록 안 된 데이터가 있을 수 있음
    if (typeof FirebaseSync !== 'undefined' && FirebaseSync.enabled
        && FirebaseSync.sessionId && AppState.comparisonResult?.length) {
        AppState.comparisonResult.forEach(row => {
            if (row._touched) {
                pushRowToFirebase(row._rowId);
            }
        });
    }

    // 1) 현재 세션 대기 중인 push 즉시 플러시
    if (typeof flushPendingRowPushes === 'function') flushPendingRowPushes();

    // 2) 현재 세션 나가기
    if (typeof leaveSession === 'function') leaveSession();

    // 3) 이전 세션 로컬 상태 초기화 (데이터 오염 방지)
    AppState.completedRows = new Set();
    notifySubscribers('completedRows', AppState.completedRows, null);
    AppState.comparisonResult = [];
    AppState.filteredResult   = [];

    // [FIX B] 세션 전환 중 원격 이벤트 차단
    // joinSession()이 _startListeners()를 즉시 호출하는데,
    // done 리스너가 비어있는 comparisonResult로 renderMainTable() 호출 방지
    if (typeof FirebaseSync !== 'undefined') FirebaseSync._processingPaused = true;

    // 4) 새 세션 참가 + presence
    if (typeof joinSession === 'function') joinSession(newSessionId, false);
    if (typeof setupPresence === 'function') setupPresence(newSessionId);

    // 5) 새 세션 EMP 로딩 (기존 _autoLoadSessionData 재활용)
    let dataLoaded = false;
    try {
        dataLoaded = await _autoLoadSessionData(newSessionId);
    } catch (e) {
        console.warn('[Session] 세션 전환 EMP 로딩 실패:', e.message);
    }

    // 6) 비교 분석 + Firebase 복원 (기존 _autoRunComparison 재활용)
    if (dataLoaded) {
        try {
            await _autoRunComparison();
        } catch (e) {
            console.warn('[Session] 세션 전환 비교 분석 실패:', e.message);
        }
    }

    // [FIX B] _autoRunComparison 미실행 시에도 paused 해제 + done 동기화
    if (typeof FirebaseSync !== 'undefined') FirebaseSync._processingPaused = false;
    if (typeof _syncRemoteCompletedToLocal === 'function') _syncRemoteCompletedToLocal();

    // 7) UI 렌더링 — 성공/실패 모두 한 번은 렌더 (이전 세션 DOM 잔상 제거)
    if (typeof populateZoneFilter === 'function') populateZoneFilter(AppState.comparisonResult);
    if (typeof renderMainTable === 'function') renderMainTable();
    if (typeof renderKPIs === 'function') renderKPIs(AppState.comparisonResult);
    if (typeof renderZoneProgress === 'function') renderZoneProgress();

    // 모달 닫기
    const modal = document.getElementById('session-switch-modal');
    if (modal) modal.style.display = 'none';

    // 8) 토스트 — 성공/실패 분리
    if (typeof toast === 'function') {
        if (dataLoaded && AppState.comparisonResult?.length) {
            toast(`세션 전환 완료: ${newSessionId}`, 'success');
        } else {
            toast('세션에 연결했지만 EMP 데이터를 불러오지 못했습니다.', 'warning');
        }
    }
}

// ── 메인 플로우 ───────────────────────────────────────────

/**
 * 작업자 로그인 후 자동 세션 검색 → 선택 → 연결 플로우
 */
async function autoSessionFlow() {
    showSyncOverlay();

    // Step 0: 로그인 확인
    updateSyncStep(0);
    await _delay(400);

    // Step 1: 세션 검색
    updateSyncStep(1);
    const sessions = await discoverActiveSessions();

    if (sessions.length === 0) {
        // 세션 없음 → 메시지 표시
        const loading = document.getElementById('sync-loading');
        const noSession = document.getElementById('sync-no-session');
        if (loading) loading.style.display = 'none';
        if (noSession) noSession.style.display = '';

        const title = document.getElementById('sync-step-title');
        if (title) title.textContent = '활성 세션 없음';
        return; // 사용자가 재시도 또는 건너뛰기 선택
    }

    // 세션 있음 → 항상 목록 표시 (작업자마다 실사장소가 다르므로)
    const loading = document.getElementById('sync-loading');
    const listEl = document.getElementById('sync-session-list');
    if (loading) loading.style.display = 'none';

    const title = document.getElementById('sync-step-title');
    if (title) title.textContent = '세션 선택';

    renderSessionPicker(sessions, null, listEl, 'overlay');
}

// ── 세션 전환 모달 ────────────────────────────────────────

/**
 * 세션 전환 모달 열기 (작업 중 세션 변경)
 */
async function showSessionSwitchModal() {
    const modal = document.getElementById('session-switch-modal');
    const listEl = document.getElementById('session-switch-list');
    const loadingEl = document.getElementById('session-switch-loading');

    if (!modal) return;
    modal.style.display = 'flex';

    // 로딩 표시
    if (listEl) listEl.style.display = 'none';
    if (loadingEl) loadingEl.style.display = '';

    // 세션 검색
    const sessions = await discoverActiveSessions();

    if (loadingEl) loadingEl.style.display = 'none';

    if (sessions.length === 0) {
        if (listEl) {
            listEl.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px;">활성 세션이 없습니다.</p>';
            listEl.style.display = '';
        }
        return;
    }

    renderSessionPicker(sessions, FirebaseSync.sessionId, listEl, 'modal');
}

// ── 유틸 ──────────────────────────────────────────────────

function _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function _esc(str) {
    if (typeof esc === 'function') return esc(str);
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
}

function _formatTimeAgo(timestamp) {
    const diff = Date.now() - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return '방금 전';
    if (mins < 60) return `${mins}분 전`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}시간 전`;
    return `${Math.floor(hours / 24)}일 전`;
}
