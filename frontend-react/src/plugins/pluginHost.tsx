/**
 * 런타임 플러그인 로더.
 *
 * 플러그인 프런트는 호스트와 **빌드가 분리된** ES 모듈 하나(`/api/plugin-assets/<id>/bundle.mjs`)다.
 * 호스트를 다시 빌드하지 않고 플러그인을 더하고 바꿀 수 있다. 계약은 두 가지:
 *
 *   v1(Vue)   — 지금까지의 모든 플러그인. `plugins/build-plugin.mjs` 가 `import {…} from 'vue'` 를
 *               `const {…} = window.__VUE__` 로 바꿔 둔 번들. default export = Vue 컴포넌트,
 *               `inject('pluginApi')` 로 { user(ref), $fetch, appName(ref), setHeaderActions, clearHeaderActions, setTitle, clearTitle }.
 *               → 호스트가 Vue 런타임을 **그 때만** 지연 로드(별도 청크)해 window.__VUE__ 를 세우고,
 *                 `createApp` 으로 div 에 마운트한다(아래 VueIsland).
 *   v2(React) — react 를 external 로 두고 window.__REACT__ / __REACT_DOM__ 를 쓰는 번들.
 *               default export = React 컴포넌트, props 로 `pluginApi`(PluginApiV2) 를 받는다.
 *               표식: `export const jwPlugin = { api: 2 }`. 작성법은 frontend-react/docs/plugin-v2.md.
 *
 * 판정 순서(detectPluginApi):
 *   ① 모듈 목록의 manifest 필드 `frontend_api`(1|2) — 지금 백엔드(/api/platform/modules)는 manifest 의 임의 필드를
 *      넘기지 않는다(backend/app/modules/registry.py 가 고정 필드만 복사). 나중에 넘어오면 그것을 믿는다.
 *   ② 없으면 번들 **소스를 fetch** 해서 들여다본다 — `jwPlugin` 표식·`window.__REACT__` → 2, `window.__VUE__` → 1.
 *      v1 번들은 맨 위에서 `window.__VUE__` 를 구조분해하므로 **import 하기 전에** 판정해야 한다
 *      (먼저 import 해 보고 실패하면 다시… 는 안 된다 — 실패한 모듈 평가도 모듈 맵에 남아 같은 URL 은 다시 평가되지 않는다).
 *      같은 URL 이라 브라우저 HTTP 캐시를 같이 쓴다: 백엔드가 ETag + `no-cache` 라 두 번째 요청은 304(수백 바이트).
 *      → 백엔드 수정 없이 동작하고, 모든 v1 번들을 그대로 연다.
 *   ③ import 후 `jwPlugin.api === 2` 를 다시 확인(소스 판정이 빗나가도 export 가 최종).
 *   표식도 전역 참조도 없는 번들은 v1(기존 계약)으로 본다.
 */
import { Component as ReactComponent, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { $fetch, type AppFetch } from '~/lib/api'
import { apiUrl } from '~/lib/runtimeConfig'
import { navigateTo, type NavigateOptions, type RouteLocationRaw } from '~/lib/router'
import { i18n, type TArg } from '~/i18n'
import { authStore, type User } from '~/composables/useAuth'
import { siteConfigStore } from '~/composables/useSiteConfig'
import { platformStore } from '~/composables/usePlatform'
import { setHeaderActions, clearHeaderActions } from '~/composables/useShellHeaderActions'
import { setTitle, clearTitle } from '~/composables/useShellTitle'

// ─────────────────────────────────────────────────────────────── 주소

/**
 * 번들 주소.
 *
 * ★ 캐시버스터(?v=Date.now())를 쓰지 않는다.
 * URL 이 매번 달라지면 브라우저가 재검증을 못 해 **열 때마다 번들 전체(150KB+)를 다시 받는다.**
 * 모바일/셀룰러에서 플러그인 페이지가 느린 주된 이유였다.
 * 백엔드가 ETag·Last-Modified 를 주고 `Cache-Control: no-cache` 이므로,
 * 안정 URL 을 쓰면 재방문은 304(수백 바이트)로 끝나고
 * 플러그인을 새로 빌드하면 mtime 이 바뀌어 자동으로 새 번들을 받는다. (docs/plugin-frontend.md "번들 캐싱")
 *
 * 웹은 상대 주소. 번들 SPA 앱(VITE_API_BASE)은 apiBase 를 붙인다 —
 * 번들은 인증 없는 공개 자산이라 Bearer 는 필요 없다(CORS 만).
 */
/**
 * 플러그인 id 로 쓸 수 있는 글자(영문·숫자·-·_ — 백엔드 설치 검사와 같다).
 * 주소(/p/<id>)의 id 가 그대로 import 경로에 들어가므로, `..%2F` 같은 값이 다른 주소의 스크립트를 불러오지 못하게 막는다.
 */
export function isValidPluginId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)
}

export function pluginBundleUrl(pluginId: string): string {
  return apiUrl(`/api/plugin-assets/${pluginId}/bundle.mjs`)
}

// ─────────────────────────────────────────────────────────────── v2 계약

/** 플러그인 계약 버전. 1 = Vue(기존), 2 = React */
export type PluginApiVersion = 1 | 2

/**
 * v2(React) 플러그인이 props 로 받는 호스트 API.
 *
 * | 멤버 | 타입 | 설명 |
 * |---|---|---|
 * | `user` | `User \| null` | 로그인 사용자(값). 바뀌면 플러그인이 새 props 로 다시 그려진다 |
 * | `appName` | `string` | 사이트 이름(값, 브랜딩) |
 * | `$fetch` | `AppFetch` | 호스트 API 클라이언트(ofetch). 번들 앱의 apiBase·Bearer 처리 포함 |
 * | `setHeaderActions` | `(actions, owner?) => () => void` | 상단바 버튼·칩 등록(= window.__WS_SHELL__.setHeaderActions) |
 * | `clearHeaderActions` | `(owner?) => void` | 상단바 항목 해제 |
 * | `setTitle` | `(title \| null, owner?) => () => void` | 상단바 제목 덮어쓰기(= window.__WS_SHELL__.setTitle). null·'' = 원복 |
 * | `clearTitle` | `(owner?) => void` | 상단바 제목 원복 |
 * | `navigateTo` | `(to, opts?) => Promise<void>` | 호스트 라우터로 이동(전체 새로고침 없이) |
 * | `t` | `(key, a?, b?) => string` | 호스트 i18n(키는 호스트 locales). 선택 — 플러그인 자체 문구엔 쓰지 않아도 된다 |
 * | `pluginId` | `string` | 지금 열린 플러그인 id(라우트 `/p/<id>`) |
 * | `version` | `2` | 계약 버전 |
 */
export interface PluginApiV2 {
  version: 2
  pluginId: string
  user: User | null
  appName: string
  $fetch: AppFetch
  setHeaderActions: typeof setHeaderActions
  clearHeaderActions: typeof clearHeaderActions
  setTitle: typeof setTitle
  clearTitle: typeof clearTitle
  navigateTo: (to: RouteLocationRaw, opts?: NavigateOptions) => Promise<void>
  t?: (key: string, a?: TArg, b?: TArg) => string
}

/** v2 플러그인 컴포넌트의 props */
export interface PluginPageProps {
  pluginApi: PluginApiV2
}

/**
 * 번들 쪽 표식 — v2 번들은 이것을 export 한다.
 * @example export const jwPlugin = { api: 2 } as const
 */
export interface PluginMarker {
  api: PluginApiVersion
}

/** 불러온 번들 모듈의 모양 */
export interface PluginModule {
  default?: unknown
  jwPlugin?: Partial<PluginMarker>
}

// ─────────────────────────────────────────────────────────────── 판정

/** manifest 필드 값(1·2·'1'·'2'·'vue'·'react')을 버전으로. 모르면 null */
export function parseApiHint(v: unknown): PluginApiVersion | null {
  if (v === 1 || v === '1' || v === 'vue' || v === 'v1') return 1
  if (v === 2 || v === '2' || v === 'react' || v === 'v2') return 2
  return null
}

/**
 * 번들 소스로 계약 버전 판정. 표식(`jwPlugin` export)·`window.__REACT__` → 2, `window.__VUE__` → 1, 둘 다 없으면 null.
 * 압축된 번들이라도 export 이름과 전역 이름은 남는다(`export { x as jwPlugin }`, `window.__VUE__`).
 */
export function detectApiFromSource(source: string): PluginApiVersion | null {
  if (/\bexport\b[^;]*\bjwPlugin\b/.test(source)) return 2
  const vue = /\b(?:window|globalThis|self)\s*\.\s*__VUE__\b/.test(source)
  const react = /\b(?:window|globalThis|self)\s*\.\s*__REACT(?:_DOM)?__\b/.test(source)
  if (vue && !react) return 1
  if (react && !vue) return 2
  if (vue && react) return 1 // 둘 다 쓰면 Vue 가 먼저 있어야 평가가 된다 — 안전하게 v1 준비
  return null
}

/** manifest 힌트 > 소스 판정 순서. 둘 다 없으면 null(호출부가 기본 v1) */
export function detectPluginApi(input: { hint?: unknown; source?: string | null }): PluginApiVersion | null {
  return parseApiHint(input.hint) ?? (input.source != null ? detectApiFromSource(input.source) : null)
}

/** import 결과로 최종 판정(export 표식이 소스 판정보다 우선) */
export function resolveModuleApi(mod: PluginModule, guess: PluginApiVersion | null): PluginApiVersion {
  if (mod?.jwPlugin && mod.jwPlugin.api === 2) return 2
  if (mod?.jwPlugin && mod.jwPlugin.api === 1) return 1
  return guess ?? 1
}

// ─────────────────────────────────────────────────────────────── Vue 런타임(지연 로드)

type VueModule = typeof import('vue')
let vuePromise: Promise<VueModule> | null = null

/**
 * Vue 런타임을 지연 로드해 window.__VUE__ 를 세운다(v1 플러그인을 열 때만 — 동적 import 라 메인 번들과 별도 청크).
 *
 * ★ Vue 렌더러는 처음 만들어질 때 `globalThis.__VUE__ = true`(devtools 표식)를 쓴다.
 * 호스트가 Vue 앱이 아니어서 렌더러보다 전역이 먼저 서므로,
 * 그대로 두면 첫 createApp 이 전역을 `true` 로 덮어 **두 번째 v1 플러그인부터 깨진다.**
 * 그래서 빈 앱 하나로 렌더러를 먼저 만들고 나서 전역을 세운다.
 */
export function ensureVueRuntime(): Promise<VueModule> {
  if (!vuePromise) {
    vuePromise = import('vue').then((Vue) => {
      Vue.createApp({}) // 렌더러 초기화(→ __VUE__ = true) 를 먼저 일으킨다
      window.__VUE__ = Vue
      return Vue
    }).catch((e) => {
      vuePromise = null
      throw e
    })
  }
  return vuePromise.then((Vue) => {
    if (window.__VUE__ !== Vue) window.__VUE__ = Vue // 누가 덮었으면 되돌린다
    return Vue
  })
}

// ─────────────────────────────────────────────────────────────── 로더(테스트에서 바꿔 끼울 수 있게)

export interface PluginLoaderDeps {
  /** 번들 ES 모듈 import(기본: 브라우저 동적 import) */
  importModule: (url: string) => Promise<PluginModule>
  /** 판정용 소스 받기(기본: fetch). 응답 실패면 throw */
  fetchSource: (url: string) => Promise<string>
  /** manifest 의 계약 버전 힌트(기본: 모듈 목록의 frontend_api) */
  apiHint: (pluginId: string) => unknown
}

/** 번들 응답이 2xx 가 아님(404 = 프런트 없음 등) */
export class BundleHttpError extends Error {
  constructor(public status: number) { super(`plugin bundle HTTP ${status}`) }
}

const defaultDeps: PluginLoaderDeps = {
  importModule: url => import(/* @vite-ignore */ url) as Promise<PluginModule>,
  fetchSource: async (url) => {
    const res = await fetch(url, { credentials: 'same-origin' })
    if (!res.ok) throw new BundleHttpError(res.status)
    return res.text()
  },
  apiHint: id => platformStore.getState().modules.find(m => m.id === id)?.frontend_api,
}

let deps: PluginLoaderDeps = defaultDeps

/** 테스트용: 로더 의존성 바꿔 끼우기. 되돌리는 함수를 돌려준다 */
export function configurePluginLoader(partial: Partial<PluginLoaderDeps>): () => void {
  const prev = deps
  deps = { ...deps, ...partial }
  return () => { deps = prev }
}

export interface LoadedPlugin {
  api: PluginApiVersion
  component: unknown
}

/** 번들을 판정·준비·import 한다. 실패면 throw(→ "Failed to load plugin") */
export async function loadPlugin(pluginId: string): Promise<LoadedPlugin> {
  if (!isValidPluginId(pluginId)) throw new Error('invalid plugin id')
  const url = pluginBundleUrl(pluginId)
  const hint = parseApiHint(deps.apiHint(pluginId))
  let guess: PluginApiVersion | null = hint
  if (guess == null) {
    try {
      guess = detectApiFromSource(await deps.fetchSource(url))
    } catch (e) {
      // 서버가 404 등으로 답했으면 import 도 같은 결과 — 바로 실패
      if (e instanceof BundleHttpError) throw e
      // 네트워크 등으로 소스를 못 봤으면 v1 일 수도 있으니 Vue 를 미리 세우고 import 해 본다
      guess = null
    }
  }
  if (guess !== 2) await ensureVueRuntime()
  const mod = await deps.importModule(url)
  const api = resolveModuleApi(mod, guess)
  if (api === 1) await ensureVueRuntime()
  if (mod?.default == null) throw new Error('plugin bundle has no default export')
  return { api, component: mod.default }
}

// ─────────────────────────────────────────────────────────────── v1 마운트(Vue 섬)

function VueIsland({ component, pluginId }: { component: unknown; pluginId: string }) {
  const elRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = elRef.current
    if (!el) return
    let disposed = false
    let cleanup: (() => void) | null = null
    void ensureVueRuntime().then((Vue) => {
      if (disposed) return
      // v1 플러그인이 inject('pluginApi') 로 받는 모양 — user·appName 은 Vue ref
      const user = Vue.shallowRef<User | null>(authStore.getState().user)
      const appName = Vue.ref<string>(siteConfigStore.getState().appName)
      const offAuth = authStore.subscribe((s) => { if (s.user !== user.value) user.value = s.user })
      const offSite = siteConfigStore.subscribe((s) => { if (s.appName !== appName.value) appName.value = s.appName })
      const app = Vue.createApp(component as Parameters<VueModule['createApp']>[0])
      app.provide('pluginApi', { user, $fetch, appName, setHeaderActions, clearHeaderActions, setTitle, clearTitle })
      app.mount(el)
      if (window.__VUE__ !== Vue) window.__VUE__ = Vue
      cleanup = () => { offAuth(); offSite(); app.unmount() }
    })
    return () => { disposed = true; cleanup?.() }
  }, [component, pluginId])
  // display: contents — 플러그인 루트가 페이지 div 의 바로 아래에 오게. 상자 하나 끼지 않는다(h-full 등 유지).
  return <div ref={elRef} data-plugin-id={pluginId} data-plugin-api="1" style={{ display: 'contents' }} />
}

// ─────────────────────────────────────────────────────────────── 화면

/** 번들을 불러오는 동안의 문구 */
export function PluginLoading() {
  return <div className="flex items-center justify-center py-20 text-muted-foreground"><span className="text-sm">Loading plugin...</span></div>
}

/** 번들을 불러오지 못했을 때의 문구 */
export function PluginLoadError() {
  return <div className="flex items-center justify-center py-20 text-destructive"><span className="text-sm">Failed to load plugin</span></div>
}

/** 번들이 렌더 중 던지면 v1 과 같은 실패 표시(호스트 셸은 살린다) */
class PluginErrorBoundary extends ReactComponent<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  override componentDidCatch(e: unknown) { console.error('[plugin] render error:', e) }
  override render() { return this.state.failed ? <PluginLoadError /> : this.props.children }
}

/** 로딩 문구를 띄우기 전 지연(200ms) — 빨리 뜨면 로딩 문구가 깜빡이지 않게 */
const LOADING_DELAY_MS = 200

export interface PluginHostProps {
  pluginId: string
  /** v2 플러그인에 넘길 API(페이지가 만든다) */
  pluginApi: PluginApiV2
}

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; plugin: LoadedPlugin }

/**
 * 플러그인 번들을 불러와 v1(Vue 섬) 또는 v2(React 컴포넌트)로 그린다.
 * pluginId 가 바뀌면 처음부터 다시 — 부르는 쪽에서 `key={pluginId}` 를 준다.
 */
export function PluginHost({ pluginId, pluginApi }: PluginHostProps) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [showLoading, setShowLoading] = useState(false)

  useEffect(() => {
    let alive = true
    const timer = setTimeout(() => { if (alive) setShowLoading(true) }, LOADING_DELAY_MS)
    loadPlugin(pluginId).then(
      (plugin) => { if (alive) setState({ status: 'ready', plugin }) },
      (e) => {
        console.error(`[plugin] ${pluginId} load failed:`, e)
        if (alive) setState({ status: 'error' })
      },
    ).finally(() => clearTimeout(timer))
    return () => { alive = false; clearTimeout(timer) }
  }, [pluginId])

  if (state.status === 'loading') return showLoading ? <PluginLoading /> : null
  if (state.status === 'error') return <PluginLoadError />
  const { plugin } = state
  if (plugin.api === 1) return <VueIsland component={plugin.component} pluginId={pluginId} />
  const Comp = plugin.component as ComponentType<PluginPageProps>
  return (
    <PluginErrorBoundary>
      <Comp pluginApi={pluginApi} />
    </PluginErrorBoundary>
  )
}

/** 페이지가 v2 pluginApi 를 만들 때 쓰는 고정 멤버 */
export const pluginApiStatics = {
  $fetch,
  setHeaderActions,
  clearHeaderActions,
  setTitle,
  clearTitle,
  navigateTo,
}

/** 컴포넌트 밖 i18n(t) — 언어 변경 시 페이지가 새 객체를 만든다 */
export const hostT = (key: string, a?: TArg, b?: TArg) => i18n.t(key, a, b)
