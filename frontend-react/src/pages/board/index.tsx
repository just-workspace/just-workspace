/**
 * 게시판 인덱스 + 보조 보기(필독 · 북마크 · 검색 결과).
 *  커맨드 바 44: "전체 게시판" | 검색(모든 게시판) + 글쓰기(게시판 선택)
 *  2열 카드(rounded 12 · card): 머리(이름 14/600 · 전체 보기) + 최근 글 행 48(읽지 않음 굵게 / 읽음 foreground·80 · 작성자 · 날짜 mono)
 *  검색은 커맨드 바 입력 → ?view=search&q=(&board=) 로 결과를 동일 행 규격(56)으로 표시한다.
 *  모바일 인덱스는 동일 카드를 1열로 배치한다.
 * "새 글 N"(카드 머리 메타) = GET /unread-counts. 카드 행 굵게 = boards-with-posts 의 is_read.
 * 보조 보기 "내가 작성한 글"(?view=mine) = GET /my-posts.
 */
import { useEffect, useRef, useState } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { useHead } from '~/lib/head'
import { useRoute, routerApi, queryString, getAppRouter, parseQuery } from '~/lib/router'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useAuth, authStore } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import { choose } from '~/composables/useDialog'
import { useBreadcrumb } from '~/composables/useBreadcrumb'
import { useBoard, boardStore, type PostSummary } from '~/composables/useBoard'
import { authorName, boardDay, isUnreadPost } from '~/utils/boardFormat'
import { NuxtLink } from '~/components/NuxtLink'
import { BoardShell } from '~/components/board/BoardShell'
import { BoardCommandBar } from '~/components/board/BoardCommandBar'
import { BoardPostRow } from '~/components/board/BoardPostRow'
import { BoardCreateModal } from '~/components/board/BoardCreateModal'
import { BoardPagination, boardPageNumbers } from '~/components/board/BoardPagination'
import { LayoutMobileDetailBar } from '~/components/layout/MobileDetailBar'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiFab } from '~/components/ui/Fab'

// ─── 인덱스: 게시판별 최근 글 ───
interface BoardWithPosts {
  id: string
  name: string
  slug: string
  description: string | null
  recent_posts: Array<{
    id: string
    board_id: string
    title: string
    author: { display_name: string | null; username: string } | null
    comment_count: number
    is_pinned: boolean
    is_must_read: boolean
    has_attachments: boolean
    created_at: string
    is_read?: boolean
  }>
}

function curQuery() {
  const r = getAppRouter()
  return parseQuery(r ? r.state.location.search : window.location.search)
}

export default function BoardIndexPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  const route = useRoute()
  const router = routerApi

  const { init, cleanup, boards, mustReadPosts, unreadCounts, fetchBookmarks, fetchMyPosts, searchPosts, fetchMustRead, fetchUnreadCounts } = useBoard()
  const { user } = useAuth()

  const currentView = queryString(route.query.view)
  const viewTitle = ({
    'must-read': t('board.view.mustRead'),
    bookmarks: t('board.sidebar.myBookmarks'),
    mine: t('board.sidebar.myPosts'),
    search: t('board.view.search'),
  } as Record<string, string>)[currentView ?? ''] ?? t('board.index.allBoards')
  useHead({ title: `${t('nav.board')} | ${appName}` })
  useBreadcrumb(currentView ? viewTitle : t('common.all'))

  const [showCreateModal, setShowCreateModal] = useState(false)
  const unreadMust = new Set(mustReadPosts.map(p => p.id))

  const [boardsWithPosts, setBoardsWithPosts] = useState<BoardWithPosts[]>([])
  const [loadingContent, setLoadingContent] = useState(true)
  const [contentError, setContentError] = useState(false)
  async function fetchBoardsWithPosts() {
    setLoadingContent(true)
    setContentError(false)
    try {
      setBoardsWithPosts(await $fetch<BoardWithPosts[]>('/api/board/boards-with-posts', { params: { limit_per_board: 4 } }))
    } catch {
      setContentError(true)
    } finally {
      setLoadingContent(false)
    }
  }

  // ─── 북마크 ───
  const [bookmarks, setBookmarks] = useState<PostSummary[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const [listError, setListError] = useState(false)
  // 북마크 · 내가 쓴 글 · 검색은 20건 단위 — 쪽 번호로 이동한다(기존에는 첫 20건만 표시됐다)
  const [listPage, setListPage] = useState(1)
  const [listTotal, setListTotal] = useState(0)
  const LIST_PAGE_SIZE = 20
  // 보기·쪽을 빠르게 전환할 때 지연 도착한 이전 응답을 폐기한다
  const listSeq = useRef(0)
  async function loadBookmarks(page = 1) {
    const my = ++listSeq.current
    setLoadingList(true)
    setListError(false)
    try {
      const data = await fetchBookmarks(page)
      if (my !== listSeq.current) return
      setBookmarks(data.posts)
      setListTotal(data.total)
      setListPage(page)
    } catch {
      if (my === listSeq.current) setListError(true)
    } finally {
      if (my === listSeq.current) setLoadingList(false)
    }
  }

  // ─── 내가 쓴 글 ───
  const [myPosts, setMyPosts] = useState<PostSummary[]>([])
  async function loadMyPosts(page = 1) {
    const my = ++listSeq.current
    setLoadingList(true)
    setListError(false)
    try {
      const data = await fetchMyPosts(page)
      if (my !== listSeq.current) return
      setMyPosts(data.posts)
      setListTotal(data.total)
      setListPage(page)
    } catch {
      if (my === listSeq.current) setListError(true)
    } finally {
      if (my === listSeq.current) setLoadingList(false)
    }
  }

  // ─── 검색 ───
  const searchQ = queryString(route.query.q) ?? ''
  const searchBoard = queryString(route.query.board) ?? ''
  const [searchResults, setSearchResults] = useState<PostSummary[]>([])
  const [searchTotal, setSearchTotal] = useState(0)
  async function runSearch(page = 1) {
    const q = queryString(curQuery().q) ?? ''
    const b = queryString(curQuery().board) ?? ''
    const my = ++listSeq.current
    if (!q.trim()) { setSearchResults([]); setSearchTotal(0); setListTotal(0); setListPage(1); setLoadingList(false); return }
    setLoadingList(true)
    setListError(false)
    try {
      const data = await searchPosts(q, b || undefined, page)
      if (my !== listSeq.current) return
      setSearchResults(data.posts)
      setSearchTotal(data.total)
      setListTotal(data.total)
      setListPage(page)
    } catch {
      if (my === listSeq.current) setListError(true)
    } finally {
      if (my === listSeq.current) setLoadingList(false)
    }
  }
  function search(q: string) {
    if (!q) return
    void router.push({ path: '/board', query: { view: 'search', q, ...(searchBoard && currentView === 'search' ? { board: searchBoard } : {}) } })
  }
  const searchScopeName = boards.find(b => b.id === searchBoard)?.name ?? ''

  async function loadView(page = 1) {
    const view = queryString(curQuery().view)
    if (view === 'bookmarks') await loadBookmarks(page)
    else if (view === 'search') await runSearch(page)
    else if (view === 'must-read') await fetchMustRead()
    else if (view === 'mine') await loadMyPosts(page)
    else await Promise.all([fetchBoardsWithPosts(), fetchUnreadCounts()])
  }
  const paged = currentView === 'bookmarks' || currentView === 'mine' || currentView === 'search'
  const listPages = Math.max(1, Math.ceil(listTotal / LIST_PAGE_SIZE))

  useEffect(() => {
    ;(async () => {
      await init()
      if (curQuery().create === '1' && authStore.getState().user?.is_admin) setShowCreateModal(true)
      await loadView()
    })()
    return () => cleanup()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // watch(() => [route.query.view, route.query.q, route.query.board], loadView)
  const firstView = useRef(true)
  useEffect(() => {
    if (firstView.current) { firstView.current = false; return }
    void loadView()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView, searchQ, searchBoard])
  // watch(() => route.query.create)
  const createQ = queryString(route.query.create)
  const firstCreate = useRef(true)
  useEffect(() => {
    if (firstCreate.current) { firstCreate.current = false; return }
    if (createQ === '1' && authStore.getState().user?.is_admin) setShowCreateModal(true)
  }, [createQ])

  // 글쓰기: 게시판이 하나면 즉시 이동, 여러 개면 선택
  async function write() {
    const list = boardStore.getState().boards
    if (!list.length) { addToast('info', t('board.write.noBoard')); return }
    if (list.length === 1) { void router.push(`/board/${list[0].id}/write`); return }
    const picked = await choose({
      title: t('board.write.pickBoard'),
      message: '',
      actions: [...list.slice(0, 6).map(b => ({ key: b.id, label: b.name, variant: 'ghost' as const })), { key: '', label: t('common.cancel'), variant: 'ghost' as const }],
    })
    if (picked) void router.push(`/board/${picked}/write`)
  }

  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const [mobileQuery, setMobileQuery] = useState('')
  function closeCreate() {
    setShowCreateModal(false)
    const q = curQuery()
    if (q.create) void router.replace({ query: { ...q, create: undefined } })
  }

  return (
    <BoardShell>
      {/* 모바일 헤더 */}
      {currentView ? (
        <LayoutMobileDetailBar
          title={viewTitle}
          subtitle={currentView === 'search' && searchQ ? t('board.search.summary', { q: searchQ, n: searchTotal }) : undefined}
          backLabel={t('board.index.allBoards')}
          backTo="/board"
          hideTabbar={false}
        />
      ) : (
        <header className="flex h-14 shrink-0 items-center border-b border-border pl-4 pr-1 md:hidden">
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-foreground">{t('board.title')}</h1>
          <UiIconButton label={t('common.search')} icon="search" size="lg" noTooltip pressed={mobileSearchOpen} onClick={() => setMobileSearchOpen(!mobileSearchOpen)} />
        </header>
      )}
      {mobileSearchOpen && !currentView && (
        <form role="search" className="shrink-0 border-b border-border px-4 py-2 md:hidden" onSubmit={(e) => { e.preventDefault(); search(mobileQuery.trim()) }}>
          <input
            value={mobileQuery}
            onChange={e => setMobileQuery(e.target.value)}
            type="search"
            autoComplete="off"
            aria-label={t('board.search.allBoards')}
            placeholder={t('board.search.allBoards')}
            className="h-11 w-full rounded-md border border-input bg-card px-3 text-[15px] text-foreground outline-hidden placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/35"
          />
        </form>
      )}

      {/* 데스크톱 커맨드 바 */}
      <BoardCommandBar
        searchPlaceholder={currentView === 'search' && searchScopeName ? t('board.search.inScope', { name: searchScopeName }) : t('board.search.allBoards')}
        searchValue={currentView === 'search' ? searchQ : ''}
        onSearch={search}
        actions={(
          <button
            type="button"
            className="inline-flex h-8 shrink-0 items-center rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            onClick={() => { void write() }}
          >{t('board.post.write')}</button>
        )}
      >
        <b className="shrink-0 font-semibold text-foreground">{viewTitle}</b>
        {currentView === 'search' && searchQ && (
          <span className="min-w-0 truncate text-muted-foreground">
            “{searchQ}”{searchScopeName && <> · {searchScopeName}</>} · <span className="font-mono">{searchTotal}</span>{t('board.search.resultCount')}
          </span>
        )}
      </BoardCommandBar>

      <div className="min-h-0 flex-1 overflow-y-auto pb-24 md:pb-0">
        {currentView === 'must-read' ? (
          /* 필독 */
          <>
            {!mustReadPosts.length && <UiEmptyState variant="panel" icon="check-circle" title={t('board.view.mustReadEmpty')} />}
            {mustReadPosts.map(p => <BoardPostRow key={p.id} post={p} unread showBoard />)}
          </>
        ) : currentView === 'mine' ? (
          /* 내가 쓴 글 */
          loadingList ? <UiSkeleton preset="list" rows={6} />
            : listError ? <UiErrorTile placement="panel" title={t('board.view.myPostsError')} onRetry={() => { void loadView(listPage) }} />
            : (
              <>
                {!myPosts.length && <UiEmptyState variant="panel" icon="edit" title={t('board.view.myPostsEmpty')} />}
                {myPosts.map(p => <BoardPostRow key={p.id} post={p} unread={false} showBoard />)}
              </>
            )
        ) : currentView === 'bookmarks' || currentView === 'search' ? (
          /* 북마크 · 검색 */
          loadingList ? <UiSkeleton preset="list" rows={6} />
            : listError ? <UiErrorTile placement="panel" title={currentView === 'search' ? t('board.search.error') : t('board.view.bookmarksError')} onRetry={() => { void loadView(listPage) }} />
            : currentView === 'bookmarks' ? (
              <>
                {!bookmarks.length && <UiEmptyState variant="panel" icon="star" title={t('board.bookmarks.empty')} />}
                {bookmarks.map(p => <BoardPostRow key={p.id} post={p} unread={isUnreadPost(p, unreadMust)} showBoard />)}
              </>
            ) : (
              <>
                {!searchQ ? <UiEmptyState variant="panel" icon="search" title={t('board.search.enterQuery')} />
                  : !searchResults.length ? <UiEmptyState variant="panel" icon="search" title={t('board.search.noResults')} />
                  : null}
                {searchResults.map(p => <BoardPostRow key={p.id} post={p} unread={isUnreadPost(p, unreadMust)} showBoard />)}
              </>
            )
        ) : (
          /* 인덱스 */
          <>
            {/* 모바일: 필독 콜아웃(데스크톱은 사이드바에 표시) */}
            {mustReadPosts.length > 0 && (
              <div className="mx-4 mt-3 flex flex-col gap-1 rounded-md border border-warning/35 bg-warning/[0.08] px-3 py-2.5 md:hidden">
                <NuxtLink to="/board?view=must-read" className="text-xs font-bold text-warning">{t('common.mustRead')} <span className="font-mono">{mustReadPosts.length}</span></NuxtLink>
                {mustReadPosts.slice(0, 3).map(p => (
                  <NuxtLink key={p.id} to={`/board/${p.board_id}/${p.id}`} className="truncate py-1 text-sm font-semibold text-foreground">{p.title}</NuxtLink>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 content-start gap-4 p-4 md:px-6 md:py-5 xl:grid-cols-2">
              {loadingContent ? (
                [1, 2, 3, 4].map(i => <UiSkeleton key={i} preset="card" framed />)
              ) : contentError ? (
                <UiErrorTile className="xl:col-span-2" placement="panel" title={t('board.loadError')} onRetry={() => { void fetchBoardsWithPosts() }} />
              ) : !boardsWithPosts.length ? (
                <UiEmptyState
                  className="xl:col-span-2"
                  variant="panel"
                  icon="clipboard-list"
                  title={t('board.index.empty')}
                  description={user?.is_admin ? t('board.index.emptyAdmin') : undefined}
                  actionLabel={user?.is_admin ? t('board.create.buttonLabel') : undefined}
                  onAction={() => setShowCreateModal(true)}
                />
              ) : (
                boardsWithPosts.map(bwp => (
                  <section key={bwp.id} className="overflow-hidden rounded-lg border border-border bg-card" aria-label={bwp.name}>
                    <div className="flex items-center gap-2 border-b border-border px-[18px] py-3.5">
                      <NuxtLink to={`/board/${bwp.id}`} className="min-w-0 truncate text-sm font-semibold text-foreground hover:underline">{bwp.name}</NuxtLink>
                      {unreadCounts?.[bwp.id] ? <span className="shrink-0 text-xs text-muted-foreground">{t('board.index.newPosts', { n: unreadCounts[bwp.id] })}</span> : null}
                      <NuxtLink to={`/board/${bwp.id}`} className="ml-auto shrink-0 text-xs font-semibold text-primary hover:underline">{t('common.viewAll')}</NuxtLink>
                    </div>
                    {!bwp.recent_posts.length && <p className="px-[18px] py-4 text-[13px] text-muted-foreground">{t('board.post.empty')}</p>}
                    {bwp.recent_posts.map(post => (
                      <NuxtLink
                        key={post.id}
                        to={`/board/${bwp.id}/${post.id}`}
                        className="flex h-12 items-center gap-2.5 border-b border-border px-[18px] text-[13.5px] transition-colors last:border-b-0 hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        {post.is_must_read && <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-warning px-[7px] text-[11px] font-bold text-background">{t('common.mustRead')}</span>}
                        <span className={cn('min-w-0 flex-1 truncate', isUnreadPost(post, unreadMust) ? 'font-bold text-foreground' : 'text-foreground/80')}>{post.title}</span>
                        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{authorName(post.author)}</span>
                        <span className="w-11 shrink-0 text-right font-mono text-[11px] text-muted-foreground">{boardDay(post.created_at)}</span>
                      </NuxtLink>
                    ))}
                  </section>
                ))
              )}
            </div>
          </>
        )}
      </div>

      {paged && !listError && listPages > 1 && (
        <div className="flex h-12 shrink-0 items-center justify-center border-t border-border">
          <BoardPagination current={listPage} total={listPages} pages={boardPageNumbers(listPage, listPages)} onGo={(p) => { void loadView(p) }} />
        </div>
      )}

      <UiFab label={t('board.post.write')} icon="edit" onClick={() => { void write() }} />

      {showCreateModal && <BoardCreateModal onClose={closeCreate} />}
    </BoardShell>
  )
}
