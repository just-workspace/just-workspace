/**
 * 런타임 설정.
 *
 * apiBase: 번들 SPA 앱(Tauri/Capacitor) 빌드에서만 값이 존재한다(`VITE_API_BASE`).
 * 웹(빈값)은 same-origin 프록시(/api·/oauth·/ws 를 nginx 가 백엔드로 전달)를 그대로 사용한다.
 */
export const runtimeConfig = {
  public: {
    apiBase: (import.meta.env.VITE_API_BASE as string | undefined) || '',
  },
}

export function useRuntimeConfig() {
  return runtimeConfig
}

/** 번들 SPA 앱 모드 여부(apiBase 가 있으면 cross-origin + Bearer). */
export const isBundledApp = (): boolean => !!runtimeConfig.public.apiBase

/** apiBase 끝의 / 를 제거한 값('' = same-origin) */
export function apiBaseUrl(): string {
  return runtimeConfig.public.apiBase.replace(/\/+$/, '')
}

/**
 * /api·/oauth 경로를 실제 요청 주소로 변환한다. 웹은 그대로, 번들 앱은 apiBase 를 앞에 붙인다.
 * 이미지 src·다운로드 링크처럼 $fetch 를 거치지 않는 주소에 사용한다.
 */
export function apiUrl(path: string): string {
  const base = apiBaseUrl()
  if (!base) return path
  return path.startsWith('/api') || path.startsWith('/oauth') ? base + path : path
}

/**
 * 로그인 응답의 세션값 저장 — 번들 앱(데스크톱·모바일, apiBase 있음)만 `ws_token` 에 저장한다.
 * 웹은 httpOnly 쿠키만 사용하며 스크립트가 읽을 수 있는 위치에 세션값을 두지 않는다(이전에 남은 값도 삭제한다).
 */
export function storeSessionToken(token: string | null | undefined): void {
  try {
    if (isBundledApp() && token) localStorage.setItem('ws_token', token)
    else if (!isBundledApp()) localStorage.removeItem('ws_token')
  } catch { /* 저장소 접근 불가 */ }
}

/** 웹에서 이전 버전이 남긴 `ws_token` 을 삭제한다(앱 시작·로그인 시). 번들 앱에는 적용하지 않는다. */
export function clearLegacyWebToken(): void {
  if (isBundledApp()) return
  try { localStorage.removeItem('ws_token') } catch { /* 저장소 접근 불가 */ }
}

/** 번들 앱이 로그인 시 수신해 보관한 서명 세션값(`ws_token`). 웹이거나 값이 없으면 null */
export function bundledToken(): string | null {
  if (!isBundledApp()) return null
  try { return localStorage.getItem('ws_token') } catch { return null }
}

/**
 * fetch/XHR 를 직접 사용하는 곳(업·다운로드 진행률 등)에 첨부할 인증 헤더.
 * 웹은 빈 객체(쿠키 세션), 번들 앱은 `Authorization: Bearer <ws_token>` — lib/api.ts 의 $fetch 와 동일한 규칙.
 */
export function bundledAuthHeaders(): Record<string, string> {
  const t = bundledToken()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

/**
 * 웹소켓 주소(`/ws/...` 경로 → ws(s)://호스트/경로).
 * 웹은 현재 창 주소 기준. 번들 앱은 apiBase 의 호스트를 사용한다.
 * 토큰은 주소에 포함하지 않는다 — 쿼리에 포함되면 nginx error_log 에 평문으로 기록된다. wsProtocols() 로 전달한다.
 */
export function wsUrl(path: string): string {
  const base = apiBaseUrl()
  if (!base) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${window.location.host}${path}`
  }
  const u = new URL(path, base)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  return u.toString()
}

/** UTF-8 문자열 → base64url(패딩 없음) */
function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * 웹소켓 인증 하위 프로토콜 — 번들 앱(쿠키 없음)만. `new WebSocket(url, wsProtocols())`.
 * `jw.bearer` + `jw.token.<base64url(ws_token)>` → 백엔드 app/auth/ws_auth.token_from_protocol.
 * 웹은 쿠키 세션이라 undefined(하위 프로토콜 없음).
 */
export function wsProtocols(): string[] | undefined {
  const t = bundledToken()
  return t ? ['jw.bearer', `jw.token.${b64url(t)}`] : undefined
}
