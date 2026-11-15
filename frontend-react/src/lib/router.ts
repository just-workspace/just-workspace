/**
 * 라우터 도우미 — `useRoute()`·`useRouter()`·`navigateTo()`.
 *
 * 사용: const route = useRoute(); route.path / route.query.tab / route.params.id;  navigateTo('/x')
 * (route 는 렌더 시점 값이다. 경로가 바뀔 때 할 일은 useEffect(..., [route.path]) 로.)
 *
 * navigateTo 는 컴포넌트 밖(store·이벤트 처리기)에서도 부를 수 있다.
 * 직전 기록의 주소는 `historyBackPath()` 로 읽는다.
 */
import { useContext, useMemo } from 'react'
import { UNSAFE_DataRouterStateContext, useLocation, useParams, type createBrowserRouter } from 'react-router'
import { _setApiNavigate } from '~/lib/api'

export type AppRouter = ReturnType<typeof createBrowserRouter>
export type LocationQueryValue = string | null
export type LocationQuery = Record<string, LocationQueryValue | LocationQueryValue[]>

/** 라우트 메타 — routes.ts 의 handle 에 둔다 */
export interface RouteMeta {
  /** 'default' | 'admin' | 'settings' | false */
  layout?: 'default' | 'admin' | 'settings' | false
  /** 모바일에서 공용 상단바 대신 페이지 자체 머리를 쓴다 */
  ownMobileHeader?: boolean
  /** 데스크톱 공용 상단바를 그리지 않는다(페이지 머리가 맡는다) */
  noDesktopTopbar?: boolean
  /** 페이지 사이드바 하단에 내 계정 패널 — 레일 아바타를 뺀다 */
  sidebarAccount?: boolean
  /** 옛 페이지 파일 경로(표시용) */
  vuePath?: string
  /** catch-all 파라미터 이름([...slug]) */
  catchAll?: string
  [k: string]: unknown
}

export interface RouteLocation {
  path: string
  fullPath: string
  query: LocationQuery
  params: Record<string, string | string[]>
  hash: string
  meta: RouteMeta
}

export type RouteLocationRaw =
  | string
  | { path?: string; query?: Record<string, unknown>; hash?: string; params?: Record<string, string> }

let _router: AppRouter | null = null
const _historyPaths = new Map<number, string>()

export function setAppRouter(r: AppRouter | null) {
  _router = r
  _historyPaths.clear()
  if (!r) return
  const record = () => {
    const idx = (typeof window !== 'undefined' ? (window.history.state?.idx as number | undefined) : undefined) ?? 0
    const l = r.state.location
    _historyPaths.set(idx, l.pathname + l.search + l.hash)
  }
  record()
  normalizeUrlBar(r)
  r.subscribe(() => { normalizeUrlBar(r); record() })
  _setApiNavigate((to) => { void navigateTo(to) })
}

export function getAppRouter(): AppRouter | null {
  return _router
}

/**
 * 주소창 쿼리를 vue-router 모양으로 맞춘다. vue-router 는 첫 진입 때 history.replace(fullPath) 로
 * 주소를 정규화하므로(새 창으로 연 `?path=my%2Fx` 도 `?path=my/x` 로 보임) 같은 결과를 낸다.
 * 라우터가 보고 있는 주소와 브라우저 주소가 같을 때만(메모리 라우터·이동 중에는 손대지 않음).
 */
function normalizeUrlBar(r: AppRouter) {
  if (typeof window === 'undefined') return
  const l = r.state.location
  const w = window.location
  if (w.pathname !== l.pathname || w.search !== l.search || !w.search) return
  const norm = normalizeSearch(w.search)
  if (norm === w.search) return
  try { window.history.replaceState(window.history.state, '', w.pathname + norm + w.hash) } catch { /* ignore */ }
}

/** 직전 기록의 주소. 없으면 undefined */
export function historyBackPath(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const idx = window.history.state?.idx as number | undefined
  if (idx == null || idx <= 0) return undefined
  return _historyPaths.get(idx - 1)
}

/** vue-router 와 같은 쿼리 파싱(같은 키 반복 = 배열, 값 없는 키 = null) */
export function parseQuery(search: string): LocationQuery {
  const q: LocationQuery = {}
  const s = search.startsWith('?') ? search.slice(1) : search
  if (!s) return q
  for (const part of s.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const k = decode(eq < 0 ? part : part.slice(0, eq))
    const v = eq < 0 ? null : decode(part.slice(eq + 1))
    if (k in q) {
      const cur = q[k]
      q[k] = Array.isArray(cur) ? [...cur, v] : [cur as LocationQueryValue, v]
    } else q[k] = v
  }
  return q
}

function decode(s: string): string {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')) } catch { return s }
}

// ── vue-router(4.x) encoding.ts 와 같은 쿼리 인코딩 ─────────────────────────
// encodeURIComponent 와 달리 `/`·`=`·`?`·`:`·`@`·`,` 등은 그대로 두고, 쿼리 구분에 쓰이는
// `&`·`#`·`+`(공백은 `+`)만 인코딩한다. 기존 링크·북마크와 주소창 모양이 같게 하려는 것.
function commonEncode(text: string): string {
  let out: string
  try { out = encodeURI(text) } catch { out = encodeURIComponent(text) } // 짝 없는 서로게이트
  return out.replace(/%7C/g, '|').replace(/%5B/g, '[').replace(/%5D/g, ']')
}

/** vue-router encodeQueryValue */
export function encodeQueryValue(text: string | number): string {
  return commonEncode(String(text))
    .replace(/\+/g, '%2B')
    .replace(/%20/g, '+')
    .replace(/#/g, '%23')
    .replace(/&/g, '%26')
    .replace(/%60/g, '`')
    .replace(/%7B/g, '{')
    .replace(/%7D/g, '}')
    .replace(/%5E/g, '^')
}

/** vue-router encodeQueryKey */
export function encodeQueryKey(text: string | number): string {
  return encodeQueryValue(text).replace(/=/g, '%3D')
}

/** vue-router stringifyQuery 와 같은 결과(undefined 는 뺀다, null 은 키만) */
export function stringifyQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return ''
  const parts: string[] = []
  for (const [k, raw] of Object.entries(query)) {
    if (raw === undefined) continue
    const ek = encodeQueryKey(k)
    const vals = Array.isArray(raw) ? raw : [raw]
    for (const v of vals) {
      if (v === undefined) continue
      parts.push(v === null ? ek : `${ek}=${encodeQueryValue(String(v))}`)
    }
  }
  return parts.join('&')
}

/** `?a=b%2Fc` → `?a=b/c` — 같은 값을 vue-router 모양으로 다시 쓴다(빈 쿼리는 '') */
export function normalizeSearch(search: string): string {
  const qs = stringifyQuery(parseQuery(search))
  return qs ? '?' + qs : ''
}

/** 이동 대상 → 전체 경로 문자열 */
export function resolve(to: RouteLocationRaw): { fullPath: string; href: string; path: string; query: LocationQuery; hash: string } {
  if (typeof to === 'string') {
    const u = new URL(to, 'http://x')
    // vue-router 처럼 문자열 쿼리도 한 번 풀었다가 같은 규칙으로 다시 쓴다(…?path=my%2Fx → …?path=my/x)
    const search = normalizeSearch(u.search)
    const fullPath = u.pathname + search + u.hash
    return { fullPath, href: fullPath, path: u.pathname, query: parseQuery(search), hash: u.hash }
  }
  const cur = _router?.state.location
  const path = to.path ?? cur?.pathname ?? '/'
  const qs = stringifyQuery(to.query)
  const hash = to.hash ? (to.hash.startsWith('#') ? to.hash : '#' + to.hash) : ''
  const fullPath = path + (qs ? '?' + qs : '') + hash
  return { fullPath, href: fullPath, path, query: parseQuery(qs), hash }
}

export interface NavigateOptions {
  replace?: boolean
  /** 외부 주소(전체 새로 고침) */
  external?: boolean
  /** 새 창 */
  open?: { target?: string }
}

/** 이동 — 컴포넌트 안팎 어디서나 */
export async function navigateTo(to: RouteLocationRaw, opts: NavigateOptions = {}): Promise<void> {
  const target = resolve(to).fullPath
  const isExternal = typeof to === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(to)
  if (opts.open) { window.open(typeof to === 'string' && isExternal ? to : target, opts.open.target ?? '_blank'); return }
  if (opts.external || isExternal) {
    const url = typeof to === 'string' ? to : target
    if (opts.replace) window.location.replace(url)
    else window.location.href = url
    return
  }
  if (!_router) { window.location.href = target; return }
  await _router.navigate(target, { replace: !!opts.replace })
}

/** 라우터 객체(push·replace·back 등) */
export function useRouter() {
  return useMemo(() => routerApi, [])
}

export const routerApi = {
  push: (to: RouteLocationRaw) => navigateTo(to),
  replace: (to: RouteLocationRaw) => navigateTo(to, { replace: true }),
  back: () => { if (_router) void _router.navigate(-1); else window.history.back() },
  forward: () => { if (_router) void _router.navigate(1); else window.history.forward() },
  go: (n: number) => { if (_router) void _router.navigate(n); else window.history.go(n) },
  resolve,
}

/** 현재 라우트 */
export function useRoute(): RouteLocation {
  const loc = useLocation()
  const rawParams = useParams()
  // useMatches 는 데이터 라우터 밖에서 던진다 — 디자인 번들(MemoryRouter)에서도 쓰이게 상태 컨텍스트를 직접 읽는다(없으면 메타 없음)
  const matches = useContext(UNSAFE_DataRouterStateContext)?.matches
  return useMemo(() => {
    const meta: RouteMeta = {}
    for (const m of matches ?? []) {
      const handle = m.route.handle
      if (handle && typeof handle === 'object') Object.assign(meta, handle)
    }
    const params: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(rawParams)) {
      if (v === undefined) continue
      if (k === '*') {
        const name = meta.catchAll || 'pathMatch'
        params[name] = v.split('/').filter(Boolean)
      } else params[k] = v
    }
    if (meta.catchAll && !(meta.catchAll in params)) params[meta.catchAll] = []
    return {
      path: loc.pathname,
      fullPath: loc.pathname + loc.search + loc.hash,
      query: parseQuery(loc.search),
      params,
      hash: loc.hash,
      meta,
    }
  }, [loc.pathname, loc.search, loc.hash, rawParams, matches])
}

/** 현재 경로(컴포넌트 밖) */
export function currentPath(): string {
  return _router?.state.location.pathname ?? (typeof location !== 'undefined' ? location.pathname : '/')
}

/** 쿼리 값 하나를 문자열로(배열이면 첫 값) */
export function queryString(v: LocationQueryValue | LocationQueryValue[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0] ?? undefined
  return v ?? undefined
}
