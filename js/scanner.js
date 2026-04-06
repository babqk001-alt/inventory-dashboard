/* scanner.js — 바코드 스캔, 카메라 스캐너, 스캔 세션 카운터
 * 의존: utils.js, state.js, dashboard-ui.js, table-renderer.js
 */
'use strict';

// ═══════════════════════════════════════════════════════
// 1. 스캔 세션 카운터
// ═══════════════════════════════════════════════════════

/** 세션 내 스캔 횟수 추적 */
const ScanSession = {
    count: 0,
};

/** 카운터 +1 증가 및 UI 업데이트 */
function incrementScanCounter() {
    ScanSession.count++;
    renderScanCounter();
}

/** 카운터 UI 업데이트 */
function renderScanCounter() {
    const el = document.getElementById('session-scan-count');
    if (el) el.textContent = ScanSession.count;
}

/** 카운터 초기화 */
function resetScanCounter() {
    ScanSession.count = 0;
    renderScanCounter();
}

// ═══════════════════════════════════════════════════════
// 2. 스캔 상태 인디케이터
// ═══════════════════════════════════════════════════════

/**
 * 스캔 상태 도트 + 텍스트 업데이트 (3초 후 자동 복원)
 * @param {'success'|'error'|''} status - CSS 클래스로 사용
 * @param {string} text - 표시할 텍스트
 */
function updateScanStatus(status, text) {
    const dot = document.querySelector('.scan-status-dot');
    const textEl = document.querySelector('.scan-status-text');

    dot.className = 'scan-status-dot';
    if (status) dot.classList.add(status);
    textEl.textContent = text || '대기 중';

    setTimeout(() => {
        dot.className = 'scan-status-dot';
        textEl.textContent = '대기 중';
    }, 3000);
}

// ═══════════════════════════════════════════════════════
// 3. 바코드/SKU 스캔 처리
// ═══════════════════════════════════════════════════════

/**
 * 스캔된 바코드/SKU 값 처리 메인 함수
 * 탐색 순서: 현재 필터 내 → 구역 범위 내 → 전체
 * @param {string} scannedValue - 스캐너로 입력된 값
 */
function processScanValue(scannedValue) {
    if (!scannedValue || !scannedValue.trim()) return;

    const term = scannedValue.trim().toLowerCase();
    const activeZone = document.getElementById('zone-filter').value;
    const locSel = document.getElementById('location-filter');
    const activeLocation = locSel ? locSel.value : 'ALL';

    // 내 구역 제한 여부 계산
    const myZones = (AppState.myZonesOnly && AppState.assigneeName)
        ? Object.entries(AppState.zoneAssignees)
            .filter(([, v]) => v === AppState.assigneeName)
            .map(([k]) => k)
        : [];
    const isZoneRestricted = activeZone !== 'ALL' || myZones.length > 0;

    // 데이터셋에서 SKU 또는 바코드로 매칭되는 모든 행 반환
    function findAllMatches(dataset) {
        let m = dataset.filter(r =>
            (r.sku && r.sku.toLowerCase() === term) ||
            (r.barcode && r.barcode.toLowerCase() === term)
        );
        // [QC-P2] 완전일치 없으면 SKU만 부분일치 fallback (barcode는 exact-only)
        if (m.length === 0) {
            m = dataset.filter(r =>
                (r.sku && r.sku.toLowerCase().includes(term))
            );
        }
        return m;
    }

    // 매칭 결과에서 최종 대상 행 결정
    // - 세부 위치 필터가 설정된 경우 즉시 이동
    // - 복수 위치인 경우 팝업 표시 후 '__MODAL__' 반환
    function resolveMatch(matches) {
        if (matches.length === 0) return null;

        if (activeLocation !== 'ALL') {
            const locM = matches.find(r => r.location === activeLocation);
            if (locM) return locM;
        }

        // 전체 데이터에서 동일 SKU/바코드의 모든 위치 수집 (팝업 판단용)
        const refSku = normalize(matches[0].sku);
        const refBarcode = normalize(matches[0].barcode);
        const allLocations = AppState.comparisonResult.filter(r =>
            (refSku && normalize(r.sku) === refSku) ||
            (refBarcode && refBarcode && normalize(r.barcode) === refBarcode)
        );

        // 정말 1개 위치뿐인 상품 → 바로 이동
        if (matches.length === 1 && allLocations.length === 1) {
            return matches[0];
        }

        // 복수 위치 → 전체 위치 목록 팝업
        _openDupScanModal(
            allLocations.length > matches.length ? allLocations : matches,
            scannedValue,
            activeLocation
        );
        return '__MODAL__';
    }

    // Step 1: 현재 필터 결과 내 탐색
    let allMatches = findAllMatches(AppState.filteredResult);
    let targetRow = resolveMatch(allMatches);
    if (targetRow === '__MODAL__') return;

    // Step 2: 구역 범위 내 재탐색 (상태필터·검색어만 해제)
    if (!targetRow && isZoneRestricted) {
        let scopeData;
        if (activeZone !== 'ALL') {
            scopeData = AppState.comparisonResult.filter(r => r.warehouseZone === activeZone);
        } else {
            scopeData = AppState.comparisonResult.filter(r => myZones.includes(r.warehouseZone));
        }
        if (activeLocation !== 'ALL') {
            const locScope = scopeData.filter(r => r.location === activeLocation);
            if (locScope.length > 0) scopeData = locScope;
        }
        allMatches = findAllMatches(scopeData);
        targetRow = resolveMatch(allMatches);
        if (targetRow === '__MODAL__') return;
        if (targetRow) {
            // 상태·검색 필터만 해제하고 구역 유지
            document.querySelector('input[name="status-filter"][value="ALL"]').checked = true;
            resetStatusRadioUI();
            document.getElementById('search-input').value = '';
            AppState.multiSearchTerms = [];
            applyFilters();
        }
    }

    // Step 3: 전체에서 탐색
    if (!targetRow) {
        allMatches = findAllMatches(AppState.comparisonResult);
        if (allMatches.length > 0) {
            if (isZoneRestricted) {
                if (activeLocation !== 'ALL') {
                    const locM = allMatches.find(r => r.location === activeLocation);
                    if (locM) allMatches = [locM];
                }
                const candidate = allMatches[0];
                const zoneLabel = activeZone !== 'ALL' ? activeZone : `내 구역(${myZones.join(', ')})`;
                const otherZone = candidate.warehouseZone || '(구역 없음)';
                const goAnyway = window.confirm(
                    `"${scannedValue}"\n\n현재 구역(${zoneLabel})에는 해당 상품이 없습니다.\n` +
                    `다른 구역(${otherZone})에서 발견되었습니다.\n\n` +
                    `해당 위치로 이동하시겠습니까?`
                );
                if (!goAnyway) {
                    playBeepError();
                    updateScanStatus('error', `구역 외 상품 (${otherZone})`);
                    toast(`현재 구역에 없는 상품입니다. 위치: ${otherZone}`, 'warning');
                    return;
                }
                AppState.myZonesOnly = false;
            }
            if (allMatches.length > 1) {
                _resetAllFilters();
                _openDupScanModal(allMatches, scannedValue, activeLocation);
                return;
            }
            targetRow = allMatches[0];
            _resetAllFilters();
        }
    }

    if (!targetRow) {
        playBeepError();
        updateScanStatus('error', '미등록 바코드');
        toast(`"${scannedValue}" — EMP에 등록되지 않은 바코드/SKU입니다.`, 'error');
        return;
    }

    _navigateToRow(targetRow);
}

// ═══════════════════════════════════════════════════════
// 4. 스캔 내부 헬퍼 함수
// ═══════════════════════════════════════════════════════

/** 전체 필터 초기화 (상태·구역·위치·검색·다중검색) */
function _resetAllFilters() {
    document.querySelector('input[name="status-filter"][value="ALL"]').checked = true;
    resetStatusRadioUI();
    document.getElementById('zone-filter').value = 'ALL';
    const locSel = document.getElementById('location-filter');
    if (locSel) { locSel.value = 'ALL'; AppState.locationFilter = 'ALL'; }
    document.getElementById('search-input').value = '';
    AppState.multiSearchTerms = [];
    populateLocationFilter(AppState.comparisonResult);
    applyFilters();
    renderAssigneePanel();
}

/**
 * 동일 상품 복수 위치 선택 모달 열기 (+ 새 위치 추가 버튼 포함)
 * @param {object[]} matches - 동일 상품의 행 배열
 * @param {string} scannedValue - 원래 스캔값
 * @param {string} activeLocation - 현재 위치 필터값
 */
function _openDupScanModal(matches, scannedValue, activeLocation) {
    const modal = document.getElementById('dup-scan-modal');
    const desc  = document.getElementById('dup-scan-desc');
    const list  = document.getElementById('dup-scan-list');

    const refRow = matches[0];
    const label = refRow.sku || refRow.barcode || scannedValue;
    desc.innerHTML = `<strong>"${esc(label)}"</strong> 상품이 <strong>${matches.length}개 위치</strong>에 존재합니다. 실사할 위치를 선택하거나 새 위치를 추가하세요.`;

    let html = '';
    matches.forEach(r => {
        const pref = (activeLocation !== 'ALL' && r.location === activeLocation);
        const done = AppState.completedRows.has(r._rowId);
        const qty = done ? '✅ 완료' : `EMP ${formatNum(r.empQty)} → 실사 ${formatNum(r.physicalQty)}`;
        html += `<div class="dup-scan-item${pref ? ' preferred' : ''}" data-row-id="${r._rowId}">
            <div class="dup-scan-item-icon"><i class="fas fa-location-dot"></i></div>
            <div class="dup-scan-item-body">
                <div class="dup-scan-item-loc">${esc(r.location || '(위치 없음)')}</div>
                <div class="dup-scan-item-meta">구역: ${esc(r.warehouseZone || '-')} · ${esc(r.name || '')}</div>
            </div>
            <div class="dup-scan-item-qty">${qty}</div>
            ${pref ? '<span class="dup-scan-pref-badge">현재 위치</span>' : ''}
        </div>`;
    });
    // 새 위치 추가 버튼
    html += `<div class="dup-scan-item dup-scan-new-loc" id="dup-scan-new-loc-btn">
        <div class="dup-scan-item-icon" style="background:var(--only-physical-bg);color:var(--only-physical);"><i class="fas fa-plus"></i></div>
        <div class="dup-scan-item-body">
            <div class="dup-scan-item-loc" style="color:var(--only-physical);">새 위치에 추가</div>
            <div class="dup-scan-item-meta">위의 위치가 아닌 다른 곳에서 발견한 경우</div>
        </div>
    </div>`;
    list.innerHTML = html;

    // 기존 위치 클릭 → 해당 행으로 이동
    list.querySelectorAll('.dup-scan-item:not(.dup-scan-new-loc)').forEach(item => {
        item.addEventListener('click', () => {
            const row = AppState.comparisonResult.find(r => r._rowId === item.getAttribute('data-row-id'));
            _closeDupScanModal();
            if (row) {
                _ensureRowVisible(row);
                _navigateToRow(row);
            }
        });
    });

    // 새 위치 추가 클릭
    document.getElementById('dup-scan-new-loc-btn').addEventListener('click', () => {
        _closeDupScanModal();
        _promptNewLocation(refRow, scannedValue);
    });

    modal.style.display = 'flex';
    playBeepSuccess();
    modal.onclick = e => { if (e.target === modal) _closeDupScanModal(); };
    document.getElementById('dup-scan-close-btn').onclick = _closeDupScanModal;
    document.getElementById('dup-scan-cancel-btn').onclick = _closeDupScanModal;
}

/**
 * 기존 상품에 새 위치 행 추가 (위치 형식 검증 포함)
 * 추가된 행은 ONLY_IN_PHYSICAL 상태로 삽입 후 해당 행으로 자동 이동
 * @param {object} refRow - 상품 정보 참조 행
 * @param {string} scannedValue - 원래 스캔값
 */
function _promptNewLocation(refRow, scannedValue) {
    const existingLocs = AppState.comparisonResult
        .filter(r =>
            normalize(r.sku) === normalize(refRow.sku) ||
            (r.barcode && normalize(r.barcode) === normalize(refRow.barcode))
        )
        .map(r => `  • ${r.location} (EMP ${r.empQty})`)
        .join('\n');

    const locInput = prompt(
        `"${refRow.sku || refRow.barcode}" 상품의 새 위치(로케이션)를 입력하세요.\n\n` +
        `형식: XX-XX-XX-XX (예: 01-04-R6-A1)\n\n` +
        `기존 위치:\n` + existingLocs
    );
    if (!locInput || !locInput.trim()) {
        toast('위치 입력이 취소되었습니다.', 'info');
        return;
    }

    const location = locInput.trim();

    // 위치 형식 검증 (각 세그먼트: 영문+숫자 1~4자, 4세그먼트)
    const locPattern = /^[A-Za-z0-9]{1,4}-[A-Za-z0-9]{1,4}-[A-Za-z0-9]{1,4}-[A-Za-z0-9]{1,4}$/;
    if (!locPattern.test(location)) {
        const retry = confirm(
            `입력한 위치 "${location}"이 표준 형식(XX-XX-XX-XX)과 다릅니다.\n\n` +
            `예시: 01-04-R6-A1, 02-01-00-00\n\n` +
            `그래도 이 위치로 등록하시겠습니까?\n[취소]를 누르면 다시 입력할 수 있습니다.`
        );
        if (!retry) {
            _promptNewLocation(refRow, scannedValue); // 재입력
            return;
        }
    }

    const zone = parseWarehouseZone(location);

    // 동일 상품 + 동일 위치 중복 확인
    const exists = AppState.comparisonResult.find(r =>
        (normalize(r.sku) === normalize(refRow.sku) ||
         (r.barcode && normalize(r.barcode) === normalize(refRow.barcode))) &&
        normalize(r.location) === normalize(location)
    );
    if (exists) {
        toast(`이미 같은 위치(${location})에 등록된 행이 있습니다. 해당 행으로 이동합니다.`, 'warning');
        _ensureRowVisible(exists);
        _navigateToRow(exists);
        return;
    }

    const newRow = {
        _rowId:        generateRowId(),
        sku:           refRow.sku || '',
        barcode:       refRow.barcode || scannedValue,
        name:          refRow.name || '',
        location:      location,
        warehouseZone: zone,
        empQty:        0,
        physicalQty:   0,
        difference:    0,
        status:        'ONLY_IN_PHYSICAL',
        matchType:     'none',
        reason:        '타위치발견',
        memo:          `신규 위치 추가 (원래: ${refRow.location || '-'})`
    };

    AppState.comparisonResult.push(newRow);
    populateZoneFilter(AppState.comparisonResult);

    // KPI만 즉시 갱신 후 필터 조정 (refreshDashboard 중복 호출 방지)
    renderKPIs(AppState.comparisonResult);

    document.querySelector('input[name="status-filter"][value="ALL"]').checked = true;
    resetStatusRadioUI();
    document.getElementById('search-input').value = '';
    AppState.multiSearchTerms = [];
    if (zone) {
        document.getElementById('zone-filter').value = zone;
        populateLocationFilter(AppState.comparisonResult);
    }
    // 세부 위치 필터: 전체 유지 (새 위치 잠금 시 기존 작업 항목이 안 보이는 문제 방지)
    const locSel = document.getElementById('location-filter');
    if (locSel) { locSel.value = 'ALL'; AppState.locationFilter = 'ALL'; }
    applyFilters();

    toast(`✅ "${refRow.sku}" → 새 위치 ${location} 추가 완료! 수량을 입력하세요.`, 'success');
    triggerAutoSave();

    // 새 행으로 이동
    const idx = AppState.filteredResult.findIndex(r => r._rowId === newRow._rowId);
    if (idx === -1) return;

    const targetPage = Math.floor(idx / AppState.pageSize) + 1;
    AppState.currentPage = targetPage;
    renderMainTable();

    requestAnimationFrame(() => {
        const rowEl = document.getElementById(`row-${newRow._rowId}`);
        if (rowEl) {
            document.querySelectorAll('.scan-highlight').forEach(el => el.classList.remove('scan-highlight'));
            rowEl.classList.add('scan-highlight');
            rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => {
                const qtyInput = rowEl.querySelector('.live-qty-input');
                if (qtyInput) { qtyInput.focus(); qtyInput.select(); }
            }, 300);
        }
    });
}

/** 복수 위치 선택 모달 닫기 */
function _closeDupScanModal() {
    hide('dup-scan-modal');
}

/**
 * 선택된 행이 filteredResult에 보이도록 필터 조정
 * @param {object} row - 대상 행
 */
function _ensureRowVisible(row) {
    if (AppState.filteredResult.find(r => r._rowId === row._rowId)) return;
    document.querySelector('input[name="status-filter"][value="ALL"]').checked = true;
    resetStatusRadioUI();
    document.getElementById('search-input').value = '';
    AppState.multiSearchTerms = [];
    if (row.warehouseZone) {
        document.getElementById('zone-filter').value = row.warehouseZone;
        populateLocationFilter(AppState.comparisonResult);
    }
    const locSel = document.getElementById('location-filter');
    if (locSel && row.location) {
        const hasOpt = [...locSel.options].some(o => o.value === row.location);
        if (hasOpt) { locSel.value = row.location; AppState.locationFilter = row.location; }
    }
    applyFilters();
}

/**
 * 최종 대상 행으로 이동: 비프음 + 카운터 + 페이지 이동 + 하이라이트 + 포커스
 * @param {object} targetRow - 이동할 행
 */
function _navigateToRow(targetRow) {
    playBeepSuccess();
    incrementScanCounter();
    updateScanStatus('success', `${targetRow.sku || targetRow.barcode}`);

    // 마지막 스캔 행 저장 + "새 위치" 버튼 표시
    AppState.lastScannedRow = targetRow;
    const newLocBtn = document.getElementById('scan-new-loc-btn');
    if (newLocBtn) newLocBtn.style.display = 'flex';

    // 스캔 마킹 (수량 변경과 분리: _scanned는 필터 통과용)
    targetRow._scanned = true;

    let idx = AppState.filteredResult.findIndex(r => r._rowId === targetRow._rowId);
    if (idx === -1) {
        // 현재 필터에서 안 보이면 필터 해제 후 재탐색
        document.querySelector('input[name="status-filter"][value="ALL"]').checked = true;
        resetStatusRadioUI();
        document.getElementById('search-input').value = '';
        AppState.multiSearchTerms = [];
        applyFilters();
        idx = AppState.filteredResult.findIndex(r => r._rowId === targetRow._rowId);
    }
    if (idx === -1) return;

    const targetPage = Math.floor(idx / AppState.pageSize) + 1;
    if (AppState.currentPage !== targetPage) {
        AppState.currentPage = targetPage;
        renderMainTable();
    }

    requestAnimationFrame(() => {
        const rowEl = document.getElementById(`row-${targetRow._rowId}`);
        if (rowEl) {
            document.querySelectorAll('.scan-highlight').forEach(el => el.classList.remove('scan-highlight'));
            rowEl.classList.add('scan-highlight');
            rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => {
                const qtyInput = rowEl.querySelector('.live-qty-input');
                if (qtyInput) { qtyInput.focus(); qtyInput.select(); }
            }, 300);
        }
    });
}

// ═══════════════════════════════════════════════════════
// 5. 카메라 스캐너 (html5-qrcode)
// ═══════════════════════════════════════════════════════

/**
 * 카메라 스캐너 모달 열기
 * - Html5Qrcode 인스턴스를 AppState.cameraScanner에 저장
 * - 후면 카메라 우선(facingMode: environment)
 * - 바코드 인식 성공 시 processScanValue 호출 후 1초 뒤 자동 닫힘
 */
function openCameraScanner() {
    const modal = document.getElementById('camera-scan-modal');
    modal.style.display = 'flex';

    const resultDiv = document.getElementById('camera-result');
    resultDiv.style.display = 'none';

    if (typeof Html5Qrcode === 'undefined') {
        toast('카메라 스캔 라이브러리를 로드할 수 없습니다.', 'error');
        return;
    }

    // 이전 인스턴스 잔재 제거 (재오픈 시 DOM 충돌 방지)
    document.getElementById('camera-reader').innerHTML = '';

    if (!AppState.cameraScanner) {
        AppState.cameraScanner = new Html5Qrcode('camera-reader');
    }

    const config = {
        fps: 10,
        qrbox: { width: 280, height: 120 },
        aspectRatio: 1.333,
        formatsToSupport: [
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.EAN_8,
            Html5QrcodeSupportedFormats.UPC_A,
            Html5QrcodeSupportedFormats.UPC_E,
            Html5QrcodeSupportedFormats.CODE_128,
            Html5QrcodeSupportedFormats.CODE_39,
            Html5QrcodeSupportedFormats.CODE_93,
            Html5QrcodeSupportedFormats.QR_CODE,
            Html5QrcodeSupportedFormats.ITF,
        ]
    };

    AppState.cameraScanner.start(
        { facingMode: 'environment' },
        config,
        (decodedText) => {
            // 인식 성공
            const resultText = document.getElementById('camera-result-text');
            resultText.textContent = `인식: ${decodedText}`;
            resultDiv.style.display = 'flex';

            processScanValue(decodedText);

            // 1초 후 자동 닫기
            setTimeout(() => {
                closeCameraScanner();
            }, 1000);
        },
        (_errorMessage) => {
            // 프레임별 인식 실패 무시 (바코드 미감지 상태)
        }
    ).catch(() => {
        toast('카메라를 시작할 수 없습니다. 카메라 권한을 확인해주세요.', 'error');
        closeCameraScanner();
    });
}

/** 카메라 스캐너 모달 닫기 */
function closeCameraScanner() {
    const modal = document.getElementById('camera-scan-modal');

    if (AppState.cameraScanner && AppState.cameraScanner.isScanning) {
        AppState.cameraScanner.stop()
            .then(() => {
                AppState.cameraScanner = null;
                hide(modal);
            })
            .catch(() => {
                AppState.cameraScanner = null;
                hide(modal);
            });
    } else {
        AppState.cameraScanner = null;
        hide(modal);
    }
}
