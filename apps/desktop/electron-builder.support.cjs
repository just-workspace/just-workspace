/**
 * 원격 지원 프로그램(포터블) 빌드 — `npm run dist:support`.
 * 데스크톱 앱과 동일한 코드베이스에서 진입점만 dist/main/support.js 로 변경한다(로그인·트레이·동기화 없음).
 * 서명 없이 생성한다(사용자 허용). 산출물은 서버 storage/apps/remote-support.exe 로 업로드한다 —
 * 원격 데스크톱 플러그인이 /api/plugins/remote-desktop/support/download 로 익명 배포한다.
 * 서버 주소는 빌드 시 JW_SERVER_URL(dist/site.json)로 내장하고, 없으면 첫 실행 시 입력받는다.
 */
const base = require('./electron-builder.config.cjs');
const fs = require('node:fs');
const path = require('node:path');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, 'dist', 'site.json'), 'utf8'));

module.exports = {
  afterPack: base.afterPack,
  appId: `${site.appId}.support`,
  productName: 'RemoteSupport',
  extraMetadata: { main: 'dist/main/support.js', productName: 'RemoteSupport', name: 'just-workspace-remote-support' },
  files: [
    'dist/main/support.js', 'dist/main/config.js', 'dist/main/contextMenu.js', 'dist/main/remote/**', 'dist/preload/remote.js',
    'dist/renderer/remote-*', 'dist/site.json', 'assets/**', 'package.json',
    'native/remote-input.js', 'native/build/Release/jw_remote_input.node',
    // livekit-client 는 러너 번들(dist/renderer/remote-runner.js)에 이미 포함되어 있고, 지원 프로그램 메인은 npm 의존성을 사용하지 않는다
    '!**/node_modules/**',
  ],
  asarUnpack: ['**/*.node'],
  npmRebuild: false,
  buildDependenciesFromSource: false,
  win: { target: 'portable', icon: 'assets/icon.png' },
  portable: { artifactName: 'remote-support.exe', requestExecutionLevel: 'user' },
  directories: { output: 'release-support' },
};
