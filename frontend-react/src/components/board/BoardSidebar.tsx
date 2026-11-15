/**
 * 게시판 왼쪽 패널 236(시안 BD1~BD4 aside) — Vue 판 components/board/BoardSidebar.vue 이식.
 *  필독 콜아웃(warning 틴트 · "필독 N" + 제목 12.5/600) → 전체 게시판 + 게시판 행 34(선택 primary/13 600 · 안 읽음 600 · 읽음 muted)
 *  → 바닥 "내 북마크 N".
 * 안 읽음 굵게 = 안 읽은 글이 있는 게시판(GET /unread-counts). 숫자 배지는 쓰지 않는다(06-3 결정 5: 나를 부른 게 아니므로).
 * 집계를 아직 못 읽었으면 안 읽은 필독이 있는 게시판만 굵게.
 * 바닥: 내 북마크 N · 내가 쓴 글(GET /my-posts → /board?view=mine).
 */
import { useEffect } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useRoute } from '~/lib/router'
import { useSharedState } from '~/lib/state'
import { useAuth } from '~/composables/useAuth'
import { useBoard } from '~/composables/useBoard'
import { NuxtLink } from '~/components/NuxtLink'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiIcon } from '~/components/ui/Icon'

export interface BoardSidebarProps {
  className?: string
  /** 링크를 눌렀을 때(Vue emit navigate) */
  onNavigate?: () => void
}

/** 게시판 목록 패널 */
export function BoardSidebar({ className, onNavigate }: BoardSidebarProps) {
  const { t } = useI18n()
  const { boards, loadingBoards, mustReadPosts, unreadCounts, fetchBookmarks } = useBoard()
  const { user } = useAuth()
  const route = useRoute()

  const currentBoardId = route.params.boardId as string | undefined
  const onIndex = route.path === '/board' && !route.query.view
  const unreadBoards = (() => {
    const set = new Set(mustReadPosts.map(p => p.board_id))
    for (const [id, n] of Object.entries(unreadCounts || {})) if (n > 0) set.add(id)
    return set
  })()

  // 북마크 수 — 페이지마다 다시 세지 않게 공유 상태로
  const [bookmarkCount, setBookmarkCount] = useSharedState<number | null>('board-bookmark-count', () => null)
  useEffect(() => {
    fetchBookmarks(1).then(d => { setBookmarkCount(d.total) }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const nav = () => onNavigate?.()

  return (
    <aside className={cn('flex h-full w-[236px] shrink-0 flex-col border-r border-border bg-card px-2.5 py-3 text-[13.5px]', className)} aria-label={t('board.sidebar.label')}>
      {/* 필독 */}
      {mustReadPosts.length > 0 && (
        <div className="mb-3 flex flex-col gap-1 rounded-md border border-warning/35 bg-warning/[0.08] px-3 py-2.5">
          <NuxtLink to="/board?view=must-read" className="text-xs font-bold text-warning hover:underline" onClick={nav}>
            {t('common.mustRead')} <span className="font-mono">{mustReadPosts.length}</span>
          </NuxtLink>
          {mustReadPosts.slice(0, 3).map(p => (
            <NuxtLink
              key={p.id}
              to={`/board/${p.board_id}/${p.id}`}
              className="truncate text-[12.5px] font-semibold text-foreground hover:underline"
              onClick={nav}
            >{p.title}</NuxtLink>
          ))}
        </div>
      )}

      <nav className="min-h-0 flex-1 overflow-y-auto" aria-label={t('board.sidebar.listLabel')}>
        <NuxtLink
          to="/board"
          className={cn('flex h-[34px] items-center rounded-sm px-2.5 transition-colors hover:bg-accent/40', onIndex ? 'bg-primary/[0.13] font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground')}
          aria-current={onIndex ? 'page' : undefined}
          onClick={nav}
        >{t('board.index.allBoards')}</NuxtLink>
        {loadingBoards && !boards.length && <UiSkeleton preset="list" rows={4} />}
        {boards.map(b => (
          <NuxtLink
            key={b.id}
            to={`/board/${b.id}`}
            className={cn(
              'flex h-[34px] items-center rounded-sm px-2.5 transition-colors hover:bg-accent/40',
              currentBoardId === b.id
                ? 'bg-primary/[0.13] font-semibold text-foreground'
                : unreadBoards.has(b.id) ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
            aria-current={currentBoardId === b.id ? 'page' : undefined}
            onClick={nav}
          ><span className="truncate">{b.name}</span></NuxtLink>
        ))}
        {!loadingBoards && !boards.length && <p className="px-2.5 py-3 text-xs text-muted-foreground">{t('board.sidebar.empty')}</p>}
        {user?.is_admin && (
          <NuxtLink
            to="/board?create=1"
            className="mt-1 flex h-[34px] items-center gap-1.5 rounded-sm px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
            onClick={nav}
          ><UiIcon name="plus" className="h-3.5 w-3.5" strokeWidth={2.4} />{t('board.sidebar.addBoard')}</NuxtLink>
        )}
      </nav>

      <div className="mt-auto flex flex-col gap-0.5 pt-2 text-[13px] text-muted-foreground">
        <NuxtLink
          to="/board?view=bookmarks"
          className={cn('rounded-sm px-2.5 py-1.5 hover:bg-accent/40 hover:text-foreground', route.query.view === 'bookmarks' ? 'font-semibold text-foreground' : '')}
          onClick={nav}
        >{t('board.sidebar.myBookmarks')}{bookmarkCount !== null && <span className="ml-1 font-mono">{bookmarkCount}</span>}</NuxtLink>
        <NuxtLink
          to="/board?view=mine"
          className={cn('rounded-sm px-2.5 py-1.5 hover:bg-accent/40 hover:text-foreground', route.query.view === 'mine' ? 'font-semibold text-foreground' : '')}
          aria-current={route.query.view === 'mine' ? 'page' : undefined}
          onClick={nav}
        >{t('board.sidebar.myPosts')}</NuxtLink>
      </div>
    </aside>
  )
}

export default BoardSidebar
