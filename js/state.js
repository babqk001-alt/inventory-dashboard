/* ═══════════════════════════════════════════════════════════════════
   state.js — 전역 애플리케이션 상태 (Proxy 기반 반응형 AppState)

   설계 방침:
   · 단방향 데이터 흐름: Firebase/파일파싱 → AppState → UI
   · Proxy 트랩으로 상태 변경을 감지 → 등록된 구독자(subscriber)에게 통지
   · 직접 AppState.xxx = yyy 방식 그대로 사용 가능 (기존 코드 호환)
   · Set/Map 등 특수 객체는 Proxy가 아닌 raw 참조를 통해 조작하므로
     mutate 후 notifySubscribers(key)를 수동으로 호출하세요.
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

// ── 원시 상태 객체 ────────────────────────────────────────

const _rawState = {
    // ── 파일 파싱 데이터 ──────────────────────────────────
    empRawData:      null,   // EMP 파일 파싱 원본 rows
    physicalRawData: null,   // 실사 파일 파싱 원본 rows (null = EMP 전용 모드)
    empColumns:      [],     // EMP 파일 컬럼 헤더
    physicalColumns: [],     // 실사 파일 컬럼 헤더

    // ── 비교 결과 ─────────────────────────────────────────
    comparisonResult: [],    // 비교 완료 후 병합된 행 배열
    filteredResult:   [],    // 현재 필터/정렬 적용 후 행 배열

    // ── 페이지네이션 ──────────────────────────────────────
    currentPage: 1,
    pageSize:    50,

    // ── 차트 인스턴스 (Chart.js) ──────────────────────────
    charts: { bar: null, pie: null },

    // ── 멀티 검색 ─────────────────────────────────────────
    multiSearchTerms: [],    // 멀티검색 키워드 배열

    // ── 카메라/오디오 ──────────────────────────────────────
    cameraScanner: null,     // Html5Qrcode 인스턴스
    audioCtx:      null,     // Web Audio API AudioContext

    // ── 자동저장 ──────────────────────────────────────────
    autoSaveTimer: null,     // debounce 타이머 핸들

    // ── 뷰 상태 ───────────────────────────────────────────
    currentView: 'overview', // 'overview' | 'livecount' | 'adjustment'
    isEmpOnly:   false,      // true = 실사 파일 없이 EMP 데이터만 사용

    // ── 담당자 / 구역 ──────────────────────────────────────
    assigneeName:   '',      // 현재 사용자 이름
    workers:        [],      // 등록된 담당자 이름 목록
    zoneAssignees:  {},      // { zoneName: assigneeName }
    myZonesOnly:    false,   // 내 구역만 보기 모드

    // ── 필터 / 정렬 ───────────────────────────────────────
    locationFilter:   'ALL', // 세부 위치 필터
    sortColumn:       null,  // 현재 정렬 컬럼 키
    sortDirection:    'asc', // 'asc' | 'desc'

    // ── 스캐너 보조 ───────────────────────────────────────
    lastScannedRow: null,    // 마지막 스캔된 행 (새 위치 추가용)

    // ── 조정 뷰 (재실사/재고조정) ──────────────────────────
    adjMode:         'recount', // 'recount' | 'adjust'
    adjPage:         1,
    adjSortColumn:   null,
    adjSortDirection:'asc',
    adjSkuGrouped:   false,  // SKU 합산 보기 모드
    recountData:     {},     // { _rowId: recountQty }

    // ── Set / Map (Proxy 외부에서 직접 조작 후 notifySubscribers 호출) ──
    adjApproved:   new Set(), // 조정 승인된 _rowId
    completedRows: new Set(), // 완료 처리된 _rowId

    // ── Firebase 실시간 ───────────────────────────────────
    remoteProgress: {},      // { zone: { scanned, total, updatedBy } }

    // ── EMP 수량 0 표시 옵션 ─────────────────────────────
    _showAllEmpZero: false,

    // ── 인증 ─────────────────────────────────────────────
    // bridgeAuthToLegacy()가 로그인 성공 후 주입합니다.
    // { uid, email, displayName, role } | null
    currentUser: null,
};

// ── 구독자 레지스트리 ─────────────────────────────────────

/** @type {Map<string, Set<Function>>} key → 구독자 함수 집합 */
const _subscribers = new Map();

/**
 * 특정 키의 상태 변경 구독.
 * @param {string}   key - 상태 키 (예: 'comparisonResult', '*')
 * @param {Function} fn  - 콜백 (newVal, oldVal, key) => void
 * @returns {Function} 구독 해제 함수
 */
function subscribeState(key, fn) {
    if (!_subscribers.has(key)) _subscribers.set(key, new Set());
    _subscribers.get(key).add(fn);
    return () => _subscribers.get(key)?.delete(fn);
}

/**
 * 구독자에게 상태 변경을 알립니다.
 * Set/Map 등 내부 mutate 후 수동 호출이 필요할 때 사용합니다.
 * @param {string} key    - 상태 키
 * @param {*}      newVal - 새 값 (참고용)
 * @param {*}      oldVal - 이전 값 (참고용)
 */
function notifySubscribers(key, newVal, oldVal) {
    _subscribers.get(key)?.forEach(fn => {
        try { fn(newVal, oldVal, key); } catch (e) { console.error('[State] 구독자 오류:', e); }
    });
    // 와일드카드 구독자에게도 알림
    _subscribers.get('*')?.forEach(fn => {
        try { fn(newVal, oldVal, key); } catch (e) { console.error('[State] 와일드카드 구독자 오류:', e); }
    });
}

// ── Proxy 생성 ─────────────────────────────────────────────

/**
 * AppState — 반응형 전역 상태 객체.
 * AppState.key = value 형태의 기존 코드와 완전 호환됩니다.
 */
const AppState = new Proxy(_rawState, {
    set(target, key, value) {
        const oldVal = target[key];
        target[key]  = value;
        // 값이 실제로 바뀐 경우에만 구독자 통지 (얕은 비교)
        if (oldVal !== value) {
            notifySubscribers(key, value, oldVal);
        }
        return true;
    },
    get(target, key) {
        return target[key];
    },
});

// ── 상태 직렬화 / 복원 (localStorage 자동저장) ──────────────

/**
 * AppState 중 직렬화 가능한 필드를 JSON으로 반환합니다.
 * Set/Function/HTMLElement 등 직렬화 불가 필드는 제외됩니다.
 * @returns {string} JSON 문자열
 */
function serializeState() {
    const snapshot = {
        comparisonResult: AppState.comparisonResult,
        assigneeName:     AppState.assigneeName,
        workers:          AppState.workers,
        zoneAssignees:    AppState.zoneAssignees,
        recountData:      AppState.recountData,
        completedRows:    [...AppState.completedRows],
        adjApproved:      [...AppState.adjApproved],
        isEmpOnly:        AppState.isEmpOnly,
        _showAllEmpZero:  AppState._showAllEmpZero,
    };
    return JSON.stringify(snapshot);
}

/**
 * JSON 문자열에서 AppState를 복원합니다.
 * @param {string} json
 */
function deserializeState(json) {
    try {
        const data = JSON.parse(json);
        if (!data || !Array.isArray(data.comparisonResult)) return;

        AppState.comparisonResult = data.comparisonResult;
        AppState.filteredResult   = [...data.comparisonResult];
        AppState.assigneeName     = data.assigneeName     || '';
        AppState.workers          = data.workers          || [];
        AppState.zoneAssignees    = data.zoneAssignees    || {};
        AppState.recountData      = data.recountData      || {};
        AppState.isEmpOnly        = data.isEmpOnly        ?? false;
        AppState._showAllEmpZero  = data._showAllEmpZero  ?? false;

        // Set 복원 (Proxy 외부 mutate 후 수동 통지)
        AppState.completedRows = new Set(data.completedRows || []);
        notifySubscribers('completedRows', AppState.completedRows, null);

        AppState.adjApproved = new Set(data.adjApproved || []);
        notifySubscribers('adjApproved', AppState.adjApproved, null);
    } catch (e) {
        console.warn('[State] 상태 복원 실패:', e);
    }
}

/**
 * localStorage에 현재 상태를 저장합니다.
 * triggerAutoSave()에서 debounce를 거쳐 호출됩니다.
 */
function persistState() {
    try {
        localStorage.setItem(LS_KEY, serializeState());
    } catch (e) {
        console.warn('[State] localStorage 저장 실패:', e);
    }
}

/**
 * localStorage에서 상태를 불러옵니다.
 * DOMContentLoaded 이후 initApp()에서 호출하세요.
 * @returns {boolean} 복원 성공 여부
 */
function loadPersistedState() {
    const saved = localStorage.getItem(LS_KEY);
    if (!saved) return false;
    deserializeState(saved);
    return AppState.comparisonResult.length > 0;
}

/**
 * 자동저장 디바운스 트리거 (1초 대기 후 저장).
 */
const triggerAutoSave = debounce(persistState, 1000);

/**
 * AppState를 초기값으로 완전 리셋합니다.
 * 새 비교 실행 시 또는 로그아웃 시 호출하세요.
 */
function resetState() {
    // 기본값으로 덮어쓰기 (Set은 새로 생성)
    AppState.empRawData       = null;
    AppState.physicalRawData  = null;
    AppState.empColumns       = [];
    AppState.physicalColumns  = [];
    AppState.comparisonResult = [];
    AppState.filteredResult   = [];
    AppState.currentPage      = 1;
    AppState.multiSearchTerms = [];
    AppState.isEmpOnly        = false;
    AppState.locationFilter   = 'ALL';
    AppState.sortColumn       = null;
    AppState.sortDirection    = 'asc';
    AppState.lastScannedRow   = null;
    AppState.adjMode          = 'recount';
    AppState.adjPage          = 1;
    AppState.adjSortColumn    = null;
    AppState.adjSortDirection = 'asc';
    AppState.adjSkuGrouped    = false;
    AppState.recountData      = {};
    AppState.remoteProgress   = {};
    AppState._showAllEmpZero  = false;

    // Set 리셋 (Proxy 외부 mutate 후 수동 통지)
    AppState.completedRows = new Set();
    notifySubscribers('completedRows', AppState.completedRows, null);
    AppState.adjApproved = new Set();
    notifySubscribers('adjApproved', AppState.adjApproved, null);
}
