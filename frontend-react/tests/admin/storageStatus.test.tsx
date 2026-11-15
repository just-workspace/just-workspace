// 저장소 상태 — 관리 › 저장소의 상태 카드(정상·끊김·쓰기 실패), 파일 탭의 끊김 안내와 쓰기 동작 꺼짐,
// 관리자 알림 띠, 끊김 신호(503 storage_unavailable)와 스스로 풀리기. $fetch 는 가짜.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; method: string }[],
  routes: {} as Record<string, () => any>,
}))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const f = async (url: string, opts: any = {}) => {
    const method = (opts.method || 'GET').toUpperCase()
    api.calls.push({ url, method })
    const handler = api.routes[`${method} ${url}`]
    return handler ? handler() : {}
  }
  const $fetch = Object.assign(f, { raw: f, native: fetch, create: () => f })
  return { ...real, $fetch }
})

const realApi = await import('~/lib/api')
const card = await import('~/components/admin/AdminStorageStatus')
const { AdminStorageStatus } = card
const { LayoutStorageDownBanner } = await import('~/components/layout/StorageDownBanner')
const { FilesFileStorageDown } = await import('~/components/files/FileStorageDown')
const storage = await import('~/composables/useStorageStatus')
const { setUser } = await import('~/composables/useAuth')
const files = await import('~/composables/useFiles')
const { resetSharedState } = await import('~/lib/state')

const S = '/api/admin/system/storage'
const STATUS = '/api/system/storage-status'
const state = (o: Record<string, unknown> = {}) => ({
  guarded: true, kind: 'nfs', location: 'nas.example.com:/volume1/workspace', state: 'ok', reason: null, write: true, lock: true,
  total_bytes: 1000 * 1024 ** 3, used_bytes: 400 * 1024 ** 3, free_bytes: 600 * 1024 ** 3,
  checked_at: '2026-03-04T05:06:07+00:00', down_since: null, ...o,
})
const DOWN = { state: 'down', reason: 'unresponsive', write: null, lock: null, total_bytes: null, used_bytes: null, free_bytes: null, down_since: '2026-03-04T04:00:00+00:00' }
const user = (admin: boolean) => setUser({ id: 'u', username: 'u', display_name: '사용자', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: admin, last_login_at: null })
const called = (method: string, url: string) => api.calls.filter(c => c.method === method && c.url === url).length

function inRouter(ui: React.ReactElement, path = '/') {
  const router = createMemoryRouter([{ path: '*', element: ui }], { initialEntries: [path] })
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  api.calls = []
  api.routes = {}
  storage._resetStorageStatus()
  storage.storageTiming.okMs = 60_000
  storage.storageTiming.downMs = 15_000
  card.storageCardTiming.downMs = 15_000
  files._resetFilesStore()
  resetSharedState()
  user(true)
})
afterEach(() => { storage._resetStorageStatus() })

describe('관리 › 저장소 — 상태 카드', () => {
  it('정상 · 네트워크 저장소: 종류·위치·연결·여유 공간·마지막 확인', async () => {
    api.routes[`GET ${S}`] = () => state()
    render(<AdminStorageStatus />)
    expect(await screen.findByText('네트워크 저장소 (NFS)')).toBeTruthy()
    expect(screen.getByText('nas.example.com:/volume1/workspace').className).toContain('font-mono')
    const conn = screen.getByTestId('storage-conn')
    expect(conn.textContent).toBe('연결됨 · 쓰기와 파일 잠금 정상')
    expect(conn.className).toContain('text-success')
    expect(conn.querySelector('svg')).toBeTruthy()
    expect(screen.getByText('600 GB')).toBeTruthy()
    expect(screen.getByRole('meter', { name: '사용한 공간' }).getAttribute('aria-valuenow')).toBe('40')
    expect(screen.getByText('마지막 확인')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(/여기에는 파일 탭의 문서, 채팅 첨부, 메일 첨부 보관본이 있습니다/)).toBeTruthy()
  })

  it('정상 · 이 서버의 디스크: 위치를 모르면 그 줄을 숨긴다', async () => {
    api.routes[`GET ${S}`] = () => state({ kind: 'local', location: null })
    render(<AdminStorageStatus />)
    expect(await screen.findByText('이 서버의 디스크')).toBeTruthy()
    expect(screen.getByTestId('storage-conn').textContent).toBe('정상')
    expect(screen.queryByText('위치')).toBeNull()
  })

  it('끊김: 경고 상자(끊긴 시각·영향·확인할 것), 여유 공간은 확인할 수 없음, [다시 확인]으로 풀린다', async () => {
    let current = state(DOWN)
    api.routes[`GET ${S}`] = () => current
    api.routes[`POST ${S}/recheck`] = () => current
    api.routes[`GET ${STATUS}`] = () => ({ guarded: true, available: true, reason: null })
    render(<AdminStorageStatus />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('파일 저장소와 연결이 끊겨 파일 쓰기가 멈췄습니다.')
    expect(alert.textContent).toContain('부터')
    expect(alert.textContent).toContain('사용자는 파일 탭에서 파일을 열거나 올릴 수 없습니다.')
    expect(alert.textContent).toContain('NAS가 켜져 있는지, 이 서버와 NAS 사이 네트워크가 살아 있는지 확인합니다.')
    expect(alert.textContent).toContain('연결되면 자동으로 다시 붙습니다.')
    expect(screen.getByTestId('storage-reason').textContent).toBe('저장소가 응답하지 않습니다.')
    const conn = screen.getByTestId('storage-conn')
    expect(conn.textContent).toBe('끊김 · 파일 쓰기와 읽기 멈춤')
    expect(conn.className).toContain('text-danger')
    expect(screen.getByText('확인할 수 없음')).toBeTruthy()
    expect(screen.queryByRole('meter')).toBeNull()

    current = state()
    fireEvent.click(screen.getAllByRole('button', { name: '다시 확인' })[0])
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(called('POST', `${S}/recheck`)).toBe(1)
    expect(screen.getByTestId('storage-conn').textContent).toBe('연결됨 · 쓰기와 파일 잠금 정상')
    // 알림 띠·파일 탭이 보는 상태도 같이 맞춘다
    await waitFor(() => expect(called('GET', STATUS)).toBe(1))
  })

  it('끊겨 있는 동안은 스스로 다시 확인하고, 돌아오면 멈춘다', async () => {
    card.storageCardTiming.downMs = 20
    let current = state({ ...DOWN, kind: 'local', location: null, reason: 'missing' })
    api.routes[`GET ${S}`] = () => current
    api.routes[`POST ${S}/recheck`] = () => current
    render(<AdminStorageStatus />)
    expect((await screen.findByRole('alert')).textContent).toContain('저장소 디스크가 이 서버에 붙어 있는지 확인합니다.')
    await waitFor(() => expect(called('POST', `${S}/recheck`)).toBeGreaterThan(1))
    current = state({ kind: 'local', location: null })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    const n = called('POST', `${S}/recheck`)
    await new Promise(r => setTimeout(r, 80))
    expect(called('POST', `${S}/recheck`)).toBe(n)
  })

  it('연결은 됐지만 쓰기나 잠금이 안 되면 경고 색으로 알린다', async () => {
    api.routes[`GET ${S}`] = () => state({ write: false, lock: null })
    const view = render(<AdminStorageStatus />)
    await waitFor(() => expect(screen.getByTestId('storage-conn').textContent).toBe('연결됨 · 쓰기가 되지 않습니다'))
    expect(screen.getByTestId('storage-conn').className).toContain('text-warning')
    view.unmount()
    api.routes[`GET ${S}`] = () => state({ lock: false })
    render(<AdminStorageStatus />)
    await waitFor(() => expect(screen.getByTestId('storage-conn').textContent).toBe('연결됨 · 파일 잠금이 되지 않습니다'))
  })

  it('상태를 못 받으면 오류와 다시 시도', async () => {
    let n = 0
    api.routes[`GET ${S}`] = () => { if (n++ === 0) throw new Error('500'); return state() }
    render(<AdminStorageStatus />)
    expect(await screen.findByText('저장소 상태를 불러오지 못했습니다')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(await screen.findByTestId('storage-conn')).toBeTruthy()
  })
})

describe('관리자 알림 띠', () => {
  it('저장소가 끊기면 관리자에게 띠와 저장소 화면 링크가 보인다', async () => {
    api.routes[`GET ${STATUS}`] = () => ({ guarded: true, available: false, reason: 'missing' })
    inRouter(<LayoutStorageDownBanner />)
    const banner = await screen.findByTestId('storage-down-banner')
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.textContent).toContain('파일 저장소와 연결이 끊겨 파일 쓰기가 멈췄습니다.')
    expect(screen.getByRole('link', { name: '저장소 상태 보기' }).getAttribute('href')).toBe('/admin/storage')
  })

  it('정상이면 보이지 않고, 일반 사용자는 묻지도 않는다', async () => {
    api.routes[`GET ${STATUS}`] = () => ({ guarded: true, available: true, reason: null })
    const view = inRouter(<LayoutStorageDownBanner />)
    await waitFor(() => expect(called('GET', STATUS)).toBe(1))
    expect(screen.queryByTestId('storage-down-banner')).toBeNull()
    view.unmount()

    storage._resetStorageStatus()
    api.calls = []
    api.routes[`GET ${STATUS}`] = () => ({ guarded: true, available: false, reason: 'missing' })
    user(false)
    inRouter(<LayoutStorageDownBanner />)
    await new Promise(r => setTimeout(r, 30))
    expect(called('GET', STATUS)).toBe(0)
    expect(screen.queryByTestId('storage-down-banner')).toBeNull()
  })

  it('쓰기가 503 storage_unavailable 로 거부되면 기다리지 않고 바로 뜬다', async () => {
    api.routes[`GET ${STATUS}`] = () => ({ guarded: true, available: true, reason: null })
    inRouter(<LayoutStorageDownBanner />)
    await waitFor(() => expect(called('GET', STATUS)).toBe(1))
    act(() => { realApi.notifyStorageDown(503, { code: 'storage_unavailable', detail: 'x' }) })
    expect(await screen.findByTestId('storage-down-banner')).toBeTruthy()
  })

  it('다른 503 이나 다른 코드는 끊김으로 보지 않는다', () => {
    const seen: string[] = []
    const on = () => seen.push('down')
    window.addEventListener(realApi.STORAGE_DOWN_EVENT, on)
    realApi.notifyStorageDown(503, { detail: 'maintenance' })
    realApi.notifyStorageDown(500, { code: 'storage_unavailable' })
    realApi.notifyStorageDown(503, null)
    expect(seen).toEqual([])
    realApi.notifyStorageDown(503, { code: 'storage_unavailable' })
    expect(seen).toEqual(['down'])
    window.removeEventListener(realApi.STORAGE_DOWN_EVENT, on)
  })
})

describe('저장소 상태 지켜보기', () => {
  it('끊겼을 때는 자주, 돌아오면 스스로 풀린다', async () => {
    storage.storageTiming.downMs = 20
    let available = false
    api.routes[`GET ${STATUS}`] = () => ({ guarded: true, available, reason: available ? null : 'unresponsive' })
    inRouter(<LayoutStorageDownBanner />)
    expect(await screen.findByTestId('storage-down-banner')).toBeTruthy()
    await waitFor(() => expect(called('GET', STATUS)).toBeGreaterThan(2))
    available = true
    await waitFor(() => expect(screen.queryByTestId('storage-down-banner')).toBeNull())
    // 정상일 때는 간격이 길다 — 곧바로 다시 묻지 않는다
    const n = called('GET', STATUS)
    await new Promise(r => setTimeout(r, 80))
    expect(called('GET', STATUS)).toBe(n)
  })

  it('표식 확인을 쓰지 않는 설치는 한 번 묻고 그만둔다', async () => {
    storage.storageTiming.okMs = 20
    api.routes[`GET ${STATUS}`] = () => ({ guarded: false, available: true, reason: null })
    inRouter(<LayoutStorageDownBanner />)
    await waitFor(() => expect(called('GET', STATUS)).toBe(1))
    await new Promise(r => setTimeout(r, 80))
    expect(called('GET', STATUS)).toBe(1)
  })

  it('상태를 묻지 못하면(서버 재시작) 보던 상태를 그대로 둔다', async () => {
    storage.storageTiming.downMs = 20
    let broken = false
    api.routes[`GET ${STATUS}`] = () => { if (broken) throw new Error('502'); return { guarded: true, available: false, reason: 'missing' } }
    inRouter(<LayoutStorageDownBanner />)
    expect(await screen.findByTestId('storage-down-banner')).toBeTruthy()
    broken = true
    await new Promise(r => setTimeout(r, 80))
    expect(screen.getByTestId('storage-down-banner')).toBeTruthy()
  })
})

describe('파일 탭 — 저장소가 끊겼을 때', () => {
  it('일반 사용자: 안내와 [다시 확인]만, 관리자 링크는 없다', async () => {
    user(false)
    storage.storageStatusStore.setState({ guarded: true, available: false, reason: 'missing' })
    let available = false
    api.routes[`GET ${STATUS}`] = () => ({ guarded: true, available, reason: null })
    inRouter(<FilesFileStorageDown />)
    expect(screen.getByRole('heading', { name: '파일' })).toBeTruthy()
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('지금은 파일을 열 수 없습니다')
    expect(alert.textContent).toContain('파일 저장소와 연결이 끊겼습니다. 관리자에게 알렸습니다. 다시 연결되면 파일은 그대로 보입니다.')
    expect(screen.getByText('파일 목록, 미리보기, 올리기, 내려받기가 모두 멈춥니다. 채팅과 메일의 첨부도 같은 이유로 열리지 않습니다.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: '저장소 상태 보기' })).toBeNull()
    available = true
    fireEvent.click(screen.getByRole('button', { name: '다시 확인' }))
    await waitFor(() => expect(storage.storageStatusStore.getState().available).toBe(true))
  })

  it('관리자: 저장소 화면으로 가는 링크가 더 있다', () => {
    storage.storageStatusStore.setState({ guarded: true, available: false, reason: 'missing' })
    inRouter(<FilesFileStorageDown admin />)
    expect(screen.getByRole('alert').textContent).toContain('저장소 화면에서 상태를 확인합니다.')
    expect(screen.getByRole('link', { name: '저장소 상태 보기' }).getAttribute('href')).toBe('/admin/storage')
  })

  it('파일 화면: 끊기면 목록·업로드·새로 만들기가 사라지고 안내만 남고, 돌아오면 원래 화면으로 풀린다', async () => {
    user(false)
    storage.storageTiming.downMs = 20
    let available = false
    api.routes[`GET ${STATUS}`] = () => ({ guarded: true, available, reason: available ? null : 'unresponsive' })
    api.routes['GET /api/files/list'] = () => ({ path: 'my', items: [] })
    const { default: FilesPage } = await import('~/pages/files')
    inRouter(<FilesPage />, '/files')
    expect(await screen.findByTestId('files-storage-down')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '업로드' })).toBeNull()
    expect(screen.queryByRole('button', { name: '새로만들기' })).toBeNull()
    expect(screen.queryByRole('button', { name: '업로드·새로 만들기' })).toBeNull()
    expect(document.querySelector('input[type="file"]')).toBeNull()

    available = true
    await waitFor(() => expect(screen.queryByTestId('files-storage-down')).toBeNull())
    expect(document.querySelector('input[type="file"]')).toBeTruthy()
  })

  it('파일 화면: 올리기가 저장소 끊김으로 거부되면 그 자리에서 안내로 바뀐다', async () => {
    user(false)
    api.routes[`GET ${STATUS}`] = () => ({ guarded: true, available: true, reason: null })
    api.routes['GET /api/files/list'] = () => ({ path: 'my', items: [] })
    const { default: FilesPage } = await import('~/pages/files')
    inRouter(<FilesPage />, '/files')
    await waitFor(() => expect(called('GET', STATUS)).toBe(1))
    expect(screen.queryByTestId('files-storage-down')).toBeNull()
    act(() => { realApi.notifyStorageDown(503, { code: 'storage_unavailable' }) })
    expect(await screen.findByTestId('files-storage-down')).toBeTruthy()
  })
})
