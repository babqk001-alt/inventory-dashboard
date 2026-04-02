/* ═══════════════════════════════════════════════════════════════════
   utils.js — 공통 유틸리티 함수 모음
   (app.js에서 분리 · 전역 함수 방식 유지 · ES6 모듈 없음)

   포함 항목:
   - DOM 헬퍼  : show, hide, setLoading
   - 문자열    : esc, normalize, formatNum, safeInt
   - UI 피드백 : toast
   - 비동기    : debounce, loadXLSX
   - 파일      : downloadBlob
   - 식별자    : generateRowId
   - 위치 파싱 : parseWarehouseZone
   - 단계 전환 : switchPhase
   - 상태 표시 : getRowClass, getDiffClass, statusBadge
   - 오디오    : getAudioContext, playBeepSuccess, playBeepError
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

// ── DOM 헬퍼 ─────────────────────────────────────────────

/**
 * 요소를 표시합니다.
 * @param {HTMLElement|string} el          - HTMLElement 또는 요소 id
 * @param {string}             [displayType='block']
 */
function show(el, displayType = 'block') {
    const elem = (typeof el === 'string') ? document.getElementById(el) : el;
    if (elem) elem.style.display = displayType;
}

/**
 * 요소를 숨깁니다.
 * modal-overlay 클래스가 있으면 닫기 애니메이션 후 숨깁니다.
 * @param {HTMLElement|string} el - HTMLElement 또는 요소 id
 */
function hide(el) {
    const elem = (typeof el === 'string') ? document.getElementById(el) : el;
    if (!elem) return;
    if (elem.classList.contains('modal-overlay')) {
        closeModalAnimated(elem);
    } else {
        elem.style.display = 'none';
    }
}

/**
 * modal-overlay 요소에 닫기 애니메이션을 적용한 후 숨깁니다.
 * @param {HTMLElement|string} el
 */
function closeModalAnimated(el) {
    const elem = (typeof el === 'string') ? document.getElementById(el) : el;
    if (!elem) return;
    elem.classList.add('modal-closing');
    setTimeout(() => {
        elem.style.display = 'none';
        elem.classList.remove('modal-closing');
    }, 210);
}

/**
 * 로딩 오버레이 표시/숨김.
 * @param {boolean} visible
 */
function setLoading(visible) {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = visible ? 'flex' : 'none';
}

// ── 문자열 유틸리티 ───────────────────────────────────────

/**
 * HTML 특수문자를 이스케이프합니다 (XSS 방지).
 * innerHTML에 사용자 입력을 삽입할 때 반드시 사용하세요.
 * @param   {*}      str
 * @returns {string}
 */
function esc(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * 비교용 문자열 정규화 (trim + 소문자).
 * @param   {*}      val
 * @returns {string}
 */
function normalize(val) {
    if (val === null || val === undefined) return '';
    return String(val).trim().toLowerCase();
}

/**
 * 숫자를 천단위 구분 기호로 포맷합니다.
 * @param   {number} n
 * @returns {string} 예: 1200 → "1,200"
 */
function formatNum(n) {
    return Number(n).toLocaleString('ko-KR');
}

/**
 * 값을 안전하게 정수로 변환합니다. NaN/미정의 시 0을 반환합니다.
 * 쉼표 포함 숫자(예: "1,200")도 처리합니다.
 * @param   {*}      val
 * @returns {number}
 */
function safeInt(val) {
    if (val === null || val === undefined || val === '') return 0;
    const cleaned = String(val).replace(/,/g, '').trim();
    const n = parseInt(cleaned, 10);
    return isNaN(n) ? 0 : n;
}

// ── UI 피드백 ────────────────────────────────────────────

/**
 * 토스트 알림을 표시합니다.
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} [type='info']
 */
function toast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const icons = {
        success: 'fa-circle-check',
        error:   'fa-circle-xmark',
        warning: 'fa-triangle-exclamation',
        info:    'fa-circle-info'
    };

    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML =
        `<i class="fas ${icons[type] || icons.info} toast-icon"></i>` +
        `<span class="toast-text">${message}</span>` +
        `<div class="toast-progress"><div class="toast-progress-bar"></div></div>`;

    // 프로그레스 바 애니메이션
    const bar = el.querySelector('.toast-progress-bar');
    if (bar) {
        bar.style.animationDuration = duration + 'ms';
    }

    container.appendChild(el);
    setTimeout(() => {
        el.classList.add('toast-exit');
        setTimeout(() => el.remove(), 300);
    }, duration);
}

// ── 비동기 유틸리티 ───────────────────────────────────────

/**
 * 디바운스 팩토리. 짧은 시간 안에 반복 호출되면 마지막 호출만 실행합니다.
 * @param {Function} fn    - 실행할 함수
 * @param {number}   delay - 대기 시간 (ms)
 * @returns {Function}
 */
function debounce(fn, delay) {
    let timer = null;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

/**
 * SheetJS(xlsx-js-style)를 필요할 때만 동적으로 로드합니다.
 * 이미 로드된 경우 즉시 resolve합니다.
 * 파일 업로드 또는 엑셀 내보내기 직전에 await loadXLSX()로 호출하세요.
 * @returns {Promise<void>}
 */
function loadXLSX() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('SheetJS 라이브러리 로드에 실패했습니다.'));
        document.head.appendChild(script);
    });
}

// ── 파일 다운로드 ─────────────────────────────────────────

/**
 * Blob을 생성하고 브라우저 다운로드를 트리거합니다.
 * @param {string|ArrayBuffer} content  - 파일 내용
 * @param {string}             filename - 저장할 파일명
 * @param {string}             mimeType - MIME 타입
 */
function downloadBlob(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ── 고유 ID 생성 ──────────────────────────────────────────

let _rowIdCounter = 0;

/**
 * 단조증가(monotonic) 고유 행 ID를 생성합니다.
 * 페이지 새로고침 시 초기화되므로 영구 식별자로 사용하지 마세요.
 * @returns {string} 예: "_r1", "_r2"
 */
function generateRowId() {
    return '_r' + (++_rowIdCounter);
}

// ── 위치 파싱 ─────────────────────────────────────────────

/**
 * 로케이션 문자열에서 창고 구역(앞 두 세그먼트)을 추출합니다.
 * 형식: "00-00-00-00" → "00-00"
 * @param   {string} location
 * @returns {string}
 */
function parseWarehouseZone(location) {
    if (!location || typeof location !== 'string') return '';
    const str   = location.trim();
    const match = str.match(/^([^-]+-[^-]+)/);
    return match ? match[1] : str.substring(0, 5);
}

// ── 단계 전환 ─────────────────────────────────────────────

/**
 * 업로드 단계 ↔ 대시보드 단계를 전환합니다.
 * .phase 요소 중 id가 `${phaseName}-phase`인 요소에 'active' 클래스를 부여합니다.
 * @param {string} phaseName - 'upload' | 'dashboard'
 */
function switchPhase(phaseName) {
    document.querySelectorAll('.phase').forEach(p => p.classList.remove('active'));
    const target = document.getElementById(`${phaseName}-phase`);
    if (target) target.classList.add('active');
}

// ── 상태별 CSS / HTML 헬퍼 ───────────────────────────────

/**
 * 비교 상태(status)에 따른 행(row) CSS 클래스를 반환합니다.
 * @param   {string} status
 * @returns {string}
 */
function getRowClass(status) {
    switch (status) {
        case 'MATCH':             return 'row-match';
        case 'MISMATCH':          return 'row-mismatch';
        case 'ONLY_IN_EMP':       return 'row-only-emp';
        case 'ONLY_IN_PHYSICAL':  return 'row-only-physical';
        case 'LOCATION_SHIFT':    return 'row-location-shift';
        default:                  return '';
    }
}

/**
 * 차이값(diff)에 따른 CSS 클래스를 반환합니다.
 * @param   {number} diff
 * @returns {string}
 */
function getDiffClass(diff) {
    if (diff > 0) return 'diff-positive';
    if (diff < 0) return 'diff-negative';
    return 'diff-zero';
}

/**
 * 상태 배지 HTML을 반환합니다.
 * @param   {string} status
 * @returns {string} HTML 문자열
 */
function statusBadge(status) {
    const labels = {
        MATCH:            '일치',
        MISMATCH:         '불일치',
        ONLY_IN_EMP:      'EMP에만',
        ONLY_IN_PHYSICAL: '실사에만',
        LOCATION_SHIFT:   '타위치발견',
    };
    const classes = {
        MATCH:            'match',
        MISMATCH:         'mismatch',
        ONLY_IN_EMP:      'only-emp',
        ONLY_IN_PHYSICAL: 'only-physical',
        LOCATION_SHIFT:   'location-shift',
    };
    return `<span class="status-badge ${classes[status] || ''}">${labels[status] || esc(status)}</span>`;
}

// ── 오디오 피드백 ─────────────────────────────────────────
// AppState.audioCtx에 의존합니다. AppState가 먼저 초기화되어야 합니다.

/**
 * AudioContext를 지연 생성하고 suspended 상태를 자동 재개합니다.
 * @returns {AudioContext}
 */
function getAudioContext() {
    if (!AppState.audioCtx) {
        AppState.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    // 모던 브라우저 자동 재생 정책: suspended 상태 시 resume
    if (AppState.audioCtx.state === 'suspended') {
        AppState.audioCtx.resume();
    }
    return AppState.audioCtx;
}

/**
 * 스캔 성공 비프음: 짧고 높은 "띡!" (1200→1800Hz, 100ms)
 */
function playBeepSuccess() {
    try {
        const ctx  = getAudioContext();
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(1200, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1800, ctx.currentTime + 0.05);

        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.1);
    } catch (e) {
        console.warn('[Audio] 성공 비프 실패:', e);
    }
}

/**
 * 스캔 실패 비프음: 길고 낮은 "삐빅!!" 2연음 (400→300Hz, 450ms)
 */
function playBeepError() {
    try {
        const ctx = getAudioContext();

        // 첫 번째 음: 400Hz, 200ms
        const osc1  = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = 'square';
        osc1.frequency.setValueAtTime(400, ctx.currentTime);
        gain1.gain.setValueAtTime(0.25, ctx.currentTime);
        gain1.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.start(ctx.currentTime);
        osc1.stop(ctx.currentTime + 0.2);

        // 두 번째 음: 300Hz, 250ms (22ms 간격 후 시작)
        const osc2  = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'square';
        osc2.frequency.setValueAtTime(300, ctx.currentTime + 0.22);
        gain2.gain.setValueAtTime(0, ctx.currentTime);
        gain2.gain.setValueAtTime(0.25, ctx.currentTime + 0.22);
        gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.45);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start(ctx.currentTime + 0.22);
        osc2.stop(ctx.currentTime + 0.45);
    } catch (e) {
        console.warn('[Audio] 오류 비프 실패:', e);
    }
}
