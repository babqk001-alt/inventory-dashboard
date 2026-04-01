/* ═══════════════════════════════════════════════════════════════════
   constants.js — 전역 상수 및 설정값 (Phase 1 + Phase 2)

   Phase 1 [보안]: Firebase 설정을 소스 전체에서 분리하여 단일 파일로 관리.
                   향후 서버사이드 환경 변수 주입 시 이 파일만 수정.
   Phase 2 [품질]: 중복 정의된 역할 라벨, DB 경로 등을 단일 출처로 통합.
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

// ── Firebase 설정 [Phase 1: 하드코딩 분리] ─────────────────────────
// ⚠️  실제 보안은 Firebase Security Rules + Auth에서 담보.
//     API Key 자체는 공개 식별자이므로 여기 유지해도 무방하나,
//     Security Rules를 반드시 역할 기반으로 설정해야 함.
const FIREBASE_CONFIG = {
    apiKey:            "AIzaSyD4EAPFji_JZPbHf7WhbjPKfG3ww35lBfk",
    authDomain:        "inventory-dashboard-a72fe.firebaseapp.com",
    databaseURL:       "https://inventory-dashboard-a72fe-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId:         "inventory-dashboard-a72fe",
    storageBucket:     "inventory-dashboard-a72fe.firebasestorage.app",
    messagingSenderId: "185365141180",
    appId:             "1:185365141180:web:948577e0ca2e68b4dce2b9"
};

// ── Firebase DB 경로 [Phase 2: 중복 경로 문자열 단일화] ──────────────
const DB_PATH = {
    users:    uid  => `users/${uid}`,
    sessions: sid  => `sessions/${sid}`,
    rows:     sid  => `sessions/${sid}/rows`,
    rowItem:  (sid, fbKey) => `sessions/${sid}/rows/${fbKey}`,
    locks:    sid  => `sessions/${sid}/locks`,
    lockItem: (sid, fbKey) => `sessions/${sid}/locks/${fbKey}`,
    done:     sid  => `sessions/${sid}/done`,
    doneItem: (sid, fbKey) => `sessions/${sid}/done/${fbKey}`,
    meta:     sid  => `sessions/${sid}/meta`,
    presence: (sid, uid) => `sessions/${sid}/presence/${uid}`,
    userRole: uid  => `users/${uid}/role`,
};

// ── 역할 라벨 [Phase 2: auth.js 내 3중 정의 → 단일화] ───────────────
const ROLE_LABELS = {
    admin:    '관리자',
    teamlead: '팀장',
    worker:   '작업자',
};

// ── 에러 메시지 [Phase 2: 공통 에러 메시지 관리] ─────────────────────
const ERROR_MESSAGES = {
    LOGIN_INVALID:   '이메일 또는 비밀번호가 올바르지 않습니다.',
    LOGIN_TOO_MANY:  '너무 많은 시도. 잠시 후 다시 시도하세요.',
    LOGIN_BAD_EMAIL: '유효하지 않은 이메일 형식입니다.',
    LOGIN_DISABLED:  '비활성화된 계정입니다. 관리자에게 문의하세요.',
    LOGIN_GENERIC:   '로그인 실패. 이메일/비밀번호를 확인하세요.',
    FB_WRITE_FAIL:   'Firebase 쓰기 권한 오류 — 보안 규칙을 확인하세요.',
    FB_INIT_FAIL:    'Firebase 초기화 실패',
    NO_DATA:         '내보낼 데이터가 없습니다.',
    NO_COMPARISON:   '먼저 비교를 실행하세요.',
};

// ── 표준 필드 키 / 레이블 ─────────────────────────────────────────
const REQUIRED_FIELDS = ['sku', 'barcode', 'name', 'qty', 'location'];
const FIELD_LABELS    = { sku: 'SKU', barcode: '바코드', name: '상품명', qty: '수량', location: '위치' };

// ── 조정 사유 옵션 ────────────────────────────────────────────────
const REASON_OPTIONS = [
    { value: '',          label: '선택안함'   },
    { value: '파손폐기',  label: '파손폐기'   },
    { value: '샘플출고',  label: '샘플출고'   },
    { value: '로케이션오류', label: '로케이션오류' },
    { value: '바코드오류',   label: '바코드오류'   },
    { value: '기타',      label: '기타'       },
];

// ── 스토리지 키 ───────────────────────────────────────────────────
const LS_KEY              = 'inventory_dashboard_autosave';
const THEME_KEY           = 'inventory_theme';
const ASSIGNEE_STORAGE_KEY = 'inventory_assignee_v1';

// ── Google Apps Script 웹앱 URL (구글 드라이브 전송용) ───────────────
const GAS_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbwBuPWy1zl46VXxf0cQUuyJsrpMims4drTExYdvOx7H5cBDgsArEd8u-_QCHIR92mqvjQ/exec";

// ── 구글 스프레드시트 CSV URL ─────────────────────────────────────
const GSHEET_CSV_URL      = 'https://docs.google.com/spreadsheets/d/1PPXbowiJMOwLLeQauUx7lF6rSOi_xmkc/export?format=csv&gid=928606008';
const GSHEET_PHYSICAL_URL = 'https://docs.google.com/spreadsheets/d/1PPXbowiJMOwLLeQauUx7lF6rSOi_xmkc/export?format=csv&gid=1117808392';

// ── 컬럼 자동 매핑 패턴 [Phase 2: guessColumn 중복 패턴 통합] ─────────
const COLUMN_GUESS_PATTERNS = {
    sku:      [/상품코드/i, /sku/i, /품번/i, /product.?code/i, /item.?code/i],
    barcode:  [/바코드/i, /barcode/i, /bar.?code/i, /upc/i, /ean/i],
    name:     [/상품명/i, /name/i, /product.?name/i, /item.?name/i, /제품명/i, /품명/i, /설명/i, /아티스트/i],
    qty:      [/수량/i, /qty/i, /quantity/i, /재고/i, /count/i, /stock/i],
    location: [/로케이션/i, /location/i, /위치/i, /loc/i, /zone/i, /창고/i, /구역/i, /shelf/i, /bin/i],
};
