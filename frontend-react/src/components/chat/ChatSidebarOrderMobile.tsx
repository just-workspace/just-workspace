/**
 * 모바일 순서 편집 모드.
 * 헤더 56: "순서 편집" + [완료] → 안내 한 행 → 섹션(분류 없음 · 사용자 카테고리)마다 제목 행 44(손잡이 · 화살표 · 이름) + 채널 행 44(손잡이 · 아이콘 · 이름).
 * 행·제목을 누르면 선택 상태(ring 2) — 오른쪽에 ↑↓ 44 두 개. 손잡이 드래그로도 이동한다(포인터 드래그 — 드롭 위치 UiDropLine).
 * DM·보관된 프로젝트는 이동 불가이므로 렌더링하지 않는다. 결과는 아래 role=status 행(aria-live polite)에 표시한다.
 * MANAGE_CHANNELS 권한이 있을 때만 진입한다(ChatSidebar 의 ⋯ 메뉴 "순서 편집").
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import type { Channel } from '~/composables/useChat'
import { chatLayoutStore, type SidebarSection } from '~/composables/useChatLayout'
import { addToast } from '~/composables/useToast'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiDragHandle, UiDropLine } from '~/components/ui/DragHandle'
import {
  categoryDropIndex, categoryMovedText, channelLabel, channelMovedText, isDraggableSection, moveCategoryTo, moveChannelTo,
  normalizeSameSectionIndex, stepCategory, stepChannel,
} from '~/utils/chatSidebarDnd'

export interface ChatSidebarOrderMobileProps {
  sections: SidebarSection[]
  onDone: () => void
}

type Sel = { kind: 'channel'; id: string } | { kind: 'category'; id: string } | null
/** 포인터 드래그 중 드롭 위치 */
type Target = { kind: 'channel'; sectionId: string; index: number } | { kind: 'category'; overId: string; after: boolean } | null

export function ChatSidebarOrderMobile({ sections, onDone }: ChatSidebarOrderMobileProps) {
  const { t, locale } = useI18n()
  const [sel, setSel] = useState<Sel>(null)
  const [status, setStatus] = useState('')
  const [target, setTarget] = useState<Target>(null)
  const dragRef = useRef<Sel>(null)
  const movable = sections.filter(isDraggableSection)
  const secName = (s: SidebarSection) => (s.kind === 'uncategorized' ? t('chat.side.uncategorized') : s.name)

  async function moveChannel(c: Channel, toSectionId: string, index: number) {
    try {
      const plan = await moveChannelTo(sections, c.id, toSectionId, index)
      if (!plan) return
      const sec = sections.find(s => s.id === plan.toSectionId)
      setStatus(channelMovedText(t, locale, c, sec ? secName(sec) : '', plan.index))
    } catch {
      addToast('error', t('chat.side.moveFailed'))
    }
  }
  async function stepCh(c: Channel, d: -1 | 1) {
    const s = stepChannel(sections, c.id, d)
    if (s) await moveChannel(c, s.toSectionId, s.index)
  }
  async function moveCat(id: string, index: number) {
    const name = sections.find(s => s.id === id)?.name || ''
    try {
      await moveCategoryTo(id, index)
      setStatus(categoryMovedText(t, locale, name, index))
    } catch {
      addToast('error', t('chat.side.moveFailed'))
    }
  }
  async function stepCat(id: string, d: -1 | 1) {
    const i = stepCategory(chatLayoutStore.getState().categories, id, d)
    if (i !== null) await moveCat(id, i)
  }

  // ─── 손잡이 포인터 드래그 ───
  function targetAt(x: number, y: number, kind: 'channel' | 'category'): Target {
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    if (!el) return null
    if (kind === 'channel') {
      const row = el.closest<HTMLElement>('[data-order-row]')
      if (row) {
        const r = row.getBoundingClientRect()
        const i = Number(row.dataset.index)
        return { kind: 'channel', sectionId: row.dataset.section || '', index: y < r.top + r.height / 2 ? i : i + 1 }
      }
      const head = el.closest<HTMLElement>('[data-order-cat]')
      if (head) return { kind: 'channel', sectionId: head.dataset.orderCat || '', index: 0 }
      return null
    }
    const sec = el.closest<HTMLElement>('[data-order-section]')
    if (!sec || !sec.dataset.orderSection) return null
    const r = sec.getBoundingClientRect()
    return { kind: 'category', overId: sec.dataset.orderSection, after: y > r.top + r.height / 2 }
  }
  function gripDown(e: ReactPointerEvent<HTMLButtonElement>, s: Sel) {
    dragRef.current = s
    setSel(s)
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  function gripMove(e: ReactPointerEvent<HTMLButtonElement>) {
    const d = dragRef.current
    if (!d) return
    setTarget(targetAt(e.clientX, e.clientY, d.kind))
  }
  function gripUp() {
    const d = dragRef.current
    const tg = target
    dragRef.current = null
    setTarget(null)
    if (!d || !tg) return
    if (d.kind === 'channel' && tg.kind === 'channel') {
      const c = sections.flatMap(s => s.channels).find(x => x.id === d.id)
      const to = sections.find(s => s.id === tg.sectionId)
      if (c && to) void moveChannel(c, to.id, to.channels.some(x => x.id === c.id) ? normalizeSameSectionIndex(to, c.id, tg.index) : tg.index)
    } else if (d.kind === 'category' && tg.kind === 'category' && tg.overId !== d.id) {
      const i = categoryDropIndex(chatLayoutStore.getState().categories, d.id, tg.overId, tg.after)
      if (i !== null) void moveCat(d.id, i)
    }
  }

  const userCats = movable.filter(s => s.kind === 'user')

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border pl-4 pr-2">
        <h2 className="min-w-0 flex-1 truncate text-[18px] font-semibold">{t('chat.side.order.title')}</h2>
        <UiButton size="sm" onClick={onDone}>{t('chat.side.order.done')}</UiButton>
      </header>
      <p className="shrink-0 px-4 pt-3 text-[13px] text-muted-foreground">{t('chat.side.order.hint')}</p>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 py-3">
        {movable.map(s => {
          const isCat = s.kind === 'user'
          const catSel = sel?.kind === 'category' && sel.id === s.id
          const ci = userCats.findIndex(x => x.id === s.id)
          return (
            <div key={s.id || 'unc'} className="flex flex-col" data-order-section={isCat ? s.id : undefined}>
              {target?.kind === 'category' && target.overId === s.id && !target.after && <UiDropLine className="mb-1" />}
              <div
                className={cn('flex h-11 items-center gap-1 rounded-lg px-2 text-[13px] font-semibold text-muted-foreground', catSel ? 'ring-2 ring-ring' : '')}
                data-order-cat={s.id}
                onClick={isCat ? () => setSel({ kind: 'category', id: s.id }) : undefined}
              >
                {isCat && (
                  <UiDragHandle
                    ariaLabel={t('chat.side.order.grip', { name: s.name })}
                    onMove={(d) => { void stepCat(s.id, d) }}
                    onPointerDown={(e) => gripDown(e, { kind: 'category', id: s.id })}
                    onPointerMove={gripMove}
                    onPointerUp={gripUp}
                    onPointerCancel={() => { dragRef.current = null; setTarget(null) }}
                  />
                )}
                <UiIcon name="chevron-down" className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{secName(s)}</span>
                {catSel && (
                  <>
                    <UiIconButton icon="arrow-up" size="lg" label={t('chat.side.order.catUp', { name: s.name })} disabled={ci <= 0} onClick={(e) => { e.stopPropagation(); void stepCat(s.id, -1) }} />
                    <UiIconButton icon="arrow-down" size="lg" label={t('chat.side.order.catDown', { name: s.name })} disabled={ci >= userCats.length - 1} onClick={(e) => { e.stopPropagation(); void stepCat(s.id, 1) }} />
                  </>
                )}
              </div>
              {s.channels.map((c, i) => {
                const chSel = sel?.kind === 'channel' && sel.id === c.id
                const line = target?.kind === 'channel' && target.sectionId === s.id && target.index === i
                const icon = c.is_voice ? 'volume-2' : c.forum_board_id ? 'messages-square' : c.type === 'private' ? 'lock' : 'hash'
                return (
                  <div key={c.id}>
                    {line && <UiDropLine className="my-0.5" />}
                    <div
                      role="button"
                      tabIndex={0}
                      aria-pressed={chSel}
                      data-order-row=""
                      data-section={s.id}
                      data-index={i}
                      className={cn('relative flex h-11 items-center gap-3 rounded-lg px-2 text-[16px] text-muted-foreground', chSel ? 'text-foreground ring-2 ring-ring' : '')}
                      onClick={() => setSel({ kind: 'channel', id: c.id })}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSel({ kind: 'channel', id: c.id }) } }}
                    >
                      <UiDragHandle
                        className="-ml-1"
                        ariaLabel={t('chat.side.order.grip', { name: channelLabel(c) })}
                        onMove={(d) => { void stepCh(c, d) }}
                        onPointerDown={(e) => gripDown(e, { kind: 'channel', id: c.id })}
                        onPointerMove={gripMove}
                        onPointerUp={gripUp}
                        onPointerCancel={() => { dragRef.current = null; setTarget(null) }}
                      />
                      <UiIcon name={icon} className="h-5 w-5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{c.name}</span>
                      {chSel && (
                        <>
                          <UiIconButton icon="arrow-up" size="lg" label={t('chat.side.order.up', { name: channelLabel(c) })} onClick={(e) => { e.stopPropagation(); void stepCh(c, -1) }} />
                          <UiIconButton icon="arrow-down" size="lg" label={t('chat.side.order.down', { name: channelLabel(c) })} onClick={(e) => { e.stopPropagation(); void stepCh(c, 1) }} />
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
              {target?.kind === 'channel' && target.sectionId === s.id && target.index >= s.channels.length && <UiDropLine className="my-0.5" />}
              {target?.kind === 'category' && target.overId === s.id && target.after && <UiDropLine className="mt-1" />}
            </div>
          )
        })}
      </div>

      <p role="status" aria-live="polite" className="shrink-0 border-t border-border bg-card px-4 py-3 text-[13px]" style={{ minHeight: 44 }}>{status}</p>
    </div>
  )
}

export default ChatSidebarOrderMobile
