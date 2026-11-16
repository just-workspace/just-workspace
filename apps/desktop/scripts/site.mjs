/**
 * 사이트 설정을 dist/site.json 으로 생성한다.
 *
 * 데스크톱 앱은 워크스페이스 하나에 종속된다. 접속할 서버는 빌드 시 결정하며
 * (JW_SERVER_URL), 앱 ID·이름도 사이트별로 상이해야 동일 PC 에 두 앱을 병행 설치할 수 있다.
 * 런타임(src/main/config.ts)과 패키징(electron-builder.config.cjs)이 이 파일 하나를 읽는다.
 *
 *   JW_SERVER_URL    워크스페이스 주소 (https://ws.example.com). --require 면 필수
 *   JW_APP_ID        기본: 호스트를 역순으로 배열하고 .just-workspace 를 덧붙인다 (ws.example.com → com.example.ws.just-workspace)
 *   JW_PRODUCT_NAME  기본: just-workspace. 설치 폴더·바로가기 이름. 지정하면 사용자 데이터 폴더도
 *                    이 이름으로 분리된다(한 PC 에 두 사이트 앱을 설치할 때 필요)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireUrl = process.argv.includes('--require');

const raw = (process.env.JW_SERVER_URL ?? '').trim();
if (!raw && requireUrl) {
  console.error('JW_SERVER_URL 이 필요하다 (예: JW_SERVER_URL=https://ws.example.com npm run dist)');
  process.exit(1);
}

let url;
try {
  url = new URL(raw || 'http://localhost');
} catch {
  console.error(`JW_SERVER_URL 이 URL 이 아니다: ${raw}`);
  process.exit(1);
}
if (!/^https?:$/.test(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
  console.error(`JW_SERVER_URL 은 경로 없는 http(s) 주소여야 한다: ${raw}`);
  process.exit(1);
}
if (requireUrl && url.protocol !== 'https:') {
  console.warn(`[경고] 배포 빌드인데 https 가 아니다: ${url.origin}`);
}

const serverUrl = url.origin;
const appId =
  process.env.JW_APP_ID?.trim() ||
  [...url.hostname.split('.').reverse(), 'just-workspace']
    .map((p) => p.toLowerCase().replace(/[^a-z0-9-]/g, '-'))
    .join('.');
const productNameExplicit = !!process.env.JW_PRODUCT_NAME?.trim();
const productName = process.env.JW_PRODUCT_NAME?.trim() || 'just-workspace';

const site = { serverUrl, appId, productName, productNameExplicit };
await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(path.join(root, 'dist', 'site.json'), JSON.stringify(site, null, 2) + '\n');
console.log(`site → ${serverUrl} (${appId}, ${productName})${raw ? '' : ' [기본값: 개발용]'}`);
