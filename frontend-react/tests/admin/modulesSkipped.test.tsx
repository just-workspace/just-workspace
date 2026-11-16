// 관리 › 모듈·플러그인 — 서버가 로드하지 않은 플러그인(목록의 skipped)을 사유와 함께 표시. $fetch 는 모의(mock).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

const api = vi.hoisted(() => ({
  calls: [] as string[],
  routes: {} as Record<string, () => any>,
}))

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const f = async (url: string, opts: any = {}) => {
    const key = `${(opts.method || 'GET').toUpperCase()} ${url}`
    api.calls.push(key)
    const handler = api.routes[key]
    return handler ? handler() : {}
  }
  const $fetch = Object.assign(f, { raw: f, native: fetch, create: () => f })
  return { ...real, $fetch }
})

const AdminModulesPage = (await import('~/pages/admin/modules')).default
const { setUser } = await import('~/composables/useAuth')
const { i18n } = await import('~/i18n')
const t = (k: string, p?: any) => i18n.t(k, p)

function renderPage() {
  const router = createMemoryRouter([{ path: '*', element: <AdminModulesPage /> }], { initialEntries: ['/admin/modules'] })
  return render(<RouterProvider router={router} />)
}

describe('관리 › 모듈·플러그인 — 올리지 않은 플러그인', () => {
  beforeEach(() => {
    api.calls.length = 0
    api.routes = {
      'GET /api/platform/modules': () => ({ modules: [{ id: 'files', name: '파일', route: '/files', type: 'builtin', enabled: true }] }),
    }
    setUser({ id: 'u1', username: 'admin', is_admin: true } as any)
  })

  it('구역이 꺼져 있어 건너뛴 플러그인 — 이름·사유(구역 이름)·구역 보기', async () => {
    api.routes['GET /api/admin/plugins'] = () => ({
      plugins: [{ id: 'notes', name: '메모', version: '1.0.0', description: '견본', author: '', enabled: true }],
      skipped: [{ id: 'remote', name: '원격 지원', reason: 'zone_not_installed', missing_zones: ['meetings', 'nope'] }],
    })
    api.routes['GET /api/admin/system/zones'] = () => ({
      zones: [{ id: 'meetings', name: { ko: '회의', en: 'Meetings' } }], addons: [],
    })
    renderPage()
    const row = await screen.findByTestId('skipped-remote')
    expect(within(row).getByText('원격 지원')).toBeTruthy()
    expect(within(row).getByText(t('admin.modules.skipped.badge'))).toBeTruthy()
    // 이름이 확인되는 구역은 이름으로, 그 외 구역은 id 그대로 표시
    await waitFor(() => expect(within(row).getByText(t('admin.modules.skipped.zoneNotInstalled', { zones: '회의, nope' }))).toBeTruthy())
    expect(within(row).getByRole('button', { name: t('admin.modules.skipped.toZones') })).toBeTruthy()
    expect(screen.getByText(t('admin.modules.skipped.title'))).toBeTruthy()
    // 로드된 플러그인은 위 목록에 그대로 표시
    expect(screen.getByText('메모')).toBeTruthy()
  })

  it('구역 목록을 못 읽으면 구역 id 로 보인다', async () => {
    api.routes['GET /api/admin/plugins'] = () => ({
      plugins: [], skipped: [{ id: 'remote', name: '원격 지원', reason: 'zone_not_installed', missing_zones: ['meetings'] }],
    })
    api.routes['GET /api/admin/system/zones'] = () => { throw new Error('503') }
    renderPage()
    const row = await screen.findByTestId('skipped-remote')
    expect(within(row).getByText(t('admin.modules.skipped.zoneNotInstalled', { zones: 'meetings' }))).toBeTruthy()
  })

  it('건너뛴 것이 없으면 그 칸도, 구역 조회도 없다', async () => {
    api.routes['GET /api/admin/plugins'] = () => ({ plugins: [], skipped: [] })
    renderPage()
    await screen.findByText('파일')
    expect(screen.queryByText(t('admin.modules.skipped.title'))).toBeNull()
    expect(api.calls).not.toContain('GET /api/admin/system/zones')
  })
})
