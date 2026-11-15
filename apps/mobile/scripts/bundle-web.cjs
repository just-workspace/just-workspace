/**
 * 번들 빌드용 웹 산출물 — React 판(frontend-react)을 이 워크스페이스 주소로 빌드해 www-react/ 에 둔다.
 *
 * 번들 모드는 앱 안에 SPA 를 넣고 API 만 서버로 보낸다(VITE_API_BASE = 사이트 주소, Bearer 토큰).
 * 기본(원격) 모드는 서버 웹을 그대로 여므로 이 단계가 없다 — builder-build.sh 가 JW_WEB_BUNDLE=1 일 때만 부른다.
 *
 *   WS_URL       워크스페이스 주소(필수) → VITE_API_BASE
 *   APP_NAME     앱 이름 → 빌드 브랜딩(런타임은 /api/health 가 덮는다)
 *   JW_WEB_SRC   frontend-react 소스 위치(기본: ../../frontend-react — 리포 그대로일 때)
 *   JW_WEB_OUT   산출물 위치(기본: www-react). capacitor.config.ts 의 webDir 이 JW_WEB_DIR 로 이걸 가리킨다.
 *
 * 확인하는 것: index.html 이 있다 / 서비스워커가 없다(vite.config 가 apiBase 있으면 PWA 를 끈다 —
 * 옛 SW 가 구번들을 precache 해 앱 업데이트가 안 먹는 사고 방지).
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const src = path.resolve(root, process.env.JW_WEB_SRC || '../../frontend-react');
const out = path.resolve(root, process.env.JW_WEB_OUT || 'www-react');
const raw = (process.env.WS_URL || '').trim();
if (!raw) { console.error('WS_URL 이 필요하다'); process.exit(1); }
let apiBase;
try { apiBase = new URL(raw).origin; } catch { console.error(`WS_URL 이 URL 이 아니다: ${raw}`); process.exit(1); }
if (!fs.existsSync(path.join(src, 'package.json'))) { console.error(`frontend-react 소스가 없다: ${src}`); process.exit(1); }

const env = { ...process.env, VITE_API_BASE: apiBase, APP_NAME: process.env.APP_NAME || 'Just Workspace' };
const run = (cmd) => execSync(cmd, { cwd: src, env, stdio: 'inherit' });

if (!fs.existsSync(path.join(src, 'node_modules'))) {
  console.log('[web] npm ci...');
  run('npm ci --no-audit --no-fund');
}
console.log(`[web] frontend-react 빌드 (VITE_API_BASE=${apiBase}) → ${out}`);
run(`npx vite build --outDir "${out}" --emptyOutDir`);

if (!fs.existsSync(path.join(out, 'index.html'))) { console.error('index.html 이 안 나왔다'); process.exit(1); }
const sw = ['sw.js', 'registerSW.js', 'manifest.webmanifest'].filter((f) => fs.existsSync(path.join(out, f)));
if (sw.length) { console.error(`번들에 서비스워커 파일이 있다(${sw.join(', ')}) — VITE_API_BASE 가 안 먹었다`); process.exit(1); }
console.log('[web] OK');
