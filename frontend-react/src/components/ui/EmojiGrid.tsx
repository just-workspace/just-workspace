/**
 * 이모지 격자: 피커의 한 섹션(자주 쓴 · 워크스페이스 · 사람 …) = 격자 하나.
 * 칸 40(데스크톱, 글리프 24) / 44(size="touch", 글리프 26) · 열 columns(데스크톱 9 · 모바일 8) · 간격 2.
 * 활성 칸(호버·키보드) = foreground/20 + 2px ring. 커스텀 칸 = primary/10 바탕. animated = 오른쪽 아래 "GIF" 꼬리표(mono 8/700).
 * 항목은 글리프(glyph) 또는 그림(imageUrl, 커스텀 이모지 — 32/36 contain).
 * 접근성: role=grid(ariaLabel = 섹션 이름) → role=row(columns 개씩) → 칸 <button role=gridcell aria-label=label>.
 *   활성 칸만 Tab(roving). ←→ = 한 칸(줄 넘김) · ↑↓ = 한 줄 · Home/End = 줄 처음/끝 · Ctrl+Home/End = 처음/끝 칸
 *   · Enter/Space(또는 클릭) = onPick. 첫 줄에서 ↑ · 마지막 줄에서 ↓ 는 onExit(방향, 열) — 피커가 인접 섹션으로 이동시킨다.
 * onActive(item, index) — 활성 칸 변경 시 호출(미리보기 줄 48 이 사용한다). activeKey 를 지정하면 제어형(다른 섹션과 활성 칸을 하나만 유지할 때).
 * handleRef.current.focus(index?) — 피커가 섹션을 이동해 올 때 해당 칸에 포커스.
 *
 * @example
 * <p className="px-1 pb-1 pt-1 text-[12px] font-semibold text-muted-foreground">자주 쓴</p>
 * <UiEmojiGrid ariaLabel="자주 사용" items={freq} columns={9} activeKey={active}
 *   onActive={it => setActive(it?.key ?? null)} onPick={it => insert(it)} onExit={(d, col) => moveSection(d, col)} />
 */
import { useImperativeHandle, useRef, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type Ref } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useModel } from './internal'

export interface UiEmojiItem {
  /** 고유 키(유니코드 이모지 자체 또는 ':name:') */
  key: string
  /** 글리프(유니코드) */
  glyph?: string
  /** 그림 주소(커스텀 이모지) — glyph 보다 우선 */
  imageUrl?: string
  /** 접근성 이름(예: ':thumbsup:' · '엄지 척') */
  label: string
  /** 워크스페이스 커스텀(primary/10 바탕) */
  custom?: boolean
  /** 움직이는 이모지("GIF" 꼬리표) */
  animated?: boolean
}

export interface UiEmojiGridHandle {
  /** index 칸(기본 = 활성 칸 또는 0)에 포커스. 범위 초과 시 마지막 칸 */
  focus: (index?: number) => void
}

export interface UiEmojiGridProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'onSelect'> {
  /** 칸 목록 */
  items: UiEmojiItem[]
  /** 열 수(기본 md 9 · touch 8) */
  columns?: number
  /** md 40(기본) · touch 44 */
  size?: 'md' | 'touch'
  /** 활성 칸 key(제어형). 미지정 시 컴포넌트가 자체 보유 */
  activeKey?: string | null
  /** 활성 칸 변경 시 호출(호버·키보드) — 미리보기 줄 용도 */
  onActive?: (item: UiEmojiItem | null, index: number) => void
  /** 선택 시 호출(클릭·Enter·Space) */
  onPick: (item: UiEmojiItem, e: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>) => void
  /** 첫 줄 ↑ / 마지막 줄 ↓ — 인접 섹션으로 이동할 때(column = 현재 열, 0부터) */
  onExit?: (dir: 'up' | 'down', column: number) => void
  /** 격자(섹션) 접근성 이름 */
  ariaLabel?: string
  /** 포커스 제어 핸들 */
  handleRef?: Ref<UiEmojiGridHandle>
}

/**
 * 이모지 격자(role=grid).
 */
export function UiEmojiGrid({
  items, columns, size = 'md', activeKey, onActive, onPick, onExit, ariaLabel, handleRef, className, ...rest
}: UiEmojiGridProps) {
  const { t } = useI18n()
  const touch = size === 'touch'
  const cols = Math.max(1, columns ?? (touch ? 8 : 9))
  const [active, setActive] = useModel<string | null>(activeKey, null, undefined)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const activeIndex = active == null ? -1 : items.findIndex(it => it.key === active)
  const tabbable = activeIndex >= 0 ? activeIndex : 0

  function activate(i: number) {
    const it = items[i] ?? null
    if ((it?.key ?? null) !== active) setActive(it?.key ?? null)
    onActive?.(it, i)
  }
  function focusAt(i: number) {
    const cells = rootRef.current?.querySelectorAll<HTMLElement>('[role=gridcell]')
    if (!cells || cells.length === 0) return
    const j = Math.max(0, Math.min(i, cells.length - 1))
    cells[j]?.focus()
    activate(j)
  }
  useImperativeHandle(handleRef, () => ({ focus: (i?: number) => focusAt(i ?? tabbable) }))

  function onKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const n = items.length
    const col = i % cols
    const lastRowStart = Math.floor((n - 1) / cols) * cols
    let j: number
    switch (e.key) {
      case 'ArrowRight': j = Math.min(n - 1, i + 1); break
      case 'ArrowLeft': j = Math.max(0, i - 1); break
      case 'ArrowDown':
        if (i + cols < n) j = i + cols
        else if (i < lastRowStart) j = n - 1 // 마지막 줄이 짧으면 끝 칸으로 이동
        else { e.preventDefault(); onExit?.('down', col); return }
        break
      case 'ArrowUp':
        if (i - cols >= 0) j = i - cols
        else { e.preventDefault(); onExit?.('up', col); return }
        break
      case 'Home': j = e.ctrlKey || e.metaKey ? 0 : i - col; break
      case 'End': j = e.ctrlKey || e.metaKey ? n - 1 : Math.min(n - 1, i - col + cols - 1); break
      case 'Enter': case ' ':
        e.preventDefault(); if (items[i]) onPick(items[i], e); return
      default: return
    }
    e.preventDefault()
    focusAt(j)
  }

  const rows: UiEmojiItem[][] = []
  for (let r = 0; r * cols < items.length; r++) rows.push(items.slice(r * cols, r * cols + cols))
  const template = { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }

  return (
    <div {...rest} ref={rootRef} role="grid" aria-label={ariaLabel} className={cn('flex flex-col gap-0.5', className)}>
      {rows.map((row, r) => (
        <div key={r} role="row" className="grid gap-0.5" style={template}>
          {row.map((it, c) => {
            const i = r * cols + c
            const on = i === activeIndex
            return (
              <button
                key={it.key}
                type="button"
                role="gridcell"
                aria-label={it.label}
                aria-selected={on}
                tabIndex={i === tabbable ? 0 : -1}
                data-key={it.key}
                className={cn(
                  'relative flex items-center justify-center rounded-md leading-none transition-colors focus-visible:outline-hidden',
                  touch ? 'h-11 text-[26px]' : 'h-10 text-2xl',
                  it.custom && !on ? 'bg-primary/10' : '',
                  on ? 'bg-foreground/20 ring-2 ring-ring' : 'hover:bg-overlay-hover focus-visible:ring-2 focus-visible:ring-ring',
                )}
                onMouseEnter={() => activate(i)}
                onFocus={() => { if (!on) activate(i) }}
                onClick={e => onPick(it, e)}
                onKeyDown={e => onKey(e, i)}
              >
                {it.imageUrl
                  ? <img src={it.imageUrl} alt="" draggable={false} loading="lazy" className={cn('object-contain', touch ? 'h-9 w-9' : 'h-8 w-8')} />
                  : <span aria-hidden="true">{it.glyph ?? it.key}</span>}
                {it.animated && (
                  <span aria-hidden="true" title={t('ui.kit22.gif')} className="absolute bottom-0 right-0 rounded bg-background px-0.5 font-mono text-[8px] font-bold leading-[11px] text-muted-foreground">GIF</span>
                )}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

export default UiEmojiGrid
