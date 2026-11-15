// 플러그인 호스트 — v1(Vue) 어댑터로 공개 sample-notes 실제 빌드물이 뜨는지, v2(React) 계약, 판정 로직.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useEffect } from 'react'

const fetchCalls = vi.hoisted(() => [] as { url: string; opts?: Record<string, unknown> }[])

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  let seq = 0
  const fake = async (url: string, opts?: Record<string, unknown>) => {
    fetchCalls.push({ url, opts })
    if (url === '/api/plugins/notes' && (!opts?.method || opts.method === 'GET')) {
      return { notes: [{ id: 'n1', title: '첫 메모', content: '본문입니다' }] }
    }
    if (url === '/api/plugins/notes' && opts?.method === 'POST') {
      const body = opts.body as { title: string; content: string }
      return { id: `new-${++seq}`, ...body }
    }
    return {}
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

// UI 키트의 EmptyState 는 여기선 모양만 흉내(이 테스트는 플러그인 경로만 본다)
vi.mock('~/components/ui/EmptyState', () => ({
  UiEmptyState: (p: { title?: string }) => <div data-testid="empty-state">{p.title}</div>,
}))

const host = await import('~/plugins/pluginHost')
const { authStore } = await import('~/composables/useAuth')
const { siteConfigStore } = await import('~/composables/useSiteConfig')
const { platformStore } = await import('~/composables/usePlatform')
const { getHeaderActions, clearAllHeaderActions } = await import('~/composables/useShellHeaderActions')
const { getShellTitle, clearAllTitles } = await import('~/composables/useShellTitle')
const { setAppRouter } = await import('~/lib/router')
const { $fetch } = await import('~/lib/api')
const { default: PluginPage } = await import('~/pages/p/[id]')

const SAMPLE = join(__dirname, '..', '..', '..', 'plugins', 'sample-notes', 'frontend', 'dist', 'plugin.mjs')
const sampleSource = readFileSync(SAMPLE, 'utf-8')

const USER = {
  id: 'u1', username: 'alice', display_name: 'Alice', email: null, primary_email: null, avatar_url: null,
  recovery_email: null, is_admin: false, last_login_at: null,
}

let restore: (() => void) | null = null
beforeEach(() => {
  fetchCalls.length = 0
  clearAllHeaderActions()
  clearAllTitles()
  authStore.setState({ user: USER, loading: false })
  siteConfigStore.setState({ appName: 'Workspace' })
  platformStore.setState({ modules: [], loaded: false })
})
afterEach(() => {
  restore?.()
  restore = null
})

// ─────────────────────────────────────────────────────────── 판정
describe('계약 버전 판정', () => {
  it('공개 sample-notes 빌드물은 v1(window.__VUE__)', () => {
    expect(host.detectApiFromSource(sampleSource)).toBe(1)
  })

  it('표식·React 전역이면 v2, 아무것도 없으면 null', () => {
    expect(host.detectApiFromSource('const a={api:2};export{a as jwPlugin,b as default};')).toBe(2)
    expect(host.detectApiFromSource('export const jwPlugin = { api: 2 }')).toBe(2)
    expect(host.detectApiFromSource('const R = window.__REACT__; export default function P(){}')).toBe(2)
    expect(host.detectApiFromSource('const { jsx } = window.__REACT_DOM__')).toBe(2)
    expect(host.detectApiFromSource('export default function P(){ return null }')).toBeNull()
    // 둘 다 쓰면 Vue 를 먼저 세워야 평가가 되니 v1
    expect(host.detectApiFromSource('const V = window.__VUE__; const R = window.__REACT__')).toBe(1)
  })

  it('manifest 힌트가 소스보다 우선', () => {
    expect(host.parseApiHint(2)).toBe(2)
    expect(host.parseApiHint('react')).toBe(2)
    expect(host.parseApiHint('1')).toBe(1)
    expect(host.parseApiHint(undefined)).toBeNull()
    expect(host.parseApiHint('x')).toBeNull()
    expect(host.detectPluginApi({ hint: 2, source: sampleSource })).toBe(2)
    expect(host.detectPluginApi({ hint: undefined, source: sampleSource })).toBe(1)
    expect(host.detectPluginApi({})).toBeNull()
  })

  it('import 후 export 표식이 최종, 없으면 추정, 그것도 없으면 v1', () => {
    expect(host.resolveModuleApi({ default: {}, jwPlugin: { api: 2 } }, 1)).toBe(2)
    expect(host.resolveModuleApi({ default: {} }, 2)).toBe(2)
    expect(host.resolveModuleApi({ default: {} }, null)).toBe(1)
  })

  it('번들 주소는 캐시버스터 없이 고정', () => {
    expect(host.pluginBundleUrl('notes')).toBe('/api/plugin-assets/notes/bundle.mjs')
  })
})

// ─────────────────────────────────────────────────────────── v1 어댑터
describe('v1(Vue) 어댑터 — 공개 sample-notes 실제 번들', () => {
  function useSample() {
    const imported: string[] = []
    restore = host.configurePluginLoader({
      apiHint: () => undefined,
      fetchSource: async (url) => { expect(url).toBe('/api/plugin-assets/notes/bundle.mjs'); return sampleSource },
      importModule: async (url) => {
        imported.push(url)
        // 번들 맨 위의 `const {…} = window.__VUE__` 가 돌 때 Vue 가 이미 있어야 한다
        expect(typeof (window.__VUE__ as { createApp?: unknown })?.createApp).toBe('function')
        // 실제 빌드물 바이트 그대로를 data: URL 모듈로(vite 의 루트 밖 파일 제한을 피한다)
        return import(/* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(sampleSource).toString('base64'))
      },
    })
    return imported
  }

  it('Vue 섬으로 마운트되고 pluginApi.$fetch 로 메모를 읽고 만든다', async () => {
    const imported = useSample()
    const api = { version: 2 as const, pluginId: 'notes', user: USER, appName: 'Workspace', ...host.pluginApiStatics }
    const { container, unmount } = render(<host.PluginHost pluginId="notes" pluginApi={api} />)

    // 번들 안 문구: 목록 머리 '메모', 서버에서 받은 메모 제목, 편집기 안내
    await waitFor(() => expect(screen.getByText('첫 메모')).toBeTruthy())
    expect(screen.getByText('메모')).toBeTruthy()
    expect(screen.getByText('메모를 선택하거나 새로 만드세요')).toBeTruthy()
    expect(imported).toEqual(['/api/plugin-assets/notes/bundle.mjs'])
    expect(fetchCalls.some(c => c.url === '/api/plugins/notes' && !c.opts)).toBe(true)
    expect(container.querySelector('[data-plugin-api="1"]')).toBeTruthy()

    // 렌더러가 window.__VUE__ = true 로 덮지 않았다(두 번째 v1 플러그인도 뜨려면 필요)
    expect(typeof (window.__VUE__ as { createApp?: unknown }).createApp).toBe('function')

    // '새 메모' 만들기(+ 버튼) → POST 본문이 번들 그대로
    const addBtn = container.querySelector('div.justify-between > button') as HTMLButtonElement
    fireEvent.click(addBtn)
    await waitFor(() => expect(fetchCalls.some(c => c.opts?.method === 'POST')).toBe(true))
    const post = fetchCalls.find(c => c.opts?.method === 'POST')!
    expect(post.url).toBe('/api/plugins/notes')
    expect(post.opts?.body).toEqual({ title: '새 메모', content: '' })
    await waitFor(() => expect(screen.getByText('새 메모')).toBeTruthy())
    // 선택된 메모가 편집기로
    await waitFor(() => expect((container.querySelector('input[placeholder="제목"]') as HTMLInputElement)?.value).toBe('새 메모'))

    // user 는 Vue ref — authStore 와 동기화(번들은 user 가 없으면 아무것도 안 그린다)
    act(() => authStore.setState({ user: null }))
    await waitFor(() => expect(screen.queryByText('첫 메모')).toBeNull())

    act(() => unmount())
    expect(container.innerHTML).toBe('')
  })

  it('pluginApi 모양(user·appName = ref, $fetch, 상단바 함수)', async () => {
    restore = host.configurePluginLoader({
      apiHint: () => 1,
      importModule: async () => {
        const V = window.__VUE__ as typeof import('vue')
        return {
          default: V.defineComponent({
            setup() {
              const api = V.inject('pluginApi') as Record<string, any>
              ;(globalThis as any).__seenApi = api
              return () => V.h('p', null, `${api.appName.value}:${api.user.value?.username}`)
            },
          }),
        }
      },
    })
    const api = { version: 2 as const, pluginId: 'x', user: USER, appName: 'Workspace', ...host.pluginApiStatics }
    render(<host.PluginHost pluginId="x" pluginApi={api} />)
    await waitFor(() => expect(screen.getByText('Workspace:alice')).toBeTruthy())
    const seen = (globalThis as any).__seenApi
    expect(Object.keys(seen).sort()).toEqual(['$fetch', 'appName', 'clearHeaderActions', 'clearTitle', 'setHeaderActions', 'setTitle', 'user'])
    expect(seen.$fetch).toBe($fetch)
    act(() => siteConfigStore.setState({ appName: 'Acme' }))
    await waitFor(() => expect(screen.getByText('Acme:alice')).toBeTruthy())
  })

  it('번들이 404 면 "Failed to load plugin"', async () => {
    const importModule = vi.fn()
    restore = host.configurePluginLoader({
      apiHint: () => undefined,
      fetchSource: async () => { throw new host.BundleHttpError(404) },
      importModule,
    })
    const api = { version: 2 as const, pluginId: 'gone', user: USER, appName: 'W', ...host.pluginApiStatics }
    const { container } = render(<host.PluginHost pluginId="gone" pluginApi={api} />)
    await waitFor(() => expect(screen.getByText('Failed to load plugin')).toBeTruthy())
    expect(container.querySelector('.text-destructive')).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────── v2 + 페이지
function FakeV2({ pluginApi }: import('~/plugins/pluginHost').PluginPageProps) {
  useEffect(() => {
    // 해제를 일부러 잊는다 — 호스트 페이지가 지워야 한다
    pluginApi.setHeaderActions([{ id: 'run', label: '실행', text: '실행' }], 'fake')
    pluginApi.setTitle('문서 제목', 'fake')
  }, [pluginApi])
  return <p>v2:{pluginApi.user?.username}:{pluginApi.appName}:{pluginApi.pluginId}:{typeof pluginApi.t}</p>
}

describe('v2(React) 계약 + 페이지', () => {
  function mountPage(path: string) {
    const router = createMemoryRouter([
      { path: '/', element: <p>home</p> },
      { path: '/p/:id', element: <PluginPage /> },
    ], { initialEntries: [path] })
    setAppRouter(router)
    const r = render(<RouterProvider router={router} />)
    return { router, ...r }
  }

  afterEach(() => setAppRouter(null))

  it('pluginApi 를 받아 렌더, 상단바 등록, 떠나면 지움, 제목', async () => {
    const importModule = vi.fn(async () => ({ default: FakeV2, jwPlugin: { api: 2 as const } }))
    restore = host.configurePluginLoader({
      apiHint: () => undefined,
      fetchSource: async () => 'const R=window.__REACT__;export{F as default,M as jwPlugin};',
      importModule,
    })
    const vueBefore = window.__VUE__
    platformStore.setState({ modules: [{ id: 'fake', name: 'Fake', icon: 'x', route: '/p/fake', type: 'plugin', requires: [], enabled: true }], loaded: true })
    const { router, unmount } = mountPage('/p/fake')

    await waitFor(() => expect(screen.getByText('v2:alice:Workspace:fake:function')).toBeTruthy())
    expect(document.title).toBe('fake | Workspace')
    expect(getHeaderActions().map(a => a.id)).toEqual(['run'])
    expect(getShellTitle()).toBe('문서 제목')
    expect(importModule).toHaveBeenCalledWith('/api/plugin-assets/fake/bundle.mjs')
    expect(window.__VUE__).toBe(vueBefore) // v2 는 Vue 를 새로 세우지 않는다

    // 다른 플러그인으로 바꾸면 지운다
    platformStore.setState({ modules: [...platformStore.getState().modules, { id: 'other', name: 'O', icon: 'x', route: '/p/other', type: 'plugin', requires: [], enabled: true }] })
    importModule.mockImplementation(async () => ({ default: () => <p>other</p>, jwPlugin: { api: 2 as const } }))
    await act(async () => { await router.navigate('/p/other') })
    await waitFor(() => expect(screen.getByText('other')).toBeTruthy())
    expect(getHeaderActions()).toEqual([])
    expect(getShellTitle()).toBe('') // 제목도 원복

    // 다시 등록된 뒤 페이지를 떠나면(언마운트) 지운다
    act(() => { host.pluginApiStatics.setHeaderActions([{ id: 'x', label: 'x', icon: 'wand' }]) })
    act(() => { host.pluginApiStatics.setTitle('다른 제목') })
    expect(getHeaderActions().length).toBe(1)
    expect(getShellTitle()).toBe('다른 제목')
    act(() => unmount())
    expect(getHeaderActions()).toEqual([])
    expect(getShellTitle()).toBe('')
  })

  it('모듈이 꺼져 있으면 / 로', async () => {
    restore = host.configurePluginLoader({ apiHint: () => 2, importModule: async () => ({ default: FakeV2 }) })
    platformStore.setState({ modules: [{ id: 'off', name: 'Off', icon: 'x', route: '/p/off', type: 'plugin', requires: [], enabled: false }], loaded: true })
    const { router } = mountPage('/p/off')
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
  })

  it('로그인 전에는 아무것도 그리지 않는다', async () => {
    const importModule = vi.fn(async () => ({ default: FakeV2 }))
    restore = host.configurePluginLoader({ apiHint: () => 2, importModule })
    authStore.setState({ user: null })
    const { container } = mountPage('/p/fake')
    await act(async () => { await Promise.resolve() })
    expect(container.innerHTML).toBe('')
    expect(importModule).not.toHaveBeenCalled()
  })
})
