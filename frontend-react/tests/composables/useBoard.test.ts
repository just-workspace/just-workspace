// 게시판 store — 목록 요청 매개변수, 리액션 "내가 누름", 모두 읽음, init 한 번
import { describe, it, expect, vi, beforeEach } from 'vitest'

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

const board = await import('~/composables/useBoard')
const { boardStore } = board
const { authStore } = await import('~/composables/useAuth')

const post = (id: string, o: Record<string, unknown> = {}): any => ({ id, board_id: 'b1', title: id, is_read: false, ...o })

beforeEach(() => {
  board._resetBoardStore()
  authStore.setState({ user: { id: 'me' } as any })
  api.calls = []
  api.handler = () => ({})
})

describe('useBoard', () => {
  it('selectBoard 는 거르기·정렬을 초기화하고 첫 페이지를 요청한다', async () => {
    boardStore.setState({ boards: [{ id: 'b1', name: 'B' } as any], selectedCategory: 'x', sortBy: 'views', pagination: { total: 99, page: 4, page_size: 20 } })
    api.handler = () => ({ pinned: [post('p0')], posts: [post('p1')], total: 1, page: 1, page_size: 20 })
    await board.selectBoard('b1')
    expect(api.calls[0]).toMatchObject({ url: '/api/board/boards/b1/posts', opts: { params: { page: 1, page_size: 20, sort: 'latest' } } })
    expect(api.calls[0].opts.params.category).toBeUndefined()
    const s = boardStore.getState()
    expect(s.currentBoard?.id).toBe('b1')
    expect(s.pinnedPosts.map(p => p.id)).toEqual(['p0'])
    expect(s.pagination).toEqual({ total: 1, page: 1, page_size: 20 })
  })

  it('setCategory 는 category 매개변수를 붙여 1쪽부터', async () => {
    boardStore.setState({ currentBoard: { id: 'b1' } as any, pagination: { total: 0, page: 3, page_size: 20 } })
    api.handler = () => ({ pinned: [], posts: [], total: 0, page: 1, page_size: 20 })
    await board.setCategory('공지')
    expect(api.calls[0].opts.params).toEqual({ page: 1, page_size: 20, sort: 'latest', category: '공지' })
  })

  it('fetchPost 는 내 id 로 reacted 를 계산하고 안 읽은 수를 다시 받는다', async () => {
    api.handler = (url) => (url === '/api/board/unread-counts'
      ? { counts: { b1: 2 }, total: 2 }
      : { id: 'p1', reactions: [{ emoji: '👍', count: 2, user_ids: ['me', 'x'] }, { emoji: '🔥', count: 1, user_ids: ['x'] }] })
    await board.fetchPost('p1')
    await Promise.resolve()
    const r = boardStore.getState().currentPost!.reactions
    expect(r.map(x => x.reacted)).toEqual([true, false])
    expect(api.calls.map(c => c.url)).toContain('/api/board/unread-counts')
  })

  it('markBoardRead 는 그 게시판 글만 읽음으로 바꾸고 필독을 다시 읽는다', async () => {
    boardStore.setState({ posts: [post('p1'), post('p2', { board_id: 'b2' })], pinnedPosts: [post('p3')], unreadCounts: { b1: 3, b2: 1 } })
    api.handler = (url) => (url === '/api/board/must-read' ? [] : {})
    await board.markBoardRead('b1')
    const s = boardStore.getState()
    expect(s.posts.map(p => p.is_read)).toEqual([true, false])
    expect(s.pinnedPosts[0].is_read).toBe(true)
    expect(s.unreadCounts).toEqual({ b1: 0, b2: 1 })
    expect(api.calls.map(c => c.url)).toEqual(['/api/board/boards/b1/read-all', '/api/board/must-read'])
  })

  it('init 은 cleanup 전까지 한 번만', async () => {
    api.handler = (url) => (url === '/api/board/unread-counts' ? { counts: {} } : [])
    await board.init()
    await board.init()
    expect(api.calls).toHaveLength(3)
    board.cleanup()
    await board.init()
    expect(api.calls).toHaveLength(6)
  })

  it('createComment 는 parent_id 가 있을 때만 붙이고 댓글을 다시 받는다', async () => {
    api.handler = (url, opts) => (opts.method === 'POST' ? { id: 'c1' } : [])
    await board.createComment('p1', '내용', null)
    expect(api.calls[0].opts.body).toEqual({ content: '내용' })
    await board.createComment('p1', '답', 'c0')
    expect(api.calls[2].opts.body).toEqual({ content: '답', parent_id: 'c0' })
    expect(api.calls[3].url).toBe('/api/board/posts/p1/comments')
  })
})
