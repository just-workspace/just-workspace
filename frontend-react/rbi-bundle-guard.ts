/**
 * 격리 브라우저 단독 번들(vite.rbi.config.ts)에 섞이면 안 되는 모듈 — 워크스페이스 셸·화면·모듈·무거운 실시간 라이브러리.
 * 빌드가 generateBundle 에서 이 목록으로 검사해 걸리면 멈춘다. 순수 함수(시험: tests/pages/rbi.test.tsx).
 */
/** 들어오면 안 되는 모듈 경로(정규식, / 구분) */
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

