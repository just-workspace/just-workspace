/**
 * 데스크톱 앱(Electron 0.5.0+) 임베드 웹뷰 프리로드가 내보내는 `window.jwShell` — 셸 → 웹 이동 명령 하나.
 *
 * 트레이 "회의"·알림 토스트 클릭처럼 셸이 화면을 옮겨야 할 때, 페이지를 새로 불러오지 않고 SPA 라우터로 옮긴다
 * (새로 불러오면 음성채널·통화가 끊긴다). 브라우저에는 없다 → 아무 일도 하지 않는다.
 * 타입 정본은 apps/desktop/src/preload/webview.ts(JwShellBridge).
 */
export interface JwShellBridge {
  apiVersion: number
  /** 셸이 앱 내부 경로로 옮기라고 할 때. 해제 함수를 돌려준다 */
  onNavigate: (fn: (path: string) => void) => () => void
}

declare global {
  interface Window { jwShell?: JwShellBridge }
}

/** 앱 내부 경로만 받는다('/x'). 바깥 주소·'//host' 는 버린다 */
export function isAppPath(p: unknown): p is string {
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !p.includes('\\')
}

/** 셸의 이동 명령을 라우터에 잇는다. 셸이 아니면 null */
export function connectDesktopBridge(navigate: (path: string) => void, w: { jwShell?: JwShellBridge } = typeof window !== 'undefined' ? window : {}): (() => void) | null {
  const b = w.jwShell
  if (!b || typeof b.onNavigate !== 'function') return null
  return b.onNavigate((p) => { if (isAppPath(p)) navigate(p) })
}
