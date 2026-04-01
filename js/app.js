/* app.js — 진입점: DOMContentLoaded 초기화 + 이벤트 와이어링
 * 의존 로드 순서 (index.html에서 보장):
 *   constants.js → utils.js → state.js → firebase-sync.js → comparison.js
 *   → file-manager.js → dashboard-ui.js → table-renderer.js
 *   → export.js → scanner.js → presence.js → auth.js → app.js
 */
'use strict';

document.addEventListener('DOMContentLoaded', () => {

    // ══════════════════════════════════════════════════════
    // [CRITICAL 1] Auth 초기화 — DOMContentLoaded 맨 앞에서 호출
    // initFirebase()는 auth.js의 onAuthStateChanged 콜백에서만 호출됨
    // 로그인 전에는 Firebase DB sync 절대 시작하지 않음
    // ══════════════════════════════════════════════════════
    if (typeof initFirebaseAuth === 'function') {
        initFirebaseAuth();
    } else {
        console.warn('[App] auth.js 미로드 — initFirebase() 직접 호출 (폴백)');
        initFirebase();
    }

    // ── 메인 테이블 이벤트 위임 (1회 등록) ──
    initMainTableDelegation();

    // ── localStorage 저장 데이터 복원 모달 ──
    const savedData = loadFromLocalStorage();
    if (savedData) {
        const modal  = document.getElementById('restore-modal');
        const metaEl = document.getElementById('restore-meta');

        const savedDate  = new Date(savedData.timestamp);
        const count      = savedData.comparisonResult.length;
        const modeLabel  = savedData.isEmpOnly ? 'EMP 전용 모드' : '비교 모드';
        metaEl.textContent = `저장 시각: ${savedDate.toLocaleString('ko-KR')} | 데이터: ${count}건 | ${modeLabel}`;

        show(modal, 'flex');

        document.getElementById('restore-load-btn').addEventListener('click', () => {
            hide(modal);
            restoreFromSavedData(savedData);
        });
        document.getElementById('restore-discard-btn').addEventListener('click', () => {
            hide(modal);
            clearLocalStorage();
            toast('이전 데이터가 삭제되었습니다.', 'info');
        });
        document.getElementById('restore-close-btn').addEventListener('click', () => hide(modal));
    }

    // ══════════════════════════════════════════════════════
    // 파일 업로드 이벤트
    // ══════════════════════════════════════════════════════
    setupFileUpload('emp');
    setupFileUpload('physical');

    document.getElementById('fetch-gsheet-btn').addEventListener('click', fetchGoogleSheetEMP);
    document.getElementById('fetch-physical-gsheet-btn').addEventListener('click', fetchGoogleSheetPhysical);

    const empRefreshBtn = document.getElementById('emp-refresh-btn');
    if (empRefreshBtn) empRefreshBtn.addEventListener('click', refreshEMPData);

    // ══════════════════════════════════════════════════════
    // 비교 실행 버튼
    // ══════════════════════════════════════════════════════
    document.getElementById('run-comparison-btn').addEventListener('click', () => {
        if (!AppState.empRawData) {
            toast('EMP 데이터 파일을 먼저 업로드해주세요.', 'error');
            return;
        }

        const mappings = getColumnMappings();
        if (!validateMappings(mappings)) return;

        setLoading(true);
        setTimeout(() => {
            try {
                AppState.comparisonResult  = runComparison(mappings);
                AppState.filteredResult    = [...AppState.comparisonResult];
                AppState.currentPage       = 1;
                AppState.multiSearchTerms  = [];

                switchPhase('dashboard');

                renderKPIs(AppState.comparisonResult);
                populateZoneFilter(AppState.comparisonResult);
                renderCharts(AppState.comparisonResult);
                document.getElementById('filtered-count').textContent = formatNum(AppState.filteredResult.length);
                renderTopDiffTable();
                renderMainTable();

                if (AppState.isEmpOnly) {
                    switchView('livecount');
                    toast(`EMP 전용 모드: 총 ${AppState.comparisonResult.length}건 로드 — 현장 실사를 시작하세요!`, 'success');
                } else {
                    switchView('overview');
                    toast(`비교 완료! 총 ${AppState.comparisonResult.length}건 분석됨`, 'success');
                }

                triggerAutoSave();
            } catch (err) {
                console.error(err);
                toast('비교 분석 중 오류 발생: ' + err.message, 'error');
            } finally {
                setLoading(false);
            }
        }, 50);
    });

    // ══════════════════════════════════════════════════════
    // 뷰 탭 이벤트
    // ══════════════════════════════════════════════════════
    document.getElementById('tab-overview').addEventListener('click',    () => switchView('overview'));
    document.getElementById('tab-livecount').addEventListener('click',   () => switchView('livecount'));
    document.getElementById('tab-adjustment').addEventListener('click',  () => switchView('adjustment'));

    // ══════════════════════════════════════════════════════
    // 재실사 · 재고조정 뷰 이벤트
    // ══════════════════════════════════════════════════════
    document.getElementById('adj-mode-recount').addEventListener('click', () => {
        AppState.adjMode = 'recount';
        document.getElementById('adj-mode-recount').classList.add('active');
        document.getElementById('adj-mode-adjust').classList.remove('active');
        AppState.adjPage = 1;
        renderAdjustmentView();
    });
    document.getElementById('adj-mode-adjust').addEventListener('click', () => {
        AppState.adjMode = 'adjust';
        document.getElementById('adj-mode-adjust').classList.add('active');
        document.getElementById('adj-mode-recount').classList.remove('active');
        AppState.adjPage = 1;
        renderAdjustmentView();
    });

    document.getElementById('adj-export-recount-btn').addEventListener('click', exportRecountSheet);
    document.getElementById('adj-export-adjust-btn').addEventListener('click', exportAdjustmentSheet);

    // 재실사 결과 파일 업로드
    const rcUploadBtn = document.getElementById('adj-recount-upload-btn');
    const rcFileInput = document.getElementById('adj-recount-file');
    if (rcUploadBtn && rcFileInput) {
        rcUploadBtn.addEventListener('click', () => rcFileInput.click());
        rcFileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) importRecountData(file);
            e.target.value = '';
        });
    }

    // SKU 합산 보기 토글
    document.getElementById('adj-sku-group-btn').addEventListener('click', () => {
        AppState.adjSkuGrouped    = !AppState.adjSkuGrouped;
        AppState.adjPage          = 1;
        AppState.adjSortColumn    = null;
        AppState.adjSortDirection = 'asc';
        renderAdjustmentView();
    });

    // 추가 데이터 병합
    const mergeBtn       = document.getElementById('adj-merge-btn');
    const mergeFileInput = document.getElementById('adj-merge-file');
    if (mergeBtn && mergeFileInput) {
        mergeBtn.addEventListener('click', () => mergeFileInput.click());
        mergeFileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) mergeExternalData(file);
            mergeFileInput.value = '';
        });
    }

    // 조정 뷰 페이지네이션
    document.getElementById('adj-prev-page').addEventListener('click', () => {
        if (AppState.adjPage > 1) { AppState.adjPage--; renderAdjustmentView(); }
    });
    document.getElementById('adj-next-page').addEventListener('click', () => {
        const targets   = getAdjTargets();
        const itemCount = AppState.adjSkuGrouped ? groupBySku(targets).length : targets.length;
        const totalPages = Math.ceil(itemCount / 50);
        if (AppState.adjPage < totalPages) { AppState.adjPage++; renderAdjustmentView(); }
    });

    // ══════════════════════════════════════════════════════
    // 필터 이벤트
    // ══════════════════════════════════════════════════════
    document.querySelectorAll('input[name="status-filter"]').forEach(radio => {
        radio.addEventListener('change', () => {
            setStatusRadioUI(radio.value);
            applyFilters();
        });
    });

    document.getElementById('zone-filter').addEventListener('change', () => {
        populateLocationFilter(AppState.comparisonResult);
        applyFilters();
        renderZoneProgress();
    });

    const locFilterEl = document.getElementById('location-filter');
    if (locFilterEl) locFilterEl.addEventListener('change', () => {
        AppState.locationFilter = locFilterEl.value;
        applyFilters();
    });

    let searchTimeout;
    document.getElementById('search-input').addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(applyFilters, 300);
    });

    document.getElementById('reset-filters-btn').addEventListener('click', () => {
        document.querySelector('input[name="status-filter"][value="ALL"]').checked = true;
        resetStatusRadioUI();
        document.getElementById('zone-filter').value = 'ALL';
        const lf = document.getElementById('location-filter');
        if (lf) { lf.value = 'ALL'; AppState.locationFilter = 'ALL'; }
        document.getElementById('search-input').value = '';
        AppState.multiSearchTerms = [];
        document.getElementById('multi-search-textarea').value = '';
        AppState.sortColumn    = null;
        AppState.sortDirection = 'asc';
        populateLocationFilter(AppState.comparisonResult);
        applyFilters();
    });

    // 테이블 헤더 정렬 — 이벤트 위임 (thead가 다시 그려져도 동작)
    document.getElementById('main-table-head').addEventListener('click', (e) => {
        const th = e.target.closest('.sortable-th');
        if (!th) return;
        const key = th.getAttribute('data-sort-key');
        if (key) toggleSort(key);
    });

    // ══════════════════════════════════════════════════════
    // 페이지네이션 이벤트
    // ══════════════════════════════════════════════════════
    document.getElementById('prev-page-btn').addEventListener('click', () => {
        if (AppState.currentPage > 1) { AppState.currentPage--; renderMainTable(); }
    });
    document.getElementById('next-page-btn').addEventListener('click', () => {
        const totalPages = Math.ceil(AppState.filteredResult.length / AppState.pageSize);
        if (AppState.currentPage < totalPages) { AppState.currentPage++; renderMainTable(); }
    });
    document.getElementById('page-size-select').addEventListener('change', (e) => {
        AppState.pageSize    = parseInt(e.target.value, 10);
        AppState.currentPage = 1;
        renderMainTable();
    });

    // ══════════════════════════════════════════════════════
    // 내보내기 이벤트
    // ══════════════════════════════════════════════════════
    document.getElementById('export-csv-btn').addEventListener('click', exportToCSV);
    document.getElementById('export-excel-btn').addEventListener('click', exportToExcel);
    document.getElementById('export-recount-btn').addEventListener('click', exportRecountSheet);
    document.getElementById('export-adjustment-btn').addEventListener('click', exportAdjustmentSheet);
    document.getElementById('btn-drive-upload').addEventListener('click', uploadToDrive);

    // ══════════════════════════════════════════════════════
    // 새 비교 버튼
    // ══════════════════════════════════════════════════════
    document.getElementById('new-comparison-btn').addEventListener('click', () => {
        AppState.empRawData      = null;
        AppState.physicalRawData = null;
        AppState.empColumns      = [];
        AppState.physicalColumns = [];
        AppState.comparisonResult = [];
        AppState.filteredResult   = [];
        AppState.multiSearchTerms = [];
        AppState.isEmpOnly        = false;
        AppState.currentView      = 'overview';
        AppState.locationFilter   = 'ALL';
        AppState.sortColumn       = null;
        AppState.sortDirection    = 'asc';

        document.getElementById('emp-file-input').value      = '';
        document.getElementById('physical-file-input').value = '';

        ['emp', 'physical'].forEach(type => {
            document.getElementById(`${type}-upload-card`).classList.remove('loaded');
            document.getElementById(`${type}-file-info`).style.display = 'none';
            document.getElementById(`${type}-dropzone`).style.display  = 'block';
        });

        const gBtn = document.getElementById('fetch-gsheet-btn');
        if (gBtn) gBtn.style.display = '';

        // 실사 데이터 GSheet 버튼도 복원 (새 비교 시 재사용 가능해야 함)
        const gPhysBtn = document.getElementById('fetch-physical-gsheet-btn');
        if (gPhysBtn) gPhysBtn.style.display = 'flex';

        document.getElementById('column-mapping-section').style.display = 'none';

        if (AppState.charts.bar) { AppState.charts.bar.destroy(); AppState.charts.bar = null; }
        if (AppState.charts.pie) { AppState.charts.pie.destroy(); AppState.charts.pie = null; }

        clearLocalStorage();
        switchPhase('upload');
    });

    // ══════════════════════════════════════════════════════
    // 모바일 UI 이벤트
    // ══════════════════════════════════════════════════════
    const mobileSidebarToggle = document.getElementById('mobile-sidebar-toggle');
    if (mobileSidebarToggle) mobileSidebarToggle.addEventListener('click', openSidebar);
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeSidebar);
    const sidebarCloseBtn = document.getElementById('sidebar-close-btn');
    if (sidebarCloseBtn) sidebarCloseBtn.addEventListener('click', closeSidebar);

    // 모바일 하단 탭바
    document.querySelectorAll('.mobile-nav-btn[data-view]').forEach(btn => {
        btn.addEventListener('click', () => {
            switchView(btn.getAttribute('data-view'));
            closeSidebar();
        });
    });
    const mobileFilterBtn = document.getElementById('mobile-filter-btn');
    if (mobileFilterBtn) mobileFilterBtn.addEventListener('click', openSidebar);

    // 모바일 내보내기 드로워
    const mobileExportBtn = document.getElementById('mobile-export-btn');
    if (mobileExportBtn) mobileExportBtn.addEventListener('click', openExportDrawer);
    const drawerOverlay = document.getElementById('mobile-drawer-overlay');
    if (drawerOverlay) drawerOverlay.addEventListener('click', closeExportDrawer);

    // 드로워 내 버튼 → 기존 함수 위임
    const mBtns = {
        'm-export-csv-btn':        () => { exportToCSV(); closeExportDrawer(); },
        'm-export-excel-btn':      () => { exportToExcel(); closeExportDrawer(); },
        'm-export-recount-btn':    () => { exportRecountSheet(); closeExportDrawer(); },
        'm-export-adjustment-btn': () => { exportAdjustmentSheet(); closeExportDrawer(); },
        'm-btn-drive-upload':      () => { closeExportDrawer(); uploadToDrive(); },
        'm-new-comparison-btn':    () => { closeExportDrawer(); document.getElementById('new-comparison-btn').click(); },
    };
    Object.entries(mBtns).forEach(([id, fn]) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', fn);
    });

    // ══════════════════════════════════════════════════════
    // 담당자 설정 이벤트
    // ══════════════════════════════════════════════════════
    loadAssigneeSettings();
    renderAssigneePanel();

    const assigneeSaveBtn = document.getElementById('assignee-save-btn');
    if (assigneeSaveBtn) assigneeSaveBtn.addEventListener('click', saveAssigneeName);

    const assigneeInput = document.getElementById('assignee-name-input');
    if (assigneeInput) assigneeInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') saveAssigneeName();
    });

    const myZonesBtn = document.getElementById('my-zones-only-btn');
    if (myZonesBtn) myZonesBtn.addEventListener('click', toggleMyZonesOnly);

    const assigneeResetBtn = document.getElementById('assignee-reset-btn');
    if (assigneeResetBtn) assigneeResetBtn.addEventListener('click', resetAllAssignees);

    // ══════════════════════════════════════════════════════
    // 다크모드 초기화
    // ══════════════════════════════════════════════════════
    initTheme();

    // 다크모드 토글 버튼 (index.html에서 inline handler 제거됨)
    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    if (themeToggleBtn) themeToggleBtn.addEventListener('click', toggleTheme);

    // ══════════════════════════════════════════════════════
    // Firebase 동기화 / 세션 관련 (inline handler 제거 보완)
    // ══════════════════════════════════════════════════════
    const firebaseSyncBtn = document.getElementById('firebase-sync-btn');
    if (firebaseSyncBtn) firebaseSyncBtn.addEventListener('click', handleFirebaseSyncBtn);

    const copySessionBtn = document.getElementById('btn-copy-session');
    if (copySessionBtn) copySessionBtn.addEventListener('click', copySessionUrl);

    // ══════════════════════════════════════════════════════
    // 구역 진행도 패널 접기/펼치기 (inline handler 제거 보완)
    // ══════════════════════════════════════════════════════
    const zoneProgressHeader = document.getElementById('zone-progress-header');
    if (zoneProgressHeader) zoneProgressHeader.addEventListener('click', toggleZoneProgressPanel);

    // ══════════════════════════════════════════════════════
    // 스캔 카운터 초기화 버튼 (inline handler 제거 보완)
    // ══════════════════════════════════════════════════════
    const counterResetBtn = document.getElementById('counter-reset-btn');
    if (counterResetBtn) {
        counterResetBtn.addEventListener('click', () => {
            resetScanCounter();
            toast('스캔 카운터가 초기화되었습니다.', 'info');
        });
    }

    // ══════════════════════════════════════════════════════
    // 사용자 관리 모달 버튼 (inline handler 제거 보완)
    // ══════════════════════════════════════════════════════
    const userManageRefreshBtn = document.getElementById('user-manage-refresh-btn');
    if (userManageRefreshBtn) userManageRefreshBtn.addEventListener('click', loadUserList);

    const userManageDoneBtn = document.getElementById('user-manage-done-btn');
    if (userManageDoneBtn) userManageDoneBtn.addEventListener('click', closeUserManageModal);

    // ══════════════════════════════════════════════════════
    // 바코드 스캔 입력 (live-scan-input)
    // ══════════════════════════════════════════════════════
    const scanInput = document.getElementById('live-scan-input');
    if (scanInput) {
        scanInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const value = scanInput.value.trim();
                if (value) processScanValue(value);
                scanInput.value = '';
            }
        });
    }

    // Ctrl+/ → 스캔 입력창 포커스 (dashboard-phase가 활성 상태일 때만)
    document.addEventListener('keydown', (e) => {
        if (!document.getElementById('dashboard-phase').classList.contains('active')) return;
        if ((e.ctrlKey || e.metaKey) && e.key === '/') {
            e.preventDefault();
            if (AppState.currentView !== 'livecount') switchView('livecount');
            if (scanInput) { scanInput.focus(); scanInput.select(); }
        }
    });

    // 새 위치 추가 버튼 (스캔 바)
    const scanNewLocBtn = document.getElementById('scan-new-loc-btn');
    if (scanNewLocBtn) {
        scanNewLocBtn.addEventListener('click', () => {
            if (!AppState.lastScannedRow) {
                toast('먼저 상품을 스캔하세요.', 'warning');
                return;
            }
            _promptNewLocation(
                AppState.lastScannedRow,
                AppState.lastScannedRow.sku || AppState.lastScannedRow.barcode
            );
        });
    }

    // ══════════════════════════════════════════════════════
    // 카메라 스캐너
    // ══════════════════════════════════════════════════════
    document.getElementById('camera-scan-btn').addEventListener('click', openCameraScanner);
    document.getElementById('camera-scan-close-btn').addEventListener('click', closeCameraScanner);
    document.getElementById('camera-scan-stop-btn').addEventListener('click', closeCameraScanner);

    const cameraScanModal = document.getElementById('camera-scan-modal');
    cameraScanModal.addEventListener('click', (e) => {
        if (e.target === cameraScanModal) closeCameraScanner();
    });

    // ══════════════════════════════════════════════════════
    // 다중 검색 모달 (Shift + F)
    // ══════════════════════════════════════════════════════
    document.addEventListener('keydown', (e) => {
        if (!document.getElementById('dashboard-phase').classList.contains('active')) return;
        if (e.shiftKey && (e.key === 'f' || e.key === 'F')) {
            const tag = document.activeElement?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            e.preventDefault();
            e.stopPropagation();
            const modal = document.getElementById('multi-search-modal');
            if (modal.style.display === 'none' || modal.style.display === '') {
                openMultiSearchModal();
            } else {
                closeMultiSearchModal();
            }
        }
    });

    document.getElementById('multi-search-close-btn').addEventListener('click', closeMultiSearchModal);
    document.getElementById('multi-search-apply-btn').addEventListener('click', applyMultiSearch);
    document.getElementById('multi-search-reset-btn').addEventListener('click', resetMultiSearch);

    const multiSearchModal = document.getElementById('multi-search-modal');
    multiSearchModal.addEventListener('click', (e) => {
        if (e.target === multiSearchModal) closeMultiSearchModal();
    });

    // ══════════════════════════════════════════════════════
    // Escape 키 — 모달 닫기
    // ══════════════════════════════════════════════════════
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;

        const dupModal = document.getElementById('dup-scan-modal');
        if (dupModal && dupModal.style.display === 'flex') {
            _closeDupScanModal();
            return;
        }
        const multiModal = document.getElementById('multi-search-modal');
        if (multiModal && multiModal.style.display === 'flex') {
            closeMultiSearchModal();
            return;
        }
        const camModal = document.getElementById('camera-scan-modal');
        if (camModal && camModal.style.display === 'flex') {
            closeCameraScanner();
            return;
        }
        const restoreModal = document.getElementById('restore-modal');
        if (restoreModal && restoreModal.style.display === 'flex') {
            restoreModal.style.display = 'none';
            return;
        }
    });

    // ══════════════════════════════════════════════════════
    // Web Audio API: 첫 사용자 상호작용에서 AudioContext 초기화
    // (브라우저의 autoplay policy 대응)
    // ══════════════════════════════════════════════════════
    const initAudio = () => {
        getAudioContext();
        document.removeEventListener('click', initAudio);
        document.removeEventListener('keydown', initAudio);
    };
    document.addEventListener('click', initAudio);
    document.addEventListener('keydown', initAudio);
});
