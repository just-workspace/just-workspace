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

/**
 * 설치 마법사 CSS 가 Tailwind 클래스를 찾으려고 훑는 소스(frontend-react 기준 경로, `/` 로 끝나면 폴더).
 * src/installer-app/installer.css 의 @source 와 같아야 한다(시험이 대조한다). 워크스페이스 앱 전체를 훑으면
 * 마법사가 쓰지 않는 화면의 클래스까지 CSS 에 실린다.
 * 마법사가 새 공용 모듈을 가져다 쓰면 빌드가 멈춘다(아래 installerUnscannedModules) — 여기와 installer.css 에 함께 더한다.
 */
export const INSTALLER_TAILWIND_SOURCES = [
  'installer.html',
  'src/installer-app/',
  'src/components/ui/',
  'src/composables/useCapsLock.ts',
  'src/composables/useToast.ts',
  'src/composables/useViewport.ts',
  'src/i18n/',
  'src/lib/clipboard.ts',
  'src/lib/fluid.ts',
  'src/lib/utils.ts',
  'src/utils/icons.ts',
]

/** 번들에 든 src 의 코드 모듈(.ts·.tsx) 가운데 위 목록이 덮지 않는 것 — 그 파일의 클래스는 CSS 에 실리지 않는다 */
export function installerUnscannedModules(ids: string[]): string[] {
  const out: string[] = []
  for (const raw of ids) {
    const id = raw.replace(/\\/g, '/').split('?')[0]
    const at = id.lastIndexOf('/src/')
    if (at < 0 || id.includes('/node_modules/') || !/\.tsx?$/.test(id)) continue
    const rel = id.slice(at + 1)
    if (!INSTALLER_TAILWIND_SOURCES.some(s => (s.endsWith('/') ? rel.startsWith(s) : rel === s))) out.push(id)
  }
  return out
}
