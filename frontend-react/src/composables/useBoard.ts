/**
 * 게시판(모듈 싱글턴 상태 + API 호출).
 *
 * React: const { boards, posts, fetchPost, ... } = useBoard()   — 값은 렌더 시점 값
 * 컴포넌트 밖: boardStore.getState().posts, 동작 함수는 모듈 export 를 직접 import.
 */
import { createStore, useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { $fetch } from '~/lib/api'
import { authStore } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import { i18n } from '~/i18n'

export interface BoardInfo {
  id: string
  name: string
  slug: string
  description: string | null
  categories: string[]
  sort_order: number
  write_permission: string
  notice_permission: string
  comment_permission: string
  allow_comments: boolean
  allow_reactions: boolean
  created_at: string
  updated_at: string
}

export interface AuthorInfo {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
}

export interface PostSummary {
  id: string
  board_id: string
  author: AuthorInfo | null
  title: string
  category: string | null
  is_pinned: boolean
  is_must_read: boolean
  view_count: number
  comment_count: number
  has_attachments: boolean
  is_edited: boolean
  created_at: string
  updated_at: string
  board_name?: string
  /** 안 읽음 표시. 목록·인덱스 카드·내가 쓴 글 응답에 포함된다(검색·북마크에는 없음 → 필독 기준) */
  is_read?: boolean
}

export interface ReactionGroup {
  emoji: string
  count: number
  user_ids: string[]
  reacted: boolean
}

export interface PostDetail {
  id: string
  board_id: string
  author: AuthorInfo | null
  title: string
  content: string
  category: string | null
  is_pinned: boolean
  is_must_read: boolean
  must_read_expires_at: string | null
  view_count: number
  comment_count: number
  attachments: Array<{ name: string; url: string; size?: number }>
  reactions: ReactionGroup[]
  is_bookmarked: boolean
  is_edited: boolean
  created_at: string
  updated_at: string
}

export interface CommentInfo {
  id: string
  post_id: string
  author: AuthorInfo | null
  parent_id: string | null
  content: string
  attachments: Array<{ name: string; url: string; size?: number }>
  is_edited: boolean
  is_deleted: boolean
  created_at: string
  updated_at: string
  replies?: CommentInfo[]
  /** 서버가 해석한 @멘션(활성 사용자만, 작성자 본인 제외) */
  mentions?: MentionUser[]
}

export interface MentionUser {
  id: string
  username: string
  display_name: string | null
  avatar_url?: string | null
}

interface PostListResponse {
  pinned: PostSummary[]
  posts: PostSummary[]
  total: number
  page: number
  page_size: number
}

interface SearchResponse {
  posts: PostSummary[]
  total: number
  page: number
  page_size: number
}

export type BoardSort = 'latest' | 'views' | 'comments'

export interface BoardState {
  boards: BoardInfo[]
  currentBoard: BoardInfo | null
  posts: PostSummary[]
  pinnedPosts: PostSummary[]
  currentPost: PostDetail | null
  comments: CommentInfo[]
  pagination: { total: number; page: number; page_size: number }
  selectedCategory: string | null
  sortBy: BoardSort
  mustReadPosts: PostSummary[]
  /** 게시판별 안 읽은 글 수(GET /unread-counts) — 본인 글·열람한 글·"모두 읽음" 이전 글 제외. null = 미확인 */
  unreadCounts: Record<string, number> | null
  loadingBoards: boolean
  loadingPosts: boolean
  loadingPost: boolean
  loadingComments: boolean
  /** 글 목록 수신 실패(빈 목록과 구분 — 목록 화면이 오류 타일을 렌더링한다) */
  postsError: boolean
}

const initial = (): BoardState => ({
  boards: [],
  currentBoard: null,
  posts: [],
  pinnedPosts: [],
  currentPost: null,
  comments: [],
  pagination: { total: 0, page: 1, page_size: 20 },
  selectedCategory: null,
  sortBy: 'latest',
  mustReadPosts: [],
  unreadCounts: null,
  loadingBoards: false,
  loadingPosts: false,
  loadingPost: false,
  loadingComments: false,
  postsError: false,
})

// Module-level singleton state
export const boardStore = createStore<BoardState>()(() => initial())

let _initialized = false
// 빠른 연속 이동 시 지연 도착한 이전 응답이 현재 화면을 덮지 않도록 요청마다 순번을 부여하여 마지막 요청만 반영한다
let _postsSeq = 0
let _postSeq = 0
let _commentsSeq = 0

/** 테스트용 */
export function _resetBoardStore() { boardStore.setState(initial()); _initialized = false }

const set = (p: Partial<BoardState>) => boardStore.setState(p)
const get = () => boardStore.getState()
const uid = () => authStore.getState().user?.id

// ─── Boards ───

export async function fetchBoards() {
  set({ loadingBoards: true })
  try {
    const data = await $fetch<BoardInfo[]>('/api/board/boards')
    set({ boards: data })
  } catch (e: any) {
    console.error('fetchBoards error:', e)
  } finally {
    set({ loadingBoards: false })
  }
}

export async function selectBoard(boardId: string) {
  set({
    currentBoard: get().boards.find(b => b.id === boardId) || null,
    selectedCategory: null,
    sortBy: 'latest',
    pagination: { ...get().pagination, page: 1 },
  })
  await fetchPosts(boardId)
}

export async function createBoard(data: {
  name: string
  slug: string
  description?: string
  categories?: string[]
  write_permission?: string
  notice_permission?: string
  comment_permission?: string
  allow_comments?: boolean
  allow_reactions?: boolean
}) {
  const result = await $fetch<BoardInfo>('/api/board/boards', {
    method: 'POST',
    body: data,
  })
  await fetchBoards()
  return result
}

export async function updateBoard(boardId: string, data: Record<string, any>) {
  await $fetch(`/api/board/boards/${boardId}`, {
    method: 'PATCH',
    body: data,
  })
  await fetchBoards()
}

export async function deleteBoard(boardId: string) {
  await $fetch(`/api/board/boards/${boardId}`, { method: 'DELETE' })
  set({ boards: get().boards.filter(b => b.id !== boardId) })
  if (get().currentBoard?.id === boardId) {
    set({ currentBoard: null, posts: [], pinnedPosts: [] })
  }
}

// ─── Posts ───

export async function fetchPosts(boardId?: string, page?: number) {
  const bid = boardId || get().currentBoard?.id
  if (!bid) return
  const my = ++_postsSeq
  set({ loadingPosts: true, postsError: false })
  try {
    const s = get()
    const params: Record<string, any> = {
      page: page || s.pagination.page,
      page_size: s.pagination.page_size,
      sort: s.sortBy,
    }
    if (s.selectedCategory) params.category = s.selectedCategory

    const data = await $fetch<PostListResponse>(`/api/board/boards/${bid}/posts`, { params })
    if (my !== _postsSeq) return
    set({
      pinnedPosts: data.pinned,
      posts: data.posts,
      pagination: {
        total: data.total,
        page: data.page,
        page_size: data.page_size,
      },
    })
  } catch (e: any) {
    console.error('fetchPosts error:', e)
    if (my === _postsSeq) set({ postsError: true })
  } finally {
    if (my === _postsSeq) set({ loadingPosts: false })
  }
}

export async function fetchPost(postId: string) {
  const my = ++_postSeq
  // 다른 글이 남아 있으면 비운다(새 주소에서 이전 글 본문이 일시적으로 표시되는 것 방지)
  set(get().currentPost && get().currentPost!.id !== postId ? { loadingPost: true, currentPost: null } : { loadingPost: true })
  try {
    const data = await $fetch<PostDetail>(`/api/board/posts/${postId}`)
    if (my !== _postSeq) return
    // Map reactions with reacted status
    const u = uid()
    if (data.reactions) {
      data.reactions = data.reactions.map(r => ({
        ...r,
        reacted: u ? (r.user_ids || []).includes(u) : false,
      }))
    }
    set({ currentPost: data })
    // 글을 열면 서버가 읽음으로 기록한다 — 사이드바 굵게 표시·안 읽은 수를 동기화한다
    void fetchUnreadCounts()
  } catch (e: any) {
    console.error('fetchPost error:', e)
    if (my === _postSeq) set({ currentPost: null })
  } finally {
    if (my === _postSeq) set({ loadingPost: false })
  }
}

export async function createPost(boardId: string, data: {
  title: string
  content: string
  category?: string | null
  is_pinned?: boolean
  is_must_read?: boolean
  must_read_expires_at?: string | null
  attachments?: Array<{ name: string; url: string; size?: number }> | null
}) {
  return await $fetch<PostDetail>(`/api/board/boards/${boardId}/posts`, {
    method: 'POST',
    body: data,
  })
}

export async function updatePost(postId: string, data: Record<string, any>) {
  const result = await $fetch<PostDetail>(`/api/board/posts/${postId}`, {
    method: 'PATCH',
    body: data,
  })
  set({ currentPost: result })
  return result
}

export async function deletePost(postId: string) {
  await $fetch(`/api/board/posts/${postId}`, { method: 'DELETE' })
  set({
    posts: get().posts.filter(p => p.id !== postId),
    pinnedPosts: get().pinnedPosts.filter(p => p.id !== postId),
  })
  if (get().currentPost?.id === postId) {
    set({ currentPost: null })
  }
}

// ─── Comments ───

export async function fetchComments(postId: string) {
  const my = ++_commentsSeq
  set({ loadingComments: true })
  try {
    const data = await $fetch<CommentInfo[]>(`/api/board/posts/${postId}/comments`)
    if (my !== _commentsSeq) return
    set({ comments: data })
  } catch (e: any) {
    console.error('fetchComments error:', e)
  } finally {
    if (my === _commentsSeq) set({ loadingComments: false })
  }
}

/** 글 머리의 "댓글 N" 을 동기화한다(댓글 작성·삭제 시에도 글은 재조회하지 않는다) */
function bumpCommentCount(postId: string, delta: number) {
  const cur = get().currentPost
  if (cur?.id === postId) set({ currentPost: { ...cur, comment_count: Math.max(0, (cur.comment_count || 0) + delta) } })
}

export async function createComment(postId: string, content: string, parentId?: string | null, attachments?: Array<{ name: string; url: string }> | null) {
  const body: Record<string, any> = { content }
  if (parentId) body.parent_id = parentId
  if (attachments) body.attachments = attachments
  const result = await $fetch<CommentInfo>(`/api/board/posts/${postId}/comments`, {
    method: 'POST',
    body,
  })
  bumpCommentCount(postId, 1)
  await fetchComments(postId)
  return result
}

export async function updateComment(commentId: string, content: string) {
  await $fetch(`/api/board/comments/${commentId}`, {
    method: 'PATCH',
    body: { content },
  })
  const cur = get().currentPost
  if (cur) {
    await fetchComments(cur.id)
  }
}

export async function deleteComment(commentId: string) {
  await $fetch(`/api/board/comments/${commentId}`, { method: 'DELETE' })
  const cur = get().currentPost
  if (cur) {
    bumpCommentCount(cur.id, -1)
    await fetchComments(cur.id)
  }
}

// ─── Reactions ───

export async function toggleReaction(postId: string, emoji: string) {
  try {
    const result = await $fetch<{ action: string; reactions: any[] }>(
      `/api/board/posts/${postId}/reactions`,
      { method: 'POST', body: { emoji } },
    )
    // Update current post reactions
    const cur = get().currentPost
    if (cur?.id === postId) {
      const u = uid()
      set({
        currentPost: {
          ...cur,
          reactions: (result.reactions || []).map((r: any) => ({
            emoji: r.emoji,
            count: r.count,
            user_ids: r.user_ids || [],
            reacted: u ? (r.user_ids || []).includes(u) : false,
          })),
        },
      })
    }
  } catch (e: any) {
    console.error('toggleReaction error:', e)
    // 오류를 무시하면 조작해도 무반응으로 보인다(리액션을 비활성화한 게시판 403 등)
    addToast('error', e?.data?.detail || i18n.t('board.reaction.error', '리액션을 반영하지 못했습니다'))
  }
}

// ─── Bookmarks ───

export async function toggleBookmark(postId: string) {
  try {
    const result = await $fetch<{ action: string; is_bookmarked: boolean }>(
      `/api/board/posts/${postId}/bookmark`,
      { method: 'POST' },
    )
    const cur = get().currentPost
    if (cur?.id === postId) {
      set({ currentPost: { ...cur, is_bookmarked: result.is_bookmarked } })
    }
    return result
  } catch (e: any) {
    console.error('toggleBookmark error:', e)
    addToast('error', e?.data?.detail || i18n.t('board.post.bookmarkError', '북마크를 변경하지 못했습니다'))
  }
}

export async function fetchBookmarks(page = 1) {
  const data = await $fetch<SearchResponse>('/api/board/bookmarks', {
    params: { page, page_size: 20 },
  })
  return data
}

// ─── 안 읽음 · 모두 읽음 · 내가 쓴 글 ───

export async function fetchUnreadCounts() {
  try {
    const data = await $fetch<{ counts: Record<string, number>; total: number }>('/api/board/unread-counts')
    set({ unreadCounts: data.counts || {} })
  } catch (e: any) {
    console.error('fetchUnreadCounts error:', e)
  }
}

/** 이 게시판 글을 모두 읽음으로 처리 — 목록 굵게 표시·안 읽은 수를 즉시 제거한다 */
export async function markBoardRead(boardId: string) {
  await $fetch(`/api/board/boards/${boardId}/read-all`, { method: 'POST' })
  const mark = (list: PostSummary[]) => list.map(p => (p.board_id === boardId && p.is_read === false ? { ...p, is_read: true } : p))
  set({
    unreadCounts: { ...(get().unreadCounts || {}), [boardId]: 0 },
    posts: mark(get().posts),
    pinnedPosts: mark(get().pinnedPosts),
  })
  // 필독은 별도 확인이 필요한 글이므로 "모두 읽음"과 별개 — 서버 기준으로 재조회한다
  void fetchMustRead()
}

export async function fetchMyPosts(page = 1) {
  return await $fetch<SearchResponse>('/api/board/my-posts', { params: { page, page_size: 20 } })
}

/** 댓글 @멘션 자동완성 후보 */
export async function searchMentionUsers(q: string, limit = 8) {
  return await $fetch<MentionUser[]>('/api/board/mention-users', { params: { q, limit } })
}

// ─── Must Read ───

export async function fetchMustRead() {
  try {
    const data = await $fetch<PostSummary[]>('/api/board/must-read')
    set({ mustReadPosts: data })
  } catch (e: any) {
    console.error('fetchMustRead error:', e)
  }
}

// ─── Search ───

export async function searchPosts(query: string, boardId?: string, page = 1) {
  const params: Record<string, any> = { q: query, page, page_size: 20 }
  if (boardId) params.board_id = boardId
  return await $fetch<SearchResponse>('/api/board/search', { params })
}

// ─── Pagination ───

export async function goToPage(page: number) {
  set({ pagination: { ...get().pagination, page } })
  await fetchPosts()
}

export async function setCategory(cat: string | null) {
  set({ selectedCategory: cat, pagination: { ...get().pagination, page: 1 } })
  await fetchPosts()
}

export async function setSort(sort: BoardSort) {
  set({ sortBy: sort, pagination: { ...get().pagination, page: 1 } })
  await fetchPosts()
}

// ─── Init ───

export async function init() {
  if (_initialized) return
  _initialized = true
  await Promise.all([fetchBoards(), fetchMustRead(), fetchUnreadCounts()])
}

export function cleanup() {
  _initialized = false
}

const actions = {
  init,
  cleanup,
  fetchBoards,
  selectBoard,
  createBoard,
  updateBoard,
  deleteBoard,
  fetchPosts,
  fetchPost,
  createPost,
  updatePost,
  deletePost,
  fetchComments,
  createComment,
  updateComment,
  deleteComment,
  toggleReaction,
  toggleBookmark,
  fetchBookmarks,
  fetchMustRead,
  fetchUnreadCounts,
  markBoardRead,
  fetchMyPosts,
  searchMentionUsers,
  searchPosts,
  goToPage,
  setCategory,
  setSort,
}

/** 상태 + 동작. 상태는 얕은 비교로 전체 구독한다. */
export function useBoard() {
  const state = useStore(boardStore, useShallow((s: BoardState) => s))
  return { ...state, ...actions }
}
