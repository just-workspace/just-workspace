/**
 * API 클라이언트 — Vue 판 Nuxt 전역 `$fetch`(ofetch) 와 같은 동작.
 *
 * - 같은 ofetch 를 쓴다: `body` 객체는 JSON 직렬화, `query`, 응답 자동 파싱, 실패 시 `FetchError`(`.data`·`.status`·`.statusCode`).
 *   Vue 쪽 `$fetch<T>(url, { method, body, query, headers, credentials })` 호출을 **글자 그대로** 옮기면 된다.
 * - 웹(same-origin): 아무것도 덧붙이지 않는다(쿠키 세션). Vue 판과 같다 — credentials 는 호출부가 준 대로.
 * - 번들 SPA 앱(VITE_API_BASE): `/api`·`/oauth` 만 apiBase 로 + `Authorization: Bearer <ws_token>`.
 *   호출부가 onResponseError 를 안 줬으면 401 에서 토큰을 지우고 /login 으로(공유 링크 손님 제외).
 *   (Vue `plugins/app-api.client.ts` 그대로)
 * - X-Request-ID: 백엔드가 모든 응답에 붙이는 요청 번호를 실패한 FetchError 에 `requestId` 로 실어 둔다
 *   (오류 화면 "요청 번호" 표시용. 본문 `request_id` 가 있으면 그쪽이 우선 — ServerErrorScreen 참조).
 */
import { ofetch, FetchError, type $Fetch, type FetchOptions } from 'ofetch'
import { apiBaseUrl, apiUrl, bundledAuthHeaders } from '~/lib/runtimeConfig'

export { FetchError }
export type { FetchOptions }

/** 401 처리 등에서 앱 라우터로 이동할 때 쓰는 함수(라우터가 만들어지면 lib/router 가 주입) */
let _navigate: ((to: string) => void) | null = null
export function _setApiNavigate(fn: (to: string) => void) { _navigate = fn }

const isApi = (u: unknown): u is string =>
  typeof u === 'string' && (u.startsWith('/api') || u.startsWith('/oauth'))

/** 실패 응답의 X-Request-ID 를 오류 객체에 붙인다 */
function attachRequestId(ctx: { response?: Response; error?: unknown }) {
  const rid = ctx.response?.headers?.get?.('x-request-id')
  if (rid && ctx.error && typeof ctx.error === 'object') {
    try { (ctx.error as { requestId?: string }).requestId = rid } catch { /* 얼린 객체 */ }
  }
}

/**
 * 웹(same-origin)에서 세션이 끊긴 응답을 받았다는 신호 — composables/useAuth 가 듣는다.
 * 예전엔 401 처리가 번들 앱 분기 안에만 있어, 웹은 세션이 만료·강제 로그아웃돼도 셸이 그대로 남고
 * 빈 목록·오류 토스트만 반복됐다(새로 고침해야 로그인 화면). 여기서는 알리기만 하고 판단은 useAuth 가 한다 —
 * 401 을 다른 뜻으로 쓰는 요청(공유 링크 비밀번호 등)이 있어 /api/auth/me 로 한 번 확인한 뒤 움직인다.
 * 429·5xx·네트워크 오류는 일시 오류다 — 알리지 않는다.
 */
export const AUTH_LOST_EVENT = 'jw:auth-lost'
function notifyAuthLost(request: string, resp?: Response) {
  if (typeof window === 'undefined' || !resp) return
  const kind = resp.status === 401
    ? 'unauthorized'
    : (resp.status === 403 && resp.headers?.get?.('x-totp-setup-required') === '1' ? 'totp' : null)
  if (!kind) return
  try { window.dispatchEvent(new CustomEvent(AUTH_LOST_EVENT, { detail: { kind, request } })) } catch { /* ignore */ }
}

/**
 * 파일 저장소가 끊겨 쓰기가 거부됐다는 신호(503 + code `storage_unavailable`) — composables/useStorageStatus 가 듣는다.
 * 파일 탭은 이 신호로 끊김 안내로 바뀌고, 저장소가 돌아오면 스스로 풀린다.
 */
export const STORAGE_DOWN_EVENT = 'jw:storage-down'
export const STORAGE_DOWN_CODE = 'storage_unavailable'
export function notifyStorageDown(status: number | undefined, data: unknown) {
  if (status !== 503 || typeof window === 'undefined') return
  if ((data as { code?: unknown } | null)?.code !== STORAGE_DOWN_CODE) return
  try { window.dispatchEvent(new CustomEvent(STORAGE_DOWN_EVENT)) } catch { /* ignore */ }
}

/**
 * 서버에 닿지 못했다는 신호(연결 실패 또는 502·503·504) — composables/useUpdateNotice 가 듣고, 업데이트 점검 중인지 묻는다.
 * 저장소 끊김(503 `storage_unavailable`)과 호출부가 스스로 끊은 요청은 알리지 않는다.
 */
export const API_DOWN_EVENT = 'jw:api-down'
export function notifyApiDown(e: unknown) {
  if (typeof window === 'undefined') return
  const x = e as { response?: Response; data?: { code?: unknown }; name?: string; cause?: { name?: string } } | null
  if (x?.name === 'AbortError' || x?.cause?.name === 'AbortError') return
  const status = x?.response?.status
  if (status !== undefined && ![502, 503, 504].includes(status)) return
  if (x?.data?.code === STORAGE_DOWN_CODE) return
  try { window.dispatchEvent(new CustomEvent(API_DOWN_EVENT, { detail: { status: status ?? 0 } })) } catch { /* ignore */ }
}

const base$fetch: $Fetch = ofetch.create({})

async function call<T>(request: string, opts: FetchOptions<'json'> = {}): Promise<T> {
  const base = apiBaseUrl()
  let url = request
  if (base && isApi(request)) {
    try {
      const t = localStorage.getItem('ws_token')
      if (t) opts = { ...opts, headers: { ...(opts.headers as Record<string, string> || {}), Authorization: `Bearer ${t}` } }
    } catch { /* ignore */ }
    if (opts.onResponseError === undefined) {
      opts = {
        ...opts,
        onResponseError: (ctx) => {
          if (ctx?.response?.status === 401) {
            try { localStorage.removeItem('ws_token') } catch { /* ignore */ }
            // 공유 링크로 들어온 손님은 계정이 없다. /api/auth/me 가 401 나는 게 정상이라
            // 여기서 로그인으로 쫓으면 편집기가 열리자마자 튕긴다.
            const guest = typeof location !== 'undefined'
              && (location.pathname.startsWith('/s/') || location.search.includes('share='))
            if (!guest && typeof location !== 'undefined' && !location.pathname.startsWith('/login')) _navigate?.('/login')
          }
        },
      }
    }
    url = base + request
  }
  try {
    return await base$fetch<T>(url, opts)
  } catch (e) {
    const resp = (e as { response?: Response })?.response
    attachRequestId({ response: resp, error: e })
    // 번들 앱은 위 onResponseError 가 맡는다 — 웹만
    if (!base && isApi(request)) notifyAuthLost(request, resp)
    if (isApi(request)) notifyStorageDown(resp?.status, (e as { data?: unknown })?.data)
    if (isApi(request)) notifyApiDown(e)
    throw e
  }
}

export interface AppFetch {
  <T = any>(request: string, opts?: FetchOptions<any>): Promise<T>
  raw: $Fetch['raw']
  native: $Fetch['native']
  create: $Fetch['create']
}

/**
 * 전역 `$fetch` — Vue 판과 같은 이름·같은 시그니처.
 * @example const data = await $fetch<{ items: Item[] }>('/api/x', { query: { page: 1 } })
 */
export const $fetch: AppFetch = Object.assign(
  <T = any>(request: string, opts?: FetchOptions<any>) => call<T>(request, opts as FetchOptions<'json'>),
  {
    raw: ((request: string, opts: FetchOptions<any> = {}) => {
      const base = apiBaseUrl()
      if (!base || !isApi(request)) return base$fetch.raw(request, opts)
      // 번들 앱: 주소만이 아니라 Bearer 도 붙인다(Vue 판 wrapped.raw 는 주소만 바꿔 인증이 빠졌다 — utils/apiDownload 가 401)
      const auth = bundledAuthHeaders()
      const headers = Object.keys(auth).length ? { ...(opts.headers as Record<string, string> || {}), ...auth } : opts.headers
      return base$fetch.raw(base + request, { ...opts, headers })
    }) as $Fetch['raw'],
    native: base$fetch.native,
    create: base$fetch.create,
  },
)

/** FetchError 등에서 HTTP 상태 코드를 꺼낸다(없으면 undefined) */
export function errorStatus(e: unknown): number | undefined {
  const x = e as { statusCode?: number; status?: number; response?: { status?: number } } | null
  return x?.statusCode ?? x?.status ?? x?.response?.status
}

/** 서버가 준 요청 번호(본문 request_id 우선, 없으면 X-Request-ID 헤더) */
export function errorRequestId(e: unknown): string | undefined {
  const x = e as { data?: { request_id?: unknown }; requestId?: string } | null
  if (x?.data && typeof x.data === 'object' && typeof x.data.request_id === 'string') return x.data.request_id
  return x?.requestId
}

/**
 * `fetch()` 를 직접 써야 하는 곳(스트리밍 진행률 다운로드 등)용 — 주소·인증만 $fetch 와 같은 규칙으로 맞춘다.
 * 웹: 그대로(`credentials` 는 호출부가 준 값). 번들 앱: `/api`·`/oauth` 에 apiBase + Bearer.
 */
export function apiRawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const auth = bundledAuthHeaders()
  if (!Object.keys(auth).length) return fetch(apiUrl(path), init)
  const headers = new Headers(init.headers)
  for (const [k, v] of Object.entries(auth)) headers.set(k, v)
  return fetch(apiUrl(path), { ...init, headers })
}
