/**
 * 데스크톱 앱(Electron 0.5.0+) 임베드 웹뷰 프리로드가 노출하는 `window.jwShell` — 셸 → 웹 이동 명령 하나.
 *
 * 트레이 "회의"·알림 토스트 클릭처럼 셸이 화면을 이동해야 하는 경우, 페이지를 재로드하지 않고 SPA 라우터로 이동한다
 * (재로드 시 음성채널·통화가 단절된다). 브라우저에는 존재하지 않는다 → no-op.
 * 타입 정본은 apps/desktop/src/preload/webview.ts(JwShellBridge).
 */
export interface JwShellBridge {
  apiVersion: number
  /** 셸이 앱 내부 경로로의 이동을 요청할 때 호출된다. 해제 함수를 반환한다 */
  onNavigate: (fn: (path: string) => void) => () => void
}

declare global {
  interface Window { jwShell?: JwShellBridge }
}

/** 앱 내부 경로만 허용한다('/x'). 외부 주소·'//host' 는 거부한다 */
export function isAppPath(p: unknown): p is string {
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !p.includes('\\')
}

/** 셸의 이동 명령을 라우터에 연결한다. 셸이 아니면 null */
export function connectDesktopBridge(navigate: (path: string) => void, w: { jwShell?: JwShellBridge } = typeof window !== 'undefined' ? window : {}): (() => void) | null {
  const b = w.jwShell
  if (!b || typeof b.onNavigate !== 'function') return null
  return b.onNavigate((p) => { if (isAppPath(p)) navigate(p) })
}
