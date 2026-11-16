/**
 * API 클라이언트 — 전역 `$fetch`(ofetch).
 *
 * - 동일한 ofetch 를 사용한다: `body` 객체는 JSON 직렬화, `query`, 응답 자동 파싱, 실패 시 `FetchError`(`.data`·`.status`·`.statusCode`).
 *   호출 형태: `$fetch<T>(url, { method, body, query, headers, credentials })`.
 * - 웹(same-origin): 추가 항목 없음(쿠키 세션) — credentials 는 호출부 지정값을 따른다.
 * - 번들 SPA 앱(VITE_API_BASE): `/api`·`/oauth` 만 apiBase 로 전달 + `Authorization: Bearer <ws_token>`.
 *   호출부가 onResponseError 를 지정하지 않은 경우 401 에서 토큰을 삭제하고 /login 으로 이동한다(공유 링크 손님 제외).
 * - X-Request-ID: 백엔드가 모든 응답에 부여하는 요청 번호를 실패한 FetchError 에 `requestId` 로 기록한다
 *   (오류 화면 "요청 번호" 표시용. 본문 `request_id` 가 있으면 해당 값 우선 — ServerErrorScreen 참조).
 */
import { ofetch, FetchError, type $Fetch, type FetchOptions } from 'ofetch'
import { apiBaseUrl, apiUrl, bundledAuthHeaders } from '~/lib/runtimeConfig'

export { FetchError }
export type { FetchOptions }

/** 401 처리 등에서 앱 라우터로 이동할 때 사용하는 함수(라우터 생성 시 lib/router 가 주입) */
let _navigate: ((to: string) => void) | null = null
export function _setApiNavigate(fn: (to: string) => void) { _navigate = fn }

const isApi = (u: unknown): u is string =>
  typeof u === 'string' && (u.startsWith('/api') || u.startsWith('/oauth'))

/** 실패 응답의 X-Request-ID 를 오류 객체에 기록한다 */
function attachRequestId(ctx: { response?: Response; error?: unknown }) {
  const rid = ctx.response?.headers?.get?.('x-request-id')
  if (rid && ctx.error && typeof ctx.error === 'object') {
    try { (ctx.error as { requestId?: string }).requestId = rid } catch { /* 동결(frozen) 객체 */ }
  }
}

/**
 * 웹(same-origin)에서 세션이 무효화된 응답을 수신했다는 신호 — composables/useAuth 가 수신한다.
 * 기존에는 401 처리가 번들 앱 분기에만 존재하여, 웹은 세션이 만료·강제 로그아웃되어도 셸이 유지되고
 * 빈 목록·오류 토스트만 반복되었다(새로 고침해야 로그인 화면 표시). 여기서는 통지만 수행하고 판단은 useAuth 가 담당한다 —
 * 401 을 다른 의미로 사용하는 요청(공유 링크 비밀번호 등)이 있으므로 /api/auth/me 로 1회 확인한 후 처리한다.
 * 429·5xx·네트워크 오류는 일시 오류이므로 통지하지 않는다.
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
 * 파일 저장소 연결이 끊겨 쓰기가 거부되었다는 신호(503 + code `storage_unavailable`) — composables/useStorageStatus 가 수신한다.
 * 파일 탭은 이 신호로 연결 끊김 안내로 전환되며, 저장소가 복구되면 자동 해제된다.
 */
export const STORAGE_DOWN_EVENT = 'jw:storage-down'
export const STORAGE_DOWN_CODE = 'storage_unavailable'
export function notifyStorageDown(status: number | undefined, data: unknown) {
  if (status !== 503 || typeof window === 'undefined') return
  if ((data as { code?: unknown } | null)?.code !== STORAGE_DOWN_CODE) return
  try { window.dispatchEvent(new CustomEvent(STORAGE_DOWN_EVENT)) } catch { /* ignore */ }
}

/**
 * 서버에 도달하지 못했다는 신호(연결 실패 또는 502·503·504) — composables/useUpdateNotice 가 수신하여 업데이트 점검 중인지 조회한다.
 * 저장소 연결 끊김(503 `storage_unavailable`)과 호출부가 직접 중단한 요청은 통지하지 않는다.
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
            // 공유 링크로 진입한 손님은 계정이 없다. /api/auth/me 의 401 응답이 정상이므로
            // 여기서 로그인으로 이동시키면 편집기가 열리는 즉시 이탈된다.
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
    // 번들 앱은 위 onResponseError 가 처리한다 — 웹에만 적용
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
 * 전역 `$fetch`.
 * @example const data = await $fetch<{ items: Item[] }>('/api/x', { query: { page: 1 } })
 */
export const $fetch: AppFetch = Object.assign(
  <T = any>(request: string, opts?: FetchOptions<any>) => call<T>(request, opts as FetchOptions<'json'>),
  {
    raw: ((request: string, opts: FetchOptions<any> = {}) => {
      const base = apiBaseUrl()
      if (!base || !isApi(request)) return base$fetch.raw(request, opts)
      // 번들 앱: 주소뿐 아니라 Bearer 도 추가한다(인증 누락 시 utils/apiDownload 가 401)
      const auth = bundledAuthHeaders()
      const headers = Object.keys(auth).length ? { ...(opts.headers as Record<string, string> || {}), ...auth } : opts.headers
      return base$fetch.raw(base + request, { ...opts, headers })
    }) as $Fetch['raw'],
    native: base$fetch.native,
    create: base$fetch.create,
  },
)

/** FetchError 등에서 HTTP 상태 코드를 추출한다(없으면 undefined) */
export function errorStatus(e: unknown): number | undefined {
  const x = e as { statusCode?: number; status?: number; response?: { status?: number } } | null
  return x?.statusCode ?? x?.status ?? x?.response?.status
}

/** 서버가 반환한 요청 번호(본문 request_id 우선, 없으면 X-Request-ID 헤더) */
export function errorRequestId(e: unknown): string | undefined {
  const x = e as { data?: { request_id?: unknown }; requestId?: string } | null
  if (x?.data && typeof x.data === 'object' && typeof x.data.request_id === 'string') return x.data.request_id
  return x?.requestId
}

/**
 * `fetch()` 를 직접 사용해야 하는 경우(스트리밍 진행률 다운로드 등)용 — 주소·인증만 $fetch 와 동일한 규칙으로 적용한다.
 * 웹: 변경 없음(`credentials` 는 호출부 지정값). 번들 앱: `/api`·`/oauth` 에 apiBase + Bearer.
 */
export function apiRawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const auth = bundledAuthHeaders()
  if (!Object.keys(auth).length) return fetch(apiUrl(path), init)
  const headers = new Headers(init.headers)
  for (const [k, v] of Object.entries(auth)) headers.set(k, v)
  return fetch(apiUrl(path), { ...init, headers })
}
