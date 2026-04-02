/* export.js — CSV/Excel/Drive 내보내기 + 재실사 · 재고조정 뷰 + 다중 검색 모달
 * 의존: utils.js, state.js, constants.js, comparison.js, dashboard-ui.js
 */
'use strict';

// ═══════════════════════════════════════════════════════
// 1. CSV 내보내기
// ═══════════════════════════════════════════════════════

/**
 * 현재 filteredResult를 CSV 문자열로 변환
 * @param {boolean} [includeBOM=true] - UTF-8 BOM 포함 여부
 * @returns {string|null} CSV 문자열, 데이터 없으면 null
 */
function generateCSVString(includeBOM = true) {
    const data = AppState.filteredResult;
    if (data.length === 0) return null;

    const headers = ['SKU', '바코드', '상품명', '위치', '구역', 'EMP 수량', '실사 수량', '차이', '상태', '조정 사유', '메모'];
    const rows = data.map(r => [
        r.sku, r.barcode, r.name, r.location, r.warehouseZone,
        r.empQty, r.physicalQty, r.difference, r.status, r.reason || '', r.memo || ''
    ]);

    let csv = (includeBOM ? '\uFEFF' : '') + headers.join(',') + '\n';
    rows.forEach(row => {
        csv += row.map(val => {
            const s = String(val ?? '');
            return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(',') + '\n';
    });

    return csv;
}

/** filteredResult를 CSV 파일로 로컬 다운로드 */
function exportToCSV() {
    const csv = generateCSVString(true);
    if (!csv) { toast('내보낼 데이터가 없습니다.', 'warning'); return; }

    downloadBlob(csv, '재고비교결과.csv', 'text/csv;charset=utf-8;');
    toast('CSV 파일이 다운로드되었습니다.', 'success');
}

// ═══════════════════════════════════════════════════════
// 2. Excel 내보내기 (SheetJS)
// ═══════════════════════════════════════════════════════

/** filteredResult를 Excel(.xlsx) 파일로 다운로드 */
async function exportToExcel() {
    const data = AppState.filteredResult;
    if (data.length === 0) { toast('내보낼 데이터가 없습니다.', 'warning'); return; }

    await loadXLSX();

    const wsData = [['SKU', '바코드', '상품명', '위치', '구역', 'EMP 수량', '실사 수량', '차이', '상태', '조정 사유', '메모']];
    data.forEach(r => {
        wsData.push([r.sku, r.barcode, r.name, r.location, r.warehouseZone, r.empQty, r.physicalQty, r.difference, r.status, r.reason || '', r.memo || '']);
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    ws['!cols'] = [
        { wch: 16 }, { wch: 16 }, { wch: 28 }, { wch: 16 }, { wch: 10 },
        { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 16 }, { wch: 14 }, { wch: 24 }
    ];

    XLSX.utils.book_append_sheet(wb, ws, '비교결과');
    XLSX.writeFile(wb, '재고비교결과.xlsx');
    toast('Excel 파일이 다운로드되었습니다.', 'success');
}

// ═══════════════════════════════════════════════════════
// 3. 재실사 지시서 다운로드 (xlsx-js-style)
// ═══════════════════════════════════════════════════════

/**
 * 재실사 지시서 Excel 다운로드 — xlsx-js-style 스타일 적용
 * AppState.adjSkuGrouped 상태에 따라 위치별 / SKU 합산 모드 분기
 */
async function exportRecountSheet() {
    const targets = filterActiveRows(AppState.comparisonResult).filter(r =>
        r.status === 'MISMATCH' || r.status === 'ONLY_IN_EMP' || r.status === 'LOCATION_SHIFT'
    );

    if (targets.length === 0) {
        toast('재실사 대상 항목이 없습니다.', 'warning');
        return;
    }

    await loadXLSX();

    const thinBorder = {
        top:    { style: 'thin', color: { rgb: '000000' } },
        bottom: { style: 'thin', color: { rgb: '000000' } },
        left:   { style: 'thin', color: { rgb: '000000' } },
        right:  { style: 'thin', color: { rgb: '000000' } }
    };
    const headerStyle = {
        font: { bold: true, sz: 11, color: { rgb: '1F2937' } },
        fill: { fgColor: { rgb: 'F3F4F6' } },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: thinBorder
    };
    const cellCenter = {
        font: { sz: 10 },
        alignment: { horizontal: 'center', vertical: 'center' },
        border: thinBorder
    };
    const cellLeft = {
        font: { sz: 10 },
        alignment: { horizontal: 'left', vertical: 'center', wrapText: true },
        border: thinBorder
    };
    const groupRowStyle = {
        font: { bold: true, sz: 10, color: { rgb: '1F2937' } },
        fill: { fgColor: { rgb: 'E5E7EB' } },
        alignment: { horizontal: 'center', vertical: 'center' },
        border: thinBorder
    };
    const groupRowLeftStyle = {
        font: { bold: true, sz: 10, color: { rgb: '1F2937' } },
        fill: { fgColor: { rgb: 'E5E7EB' } },
        alignment: { horizontal: 'left', vertical: 'center', wrapText: true },
        border: thinBorder
    };

    const headers = ['SKU', '상품명', '로케이션', 'EMP 수량', '실사 수량', '차이 수량', '재실사 확인 수량', '비고'];
    const wsData = [headers];
    const groupRowIndices = [];
    let toastMsg = '';

    if (AppState.adjSkuGrouped) {
        // SKU 합산 모드
        const groups = groupBySku(targets);
        groups.sort((a, b) => Math.abs(b.diffTotal) - Math.abs(a.diffTotal));

        groups.forEach(g => {
            groupRowIndices.push(wsData.length);
            wsData.push([
                g.sku, g.name, `[${g.locationCount}개 위치]`,
                g.empTotal, g.physTotal, g.diffTotal, '', ''
            ]);
            const sorted = [...g.rows].sort((a, b) =>
                (a.location || '').localeCompare(b.location || '', 'ko')
            );
            sorted.forEach(r => {
                wsData.push([
                    '', '  └', r.location,
                    r.empQty, r.physicalQty, r.difference, '', ''
                ]);
            });
        });
        toastMsg = `재실사 지시서 (SKU 합산) 다운로드 완료 (${groups.length}개 SKU)`;
    } else {
        // 위치별 모드
        targets.sort((a, b) => {
            const locA = (a.location || '').toString().toUpperCase();
            const locB = (b.location || '').toString().toUpperCase();
            return locA.localeCompare(locB, 'ko');
        });
        targets.forEach(r => {
            wsData.push([r.sku, r.name, r.location, r.empQty, r.physicalQty, r.difference, '', '']);
        });
        toastMsg = `재실사 지시서 다운로드 완료 (${targets.length}건, 로케이션 순 정렬)`;
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    const range = XLSX.utils.decode_range(ws['!ref']);
    const leftAlignCols = new Set([1, 7]);
    const groupRowSet = new Set(groupRowIndices);

    for (let R = range.s.r; R <= range.e.r; R++) {
        for (let C = range.s.c; C <= range.e.c; C++) {
            const cellRef = XLSX.utils.encode_cell({ r: R, c: C });
            if (!ws[cellRef]) ws[cellRef] = { v: '', t: 's' };
            if (R === 0) {
                ws[cellRef].s = headerStyle;
            } else if (groupRowSet.has(R)) {
                ws[cellRef].s = leftAlignCols.has(C) ? groupRowLeftStyle : groupRowStyle;
            } else {
                ws[cellRef].s = leftAlignCols.has(C) ? cellLeft : cellCenter;
            }
        }
    }

    ws['!cols'] = [
        { wch: 18 }, { wch: 42 }, { wch: 18 }, { wch: 12 },
        { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 28 }
    ];
    ws['!rows'] = [{ hpx: 25 }];
    for (let R = 1; R < wsData.length; R++) {
        if (AppState.adjSkuGrouped && !groupRowSet.has(R) && R > 0) {
            // 하위 행: 그룹 레벨 1 + 접힌 상태
            ws['!rows'][R] = { hpx: 24, level: 1, hidden: true };
        } else {
            ws['!rows'][R] = { hpx: groupRowSet.has(R) ? 28 : 24 };
        }
    }
    // 그룹화 방향: 합산 행 아래에 하위 행
    if (AppState.adjSkuGrouped) {
        ws['!outline'] = { above: false, left: false };
    }

    const sheetName = AppState.adjSkuGrouped ? '재실사 지시서 (SKU합산)' : '재실사 지시서';
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    XLSX.writeFile(wb, '재실사_지시서.xlsx');
    toast(toastMsg, 'success');
}

// ═══════════════════════════════════════════════════════
// 4. 재실사 데이터 업로드 (importRecountData)
// ═══════════════════════════════════════════════════════

/**
 * 재실사 전용 컬럼 자동 매핑
 * @param {string[]} cols - 헤더 컬럼명 배열
 * @returns {{ sku, location, recountQty, name, barcode }}
 */
function autoMapRecountColumns(cols) {
    const mapping = { sku: null, location: null, recountQty: null, name: null, barcode: null };

    const skuPats = [/상품코드/i, /sku/i, /품번/i, /product.?code/i];
    for (const pat of skuPats) {
        const found = cols.find(c => pat.test(c));
        if (found) { mapping.sku = found; break; }
    }

    const locPats = [/로케이션/i, /location/i, /위치/i, /loc/i];
    for (const pat of locPats) {
        const found = cols.find(c => pat.test(c));
        if (found) { mapping.location = found; break; }
    }

    const rcPats = [/재실사.*수량/i, /재실사.*확인/i, /재확인/i, /recount/i];
    for (const pat of rcPats) {
        const found = cols.find(c => pat.test(c));
        if (found) { mapping.recountQty = found; break; }
    }
    // 재실사 전용 컬럼이 없으면 일반 수량 컬럼의 마지막 항목 사용
    if (!mapping.recountQty) {
        const qtyPats = [/수량/i, /qty/i, /quantity/i];
        for (const pat of qtyPats) {
            const matches = cols.filter(c => pat.test(c));
            if (matches.length > 0) {
                mapping.recountQty = matches[matches.length - 1];
                break;
            }
        }
    }

    const namePats = [/상품명/i, /name/i, /품명/i];
    for (const pat of namePats) {
        const found = cols.find(c => pat.test(c));
        if (found) { mapping.name = found; break; }
    }
    const barPats = [/바코드/i, /barcode/i, /upc/i, /ean/i];
    for (const pat of barPats) {
        const found = cols.find(c => pat.test(c));
        if (found) { mapping.barcode = found; break; }
    }

    return mapping;
}

/**
 * 재실사 엑셀 업로드 → recountData + physicalQty 일괄 반영
 * - 기존 SKU+위치 행: 재실사 수량으로 physicalQty 업데이트
 * - 신규 SKU+위치: confirm 후 comparisonResult에 추가
 * @param {File} file - 업로드된 파일
 */
async function importRecountData(file) {
    if (!AppState.comparisonResult || AppState.comparisonResult.length === 0) {
        toast('먼저 비교 분석을 실행한 후 업로드하세요.', 'warning');
        return;
    }

    try {
        await loadXLSX();
        setLoading(true);
        const result = await parseFile(file);
        const rows = result.rows;
        const cols = result.columns;

        if (rows.length === 0) {
            toast('파일에 데이터가 없습니다.', 'error');
            return;
        }

        const mapping = autoMapRecountColumns(cols);
        if (!mapping.recountQty) {
            toast('재실사 확인 수량 컬럼을 찾을 수 없습니다. 컬럼명을 확인하세요.', 'error');
            return;
        }
        if (!mapping.sku && !mapping.location) {
            toast('상품코드 또는 로케이션 컬럼을 찾을 수 없습니다.', 'error');
            return;
        }

        // 기존 데이터를 SKU+위치 키로 인덱싱
        const existingMap = new Map();
        AppState.comparisonResult.forEach(r => {
            const key = `${normalize(r.sku)}|||${normalize(r.location)}`;
            existingMap.set(key, r);
        });

        let applied = 0;
        let skipped = 0;
        const newItems = [];
        let lastSku = '';
        let lastName = '';
        let lastBarcode = '';

        rows.forEach(row => {
            let sku = mapping.sku ? String(row[mapping.sku] ?? '').trim() : '';
            const location = mapping.location ? String(row[mapping.location] ?? '').trim() : '';
            const recountVal = String(row[mapping.recountQty] ?? '').trim();
            const name = mapping.name ? String(row[mapping.name] ?? '').trim() : '';
            const barcode = mapping.barcode ? String(row[mapping.barcode] ?? '').trim() : '';

            // SKU가 있으면 항상 lastSku 업데이트
            if (sku && sku !== '└') {
                lastSku = sku;
                if (name) lastName = name;
                if (barcode) lastBarcode = barcode;
            }

            // SKU 합산 지시서의 합산 행 ([N개 위치]) 무시
            if (location.startsWith('[')) {
                skipped++;
                return;
            }

            // 하위 행: SKU 비어있으면 lastSku 상속
            if (!sku || sku === '└') {
                sku = lastSku;
            }

            // 재실사 수량이 없으면 스킵
            if (recountVal === '' || recountVal === '-') {
                skipped++;
                return;
            }

            const newQty = Math.max(0, safeInt(recountVal));
            if (!sku && !location) { skipped++; return; }

            const key = `${normalize(sku)}|||${normalize(location)}`;

            if (existingMap.has(key)) {
                // 기존 항목: 재실사 수량 적용 (원본 physicalQty 1회만 보존)
                const r = existingMap.get(key);
                if (r._originalPhysicalQty === undefined) {
                    r._originalPhysicalQty = r.physicalQty;
                }
                r.physicalQty = newQty;
                r.difference = newQty - r.empQty;
                r.status = r.difference === 0 ? 'MATCH' : 'MISMATCH';
                r._touched = true;
                AppState.recountData[r._rowId] = newQty;
                applied++;
            } else {
                // 신규 품목 후보 (수량 0은 스킵)
                if (newQty > 0) {
                    newItems.push({
                        sku,
                        name: name || lastName,
                        barcode: barcode || lastBarcode,
                        location,
                        qty: newQty
                    });
                } else {
                    skipped++;
                }
            }
        });

        // 신규 품목 confirm 팝업
        let addedCount = 0;
        if (newItems.length > 0) {
            const preview = newItems.slice(0, 5).map(n =>
                `  • ${n.sku} | ${n.location} | 수량 ${n.qty}`
            ).join('\n');
            const more = newItems.length > 5 ? `\n  ... 외 ${newItems.length - 5}건` : '';
            const confirmMsg = `기존에 없는 신규 품목 ${newItems.length}건이 발견되었습니다.\n\n${preview}${more}\n\n추가하시겠습니까?`;

            if (window.confirm(confirmMsg)) {
                newItems.forEach(n => {
                    const empRef = AppState.comparisonResult.find(r => normalize(r.sku) === normalize(n.sku));
                    const newRow = {
                        _rowId:        generateRowId(),
                        sku:           n.sku,
                        barcode:       n.barcode || (empRef ? empRef.barcode : ''),
                        name:          n.name || (empRef ? empRef.name : ''),
                        location:      n.location,
                        warehouseZone: parseWarehouseZone(n.location),
                        empQty:        0,
                        physicalQty:   n.qty,
                        difference:    n.qty,
                        status:        'ONLY_IN_PHYSICAL',
                        matchType:     'none',
                        reason:        '',
                        memo:          '재실사 업로드 신규',
                        _touched:      true
                    };
                    AppState.comparisonResult.push(newRow);
                    AppState.recountData[newRow._rowId] = n.qty;
                    addedCount++;
                });
            }
        }

        // UI 전체 갱신
        if (addedCount > 0) populateZoneFilter(AppState.comparisonResult);
        refreshDashboard();
        renderAdjustmentView();
        triggerAutoSave();

        toast(`✅ 재실사 결과: ${applied}건 적용, ${addedCount > 0 ? addedCount + '건 신규 추가, ' : ''}${skipped}건 스킵`, 'success');

    } catch (err) {
        console.error('Recount import error:', err);
        toast('재실사 결과 업로드 실패: ' + err.message, 'error');
    } finally {
        setLoading(false);
    }
}

// ═══════════════════════════════════════════════════════
// 5. EMP 재고조정 양식 다운로드 (xlsx-js-style)
// ═══════════════════════════════════════════════════════

/**
 * EMP 재고조정 양식 Excel 다운로드
 * - 시트1: EMP 업로드용 (상품코드/색상코드/사이즈코드/로케이션/실사수량/조정수량)
 * - 시트2: 상세내역(참고)
 */
async function exportAdjustmentSheet() {
    const targets = AppState.comparisonResult.filter(r => r.difference !== 0);

    if (targets.length === 0) {
        toast('재고 조정 대상 항목이 없습니다.', 'warning');
        return;
    }

    await loadXLSX();

    // 로케이션 오름차순 정렬
    targets.sort((a, b) => {
        const la = (a.location || '').toUpperCase();
        const lb = (b.location || '').toUpperCase();
        return la.localeCompare(lb, 'ko');
    });

    const thinBorder = {
        top:    { style: 'thin', color: { rgb: '000000' } },
        bottom: { style: 'thin', color: { rgb: '000000' } },
        left:   { style: 'thin', color: { rgb: '000000' } },
        right:  { style: 'thin', color: { rgb: '000000' } }
    };
    const headerStyle = {
        font: { bold: true, sz: 11, color: { rgb: 'FFFFFF' } },
        fill: { fgColor: { rgb: '7C3AED' } },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border: thinBorder
    };
    const cellCenter = {
        font: { sz: 10 },
        alignment: { horizontal: 'center', vertical: 'center' },
        border: thinBorder
    };
    const cellNum = {
        font: { sz: 10 },
        alignment: { horizontal: 'right', vertical: 'center' },
        border: thinBorder
    };

    // EMP 업로드 양식 (컬럼 순서 고정)
    const headers = ['상품코드', '색상코드', '사이즈코드', '로케이션', '실사수량', '조정수량'];
    const wsData = [headers];

    targets.forEach(r => {
        wsData.push([
            r.sku || '',
            '999',                       // 색상코드 (EMP 고정값)
            '999',                       // 사이즈코드 (EMP 고정값)
            r.location || '00-00-00-00',
            0,                           // 실사수량: 조정 방식이므로 0
            r.difference,               // 조정수량: 실사 - EMP
        ]);
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // 스타일 적용
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let R = range.s.r; R <= range.e.r; R++) {
        for (let C = range.s.c; C <= range.e.c; C++) {
            const ref = XLSX.utils.encode_cell({ r: R, c: C });
            if (!ws[ref]) ws[ref] = { v: '', t: 's' };
            if (R === 0) {
                ws[ref].s = headerStyle;
            } else {
                ws[ref].s = (C >= 4) ? cellNum : cellCenter;
            }
        }
    }

    ws['!cols'] = [
        { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 12 }
    ];

    // 참고용 상세 내역 시트
    const detailHeaders = ['상품코드', '바코드', '상품명', '로케이션', '구역', 'EMP수량', '실사수량', '차이', '상태', '조정사유', '메모'];
    const detailData = [detailHeaders];
    targets.forEach(r => {
        detailData.push([
            r.sku, r.barcode, r.name, r.location, r.warehouseZone,
            r.empQty, r.physicalQty, r.difference,
            r.status === 'MATCH' ? '일치' : r.status === 'MISMATCH' ? '불일치' :
            r.status === 'ONLY_IN_EMP' ? 'EMP에만' : r.status === 'ONLY_IN_PHYSICAL' ? '실사에만' :
            r.status === 'LOCATION_SHIFT' ? '타위치' : r.status,
            r.reason || '', r.memo || ''
        ]);
    });
    const ws2 = XLSX.utils.aoa_to_sheet(detailData);
    ws2['!cols'] = [
        { wch: 18 }, { wch: 16 }, { wch: 40 }, { wch: 16 }, { wch: 8 },
        { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 24 }
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'EMP 업로드용');
    XLSX.utils.book_append_sheet(wb, ws2, '상세내역(참고)');
    XLSX.writeFile(wb, `EMP_재고조정_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`);
    toast(`EMP 재고조정 양식 다운로드 완료 (${targets.length}건)`, 'success');
}

// ═══════════════════════════════════════════════════════
// 6. 조정 대상 필터 + SKU 그룹핑 헬퍼
// ═══════════════════════════════════════════════════════

/** 조정 대상 필터 — 전체 데이터 기준 (KPI/구역 요약용) */
function getAdjTargetsAll() {
    return filterActiveRows(AppState.comparisonResult).filter(r =>
        r.status === 'MISMATCH' || r.status === 'ONLY_IN_EMP' ||
        r.status === 'ONLY_IN_PHYSICAL' || r.status === 'LOCATION_SHIFT'
    );
}

/** 조정 대상 필터 — 사이드바 필터 적용 (테이블 렌더링용) */
function getAdjTargets() {
    return AppState.filteredResult.filter(r =>
        r.status === 'MISMATCH' || r.status === 'ONLY_IN_EMP' ||
        r.status === 'ONLY_IN_PHYSICAL' || r.status === 'LOCATION_SHIFT'
    );
}

/**
 * SKU 기준 그룹핑 + 합산
 * @param {object[]} targets - 조정 대상 행 배열
 * @returns {object[]} SKU 그룹 배열 (empTotal, physTotal, diffTotal, locationCount)
 */
function groupBySku(targets) {
    const skuMap = new Map();
    targets.forEach(r => {
        const key = normalize(r.sku);
        if (!key) return;
        if (!skuMap.has(key)) {
            skuMap.set(key, {
                sku: r.sku, name: r.name, barcode: r.barcode,
                locations: [], empTotal: 0, physTotal: 0, rows: []
            });
        }
        const g = skuMap.get(key);
        g.empTotal += r.empQty;
        g.physTotal += r.physicalQty;
        g.locations.push(r.location);
        g.rows.push(r);
    });
    return [...skuMap.values()].map(g => ({
        ...g,
        diffTotal: g.physTotal - g.empTotal,
        locationCount: g.locations.length,
        status: (g.physTotal - g.empTotal) === 0 ? 'LOCATION_SHIFT' : 'MISMATCH',
    }));
}

// ═══════════════════════════════════════════════════════
// 7. 조정 뷰 렌더링
// ═══════════════════════════════════════════════════════

/** 조정 뷰 전체 렌더링 진입점 */
function renderAdjustmentView() {
    const allTargets = getAdjTargetsAll();
    const filteredTargets = getAdjTargets();
    renderAdjSummary(allTargets, filteredTargets);
    renderAdjZoneSummary(allTargets);

    if (AppState.adjSkuGrouped) {
        const groups = groupBySku(filteredTargets);
        renderAdjTableGrouped(groups);
    } else {
        renderAdjTable(filteredTargets);
    }
    renderAdjEmpPreview(filteredTargets);

    // SKU 합산 버튼 활성 상태 동기화
    const skuBtn = document.getElementById('adj-sku-group-btn');
    if (skuBtn) skuBtn.classList.toggle('active', AppState.adjSkuGrouped);
}

/** 조정 요약 KPI 렌더링 */
function renderAdjSummary(allTargets, filteredTargets) {
    const plus = allTargets.filter(r => r.difference > 0).length;
    const minus = allTargets.filter(r => r.difference < 0).length;
    const recountDone = allTargets.filter(r => AppState.recountData[r._rowId] !== undefined).length;

    document.getElementById('adj-total').textContent = formatNum(allTargets.length);
    document.getElementById('adj-plus').textContent = formatNum(plus);
    document.getElementById('adj-minus').textContent = formatNum(minus);
    document.getElementById('adj-recount-done').textContent = `${recountDone}/${allTargets.length}`;
}

/** 구역별 조정 현황 칩 렌더링 */
function renderAdjZoneSummary(targets) {
    const grid = document.getElementById('adj-zone-grid');
    const zoneMap = {};
    targets.forEach(r => {
        const z = r.warehouseZone || '(없음)';
        if (!zoneMap[z]) zoneMap[z] = { plus: 0, minus: 0, total: 0, empQty: 0, physQty: 0, diffQty: 0, rcDone: 0 };
        zoneMap[z].total++;
        zoneMap[z].empQty += r.empQty;
        zoneMap[z].physQty += r.physicalQty;
        zoneMap[z].diffQty += r.difference;
        if (r.difference > 0) zoneMap[z].plus++;
        if (r.difference < 0) zoneMap[z].minus++;
        if (AppState.recountData[r._rowId] !== undefined) zoneMap[z].rcDone++;
    });

    const zones = Object.keys(zoneMap).sort();
    grid.innerHTML = zones.map(z => {
        const s = zoneMap[z];
        const diffClass = s.diffQty > 0 ? 'plus' : s.diffQty < 0 ? 'minus' : '';
        const rcPct = s.total > 0 ? Math.round(s.rcDone / s.total * 100) : 0;
        // 칩 상태 클래스: 완료 > 증가/감소
        const chipMod = rcPct >= 100 ? 'adj-zone-chip--done'
            : s.diffQty > 0 ? 'adj-zone-chip--plus'
            : s.diffQty < 0 ? 'adj-zone-chip--minus' : '';
        return `<div class="adj-zone-chip ${chipMod}">
            <div class="adj-zone-chip-top">
                <span class="adj-zone-chip-name">${esc(z)}</span>
                <span class="adj-zone-chip-cnt">${s.total}건</span>
            </div>
            <div class="adj-zone-chip-qty">
                <span class="qty-label">EMP <strong>${formatNum(s.empQty)}</strong></span>
                <span class="qty-label">실사 <strong>${formatNum(s.physQty)}</strong></span>
                <span class="${diffClass}">차이 ${s.diffQty > 0 ? '+' : ''}${formatNum(s.diffQty)}</span>
            </div>
            <div class="adj-zone-chip-bottom">
                <div class="adj-zone-chip-stats">
                    <span class="stat-badge plus"><i class="fas fa-arrow-up"></i> ${s.plus}</span>
                    <span class="stat-badge minus"><i class="fas fa-arrow-down"></i> ${s.minus}</span>
                </div>
                <div class="adj-zone-chip-rc-wrap">
                    <span class="adj-zone-chip-rc ${rcPct >= 100 ? 'done' : ''}">${s.rcDone}/${s.total} (${rcPct}%)</span>
                    <div class="adj-zone-chip-progress"><div class="adj-zone-chip-progress-bar" style="width:${rcPct}%"></div></div>
                </div>
            </div>
        </div>`;
    }).join('');
}

/**
 * 조정 테이블 렌더링 (위치별 모드)
 * - recount 모드: 재실사 확인 수량 입력 가능
 * - adjust 모드: 승인 체크박스 제공
 * @param {object[]} targets - 조정 대상 행 배열
 */
function renderAdjTable(targets) {
    const mode = AppState.adjMode;
    const pageSize = 50;

    // 정렬 적용
    if (AppState.adjSortColumn) {
        const col = AppState.adjSortColumn;
        const dir = AppState.adjSortDirection === 'desc' ? -1 : 1;
        targets = [...targets].sort((a, b) => {
            let va = a[col], vb = b[col];
            if (col === 'empQty' || col === 'physicalQty' || col === 'difference') {
                return (Number(va || 0) - Number(vb || 0)) * dir;
            }
            va = String(va || '').toLowerCase();
            vb = String(vb || '').toLowerCase();
            if (va < vb) return -1 * dir;
            if (va > vb) return 1 * dir;
            return 0;
        });
    }

    const totalPages = Math.max(1, Math.ceil(targets.length / pageSize));
    if (AppState.adjPage > totalPages) AppState.adjPage = totalPages;
    const start = (AppState.adjPage - 1) * pageSize;
    const page = targets.slice(start, start + pageSize);

    // 제목 업데이트
    const titleEl = document.getElementById('adj-table-title');
    titleEl.textContent = mode === 'recount' ? '재실사 대상 목록' : '재고조정 대상 목록';

    // 정렬 가능 헤더 빌더
    const sc = AppState.adjSortColumn;
    const sd = AppState.adjSortDirection;
    const sh = (label, col) => {
        const isActive = sc === col;
        const icon = isActive ? (sd === 'asc' ? '▲' : '▼') : '⇅';
        return `<th class="sortable-th${isActive ? ' sort-active' : ''}" data-adj-sort="${col}">${label}<span class="sort-icon">${icon}</span></th>`;
    };

    const thead = document.getElementById('adj-table-head');
    if (mode === 'recount') {
        thead.innerHTML = `<tr><th>#</th>${sh('SKU','sku')}${sh('상품명','name')}${sh('위치','location')}${sh('구역','warehouseZone')}${sh('EMP','empQty')}${sh('1차 실사','physicalQty')}${sh('차이','difference')}<th>재실사 확인 수량</th>${sh('상태','status')}</tr>`;
    } else {
        thead.innerHTML = `<tr><th>#</th>${sh('SKU','sku')}${sh('상품명','name')}${sh('위치','location')}${sh('구역','warehouseZone')}${sh('EMP','empQty')}${sh('실사','physicalQty')}${sh('조정수량','difference')}${sh('사유','reason')}<th>승인</th></tr>`;
    }

    // 헤더 클릭 정렬 이벤트
    thead.querySelectorAll('[data-adj-sort]').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.getAttribute('data-adj-sort');
            if (AppState.adjSortColumn === col) {
                if (AppState.adjSortDirection === 'asc') {
                    AppState.adjSortDirection = 'desc';
                } else {
                    AppState.adjSortColumn = null;
                    AppState.adjSortDirection = 'asc';
                }
            } else {
                AppState.adjSortColumn = col;
                AppState.adjSortDirection = 'asc';
            }
            AppState.adjPage = 1;
            renderAdjTable(getAdjTargets());
        });
    });

    // 바디 렌더링
    const tbody = document.getElementById('adj-table-body');
    if (page.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:32px;color:#9CA3AF;">조정 대상 항목이 없습니다.</td></tr>';
    } else {
        let html = '';
        page.forEach((r, i) => {
            const rowId = r._rowId;
            const rowClass = getRowClass(r.status);
            html += `<tr class="${rowClass}">`;
            html += `<td>${start + i + 1}</td>`;
            html += `<td>${esc(r.sku)}</td>`;
            html += `<td>${esc(r.name)}</td>`;
            html += `<td>${esc(r.location)}</td>`;
            html += `<td>${esc(r.warehouseZone)}</td>`;
            html += `<td>${formatNum(r.empQty)}</td>`;

            if (mode === 'recount') {
                // 1차 실사: 원본 있으면 취소선 + 변경값 표시
                const origQty = r._originalPhysicalQty !== undefined ? r._originalPhysicalQty : null;
                if (origQty !== null && origQty !== r.physicalQty) {
                    html += `<td><span style="text-decoration:line-through;color:var(--text-muted);font-size:0.85em;">${formatNum(origQty)}</span> → ${formatNum(r.physicalQty)}</td>`;
                } else {
                    html += `<td>${formatNum(r.physicalQty)}</td>`;
                }
                html += `<td class="${getDiffClass(r.difference)}">${r.difference > 0 ? '+' : ''}${formatNum(r.difference)}</td>`;
                const rcVal = AppState.recountData[rowId] !== undefined ? AppState.recountData[rowId] : '';
                const confirmed = rcVal !== '' ? ' confirmed' : '';
                html += `<td><input type="number" class="recount-qty-input${confirmed}" data-row-id="${rowId}" value="${rcVal}" min="0" step="1" placeholder="재확인"></td>`;
                html += `<td>${statusBadge(r.status)}</td>`;
            } else {
                html += `<td>${formatNum(r.physicalQty)}</td>`;
                html += `<td class="${getDiffClass(r.difference)}" style="font-weight:700;">${r.difference > 0 ? '+' : ''}${formatNum(r.difference)}</td>`;
                html += `<td>${esc(r.reason || '')}</td>`;
                const checked = AppState.adjApproved.has(rowId) ? ' checked' : '';
                html += `<td style="text-align:center;"><input type="checkbox" class="adj-approve-cb" data-row-id="${rowId}"${checked}></td>`;
            }
            html += '</tr>';
        });
        tbody.innerHTML = html;

        // 재실사 수량 입력 이벤트
        if (mode === 'recount') {
            tbody.querySelectorAll('.recount-qty-input').forEach(input => {
                input.addEventListener('change', (e) => {
                    const rid = e.target.getAttribute('data-row-id');
                    const row = AppState.comparisonResult.find(r => r._rowId === rid);
                    if (!row) return;

                    const val = e.target.value.trim();
                    if (val === '') {
                        // 삭제 → 원본으로 복원
                        delete AppState.recountData[rid];
                        if (row._originalPhysicalQty !== undefined) {
                            row.physicalQty = row._originalPhysicalQty;
                            delete row._originalPhysicalQty;
                        }
                        e.target.classList.remove('confirmed');
                    } else {
                        // 재실사 수량 적용
                        const newQty = Math.max(0, parseInt(val, 10) || 0);
                        AppState.recountData[rid] = newQty;
                        if (row._originalPhysicalQty === undefined) {
                            row._originalPhysicalQty = row.physicalQty;
                        }
                        row.physicalQty = newQty;
                        row._touched = true;
                        e.target.classList.add('confirmed');
                    }
                    // 차이/상태 재계산
                    row.difference = row.physicalQty - row.empQty;
                    row.status = row.difference === 0 ? 'MATCH' : 'MISMATCH';

                    // 요약 + 셀 즉시 갱신
                    renderAdjSummary(getAdjTargetsAll(), getAdjTargets());
                    renderAdjZoneSummary(getAdjTargetsAll());
                    const tr = e.target.closest('tr');
                    if (tr) {
                        const cells = tr.querySelectorAll('td');
                        // cells: #, SKU, 상품명, 위치, 구역, EMP, 1차실사(6), 차이(7), 재실사입력(8), 상태(9)
                        if (cells[6]) {
                            cells[6].innerHTML = row._originalPhysicalQty !== undefined
                                ? `<span style="text-decoration:line-through;color:var(--text-muted);font-size:0.85em;">${formatNum(row._originalPhysicalQty)}</span> → ${formatNum(row.physicalQty)}`
                                : formatNum(row.physicalQty);
                        }
                        if (cells[7]) {
                            cells[7].className = getDiffClass(row.difference);
                            cells[7].textContent = `${row.difference > 0 ? '+' : ''}${formatNum(row.difference)}`;
                        }
                        if (cells[9]) cells[9].innerHTML = statusBadge(row.status);
                    }
                    triggerAutoSave();
                });
            });
        } else {
            // 승인 체크박스 이벤트
            tbody.querySelectorAll('.adj-approve-cb').forEach(cb => {
                cb.addEventListener('change', (e) => {
                    const rid = e.target.getAttribute('data-row-id');
                    if (e.target.checked) {
                        AppState.adjApproved.add(rid);
                    } else {
                        AppState.adjApproved.delete(rid);
                    }
                });
            });
        }
    }

    // 페이지네이션
    document.getElementById('adj-page-info').textContent = `${AppState.adjPage} / ${totalPages}`;
    document.getElementById('adj-prev-page').disabled = AppState.adjPage <= 1;
    document.getElementById('adj-next-page').disabled = AppState.adjPage >= totalPages;
    // 비합산 모드: 전체 펼침/접기 버튼 숨김
    document.getElementById('adj-expand-all').style.display = 'none';
}

/**
 * SKU 합산 뷰 테이블 렌더링
 * - 그룹 행 클릭으로 하위 행 펼치기/접기
 * - 전체 펼침/접기 버튼 표시
 * @param {object[]} groups - groupBySku() 반환 그룹 배열
 */
function renderAdjTableGrouped(groups) {
    const pageSize = 50;

    // 정렬
    if (AppState.adjSortColumn) {
        const col = AppState.adjSortColumn;
        const dir = AppState.adjSortDirection === 'desc' ? -1 : 1;
        const colMap = { empQty: 'empTotal', physicalQty: 'physTotal', difference: 'diffTotal' };
        const actualCol = colMap[col] || col;
        groups.sort((a, b) => {
            let va = a[actualCol], vb = b[actualCol];
            if (['empTotal', 'physTotal', 'diffTotal', 'locationCount'].includes(actualCol)) {
                return (Number(va || 0) - Number(vb || 0)) * dir;
            }
            va = String(va || '').toLowerCase();
            vb = String(vb || '').toLowerCase();
            return va < vb ? -1 * dir : va > vb ? 1 * dir : 0;
        });
    } else {
        // 기본: 차이 절대값 큰 순
        groups.sort((a, b) => Math.abs(b.diffTotal) - Math.abs(a.diffTotal));
    }

    const totalPages = Math.max(1, Math.ceil(groups.length / pageSize));
    if (AppState.adjPage > totalPages) AppState.adjPage = totalPages;
    const start = (AppState.adjPage - 1) * pageSize;
    const page = groups.slice(start, start + pageSize);

    document.getElementById('adj-table-title').textContent = 'SKU 합산 비교 목록';

    const sc = AppState.adjSortColumn;
    const sd = AppState.adjSortDirection;
    const sh = (label, col) => {
        const isActive = sc === col;
        const icon = isActive ? (sd === 'asc' ? '▲' : '▼') : '⇅';
        return `<th class="sortable-th${isActive ? ' sort-active' : ''}" data-adj-sort="${col}">${label}<span class="sort-icon">${icon}</span></th>`;
    };

    const thead = document.getElementById('adj-table-head');
    thead.innerHTML = `<tr><th>#</th>${sh('SKU','sku')}${sh('상품명','name')}${sh('위치 수','locationCount')}${sh('EMP 합계','empQty')}${sh('실사 합계','physicalQty')}${sh('차이','difference')}${sh('상태','status')}<th></th></tr>`;

    thead.querySelectorAll('[data-adj-sort]').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.getAttribute('data-adj-sort');
            if (AppState.adjSortColumn === col) {
                if (AppState.adjSortDirection === 'asc') {
                    AppState.adjSortDirection = 'desc';
                } else {
                    AppState.adjSortColumn = null;
                    AppState.adjSortDirection = 'asc';
                }
            } else {
                AppState.adjSortColumn = col;
                AppState.adjSortDirection = 'asc';
            }
            AppState.adjPage = 1;
            renderAdjustmentView();
        });
    });

    const tbody = document.getElementById('adj-table-body');
    if (page.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:32px;color:#9CA3AF;">조정 대상 항목이 없습니다.</td></tr>';
    } else {
        let html = '';
        page.forEach((g, i) => {
            const statusLabel = g.status === 'LOCATION_SHIFT' ? '위치이동만' : '수량차이';
            const statusClass = g.status === 'LOCATION_SHIFT' ? 'location-shift' : 'mismatch';
            const diffClass = getDiffClass(g.diffTotal);
            const skuKey = normalize(g.sku);

            html += `<tr class="sku-group-row expanded" data-sku-key="${esc(skuKey)}" style="cursor:pointer;">`;
            html += `<td>${start + i + 1}</td>`;
            html += `<td><strong>${esc(g.sku)}</strong></td>`;
            html += `<td>${esc(g.name)}</td>`;
            html += `<td style="text-align:center;">${g.locationCount}</td>`;
            html += `<td>${formatNum(g.empTotal)}</td>`;
            html += `<td>${formatNum(g.physTotal)}</td>`;
            html += `<td class="${diffClass}" style="font-weight:700;">${g.diffTotal > 0 ? '+' : ''}${formatNum(g.diffTotal)}</td>`;
            html += `<td><span class="status-badge ${statusClass}">${statusLabel}</span></td>`;
            html += `<td><i class="fas fa-chevron-up sku-expand-icon"></i></td>`;
            html += '</tr>';

            // 하위 행 (기본 펼침)
            g.rows.forEach(r => {
                html += `<tr class="sku-sub-row" data-parent-sku="${esc(skuKey)}">`;
                html += `<td></td>`;
                html += `<td style="padding-left:24px;color:var(--text-muted);">└</td>`;
                html += `<td>${esc(r.location)}</td>`;
                html += `<td>${esc(r.warehouseZone)}</td>`;
                html += `<td>${formatNum(r.empQty)}</td>`;
                html += `<td>${formatNum(r.physicalQty)}</td>`;
                html += `<td class="${getDiffClass(r.difference)}">${r.difference > 0 ? '+' : ''}${formatNum(r.difference)}</td>`;
                html += `<td>${statusBadge(r.status)}</td>`;
                html += `<td></td>`;
                html += '</tr>';
            });
        });
        tbody.innerHTML = html;

        // 펼치기/접기 이벤트
        tbody.querySelectorAll('.sku-group-row').forEach(row => {
            row.addEventListener('click', () => {
                const skuKey = row.getAttribute('data-sku-key');
                const subRows = tbody.querySelectorAll(`.sku-sub-row[data-parent-sku="${skuKey}"]`);
                const icon = row.querySelector('.sku-expand-icon');
                const isOpen = subRows[0] && subRows[0].style.display !== 'none';
                subRows.forEach(sr => sr.style.display = isOpen ? 'none' : '');
                if (icon) {
                    icon.classList.toggle('fa-chevron-down', isOpen);
                    icon.classList.toggle('fa-chevron-up', !isOpen);
                }
                row.classList.toggle('expanded', !isOpen);
            });
        });
    }

    // 페이지네이션
    document.getElementById('adj-page-info').textContent = `${AppState.adjPage} / ${totalPages}`;
    document.getElementById('adj-prev-page').disabled = AppState.adjPage <= 1;
    document.getElementById('adj-next-page').disabled = AppState.adjPage >= totalPages;

    // 전체 펼침/접기 버튼
    const expandAllBtn = document.getElementById('adj-expand-all');
    expandAllBtn.style.display = '';
    const updateExpandIcon = () => {
        const anyOpen = tbody.querySelector('.sku-sub-row:not([style*="display: none"])');
        const icon = expandAllBtn.querySelector('i');
        icon.className = anyOpen ? 'fas fa-angles-up' : 'fas fa-angles-down';
        expandAllBtn.title = anyOpen ? '전체 접기' : '전체 펼치기';
    };
    updateExpandIcon();
    expandAllBtn.onclick = () => {
        const anyOpen = tbody.querySelector('.sku-sub-row:not([style*="display: none"])');
        const showAll = !anyOpen;
        tbody.querySelectorAll('.sku-sub-row').forEach(sr => sr.style.display = showAll ? '' : 'none');
        tbody.querySelectorAll('.sku-group-row').forEach(row => {
            row.classList.toggle('expanded', showAll);
            const icon = row.querySelector('.sku-expand-icon');
            if (icon) {
                icon.classList.toggle('fa-chevron-up', showAll);
                icon.classList.toggle('fa-chevron-down', !showAll);
            }
        });
        updateExpandIcon();
    };
}

/**
 * EMP 업로드 미리보기 테이블 렌더링 (adjust 모드 전용)
 * @param {object[]} targets - 조정 대상 행 배열
 */
function renderAdjEmpPreview(targets) {
    const previewWrap = document.getElementById('adj-emp-preview');
    const tableWrap = document.getElementById('adj-preview-table-wrap');
    const countEl = document.getElementById('adj-preview-count');

    if (AppState.adjMode !== 'adjust') {
        previewWrap.style.display = 'none';
        return;
    }

    const items = targets.filter(r => r.difference !== 0);
    if (items.length === 0) {
        previewWrap.style.display = 'none';
        return;
    }

    previewWrap.style.display = '';
    countEl.textContent = `${items.length}건`;

    // 최대 20행 미리보기
    const preview = items.slice(0, 20);
    let html = '<table><thead><tr><th>상품코드</th><th>색상코드</th><th>사이즈코드</th><th>로케이션</th><th>실사수량</th><th>조정수량</th></tr></thead><tbody>';
    preview.forEach(r => {
        const diffStyle = r.difference > 0
            ? 'color:#22C55E;font-weight:700;'
            : 'color:#EF4444;font-weight:700;';
        html += `<tr>`;
        html += `<td>${esc(r.sku)}</td>`;
        html += `<td>999</td><td>999</td>`;
        html += `<td>${esc(r.location || '00-00-00-00')}</td>`;
        html += `<td>0</td>`;
        html += `<td style="${diffStyle}">${r.difference > 0 ? '+' : ''}${r.difference}</td>`;
        html += `</tr>`;
    });
    if (items.length > 20) {
        html += `<tr><td colspan="6" style="text-align:center;color:#9CA3AF;padding:12px;">... 외 ${items.length - 20}건 더</td></tr>`;
    }
    html += '</tbody></table>';
    tableWrap.innerHTML = html;
}

// ═══════════════════════════════════════════════════════
// 8. 외부 데이터 병합 (mergeExternalData)
// ═══════════════════════════════════════════════════════

/**
 * 추가 실사 파일 → comparisonResult 병합
 * - 동일 SKU+위치: physicalQty 업데이트
 * - 신규 SKU+위치: ONLY_IN_PHYSICAL 행으로 추가
 * @param {File} file - 병합할 파일
 */
async function mergeExternalData(file) {
    if (!AppState.comparisonResult || AppState.comparisonResult.length === 0) {
        toast('먼저 비교 분석을 실행한 후 병합하세요.', 'warning');
        return;
    }

    try {
        await loadXLSX();
        setLoading(true);
        const result = await parseFile(file);
        const rows = result.rows;
        const cols = result.columns;

        if (rows.length === 0) {
            toast('파일에 데이터가 없습니다.', 'error');
            return;
        }

        const mapping = autoMapMergeColumns(cols);
        if (!mapping.sku || !mapping.qty) {
            toast('상품코드(SKU)와 수량 컬럼을 찾을 수 없습니다. 컬럼명을 확인하세요.', 'error');
            return;
        }

        // 기존 데이터를 SKU+위치 키로 인덱싱
        const existingMap = new Map();
        AppState.comparisonResult.forEach(r => {
            const key = `${normalize(r.sku)}|||${normalize(r.location)}`;
            existingMap.set(key, r);
        });

        let updated = 0;
        let added = 0;
        let skipped = 0;

        // 외부 데이터를 SKU+위치 기준으로 먼저 합산 (동일 키 중복 행 처리)
        const externalAgg = new Map();
        rows.forEach(row => {
            const sku = String(row[mapping.sku] ?? '').trim();
            const barcode = mapping.barcode ? String(row[mapping.barcode] ?? '').trim() : '';
            const name = mapping.name ? String(row[mapping.name] ?? '').trim() : '';
            const qty = safeInt(row[mapping.qty]);
            const location = mapping.location ? String(row[mapping.location] ?? '').trim() : '';

            if (!sku) { skipped++; return; }

            const key = `${normalize(sku)}|||${normalize(location)}`;
            if (externalAgg.has(key)) {
                externalAgg.get(key).qty += qty;
            } else {
                externalAgg.set(key, { sku, barcode, name, qty, location });
            }
        });

        // 합산된 데이터를 기존 comparisonResult에 병합
        externalAgg.forEach((ext, key) => {
            if (existingMap.has(key)) {
                const existing = existingMap.get(key);
                existing.physicalQty = ext.qty;
                existing.difference = ext.qty - existing.empQty;
                existing.status = existing.difference === 0 ? 'MATCH' : 'MISMATCH';
                existing._touched = true;
                if (ext.name && !existing.name) existing.name = ext.name;
                if (ext.barcode && !existing.barcode) existing.barcode = ext.barcode;
                updated++;
            } else {
                const empRef = AppState.comparisonResult.find(r => normalize(r.sku) === normalize(ext.sku));
                const newRow = {
                    _rowId:        generateRowId(),
                    sku:           ext.sku,
                    barcode:       ext.barcode || (empRef ? empRef.barcode : ''),
                    name:          ext.name || (empRef ? empRef.name : ''),
                    location:      ext.location,
                    warehouseZone: parseWarehouseZone(ext.location),
                    empQty:        0,
                    physicalQty:   ext.qty,
                    difference:    ext.qty,
                    status:        'ONLY_IN_PHYSICAL',
                    matchType:     'none',
                    reason:        '',
                    memo:          `외부 데이터 병합 (${file.name})`,
                    _touched:      true
                };
                AppState.comparisonResult.push(newRow);
                existingMap.set(key, newRow);
                added++;
            }
        });

        populateZoneFilter(AppState.comparisonResult);
        refreshDashboard();
        renderAdjustmentView();

        const statusEl = document.getElementById('adj-merge-status');
        if (statusEl) statusEl.textContent = `✅ ${file.name} 병합 완료`;

        toast(`✅ 병합 완료! 업데이트 ${updated}건 · 신규 추가 ${added}건 · 건너뜀 ${skipped}건`, 'success');

    } catch (err) {
        console.error(err);
        toast('파일 병합 실패: ' + err.message, 'error');
    } finally {
        setLoading(false);
    }
}

/**
 * 병합용 컬럼 자동 매핑
 * @param {string[]} cols - 헤더 컬럼명 배열
 * @returns {{ sku, barcode, name, qty, location }}
 */
function autoMapMergeColumns(cols) {
    const mapping = { sku: null, barcode: null, name: null, qty: null, location: null };

    const patterns = {
        sku:      [/상품코드/i, /sku/i, /품번/i, /product.?code/i, /item.?code/i],
        barcode:  [/바코드/i, /barcode/i, /upc/i, /ean/i],
        name:     [/상품명/i, /name/i, /product.?name/i, /아티스트/i],
        qty:      [/수량/i, /qty/i, /quantity/i, /재고/i, /count/i],
        location: [/로케이션/i, /location/i, /위치/i, /loc/i],
    };

    Object.entries(patterns).forEach(([field, pats]) => {
        for (const pat of pats) {
            const found = cols.find(c => pat.test(c));
            if (found) { mapping[field] = found; break; }
        }
    });

    return mapping;
}

// ═══════════════════════════════════════════════════════
// 9. 구글 드라이브 전송 (GAS WebApp 경유)
// ═══════════════════════════════════════════════════════

/**
 * 실사 결과 CSV를 구글 드라이브로 전송
 * - 작업 구역: 사이드바 필터값 자동 사용, ALL이면 prompt
 * - 작업자: AppState.assigneeName 우선, 없으면 prompt
 * - 파일명: YYMMDD_구역_이름.csv
 * - 전송 데이터: 실사 수량이 입력된 항목(_touched/completedRows/physicalQty>0)만 포함
 */
function uploadToDrive() {
    if (!AppState.comparisonResult || AppState.comparisonResult.length === 0) {
        toast('전송할 데이터가 없습니다. 먼저 비교를 실행하세요.', 'warning');
        return;
    }

    // 실사 작업이 실제로 이루어진 항목만 필터링
    const workedItems = AppState.comparisonResult.filter(r => {
        if (AppState.completedRows.has(r._rowId)) return true;
        if (r._touched) return true;
        if (r.physicalQty > 0) return true;
        if (r.status === 'ONLY_IN_PHYSICAL') return true;
        return false;
    });

    if (workedItems.length === 0) {
        toast('실사 수량이 입력된 항목이 없습니다. 실사를 진행한 후 제출하세요.', 'warning');
        return;
    }

    // 수량 0 항목 경고 (현재 필터 기준)
    const zeroQtyInView = AppState.filteredResult.filter(r => r.physicalQty === 0 && r.empQty > 0);
    if (zeroQtyInView.length > 0) {
        const zoneLabel = document.getElementById('zone-filter').value;
        const scopeMsg = zoneLabel !== 'ALL' ? ` (구역: ${zoneLabel})` : '';
        const proceed = window.confirm(
            `⚠️ 실사 수량이 0인 항목이 ${zeroQtyInView.length}건 있습니다.${scopeMsg}\n\n` +
            `수량을 입력하지 않은 항목이 포함되어 있을 수 있습니다.\n\n` +
            `그대로 제출하시겠습니까?\n\n` +
            `(취소 후 상태 필터에서 "수량 0"을 선택하면 해당 항목을 확인할 수 있습니다.)`
        );
        if (!proceed) return;
    }

    // 작업 구역 — 사이드바 필터값 자동 반영, ALL이면 직접 입력
    let zone = document.getElementById('zone-filter').value;
    if (zone === 'ALL') {
        zone = prompt('작업 구역을 입력하세요 (예: 01-04, 02-01):');
        if (zone === null || zone.trim() === '') {
            toast('작업 구역이 입력되지 않았습니다. 전송이 취소되었습니다.', 'error');
            return;
        }
    }

    // 작업자 이름 — 담당자 설정 우선, 없으면 직접 입력
    let worker = AppState.assigneeName ? AppState.assigneeName : null;
    if (!worker) {
        worker = prompt('작업자 이름을 입력하세요:');
        if (worker === null || worker.trim() === '') {
            toast('작업자 이름이 입력되지 않았습니다. 전송이 취소되었습니다.', 'error');
            return;
        }
    }

    // 제출 전 확인 다이얼로그
    const confirmed = window.confirm(
        `구글 드라이브로 실사 데이터를 제출합니다.\n\n` +
        `• 담당자: ${worker.trim()}\n` +
        `• 구역: ${zone.trim()}\n` +
        `• 전송 항목: ${workedItems.length}건 (실사 수량 입력된 항목만)\n` +
        `  ※ 실사하지 않은 항목 ${AppState.comparisonResult.length - workedItems.length}건은 제외됩니다\n\n` +
        `계속하시겠습니까?`
    );
    if (!confirmed) return;

    // 파일명 생성: YYMMDD_구역_이름.csv
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const fileName = `${yy}${mm}${dd}_${zone.trim()}_${worker.trim()}.csv`;

    // CSV 생성 (workedItems 기반, BOM 없음)
    const headers = ['SKU', '바코드', '상품명', '위치', '구역', 'EMP 수량', '실사 수량', '차이', '상태', '조정 사유', '메모'];
    let csvString = headers.join(',') + '\n';
    workedItems.forEach(r => {
        const row = [r.sku, r.barcode, r.name, r.location, r.warehouseZone,
            r.empQty, r.physicalQty, r.difference, r.status, r.reason || '', r.memo || ''];
        csvString += row.map(val => {
            const s = String(val ?? '');
            return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(',') + '\n';
    });

    // 한글 깨짐 방지: Base64 인코딩
    const base64Data = btoa(unescape(encodeURIComponent(csvString)));

    // 버튼 비활성화 & 전송 시작 알림
    const btn = document.getElementById('btn-drive-upload');
    if (btn) btn.disabled = true;
    toast(`구글 드라이브로 전송 중... (${workedItems.length}건)`, 'info');

    // 집계용 행 데이터
    const rowData = workedItems.map(r => ({
        sku:         r.sku        || '',
        name:        r.name       || '',
        location:    r.location   || '',
        zone:        r.warehouseZone || '',
        empQty:      r.empQty,
        physicalQty: r.physicalQty,
        difference:  r.difference,
        status:      r.status,
        reason:      r.reason     || '',
        memo:        r.memo       || '',
        done:        AppState.completedRows.has(r._rowId),
    }));

    fetch(GAS_WEBAPP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
            fileName,
            data:          base64Data,
            workerName:    worker.trim(),
            zone:          zone.trim(),
            zoneAssignees: AppState.zoneAssignees,
            uploadedAt:    new Date().toISOString(),
            rowData,
            sessionId:     FirebaseSync.sessionId || '',
        })
    })
    .then(response => response.text())
    .then(rawText => {
        console.log('[Drive Upload] Raw response:', rawText);

        let result;
        try {
            result = JSON.parse(rawText);
        } catch (parseErr) {
            // JSON 파싱 실패 시 원문에 success 포함 여부로 판단
            if (rawText.includes('"status":"success"')) {
                toast(`✅ "${fileName}" 전송 완료! 구글 드라이브에 저장되었습니다.`, 'success');
                return;
            }
            console.error('[Drive Upload] JSON parse failed:', parseErr);
            toast('⚠️ 전송 처리 중입니다. 구글 드라이브 폴더를 확인해 주세요.', 'warning');
            return;
        }

        if (result.status === 'success' || rawText.includes('"status":"success"')) {
            toast(`✅ "${fileName}" 전송 완료! 구글 드라이브에 저장되었습니다.`, 'success');
        } else {
            toast(`⚠️ 서버 응답 오류: ${result.message || JSON.stringify(result)}`, 'error');
        }
    })
    .catch(err => {
        // 네트워크 에러: 파일이 이미 업로드되었을 수 있으므로 부드럽게 안내
        console.error('[Drive Upload Error]', err);
        toast('⚠️ 전송 처리 중입니다. 구글 드라이브 폴더를 확인해 주세요.', 'warning');
    })
    .finally(() => {
        if (btn) btn.disabled = false;
    });
}

// ═══════════════════════════════════════════════════════
// 10. 다중 검색 모달 (Shift+F)
// ═══════════════════════════════════════════════════════

/** 다중 검색 모달 열기 */
function openMultiSearchModal() {
    const modal = document.getElementById('multi-search-modal');
    modal.style.display = 'flex';
    const textarea = document.getElementById('multi-search-textarea');
    if (AppState.multiSearchTerms.length > 0) {
        textarea.value = AppState.multiSearchTerms.join('\n');
    }
    textarea.focus();
}

/** 다중 검색 모달 닫기 */
function closeMultiSearchModal() {
    hide('multi-search-modal');
}

/** 다중 검색 적용 — 텍스트에어리어의 키워드를 쉼표/공백/줄바꿈으로 분리 */
function applyMultiSearch() {
    const textarea = document.getElementById('multi-search-textarea');
    const raw = textarea.value;
    const terms = raw.split(/[,\s\n]+/).map(t => t.trim()).filter(t => t.length > 0);
    AppState.multiSearchTerms = terms;
    closeMultiSearchModal();
    applyFilters();
    if (terms.length > 0) {
        toast(`다중 검색 적용: ${terms.length}개 키워드`, 'info');
    }
}

/** 다중 검색 초기화 */
function resetMultiSearch() {
    document.getElementById('multi-search-textarea').value = '';
    AppState.multiSearchTerms = [];
    closeMultiSearchModal();
    applyFilters();
    toast('다중 검색이 초기화되었습니다.', 'info');
}
