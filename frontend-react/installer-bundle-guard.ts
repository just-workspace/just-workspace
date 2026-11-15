/**
 * 설치 마법사 번들(vite.installer.config.ts)에 섞이면 안 되는 모듈.
 * 설치 마법사는 워크스페이스 서버가 없을 때 뜨는 독립 화면이라 워크스페이스 앱의 화면·셸·라우터·API 클라이언트·
 * 로그인 상태·무거운 라이브러리가 딸려 오면 안 된다. 같이 쓰는 것은 UI 키트 · 토큰 CSS · 아이콘 · i18n 엔진 · 작은 도구까지.
 * 빌드가 generateBundle 에서 이 목록으로 검사해 걸리면 멈춘다. 순수 함수(시험: tests/installer-app/bundleGuard.test.ts).
 */
/** 들어오면 안 되는 모듈 경로(정규식, / 구분) */
export const FORBIDDEN = [
  /\/src\/(pages|layouts|router|plugins|rbi-app)\//,
  /\/src\/App\.tsx$/,
  /\/src\/main\.tsx$/,
  /\/src\/components\/(?!ui\/)[^/]+\//,
  /\/src\/components\/ui\/(Toast|DialogHost|AppRail|Topbar|Tabbar|EditorToolbar|MentionList|EmojiGrid)\.tsx$/,
  /\/src\/lib\/(api|router|query|state|runtimeConfig|bundledApp|desktopBridge|chatEvents|clientErrorReport|chunkReload)\.ts$/,
  /\/src\/lib\/(voice|lossless|hires|rbiMirror)\//,
  /\/src\/composables\/use(Auth|Sidebar|Dialog|Rbi|Api)[A-Za-z]*\.tsx?$/,
  /\/node_modules\/(vue|@vue|livekit-client|@livekit|@tiptap|prosemirror-[a-z-]+|yjs|y-websocket|y-protocols|shiki|chart\.js|react-chartjs-2|katex|markdown-it|dompurify|emojibase-data|react-router|@tanstack|ofetch)\//,
]

export function installerForbiddenModules(ids: string[]): string[] {
  return ids.map(i => i.replace(/\\/g, '/').split('?')[0]).filter(i => FORBIDDEN.some(re => re.test(i)))
}
