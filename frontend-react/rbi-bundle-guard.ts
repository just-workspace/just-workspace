/**
 * 격리 브라우저 단독 번들(vite.rbi.config.ts)에 포함 금지인 모듈 — 워크스페이스 셸·화면·모듈·대용량 실시간 라이브러리.
 * 빌드는 generateBundle 에서 본 목록으로 검사하며 위반 시 중단한다. 순수 함수(테스트: tests/pages/rbi.test.tsx).
 */
/** 포함 금지 모듈 경로(정규식, / 구분) */
export const FORBIDDEN = [
  /\/src\/(pages|layouts|router|plugins)\//,
  /\/src\/App\.tsx$/,
  /\/src\/main\.tsx$/,
  /\/src\/components\/(layout|mail|chat|files|meetings|calendar|contacts|board|wiki|git|tasks|dashboard|admin|settings|office|voice)\//,
  /\/src\/lib\/(voice|lossless|hires)\//,
  /\/node_modules\/(vue|livekit-client|@tiptap|yjs|y-websocket|shiki|chart\.js)\//,
]

export function rbiForbiddenModules(ids: string[]): string[] {
  return ids.map(i => i.replace(/\\/g, '/')).filter(i => FORBIDDEN.some(re => re.test(i)))
}

