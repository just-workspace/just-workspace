/**
 * 설치 마법사 번들(vite.installer.config.ts)에 포함 금지인 모듈.
 * 설치 마법사는 워크스페이스 서버 부재 시 표시되는 독립 화면이므로 워크스페이스 앱의 화면·셸·라우터·API 클라이언트·
 * 로그인 상태·대용량 라이브러리가 포함되어서는 안 된다. 공용 범위는 UI 키트 · 토큰 CSS · 아이콘 · i18n 엔진 · 소형 유틸리티로 한정한다.
 * 빌드는 generateBundle 에서 본 목록으로 검사하며 위반 시 중단한다. 순수 함수(테스트: tests/installer-app/bundleGuard.test.ts).
 */
/** 포함 금지 모듈 경로(정규식, / 구분) */
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
 * 설치 마법사 CSS 가 Tailwind 클래스 탐색을 위해 스캔하는 소스(frontend-react 기준 경로, `/` 로 끝나면 폴더).
 * src/installer-app/installer.css 의 @source 와 동일해야 한다(테스트에서 대조). 워크스페이스 앱 전체를 스캔하면
 * 마법사가 사용하지 않는 화면의 클래스까지 CSS 에 포함된다.
 * 마법사가 신규 공용 모듈을 사용하면 빌드가 중단된다(아래 installerUnscannedModules) — 본 목록과 installer.css 에 함께 추가한다.
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

/** 번들에 포함된 src 코드 모듈(.ts·.tsx) 중 위 목록에 해당하지 않는 항목 — 해당 파일의 클래스는 CSS 에 포함되지 않는다 */
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
