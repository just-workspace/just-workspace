/**
 * 숫자 페이지네이션("글 번호로 소통하니 숫자 유지") — Vue 판 components/board/BoardPagination.vue 이식.
 *  ‹ › 32 테두리 · 번호 32 mono 12 · 현재 = primary/13 + 안쪽 테두리 primary/50 · aria-current="page".
 */
import { Fragment } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { UiIcon } from '~/components/ui/Icon'

export interface BoardPaginationProps {
  current: number
  total: number
  pages: (number | '...')[]
  onGo?: (page: number) => void
}

/** 번호 줄에 그릴 것 — 7쪽까지는 전부, 그보다 많으면 처음 · 현재 앞뒤 · 끝 + 말줄임 */
export function boardPageNumbers(current: number, total: number): (number | '...')[] {
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
}

/** 페이지 번호 줄 */
export function BoardPagination({ current, total, pages, onGo }: BoardPaginationProps) {
  const { t } = useI18n()
  return (
    <nav aria-label={t('board.pagination.label')} className="flex items-center justify-center gap-1.5 font-mono text-xs">
      <button
        type="button"
        aria-label={t('board.pagination.prev')}
        disabled={current <= 1}
        className="grid h-8 w-8 place-items-center rounded-sm border border-border text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onGo?.(current - 1)}
      ><UiIcon name="chevron-left" className="h-3.5 w-3.5" strokeWidth={2.4} /></button>

      {pages.map((p, i) => (
        <Fragment key={i}>
          {p === '...' ? (
            <span className="grid h-8 w-6 place-items-center text-muted-foreground" aria-hidden="true">…</span>
          ) : (
            <button
              type="button"
              aria-current={p === current ? 'page' : undefined}
              aria-label={t('board.pagination.page', { n: p })}
              className={cn(
                'grid h-8 min-w-[2rem] place-items-center rounded-sm px-1 transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                p === current
                  ? 'bg-primary/[0.13] font-semibold text-foreground shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.5)]'
                  : 'text-foreground hover:bg-accent',
              )}
              onClick={() => onGo?.(p)}
            >{p}</button>
          )}
        </Fragment>
      ))}

      <button
        type="button"
        aria-label={t('board.pagination.next')}
        disabled={current >= total}
        className="grid h-8 w-8 place-items-center rounded-sm border border-border text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onGo?.(current + 1)}
      ><UiIcon name="chevron-right" className="h-3.5 w-3.5" strokeWidth={2.4} /></button>
    </nav>
  )
}

export default BoardPagination
