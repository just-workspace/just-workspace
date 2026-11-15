/**
 * 카테고리 밑줄 탭(시안 BD2 · 결정 2 "카테고리는 밑줄 탭") — Vue 판 components/board/BoardCategoryTabs.vue 이식.
 * 높이 40, 선택 = 2px primary 밑줄 + 600. 화살표 ←/→ 로 탭 사이 이동(role=tablist).
 */
import { useRef, type KeyboardEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'

export interface BoardCategoryTabsProps {
  categories: readonly string[]
  selected: string | null
  className?: string
  onSelect?: (category: string | null) => void
}

/** 카테고리 탭(전체 + 게시판 카테고리) */
export function BoardCategoryTabs({ categories, selected, className, onSelect }: BoardCategoryTabsProps) {
  const { t } = useI18n()
  const items = [{ key: null as string | null, label: t('common.all') }, ...categories.map(c => ({ key: c as string | null, label: c }))]
  const root = useRef<HTMLDivElement | null>(null)

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const tabs = Array.from(root.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])
    const i = tabs.indexOf(document.activeElement as HTMLElement)
    if (i < 0) return
    e.preventDefault()
    tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]?.focus()
  }

  return (
    <div ref={root} role="tablist" aria-label={t('board.category.label')} className={cn('flex h-full min-w-0 items-stretch gap-1 overflow-x-auto scrollbar-none', className)} onKeyDown={onKey}>
      {items.map(it => (
        <button
          key={it.key ?? '__all'}
          type="button"
          role="tab"
          aria-selected={selected === it.key}
          tabIndex={selected === it.key ? 0 : -1}
          className={cn(
            '-mb-px flex shrink-0 items-center whitespace-nowrap border-b-2 px-2.5 text-[13px] transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
            selected === it.key ? 'border-primary font-semibold text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
          onClick={() => onSelect?.(it.key)}
        >{it.label}</button>
      ))}
    </div>
  )
}

export default BoardCategoryTabs
