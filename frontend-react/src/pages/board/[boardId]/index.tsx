/**
 * 게시판 글 목록.
 *  커맨드 바 44: 게시판명 600 + 설명 muted | 검색(이 게시판) + 글쓰기
 *  카테고리 밑줄 탭 40 + "최신순 ▾" → 글 행 56(아바타 28 · 필독 솔리드 · 고정 틴트 · 안 읽음 굵게) → 숫자 페이지네이션 48
 *  모바일: 상단 바(‹ 게시판 목록 · 이름 / 설명 · 필독 N · 검색 44) + 행 + FAB 글쓰기(탭바 유지).
 *  "모두 읽음"(POST /boards/{id}/read-all): 안 읽은 글이 있을 때만, 활동 패널 머리의 "모두 읽음" 글자 버튼 규격(primary 600).
 * 경로 매개변수가 바뀌면 화면을 새로 만든다 — boardId 를 key 로 다시 마운트한다.
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { useRoute, routerApi } from '~/lib/router'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { addToast } from '~/composables/useToast'
import { useBreadcrumb } from '~/composables/useBreadcrumb'
import { useBoard, boardStore, type BoardSort } from '~/composables/useBoard'
import { isUnreadPost } from '~/utils/boardFormat'
import { NuxtLink } from '~/components/NuxtLink'
import { BoardShell } from '~/components/board/BoardShell'
import { BoardCommandBar } from '~/components/board/BoardCommandBar'
import { BoardCategoryTabs } from '~/components/board/BoardCategoryTabs'
import { BoardPostRow } from '~/components/board/BoardPostRow'
import { BoardPagination } from '~/components/board/BoardPagination'
import { LayoutMobileDetailBar } from '~/components/layout/MobileDetailBar'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiFab } from '~/components/ui/Fab'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'

// 정렬 ▾
const SORTS = [
  { key: 'latest', labelKey: 'board.sort.latestOrder' },
  { key: 'views', labelKey: 'board.sort.viewsOrder' },
  { key: 'comments', labelKey: 'board.sort.commentsOrder' },
] as const

function BoardListPage({ boardId }: { boardId: string }) {
  const { appName } = useSiteConfig()
  const router = routerApi
  const { t } = useI18n()

  const {
    init, cleanup, currentBoard, posts, pinnedPosts, pagination, mustReadPosts, unreadCounts,
    selectedCategory, sortBy, loadingPosts, postsError,
    selectBoard, goToPage, setCategory, setSort, markBoardRead,
  } = useBoard()

  const hasUnread = (unreadCounts?.[boardId] ?? 0) > 0
    || posts.some(p => p.is_read === false) || pinnedPosts.some(p => p.is_read === false)
  const [markingRead, setMarkingRead] = useState(false)
  async function readAll() {
    if (markingRead) return
    setMarkingRead(true)
    try {
      await markBoardRead(boardId)
      addToast('success', t('board.readAll.done'))
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('board.readAll.failed'))
    } finally {
      setMarkingRead(false)
    }
  }

  useHead({ title: `${currentBoard?.name ?? t('board.title')} | ${appName}` })
  useBreadcrumb(currentBoard?.name ?? null)

  const [loadError, setLoadError] = useState(false)
  async function load() {
    setLoadError(false)
    try {
      await init()
      await selectBoard(boardId)
      if (!boardStore.getState().currentBoard) setLoadError(true)
    } catch {
      setLoadError(true)
    }
  }
  useEffect(() => {
    void load()
    return () => cleanup()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const unreadMust = new Set(mustReadPosts.map(p => p.id))
  const mustCount = mustReadPosts.filter(p => p.board_id === boardId).length
  const mobileSubtitle = [currentBoard?.description, mustCount ? t('board.mustReadCount', { n: mustCount }) : ''].filter(Boolean).join(' · ')

  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.page_size))
  const pageNumbers = (() => {
    const total = totalPages
    const current = pagination.page
    const pages: (number | '...')[] = []
    if (total <= 7) {
      for (let i = 1; i <= total; i++) pages.push(i)
    } else {
      pages.push(1)
      if (current > 3) pages.push('...')
      for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) pages.push(i)
      if (current < total - 2) pages.push('...')
      pages.push(total)
    }
    return pages
  })()

  const sortLabel = t(SORTS.find(s => s.key === sortBy)?.labelKey ?? 'board.sort.latestOrder')
  const [sortMenu, setSortMenu] = useState<{ anchor: DOMRect | null } | null>(null)
  const sortItems: UiMenuItem[] = SORTS.map(s => ({ key: s.key, label: t(s.labelKey), radio: true, checked: s.key === sortBy }))

  function search(q: string) {
    if (!q) return
    void router.push({ path: '/board', query: { view: 'search', q, board: boardId } })
  }
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const [mobileQuery, setMobileQuery] = useState('')
  const writeTo = `/board/${boardId}/write`

  return (
    <BoardShell>
      {/* 모바일 상단 바 */}
      <LayoutMobileDetailBar
        title={currentBoard?.name ?? t('board.title')}
        subtitle={mobileSubtitle}
        backLabel={t('board.sidebar.listLabel')}
        backTo="/board"
        hideTabbar={false}
        actions={(
          <>
            {hasUnread && (
              <button
                type="button"
                className="inline-flex h-11 shrink-0 items-center px-2.5 text-sm font-semibold text-primary disabled:opacity-50"
                disabled={markingRead}
                onClick={() => { void readAll() }}
              >{t('board.readAll.label')}</button>
            )}
            <UiIconButton label={t('common.search')} icon="search" size="lg" noTooltip pressed={mobileSearchOpen} onClick={() => setMobileSearchOpen(!mobileSearchOpen)} />
          </>
        )}
      />
      {mobileSearchOpen && (
        <form role="search" className="shrink-0 border-b border-border px-4 py-2 md:hidden" onSubmit={(e) => { e.preventDefault(); search(mobileQuery.trim()) }}>
          <input
            value={mobileQuery}
            onChange={e => setMobileQuery(e.target.value)}
            type="search"
            autoComplete="off"
            aria-label={t('board.search.inBoard')}
            placeholder={t('board.search.inBoard')}
            className="h-11 w-full rounded-md border border-input bg-card px-3 text-[15px] text-foreground outline-hidden placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/35"
          />
        </form>
      )}

      {/* 데스크톱 커맨드 바 */}
      <BoardCommandBar
        searchPlaceholder={t('board.search.inBoard')}
        onSearch={search}
        actions={(
          <>
            {hasUnread && (
              <button
                type="button"
                className="inline-flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-semibold text-primary hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                disabled={markingRead}
                onClick={() => { void readAll() }}
              >{t('board.readAll.label')}</button>
            )}
            <NuxtLink
              to={writeTo}
              className="inline-flex h-8 shrink-0 items-center rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >{t('board.post.write')}</NuxtLink>
          </>
        )}
      >
        <b className="shrink-0 font-semibold text-foreground">{currentBoard?.name ?? ''}</b>
        {currentBoard?.description && <span className="min-w-0 truncate text-muted-foreground">{currentBoard.description}</span>}
      </BoardCommandBar>

      {/* 카테고리 탭 + 정렬 */}
      <div className="flex h-10 shrink-0 items-stretch gap-2 border-b border-border px-2 md:px-4">
        <BoardCategoryTabs
          categories={currentBoard?.categories ?? []}
          selected={selectedCategory}
          className="flex-1"
          onSelect={(c) => { void setCategory(c) }}
        />
        <button
          type="button"
          aria-haspopup="menu"
          aria-label={t('board.sort.ariaCurrent', { label: sortLabel })}
          className="flex shrink-0 items-center gap-1 px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(e) => setSortMenu({ anchor: (e.currentTarget as HTMLElement).getBoundingClientRect() })}
        >{sortLabel}<UiIcon name="chevron-down" className="h-3 w-3" strokeWidth={2.4} /></button>
      </div>

      {/* 목록 */}
      <div className="min-h-0 flex-1 overflow-y-auto pb-24 md:pb-0">
        {loadingPosts && !posts.length && !pinnedPosts.length ? (
          <UiSkeleton preset="list" rows={8} />
        ) : loadError || (postsError && !posts.length && !pinnedPosts.length) ? (
          /* 목록을 못 받은 것을 "아직 글이 없습니다"로 보이지 않게 */
          <UiErrorTile placement="panel" title={t('board.loadError')} onRetry={() => { void load() }} />
        ) : !posts.length && !pinnedPosts.length ? (
          <UiEmptyState
            variant="panel"
            icon="clipboard-list"
            title={selectedCategory ? t('board.post.emptyCategory') : t('board.post.emptyYet')}
            description={t('board.post.emptyDesc')}
            actionLabel={t('board.post.write')}
            actionTo={writeTo}
          />
        ) : (
          <>
            {pinnedPosts.map(p => <BoardPostRow key={`pin-${p.id}`} post={p} pinned unread={isUnreadPost(p, unreadMust)} />)}
            {posts.map(p => <BoardPostRow key={p.id} post={p} unread={isUnreadPost(p, unreadMust)} />)}
          </>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex h-12 shrink-0 items-center justify-center border-t border-border">
          <BoardPagination current={pagination.page} total={totalPages} pages={pageNumbers} onGo={(p) => { void goToPage(p) }} />
        </div>
      )}

      <UiFab label={t('board.post.write')} icon="edit" to={writeTo} />

      {sortMenu && (
        <UiMenu
          items={sortItems}
          anchor={sortMenu.anchor}
          title={t('board.sort.label')}
          width={220}
          dense
          onSelect={(k) => { void setSort(k as BoardSort) }}
          onClose={() => setSortMenu(null)}
        />
      )}
    </BoardShell>
  )
}

export default function Page() {
  const route = useRoute()
  const boardId = route.params.boardId as string
  return <BoardListPage key={boardId} boardId={boardId} />
}
