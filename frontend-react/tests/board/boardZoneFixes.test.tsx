// 게시판 구역 전수조사 수정 고정:
//  글 수정 — 본문을 건드리지 않아도 저장된다 · 고정/필독은 바꿀 수 있는 사람만 보낸다 · 첨부를 다 지우면 빈 목록을 보낸다
//  임시글 — 제목 없는 임시글이 복원 직후 지워지지 않고, 바로 올릴 수 있다
//  본문 정화 — 자리·겹침 스타일(position 등)만 지우고 정렬·색은 남긴다
//  스토어 — 늦게 온 이전 응답을 버린다 · 목록 실패를 빈 목록과 구분한다 · 댓글 수를 맞춘다
//  댓글 @멘션 — 한글 조합 중 Enter 로 후보를 넣지 않는다
//  편집 툴바 [본문 ▾] — 목록이 툴바(overflow) 밖 body 에 그려진다
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts: any }[],
  handler: (_url: string, _opts: any): any => [],
}))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts: any = {}) => { api.calls.push({ url, opts }); return api.handler(url, opts) }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { default: WritePage } = await import('~/pages/board/[boardId]/write')
const { default: BoardIndexPage } = await import('~/pages/board/index')
const { setAppRouter } = await import('~/lib/router')
const { setUser } = await import('~/composables/useAuth')
const board = await import('~/composables/useBoard')
const { stripLayoutStyles, textOfHtml } = await import('~/components/editor/safeHtml')
const { boardPageNumbers } = await import('~/components/board/BoardPagination')
const { BoardCommentInput } = await import('~/components/board/BoardCommentInput')
const { UiEditorToolbar } = await import('~/components/ui/EditorToolbar')
const { i18n } = await import('~/i18n')
const { Editor } = await import('@tiptap/core')
const { default: StarterKit } = await import('@tiptap/starter-kit')

const BOARD = { id: 'b1', name: '자유', slug: 'free', categories: ['질문'], notice_permission: 'admin', allow_comments: true, allow_reactions: true, comment_permission: 'all' }
const POST = {
  id: 'p1', board_id: 'b1', author: { id: 'u1', username: 'qa', display_name: '검수', avatar_url: null },
  title: '원래 제목', content: '<p>원래 본문</p>', category: '질문', is_pinned: false, is_must_read: false, must_read_expires_at: null,
  view_count: 1, comment_count: 2, attachments: [{ name: 'a.txt', url: '/s/1', size: 10 }], reactions: [], is_bookmarked: false, is_edited: false,
  created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
}

function baseHandler(url: string, opts: any): any {
  if (url === '/api/board/boards') return [BOARD]
  if (url === '/api/board/unread-counts') return { counts: {}, total: 0 }
  if (url === '/api/board/posts/p1' && (!opts.method || opts.method === 'GET')) return { ...POST }
  if (url === '/api/board/posts/p1' && opts.method === 'PATCH') return { ...POST, ...opts.body }
  if (url === '/api/board/boards/b1/posts' && opts.method === 'POST') return { ...POST, id: 'new', ...opts.body }
  return []
}

function user(is_admin = false) {
  setUser({ id: 'u1', username: 'qa', display_name: '검수', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin, last_login_at: null } as any)
}

function renderWrite(path: string) {
  const router = createMemoryRouter([{ path: '/board/:boardId/write', element: <WritePage /> }, { path: '*', element: <div /> }], { initialEntries: [path] })
  return render(<RouterProvider router={router} />)
}
const patchCall = () => api.calls.find(c => c.url === '/api/board/posts/p1' && c.opts.method === 'PATCH')
const postCall = () => api.calls.find(c => c.url === '/api/board/boards/b1/posts' && c.opts.method === 'POST')

beforeEach(() => {
  api.calls = []
  api.handler = baseHandler
  board._resetBoardStore()
  localStorage.clear()
  user(false)
})

describe('글 수정(write?edit=)', () => {
  it('본문을 건드리지 않고 제목만 고쳐도 저장된다 — 저장된 본문을 그대로 보내고, 일반 사용자는 고정·필독을 보내지 않는다', async () => {
    const { container } = renderWrite('/board/b1/write?edit=p1')
    await waitFor(() => expect(container.querySelector('[contenteditable="true"]')?.textContent).toContain('원래 본문'))
    const title = screen.getByPlaceholderText(i18n.t('board.write.titlePlaceholder')) as HTMLInputElement
    expect(title.value).toBe('원래 제목')
    fireEvent.change(title, { target: { value: '고친 제목' } })
    fireEvent.click(screen.getAllByRole('button', { name: i18n.t('common.save') })[0])
    await waitFor(() => expect(patchCall()).toBeTruthy())
    const body = patchCall()!.opts.body
    expect(body.title).toBe('고친 제목')
    expect(body.content).toBe('<p>원래 본문</p>')
    expect(body.category).toBe('질문')
    expect('is_pinned' in body).toBe(false)
    expect('is_must_read' in body).toBe(false)
    expect(body.attachments).toEqual([{ name: 'a.txt', url: '/s/1', size: 10 }])
  })

  it('첨부를 다 지우면 빈 목록을 보낸다(null 이면 서버가 "안 바꿈"으로 본다)', async () => {
    const { container } = renderWrite('/board/b1/write?edit=p1')
    await waitFor(() => expect(container.querySelector('[contenteditable="true"]')?.textContent).toContain('원래 본문'))
    fireEvent.click(screen.getByRole('button', { name: i18n.t('board.write.removeAttachment', { name: 'a.txt' }) }))
    fireEvent.click(screen.getAllByRole('button', { name: i18n.t('common.save') })[0])
    await waitFor(() => expect(patchCall()).toBeTruthy())
    expect(patchCall()!.opts.body.attachments).toEqual([])
  })

  it('고정·필독을 바꿀 수 있는 사람(관리자)은 값을 보낸다', async () => {
    user(true)
    const { container } = renderWrite('/board/b1/write?edit=p1')
    await waitFor(() => expect(container.querySelector('[contenteditable="true"]')?.textContent).toContain('원래 본문'))
    fireEvent.click(screen.getAllByRole('button', { name: i18n.t('common.save') })[0])
    await waitFor(() => expect(patchCall()).toBeTruthy())
    expect(patchCall()!.opts.body).toMatchObject({ is_pinned: false, is_must_read: false })
  })
})

describe('임시글(새 글)', () => {
  it('제목 없는 임시글은 복원 뒤에도 남고, 본문을 건드리지 않고 올릴 수 있다', async () => {
    localStorage.setItem('board-draft:b1', JSON.stringify({ title: '', html: '<p>본문만 쓴 임시글</p>', category: null, isPinned: false, isMustRead: false, attachments: [], at: Date.now() }))
    const { container } = renderWrite('/board/b1/write')
    await waitFor(() => expect(container.querySelector('[contenteditable="true"]')?.textContent).toContain('본문만 쓴 임시글'))
    // 임시 저장 디바운스(800ms)가 지난 뒤에도 지워지지 않는다
    await act(async () => { await new Promise(r => setTimeout(r, 950)) })
    expect(JSON.parse(localStorage.getItem('board-draft:b1') || 'null')?.html).toBe('<p>본문만 쓴 임시글</p>')

    fireEvent.change(screen.getByPlaceholderText(i18n.t('board.write.titlePlaceholder')), { target: { value: '제목' } })
    fireEvent.click(screen.getAllByRole('button', { name: i18n.t('board.write.publish') })[0])
    await waitFor(() => expect(postCall()).toBeTruthy())
    expect(postCall()!.opts.body).toMatchObject({ title: '제목', content: '<p>본문만 쓴 임시글</p>', attachments: null })
    // 올린 뒤에는 임시글이 되살아나지 않는다(남은 저장 예약 취소)
    await act(async () => { await new Promise(r => setTimeout(r, 950)) })
    expect(localStorage.getItem('board-draft:b1')).toBeNull()
  }, 10_000)
})

describe('본문 정화 — 자리·겹침 스타일', () => {
  it('position·inset·z-index·transform·음수 여백은 지우고 정렬·색·너비는 남긴다', () => {
    const out = stripLayoutStyles(
      '<p style="text-align:center;color:red">가운데</p>'
      + '<a href="https://x.test" style="position:fixed;inset:0;top:0;left:0;z-index:9999;width:100px">덮기</a>'
      + '<div style="transform:translate(-50%,-50%);margin-top:-300px;margin-left:4px;opacity:0;pointer-events:none">x</div>'
      + '<td style="width: 120px">칸</td>',
    )
    const doc = new DOMParser().parseFromString(`<body>${out}</body>`, 'text/html')
    const p = doc.querySelector('p') as HTMLElement
    expect(p.style.textAlign).toBe('center')
    expect(p.style.color).toBe('red')
    const a = doc.querySelector('a') as HTMLElement
    expect(a.getAttribute('href')).toBe('https://x.test')
    expect(a.getAttribute('style') || '').not.toMatch(/position|inset|z-index|top|left/)
    expect(a.style.width).toBe('100px')
    const div = doc.querySelector('div') as HTMLElement
    expect(div.getAttribute('style') || '').not.toMatch(/transform|margin-top|opacity|pointer-events/)
    expect(div.style.marginLeft).toBe('4px')
  })
  it('style 이 없으면 그대로, 남는 것이 없으면 속성째 지운다', () => {
    expect(stripLayoutStyles('<p>글</p>')).toBe('<p>글</p>')
    expect(stripLayoutStyles('<p style="position:absolute">글</p>')).toBe('<p>글</p>')
    expect(textOfHtml('<p>가 <b>나</b></p>')).toBe('가 나')
  })
})

describe('쪽 번호', () => {
  it('7쪽까지 전부, 그 뒤로는 말줄임', () => {
    expect(boardPageNumbers(1, 3)).toEqual([1, 2, 3])
    expect(boardPageNumbers(5, 10)).toEqual([1, '...', 4, 5, 6, '...', 10])
    expect(boardPageNumbers(1, 10)).toEqual([1, 2, '...', 10])
  })
})

describe('북마크 · 내가 쓴 글 · 검색 — 쪽 넘김', () => {
  it('20건이 넘으면 쪽 번호가 나오고, 누르면 그 쪽을 불러온다', async () => {
    const row = (i: number) => ({ ...POST, id: `p${i}`, title: `글 ${i}`, has_attachments: false })
    api.handler = (url: string, opts: any) => {
      if (url === '/api/board/bookmarks') {
        const page = opts?.params?.page ?? 1
        return { posts: [row(page * 100)], total: 45, page, page_size: 20 }
      }
      return baseHandler(url, opts)
    }
    const router = createMemoryRouter([{ path: '/board', element: <BoardIndexPage /> }, { path: '*', element: <div /> }], { initialEntries: ['/board?view=bookmarks'] })
    setAppRouter(router as any)
    render(<RouterProvider router={router} />)
    await screen.findByText('글 100')
    const nav = screen.getByRole('navigation', { name: i18n.t('board.pagination.label') })
    expect(nav.textContent).toContain('3')   // 45건 = 3쪽
    fireEvent.click(screen.getByRole('button', { name: i18n.t('board.pagination.page', { n: 2 }) }))
    await screen.findByText('글 200')
    expect(api.calls.filter(c => c.url === '/api/board/bookmarks').map(c => c.opts.params.page)).toEqual(expect.arrayContaining([1, 2]))
    expect(screen.getByRole('button', { name: i18n.t('board.pagination.page', { n: 2 }) }).getAttribute('aria-current')).toBe('page')
    setAppRouter(null)
  })
})

describe('useBoard 스토어', () => {
  it('글: 늦게 온 이전 응답은 버린다', async () => {
    const waits: Record<string, (v: any) => void> = {}
    api.handler = (url: string) => {
      const m = /^\/api\/board\/posts\/(\w+)$/.exec(url)
      if (m) return new Promise(res => { waits[m[1]] = res })
      return baseHandler(url, {})
    }
    const a = board.fetchPost('a')
    const b = board.fetchPost('b')
    waits.b({ ...POST, id: 'b' })
    await b
    expect(board.boardStore.getState().currentPost?.id).toBe('b')
    waits.a({ ...POST, id: 'a' })
    await a
    expect(board.boardStore.getState().currentPost?.id).toBe('b')
    expect(board.boardStore.getState().loadingPost).toBe(false)
  })

  it('목록: 실패는 postsError, 늦게 온 다른 게시판 응답은 버린다', async () => {
    api.handler = (url: string) => { if (url.endsWith('/posts')) throw new Error('boom'); return baseHandler(url, {}) }
    await board.fetchPosts('b1')
    expect(board.boardStore.getState().postsError).toBe(true)

    const waits: Record<string, (v: any) => void> = {}
    api.handler = (url: string) => new Promise(res => { waits[url] = res })
    const one = board.fetchPosts('b1')
    const two = board.fetchPosts('b2')
    const page = (id: string) => ({ pinned: [], posts: [{ ...POST, id }], total: 1, page: 1, page_size: 20 })
    waits['/api/board/boards/b2/posts'](page('from-b2'))
    await two
    waits['/api/board/boards/b1/posts'](page('from-b1'))
    await one
    const s = board.boardStore.getState()
    expect(s.posts.map(p => p.id)).toEqual(['from-b2'])
    expect(s.postsError).toBe(false)
    expect(s.loadingPosts).toBe(false)
  })

  it('댓글을 달고 지우면 글 머리의 댓글 수가 맞는다', async () => {
    api.handler = (url: string, opts: any) => {
      if (url === '/api/board/posts/p1/comments' && opts.method === 'POST') return { id: 'c1' }
      return baseHandler(url, opts)
    }
    await board.fetchPost('p1')
    expect(board.boardStore.getState().currentPost?.comment_count).toBe(2)
    await board.createComment('p1', '새 댓글')
    expect(board.boardStore.getState().currentPost?.comment_count).toBe(3)
    await board.deleteComment('c1')
    expect(board.boardStore.getState().currentPost?.comment_count).toBe(2)
  })
})

describe('댓글 @멘션 — 한글 조합', () => {
  it('조합 중 Enter 는 후보를 넣지 않고, 조합이 끝난 Enter 는 넣는다', async () => {
    api.handler = (url: string) => (url === '/api/board/mention-users' ? [{ id: 'u2', username: 'kim', display_name: '김서연', avatar_url: null }] : [])
    render(<BoardCommentInput postId="p1" />)
    const box = screen.getByRole('combobox') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: '@김', selectionStart: 2, selectionEnd: 2 } })
    await waitFor(() => expect(box.getAttribute('aria-expanded')).toBe('true'))

    fireEvent.keyDown(box, { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(box.value).toBe('@김')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(box.value).toBe('@kim ')
  })
})

describe('편집 툴바 [본문 ▾]', () => {
  it('목록은 툴바 밖(body)에 fixed 로 그려지고, 고르면 블록 형식이 바뀐다', async () => {
    const editor = new Editor({ extensions: [StarterKit], content: '<p>글</p>' })
    const { container } = render(<UiEditorToolbar editor={editor as any} />)
    const toolbar = container.querySelector('[role="toolbar"]')!
    fireEvent.click(screen.getByRole('button', { name: i18n.t('ui.editor.blockType') }))
    const list = await screen.findByRole('listbox')
    expect(toolbar.contains(list)).toBe(false)
    expect(list.parentElement).toBe(document.body)
    expect(list.className.split(/\s+/)).toEqual(expect.arrayContaining(['fixed', 'z-overlay']))
    fireEvent.click(screen.getByRole('option', { name: i18n.t('ui.editor.heading', { n: 2 }) }))
    expect(editor.isActive('heading', { level: 2 })).toBe(true)
    expect(screen.queryByRole('listbox')).toBeNull()
    editor.destroy()
  })
})
