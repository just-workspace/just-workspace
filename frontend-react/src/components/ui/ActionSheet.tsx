/**
 * 모바일 액션 시트(시안 PatOverlay "바텀시트" · FilesMobile sheet): 스크림 + 상단 rounded-sheet(16) + 핸들 36×4,
 * 아래 여백 28 + safe-area. 머리글 두 가지:
 *  · 제목만 — 17/600(PatOverlay)
 *  · 아이콘 + 이름 + 메타 — 아이콘 28 · 이름 16/600 · 메타 12 muted(" · " 로 잇고 mono 조각 지원), 아래 구분선(FilesMobile)
 *  · header — 아이콘 자리에 모듈 고유 그림(파일 유형 아이콘 등)을 넣을 때(Vue #header 슬롯). 이름·메타는 props 그대로.
 * 항목(items) = 48 · 15px · 아이콘 20 · 간격 14(UiMenu 와 같은 항목 형식 — description 이 있으면 56 두 줄, 하위 메뉴 항목은 ›).
 * children 은 항목 아래 자유 내용(보기·정렬 시트 등).
 * Esc 닫기 · 포커스 트랩 · ↑↓ 항목 이동 · 닫으면 연 요소로 포커스 복귀.
 * 마운트 = 열림. 부모가 조건부로 그렸다 뗀다(onClose 에서 상태를 내린다). body 로 포털.
 */
import { Fragment, useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '~/lib/utils'
import { UiIcon } from './Icon'
import { UiBadge } from './Badge'
import { FOCUSABLE, menuItemRole } from './internal'
import type { UiMenuItem } from './Menu'

type MetaPart = string | { text: string; mono?: boolean }

export interface UiActionSheetProps {
  /** 접근성 이름(머리글이 없을 때도 필수) */
  label: string
  /** 머리글 제목 */
  title?: string
  /** 머리글 아이콘(utils/icons.ts). header 가 있으면 그쪽 */
  icon?: string
  /** 머리글 메타 — 문자열 또는 조각 배열(" · " 로 잇는다) */
  meta?: string | MetaPart[]
  /** 항목(UiMenu 와 같은 형식) */
  items?: UiMenuItem[]
  /** 닫기(스크림 클릭·Esc) */
  onClose?: () => void
  /** 항목 고름 — 항목 key */
  onSelect?: (key: string) => void
  /** 머리글 아이콘 자리 그림(Vue #header 슬롯) */
  header?: ReactNode
  /** 항목 아래 자유 내용 */
  children?: ReactNode
}

/**
 * 바닥 시트.
 * @example {open && <UiActionSheet label="파일" title={file.name} icon="file" meta={[size, { text: date, mono: true }]} items={items} onSelect={run} onClose={() => setOpen(false)} />}
 */
export function UiActionSheet({ label, title, icon, meta, items = [], onClose, onSelect, header, children }: UiActionSheetProps) {
  const panel = useRef<HTMLDivElement | null>(null)
  // 안에서 누르기 시작해(입력 글자를 끌어 고르는 등) 스크림에서 뗀 것은 "바깥 클릭" 이 아니다 —
  // 그 경우에도 click 은 공통 조상인 스크림에서 나서, 예전에는 시트가 닫혔다.
  const downInside = useRef(false)

  const metaParts: { text: string; mono?: boolean }[] = !meta ? [] : (Array.isArray(meta) ? meta : [meta]).map(p => (typeof p === 'string' ? { text: p } : p))
  const richHeader = !!(icon || header != null || metaParts.length)

  function pick(it: UiMenuItem) {
    if (it.disabled || it.heading) return
    onSelect?.(it.key)
  }

  function onKeydown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); return }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const els = Array.from(panel.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? [])
      if (!els.length) return
      e.preventDefault()
      const i = els.indexOf(document.activeElement as HTMLElement)
      els[e.key === 'ArrowDown' ? (i + 1) % els.length : (i - 1 + els.length) % els.length]?.focus()
      return
    }
    if (e.key !== 'Tab') return
    const els = Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    if (!els.length) return
    const first = els[0], last = els[els.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    ;(panel.current?.querySelector<HTMLElement>(FOCUSABLE) ?? panel.current)?.focus()
    return () => { opener?.focus?.() }
  }, [])

  return createPortal(
    <div className="fixed inset-0 z-modal flex flex-col justify-end bg-scrim" 
      onMouseDown={(e) => { downInside.current = e.target !== e.currentTarget }}
      onClick={(e) => {
        const dragged = downInside.current
        downInside.current = false
        if (e.target === e.currentTarget && !dragged) onClose?.()
      }}
      onKeyDown={onKeydown}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="max-h-[85dvh] overflow-y-auto rounded-t-sheet border-t border-border bg-card pt-2.5 outline-hidden"
        style={{ paddingBottom: 'calc(28px + env(safe-area-inset-bottom))' }}
      >
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-muted" aria-hidden="true" />

        {richHeader
          ? (
            /* 머리글: 아이콘 + 이름 + 메타 */
            <div className="flex items-center gap-3 border-b border-border px-4 pb-3">
              {header ?? (icon ? <UiIcon name={icon} className="h-7 w-7 text-muted-foreground" strokeWidth={1.8} /> : null)}
              <div className="min-w-0">
                {title && <div className="truncate text-base font-semibold">{title}</div>}
                {metaParts.length > 0 && (
                  <div className="text-xs text-muted-foreground">
                    {metaParts.map((m, i) => (
                      <Fragment key={i}>{i > 0 && <span> · </span>}<span className={m.mono ? 'font-mono' : ''}>{m.text}</span></Fragment>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
          : title
            /* 머리글: 제목만 */
            ? <div className="truncate px-4 pb-2 text-[17px] font-semibold">{title}</div>
            : null}

        {items.length > 0 && (
          <div role="menu" aria-label={title || label}>
            {items.map(it => (
              <SheetRow key={it.key} it={it} onPick={pick} />
            ))}
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  )
}

function SheetRow({ it, onPick }: { it: UiMenuItem; onPick: (it: UiMenuItem) => void }) {
  return (
    <>
      {it.separated && <div className="my-1 h-px bg-border" role="separator" />}
      {it.heading
        ? <p className="px-4 pb-1 pt-3 text-xs font-semibold text-muted-foreground">{it.label}</p>
        : (
          <button
            type="button"
            role={menuItemRole(it)}
            aria-checked={it.checked}
            disabled={it.disabled}
            className={cn(
              'flex w-full items-center gap-3.5 px-4 text-left text-[15px] outline-hidden focus-visible:bg-accent/40 disabled:opacity-40',
              it.description ? 'min-h-14 py-2' : 'h-12',
              it.danger ? 'text-danger active:bg-danger/10' : 'text-foreground active:bg-accent/40',
            )}
            onClick={() => onPick(it)}
          >
            {it.icon && <UiIcon name={it.icon} className={cn('h-5 w-5 shrink-0', it.danger ? '' : 'text-muted-foreground')} />}
            {it.description
              ? (
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={cn('truncate', it.checked ? 'font-semibold' : '')}>{it.label}</span>
                  <span className="truncate text-xs text-muted-foreground">{it.description}</span>
                </span>
              )
              : <span className={cn('min-w-0 flex-1 truncate', it.checked ? 'font-semibold' : '')}>{it.label}</span>}
            {it.badge && <UiBadge tone="neutral" tint size={18} className="shrink-0">{it.badge}</UiBadge>}
            {it.hint && <span className="shrink-0 font-mono text-xs text-muted-foreground">{it.hint}</span>}
            {it.checked && <UiIcon name="check" className="h-[18px] w-[18px] shrink-0 text-primary" strokeWidth={2.4} />}
            {(it.children || it.panel !== undefined) && <UiIcon name="chevron-right" className="h-[18px] w-[18px] shrink-0 text-muted-foreground" />}
          </button>
        )}
    </>
  )
}

export default UiActionSheet
