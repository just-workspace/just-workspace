// 파일·오피스 모듈(r1/files-office) — 메뉴 항목 규칙, 댓글 hook, 목록 클릭·선택·인라인 이름 변경, 전송 패널 머리, 공유 모달 기본 탭,
// 오피스 여는 중 문구(i18n-t 대체), 공유 링크 손님 화면 분기. ($fetch 는 모의(mock))
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, renderHook } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts: any }[],
  handler: (_url: string, _opts: any): any => ({}),
}))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts: any = {}) => { api.calls.push({ url, opts }); return api.handler(url, opts) }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { i18n } = await import('~/i18n')
const files = await import('~/composables/useFiles')
const { fileMenuItems } = await import('~/components/files/FileContextMenu')
const { useFileComments } = await import('~/composables/useFileComments')
const { FilesFileList } = await import('~/components/files/FileList')
const { FilesTransferPanel } = await import('~/components/files/TransferPanel')
const transfers = await import('~/composables/useTransfers')
const { FilesFileShareModal } = await import('~/components/files/FileShareModal')
const { setUser } = await import('~/composables/useAuth')
const { resetSharedState } = await import('~/lib/state')

const t = (k: string, p?: Record<string, unknown>) => i18n.t(k, p as any)
const item = (name: string, o: Record<string, unknown> = {}) => ({ name, path: `my/${name}`, is_dir: false, size: 10, modified_at: null, mime_type: null, ...o }) as import('~/composables/useFiles').FileItem

function inRouter(ui: React.ReactElement, path = '/') {
  const router = createMemoryRouter([{ path: '*', element: ui }], { initialEntries: [path] })
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  files._resetFilesStore()
  transfers._resetTransfersStore()
  resetSharedState()
  api.calls = []
  api.handler = () => ({})
  setUser({ id: 'u1', username: 'me', display_name: '나', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: false, last_login_at: null } as any)
})

describe('FileContextMenu 항목', () => {
  const keys = (it: any, inSearch = false) => fileMenuItems(it, inSearch, k => k).map(x => x.key)
  it('내 파일: 열기·공유·채널·이동·이름·버전·다운로드·별·상세·휴지통 순', () => {
    expect(keys(item('a.txt'))).toEqual(['open', 'share', 'channel', 'move', 'rename', 'versions', 'download', 'star', 'detail', 'delete'])
  })
  it('폴더: 채널·버전 없음, 검색 결과면 위치 열기', () => {
    expect(keys(item('d', { is_dir: true }), true)).toEqual(['open', 'share', 'move', 'rename', 'download', 'star', 'detail', 'location', 'delete'])
  })
  it('공유받은 항목: 보기 권한은 열기·다운로드·상세만, 공동 소유는 공유·이동(안쪽만)·이름·휴지통까지', () => {
    expect(keys({ ...item('x'), path: 'shared-with-me/s1', role: 'view' })).toEqual(['open', 'download', 'detail'])
    expect(keys({ ...item('x'), path: 'shared-with-me/s1', role: 'owner' })).toEqual(['open', 'share', 'rename', 'download', 'detail', 'delete'])
    expect(keys({ ...item('x'), path: 'shared-with-me/s1/sub/x', role: 'owner' })).toEqual(['open', 'share', 'move', 'rename', 'download', 'detail', 'delete'])
  })
})

describe('useFileComments', () => {
  it('load·add·edit·remove 요청과 목록 갱신', async () => {
    api.handler = (url, opts) => {
      if (url === '/api/files/comments' && !opts.method) return { items: [{ id: 'c1', content: 'a' }], can_comment: true, role: 'owner' }
      if (url === '/api/files/comments' && opts.method === 'POST') return { id: 'c2', content: opts.body.content }
      if (url === '/api/files/comments/c1' && opts.method === 'PATCH') return { id: 'c1', content: opts.body.content }
      return {}
    }
    const { result } = renderHook(() => useFileComments('my/a.txt'))
    await act(async () => { await result.current.load() })
    expect(api.calls[0]).toMatchObject({ url: '/api/files/comments', opts: { params: { path: 'my/a.txt' } } })
    expect(result.current.items.map(c => c.id)).toEqual(['c1'])
    expect(result.current.canComment).toBe(true)
    await act(async () => { await result.current.add('b') })
    expect(result.current.items.map(c => c.id)).toEqual(['c1', 'c2'])
    await act(async () => { await result.current.edit('c1', 'z') })
    expect(result.current.items[0].content).toBe('z')
    await act(async () => { await result.current.remove('c2') })
    expect(api.calls.at(-1)).toMatchObject({ url: '/api/files/comments/c2', opts: { method: 'DELETE' } })
    expect(result.current.items.map(c => c.id)).toEqual(['c1'])
  })
  it('실패하면 비우고 error', async () => {
    api.handler = () => { throw Object.assign(new Error('x'), { data: { detail: '안 됨' } }) }
    const { result } = renderHook(() => useFileComments('my/a'))
    await act(async () => { await result.current.load() })
    expect(result.current.error).toBe('안 됨')
    expect(result.current.items).toEqual([])
  })
})

describe('FileList', () => {
  it('클릭 = 열기, Ctrl 클릭 = 선택 토글, Shift = 범위', () => {
    files.filesStore.setState({ items: [item('a'), item('b'), item('c')], loading: false })
    const onOpen = vi.fn()
    inRouter(<FilesFileList onOpen={onOpen} />)
    const rows = screen.getAllByRole('row').filter(r => r.getAttribute('aria-rowindex'))
    expect(rows).toHaveLength(3)
    fireEvent.click(rows[0])
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ path: 'my/a' }))
    fireEvent.click(rows[0], { ctrlKey: true })
    expect([...files.filesStore.getState().selectedItems]).toEqual(['my/a'])
    fireEvent.click(rows[2], { shiftKey: true })
    expect([...files.filesStore.getState().selectedItems].sort()).toEqual(['my/a', 'my/b', 'my/c'])
  })

  it('인라인 이름 바꾸기 — 확장자 앞까지 선택, Enter 로 확정', async () => {
    files.filesStore.setState({ items: [item('report.docx')], loading: false })
    const onCommitRename = vi.fn()
    inRouter(<FilesFileList onCommitRename={onCommitRename} />)
    act(() => files.setInlineEdit({ kind: 'rename', path: 'my/report.docx' }))
    const input = await screen.findByLabelText(t('files.list.newName')) as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('report.docx'))
    await waitFor(() => expect(input.selectionEnd).toBe(6))
    fireEvent.change(input, { target: { value: 'final.docx' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommitRename).toHaveBeenCalledWith(expect.objectContaining({ path: 'my/report.docx' }), 'final.docx')
  })

  it('빈 폴더는 빈 상태', () => {
    files.filesStore.setState({ items: [], loading: false })
    inRouter(<FilesFileList />)
    expect(screen.getByText(t('files.empty'))).toBeTruthy()
  })
})

describe('TransferPanel', () => {
  it('없으면 안 그린다 · 올리는 중 "1 / 2" · 모두 취소', () => {
    const { container } = inRouter(<FilesTransferPanel />)
    expect(container.querySelector('[role=region]')).toBeNull()
    const abort = vi.fn()
    act(() => {
      const a = transfers.addTransfer('a.bin', 'up', 100)
      transfers.patchTransfer(a.id, { _abort: abort })
      transfers.addTransfer('b.bin', 'up', 100, 'queued')
    })
    expect(screen.getByRole('status').textContent).toContain('1 / 2')
    fireEvent.click(screen.getByText(t('files.transfer.cancelAll')))
    expect(abort).toHaveBeenCalled()
  })
})

describe('FileShareModal', () => {
  it('기본 탭은 사람·채널, 링크 탭은 고를 때만 — 폴더 하나도 링크(paths 로 보냄, 주소는 /s/)', async () => {
    api.handler = (url, opts) => {
      if (url === '/api/files/users') return []
      if (url.startsWith('/api/files/share-info') || url.includes('share-user')) return { shares: [], owner: null }
      if (url === '/api/files/share' && opts?.method === 'POST') return { token: 'tk', id: 'l1', url: '', display_name: 'dir.zip', expires_at: null, max_downloads: null, created_at: '', is_folder: true }
      return []
    }
    inRouter(<FilesFileShareModal items={[item('dir', { is_dir: true })]} />)
    const tabs = await screen.findAllByRole('tab')
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    expect(tabs[0].textContent).toContain(t('files.shareModal.tabPeople'))
    fireEvent.click(tabs[1])
    expect(screen.queryByText(t('files.shareModal.noLinkFolder'))).toBeNull()
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: t('files.shareModal.createCopy') })) })
    const c = api.calls.find(x => x.url === '/api/files/share' && x.opts?.method === 'POST')
    expect(c?.opts.body).toMatchObject({ path: '', paths: ['my/dir'] })
  })
})

describe('office/open', () => {
  it('여는 중 — 10초 문구 안에 [미리보기로 열기] 버튼, 지원 안 하는 형식(400)은 다시 시도 없음', async () => {
    let fail = false
    api.handler = (url) => {
      if (url === '/api/wopi/open') {
        if (fail) throw Object.assign(new Error('400'), { statusCode: 400 })
        return new Promise(() => {})
      }
      return {}
    }
    const Page = (await import('~/pages/office/open')).default
    const r1 = inRouter(<Page />, '/office/open?path=my%2Fa.docx')
    expect(await screen.findByText(t('office.open.openPreview'))).toBeTruthy()
    const p = screen.getByText(t('office.open.openPreview')).closest('p')!
    expect(p.textContent).toContain(t('office.open.loadingEditor'))
    expect(p.textContent).not.toContain('{link}')
    r1.unmount()
    fail = true
    inRouter(<Page />, '/office/open?path=my%2Fa.hwp')
    expect(await screen.findByText(t('office.open.errUnsupported'))).toBeTruthy()
    expect(screen.queryByText(t('common.retry'))).toBeNull()
  })
})

describe('s/[token]', () => {
  it('만료 410 → 결과 화면, 비밀번호 링크 → 비밀번호 틀', async () => {
    const Page = (await import('~/pages/s/[token]')).default
    api.handler = (url) => {
      if (url === '/api/wopi/shared/t1/info') throw Object.assign(new Error('410'), { statusCode: 410 })
      if (url === '/api/wopi/shared/t2/info') return { name: '', size: null, is_office: false, can_edit: false, allow_download: true, requires_password: true, is_multi: false, item_count: 1, expires_at: null, downloads_left: null, owner_name: '김', exists: true }
      return {}
    }
    const router1 = createMemoryRouter([{ path: '/s/:token', element: <Page /> }], { initialEntries: ['/s/t1'] })
    const r1 = render(<RouterProvider router={router1} />)
    expect(await screen.findByText(t('share.result.expired.title'))).toBeTruthy()
    r1.unmount()
    const router2 = createMemoryRouter([{ path: '/s/:token', element: <Page /> }], { initialEntries: ['/s/t2'] })
    render(<RouterProvider router={router2} />)
    expect(await screen.findByText(t('share.passwordTitle'))).toBeTruthy()
    expect(screen.getByText(t('share.lockedFile'))).toBeTruthy()
  })
})
