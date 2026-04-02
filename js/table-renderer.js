/* ═══════════════════════════════════════════════════════════════════
   table-renderer.js — 메인 테이블 렌더링 + Live-Input 이벤트 위임

   의존: constants.js (REASON_OPTIONS)
         state.js     (AppState, triggerAutoSave)
         utils.js     (esc, formatNum, safeInt, getRowClass, getDiffClass,
                       statusBadge)
         firebase-sync.js (FirebaseSync, acquireLock, releaseLock,
                           toggleRowDone, debouncedPushRow, getFirebaseKey,
                           _applyLocksToTable)
         dashboard-ui.js  (renderKPIs, _debouncedFullRefresh)

   포함 항목:
   · renderMainTable()         — 페이지네이션 포함 메인 테이블 전체 렌더링
   · wireUpLiveInputs()        — no-op (이벤트 위임으로 대체됨)
   · initMainTableDelegation() — tbody 1회 이벤트 위임 등록
   · handleLiveQtyInput()      — 타이핑 즉시 AppState 반영
   · handleLiveQtyChange()     — 확정 시 updateRowQty 호출
   · _handleQtyDelta()         — +/- 버튼 공통 로직
   · updateRowQty()            — 수량 갱신 + DOM 부분 업데이트
   · handleReasonChange()      — 사유 select 변경
   · handleMemoChange()        — 메모 input 변경
   · addManualNewRow()         — EMP-only 모드에서 스캔 신규 행 추가
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

// ── 메인 테이블 렌더링 ─────────────────────────────────────

/**
 * AppState.filteredResult를 기반으로 메인 테이블을 렌더링합니다.
 * 페이지네이션, 정렬 가능 헤더, 완료 행 처리를 포함합니다.
 */
function renderMainTable() {
    const data       = AppState.filteredResult;
    const pageSize   = AppState.pageSize;
    const totalPages = Math.max(1, Math.ceil(data.length / pageSize));

    if (AppState.currentPage > totalPages) AppState.currentPage = totalPages;

    const startIdx = (AppState.currentPage - 1) * pageSize;
    const pageData = data.slice(startIdx, startIdx + pageSize);

    // 정렬 가능 헤더 렌더링 (5컬럼 그룹)
    const thead = document.getElementById('main-table-head');
    if (thead) {
        const sortCols = [
            { key: null,       label: '#' },
            { key: 'sku',      label: '상품 정보' },
            { key: 'barcode',  label: '바코드 · 위치' },
            { key: 'empQty',   label: '수량' },
            { key: 'status',   label: '상태 · 완료' },
        ];
        let thHtml = '<tr>';
        sortCols.forEach(c => {
            if (c.key) {
                const isActive = AppState.sortColumn === c.key;
                const icon = isActive ? (AppState.sortDirection === 'asc' ? '▲' : '▼') : '⇅';
                thHtml += `<th class="sortable-th${isActive ? ' sort-active' : ''}" data-sort-key="${c.key}">${c.label}<span class="sort-icon">${icon}</span></th>`;
            } else {
                thHtml += `<th>${c.label}</th>`;
            }
        });
        thHtml += '</tr>';
        thead.innerHTML = thHtml;
    }

    // tbody 렌더링
    const tbody = document.getElementById('main-table-body');
    if (!tbody) return;

    if (pageData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:32px;color:#9CA3AF;">데이터가 없습니다.</td></tr>';
    } else {
        let html = '';
        pageData.forEach((r, i) => {
            const rowId  = r._rowId;
            const isDone = AppState.completedRows.has(rowId)
                || !!(FirebaseSync.sessionId && FirebaseSync.remoteCompleted?.[getFirebaseKey(r)]);
            const rowClass  = getRowClass(r.status);
            const doneClass = isDone ? ' row-done' : '';

            html += `<tr class="${rowClass}${doneClass}" data-row-id="${rowId}" id="row-${rowId}">`;
            html += `<td data-label="#">${startIdx + i + 1}</td>`;

            // ── 상품 정보 (SKU + 이름) ──
            html += `<td data-label="상품 정보" class="cell-product-info">`;
            html += `<div class="product-sku">${esc(r.sku)}</div>`;
            html += `<div class="product-name">${esc(r.name)}</div>`;
            html += `</td>`;

            // ── 바코드 · 위치 (별도 컬럼) ──
            html += `<td data-label="바코드·위치" class="cell-barcode-loc">`;
            if (r.barcode) html += `<div class="bl-barcode"><i class="fas fa-barcode"></i> ${esc(r.barcode)}</div>`;
            html += `<div class="bl-location"><i class="fas fa-map-marker-alt"></i> ${esc(r.location)}`;
            if (r.warehouseZone) html += ` <span class="bl-zone">${esc(r.warehouseZone)}</span>`;
            html += `</div></td>`;

            // ── 수량 (그룹) ──
            html += `<td data-label="수량" class="cell-qty-action">`;
            html += `<div class="qty-emp-label">EMP <strong>${formatNum(r.empQty)}</strong></div>`;
            html += `<div class="live-qty-cell">`;
            if (!isDone) {
                html += `<button type="button" class="qty-btn qty-minus" data-row-id="${rowId}" title="−1">−</button>`;
                html += `<input type="number" class="live-qty-input" data-row-id="${rowId}" value="${r.physicalQty}" min="0" step="1">`;
                html += `<button type="button" class="qty-btn qty-plus" data-row-id="${rowId}" title="+1">+</button>`;
            } else {
                html += `<span class="done-qty">${formatNum(r.physicalQty)}</span>`;
            }
            html += `<button type="button" class="qty-btn qty-done${isDone ? ' is-done' : ''}" data-row-id="${rowId}" title="${isDone ? '완료 취소' : '완료'}">✓</button>`;
            html += `</div>`;
            html += `<div class="qty-diff ${getDiffClass(r.difference)}" data-diff-cell="${rowId}">${r.difference > 0 ? '+' : ''}${formatNum(r.difference)}</div>`;
            html += `</td>`;

            // ── 상태 · 완료 (그룹) ──
            html += `<td data-label="상태" class="cell-status-action" data-status-cell="${rowId}">`;
            html += `<div>${statusBadge(r.status)}</div>`;
            html += `<select class="reason-select" data-row-id="${rowId}"${isDone ? ' disabled' : ''}>`;
            REASON_OPTIONS.forEach(opt => {
                const selected = r.reason === opt.value ? ' selected' : '';
                html += `<option value="${esc(opt.value)}"${selected}>${esc(opt.label)}</option>`;
            });
            html += `</select>`;
            html += `<input type="text" class="memo-input" data-row-id="${rowId}" value="${esc(r.memo || '')}" placeholder="메모..."${isDone ? ' disabled' : ''}>`;
            html += `</td>`;

            html += '</tr>';
        });
        tbody.innerHTML = html;

        wireUpLiveInputs();
        if (FirebaseSync.sessionId) _applyLocksToTable();
    }

    // 페이지네이션
    const pageInfo    = document.getElementById('page-info');
    const prevBtn     = document.getElementById('prev-page-btn');
    const nextBtn     = document.getElementById('next-page-btn');
    if (pageInfo) pageInfo.textContent = `${AppState.currentPage} / ${totalPages}`;
    if (prevBtn)  prevBtn.disabled     = AppState.currentPage <= 1;
    if (nextBtn)  nextBtn.disabled     = AppState.currentPage >= totalPages;
}

// ── 이벤트 위임 등록 ──────────────────────────────────────

/**
 * tbody의 이벤트 위임 등록 이후 개별 행 와이어업은 불필요합니다.
 * 기존 코드 호환을 위해 no-op으로 유지합니다.
 */
function wireUpLiveInputs() { /* no-op — 이벤트 위임(initMainTableDelegation)이 처리 */ }

/**
 * main-table-body에 1회 이벤트 위임 리스너를 등록합니다.
 * renderMainTable()이 innerHTML을 교체해도 버블링으로 자동 처리됩니다.
 *
 * 처리 이벤트:
 *   input   → .live-qty-input
 *   change  → .live-qty-input / .reason-select / .memo-input
 *   focusin → .live-qty-input / .reason-select / .memo-input (잠금 획득)
 *   keydown → .live-qty-input (Enter → 완료 토글)
 *   click   → .qty-btn.qty-minus / .qty-btn.qty-plus / .qty-done
 *   click   → .sortable-th (헤더 정렬)
 */
function initMainTableDelegation() {
    const tbody = document.getElementById('main-table-body');
    if (!tbody) return;

    tbody.addEventListener('input', e => {
        if (e.target.matches('.live-qty-input')) handleLiveQtyInput(e);
    });

    tbody.addEventListener('change', e => {
        const t = e.target;
        if      (t.matches('.live-qty-input'))  handleLiveQtyChange(e);
        else if (t.matches('.reason-select'))   handleReasonChange(e);
        else if (t.matches('.memo-input'))      handleMemoChange(e);
    });

    tbody.addEventListener('focusin', e => {
        const t = e.target;
        if (!t.matches('.live-qty-input, .reason-select, .memo-input')) return;
        const rowId = t.getAttribute('data-row-id');
        if (t.matches('.live-qty-input') && !acquireLock(rowId)) {
            t.blur();
        } else {
            acquireLock(rowId);
        }
    });

    tbody.addEventListener('keydown', e => {
        if (e.target.matches('.live-qty-input') && e.key === 'Enter') {
            e.preventDefault();
            toggleRowDone(e.target.getAttribute('data-row-id'));
        }
    });

    tbody.addEventListener('click', e => {
        const minus = e.target.closest('.qty-btn.qty-minus');
        const plus  = e.target.closest('.qty-btn.qty-plus');
        const done  = e.target.closest('.qty-done');
        if (minus) {
            const rowId = minus.getAttribute('data-row-id');
            if (acquireLock(rowId)) _handleQtyDelta(rowId, -1);
        } else if (plus) {
            const rowId = plus.getAttribute('data-row-id');
            if (acquireLock(rowId)) _handleQtyDelta(rowId, +1);
        } else if (done) {
            toggleRowDone(done.getAttribute('data-row-id'));
        }
    });

    // 정렬 가능 헤더 클릭 위임 (thead)
    const thead = document.getElementById('main-table-head');
    if (thead) {
        thead.addEventListener('click', e => {
            const th = e.target.closest('.sortable-th');
            if (th) toggleSort(th.getAttribute('data-sort-key'));
        });
    }
}

// ── Live-Input 핸들러 ─────────────────────────────────────

/**
 * 타이핑 즉시 AppState에 수량을 반영합니다.
 * UI 재렌더 시 값이 유실되지 않도록 보호합니다.
 */
function handleLiveQtyInput(e) {
    const input = e.target;
    input.classList.add('changed');
    setTimeout(() => input.classList.remove('changed'), 400);

    const rowId = input.getAttribute('data-row-id');
    const row   = AppState.comparisonResult.find(r => r._rowId === rowId);
    if (!row) return;
    const qty = Math.max(0, safeInt(input.value));
    if (row.physicalQty !== qty) row._touched = true;
    row.physicalQty = qty;
    row.difference  = qty - row.empQty;
}

/**
 * 입력 확정(blur/change) 시 updateRowQty()를 호출합니다.
 */
function handleLiveQtyChange(e) {
    const input   = e.target;
    const rowId   = input.getAttribute('data-row-id');
    const finalQty = Math.max(0, safeInt(input.value));
    input.value   = finalQty;
    updateRowQty(rowId, finalQty);
}

/**
 * +/- 버튼 공통 로직.
 * @param {string} rowId
 * @param {1|-1}   delta
 */
function _handleQtyDelta(rowId, delta) {
    const input = document.querySelector(`.live-qty-input[data-row-id="${rowId}"]`);
    if (!input) return;
    const newVal = Math.max(0, safeInt(input.value) + delta);
    input.value  = newVal;
    input.classList.add('changed');
    setTimeout(() => input.classList.remove('changed'), 400);
    updateRowQty(rowId, newVal);
}

/**
 * 행의 physicalQty를 갱신하고 diff/status를 재계산합니다.
 * DOM 부분 업데이트(차이 셀, 상태 셀, 행 클래스)를 수행합니다.
 * @param {string} rowId
 * @param {number} newQty
 */
function updateRowQty(rowId, newQty) {
    const row = AppState.comparisonResult.find(r => r._rowId === rowId);
    if (!row) return;

    row.physicalQty = newQty;
    row.difference  = newQty - row.empQty;
    row._touched    = true;

    // 상태 재계산
    if (row.status !== 'ONLY_IN_EMP' && row.status !== 'ONLY_IN_PHYSICAL' && row.status !== 'LOCATION_SHIFT') {
        row.status = row.difference === 0 ? 'MATCH' : 'MISMATCH';
    } else if (row.status === 'ONLY_IN_EMP' && newQty > 0) {
        row.status = row.difference === 0 ? 'MATCH' : 'MISMATCH';
    } else if (AppState.isEmpOnly) {
        row.status = row.difference === 0 ? 'MATCH' : 'MISMATCH';
    }

    // 차이 셀 부분 업데이트
    const diffCell = document.querySelector(`[data-diff-cell="${rowId}"]`);
    if (diffCell) {
        diffCell.className   = getDiffClass(row.difference);
        diffCell.textContent = (row.difference > 0 ? '+' : '') + formatNum(row.difference);
    }
    // 상태 셀 부분 업데이트 (cell-status-action 내 첫 div만 교체)
    const statusCell = document.querySelector(`[data-status-cell="${rowId}"]`);
    if (statusCell) {
        const badgeDiv = statusCell.querySelector('div');
        if (badgeDiv) badgeDiv.innerHTML = statusBadge(row.status);
    }
    // 행 배경색 클래스 갱신
    const tr = document.getElementById(`row-${rowId}`);
    if (tr) tr.className = getRowClass(row.status);

    // KPI 즉시 갱신, 차트/구역은 디바운스
    renderKPIs(AppState.comparisonResult);
    triggerAutoSave();
    _debouncedFullRefresh();
    debouncedPushRow(rowId);
}

/**
 * 조정 사유 변경 핸들러.
 */
function handleReasonChange(e) {
    const rowId = e.target.getAttribute('data-row-id');
    const row   = AppState.comparisonResult.find(r => r._rowId === rowId);
    if (row) {
        row.reason = e.target.value;
        triggerAutoSave();
        debouncedPushRow(rowId);
    }
}

/**
 * 메모 변경 핸들러.
 */
function handleMemoChange(e) {
    const rowId = e.target.getAttribute('data-row-id');
    const row   = AppState.comparisonResult.find(r => r._rowId === rowId);
    if (row) {
        row.memo = e.target.value;
        triggerAutoSave();
        debouncedPushRow(rowId);
    }
}

// ── EMP-only 신규 행 추가 (스캔 전용) ────────────────────

/**
 * EMP-only 모드에서 스캔된 바코드가 기존 행에 없으면 신규 행을 생성합니다.
 * @param {string} barcode   - 스캔된 바코드
 * @param {string} [location=''] - 현재 위치 필터
 */
function addManualNewRow(barcode, location = '') {
    const existing = AppState.comparisonResult.find(r =>
        r.barcode === barcode || r.sku === barcode
    );
    if (existing) return existing;

    const newRow = {
        _rowId:        generateRowId(),
        sku:           barcode,
        barcode:       barcode,
        name:          '',
        location:      location,
        warehouseZone: parseWarehouseZone(location),
        empQty:        0,
        physicalQty:   1,
        difference:    1,
        status:        'ONLY_IN_PHYSICAL',
        matchType:     'none',
        reason:        '',
        memo:          '',
        _scanned:      true,
    };
    AppState.comparisonResult.push(newRow);
    return newRow;
}
