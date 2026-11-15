// "다운로드 막음(미리보기만)" 과 미리보기 안 되는 형식 — 링크 만들기 창은 그 옵션을 비활성 + 이유, 손님 화면은 죽은 링크에 안내.
// 미리보기 가능 여부는 서버 판정(GET /share/preview-kind · info.can_preview · unlock.can_preview · list 의 preview). $fetch 는 가짜.
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
const files = await import('~/composables/useFiles')
const { FilesFileShareModal } = await import('~/components/files/FileShareModal')
const { setUser } = await import('~/composables/useAuth')
const { resetSharedState } = await import('~/lib/state')
const Page = (await import('~/pages/s/[token]')).default

const t = (k: string, p?: Record<string, unknown>) => i18n.t(k, p as any)
const REASON = /미리 볼 수 없어 "다운로드 막음"을 쓸 수 없습니다/
const DEAD = '이 형식은 미리 볼 수 없고 내려받기가 막혀 있습니다.'
const item = (name: string, is_dir = false) => ({ name, path: `my/${name}`, is_dir, size: 10, modified_at: null, mime_type: null }) as import('~/composables/useFiles').FileItem
const link = (o: Record<string, unknown> = {}) => ({
  id: 'L1', token: 'tok', display_name: 'app.zip', file_path: 'my/app.zip', expires_at: null, max_downloads: null,
  download_count: 0, created_at: '2026-11-14T00:00:00Z', can_edit: false, has_password: false, allow_download: true,
  paths: ['my/app.zip'], email_count: 0, ...o,
})

function inRouter(ui: React.ReactElement, path = '/') {
  const router = createMemoryRouter([{ path: '*', element: ui }], { initialEntries: [path] })
  return render(<RouterProvider router={router} />)
}
function mountGuest() {
  const router = createMemoryRouter([{ path: '/s/:token', element: <Page /> }], { initialEntries: ['/s/tk'] })
  return render(<RouterProvider router={router} />)
}
/** 새 링크 카드의 권한 선택(첫 번째 권한 select)을 열어 "다운로드 막음" 옵션을 찾는다 */
async function nodlOption(index = 0) {
  const boxes = await screen.findAllByRole('combobox', { name: t('files.shareModal.permission') })
  const box = boxes[index]
  if (box.tagName === 'SELECT') return Array.from(box.querySelectorAll('option')).find(o => o.textContent === t('files.shareModal.permViewNoDownload'))!
  fireEvent.click(box)
  const opts = await screen.findAllByRole('option')
  return opts.find(o => (o.textContent || '').includes(t('files.shareModal.permViewNoDownload')))!
}
const isDisabled = (el: Element) => (el as HTMLOptionElement).disabled === true || el.getAttribute('aria-disabled') === 'true'

beforeEach(() => {
  files._resetFilesStore()
  resetSharedState()
  api.calls = []
  api.handler = () => ({})
  window.history.replaceState(null, '', '/s/tk')
  setUser({ id: 'u1', username: 'me', display_name: '나', email: 'me@corp.test', primary_email: null, avatar_url: null, recovery_email: null, is_admin: false, last_login_at: null } as any)
})

describe('링크 만들기 — 미리보기 안 되는 파일', () => {
  const base = (preview: unknown, links: any[] = []) => (url: string) => {
    if (url === '/api/files/share/preview-kind') return preview
    if (url === '/api/files/share/list') return links
    if (url.includes('share-user')) return { shares: [], owner: null }
    return []
  }

  it('서버가 미리보기 불가(null)라고 하면 "다운로드 막음" 비활성 + 이유', async () => {
    api.handler = base({ preview: null, is_file: true })
    inRouter(<FilesFileShareModal items={[item('app.zip')]} initialTab="link" />)
    expect(await screen.findByText(REASON)).toBeTruthy()
    const call = api.calls.find(c => c.url === '/api/files/share/preview-kind')!
    expect(call.opts.params).toEqual({ path: 'my/app.zip' })
    const opt = await nodlOption()
    expect(isDisabled(opt)).toBe(true)
    expect(opt.textContent).toContain('미리보기 안 되는 형식')
  })

  it('미리보기 되는 파일이면 그대로 고를 수 있다', async () => {
    api.handler = base({ preview: 'text', is_file: true })
    inRouter(<FilesFileShareModal items={[item('a.txt')]} initialTab="link" />)
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/files/share/preview-kind')).toBe(true))
    expect(isDisabled(await nodlOption())).toBe(false)
    expect(screen.queryByText(REASON)).toBeNull()
  })

  it('판정을 못 받으면(구버전 서버·오류) 막지 않는다 — 서버 400 이 마지막 방어', async () => {
    api.handler = (url) => {
      if (url === '/api/files/share/preview-kind') throw Object.assign(new Error('500'), { statusCode: 500 })
      return base(null)(url)
    }
    inRouter(<FilesFileShareModal items={[item('app.zip')]} initialTab="link" />)
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/files/share/preview-kind')).toBe(true))
    expect(isDisabled(await nodlOption())).toBe(false)
    expect(screen.queryByText(REASON)).toBeNull()
  })

  it('폴더·묶음은 묻지 않는다(폴더 링크는 허용 유지)', async () => {
    api.handler = base({ preview: null })
    const r = inRouter(<FilesFileShareModal items={[item('docs', true)]} initialTab="link" />)
    expect(isDisabled(await nodlOption())).toBe(false)
    expect(api.calls.some(c => c.url === '/api/files/share/preview-kind')).toBe(false)
    r.unmount()
    inRouter(<FilesFileShareModal items={[item('a.zip'), item('b.zip')]} initialTab="link" />)
    await screen.findAllByRole('combobox', { name: t('files.shareModal.permission') })
    expect(api.calls.some(c => c.url === '/api/files/share/preview-kind')).toBe(false)
  })

  it('기존 링크 수정: can_block_download=false 면 막음으로 못 바꾼다(이유 표시), 이미 막힌 옛 링크는 그대로', async () => {
    api.handler = base({ preview: null }, [link({ can_block_download: false })])
    const r = inRouter(<FilesFileShareModal items={[item('app.zip')]} initialTab="link" />)
    fireEvent.click(await screen.findByRole('button', { name: t('files.shareModal.linkMenu') }))
    fireEvent.click(await screen.findByRole('menuitem', { name: t('files.shareModal.editLinkMenu') }))
    await waitFor(() => expect(screen.getAllByText(REASON).length).toBe(2))     // 수정 폼 + 새 링크 카드
    expect(isDisabled(await nodlOption(0))).toBe(true)
    r.unmount()

    files._resetFilesStore()
    api.handler = base({ preview: null }, [link({ can_block_download: false, allow_download: false })])
    inRouter(<FilesFileShareModal items={[item('app.zip')]} initialTab="link" />)
    fireEvent.click(await screen.findByRole('button', { name: t('files.shareModal.linkMenu') }))
    fireEvent.click(await screen.findByRole('menuitem', { name: t('files.shareModal.editLinkMenu') }))
    await waitFor(() => expect(screen.getAllByRole('combobox', { name: t('files.shareModal.permission') }).length).toBe(2))
    expect(isDisabled(await nodlOption(0))).toBe(false)        // 이미 막힌 값은 고른 채로 둔다(되돌릴 수 있게)
  })
})

describe('손님 화면 — 내려받기 막힘 + 미리보기 안 되는 형식', () => {
  const INFO = { name: 'app.zip', size: 10, is_office: false, can_edit: false, allow_download: false, requires_password: false,
    is_multi: false, is_folder: false, item_count: 1, expires_at: null, downloads_left: null, owner_name: '앨리스', exists: true }

  it('can_preview=false 면 [미리보기] 대신 안내', async () => {
    api.handler = url => (url === '/api/wopi/shared/tk/info' ? { ...INFO, can_preview: false } : {})
    mountGuest()
    expect(await screen.findByText(DEAD)).toBeTruthy()
    expect(screen.queryByText(t('share.preview'))).toBeNull()
    expect(screen.queryByText(t('share.download'))).toBeNull()
  })

  it('미리보기 되는 파일(또는 구버전 서버 — 값 없음)은 [미리보기] 그대로', async () => {
    api.handler = url => (url === '/api/wopi/shared/tk/info' ? { ...INFO, name: 'a.txt', can_preview: true } : {})
    const r = mountGuest()
    expect(await screen.findByText(t('share.preview'))).toBeTruthy()
    expect(screen.queryByText(DEAD)).toBeNull()
    r.unmount()
    api.handler = url => (url === '/api/wopi/shared/tk/info' ? { ...INFO } : {})
    mountGuest()
    expect(await screen.findByText(t('share.preview'))).toBeTruthy()
  })

  it('비밀번호 링크는 푼 뒤(unlock.can_preview=false) 안내', async () => {
    api.handler = (url) => {
      if (url === '/api/wopi/shared/tk/info') return { ...INFO, name: '', size: null, requires_password: true, can_preview: true }
      if (url === '/api/files/shared/tk/unlock') return { ok: true, access: 'AK', can_preview: false }
      if (url.startsWith('/api/files/shared/tk/list')) throw Object.assign(new Error('400'), { statusCode: 400 })
      return {}
    }
    mountGuest()
    fireEvent.change(await screen.findByLabelText(t('share.passwordLabel')), { target: { value: '1234' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('share.unlock') })) })
    expect(await screen.findByText(DEAD)).toBeTruthy()
    expect(screen.queryByText(t('share.preview'))).toBeNull()
  })

  it('비밀번호 링크의 원본이 지워졌으면(unlock.exists=false) "삭제됨" 이 먼저 — 형식 안내가 아니다', async () => {
    api.handler = (url) => {
      if (url === '/api/wopi/shared/tk/info') return { ...INFO, name: '', size: null, requires_password: true, can_preview: true }
      if (url === '/api/files/shared/tk/unlock') return { ok: true, access: 'AK', exists: false, can_preview: false }
      return {}
    }
    mountGuest()
    fireEvent.change(await screen.findByLabelText(t('share.passwordLabel')), { target: { value: '1234' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('share.unlock') })) })
    expect(await screen.findByText(t('share.result.gone.title'))).toBeTruthy()
    expect(screen.queryByText(DEAD)).toBeNull()
    expect(api.calls.some(c => c.url.startsWith('/api/files/shared/tk/list'))).toBe(false)
  })

  it('폴더 링크: 미리보기 안 되는 파일 줄에 이유(누를 것이 없는 줄)', async () => {
    const F = { ...INFO, name: 'docs.zip', is_multi: true, is_folder: true, can_preview: true }
    const row = (name: string, preview: string | null) => ({ name, path: name, is_dir: false, size: 5, modified_at: null, mime_type: null, preview })
    api.handler = (url) => {
      if (url === '/api/wopi/shared/tk/info') return F
      if (url.startsWith('/api/files/shared/tk/list')) return { name: 'docs', sub: '', allow_download: false, truncated: false, items: [row('a.txt', 'text'), row('app.zip', null)] }
      return {}
    }
    const r = mountGuest()
    const zip = (await screen.findByText('app.zip')).closest('li')!
    expect(zip.textContent).toContain('미리보기 불가')
    expect(zip.textContent).toContain(DEAD)
    expect((zip.querySelector('button') as HTMLButtonElement).disabled).toBe(true)
    const txt = screen.getByText('a.txt').closest('li')!
    expect(txt.textContent).not.toContain('미리보기 불가')
    r.unmount()

    // 내려받기 허용 링크면 안내 없음(받으면 되니까)
    api.handler = (url) => {
      if (url === '/api/wopi/shared/tk/info') return { ...F, allow_download: true }
      if (url.startsWith('/api/files/shared/tk/list')) return { name: 'docs', sub: '', allow_download: true, truncated: false, items: [row('app.zip', null)] }
      return {}
    }
    mountGuest()
    expect((await screen.findByText('app.zip')).closest('li')!.textContent).not.toContain('미리보기 불가')
  })
})
