/* ═══════════════════════════════════════════════════════════════════
   scoreboard.js — 전광판(Scoreboard) 뷰 렌더링

   구성 요소:
   · 반원 게이지 — 전체 진행률
   · 히트맵 그리드 — 구역별 타일 (4단계 색상)
   · 최근 활동 피드 — Firebase remoteProgress 기반
   · 단면도 모달 — 구역 클릭 시 상세 뷰 (Phase 3)
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

// ── 색상 상수 (4단계) ─────────────────────────────────────────
const SB_COLORS = {
    NOT_STARTED: { bg: '#6B7280', text: '#fff' },  // 0%   — 회색
    EARLY:       { bg: '#F59E0B', text: '#fff' },  // 1-49% — 주황
    LATE:        { bg: '#3B82F6', text: '#fff' },  // 50-99% — 파랑
    COMPLETE:    { bg: '#10B981', text: '#fff' },  // 100% — 초록
};

/** 진행률 → 4단계 색상 객체 */
function sbGetColor(pct) {
    if (pct <= 0)   return SB_COLORS.NOT_STARTED;
    if (pct < 50)   return SB_COLORS.EARLY;
    if (pct < 100)  return SB_COLORS.LATE;
    return SB_COLORS.COMPLETE;
}

// ── 구역 데이터 수집 ──────────────────────────────────────────

/**
 * AppState에서 구역별 진행률 데이터를 수집합니다.
 * @returns {{ zones: Array<{name, scanned, total, pct, assignee}>, totalScanned: number, totalItems: number }}
 */
function sbCollectZoneData() {
    const data = AppState.comparisonResult;
    if (!data || data.length === 0) {
        // 비교 데이터 없으면 remoteProgress만 사용
        return sbCollectFromRemote();
    }

    const zoneMap = {};
    const allRows = typeof filterActiveRows === 'function' ? filterActiveRows(data) : data;

    allRows.forEach(r => {
        const zone = r.warehouseZone;
        if (!zone) return;
        if (!zoneMap[zone]) zoneMap[zone] = { name: zone, scanned: 0, total: 0 };
        zoneMap[zone].total++;
        if (
            r.physicalQty > 0 ||
            (AppState.completedRows && AppState.completedRows.has(r._rowId)) ||
            r._touched ||
            r.status === 'MATCH' ||
            r.status === 'LOCATION_SHIFT'
        ) {
            zoneMap[zone].scanned++;
        }
    });

    // remoteProgress 병합 (원격에서 더 높은 수치가 있으면 적용)
    if (AppState.remoteProgress) {
        Object.entries(AppState.remoteProgress).forEach(([zone, info]) => {
            if (!zoneMap[zone]) {
                zoneMap[zone] = { name: zone, scanned: info.scanned || 0, total: info.total || 0 };
            } else {
                zoneMap[zone].scanned = Math.max(zoneMap[zone].scanned, info.scanned || 0);
                if (info.total) zoneMap[zone].total = Math.max(zoneMap[zone].total, info.total);
            }
        });
    }

    const zones = Object.values(zoneMap)
        .map(z => ({
            ...z,
            pct: z.total > 0 ? Math.round((z.scanned / z.total) * 100) : 0,
            assignee: AppState.zoneAssignees ? (AppState.zoneAssignees[z.name] || '') : '',
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

    const totalScanned = zones.reduce((s, z) => s + z.scanned, 0);
    const totalItems   = zones.reduce((s, z) => s + z.total, 0);

    return { zones, totalScanned, totalItems };
}

/** remoteProgress만으로 구역 데이터 수집 (비교 데이터 없을 때) */
function sbCollectFromRemote() {
    const rp = AppState.remoteProgress || {};
    const zones = Object.entries(rp)
        .map(([name, info]) => ({
            name,
            scanned: info.scanned || 0,
            total:   info.total || 0,
            pct:     info.total > 0 ? Math.round(((info.scanned || 0) / info.total) * 100) : 0,
            assignee: AppState.zoneAssignees ? (AppState.zoneAssignees[name] || '') : '',
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

    const totalScanned = zones.reduce((s, z) => s + z.scanned, 0);
    const totalItems   = zones.reduce((s, z) => s + z.total, 0);

    return { zones, totalScanned, totalItems };
}

// ── 메인 렌더 함수 ────────────────────────────────────────────

/** 전광판 전체를 렌더링합니다. switchView('scoreboard') 시 호출됩니다. */
function renderScoreboard() {
    const { zones, totalScanned, totalItems } = sbCollectZoneData();
    const overallPct = totalItems > 0 ? Math.round((totalScanned / totalItems) * 100) : 0;

    sbRenderGauge(overallPct);
    sbRenderStats(totalScanned, totalItems, zones);
    sbRenderHeatmap(zones);
    sbRenderFeed();
    sbCheckMilestone(overallPct);

    // 구역별 완료 축하 체크
    zones.forEach(z => sbCheckZoneComplete(z.name, z.pct));

    // 단면도 데이터 비동기 로드 (최초 1회)
    sbLoadFloorPlans().catch(() => {});
}

// ── 반원 게이지 ───────────────────────────────────────────────

/** @type {number|null} 이전 전체 진행률 (카운트업 애니메이션용) */
let _sbPrevPct = null;

function sbRenderGauge(pct) {
    const gaugeEl = document.getElementById('sb-gauge');
    const fillEl  = document.getElementById('sb-gauge-fill');
    const pctEl   = document.getElementById('sb-gauge-pct');
    if (!gaugeEl || !fillEl || !pctEl) return;

    // 반원 게이지: 180도 = 100%
    const deg = (pct / 100) * 180;
    const color = sbGetColor(pct);

    fillEl.style.background = `conic-gradient(
        ${color.bg} 0deg,
        ${color.bg} ${deg}deg,
        transparent ${deg}deg,
        transparent 180deg,
        transparent 180deg
    )`;

    // 카운트업 애니메이션
    const from = _sbPrevPct ?? 0;
    _sbPrevPct = pct;
    sbAnimateNumber(pctEl, from, pct, '%');
}

/** 숫자 카운트업 애니메이션 */
function sbAnimateNumber(el, from, to, suffix = '') {
    const duration = 600; // ms
    const start = performance.now();
    const diff = to - from;

    function tick(now) {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        // easeOutCubic
        const ease = 1 - Math.pow(1 - progress, 3);
        const current = Math.round(from + diff * ease);
        el.textContent = current.toLocaleString() + suffix;
        if (progress < 1) requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
}

// ── 요약 통계 ─────────────────────────────────────────────────

function sbRenderStats(scanned, total, zones) {
    const scannedEl    = document.getElementById('sb-scanned');
    const totalEl      = document.getElementById('sb-total-items');
    const zonesDoneEl  = document.getElementById('sb-zones-done');
    const zonesRemEl   = document.getElementById('sb-zones-remain');

    const zonesDone = zones.filter(z => z.pct >= 100).length;
    const zonesRemain = zones.length - zonesDone;

    if (scannedEl)   sbAnimateNumber(scannedEl, parseInt(scannedEl.textContent.replace(/,/g, '')) || 0, scanned);
    if (totalEl)     sbAnimateNumber(totalEl, parseInt(totalEl.textContent.replace(/,/g, '')) || 0, total);
    if (zonesDoneEl) sbAnimateNumber(zonesDoneEl, parseInt(zonesDoneEl.textContent) || 0, zonesDone);
    if (zonesRemEl)  sbAnimateNumber(zonesRemEl, parseInt(zonesRemEl.textContent) || 0, zonesRemain);
}

// ── 히트맵 그리드 ─────────────────────────────────────────────

function sbRenderHeatmap(zones) {
    const grid = document.getElementById('sb-heatmap');
    if (!grid) return;

    if (zones.length === 0) {
        grid.innerHTML = '<div class="sb-heatmap-empty"><i class="fas fa-inbox"></i><p>데이터를 불러오면 구역 현황이 표시됩니다.</p></div>';
        return;
    }

    const html = zones.map((z, i) => {
        const color = sbGetColor(z.pct);
        const assigneeHtml = z.assignee
            ? `<span class="sb-tile-assignee"><i class="fas fa-user"></i> ${esc(z.assignee)}</span>`
            : '';
        const completeBadge = z.pct >= 100
            ? '<span class="sb-tile-complete"><i class="fas fa-check-circle"></i></span>'
            : '';

        return `<div class="sb-tile" data-zone="${esc(z.name)}" style="background:${color.bg};color:${color.text};animation-delay:${i * 50}ms" onclick="sbOpenFloorPlan('${esc(z.name)}')">
            ${completeBadge}
            <div class="sb-tile-name">${esc(z.name)}</div>
            <div class="sb-tile-pct">${z.pct}%</div>
            <div class="sb-tile-bar">
                <div class="sb-tile-bar-fill" style="width:${z.pct}%;background:rgba(255,255,255,0.35)"></div>
            </div>
            <div class="sb-tile-detail">${z.scanned.toLocaleString()} / ${z.total.toLocaleString()}</div>
            ${assigneeHtml}
        </div>`;
    }).join('');

    grid.innerHTML = html;
}

// ── 최근 활동 피드 ────────────────────────────────────────────

function sbRenderFeed() {
    const feedEl = document.getElementById('sb-feed');
    if (!feedEl) return;

    // remoteProgress에서 최근 활동 수집
    const activities = [];
    const rp = AppState.remoteProgress || {};

    Object.entries(rp).forEach(([zone, info]) => {
        if (info.updatedBy && info.updatedBy !== '_self') {
            activities.push({
                user: info.updatedBy,
                zone: zone,
                scanned: info.scanned || 0,
                total: info.total || 0,
                pct: info.total > 0 ? Math.round(((info.scanned || 0) / info.total) * 100) : 0,
                timestamp: info.updatedAt || null,
            });
        }
    });

    // recentActivity 배열이 있으면 병합
    if (AppState.recentActivity && AppState.recentActivity.length > 0) {
        AppState.recentActivity.forEach(a => {
            if (!activities.find(x => x.user === a.user && x.zone === a.zone)) {
                activities.push(a);
            }
        });
    }

    if (activities.length === 0) {
        feedEl.innerHTML = '<div class="sb-feed-empty"><i class="fas fa-satellite-dish"></i> 실시간 활동을 기다리는 중...</div>';
        return;
    }

    // 타임스탬프 역순 정렬 (최신 먼저)
    activities.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const html = activities.slice(0, 10).map(a => {
        const color = sbGetColor(a.pct || 0);
        const icon = (a.pct || 0) >= 100 ? 'fa-check-circle' : 'fa-spinner fa-pulse';
        const timeStr = a.timestamp ? sbRelativeTime(a.timestamp) : '';
        return `<div class="sb-feed-item">
            <span class="sb-feed-dot" style="background:${color.bg}"></span>
            <span class="sb-feed-user">${esc(a.user)}</span>
            <span class="sb-feed-arrow">→</span>
            <span class="sb-feed-zone">${esc(a.zone)}</span>
            <span class="sb-feed-status"><i class="fas ${icon}"></i> ${a.pct || 0}%</span>
            ${timeStr ? `<span class="sb-feed-time">${timeStr}</span>` : ''}
        </div>`;
    }).join('');

    feedEl.innerHTML = html;
}

/** 타임스탬프 → "3분 전" 형태의 상대 시간 */
function sbRelativeTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return '방금 전';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}분 전`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}시간 전`;
    return `${Math.floor(diff / 86400000)}일 전`;
}

// ── 마일스톤 축하 ─────────────────────────────────────────────

/** @type {Set<number>} 이미 축하한 마일스톤 */
const _sbCelebratedMilestones = new Set();

function sbCheckMilestone(pct) {
    const milestones = [25, 50, 75, 100];
    milestones.forEach(m => {
        if (pct >= m && !_sbCelebratedMilestones.has(m)) {
            _sbCelebratedMilestones.add(m);
            sbShowToast(m);
        }
    });
}

function sbShowToast(milestone) {
    const messages = {
        25:  '25% 돌파! 순조로운 출발입니다 🚀',
        50:  '절반 완료! 반환점을 돌았습니다 🎯',
        75:  '75% 달성! 거의 다 왔습니다 💪',
        100: '전체 완료! 수고하셨습니다 🎉',
    };

    const toast = document.createElement('div');
    toast.className = 'sb-toast';
    toast.innerHTML = `<i class="fas fa-trophy"></i> ${messages[milestone] || milestone + '% 달성!'}`;
    document.body.appendChild(toast);

    // 입장 애니메이션
    requestAnimationFrame(() => toast.classList.add('sb-toast-show'));

    // 4초 후 제거
    setTimeout(() => {
        toast.classList.remove('sb-toast-show');
        setTimeout(() => toast.remove(), 400);
    }, 4000);
}

// ── 구역 완료 축하 이펙트 ─────────────────────────────────────

/** @type {Set<string>} 이미 축하한 구역 */
const _sbCelebratedZones = new Set();

function sbCheckZoneComplete(zoneName, pct) {
    if (pct >= 100 && !_sbCelebratedZones.has(zoneName)) {
        _sbCelebratedZones.add(zoneName);
        const tile = document.querySelector(`.sb-tile[data-zone="${zoneName}"]`);
        if (tile) {
            tile.classList.add('sb-tile-celebrate');
            sbSpawnConfetti(tile);
            setTimeout(() => tile.classList.remove('sb-tile-celebrate'), 1500);
        }
    }
}

/** 타일 내부에 간단한 confetti 파티클을 생성합니다 */
function sbSpawnConfetti(tile) {
    const wrap = document.createElement('div');
    wrap.className = 'sb-confetti-wrap';
    tile.appendChild(wrap);

    const colors = ['#fbbf24', '#f87171', '#34d399', '#60a5fa', '#a78bfa', '#fb923c'];
    for (let i = 0; i < 12; i++) {
        const p = document.createElement('div');
        p.className = 'sb-confetti';
        p.style.left = Math.random() * 100 + '%';
        p.style.background = colors[Math.floor(Math.random() * colors.length)];
        p.style.animationDelay = (Math.random() * 0.4) + 's';
        p.style.animationDuration = (0.8 + Math.random() * 0.6) + 's';
        wrap.appendChild(p);
    }

    setTimeout(() => wrap.remove(), 2000);
}

// ── 단면도 모달 (Phase 3에서 확장) ─────────────────────────────

/**
 * 구역명(예: "02-04")을 단면도 키(예: "S204")로 변환합니다.
 * 매핑: 02-06→S206, 02-02→S202, 02-04→S204, B2-04→B204
 */
const SB_ZONE_TO_PLAN_KEY = {
    '02-06': 'S206',
    '02-02': 'S202',
    '02-04': 'S204',
    'B2-04': 'B204',
};

function sbOpenFloorPlan(zoneName) {
    const modal   = document.getElementById('sb-floorplan-modal');
    const titleEl = document.getElementById('sb-floorplan-title');
    const bodyEl  = document.getElementById('sb-floorplan-body');
    if (!modal || !bodyEl) return;

    if (titleEl) titleEl.textContent = `${zoneName} 상세`;
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // 구역명 → 단면도 키 매핑 후 조회
    const planKey = SB_ZONE_TO_PLAN_KEY[zoneName] || zoneName;
    const floorPlan = AppState.floorPlans && (AppState.floorPlans[planKey] || AppState.floorPlans[zoneName]);

    if (floorPlan && floorPlan.length > 0) {
        sbRenderFloorPlanGrid(bodyEl, zoneName, floorPlan);
    } else {
        sbRenderLocationList(bodyEl, zoneName);
    }
}

function sbCloseFloorPlan() {
    const modal = document.getElementById('sb-floorplan-modal');
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = '';
}

/**
 * 행이 실제로 스캔/처리 완료되었는지 판정합니다.
 * MATCH 상태이더라도 EMP=0 & 실사=0인 항목은 미스캔으로 봅니다.
 */
function sbIsRowScanned(r) {
    if (r.physicalQty > 0) return true;
    if (AppState.completedRows && AppState.completedRows.has(r._rowId)) return true;
    if (r._touched) return true;
    // MATCH인데 실사 수량이 0보다 큰 경우만 완료 (EMP=0, 실사=0은 미스캔)
    if (r.status === 'MATCH' && (r.empQty > 0 || r.physicalQty > 0)) return true;
    if (r.status === 'LOCATION_SHIFT') return true;
    return false;
}

/** 단면도 없는 구역: 로케이션 목록 그리드 */
function sbRenderLocationList(bodyEl, zoneName) {
    const data = AppState.comparisonResult || [];
    const rows = data.filter(r => r.warehouseZone === zoneName);

    if (rows.length === 0) {
        bodyEl.innerHTML = '<div class="sb-fp-empty"><i class="fas fa-map-marker-alt"></i><p>해당 구역의 로케이션 데이터가 없습니다.</p></div>';
        return;
    }

    // 로케이션별로 그룹화 (같은 로케이션에 여러 SKU가 있을 수 있음)
    const locMap = {};
    rows.forEach(r => {
        const loc = r.location || r.empLocation || '?';
        if (!locMap[loc]) locMap[loc] = { total: 0, scanned: 0 };
        locMap[loc].total++;
        if (sbIsRowScanned(r)) locMap[loc].scanned++;
    });

    const locEntries = Object.entries(locMap).sort((a, b) => a[0].localeCompare(b[0]));
    const totalItems = locEntries.reduce((s, [, v]) => s + v.total, 0);
    const doneItems = locEntries.reduce((s, [, v]) => s + v.scanned, 0);
    const pct = totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 0;

    let html = `<div class="sb-fp-summary">
        <span class="sb-fp-badge" style="background:${sbGetColor(pct).bg}">${pct}%</span>
        <span>${doneItems} / ${totalItems}건 완료</span>
        <span class="sb-fp-no-plan"><i class="fas fa-info-circle"></i> 단면도 미등록</span>
    </div>`;

    html += '<div class="sb-fp-loc-grid">';
    locEntries.forEach(([loc, info]) => {
        const allDone = info.scanned >= info.total;
        const partial = info.scanned > 0 && !allDone;
        const cls = allDone ? 'sb-fp-loc done' : (partial ? 'sb-fp-loc partial' : 'sb-fp-loc');
        const label = info.total > 1 ? `${esc(loc)} (${info.scanned}/${info.total})` : esc(loc);
        html += `<div class="${cls}">${label}</div>`;
    });
    html += '</div>';

    bodyEl.innerHTML = html;
}

/** 단면도 있는 구역: 컴팩트 랙 카드 레이아웃 */
function sbRenderFloorPlanGrid(bodyEl, zoneName, floorPlan) {
    // ── 1. CSV에서 유효한 셀(랙 코드) 추출 ─────────────────────
    const metaPatterns = ['KPOPMERCH', '구역:', '담당자:', 'Warehouse Layout', '참고사항', '예시)'];
    const labelPatterns = ['출입문', '작업대', '베란다', '작', '업', '대'];
    // 구역 코드 자체 (S206, S202, S204, B204) 제거
    const zoneCodePatterns = Object.values(SB_FLOOR_PLAN_GIDS).length > 0
        ? Object.keys(SB_FLOOR_PLAN_GIDS) : [];
    // planKey도 제거
    const planKey = SB_ZONE_TO_PLAN_KEY[zoneName] || zoneName;

    const rackCodes = new Set();
    const labelCodes = new Set();

    floorPlan.forEach(row => {
        row.forEach(c => {
            const v = (c || '').trim();
            if (!v) return;
            if (metaPatterns.some(p => v.includes(p))) return;
            if (labelPatterns.includes(v)) { labelCodes.add(v); return; }
            // 구역 코드 자체(S206, S202 등)와 planKey 제거
            if (zoneCodePatterns.includes(v) || v === planKey) return;
            rackCodes.add(v);
        });
    });

    if (rackCodes.size === 0) {
        sbRenderLocationList(bodyEl, zoneName);
        return;
    }

    // ── 2. 로케이션 스캔 상태 맵 ──────────────────────────────
    const data = AppState.comparisonResult || [];
    const zoneRows = data.filter(r => r.warehouseZone === zoneName);

    const locStatusMap = {};
    zoneRows.forEach(r => {
        const loc = r.location || r.empLocation || '';
        if (!loc) return;
        if (!locStatusMap[loc]) locStatusMap[loc] = { scanned: 0, total: 0 };
        locStatusMap[loc].total++;
        if (sbIsRowScanned(r)) locStatusMap[loc].scanned++;
    });

    // ── 3. 랙별 진행률 계산 ────────────────────────────────────
    const racks = [];
    rackCodes.forEach(code => {
        // 매칭: zoneName-code 로 시작하는 로케이션
        const prefix = `${zoneName}-${code}`;
        const matched = Object.keys(locStatusMap).filter(loc =>
            loc.startsWith(prefix) || loc === code
        );
        const total   = matched.reduce((s, l) => s + (locStatusMap[l]?.total || 0), 0);
        const scanned = matched.reduce((s, l) => s + (locStatusMap[l]?.scanned || 0), 0);
        const pct = total > 0 ? Math.round((scanned / total) * 100) : -1; // -1 = 매칭 없음
        racks.push({ code, total, scanned, pct });
    });

    // ── 4. 접두사별 그룹핑 ─────────────────────────────────────
    function getGroupKey(code) {
        // HP-A1 → "HP", LZ-00 → "L", B7 → "B", C3 → "C", W1-00 → "W", etc.
        if (code.startsWith('HP-')) return 'HP';
        if (code.startsWith('BW') || code.startsWith('BZ')) return 'BW/BZ';
        // 첫 알파벳 그룹
        const m = code.match(/^([A-Z]+)/);
        return m ? m[1] : '기타';
    }

    const groups = {};
    racks.forEach(r => {
        const key = getGroupKey(r.code);
        if (!groups[key]) groups[key] = [];
        groups[key].push(r);
    });

    // 그룹 내 정렬
    Object.values(groups).forEach(arr => arr.sort((a, b) => a.code.localeCompare(b.code)));

    // 그룹 키 정렬 (알파벳)
    const groupKeys = Object.keys(groups).sort();

    // ── 5. 전체 통계 ──────────────────────────────────────────
    const totalItems   = racks.reduce((s, r) => s + r.total, 0);
    const scannedItems = racks.reduce((s, r) => s + r.scanned, 0);
    const overallPct   = totalItems > 0 ? Math.round((scannedItems / totalItems) * 100) : 0;

    // ── 6. HTML 렌더링 ────────────────────────────────────────
    // 단면도 이미지 (planKey로 매핑)
    const imgSrc = SB_FLOOR_PLAN_IMAGES[planKey] || null;
    let html = '';

    if (imgSrc) {
        html += `<div class="sb-fp-image-wrap">
            <div class="sb-fp-image-label">
                <span><i class="fas fa-map"></i> 창고 단면도</span>
                <a class="sb-fp-newtab-btn" href="${imgSrc}" target="_blank" title="새 탭에서 열기">
                    <i class="fas fa-external-link-alt"></i> 새 탭에서 열기
                </a>
            </div>
            <img class="sb-fp-image" src="${imgSrc}" alt="${esc(planKey)} 단면도"
                 onclick="sbOpenLightbox(this)" title="클릭하여 전체화면 확대">
            <div class="sb-fp-image-hint"><i class="fas fa-expand-arrows-alt"></i> 클릭하여 전체화면 확대</div>
        </div>`;
    }

    html += `<div class="sb-fp-summary">
        <span class="sb-fp-badge" style="background:${sbGetColor(overallPct).bg}">${overallPct}%</span>
        <span>${scannedItems} / ${totalItems}건 완료</span>
        <span class="sb-fp-plan-label"><i class="fas fa-warehouse"></i> ${racks.length}개 랙</span>
    </div>`;

    groupKeys.forEach(key => {
        const groupRacks = groups[key];
        html += `<div class="sb-rack-group">
            <div class="sb-rack-group-title">${esc(key)} 시리즈 <span class="sb-rack-group-count">${groupRacks.length}</span></div>
            <div class="sb-rack-cards">`;

        groupRacks.forEach(r => {
            const color = r.pct < 0 ? SB_COLORS.NOT_STARTED : sbGetColor(r.pct);
            const pctText = r.pct < 0 ? '-' : r.pct + '%';
            const barWidth = r.pct < 0 ? 0 : r.pct;
            const statusCls = r.pct >= 100 ? ' rack-done' : (r.pct > 0 ? ' rack-active' : '');

            html += `<div class="sb-rack-card${statusCls}">
                <div class="sb-rack-name">${esc(r.code)}</div>
                <div class="sb-rack-bar"><div class="sb-rack-bar-fill" style="width:${barWidth}%;background:${color.bg}"></div></div>
                <div class="sb-rack-info">
                    <span class="sb-rack-pct" style="color:${color.bg}">${pctText}</span>
                    <span class="sb-rack-count">${r.scanned}/${r.total}</span>
                </div>
            </div>`;
        });

        html += '</div></div>';
    });

    // 라벨(출입문, 작업대 등)이 있으면 하단에 표시
    if (labelCodes.size > 0) {
        const labels = [...labelCodes].filter(l => !['작', '업', '대'].includes(l));
        if (labels.length > 0) {
            html += `<div class="sb-rack-labels">`;
            labels.forEach(l => {
                html += `<span class="sb-rack-label"><i class="fas fa-door-open"></i> ${esc(l)}</span>`;
            });
            html += '</div>';
        }
    }

    bodyEl.innerHTML = html;
}

/** 단면도 이미지 확대/축소 토글 */
// ── 라이트박스 (전체화면 이미지 뷰어) ────────────────────────
let _lbSrc = '';
let _lbScale = 1;
let _lbOffX = 0;
let _lbOffY = 0;
let _lbDragging = false;
let _lbDragStartX = 0;
let _lbDragStartY = 0;
let _lbLastDist = 0;

/** 라이트박스 열기 */
function sbOpenLightbox(imgEl) {
    _lbSrc = imgEl.src;
    _lbScale = 1;
    _lbOffX = 0;
    _lbOffY = 0;

    // 라이트박스 DOM 최초 생성
    let lb = document.getElementById('sb-lightbox');
    if (!lb) {
        lb = document.createElement('div');
        lb.id = 'sb-lightbox';
        lb.className = 'sb-lightbox';
        lb.innerHTML = `
            <div class="sb-lb-backdrop" onclick="sbCloseLightbox()"></div>
            <div class="sb-lb-toolbar">
                <span class="sb-lb-hint">
                    <i class="fas fa-mouse"></i> 휠: 확대/축소 &nbsp;·&nbsp;
                    <i class="fas fa-arrows-alt"></i> 드래그: 이동
                </span>
                <button class="sb-lb-newtab" onclick="sbLightboxNewTab()">
                    <i class="fas fa-external-link-alt"></i> 새 탭에서 열기
                </button>
                <button class="sb-lb-close" onclick="sbCloseLightbox()">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="sb-lb-stage" id="sb-lb-stage">
                <img class="sb-lb-img" id="sb-lb-img" draggable="false" alt="단면도">
            </div>
            <div class="sb-lb-zoom-bar">
                <button onclick="sbLbZoom(-0.2)"><i class="fas fa-minus"></i></button>
                <span id="sb-lb-zoom-label">100%</span>
                <button onclick="sbLbZoom(0.2)"><i class="fas fa-plus"></i></button>
                <button onclick="sbLbReset()" title="초기화"><i class="fas fa-compress-arrows-alt"></i></button>
            </div>`;
        document.body.appendChild(lb);

        const stage = document.getElementById('sb-lb-stage');

        // 마우스 휠 줌
        stage.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.12 : 0.88;
            _lbScale = Math.min(Math.max(_lbScale * factor, 0.3), 10);
            sbLbApplyTransform();
        }, { passive: false });

        // 마우스 드래그 패닝
        stage.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            _lbDragging = true;
            _lbDragStartX = e.clientX - _lbOffX;
            _lbDragStartY = e.clientY - _lbOffY;
            stage.style.cursor = 'grabbing';
        });
        window.addEventListener('mousemove', (e) => {
            if (!_lbDragging) return;
            _lbOffX = e.clientX - _lbDragStartX;
            _lbOffY = e.clientY - _lbDragStartY;
            sbLbApplyTransform();
        });
        window.addEventListener('mouseup', () => {
            _lbDragging = false;
            const s = document.getElementById('sb-lb-stage');
            if (s) s.style.cursor = 'grab';
        });

        // 터치: 핀치줌 + 드래그
        stage.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                _lbLastDist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
            } else if (e.touches.length === 1) {
                _lbDragging = true;
                _lbDragStartX = e.touches[0].clientX - _lbOffX;
                _lbDragStartY = e.touches[0].clientY - _lbOffY;
            }
        }, { passive: true });
        stage.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (e.touches.length === 2) {
                const dist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                if (_lbLastDist > 0) {
                    _lbScale = Math.min(Math.max(_lbScale * (dist / _lbLastDist), 0.3), 10);
                    sbLbApplyTransform();
                }
                _lbLastDist = dist;
            } else if (e.touches.length === 1 && _lbDragging) {
                _lbOffX = e.touches[0].clientX - _lbDragStartX;
                _lbOffY = e.touches[0].clientY - _lbDragStartY;
                sbLbApplyTransform();
            }
        }, { passive: false });
        stage.addEventListener('touchend', () => {
            _lbDragging = false;
            _lbLastDist = 0;
        });
    }

    // 이미지 세팅 후 표시
    const img = document.getElementById('sb-lb-img');
    img.src = _lbSrc;
    lb.classList.add('sb-lightbox-active');
    document.body.style.overflow = 'hidden';
    sbLbApplyTransform();

    // ESC 닫기
    window._sbLbKeyHandler = (e) => { if (e.key === 'Escape') sbCloseLightbox(); };
    document.addEventListener('keydown', window._sbLbKeyHandler);
}

/** 라이트박스 닫기 */
function sbCloseLightbox() {
    const lb = document.getElementById('sb-lightbox');
    if (lb) lb.classList.remove('sb-lightbox-active');
    document.body.style.overflow = '';
    document.removeEventListener('keydown', window._sbLbKeyHandler);
}

/** 새 탭에서 열기 */
function sbLightboxNewTab() {
    if (_lbSrc) window.open(_lbSrc, '_blank');
}

/** 줌 버튼 */
function sbLbZoom(delta) {
    _lbScale = Math.min(Math.max(_lbScale + delta, 0.3), 10);
    sbLbApplyTransform();
}

/** 초기화 */
function sbLbReset() {
    _lbScale = 1;
    _lbOffX = 0;
    _lbOffY = 0;
    sbLbApplyTransform();
}

/** transform 적용 */
function sbLbApplyTransform() {
    const img = document.getElementById('sb-lb-img');
    if (img) {
        img.style.transform = `translate(${_lbOffX}px, ${_lbOffY}px) scale(${_lbScale})`;
    }
    const label = document.getElementById('sb-lb-zoom-label');
    if (label) label.textContent = Math.round(_lbScale * 100) + '%';
}

// ── Google Sheets 단면도 로딩 ──────────────────────────────

/**
 * Google Sheets에서 4개 창고 단면도 CSV를 로드하여 AppState.floorPlans에 캐싱합니다.
 * 시트 ID: 1u_Y6h16cku_LxP5VCBL78rkGYgjXdL7E6YIj_LYcnfE
 */
const SB_SHEET_ID = '1MANQF1O7aqaDbFp6xGWccCzuWp7MHDjgUE_cqO-dIXM';

/** 창고별 단면도 이미지 경로 */
const SB_FLOOR_PLAN_IMAGES = {
    'S206': 'images/단면도 - S206_page-0001.jpg',
    'S202': 'images/단면도 - S202.jpg',
    'S204': 'images/단면도 - S204_page-0001.jpg',
    'B204': 'images/단면도 - B204.jpg',
};

const SB_FLOOR_PLAN_GIDS = {
    'S206': 944880178,
    'S202': 1910636165,
    'S204': 1927594626,
    'B204': 1224066942,
};

/** 모든 단면도 CSV를 병렬 로드 */
async function sbLoadFloorPlans() {
    if (Object.keys(AppState.floorPlans || {}).length > 0) return; // 이미 로딩됨

    // localStorage 캐시 확인 (시트 ID 포함 키로 구버전 캐시 무효화)
    const cacheKey = `sb_floorplans_${SB_SHEET_ID}`;
    try {
        // 구버전 캐시 삭제
        localStorage.removeItem('sb_floorplans');
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
            const parsed = JSON.parse(cached);
            if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
                AppState.floorPlans = parsed;
                console.log('[Scoreboard] 단면도 캐시에서 로드:', Object.keys(parsed).join(', '));
                return;
            }
        }
    } catch (e) { /* 캐시 무시 */ }

    const results = {};

    await Promise.allSettled(
        Object.entries(SB_FLOOR_PLAN_GIDS).map(async ([zone, gid]) => {
            try {
                const url = `https://docs.google.com/spreadsheets/d/${SB_SHEET_ID}/export?format=csv&gid=${gid}`;
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const csv = await res.text();
                results[zone] = sbParseCsv(csv);
                console.log(`[Scoreboard] 단면도 로드: ${zone} (${results[zone].length}행)`);
            } catch (e) {
                console.warn(`[Scoreboard] 단면도 로드 실패: ${zone}`, e.message);
            }
        })
    );

    AppState.floorPlans = results;

    // localStorage에 캐싱
    try {
        localStorage.setItem(cacheKey, JSON.stringify(results));
    } catch (e) { /* 용량 초과 시 무시 */ }
}

/** 간단한 CSV 파서 (쉼표 구분, 따옴표 지원) */
function sbParseCsv(csv) {
    const rows = [];
    const lines = csv.split('\n');

    for (const line of lines) {
        if (!line.trim()) continue;
        const cells = [];
        let current = '';
        let inQuote = false;

        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (inQuote) {
                if (ch === '"' && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else if (ch === '"') {
                    inQuote = false;
                } else {
                    current += ch;
                }
            } else {
                if (ch === '"') {
                    inQuote = true;
                } else if (ch === ',') {
                    cells.push(current.trim());
                    current = '';
                } else {
                    current += ch;
                }
            }
        }
        cells.push(current.trim());
        rows.push(cells);
    }

    return rows;
}

// ── 이벤트 바인딩 ─────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    // 모달 닫기
    const closeBtn = document.getElementById('sb-floorplan-close');
    if (closeBtn) closeBtn.addEventListener('click', sbCloseFloorPlan);

    const overlay = document.querySelector('.sb-floorplan-overlay');
    if (overlay) overlay.addEventListener('click', sbCloseFloorPlan);

    // ESC 키로 모달 닫기
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') sbCloseFloorPlan();
    });
});

// ── remoteProgress 변경 시 자동 갱신 ──────────────────────────

if (typeof subscribeState === 'function') {
    subscribeState('remoteProgress', () => {
        if (AppState.currentView === 'scoreboard') {
            renderScoreboard();
        }
    });
}
