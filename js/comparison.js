/* ═══════════════════════════════════════════════════════════════════
   comparison.js — 비교 엔진 + 컬럼 매핑 UI

   의존: constants.js (REQUIRED_FIELDS, FIELD_LABELS, COLUMN_GUESS_PATTERNS)
         state.js     (AppState)
         utils.js     (esc, toast, safeInt, normalize, generateRowId, parseWarehouseZone)

   포함 항목:
   · guessColumn()         — 헤더명으로 필드 자동 추정
   · buildColumnMapping()  — 컬럼 매핑 UI 빌드
   · buildPreviewTable()   — 업로드 미리보기 테이블
   · getColumnMappings()   — 현재 매핑 선택값 수집
   · validateMappings()    — 필수 필드 선택 검증
   · runComparison()       — 비교 실행 (EMP-only / 양방향)
   · normalizeDataset()    — 원시 rows → 정규화 + SKU+Location 집계

   비교 알고리즘:
   1. SKU + Location 복합키 우선 매칭
   2. Barcode + Location 폴백 매칭
   3. LOCATION_SHIFT 감지: 동일 SKU의 전체 수량 합산 일치 시 승격
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

// ── 컬럼 자동 추정 ─────────────────────────────────────────

/**
 * 컬럼 헤더 목록에서 fieldKey에 해당하는 컬럼명을 추정합니다.
 * constants.js의 COLUMN_GUESS_PATTERNS을 사용합니다.
 * @param   {string[]} columns
 * @param   {string}   fieldKey - REQUIRED_FIELDS 중 하나
 * @returns {string}   추정된 컬럼명, 없으면 ''
 */
function guessColumn(columns, fieldKey) {
    const regexes = COLUMN_GUESS_PATTERNS[fieldKey] || [];
    for (const regex of regexes) {
        const found = columns.find(col => regex.test(col));
        if (found) return found;
    }
    return '';
}

// ── 컬럼 매핑 UI ──────────────────────────────────────────

/**
 * 단일 select 요소를 columns로 채우고, 자동 추정값을 기본 선택합니다.
 * @param {string}   selectId
 * @param {string[]} columns
 * @param {string}   fieldKey
 */
function populateSelect(selectId, columns, fieldKey) {
    const select = document.getElementById(selectId);
    if (!select) return;
    select.innerHTML = '<option value="">-- 선택 --</option>';
    columns.forEach(col => {
        const opt = document.createElement('option');
        opt.value       = col;
        opt.textContent = col;
        select.appendChild(opt);
    });
    const guess = guessColumn(columns, fieldKey);
    if (guess) select.value = guess;
}

/**
 * EMP / 실사 파일 컬럼 매핑 UI를 빌드합니다.
 * 실사 파일이 없는 EMP-only 모드에서는 실사 매핑 블록을 숨깁니다.
 */
function buildColumnMapping() {
    const { empColumns, physicalColumns, physicalRawData } = AppState;

    REQUIRED_FIELDS.forEach(field => {
        populateSelect(`emp-map-${field}`, empColumns, field);
    });

    const physBlock   = document.getElementById('physical-mapping-block');
    const physPreview = document.getElementById('physical-preview-block');

    if (physicalRawData && physicalRawData.length > 0) {
        if (physBlock)   physBlock.style.display   = 'block';
        if (physPreview) physPreview.style.display = 'block';
        REQUIRED_FIELDS.forEach(field => {
            populateSelect(`physical-map-${field}`, physicalColumns, field);
        });
        buildPreviewTable('physical-preview-wrap', physicalRawData, 5);
    } else {
        if (physBlock)   physBlock.style.display   = 'none';
        if (physPreview) physPreview.style.display = 'none';
    }

    const mappingSection = document.getElementById('column-mapping-section');
    if (mappingSection) mappingSection.style.display = 'block';
    buildPreviewTable('emp-preview-wrap', AppState.empRawData, 5);
}

/**
 * 업로드 데이터 미리보기 테이블을 렌더링합니다.
 * @param {string}   containerId
 * @param {Object[]} rows
 * @param {number}   maxRows
 */
function buildPreviewTable(containerId, rows, maxRows) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!rows || rows.length === 0) {
        container.innerHTML = '<p style="color:#9CA3AF;">데이터 없음</p>';
        return;
    }
    const cols        = Object.keys(rows[0]);
    const displayRows = rows.slice(0, maxRows);
    let html = '<table><thead><tr>';
    cols.forEach(c => { html += `<th>${esc(c)}</th>`; });
    html += '</tr></thead><tbody>';
    displayRows.forEach(row => {
        html += '<tr>';
        cols.forEach(c => {
            const val = row[c] !== undefined && row[c] !== null ? String(row[c]) : '';
            html += `<td>${esc(val)}</td>`;
        });
        html += '</tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = html;
}

/**
 * 현재 select 요소에서 컬럼 매핑값을 수집합니다.
 * @returns {{ emp: Object, physical: Object }}
 */
function getColumnMappings() {
    const mappings = { emp: {}, physical: {} };
    REQUIRED_FIELDS.forEach(field => {
        const sel = document.getElementById(`emp-map-${field}`);
        mappings.emp[field] = sel ? sel.value : '';
    });
    if (AppState.physicalRawData && AppState.physicalRawData.length > 0) {
        REQUIRED_FIELDS.forEach(field => {
            const sel = document.getElementById(`physical-map-${field}`);
            mappings.physical[field] = sel ? sel.value : '';
        });
    }
    return mappings;
}

/**
 * 필수 컬럼(SKU, qty, location) 선택 여부를 검증합니다.
 * @param   {{ emp: Object, physical: Object }} mappings
 * @returns {boolean}
 */
function validateMappings(mappings) {
    const required = ['sku', 'qty', 'location'];
    for (const field of required) {
        if (!mappings.emp[field]) {
            toast(`EMP 데이터의 "${FIELD_LABELS[field]}" 컬럼을 선택해주세요.`, 'error');
            return false;
        }
    }
    if (AppState.physicalRawData && AppState.physicalRawData.length > 0) {
        for (const field of required) {
            if (!mappings.physical[field]) {
                toast(`실사 데이터의 "${FIELD_LABELS[field]}" 컬럼을 선택해주세요.`, 'error');
                return false;
            }
        }
    }
    return true;
}

// ── 비교 엔진 ─────────────────────────────────────────────

/**
 * EMP 데이터와 실사 데이터를 비교하여 comparisonResult를 생성합니다.
 *
 * EMP-only 모드 (physicalRawData가 없을 때):
 *   - EMP 행 전체를 physicalQty=0으로 복사
 *   - empQty > 0 → MISMATCH, empQty === 0 → MATCH
 *
 * 양방향 모드:
 *   1. SKU + Location 복합키로 매칭
 *   2. 미매칭 시 Barcode + Location 폴백
 *   3. EMP에만 있는 행: ONLY_IN_EMP
 *   4. 실사에만 있는 행: ONLY_IN_PHYSICAL
 *   5. LOCATION_SHIFT 감지 (동일 SKU 총수량 일치 시)
 *
 * @param   {{ emp: Object, physical: Object }} mappings
 * @returns {Object[]} comparisonResult 배열
 */
function runComparison(mappings) {
    const empData = normalizeDataset(AppState.empRawData, mappings.emp);

    // ── EMP-only 모드 ──
    if (!AppState.physicalRawData || AppState.physicalRawData.length === 0) {
        AppState.isEmpOnly = true;
        const results = empData.map(empRow => ({
            _rowId:        generateRowId(),
            sku:           empRow.sku,
            barcode:       empRow.barcode,
            name:          empRow.name,
            location:      empRow.location,
            warehouseZone: parseWarehouseZone(empRow.location),
            empQty:        empRow.qty,
            physicalQty:   0,
            difference:    -empRow.qty,
            status:        empRow.qty === 0 ? 'MATCH' : 'MISMATCH',
            matchType:     'emp-only',
            reason:        '',
            memo:          '',
        }));
        _sortBySKULocation(results);
        return results;
    }

    // ── 양방향 비교 ──
    AppState.isEmpOnly = false;
    const physicalData = normalizeDataset(AppState.physicalRawData, mappings.physical);

    // 실사 데이터 인덱스 맵 생성 (SKU+Loc, Barcode+Loc)
    const physBySKULoc     = new Map();
    const physByBarcodeLoc = new Map();
    const physicalMatched  = new Set();

    physicalData.forEach((row, idx) => {
        const skuLocKey = `${normalize(row.sku)}|||${normalize(row.location)}`;
        const barLocKey = `${normalize(row.barcode)}|||${normalize(row.location)}`;
        if (row.sku     && !physBySKULoc.has(skuLocKey))     physBySKULoc.set(skuLocKey, { row, idx });
        if (row.barcode && !physByBarcodeLoc.has(barLocKey)) physByBarcodeLoc.set(barLocKey, { row, idx });
    });

    const results = [];

    // EMP 행 처리
    empData.forEach(empRow => {
        const skuLocKey = `${normalize(empRow.sku)}|||${normalize(empRow.location)}`;
        const barLocKey = `${normalize(empRow.barcode)}|||${normalize(empRow.location)}`;

        let physMatch = null;
        let matchType = 'none';

        if (empRow.sku && physBySKULoc.has(skuLocKey)) {
            const entry  = physBySKULoc.get(skuLocKey);
            physMatch    = entry.row;
            physicalMatched.add(entry.idx);
            matchType    = 'sku';
        } else if (empRow.barcode && physByBarcodeLoc.has(barLocKey)) {
            const entry  = physByBarcodeLoc.get(barLocKey);
            physMatch    = entry.row;
            physicalMatched.add(entry.idx);
            matchType    = 'barcode';
        }

        if (physMatch) {
            const diff = physMatch.qty - empRow.qty;
            results.push({
                _rowId:        generateRowId(),
                sku:           empRow.sku      || physMatch.sku,
                barcode:       empRow.barcode  || physMatch.barcode,
                name:          empRow.name     || physMatch.name,
                location:      empRow.location || physMatch.location,
                warehouseZone: parseWarehouseZone(empRow.location || physMatch.location),
                empQty:        empRow.qty,
                physicalQty:   physMatch.qty,
                difference:    diff,
                status:        diff === 0 ? 'MATCH' : 'MISMATCH',
                matchType,
                reason:        '',
                memo:          '',
            });
        } else {
            results.push({
                _rowId:        generateRowId(),
                sku:           empRow.sku,
                barcode:       empRow.barcode,
                name:          empRow.name,
                location:      empRow.location,
                warehouseZone: parseWarehouseZone(empRow.location),
                empQty:        empRow.qty,
                physicalQty:   0,
                difference:    -empRow.qty,
                status:        'ONLY_IN_EMP',
                matchType:     'none',
                reason:        '',
                memo:          '',
            });
        }
    });

    // 실사에만 있는 행 추가
    physicalData.forEach((physRow, idx) => {
        if (!physicalMatched.has(idx)) {
            results.push({
                _rowId:        generateRowId(),
                sku:           physRow.sku,
                barcode:       physRow.barcode,
                name:          physRow.name,
                location:      physRow.location,
                warehouseZone: parseWarehouseZone(physRow.location),
                empQty:        0,
                physicalQty:   physRow.qty,
                difference:    physRow.qty,
                status:        'ONLY_IN_PHYSICAL',
                matchType:     'none',
                reason:        '',
                memo:          '',
            });
        }
    });

    // LOCATION_SHIFT 감지 (Pass 1: SKU 그룹 총량 일치)
    _detectLocationShift(results);

    _sortBySKULocation(results);
    return results;
}

/**
 * 원시 rows를 정규화하고 (SKU + Location) 복합키로 수량을 집계합니다.
 * @param   {Object[]} rawRows
 * @param   {Object}   mapping  - { sku, barcode, name, qty, location } → 원시 컬럼명
 * @returns {Object[]} 정규화된 행 배열
 */
function normalizeDataset(rawRows, mapping) {
    const normalized = rawRows.map(row => ({
        sku:      String(row[mapping.sku]      ?? '').trim(),
        barcode:  mapping.barcode  ? String(row[mapping.barcode]  ?? '').trim() : '',
        name:     mapping.name     ? String(row[mapping.name]     ?? '').trim() : '',
        qty:      safeInt(row[mapping.qty]),
        location: String(row[mapping.location] ?? '').trim(),
    }));

    // SKU+Location 복합키로 수량 집계 (중복 행 합산)
    const aggregated = new Map();
    normalized.forEach(row => {
        const itemKey = normalize(row.sku) || normalize(row.barcode);
        if (!itemKey) return; // 식별자 없는 행 제외
        const compositeKey = `${itemKey}|||${normalize(row.location)}`;
        if (aggregated.has(compositeKey)) {
            aggregated.get(compositeKey).qty += row.qty;
        } else {
            aggregated.set(compositeKey, { ...row });
        }
    });

    return Array.from(aggregated.values());
}

// ── 내부 헬퍼 ─────────────────────────────────────────────

/**
 * LOCATION_SHIFT 감지.
 * 동일 SKU의 전체 EMP 수량 합계 === 전체 실사 수량 합계이고,
 * 수량이 0보다 크면 MISMATCH/ONLY_IN_* 행들을 LOCATION_SHIFT로 승격합니다.
 * 총량이 다르면 양쪽 ONLY_IN_* 행은 MISMATCH로 전환합니다.
 * @param {Object[]} results - runComparison 내부 결과 배열 (in-place 수정)
 */
function _detectLocationShift(results) {
    // SKU별 집계
    const skuTotals = new Map(); // normalized sku → { empTotal, physTotal, indices[] }
    results.forEach((r, idx) => {
        const key = normalize(r.sku);
        if (!key) return;
        if (!skuTotals.has(key)) skuTotals.set(key, { empTotal: 0, physTotal: 0, indices: [] });
        const entry = skuTotals.get(key);
        entry.empTotal  += r.empQty;
        entry.physTotal += r.physicalQty;
        entry.indices.push(idx);
    });

    skuTotals.forEach(agg => {
        const { empTotal, physTotal, indices } = agg;

        if (empTotal === physTotal && empTotal > 0) {
            // 총량 일치: 비매칭 행들을 LOCATION_SHIFT로 승격
            indices.forEach(idx => {
                const r = results[idx];
                if (r.status === 'MISMATCH' || r.status === 'ONLY_IN_EMP' || r.status === 'ONLY_IN_PHYSICAL') {
                    r.status = 'LOCATION_SHIFT';
                }
            });
        } else if (empTotal > 0 && physTotal > 0 && empTotal !== physTotal) {
            // 총량 불일치: ONLY_IN_* 행 → MISMATCH
            indices.forEach(idx => {
                const r = results[idx];
                if (r.status === 'ONLY_IN_EMP' || r.status === 'ONLY_IN_PHYSICAL') {
                    r.status = 'MISMATCH';
                }
            });
        }
    });
}

/**
 * SKU → Location 오름차순으로 결과 배열을 정렬합니다.
 * @param {Object[]} results
 */
function _sortBySKULocation(results) {
    results.sort((a, b) => {
        const skuCmp = (a.sku || '').toLowerCase().localeCompare((b.sku || '').toLowerCase());
        if (skuCmp !== 0) return skuCmp;
        return (a.location || '').toLowerCase().localeCompare((b.location || '').toLowerCase());
    });
}
