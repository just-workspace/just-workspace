/**
 * 사이트 값을 안드로이드 프로젝트에 주입한다 (builder-build.sh 가 cap sync 직후 호출한다).
 *  - capacitor.config.json: 이 워크스페이스를 바로 열고(런처 생략), 해당 호스트 밖으로는 이동하지 않는다
 *    · 원격(기본): server.url = 사이트 주소 — 서버 웹을 그대로 연다
 *    · 번들(JW_WEB_BUNDLE=1): server.url 없음 — 앱 내 React SPA(https://localhost)가 API 만 사이트로 전송한다
 *  - strings.xml: 런처에 표시되는 앱 이름
 * 환경: WS_URL, APP_ID, APP_NAME, JW_WEB_BUNDLE
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const u = new URL(process.env.WS_URL);

const cfgPath = path.join(root, 'android/app/src/main/assets/capacitor.config.json');
const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
c.appId = process.env.APP_ID;
c.appName = process.env.APP_NAME;
const bundle = process.env.JW_WEB_BUNDLE === '1';

const server = {
  ...c.server,
  androidScheme: 'https',
  allowNavigation: [u.host],
  cleartext: u.protocol === 'http:',
};
// 번들: 앱 내 SPA(https://localhost) — 백엔드 CORS 가 이 출처를 허용한다(ALLOW_NATIVE_APP_ORIGINS, 기본 활성화)
if (bundle) delete server.url;
else server.url = u.origin;
c.server = server;
fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2));
console.log(bundle ? `baked bundle api=${u.origin}` : `baked server.url=${c.server.url}`);

// Android 문자열 리소스: XML 이스케이프 + ' " \ 앞에 \, 맨 앞 @ ? 도 \
const name = process.env.APP_NAME
  .replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m])
  .replace(/(['"\\])/g, '\\$1')
  .replace(/^([@?])/, '\\$1');
const strPath = path.join(root, 'android/app/src/main/res/values/strings.xml');
const xml = fs.readFileSync(strPath, 'utf8')
  .replace(/(<string name="(?:app_name|title_activity_main)">)[^<]*/g, (_, h) => h + name);
fs.writeFileSync(strPath, xml);
console.log(`baked app name=${process.env.APP_NAME}`);
