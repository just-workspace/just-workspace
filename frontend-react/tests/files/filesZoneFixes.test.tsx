// 파일 구역 전수조사 수정 고정 — 늦게 온 목록 응답 버리기·읽기 실패 표시, 검색 중 이동/삭제/이름 변경,
// 여러 개 삭제의 일부 실패, 형식 모르는 항목 미리보기(확장자), 메뉴 Esc, 한글 조합 중 Enter. ($fetch 는 가짜)
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
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const files = await import('~/composables/useFiles')
const lib = await import('~/lib/files')
const { FilesFileList } = await import('~/components/files/FileList')
const { FilesFileShareModal } = await import('~/components/files/FileShareModal')
const { FilesFileCommandBar } = await import('~/components/files/FileCommandBar')
const { setUser } = await import('~/composables/useAuth')
const { resetSharedState } = await import('~/lib/state')

type Item = import('~/composables/useFiles').FileItem
const item = (name: string, o: Record<string, unknown> = {}) => ({ name, path: `my/${name}`, is_dir: false, size: 10, modified_at: null, mime_type: null, ...o }) as Item
const st = () => files.filesStore.getState()

function inRouter(ui: React.ReactElement) {
  const router = createMemoryRouter([{ path: '*', element: ui }], { initialEntries: ['/'] })
  return render(<RouterProvider router={router} />)
}
/** 밖에서 풀 수 있는 약속 */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  files._resetFilesStore()
  resetSharedState()
  api.calls = []
  api.handler = () => ({})
  setUser({ id: 'u1', username: 'me', display_name: '나', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: false, last_login_at: null } as any)
})

describe('목록 요청 순서', () => {
  it('늦게 온 앞 폴더 응답은 버린다(A 클릭 → B 클릭 → A 가 늦게 옴)', async () => {
    const a = deferred<any>()
    const b = deferred<any>()
    api.handler = (url, opts) => {
      if (url === '/api/files/list') return opts.params.path === 'my/A' ? a.promise : b.promise
      return { items: {} }
    }
    const pa = files.fetchFiles('my/A')
    const pb = files.fetchFiles('my/B')
    b.resolve({ path: 'my/B', items: [item('b.txt', { path: 'my/B/b.txt' })] })
    await pb
    expect(st().currentPath).toBe('my/B')
    expect(st().loading).toBe(false)
    a.resolve({ path: 'my/A', items: [item('a.txt', { path: 'my/A/a.txt' })] })
    await pa
    expect(st().currentPath).toBe('my/B')
    expect(st().items.map(i => i.name)).toEqual(['b.txt'])
  })

  it('읽기 실패는 빈 폴더가 아니라 오류 — 보던 목록·경로는 그대로, 다시 시도하면 그 폴더를 읽는다', async () => {
    files.filesStore.setState({ currentPath: 'my', items: [item('keep.txt')] })
    api.handler = (url) => {
      if (url === '/api/files/list') throw Object.assign(new Error('x'), { statusCode: 404, data: { detail: '경로를 찾을 수 없습니다' } })
      return { items: {} }
    }
    await files.fetchFiles('my/gone')
    expect(st().listError).toEqual({ path: 'my/gone', message: '경로를 찾을 수 없습니다', status: 404 })
    expect(st().currentPath).toBe('my')
    expect(st().items.map(i => i.name)).toEqual(['keep.txt'])

    inRouter(<FilesFileList />)
    expect(screen.getByText('"gone" 폴더를 찾을 수 없습니다')).toBeTruthy()
    expect(screen.queryByText('keep.txt')).toBeNull()

    api.handler = (url, opts) => (url === '/api/files/list' ? { path: opts.params.path, items: [item('ok.txt')] } : { items: {} })
    await act(async () => { await files.retryList() })
    expect(api.calls.filter(c => c.url === '/api/files/list').at(-1)!.opts.params.path).toBe('my/gone')
    expect(st().listError).toBeNull()
    expect(st().currentPath).toBe('my/gone')
  })

  it('늦게 온 앞 검색 응답은 버리고, 검색을 닫으면 떠 있던 응답도 버린다', async () => {
    const first = deferred<any>()
    api.handler = (url, opts) => {
      if (url === '/api/files/search') return opts.params.q === 'a' ? first.promise : { items: [item('ab.txt')] }
      return {}
    }
    const p1 = files.searchFiles('a')
    await files.searchFiles('ab')
    first.resolve({ items: [item('a-only.txt')] })
    await p1
    expect(st().searchResults.map(i => i.name)).toEqual(['ab.txt'])

    const late = deferred<any>()
    api.handler = () => late.promise
    const p2 = files.searchFiles('zz')
    files.exitSearch()
    expect(st().loading).toBe(false)
    late.resolve({ items: [item('zz.txt')] })
    await p2
    expect(st().searchActive).toBe(false)
    expect(st().searchResults).toEqual([])
  })
})

describe('검색 중 동작', () => {
  const searching = () => files.filesStore.setState({
    currentPath: 'my', searchActive: true, searchQuery: 'x',
    searchResults: [item('x1.txt', { path: 'my/d/x1.txt' }), item('x2.txt', { path: 'my/d/x2.txt' }), item('xd', { path: 'my/xd', is_dir: true }), item('in.txt', { path: 'my/xd/in.txt' })],
  })

  it('경로 바·사이드바로 옮기면 검색이 닫힌다', async () => {
    searching()
    api.handler = (url, opts) => (url === '/api/files/list' ? { path: opts.params.path, items: [] } : { items: {} })
    files.navigateToPath('my/other')
    expect(st().searchActive).toBe(false)
    expect(st().searchQuery).toBe('')
    await waitFor(() => expect(st().currentPath).toBe('my/other'))
  })

  it('지운 항목(폴더면 그 아래까지)·이름 바꾼 항목이 검색 결과에 바로 반영된다', async () => {
    searching()
    api.handler = (url, opts) => {
      if (url === '/api/files/list') return { path: 'my', items: [] }
      if (url === '/api/files/rename') return { ok: true, new_name: opts.body.new_name, path: `my/d/${opts.body.new_name}` }
      return {}
    }
    await files.deleteItems(['my/xd'])
    expect(st().searchResults.map(i => i.path)).toEqual(['my/d/x1.txt', 'my/d/x2.txt'])
    await files.renameItem('my/d/x1.txt', 'x9.txt')
    expect(st().searchResults.map(i => [i.path, i.name])).toEqual([['my/d/x9.txt', 'x9.txt'], ['my/d/x2.txt', 'x2.txt']])
    expect(st().searchActive).toBe(true)
  })
})

describe('여러 개 삭제', () => {
  it('하나가 실패해도 나머지를 지우고 목록을 새로 읽는다 — 실패한 경로를 실어 던진다', async () => {
    api.handler = (url, opts) => {
      if (url === '/api/files/delete' && opts.params.path === 'my/2') throw Object.assign(new Error('x'), { data: { detail: 'Not found' } })
      if (url === '/api/files/list') return { path: 'my', items: [item('2')] }
      return {}
    }
    const err: any = await files.deleteItems(['my/1', 'my/2', 'my/3']).catch(e => e)
    expect(err.failed).toEqual(['my/2'])
    expect(err.deleted).toBe(2)
    expect(err.data.detail).toBe('Not found')
    expect(api.calls.filter(c => c.url === '/api/files/delete').map(c => c.opts.params.path)).toEqual(['my/1', 'my/2', 'my/3'])
    expect(api.calls.some(c => c.url === '/api/files/list')).toBe(true)
    expect(st().items.map(i => i.name)).toEqual(['2'])
  })
})

describe('미리보기 형식', () => {
  it('형식(mime)을 모르면 확장자로 — 직접 공유받은 이미지·PDF', () => {
    expect(lib.previewKind({ name: '사진.PNG', mime_type: null })).toBe('image')
    expect(lib.previewKind({ name: 'a.pdf', mime_type: null })).toBe('pdf')
    expect(lib.previewKind({ name: 'a.txt', mime_type: null })).toBe('text')
    expect(lib.previewKind({ name: 'a.heic', mime_type: null })).toBeNull()   // 서버가 못 그리는 형식
    expect(lib.previewKind({ name: 'a.zip', mime_type: 'application/zip' })).toBeNull()
    expect(lib.previewKind({ name: 'd.png', is_dir: true })).toBeNull()
  })
  it('문구 키가 아직 없으면 기본 문구에 값을 끼운다', () => {
    const t = (k: string) => k
    expect(lib.textOr(t, 'x.y', '{n}개: {list}', { n: 2, list: 'a, b' })).toBe('2개: a, b')
    expect(lib.textOr(() => '번역됨', 'x.y', '기본')).toBe('번역됨')
  })
})

describe('Esc · 한글 조합', () => {
  it('공유 창 링크 ⋮ 메뉴에서 Esc = 메뉴만 닫힘(공유 창은 그대로)', async () => {
    const onClose = vi.fn()
    api.handler = (url) => {
      if (url === '/api/files/share/list') return [{ id: 'l1', token: 'tok', display_name: 'a.txt', file_path: 'my/a.txt', expires_at: null, max_downloads: null, download_count: 0, created_at: '2026-01-01T00:00:00Z', paths: ['my/a.txt'] }]
      if (url === '/api/files/share-user/list') return { shares: [], owner: null, my_role: 'owner' }
      return []
    }
    inRouter(<FilesFileShareModal items={[item('a.txt')]} initialTab="link" onClose={onClose} />)
    const more = await screen.findByRole('button', { name: /링크 메뉴|more|메뉴/i, expanded: false })
    fireEvent.click(more)
    expect(screen.getByRole('menu')).toBeTruthy()
    more.focus()
    fireEvent.keyDown(more, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    // 메뉴가 닫힌 뒤의 Esc 는 예전처럼 공유 창을 닫는다
    fireEvent.keyDown(more, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('"새로 만들기" 메뉴에서 Esc = 메뉴만 닫힘(페이지로 안 올라감)', () => {
    const pageEsc = vi.fn()
    const { container } = inRouter(<div onKeyDown={(e) => { if (e.key === 'Escape') pageEsc() }}><FilesFileCommandBar /></div>)
    const btn = container.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement
    fireEvent.click(btn)
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(btn, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(pageEsc).not.toHaveBeenCalled()
  })

  it('이름 바꾸기: 조합 중 Enter 는 확정이 아니다, 조합이 끝난 Enter 만 확정', async () => {
    files.filesStore.setState({ currentPath: 'my', items: [item('a.txt')] })
    const onCommitRename = vi.fn()
    inRouter(<FilesFileList onCommitRename={onCommitRename} />)
    act(() => { files.setInlineEdit({ kind: 'rename', path: 'my/a.txt' }) })
    const input = (await screen.findAllByRole('textbox')).find(el => (el as HTMLInputElement).value === 'a.txt') as HTMLInputElement
    fireEvent.change(input, { target: { value: '가.txt' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    expect(onCommitRename).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommitRename).toHaveBeenCalledTimes(1)
    expect(onCommitRename.mock.calls[0][1]).toBe('가.txt')
  })

  it('isComposingKey', () => {
    expect(lib.isComposingKey({ nativeEvent: { isComposing: true } })).toBe(true)
    expect(lib.isComposingKey({ keyCode: 229 })).toBe(true)
    expect(lib.isComposingKey({ nativeEvent: { isComposing: false }, keyCode: 13 })).toBe(false)
  })
})
