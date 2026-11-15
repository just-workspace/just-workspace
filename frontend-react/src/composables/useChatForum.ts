/**
 * 포럼 채널 = 게시판 데이터의 채팅 쪽 보기. Channel.forum_board_id 의 게시판 글을 기존 게시판 API 로 읽는다
 * (/api/board/boards/{id}/posts · posts/{id} · comments — 글·댓글 열기는 useBoard 의 fetchPost/fetchComments 를 그대로 쓴다).
 * 목록은 게시판 화면 상태(boardStore.posts)를 건드리지 않게 여기서 따로 들고 있다 — 같은 글이 게시판에서도 보인다.
 *
 * 보기 전환(글 목록 / 갤러리)은 사람마다 기억(localStorage) — 헤더 자리의 ForumViewToggle(SHELL 이 놓는다)과 ChatForumView 가 같이 쓴다.
 * 갤러리 썸네일: 목록 응답에 thumbnail_url(또는 first_image · content)이 있으면 그것 — 없으면 글자 타일.
 *   (글 상세를 하나씩 읽으면 서버가 읽음·조회수를 올리므로 목록에서 상세를 미리 읽지 않는다 — BE 에 목록 썸네일 필드 요청)
 */
import { createStore, useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { $fetch } from '~/lib/api'
import { i18n } from '~/i18n'
import type { BoardSort, PostSummary } from '~/composables/useBoard'

export type ForumView = 'list' | 'gallery'
const LS_VIEW = 'jw-chat-forum-view'
function readView(): ForumView {
  try { return localStorage.getItem(LS_VIEW) === 'gallery' ? 'gallery' : 'list' } catch { return 'list' }
}

/** 목록 항목 — 서버가 나중에 붙일 수 있는 썸네일 필드까지 */
export type ForumPost = PostSummary & { thumbnail_url?: string | null; first_image?: string | null; content?: string | null; last_activity_at?: string | null }

/** HTML·마크다운 본문의 첫 이미지 주소 */
export function firstImageOf(content: string | null | undefined): string | null {
  if (!content) return null
  const html = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/i.exec(content)
  if (html) return html[1]
  const md = /!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/.exec(content)
  return md ? md[1] : null
}
/** 갤러리 썸네일(없으면 null) */
export function postThumb(p: ForumPost): string | null {
  return p.thumbnail_url || p.first_image || firstImageOf(p.content) || null
}
/** 최근 활동 시각(서버가 주면 그것, 아니면 수정 시각) */
export function postActivity(p: ForumPost): string {
  return p.last_activity_at || p.updated_at || p.created_at
}

interface ForumState {
  view: ForumView
  boardId: string | null
  pinned: ForumPost[]
  posts: ForumPost[]
  total: number
  page: number
  pageSize: number
  sort: BoardSort
  category: string | null
  loading: boolean
  error: string | null
  /** 오른쪽에 연 글 */
  openPostId: string | null
}
const initial = (): ForumState => ({
  view: typeof localStorage !== 'undefined' ? readView() : 'list',
  boardId: null, pinned: [], posts: [], total: 0, page: 1, pageSize: 20, sort: 'latest', category: null, loading: false, error: null, openPostId: null,
})
export const forumStore = createStore<ForumState>()(() => initial())
const S = () => forumStore.getState()
const set = (p: Partial<ForumState>) => forumStore.setState(p)
export function _resetForum() { forumStore.setState(initial()); _seq++ }

export function setForumView(v: ForumView) {
  set({ view: v })
  try { localStorage.setItem(LS_VIEW, v) } catch { /* 기억 못 해도 동작은 같다 */ }
}
export function useForumView(): ForumView { return useStore(forumStore, s => s.view) }

let _seq = 0
/** 글 목록 읽기. 다른 게시판으로 바뀌면 필터·쪽을 처음으로 */
export async function loadForum(boardId: string, opts: { page?: number; sort?: BoardSort; category?: string | null } = {}) {
  const fresh = S().boardId !== boardId
  const page = opts.page ?? (fresh ? 1 : S().page)
  const sort = opts.sort ?? (fresh ? 'latest' : S().sort)
  const category = opts.category !== undefined ? opts.category : (fresh ? null : S().category)
  const my = ++_seq
  set({ boardId, page, sort, category, loading: true, error: null, ...(fresh ? { posts: [], pinned: [], total: 0, openPostId: null } : {}) })
  try {
    const params: Record<string, string | number> = { page, page_size: S().pageSize, sort }
    if (category) params.category = category
    const data = await $fetch<{ pinned: ForumPost[]; posts: ForumPost[]; total: number; page: number; page_size: number }>(`/api/board/boards/${boardId}/posts`, { params })
    if (my !== _seq) return
    set({ pinned: data?.pinned || [], posts: data?.posts || [], total: data?.total ?? 0, page: data?.page ?? page })
  } catch (e: any) {
    if (my !== _seq) return
    const d = e?.data?.detail
    set({ error: (typeof d === 'string' ? d : d?.message) || i18n.t('chat.right.forum.loadError') })
  } finally {
    if (my === _seq) set({ loading: false })
  }
}
export const setForumOpenPost = (id: string | null) => set({ openPostId: id })

export function useForum() {
  return useStore(forumStore, useShallow((s: ForumState) => s))
}
