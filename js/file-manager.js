/* ═══════════════════════════════════════════════════════════════════
   file-manager.js — 파일 업로드 / 구글 시트 가져오기 / EMP 갱신

   의존: constants.js (GSHEET_CSV_URL, GSHEET_PHYSICAL_URL)
         state.js     (AppState)
         utils.js     (loadXLSX, toast, setLoading, safeInt, normalize,
                       generateRowId, parseWarehouseZone)
         comparison.js (buildColumnMapping)

   포함 항목:
   · parseFile()                  — 단일 파일 → rows/columns 파싱
   · handleFileSelect()           — 단일 파일 선택 처리
   · handleMultiPhysicalFiles()   — 다중 실사 파일 병합
   · setupFileUpload()            — 드롭존 + 파일 입력 이벤트 등록
   · fetchGoogleSheetEMP()        — 구글 시트 EMP 불러오기
   · fetchGoogleSheetPhysical()   — 구글 시트 실사 불러오기
   · refreshEMPData()             — EMP 수량 실시간 갱신 (실사 보존)
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

// ── 파일 파싱 ──────────────────────────────────────────────

/**
 * CSV 또는 Excel 파일을 SheetJS로 파싱합니다.
 * SheetJS는 필요할 때 동적으로 로드됩니다(loadXLSX).
 * @param   {File}    file
 * @returns {Promise<{ columns: string[], rows: Object[] }>}
 */
async function parseFile(file) {
    await loadXLSX();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data     = new Uint8Array(e.target.result);
                let workbook = XLSX.read(data, { type: 'array', codepage: 65001 });

                // [H8] EUC-KR 인코딩 감지: UTF-8 파싱 후 U+FFFD(깨진 문자) 다수 발견 시 재파싱
                const isCsv = file.name.toLowerCase().endsWith('.csv');
                if (isCsv) {
                    const testSheet = workbook.Sheets[workbook.SheetNames[0]];
                    const sample = XLSX.utils.sheet_to_csv(testSheet).slice(0, 500);
                    if ((sample.match(/\ufffd/g) || []).length > 3) {
                        console.log('[File] EUC-KR 인코딩 감지 → 재파싱');
                        workbook = XLSX.read(data, { type: 'array', codepage: 51949 });
                    }
                }

                const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                const jsonData = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
                if (jsonData.length === 0) {
                    reject(new Error('파일에 데이터가 없습니다.'));
                    return;
                }
                resolve({ columns: Object.keys(jsonData[0]), rows: jsonData });
            } catch (err) {
                reject(new Error('파일 파싱 실패: ' + err.message));
            }
        };
        reader.onerror = () => reject(new Error('파일 읽기 실패'));
        reader.readAsArrayBuffer(file);
    });
}

// ── 파일 선택 처리 ────────────────────────────────────────

/**
 * 단일 파일 선택 후 파싱하여 AppState에 저장합니다.
 * EMP 데이터가 로드되면 컬럼 매핑 UI를 표시합니다.
 * @param {'emp'|'physical'} type
 * @param {File}             file
 */
async function handleFileSelect(type, file) {
    const validExts = ['.csv', '.xlsx', '.xls'];
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!validExts.includes(ext)) {
        toast('CSV 또는 Excel 파일만 업로드 가능합니다.', 'error');
        return;
    }

    try {
        setLoading(true);
        const result = await parseFile(file);

        if (type === 'emp') {
            AppState.empRawData = result.rows;
            AppState.empColumns = result.columns;
        } else {
            AppState.physicalRawData = result.rows;
            AppState.physicalColumns = result.columns;
        }

        _updateUploadCardUI(type, `${file.name} (${result.rows.length}행)`);
        toast(`${type === 'emp' ? 'EMP' : '실사'} 데이터 로드 완료 (${result.rows.length}행)`, 'success');

        if (AppState.empRawData) buildColumnMapping();
    } catch (err) {
        console.error('[FileManager]', err);
        toast(err.message, 'error');
    } finally {
        setLoading(false);
    }
}

/**
 * 다중 실사 파일을 모두 파싱한 뒤 합쳐서 단일 physicalRawData로 저장합니다.
 * @param {File[]} files
 */
async function handleMultiPhysicalFiles(files) {
    const validExts = ['.csv', '.xlsx', '.xls'];
    const validFiles = files.filter(f => validExts.includes('.' + f.name.split('.').pop().toLowerCase()));

    if (validFiles.length === 0) {
        toast('CSV 또는 Excel 파일만 업로드 가능합니다.', 'error');
        return;
    }

    try {
        setLoading(true);
        let allRows = [];
        let columns = null;

        for (const file of validFiles) {
            const result = await parseFile(file);
            if (!columns && result.columns.length > 0) columns = result.columns;
            allRows = allRows.concat(result.rows);
        }

        AppState.physicalRawData = allRows;
        AppState.physicalColumns = columns || [];

        _updateUploadCardUI('physical', `${validFiles.length}개 파일 병합 (총 ${allRows.length}행)`);
        toast(`✅ 실사 데이터 ${validFiles.length}개 파일 로드 완료 (총 ${allRows.length}행)`, 'success');

        if (AppState.empRawData) buildColumnMapping();
    } catch (err) {
        console.error('[FileManager] 다중 파일 로드 오류:', err);
        toast('파일 로드 실패: ' + err.message, 'error');
    } finally {
        setLoading(false);
    }
}

// ── 드롭존 이벤트 등록 ────────────────────────────────────

/**
 * 업로드 카드의 드롭존, 파일 입력, 파일 제거 버튼 이벤트를 등록합니다.
 * @param {'emp'|'physical'} type
 */
function setupFileUpload(type) {
    const dropzone  = document.getElementById(`${type}-dropzone`);
    const fileInput = document.getElementById(`${type}-file-input`);
    const card      = document.getElementById(`${type}-upload-card`);
    const fileInfo  = document.getElementById(`${type}-file-info`);
    const removeBtn = document.getElementById(`${type}-remove-btn`);

    if (!dropzone || !fileInput) return;

    dropzone.addEventListener('click', () => fileInput.click());

    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        card.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => card.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('dragover');
        const files = Array.from(e.dataTransfer.files);
        if (type === 'physical' && files.length > 1) {
            handleMultiPhysicalFiles(files);
        } else if (files[0]) {
            handleFileSelect(type, files[0]);
        }
    });

    fileInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files);
        if (type === 'physical' && files.length > 1) {
            handleMultiPhysicalFiles(files);
        } else if (files[0]) {
            handleFileSelect(type, files[0]);
        }
    });

    if (removeBtn) {
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            fileInput.value = '';
            card.classList.remove('loaded');
            if (fileInfo) fileInfo.style.display = 'none';
            dropzone.style.display = 'block';

            if (type === 'emp') {
                AppState.empRawData = null;
                AppState.empColumns = [];
                const gBtn = document.getElementById('fetch-gsheet-btn');
                if (gBtn) gBtn.style.display = '';
            } else {
                AppState.physicalRawData = null;
                AppState.physicalColumns = [];
            }

            const mappingSection = document.getElementById('column-mapping-section');
            if (mappingSection) mappingSection.style.display = 'none';
        });
    }
}

// ── 구글 시트 가져오기 ─────────────────────────────────────

/**
 * 구글 스프레드시트에서 EMP 데이터를 CSV로 가져옵니다.
 */
async function fetchGoogleSheetEMP() {
    await loadXLSX();
    setLoading(true);
    try {
        const response = await fetch(GSHEET_CSV_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}: 시트를 불러올 수 없습니다.`);

        const csvText = await response.text();
        if (!csvText || csvText.trim().length === 0) throw new Error('시트에서 빈 데이터를 수신했습니다.');

        const workbook = XLSX.read(csvText, { type: 'string', codepage: 65001 });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
        if (jsonData.length === 0) throw new Error('파싱된 데이터가 0행입니다.');

        AppState.empRawData = jsonData;
        AppState.empColumns = Object.keys(jsonData[0]);

        _updateUploadCardUI('emp', `구글_시트_실시간_EMP.csv (${jsonData.length}행)`);
        const gBtn = document.getElementById('fetch-gsheet-btn');
        if (gBtn) gBtn.style.display = 'none';

        toast(`구글 시트 연동 완료 — ${jsonData.length}행 로드됨`, 'success');
        buildColumnMapping();
    } catch (err) {
        console.error('[FileManager] Google Sheet EMP 오류:', err);
        toast('구글 시트 불러오기 실패: ' + err.message, 'error');
    } finally {
        setLoading(false);
    }
}

/**
 * 구글 스프레드시트에서 실사 데이터를 CSV로 가져옵니다.
 */
async function fetchGoogleSheetPhysical() {
    await loadXLSX();
    setLoading(true);
    try {
        const response = await fetch(GSHEET_PHYSICAL_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}: 실사 시트를 불러올 수 없습니다.`);

        const csvText = await response.text();
        if (!csvText || csvText.trim().length === 0) throw new Error('시트에서 빈 데이터를 수신했습니다.');

        const workbook = XLSX.read(csvText, { type: 'string', codepage: 65001 });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
        if (jsonData.length === 0) throw new Error('파싱된 데이터가 0행입니다.');

        AppState.physicalRawData = jsonData;
        AppState.physicalColumns = Object.keys(jsonData[0]);

        _updateUploadCardUI('physical', `구글_시트_실사데이터.csv (${jsonData.length}행)`);
        const gBtn = document.getElementById('fetch-physical-gsheet-btn');
        if (gBtn) gBtn.style.display = 'none';

        toast(`✅ 실사 데이터 연동 완료 — ${jsonData.length}행 로드됨`, 'success');
        if (AppState.empRawData) buildColumnMapping();
    } catch (err) {
        console.error('[FileManager] Google Sheet Physical 오류:', err);
        toast('실사 데이터 불러오기 실패: ' + err.message, 'error');
    } finally {
        setLoading(false);
    }
}

// ── EMP 데이터 갱신 (실사 보존) ───────────────────────────

/**
 * 구글 시트에서 최신 EMP 수량을 가져와 기존 비교 결과의 empQty만 갱신합니다.
 * 실사 수량, 사유, 메모는 그대로 유지됩니다.
 */
async function refreshEMPData() {
    await loadXLSX();
    if (!AppState.comparisonResult || AppState.comparisonResult.length === 0) {
        toast('먼저 비교 분석을 실행한 후 갱신하세요.', 'warning');
        return;
    }

    const confirmed = window.confirm(
        'EMP 기초자료를 구글시트에서 최신으로 갱신합니다.\n\n' +
        '• 실사 수량, 사유, 메모는 그대로 유지됩니다\n' +
        '• EMP 수량과 차이/상태만 재계산됩니다\n\n' +
        '계속하시겠습니까?'
    );
    if (!confirmed) return;

    setLoading(true);
    try {
        const response = await fetch(GSHEET_CSV_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const csvText = await response.text();
        if (!csvText || csvText.trim().length === 0) throw new Error('빈 데이터 수신');

        const workbook = XLSX.read(csvText, { type: 'string', codepage: 65001 });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
        if (jsonData.length === 0) throw new Error('파싱된 데이터 0행');

        const empMapping = _guessEmpMapping(Object.keys(jsonData[0]));
        if (!empMapping.sku || !empMapping.qty) {
            toast('EMP 데이터에서 상품코드/수량 컬럼을 찾을 수 없습니다.', 'error');
            return;
        }

        // 새 EMP를 SKU+위치 키로 인덱싱 (수량 합산)
        const newEmpMap = new Map();
        jsonData.forEach(row => {
            const sku      = String(row[empMapping.sku]      ?? '').trim();
            const location = empMapping.location ? String(row[empMapping.location] ?? '').trim() : '';
            const qty      = safeInt(row[empMapping.qty]);
            if (!sku) return;
            const key = `${normalize(sku)}|||${normalize(location)}`;
            if (newEmpMap.has(key)) {
                newEmpMap.get(key).qty += qty;
            } else {
                newEmpMap.set(key, {
                    sku, location, qty,
                    barcode: empMapping.barcode ? String(row[empMapping.barcode] ?? '').trim() : '',
                    name:    empMapping.name    ? String(row[empMapping.name]    ?? '').trim() : '',
                });
            }
        });

        // 기존 행 업데이트
        let updated = 0, unchanged = 0;
        const existingKeys = new Set();

        AppState.comparisonResult.forEach(r => {
            const key = `${normalize(r.sku)}|||${normalize(r.location)}`;
            existingKeys.add(key);
            const empEntry = newEmpMap.get(key);
            if (empEntry) {
                const oldEmpQty = r.empQty;
                r.empQty     = empEntry.qty;
                r.difference = r.physicalQty - r.empQty;
                if (r.status === 'ONLY_IN_PHYSICAL' && empEntry.qty > 0) {
                    r.status = r.difference === 0 ? 'MATCH' : 'MISMATCH';
                } else if (r.status !== 'ONLY_IN_PHYSICAL') {
                    r.status = r.difference === 0 ? 'MATCH' : 'MISMATCH';
                }
                if (oldEmpQty !== r.empQty) updated++;
                else unchanged++;
            }
            // 상품명/바코드 보강
            const empEntry2 = newEmpMap.get(key);
            if (empEntry2) {
                if (empEntry2.name    && !r.name)    r.name    = empEntry2.name;
                if (empEntry2.barcode && !r.barcode) r.barcode = empEntry2.barcode;
            }
        });

        // EMP에 신규 추가된 행 삽입
        let added = 0;
        newEmpMap.forEach((empEntry, key) => {
            if (!existingKeys.has(key)) {
                AppState.comparisonResult.push({
                    _rowId:        generateRowId(),
                    sku:           empEntry.sku,
                    barcode:       empEntry.barcode || '',
                    name:          empEntry.name    || '',
                    location:      empEntry.location,
                    warehouseZone: parseWarehouseZone(empEntry.location),
                    empQty:        empEntry.qty,
                    physicalQty:   0,
                    difference:    -empEntry.qty,
                    status:        empEntry.qty === 0 ? 'MATCH' : 'MISMATCH',
                    matchType:     'exact',
                    reason:        '',
                    memo:          '',
                });
                added++;
            }
        });

        AppState.empRawData = jsonData;

        if (typeof populateZoneFilter === 'function') populateZoneFilter(AppState.comparisonResult);
        if (typeof refreshDashboard   === 'function') refreshDashboard();
        if (AppState.currentView === 'adjustment' && typeof renderAdjustmentView === 'function') {
            renderAdjustmentView();
        }

        toast(`✅ EMP 갱신 완료! 변경 ${updated}건 · 신규 ${added}건 · 동일 ${unchanged}건 (총 EMP ${jsonData.length}행)`, 'success');
    } catch (err) {
        console.error('[FileManager] EMP 갱신 오류:', err);
        toast('EMP 갱신 실패: ' + err.message, 'error');
    } finally {
        setLoading(false);
    }
}

// ── 내부 헬퍼 ─────────────────────────────────────────────

/**
 * 업로드 카드 UI를 "파일 로드됨" 상태로 전환합니다.
 * @param {'emp'|'physical'} type
 * @param {string}           labelText - 파일명 + 행 수 레이블
 */
function _updateUploadCardUI(type, labelText) {
    const card       = document.getElementById(`${type}-upload-card`);
    const dropzone   = document.getElementById(`${type}-dropzone`);
    const fileInfo   = document.getElementById(`${type}-file-info`);
    const fileNameEl = document.getElementById(`${type}-file-name`);

    if (card)       card.classList.add('loaded');
    if (dropzone)   dropzone.style.display   = 'none';
    if (fileInfo)   fileInfo.style.display   = 'flex';
    if (fileNameEl) fileNameEl.textContent   = labelText;
}

/**
 * EMP 컬럼 헤더에서 필드 매핑을 자동 추정합니다. (갱신 전용)
 * constants.js의 COLUMN_GUESS_PATTERNS을 재사용합니다.
 * @param   {string[]} cols
 * @returns {Object}   { sku, barcode, name, qty, location }
 */
function _guessEmpMapping(cols) {
    const mapping = { sku: null, barcode: null, name: null, qty: null, location: null };
    Object.keys(mapping).forEach(field => {
        const pats = COLUMN_GUESS_PATTERNS[field] || [];
        for (const pat of pats) {
            const found = cols.find(c => pat.test(c));
            if (found) { mapping[field] = found; break; }
        }
    });
    return mapping;
}
