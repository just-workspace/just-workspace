/**
 * 사이드바 구역 하나.
 * 제목 24 · 12/600(모바일 44 · 13/600): button + aria-expanded, 화살표 100ms −90°(reduce-motion 이면 즉시).
 * 오른쪽 ⋯(사용자·시스템 카테고리 — 카테고리 메뉴) · +(채널 만들기 — 이 카테고리로 / DM 은 새 메시지).
 * "분류 없음"은 제목이 없다. 빈 사용자 카테고리는 점선 칸 안내.
 * 끌기 표시: 채널을 다른 카테고리 제목 위로 = 제목 primary/15 + 2px ring + 안내 한 줄, 카테고리 끌기 = 구역 앞/뒤 UiDropLine, 끄는 카테고리 40%.
 * 끌기 동작(HTML5 DnD)·키보드 이동은 ChatSidebar 가 한다 — 이 부품은 그리기와 이벤트 연결만.
 */
import type { DragEvent, KeyboardEvent, ReactNode } from 'react'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import type { SidebarSection } from '~/composables/useChatLayout'
import { UiIcon } from '~/components/ui/Icon'
import { UiDropLine } from '~/components/ui/DragHandle'
import { ChatCategoryRename } from './ChatCategoryDialogs'

export interface ChatCategorySectionProps {
  section: SidebarSection
  mobile?: boolean
  canManage: boolean
  /** 이름 바꾸는 중(#cat-rename) */
  renaming?: boolean
  onRenameDone?: () => void
  onToggle: () => void
  /** ⋯ 메뉴(없으면 ⋯ 안 그림) */
  onMenu?: (anchor: HTMLElement) => void
  /** +(없으면 + 안 그림) */
  onAdd?: () => void
  /** 제목 F2 · Alt(+Shift)+↑↓ */
  onRename?: () => void
  onMoveCategory?: (delta: -1 | 1) => void
  /** 채널을 끌어 이 제목 위에 올림 — 강조 + 안내 */
  dropHighlight?: boolean
  /** 카테고리 끌기 자리 선 */
  catLine?: 'before' | 'after' | null
  /** 끄는 중인 카테고리(40%) */
  ghosted?: boolean
  /** 제목 끌기(카테고리째, MANAGE_CHANNELS · 사용자 카테고리만) */
  headerDraggable?: boolean
  onHeaderDragStart?: (e: DragEvent<HTMLElement>) => void
  onHeaderDragEnd?: (e: DragEvent<HTMLElement>) => void
  /** 제목 위 끌기(채널 → 맨 아래로 / 카테고리 → 자리 선) */
  onHeaderDragOver?: (e: DragEvent<HTMLElement>) => void
  onHeaderDragLeave?: (e: DragEvent<HTMLElement>) => void
  onHeaderDrop?: (e: DragEvent<HTMLElement>) => void
  /** 구역 몸통 위 끌기(빈 칸 · 카테고리 자리) */
  onBodyDragOver?: (e: DragEvent<HTMLElement>) => void
  onBodyDrop?: (e: DragEvent<HTMLElement>) => void
  children?: ReactNode
}

export function ChatCategorySection({
  section, mobile = false, canManage, renaming, onRenameDone, onToggle, onMenu, onAdd, onRename, onMoveCategory,
  dropHighlight, catLine, ghosted, headerDraggable, onHeaderDragStart, onHeaderDragEnd, onHeaderDragOver, onHeaderDragLeave, onHeaderDrop,
  onBodyDragOver, onBodyDrop, children,
}: ChatCategorySectionProps) {
  const { t } = useI18n()
  const titled = section.kind !== 'uncategorized'
  const open = !section.collapsed
  const empty = section.kind === 'user' && section.channels.length === 0

  function onKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'F2' && onRename) { e.preventDefault(); onRename(); return }
    if (onMoveCategory && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      onMoveCategory(e.key === 'ArrowUp' ? -1 : 1)
    }
  }

  return (
    <section
      aria-label={titled ? section.name : t('chat.side.uncategorized')}
      className={cn('relative flex flex-col gap-px', ghosted ? 'opacity-40' : '')}
      data-section={section.id || 'uncategorized'}
      onDragOver={onBodyDragOver}
      onDrop={onBodyDrop}
    >
      {catLine === 'before' && <UiDropLine className="-mt-2 mb-1.5" />}

      {titled && (renaming
        ? <ChatCategoryRename section={section} onDone={() => onRenameDone?.()} />
        : (
          <div
            className={cn(
              'group/cat flex items-center gap-1 rounded px-1 font-semibold transition-colors',
              mobile ? 'h-11 text-[13px]' : 'h-6 text-[12px]',
              dropHighlight ? 'bg-primary/15 text-primary ring-2 ring-primary' : 'text-muted-foreground hover:text-foreground',
            )}
            draggable={headerDraggable || undefined}
            onDragStart={onHeaderDragStart}
            onDragEnd={onHeaderDragEnd}
            onDragOver={onHeaderDragOver}
            onDragLeave={onHeaderDragLeave}
            onDrop={onHeaderDrop}
          >
            <button
              type="button"
              aria-expanded={open}
              className="flex h-full min-w-0 flex-1 items-center gap-1 rounded text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onToggle}
              onKeyDown={onKey}
            >
              <span className={cn('inline-flex shrink-0 transition-transform duration-100 motion-reduce:transition-none', open ? '' : '-rotate-90')}>
                <UiIcon name="chevron-down" strokeWidth={2.4} className={mobile ? 'h-3.5 w-3.5' : 'h-3 w-3'} />
              </span>
              <span className="truncate">{section.name}</span>
            </button>
            {onMenu && (
              <button
                type="button"
                aria-label={t('chat.side.catMenu')}
                title={t('chat.side.catMenu')}
                aria-haspopup="menu"
                className={cn('inline-flex shrink-0 items-center justify-center rounded hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring', mobile ? 'h-11 w-11' : 'p-0.5')}
                onClick={(e) => onMenu(e.currentTarget)}
              >
                <UiIcon name="more-horizontal" className="h-4 w-4" />
              </button>
            )}
            {onAdd && (
              <button
                type="button"
                aria-label={section.kind === 'dm' ? t('chat.side.addDm') : t('chat.side.addChannel')}
                title={section.kind === 'dm' ? t('chat.side.addDm') : t('chat.side.addChannel')}
                className={cn('inline-flex shrink-0 items-center justify-center rounded hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring', mobile ? 'h-11 w-11' : 'p-0.5')}
                onClick={onAdd}
              >
                <UiIcon name="plus" className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}

      {dropHighlight && <p className="px-2 pb-1 text-[12px] text-primary">{t('chat.side.dropNote')}</p>}

      {empty && open && (
        <p className="rounded-lg border border-dashed border-border px-3 py-2 text-[13px] text-muted-foreground">
          {canManage ? t('chat.side.empty') : t('chat.side.emptyNoPerm')}
        </p>
      )}

      {children}

      {catLine === 'after' && <UiDropLine className="mt-1.5" />}
    </section>
  )
}

export default ChatCategorySection
