// 폴더 공유 링크 손님 화면(wave 7) — 목록·하위 폴더 이동·경로·받기 주소·내려받기 막힘·비밀번호 링크 푼 뒤 폴더 화면.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts: any }[],
  handler: (_url: string, _opts: any): any => ({}),
}))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts: any = {}) => { api.calls.push({ url, opts }); return api.handler(url, opts) }
  return { ...real, $fetch: Object.assign(fake, { raw: fake, native: fetch, create: () => fake }) }
})

const { i18n } = await import('~/i18n')
const t = (k: string, p?: Record<string, unknown>) => i18n.t(k, p as any)
const Page = (await import('~/pages/s/[token]')).default

const INFO = { name: 'docs.zip', size: null, is_office: false, can_edit: false, allow_download: true, requires_password: false,
  is_multi: true, is_folder: true, item_count: 1, expires_at: null, downloads_left: null, owner_name: '앨리스', exists: true }
const it_ = (name: string, o: Record<string, unknown> = {}) => ({ name, path: name, is_dir: false, size: 5, modified_at: null, mime_type: 'text/plain', preview: 'text', ...o })

function listFor(url: string, allow = true) {
  const sub = new URL(url, 'http://x').searchParams.get('sub') || ''
  if (sub === '') return { name: 'docs', sub, allow_download: allow, truncated: false, items: [it_('sub', { is_dir: true, preview: null, size: 0, mime_type: null }), it_('a.txt')] }
  if (sub === 'sub') return { name: 'docs', sub, allow_download: allow, truncated: false, items: [it_('b.bin', { path: 'sub/b.bin', preview: null, mime_type: null })] }
  throw Object.assign(new Error('404'), { statusCode: 404 })
}

function mount(path = '/s/tk') {
  const router = createMemoryRouter([{ path: '/s/:token', element: <Page /> }], { initialEntries: [path] })
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  api.calls = []
  window.history.replaceState(null, '', '/s/tk')
})

describe('폴더 공유 링크 손님 화면', () => {
  it('목록 → 하위 폴더 들어가기 → 경로로 되돌아오기', async () => {
    api.handler = (url) => {
      if (url === '/api/wopi/shared/tk/info') return INFO
      if (url.startsWith('/api/files/shared/tk/list')) return listFor(url)
      return {}
    }
    mount()
    expect(await screen.findByText('a.txt')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'docs' })).toBeTruthy()
    expect(document.body.textContent).toContain(t('share.sharedBy', { name: '앨리스' }))
    fireEvent.click(screen.getByText('sub'))
    expect(await screen.findByText('b.bin')).toBeTruthy()
    expect(window.location.search).toBe('?p=sub')
    expect(screen.getByText(t('share.folder.zipHere'))).toBeTruthy()
    const nav = screen.getByRole('navigation', { name: t('share.folder.path') })
    fireEvent.click(nav.querySelector('button')!)
    expect(await screen.findByText('a.txt')).toBeTruthy()
  })

  it('내려받기 막힌 링크 = 받기 버튼 없음, 미리보기만', async () => {
    api.handler = (url) => {
      if (url === '/api/wopi/shared/tk/info') return { ...INFO, allow_download: false }
      if (url.startsWith('/api/files/shared/tk/list')) return listFor(url, false)
      return {}
    }
    mount()
    expect(await screen.findByText('a.txt')).toBeTruthy()
    expect(screen.queryByRole('button', { name: t('share.folder.downloadOf', { name: 'a.txt' }) })).toBeNull()
    expect(screen.queryByText(t('share.folder.zipAll'))).toBeNull()
    expect(screen.getByRole('button', { name: t('share.folder.previewOf', { name: 'a.txt' }) })).toBeTruthy()
  })

  it('미리보기 = inline 주소로 글자를 받아 보여 준다', async () => {
    api.handler = (url) => {
      if (url === '/api/wopi/shared/tk/info') return INFO
      if (url.startsWith('/api/files/shared/tk/list')) return listFor(url)
      return {}
    }
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('hello', { headers: { 'content-type': 'text/plain' } }))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: t('share.folder.previewOf', { name: 'a.txt' }) }))
    expect(await screen.findByText('hello')).toBeTruthy()
    expect(String(f.mock.calls[0][0])).toBe('/api/files/shared/tk?sub=a.txt&inline=1')
    f.mockRestore()
  })

  it('비밀번호 링크 — 풀고 목록이 열리면 폴더 화면, access 를 붙인다', async () => {
    api.handler = (url) => {
      if (url === '/api/wopi/shared/tk/info') return { ...INFO, name: '', is_multi: false, is_folder: false, requires_password: true }
      if (url === '/api/files/shared/tk/unlock') return { ok: true, access: 'AK' }
      if (url.startsWith('/api/files/shared/tk/list')) return listFor(url)
      return {}
    }
    mount()
    const pw = await screen.findByLabelText(t('share.passwordLabel'))
    fireEvent.change(pw, { target: { value: '1234' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('share.unlock') })) })
    expect(await screen.findByText('a.txt')).toBeTruthy()
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/files/shared/tk/list?sub=&access=AK')).toBe(true))
  })

  it('목록이 410 이면 결과 화면', async () => {
    api.handler = (url) => {
      if (url === '/api/wopi/shared/tk/info') return INFO
      if (url.startsWith('/api/files/shared/tk/list')) throw Object.assign(new Error('410'), { statusCode: 410 })
      return {}
    }
    mount()
    expect(await screen.findByText(t('share.result.expired.title'))).toBeTruthy()
  })
})
