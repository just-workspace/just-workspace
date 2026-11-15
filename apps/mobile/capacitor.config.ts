import type { CapacitorConfig } from '@capacitor/cli';

// 서버 웹을 감싸는 네이티브 셸. 연결 모델:
//  - URL 입력형(기본): server.url 비움 → www/index.html 런처에서 워크스페이스 주소 입력.
//  - 브랜드 빌드형: server.url 을 인스턴스 주소로 고정(전용 앱) — builder-build.sh + scripts/bake-site.cjs.
//  - 번들 빌드형(선택, React 만): JW_WEB_BUNDLE=1 → frontend-react 를 www-react/ 로 빌드해 앱에 넣고
//    API 만 서버로(scripts/bundle-web.cjs). 이때 JW_WEB_DIR=www-react 로 webDir 을 바꿔 sync 한다.
//
// 본문 웹 UI(JW_WEB = vue | react, 기본 react): 서버 nginx 의 UI 전환 쿠키 jw_ui 를 첫 로드 전에 심어
// 고른다(WebUiPlugin.java). 기본값은 여기와 bake-site.cjs 의 DEFAULT_WEB.
const DEFAULT_WEB = 'react';
const web = (process.env.JW_WEB || DEFAULT_WEB).trim().toLowerCase() === 'react' ? 'react' : 'vue';

const config: CapacitorConfig = {
  appId: 'it.justworkspace.mobile',
  appName: 'Just Workspace',
  webDir: process.env.JW_WEB_DIR || 'www',
  server: {
    androidScheme: 'https',
    // url: 'https://your-workspace.example.com',   // 브랜드 빌드 시 주석 해제
    allowNavigation: ['*'],                          // URL 입력형: 입력한 워크스페이스로 이동 허용
    cleartext: true,                                 // 내부망 http 허용(사내)
  },
  plugins: {
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
    WebUi: { web },
  },
};

export default config;
