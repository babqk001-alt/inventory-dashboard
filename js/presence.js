/* presence.js — Firebase 세션 접속자 실시간 관리
 * 의존: firebase-sync.js (FirebaseSync 객체), utils.js, state.js
 *
 * 구현 방식:
 *  - sessions/{sessionId}/presence/{deviceId} 에 접속자 정보 기록
 *  - onDisconnect().remove() 로 브라우저 종료 시 자동 제거
 *  - 구독 → renderOnlineUsers() 로 UI 업데이트
 */
'use strict';

/** Presence 관리 객체 */
const Presence = {
    /** 현재 세션의 presence DB 참조 */
    _ref: null,
    /** presence 리스너 해제 함수 */
    _unsubscribe: null,
    /** 현재 세션에 접속 중인 사용자 맵 { deviceId → { name, joinedAt } } */
    _users: {},
};

// ═══════════════════════════════════════════════════════
// 1. 접속자 등록 / 해제
// ═══════════════════════════════════════════════════════

/**
 * 현재 세션에 자신을 접속자로 등록
 * - onDisconnect 설정: 연결 끊기면 자동 제거
 * - 다른 접속자 변경사항 구독 시작
 * @param {string} sessionId - Firebase 세션 ID
 */
function registerPresence(sessionId) {
    if (!FirebaseSync.enabled || !FirebaseSync.db || !sessionId) return;

    const deviceId = FirebaseSync._deviceId;
    const name = AppState.assigneeName || `사용자_${deviceId.slice(-4)}`;
    const presenceRef = FirebaseSync.db.ref(`sessions/${sessionId}/presence/${deviceId}`);

    // 연결 끊기면 자동 제거 (onDisconnect)
    presenceRef.onDisconnect().remove();

    // 접속자 등록
    presenceRef.set({
        name,
        joinedAt: Date.now(),
    }).catch(err => console.warn('[Presence] 등록 실패:', err.message));

    Presence._ref = FirebaseSync.db.ref(`sessions/${sessionId}/presence`);

    // 접속자 목록 실시간 구독
    Presence._ref.on('value', snap => {
        Presence._users = snap.val() || {};
        renderOnlineUsers();
    });

    Presence._unsubscribe = () => {
        if (Presence._ref) {
            Presence._ref.off('value');
            Presence._ref = null;
        }
    };
}

/**
 * 세션 접속자 목록에서 자신을 제거하고 구독 해제
 * leaveSession() 호출 시 함께 호출
 */
function unregisterPresence(sessionId) {
    if (!FirebaseSync.enabled || !FirebaseSync.db || !sessionId) return;

    const deviceId = FirebaseSync._deviceId;
    // onDisconnect 취소 후 직접 삭제
    FirebaseSync.db.ref(`sessions/${sessionId}/presence/${deviceId}`)
        .onDisconnect().cancel();
    FirebaseSync.db.ref(`sessions/${sessionId}/presence/${deviceId}`)
        .remove()
        .catch(() => {});

    if (Presence._unsubscribe) {
        Presence._unsubscribe();
        Presence._unsubscribe = null;
    }
    Presence._users = {};
    renderOnlineUsers();
}

// ═══════════════════════════════════════════════════════
// 2. 접속자 UI 렌더링
// ═══════════════════════════════════════════════════════

/**
 * 세션 접속자 목록 UI 업데이트
 * - #online-users-list 요소에 아바타 + 이름 렌더링
 * - #online-users-count 요소에 숫자 표시
 */
function renderOnlineUsers() {
    const countEl = document.getElementById('online-users-count');
    const listEl  = document.getElementById('online-users-list');
    if (!listEl) return;

    const users = Object.entries(Presence._users);
    const myDeviceId = FirebaseSync._deviceId;

    if (countEl) countEl.textContent = users.length;

    if (users.length === 0) {
        listEl.innerHTML = '<span class="online-user-empty">접속자 없음</span>';
        return;
    }

    listEl.innerHTML = users.map(([deviceId, info]) => {
        const name = esc(info.name || `사용자_${deviceId.slice(-4)}`);
        const isMe = deviceId === myDeviceId;
        const initial = (info.name || '?').charAt(0).toUpperCase();
        return `<span class="online-user-chip${isMe ? ' me' : ''}" title="${name}${isMe ? ' (나)' : ''}">
            <span class="online-user-avatar">${initial}</span>
            <span class="online-user-name">${name}${isMe ? ' (나)' : ''}</span>
        </span>`;
    }).join('');
}
