/* ═══════════════════════════════════════════════════════════════════
   dashboard-ui.js — KPI · 차트 · 필터 · 구역 진행률 · 담당자 패널 · 뷰 전환

   의존: constants.js (REASON_OPTIONS, ASSIGNEE_STORAGE_KEY, THEME_KEY)
         state.js     (AppState, triggerAutoSave, notifySubscribers)
         utils.js     (esc, toast, formatNum, safeInt, normalize,
                       parseWarehouseZone, show, hide, switchPhase)
         comparison.js (applyFilters - 순환 의존 주의: applyFilters가 renderMainTable 호출)

   포함 항목:
   · filterActiveRows()         — EMP 0 + 실사 0 행 필터 (공통)
   · renderKPIs()               — KPI 카드 렌더링
   · populateZoneFilter()       — 구역 드롭다운 채우기
   · populateLocationFilter()   — 세부 위치 드롭다운 채우기
   · resetStatusRadioUI()       — 상태 필터 초기화
   · setStatusRadioUI()         — 상태 필터 지정값 설정
   · applyFilters()             — 전체 필터 적용 + 테이블 갱신
   · toggleSort()               — 테이블 헤더 정렬 토글
   · renderCharts()             — Chart.js 바/도넛 차트 렌더링
   · renderTopDiffTable()       — Top 10 차이 테이블 렌더링
   · refreshDashboard()         — KPI + 차트 + 필터 일괄 갱신
   · switchView()               — 뷰 탭 전환 (overview / livecount / adjustment)
   · updateSidebarPosition()    — 스캔바 표시 여부에 따른 사이드바 위치 보정
   · syncMobileTabState()       — 모바일 탭 활성 상태 동기화
   · openSidebar() / closeSidebar()
   · openExportDrawer() / closeExportDrawer()
   · renderZoneProgress()       — 구역별 진행률 카드 렌더링
   · selectZoneFromCard()       — 구역 카드 클릭 → 필터 전환
   · toggleZoneProgressPanel()  — 모바일 패널 접기/펼치기
   · syncZoneProgressVisibility()
   · renderAssigneePanel()      — 담당자 패널 렌더링
   · saveAssigneeName()         — 담당자 추가
   · removeWorker()             — 담당자 삭제
   · onZoneAssigneeChange()     — 구역 담당자 변경
   · toggleMyZonesOnly()        — 내 구역만 보기 토글
   · resetAllAssignees()        — 담당자 전체 초기화
   · loadAssigneeSettings()     — localStorage 담당자 설정 로드
   · saveAssigneeSettings()     — localStorage 담당자 설정 저장
   · initTheme() / applyTheme() / toggleTheme()
   · saveToLocalStorage() / loadFromLocalStorage() / restoreFromSavedData() / clearLocalStorage()
   · updateAutoSaveIndicator()
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

// ── EMP 0 + 실사 0 행 필터 ────────────────────────────────

/**
 * EMP 수량 0 + 실사 수량 0인 행을 제외합니다.
 * 예외: 재실사 입력된 행, 완료된 행, 스캔된 행은 보존합니다.
 * @param   {Object[]} data
 * @returns {Object[]}
 */
function filterActiveRows(data) {
    return data.filter(r => {
        if (r.empQty === 0 && r.physicalQty === 0) {
            if (r.status !== 'MATCH') { r.status = 'MATCH'; r.difference = 0; }
            if (AppState.recountData[r._rowId] !== undefined) return true;
            if (AppState.completedRows.has(r._rowId))          return true;
            if (r._scanned)                                     return true;
            return false;
        }
        if (r.empQty > 0)                                                            return true;
        if (r.physicalQty > 0)                                                       return true;
        if (AppState.completedRows.has(r._rowId))                                    return true;
        if (r.status === 'ONLY_IN_PHYSICAL' && (r._touched || r._scanned))           return true;
        return false;
    });
}

// ── KPI ───────────────────────────────────────────────────

/**
 * KPI 카드를 갱신합니다.
 * @param {Object[]} data - AppState.comparisonResult
 */
function renderKPIs(data) {
    const activeData    = filterActiveRows(data);
    const total         = activeData.length;
    const matchCount    = activeData.filter(r => r.status === 'MATCH').length;
    const mismatchRows  = activeData.filter(r => r.status === 'MISMATCH');
    const locShiftRows  = activeData.filter(r => r.status === 'LOCATION_SHIFT');
    const missingRows   = activeData.filter(r => r.status === 'ONLY_IN_EMP');
    const accuracy      = total > 0 ? ((matchCount / total) * 100).toFixed(1) : '0.0';

    _setText('kpi-total',     formatNum(total));
    _setText('kpi-mismatch',  formatNum(mismatchRows.length));
    _setText('kpi-locshift',  formatNum(locShiftRows.length));
    _setText('kpi-missing',   formatNum(missingRows.length));
    _setText('kpi-accuracy',  accuracy + '%');

    const totalEmpQty  = activeData.reduce((s, r) => s + (r.empQty || 0), 0);
    const totalPhysQty = activeData.reduce((s, r) => s + (r.physicalQty || 0), 0);
    const mismatchDiff = mismatchRows.reduce((s, r) => s + r.difference, 0);
    const locShiftQty  = locShiftRows.reduce((s, r) => s + (r.empQty || 0), 0);
    const missingQty   = missingRows.reduce((s, r)  => s + (r.empQty || 0), 0);

    _setTextIfEl('kpi-total-qty',    `EMP ${formatNum(totalEmpQty)}개 · 실사 ${formatNum(totalPhysQty)}개`);
    _setTextIfEl('kpi-mismatch-qty', mismatchDiff !== 0
        ? `실사 - EMP 차이 합계 ${mismatchDiff > 0 ? '+' : ''}${formatNum(mismatchDiff)}개` : '');
    _setTextIfEl('kpi-locshift-qty', locShiftQty > 0
        ? `EMP 등록 위치와 다른 곳에서 발견 ${formatNum(locShiftQty)}개` : '');
    _setTextIfEl('kpi-missing-qty',  missingQty > 0
        ? `EMP에 있지만 실사에서 미발견 ${formatNum(missingQty)}개` : '');
}

// ── 구역 / 위치 필터 드롭다운 ─────────────────────────────

/**
 * 구역 드롭다운을 채우고 세부 위치 드롭다운도 갱신합니다.
 * @param {Object[]} data
 */
function populateZoneFilter(data) {
    const zones  = [...new Set(data.map(r => r.warehouseZone).filter(Boolean))].sort();
    const select = document.getElementById('zone-filter');
    if (!select) return;
    select.innerHTML = '<option value="ALL">전체 구역</option>';
    zones.forEach(z => {
        const opt = document.createElement('option');
        opt.value = z; opt.textContent = z;
        select.appendChild(opt);
    });
    populateLocationFilter(data);
}

/**
 * 세부 위치 드롭다운을 현재 선택된 구역 기준으로 갱신합니다.
 * @param {Object[]} [data]
 */
function populateLocationFilter(data) {
    const sel = document.getElementById('location-filter');
    if (!sel) return;
    const zone = document.getElementById('zone-filter')?.value || 'ALL';
    let src = data || AppState.comparisonResult;
    if (zone && zone !== 'ALL') src = src.filter(r => r.warehouseZone === zone);
    const locs = [...new Set(src.map(r => r.location).filter(Boolean))].sort();
    const prev = sel.value;
    sel.innerHTML = '<option value="ALL">전체 위치</option>';
    locs.forEach(loc => {
        const o = document.createElement('option');
        o.value = loc; o.textContent = loc;
        sel.appendChild(o);
    });
    sel.value = locs.includes(prev) ? prev : 'ALL';
    AppState.locationFilter = sel.value;
}

// ── 상태 필터 라디오 UI ───────────────────────────────────

function resetStatusRadioUI() {
    const group = document.getElementById('status-filter-group');
    if (!group) return;
    group.querySelectorAll('.radio-item').forEach(el => el.classList.remove('active'));
    group.querySelector('.radio-item[data-value="ALL"]')?.classList.add('active');
}

function setStatusRadioUI(value) {
    const group = document.getElementById('status-filter-group');
    if (!group) return;
    group.querySelectorAll('.radio-item').forEach(el => el.classList.remove('active'));
    group.querySelector(`.radio-item[data-value="${value}"]`)?.classList.add('active');
}

// ── 필터 적용 ─────────────────────────────────────────────

/**
 * 현재 필터 상태(상태, 구역, 위치, 검색어, 정렬)를 적용하여
 * filteredResult를 갱신하고 테이블/Top-10을 재렌더합니다.
 */
function applyFilters() {
    let data = AppState.comparisonResult;

    // EMP 0 + 실사 0 행 숨김
    if (!AppState._showAllEmpZero) data = filterActiveRows(data);

    // 상태 필터
    const statusVal = document.querySelector('input[name="status-filter"]:checked')?.value || 'ALL';
    if (statusVal === 'ZERO_QTY') {
        data = data.filter(r => r.physicalQty === 0 && r.empQty > 0);
    } else if (statusVal !== 'ALL') {
        data = data.filter(r => r.status === statusVal);
    }

    // 구역 필터
    const zoneVal = document.getElementById('zone-filter')?.value || 'ALL';
    if (zoneVal !== 'ALL') data = data.filter(r => r.warehouseZone === zoneVal);

    // 세부 위치 필터
    const locSel = document.getElementById('location-filter');
    const locVal = locSel ? locSel.value : 'ALL';
    AppState.locationFilter = locVal;
    if (locVal !== 'ALL') data = data.filter(r => r.location === locVal);

    // 내 구역만 보기
    if (AppState.myZonesOnly && AppState.assigneeName) {
        const myZones = Object.entries(AppState.zoneAssignees)
            .filter(([, v]) => v === AppState.assigneeName)
            .map(([k]) => k);
        if (myZones.length > 0) data = data.filter(r => myZones.includes(r.warehouseZone));
    }

    // 검색 (단일 + 멀티)
    const singleSearch = (document.getElementById('search-input')?.value || '').trim().toLowerCase();
    const multiTerms   = AppState.multiSearchTerms.map(t => t.toLowerCase());
    const allTerms     = [...(singleSearch ? [singleSearch] : []), ...multiTerms.filter(Boolean)];
    if (allTerms.length > 0) {
        data = data.filter(r => allTerms.some(term =>
            (r.sku     && r.sku.toLowerCase().includes(term)) ||
            (r.barcode && r.barcode.toLowerCase().includes(term)) ||
            (r.name    && r.name.toLowerCase().includes(term))
        ));
    }

    // 정렬
    if (AppState.sortColumn) {
        const col = AppState.sortColumn;
        const dir = AppState.sortDirection === 'desc' ? -1 : 1;
        data.sort((a, b) => {
            let va = a[col], vb = b[col];
            if (col === 'empQty' || col === 'physicalQty' || col === 'difference') {
                return (Number(va) - Number(vb)) * dir;
            }
            va = String(va || '').toLowerCase();
            vb = String(vb || '').toLowerCase();
            if (va < vb) return -1 * dir;
            if (va > vb) return  1 * dir;
            return 0;
        });
    } else {
        data.sort((a, b) => {
            const sc = (a.sku || '').toLowerCase().localeCompare((b.sku || '').toLowerCase());
            if (sc !== 0) return sc;
            return (a.location || '').toLowerCase().localeCompare((b.location || '').toLowerCase());
        });
    }

    AppState.filteredResult = data;
    AppState.currentPage    = 1;
    _setText('filtered-count', formatNum(data.length));

    if (typeof renderMainTable    === 'function') renderMainTable();
    if (typeof renderTopDiffTable === 'function') renderTopDiffTable();

    if (AppState.currentView === 'adjustment' && typeof renderAdjustmentView === 'function') {
        AppState.adjPage = 1;
        renderAdjustmentView();
    }
}

/**
 * 테이블 헤더 클릭으로 정렬 방향을 토글합니다.
 * 3번 클릭 시 정렬 해제됩니다.
 * @param {string} column - AppState row의 키 이름
 */
function toggleSort(column) {
    if (AppState.sortColumn === column) {
        if (AppState.sortDirection === 'asc') {
            AppState.sortDirection = 'desc';
        } else {
            AppState.sortColumn    = null;
            AppState.sortDirection = 'asc';
        }
    } else {
        AppState.sortColumn    = column;
        AppState.sortDirection = 'asc';
    }
    applyFilters();
}

// ── 차트 ──────────────────────────────────────────────────

/**
 * 구역별 불일치 건수 바 차트와 상태 비율 도넛 차트를 렌더링합니다.
 * @param {Object[]} data - AppState.comparisonResult
 */
function renderCharts(data) {
    const activeData = filterActiveRows(data);

    // 구역별 이슈 집계
    const issueByZone = {};
    activeData.filter(r => r.status === 'MISMATCH' || r.status === 'LOCATION_SHIFT').forEach(r => {
        const zone = r.warehouseZone || '(없음)';
        issueByZone[zone] = (issueByZone[zone] || 0) + 1;
    });
    const zoneLabels = Object.keys(issueByZone).sort();
    const zoneCounts = zoneLabels.map(z => issueByZone[z]);

    if (AppState.charts.bar) AppState.charts.bar.destroy();
    const barCtx = document.getElementById('zone-bar-chart')?.getContext('2d');
    if (barCtx) {
        AppState.charts.bar = new Chart(barCtx, {
            type: 'bar',
            data: {
                labels: zoneLabels,
                datasets: [{
                    label: '불일치/위치이동 건수',
                    data: zoneCounts,
                    backgroundColor: '#F59E0B',
                    borderColor: '#D97706',
                    borderWidth: 1,
                    borderRadius: 6,
                    maxBarThickness: 48,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: ctx => `${ctx.parsed.y}건` } },
                },
                scales: {
                    x: {
                        title: { display: true, text: '창고 구역 (Zone)', font: { weight: 'bold' } },
                        grid:  { display: false },
                    },
                    y: {
                        title: { display: true, text: '건수', font: { weight: 'bold' } },
                        beginAtZero: true,
                        ticks: { precision: 0 },
                    },
                },
            },
        });
    }

    // 상태 비율 도넛
    const statusCounts = { MATCH: 0, MISMATCH: 0, LOCATION_SHIFT: 0, ONLY_IN_EMP: 0, ONLY_IN_PHYSICAL: 0 };
    activeData.forEach(r => { if (statusCounts[r.status] !== undefined) statusCounts[r.status]++; });

    if (AppState.charts.pie) AppState.charts.pie.destroy();
    const pieCtx = document.getElementById('status-pie-chart')?.getContext('2d');
    if (pieCtx) {
        AppState.charts.pie = new Chart(pieCtx, {
            type: 'doughnut',
            data: {
                labels: ['일치', '불일치', '타위치발견', 'EMP에만', '실사에만'],
                datasets: [{
                    data: [
                        statusCounts.MATCH,
                        statusCounts.MISMATCH,
                        statusCounts.LOCATION_SHIFT,
                        statusCounts.ONLY_IN_EMP,
                        statusCounts.ONLY_IN_PHYSICAL,
                    ],
                    backgroundColor: ['#10B981', '#F59E0B', '#0EA5E9', '#EF4444', '#8B5CF6'],
                    borderColor: '#fff',
                    borderWidth: 3,
                    hoverOffset: 8,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '55%',
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { padding: 16, usePointStyle: true, font: { size: 12 } },
                    },
                    tooltip: {
                        callbacks: {
                            label: ctx => {
                                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                                const pct   = total > 0 ? ((ctx.parsed / total) * 100).toFixed(1) : 0;
                                return ` ${ctx.label}: ${ctx.parsed}건 (${pct}%)`;
                            },
                        },
                    },
                },
            },
        });
    }
}

// ── Top 10 차이 테이블 ─────────────────────────────────────

/** 차이(절대값) 상위 10개 행을 렌더링합니다. */
function renderTopDiffTable() {
    const data = AppState.filteredResult
        .filter(r => ['MISMATCH', 'ONLY_IN_EMP', 'ONLY_IN_PHYSICAL', 'LOCATION_SHIFT'].includes(r.status))
        .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference))
        .slice(0, 10);

    const container = document.getElementById('top-diff-table-wrap');
    if (!container) return;
    if (data.length === 0) {
        container.innerHTML = '<p style="padding:16px;color:#9CA3AF;text-align:center;">차이가 있는 항목이 없습니다.</p>';
        return;
    }

    let html = '<table><thead><tr><th>#</th><th>SKU</th><th>상품명</th><th>위치</th><th>구역</th><th>EMP 수량</th><th>실사 수량</th><th>차이</th><th>상태</th></tr></thead><tbody>';
    data.forEach((r, i) => {
        html += `<tr class="${getRowClass(r.status)}">
            <td>${i + 1}</td>
            <td>${esc(r.sku)}</td>
            <td>${esc(r.name)}</td>
            <td>${esc(r.location)}</td>
            <td>${esc(r.warehouseZone)}</td>
            <td>${formatNum(r.empQty)}</td>
            <td>${formatNum(r.physicalQty)}</td>
            <td class="${getDiffClass(r.difference)}">${r.difference > 0 ? '+' : ''}${formatNum(r.difference)}</td>
            <td>${statusBadge(r.status)}</td>
        </tr>`;
    });
    html += '</tbody></table>';
    container.innerHTML = html;
}

// ── 전역 리프레시 ─────────────────────────────────────────

/**
 * KPI, 차트, 필터를 일괄 갱신합니다.
 * 스크롤 위치와 페이지 번호를 보존합니다.
 */
function refreshDashboard() {
    const savedPage    = AppState.currentPage;
    const scrollParent = document.querySelector('.main-content') || document.documentElement;
    const savedScroll  = scrollParent.scrollTop;

    renderKPIs(AppState.comparisonResult);
    renderCharts(AppState.comparisonResult);
    applyFilters();

    const totalPages = Math.max(1, Math.ceil(AppState.filteredResult.length / AppState.pageSize));
    AppState.currentPage = Math.min(savedPage, totalPages);
    if (AppState.currentPage !== 1 && typeof renderMainTable === 'function') renderMainTable();

    syncZoneProgressVisibility();
    renderAssigneePanel();
    if (typeof debouncedPushToFirebase === 'function') debouncedPushToFirebase();
    triggerAutoSave();

    requestAnimationFrame(() => { scrollParent.scrollTop = savedScroll; });
}

// ── 수량 변경 후 KPI/차트 디바운스 갱신 ─────────────────────
const _debouncedFullRefresh = debounce(() => {
    renderCharts(AppState.comparisonResult);
    syncZoneProgressVisibility();
}, 1000);

// ── 뷰 탭 전환 ───────────────────────────────────────────

/**
 * 뷰 탭을 전환합니다.
 * @param {'overview'|'livecount'|'adjustment'} viewName
 */
function switchView(viewName) {
    AppState.currentView = viewName;
    syncZoneProgressVisibility();
    syncMobileTabState(viewName);

    document.querySelectorAll('.view-tab').forEach(tab => {
        tab.classList.toggle('active', tab.getAttribute('data-view') === viewName);
    });

    const scanBar          = document.getElementById('live-scan-bar');
    const chartsSection    = document.getElementById('charts-section');
    const topDiffSection   = document.getElementById('top-diff-section');
    const liveBadge        = document.getElementById('live-badge');
    const dataTableSection = document.querySelector('.data-table-section');
    const adjSection       = document.getElementById('adjustment-section');
    const sbSection        = document.getElementById('scoreboard-section');

    if (scanBar)           scanBar.style.display           = 'none';
    if (chartsSection)     chartsSection.style.display     = 'none';
    if (topDiffSection)    topDiffSection.style.display    = 'none';
    if (liveBadge)         liveBadge.style.display         = 'none';
    if (dataTableSection)  dataTableSection.style.display  = '';
    if (adjSection)        adjSection.style.display        = 'none';
    if (sbSection)         sbSection.style.display         = 'none';

    /** fade-in 헬퍼: display 설정 후 animation 재실행 */
    function _showFade(el, displayType) {
        if (!el) return;
        el.style.display = displayType || '';
        el.classList.remove('view-fade-in');
        void el.offsetWidth; // reflow 강제
        el.classList.add('view-fade-in');
    }

    if (viewName === 'overview') {
        _showFade(chartsSection);
        _showFade(topDiffSection);
        refreshDashboard();
    } else if (viewName === 'livecount') {
        _showFade(scanBar, 'flex');
        if (liveBadge) liveBadge.style.display = 'inline-block';
        refreshDashboard();
        requestAnimationFrame(() => {
            document.getElementById('live-scan-input')?.focus();
        });
    } else if (viewName === 'adjustment') {
        if (dataTableSection) dataTableSection.style.display = 'none';
        _showFade(adjSection);
        if (typeof renderAdjustmentView === 'function') renderAdjustmentView();
    } else if (viewName === 'scoreboard') {
        if (dataTableSection) dataTableSection.style.display = 'none';
        _showFade(sbSection);
        if (typeof renderScoreboard === 'function') renderScoreboard();
    }

    updateSidebarPosition();
}

function updateSidebarPosition() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    if (AppState.currentView === 'livecount') {
        sidebar.style.top    = 'calc(var(--header-h) + var(--scan-bar-h))';
        sidebar.style.height = 'calc(100vh - var(--header-h) - var(--scan-bar-h))';
    } else {
        sidebar.style.top    = 'var(--header-h)';
        sidebar.style.height = 'calc(100vh - var(--header-h))';
    }
}

function syncMobileTabState(viewName) {
    document.querySelectorAll('.mobile-nav-btn[data-view]').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-view') === viewName);
    });
}

// ── 모바일 사이드바 / 내보내기 드로워 ──────────────────────

function openSidebar() {
    document.getElementById('sidebar')?.classList.add('open');
    document.getElementById('sidebar-overlay')?.classList.add('visible');
    document.body.style.overflow = 'hidden';
}
function closeSidebar() {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebar-overlay')?.classList.remove('visible');
    document.body.style.overflow = '';
}
function openExportDrawer() {
    const drawer  = document.getElementById('mobile-export-drawer');
    const overlay = document.getElementById('mobile-drawer-overlay');
    if (!drawer) return;
    drawer.style.display = 'block';
    overlay?.classList.add('visible');
    requestAnimationFrame(() => drawer.classList.add('open'));
}
function closeExportDrawer() {
    const drawer  = document.getElementById('mobile-export-drawer');
    const overlay = document.getElementById('mobile-drawer-overlay');
    if (!drawer) return;
    drawer.classList.remove('open');
    overlay?.classList.remove('visible');
    setTimeout(() => { drawer.style.display = 'none'; }, 300);
}

// ── 구역 진행률 ───────────────────────────────────────────

/** 구역별 진행률 카드를 렌더링합니다. */
function renderZoneProgress() {
    const panel = document.getElementById('zone-progress-panel');
    const grid  = document.getElementById('zone-progress-grid');
    if (!panel || !grid) return;

    const data = AppState.comparisonResult;
    if (!data || data.length === 0) return;

    const allZones = [...new Set(data.map(r => r.warehouseZone).filter(Boolean))].sort();
    if (allZones.length === 0) return;

    const activeZone = document.getElementById('zone-filter')?.value || 'ALL';

    let visibleZones = allZones;
    let filterLabel  = '';
    if (AppState.assigneeName) {
        const myZones = Object.entries(AppState.zoneAssignees)
            .filter(([, v]) => v === AppState.assigneeName)
            .map(([k]) => k)
            .filter(z => allZones.includes(z))
            .sort();
        if (myZones.length > 0) {
            visibleZones = myZones;
            filterLabel  = `${AppState.assigneeName} 담당`;
        }
    }

    const titleEl = document.querySelector('.zone-progress-title span');
    if (titleEl) {
        titleEl.innerHTML = filterLabel
            ? `구역별 실사 진행률 <span class="zone-filter-badge">${esc(filterLabel)}</span>`
            : '구역별 실사 진행률';
    }

    let html = '';
    visibleZones.forEach(zone => {
        let zoneRows = filterActiveRows(data.filter(r => r.warehouseZone === zone));
        const total  = zoneRows.length;
        if (total === 0) return;

        const localScanned = zoneRows.filter(r =>
            r.physicalQty > 0 ||
            AppState.completedRows.has(r._rowId) ||
            r._touched ||
            r.status === 'MATCH' ||
            r.status === 'LOCATION_SHIFT'
        ).length;

        const remote  = AppState.remoteProgress && AppState.remoteProgress[zone];
        const scanned = remote ? Math.max(localScanned, remote.scanned) : localScanned;
        const pct        = Math.round((scanned / total) * 100);
        const isComplete = pct >= 100;
        const isActive   = activeZone === zone;

        const remoteBy = remote && remote.updatedBy && remote.updatedBy !== '_self'
            && remote.updatedBy !== AppState.assigneeName
            ? `<span class="zone-card-remote-by"><i class="fas fa-user"></i> ${esc(remote.updatedBy)}</span>`
            : '';

        // zone 카드의 onclick은 index.html에서 data-* 기반 이벤트 위임으로 교체됨
        html += `<div class="zone-card${isActive ? ' active-zone' : ''}${isComplete ? ' zone-complete' : ''}" data-zone="${esc(zone)}">
            ${isComplete ? '<div class="zone-card-complete-badge"><i class="fas fa-check"></i></div>' : ''}
            <div class="zone-card-top">
                <span class="zone-card-name">${esc(zone)}</span>
                <span class="zone-card-pct">${pct}%</span>
            </div>
            <div class="zone-progress-bar-wrap">
                <div class="zone-progress-bar-fill" style="width:${pct}%"></div>
            </div>
            <div class="zone-card-stats">
                <span class="zone-stat-scanned">${scanned}건 완료</span>
                <span class="zone-stat-total">/ ${total}건</span>
                ${remoteBy}
            </div>
        </div>`;
    });

    grid.innerHTML = html || '<p style="font-size:0.8rem;color:var(--text-muted);">표시할 구역이 없습니다.</p>';
}

/**
 * 구역 카드 클릭 시 해당 구역으로 필터를 전환합니다.
 * 이미 선택된 구역 클릭 시 'ALL'로 토글합니다.
 * @param {string} zone
 */
function selectZoneFromCard(zone) {
    const zoneFilter = document.getElementById('zone-filter');
    if (!zoneFilter) return;
    zoneFilter.value = zoneFilter.value === zone ? 'ALL' : zone;
    applyFilters();
    renderZoneProgress();
}

/** 모바일에서 구역 진행률 패널을 접기/펼치기 합니다. */
function toggleZoneProgressPanel() {
    if (window.innerWidth > 768) return;
    document.getElementById('zone-progress-panel')?.classList.toggle('expanded');
}

/** livecount 뷰에서만 구역 진행률 패널을 표시합니다. */
function syncZoneProgressVisibility() {
    const panel  = document.getElementById('zone-progress-panel');
    if (!panel) return;
    const isLive = AppState.currentView === 'livecount';
    const hasData = AppState.comparisonResult && AppState.comparisonResult.length > 0;
    panel.style.display = (isLive && hasData) ? 'block' : 'none';
    if (isLive && hasData) renderZoneProgress();
}

// ── 담당자 패널 ───────────────────────────────────────────

/** localStorage에서 담당자 설정을 불러옵니다. */
function loadAssigneeSettings() {
    try {
        const raw = localStorage.getItem(ASSIGNEE_STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        const legacyWorkers = [...new Set(Object.values(data.zones || {}).filter(Boolean))];
        AppState.assigneeName  = data.name   || '';
        AppState.workers       = data.workers || (data.name ? [...new Set([data.name, ...legacyWorkers])] : legacyWorkers);
        AppState.zoneAssignees = data.zones  || {};
        AppState.myZonesOnly   = false;
    } catch (e) { /* 조용히 무시 */ }
}

/** 담당자 설정을 localStorage에 저장합니다. */
function saveAssigneeSettings() {
    localStorage.setItem(ASSIGNEE_STORAGE_KEY, JSON.stringify({
        name:    AppState.assigneeName,
        workers: AppState.workers,
        zones:   AppState.zoneAssignees,
    }));
}

/** 담당자 패널 전체를 재렌더합니다. */
function renderAssigneePanel() {
    const badge      = document.getElementById('worker-badge');
    const badgeName  = document.getElementById('worker-badge-name');
    const myZonesBtn = document.getElementById('my-zones-only-btn');
    const chipList   = document.getElementById('assignee-chip-list');

    if (badge && badgeName) {
        badgeName.textContent = AppState.assigneeName;
        badge.style.display   = AppState.assigneeName ? 'flex' : 'none';
    }

    // 담당자 칩 목록
    if (chipList) {
        if (AppState.workers.length === 0) {
            chipList.innerHTML = '<p style="font-size:0.75rem;color:var(--text-muted);">등록된 담당자가 없습니다.</p>';
        } else {
            chipList.innerHTML = AppState.workers.map(w => {
                const isMe = w === AppState.assigneeName;
                // onclick inline handler 제거 → data-worker 기반 이벤트 위임으로 교체
                return `<span class="assignee-chip${isMe ? ' is-me' : ''}">
                    ${isMe ? '<i class="fas fa-user" style="font-size:0.7rem;"></i>' : ''}
                    ${esc(w)}
                    <button class="assignee-chip-del" data-worker="${esc(w)}" title="${esc(w)} 삭제">
                        <i class="fas fa-xmark"></i>
                    </button>
                </span>`;
            }).join('');
        }
    }

    // 구역별 담당자 드롭다운
    let zones = [...new Set(AppState.comparisonResult.map(r => r.warehouseZone).filter(Boolean))].sort();
    if (zones.length === 0 && AppState.comparisonResult.length > 0) {
        AppState.comparisonResult.forEach(r => {
            if (!r.warehouseZone && r.location) r.warehouseZone = parseWarehouseZone(r.location);
        });
        zones = [...new Set(AppState.comparisonResult.map(r => r.warehouseZone).filter(Boolean))].sort();
    }

    const list      = document.getElementById('assignee-zone-list');
    const zoneLabel = document.getElementById('assignee-zone-label');
    if (!list) return;

    if (zones.length === 0) {
        list.innerHTML = '<p style="font-size:0.78rem;color:var(--text-muted);font-style:italic;">비교 실행 후 구역이 표시됩니다.</p>';
        if (zoneLabel)  zoneLabel.style.display  = 'none';
        if (myZonesBtn) myZonesBtn.style.display = 'none';
        return;
    }
    if (zoneLabel)  zoneLabel.style.display  = 'block';

    let html = '';
    zones.forEach(zone => {
        const assigned = AppState.zoneAssignees[zone] || '';
        const isMe     = assigned === AppState.assigneeName && AppState.assigneeName;
        // onchange inline handler 제거 → data-zone 기반 이벤트 위임으로 교체
        html += `<div class="assignee-zone-row">
            <span class="assignee-zone-label">${esc(zone)}</span>
            <select class="assignee-zone-select${isMe ? ' assigned-me' : ''}" data-zone="${esc(zone)}">
                <option value="">미배정</option>`;
        AppState.workers.forEach(w => {
            html += `<option value="${esc(w)}"${assigned === w ? ' selected' : ''}>${esc(w)}</option>`;
        });
        if (assigned && !AppState.workers.includes(assigned)) {
            html += `<option value="${esc(assigned)}" selected>${esc(assigned)} ⚠️</option>`;
        }
        html += `</select></div>`;
    });
    list.innerHTML = html;

    if (myZonesBtn) {
        myZonesBtn.style.display = AppState.assigneeName ? 'block' : 'none';
        myZonesBtn.innerHTML = AppState.myZonesOnly
            ? '<i class="fas fa-globe"></i> 전체 구역 보기'
            : '<i class="fas fa-user-check"></i> 내 구역만 보기';
    }
}

/** 구역 담당자 select 변경 핸들러 (이벤트 위임에서 호출) */
function onZoneAssigneeChange(selectEl) {
    const zone  = selectEl.getAttribute('data-zone');
    const value = selectEl.value;
    AppState.zoneAssignees[zone] = value;
    saveAssigneeSettings();
    renderAssigneePanel();
    renderZoneProgress();
}

/** 담당자 추가. 로그인 중일 때는 workers만 추가합니다. */
function saveAssigneeName() {
    const input = document.getElementById('assignee-name-input');
    if (!input) return;
    const name = input.value.trim();
    if (!name) { toast('이름을 입력해 주세요.', 'warning'); return; }

    if (AppState.currentUser) {
        if (AppState.workers.includes(name)) {
            toast(`담당자 "${name}"은 이미 등록되어 있습니다.`, 'info');
            input.value = '';
            return;
        }
        AppState.workers.push(name);
        saveAssigneeSettings();
        renderAssigneePanel();
        toast(`담당자 "${name}" 추가됐습니다.`, 'success');
        input.value = '';
        return;
    }

    if (AppState.workers.includes(name)) {
        AppState.assigneeName = name;
        saveAssigneeSettings();
        renderAssigneePanel();
        toast(`"${name}"을 내 담당자로 설정했습니다.`, 'info');
        input.value = '';
        return;
    }

    AppState.workers.push(name);
    if (!AppState.assigneeName) AppState.assigneeName = name;
    saveAssigneeSettings();
    renderAssigneePanel();
    toast(`담당자 "${name}" 추가됐습니다.`, 'success');
    input.value = '';
}

/** 담당자 삭제. 해당 담당자의 구역 배정도 해제합니다. */
function removeWorker(name) {
    if (!window.confirm(`"${name}" 담당자를 삭제하시겠습니까?\n해당 담당자의 구역 배정도 함께 해제됩니다.`)) return;
    AppState.workers = AppState.workers.filter(w => w !== name);
    Object.keys(AppState.zoneAssignees).forEach(zone => {
        if (AppState.zoneAssignees[zone] === name) AppState.zoneAssignees[zone] = '';
    });
    if (AppState.assigneeName === name) AppState.assigneeName = AppState.workers[0] || '';
    saveAssigneeSettings();
    renderAssigneePanel();
    renderZoneProgress();
    toast(`"${name}" 담당자가 삭제됐습니다.`, 'info');
}

/** 담당자 전체 초기화 */
function resetAllAssignees() {
    if (!window.confirm('담당자 목록과 구역 배정을 모두 초기화하시겠습니까?')) return;
    AppState.workers       = [];
    AppState.assigneeName  = '';
    AppState.zoneAssignees = {};
    AppState.myZonesOnly   = false;
    saveAssigneeSettings();
    renderAssigneePanel();
    renderZoneProgress();
    applyFilters();
    toast('담당자 설정이 초기화됐습니다.', 'info');
}

/** 내 구역만 보기 토글 */
function toggleMyZonesOnly() {
    if (!AppState.assigneeName) { toast('먼저 담당자 이름을 설정해 주세요.', 'warning'); return; }
    AppState.myZonesOnly = !AppState.myZonesOnly;
    applyFilters();
    renderAssigneePanel();
    toast(AppState.myZonesOnly ? '내 담당 구역만 표시합니다.' : '전체 구역을 표시합니다.', 'info');
}

// ── 다크 테마 ─────────────────────────────────────────────

function initTheme() {
    const saved = localStorage.getItem(THEME_KEY) || 'light';
    applyTheme(saved);
    // 리스너는 app.js DOMContentLoaded에서 등록 (이중 바인딩 방지)
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
    const icon = document.getElementById('theme-icon');
    if (icon) icon.className = theme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
    if (AppState.charts.bar || AppState.charts.pie) {
        const isDark = theme === 'dark';
        Chart.defaults.color       = isDark ? '#9CA3AF' : '#6B7280';
        Chart.defaults.borderColor = isDark ? '#2D3148' : '#E2E5EC';
        if (AppState.comparisonResult.length > 0) renderCharts(AppState.comparisonResult);
    }
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    applyTheme(current === 'dark' ? 'light' : 'dark');
}

// ── localStorage 자동저장 ─────────────────────────────────

/** state.js의 triggerAutoSave에 의해 호출되는 저장 인디케이터 갱신 래퍼 */
function updateAutoSaveIndicator(state) {
    const el = document.getElementById('autosave-status');
    if (!el) return;
    if (state === 'saving') {
        el.textContent = '저장 중...';
        el.className   = 'autosave-saving';
    } else {
        el.textContent = '저장됨';
        el.className   = 'autosave-saved';
        const textEl = document.getElementById('autosave-text');
        if (textEl) textEl.textContent = '자동저장 완료';
    }
}

// saveToLocalStorage() 제거됨 — 필터링 로직이 state.js serializeState()로 통합됨
// 실제 저장: triggerAutoSave() → persistState() → serializeState()

/**
 * localStorage에서 저장된 상태를 불러옵니다.
 * @returns {Object|null}
 */
function loadFromLocalStorage() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data || !Array.isArray(data.comparisonResult)) return null;
        return data;
    } catch (e) {
        return null;
    }
}

/** localStorage에서 불러온 데이터를 AppState에 복원합니다. */
function restoreFromSavedData(data) {
    // 슬림 저장에서 제거된 파생 필드 재계산 (difference, warehouseZone 등)
    AppState.comparisonResult = (data.comparisonResult || []).map(r => ({
        ...r,
        warehouseZone: r.warehouseZone || (typeof parseWarehouseZone === 'function' ? parseWarehouseZone(r.location) : ''),
        difference:    (r.physicalQty || 0) - (r.empQty || 0),
        reason:        r.reason   || '',
        memo:          r.memo     || '',
        _touched:      r._touched || false,
        _scanned:      r._scanned || false,
    }));
    // [C3 수정] 복원된 행 ID 최대값으로 카운터 동기화 (ID 충돌 방지)
    syncRowIdCounter(AppState.comparisonResult);
    AppState.filteredResult   = [...AppState.comparisonResult];
    AppState.isEmpOnly        = data.isEmpOnly  ?? false;
    AppState.recountData      = data.recountData || {};
    AppState.assigneeName     = data.assigneeName || '';
    AppState.workers          = data.workers      || [];
    AppState.zoneAssignees    = data.zoneAssignees || {};

    AppState.completedRows = new Set(data.completedRows || []);
    notifySubscribers('completedRows', AppState.completedRows, null);
    AppState.adjApproved = new Set(data.adjApproved || []);
    notifySubscribers('adjApproved', AppState.adjApproved, null);

    switchPhase('dashboard');
    renderKPIs(AppState.comparisonResult);
    populateZoneFilter(AppState.comparisonResult);
    renderCharts(AppState.comparisonResult);
    if (typeof renderMainTable === 'function') renderMainTable();
    if (typeof renderAdjustmentView === 'function' && AppState.currentView === 'adjustment') {
        renderAdjustmentView();
    }

    const viewName = data.currentView || 'overview';
    switchView(viewName);
    renderAssigneePanel();
    toast(`이전 데이터 ${AppState.comparisonResult.length}건이 복원됐습니다.`, 'success');
}

/** localStorage 데이터 삭제 */
function clearLocalStorage() {
    localStorage.removeItem(LS_KEY);
}

// ── 내부 헬퍼 ─────────────────────────────────────────────

function _setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function _setTextIfEl(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}
