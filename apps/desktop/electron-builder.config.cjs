/**
 * electron-builder 설정. 사이트별로 상이한 값(앱 ID·이름)은 dist/site.json 에서 읽는다
 * — `npm run dist` 가 scripts/site.mjs --require 로 먼저 생성한다.
 */
const fs = require('node:fs');
const path = require('node:path');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, 'dist', 'site.json'), 'utf8'));

/**
 * 패키징된 실행 파일(퓨즈 적용 대상). 플랫폼별로 위치가 상이하다.
 *   win    <appOutDir>/<productFilename>.exe
 *   mac    <appOutDir>/<productFilename>.app   (퓨즈 도구가 번들 내부 바이너리를 탐색한다)
 *   linux  <appOutDir>/<executableName>
 */
function packagedExecutable(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  const name = packager.appInfo.productFilename;
  if (electronPlatformName === 'win32') return path.join(appOutDir, `${name}.exe`);
  if (electronPlatformName === 'darwin') return path.join(appOutDir, `${name}.app`);
  return path.join(appOutDir, packager.executableName);
}

/**
 * Electron Fuses — 바이너리에 기록하는 보안 스위치. 런타임 플래그가 아니라 실행 파일
 * 자체를 변경하므로, 설치된 앱으로 `ELECTRON_RUN_AS_NODE=1 app.exe evil.js` 와 같이
 * 본 프로젝트의 서명·권한으로 임의 코드를 실행하는 경로가 차단된다. 패키징 직후, 코드 서명 전에
 * 실행해야 한다(afterPack 이 해당 시점이다 — 서명 후 변경하면 서명이 무효화된다).
 *
 * mattermost/desktop `scripts/afterpack.js`(Apache-2.0)와 동일한 구성이다.
 * @electron/fuses 2.x 는 ESM 전용이므로 CJS 설정에서는 동적 import 로 호출한다.
 */
async function flipElectronFuses(context) {
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses');
  const exe = packagedExecutable(context);
  const platform = context.electronPlatformName;
  await flipFuses(exe, {
    version: FuseVersion.V1,
    // 서명된 바이너리를 Node 런타임으로 전용하는 경로. 사용처 없음.
    [FuseV1Options.RunAsNode]: false,
    // NODE_OPTIONS 로 --require 를 삽입하는 경로.
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    // --inspect 로 메인 프로세스에 디버거를 연결하는 경로.
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    // 세션 쿠키를 OS 키 저장소로 암호화. 임베드 뷰의 로그인 쿠키가 여기에 저장된다.
    [FuseV1Options.EnableCookieEncryption]: true,
    // app.asar 옆에 압축 해제된 app/ 폴더를 우선 로드하는 동작 차단.
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // asar 해시를 실행 파일에 내장하여 변조를 거부한다. Electron 은 mac·win 만 지원하며
    // (linux 미지원), electron-builder 26 이 두 플랫폼에 해시를 기록한다
    // (electronMac.createMacApp / electronWin.addWinAsarIntegrity). linux 에서 활성화하면
    // 해시가 없어 앱이 기동하지 않으므로 비활성화한다.
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: platform !== 'linux',
    // 위 둘(OnlyLoadAppFromAsar·Integrity)이 활성화되어 있으면 무의미한 옵션은 기본값을 유지한다.
  });
  console.log(`  • fuses flipped  file=${exe}`);
}

module.exports = {
  afterPack: flipElectronFuses,
  appId: site.appId,
  productName: site.productName,
  // 사용자 데이터 폴더는 package.json name(%APPDATA%\just-workspace-desktop)이다. 기존 설치의
  // 로그인을 보존하기 위해 기본값은 유지하고, JW_PRODUCT_NAME 을 지정한 빌드만 해당 이름으로 분리한다.
  extraMetadata: site.productNameExplicit ? { productName: site.productName } : {},
  files: ['dist/**', 'assets/**', 'package.json', 'native/index.js', 'native/remote-input.js', 'native/build/Release/*.node'],
  // 네이티브 바이너리(.node)는 asar 밖에 둔다 — Windows 로더는 아카이브 내부의 DLL 을 열 수 없다.
  //   · native/build/Release/jw_native_audio.node (하이레조 엔진, npm run native:build 로 Electron 헤더 기준 빌드)
  //   · @fails-components/webtransport-transport-http3-quiche 의 프리빌드 webtransport.node (N-API v6)
  asarUnpack: ['**/*.node'],
  // electron-builder 의 자동 재빌드를 비활성화한다: jw_native_audio 는 native:build 가 이미 Electron 헤더로 빌드했고,
  // quiche 패키지는 install 스크립트가 cmake-js 소스 빌드로 fallback 하므로 프리빌드를 그대로 사용한다.
  npmRebuild: false,
  buildDependenciesFromSource: false,
  win: {
    target: 'nsis',
    icon: 'assets/icon.png',
    signtoolOptions: { signingHashAlgorithms: ['sha256'] },
  },
  linux: {
    target: 'AppImage',
    icon: 'assets/icon.png',
    category: 'Network',
  },
  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    icon: 'assets/icon.png',
    category: 'public.app-category.business',
    extendInfo: {
      NSCameraUsageDescription: '회의에서 카메라를 사용합니다.',
      NSMicrophoneUsageDescription: '회의에서 마이크를 사용합니다.',
      // Electron 39+ (macOS 14.2+): desktopCapturer 가 CoreAudio Tap 을 사용하므로 이 키가 없으면 화면 공유
      // 오디오 스트림이 통지 없이 중단된다(오류도 발생하지 않음). docs/breaking-changes.md 39.0 참고.
      NSAudioCaptureUsageDescription: '화면 공유 시 시스템 소리를 함께 보냅니다.',
    },
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
  },
  directories: { output: 'release' },
  // 백엔드 /api/apps/desktop 이 storage/apps/ 에서 이 이름의 파일을 제공한다
  artifactName: 'workspace-desktop-setup.exe',
  nsis: {
    oneClick: true,
    perMachine: false,
    allowToChangeInstallationDirectory: false,
    deleteAppDataOnUninstall: false,
    shortcutName: site.productName,
  },
};
