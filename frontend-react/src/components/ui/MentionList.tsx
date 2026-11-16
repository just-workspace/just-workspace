/**
 * 멘션 자동완성 목록 — 입력(textarea·input) 위/아래에 부착되는 listbox.
 * (상세 설명·예시는 아래 컴포넌트 JSDoc 참조)
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '~/lib/utils'
import { toCssRect, viewportCss } from '~/composables/useViewport'
import { useI18n } from '~/i18n'
import { UiAvatar } from './Avatar'
import { UiKeycap } from './Keycap'
import { useUid } from './internal'

export interface UiMentionOption {
  /** 고유 id */
  id: string
  /** 이름(13/500) */
  label: string
  /** 보조 글(이메일·@아이디·권한 등, 12 muted) */
  secondary?: string
  /** 아바타 사진 */
  avatarUrl?: string | null
  /** 아바타 글자(기본 = 이름 첫 글자) */
  initial?: string
  /** 앞 칸의 아바타를 대체할 내용(예: `:` 자동완성의 이모지 24 · 역할 점) */
  leading?: ReactNode
  /** 오른쪽 꼬리표(예: "역할" · "GIF" · 단축키) — 선택 행의 ↵ 키캡 앞에 배치된다 */
  trailing?: ReactNode
  /** 선택 불가 — 행 60% + aria-disabled, 마우스·Enter 로 선택되지 않는다(↑↓ 로는 통과하며 사유가 낭독된다) */
  disabled?: boolean
  /** 선택 불가 사유(12 muted, 보조 글 뒤 · 화면 낭독기에서도 이어서 낭독됨) */
  disabledReason?: string
  /** 이름 글자 클래스(예: 역할 색 text-role-N) */
  labelClassName?: string
}

export interface UiMentionListProps {
  /** listbox id(입력 aria-controls). 행 id 는 `${id}-${i}` — useUiMentionList().id 를 전달한다 */
  id: string
  /** 후보 */
  options: UiMentionOption[]
  /** 선택(강조) 행 */
  activeIndex: number
  /** 마우스 호버 시 호출 */
  onActiveChange?: (i: number) => void
  /** 행 선택(마우스) — 키보드 선택은 useUiMentionList 가 동일한 onPick 을 호출한다 */
  onPick: (i: number) => void
  /** 머리글(예: "이 파일을 볼 수 있는 사람") */
  heading?: ReactNode
  /** 바닥 안내 줄(예: "볼 권한이 없는 사람은 언급해도 알림이 가지 않습니다") */
  footer?: ReactNode
  /** 기준 요소(포털 + fixed). 없으면 relative 부모 안 absolute */
  anchor?: HTMLElement | null
  /** 위(기본) / 아래 */
  placement?: 'top' | 'bottom'
  /** 접근성 이름(기본 "멘션할 사람") */
  ariaLabel?: string
  /** 목록 최대 높이 px(기본 240) */
  maxHeight?: number
  /** 크기 — default(행 36 · 이름 13/500 · 보조 12 · 선택 bg-accent) · chat(채팅 자동완성: 행 36 · 이름 14/500 · 보조 13 · 선택 overlay-selected /20 · 호버 /12) */
  size?: 'default' | 'chat'
  className?: string
}

/** 입력 쪽 키보드·aria 묶음 */
export interface UiMentionListController {
  /** listbox id */
  id: string
  active: number
  setActive: (i: number) => void
  /** 선택(마우스·키보드 공통) */
  pick: (i: number) => void
  /** 입력 onKeyDown 최상단에서 호출한다 — 처리한 경우 true 반환(입력의 다른 단축키는 생략한다) */
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => boolean
  /** 입력에 전개할 aria(role=combobox · aria-expanded · aria-controls · aria-activedescendant · aria-autocomplete) */
  inputProps: {
    role: 'combobox'
    'aria-autocomplete': 'list'
    'aria-expanded': boolean
    'aria-controls': string | undefined
    'aria-activedescendant': string | undefined
  }
}

/**
 * 멘션 목록 제어 훅 — 후보 수 변경 시 선택을 첫 항목으로 초기화한다.
 */
export function useUiMentionList({ count, open, onPick, onClose, idPrefix = 'ui-mention', anyEnter = false, isDisabled }: {
  /** 후보 수 */
  count: number
  /** 목록 표시 여부(후보 0 이면 키를 가로채지 않는다) */
  open: boolean
  /** i 번째 항목 선택 시 호출 */
  onPick: (i: number) => void
  /** Esc */
  onClose: () => void
  idPrefix?: string
  /** Shift·Ctrl·⌘ 조합 Enter 도 선택으로 처리(채팅 입력의 기존 동작). 기본은 수식키 없는 Enter 만 처리 */
  anyEnter?: boolean
  /** i 번째 행의 선택 불가 여부(옵션 disabled) — Enter/Tab 은 소비하되 onPick 은 호출하지 않는다 */
  isDisabled?: (i: number) => boolean
}): UiMentionListController {
  const id = useUid(idPrefix)
  const [active, setActive] = useState(0)
  const [prevCount, setPrevCount] = useState(count)
  if (count !== prevCount) { setPrevCount(count); setActive(0) }
  const shown = open && count > 0
  const cur = Math.min(active, Math.max(0, count - 1))
  function onKeyDown(e: KeyboardEvent<HTMLElement>): boolean {
    if (!shown) return false
    // 한글 조합 중 Enter·Tab 은 IME 소관 — 여기서 선택 처리하면 조합 중이던 글자가 중복된다
    if (e.nativeEvent.isComposing || e.keyCode === 229) return false
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((cur + 1) % count); return true }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((cur - 1 + count) % count); return true }
    if ((e.key === 'Enter' && (anyEnter || (!e.ctrlKey && !e.metaKey))) || e.key === 'Tab') { e.preventDefault(); if (!isDisabled?.(cur)) onPick(cur); return true }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return true }
    return false
  }
  return {
    id,
    active: cur,
    setActive,
    pick: onPick,
    onKeyDown,
    inputProps: {
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': shown,
      'aria-controls': shown ? id : undefined,
      'aria-activedescendant': shown ? `${id}-${cur}` : undefined,
    },
  }
}

/**
 * 멘션 자동완성 목록 — 입력(textarea·input) 위/아래에 부착되는 listbox.
 * 채팅 입력·게시판 댓글·파일 댓글이 공용으로 사용한다.
 *
 * 모양: rounded-lg · border · bg-popover · shadow-md. 머리글(11/600 muted) · 행 36(아바타 20 · 이름 13/500 · 보조 글 12 muted)
 *       · 선택 행 bg-accent + 오른쪽 ↵ 키캡 · 바닥 안내 줄(12 muted, 위 테두리).
 *       옵션 슬롯: leading(아바타 자리 대체) · trailing(오른쪽 꼬리표) · disabled + disabledReason(60% + 사유 12 muted,
 *       aria-disabled, 클릭·Enter 로 선택 불가 — 훅에 isDisabled 를 함께 지정한다).
 * 키보드: 포커스는 입력에 유지한다(aria-activedescendant) — 입력 onKeyDown 에서 useUiMentionList().onKeyDown(e) 를 먼저 호출한다.
 *   ↑↓ 이동(순환) · Enter/Tab 선택(Ctrl/⌘+Enter 는 처리하지 않음 — 전송 단축키, anyEnter 면 해당 조합도 선택) · Esc 닫기.
 * 위치: anchor 를 지정하면 해당 요소 기준(body 포털, fixed — 위(top, 기본)/아래, 공간 부족 시 반전, 폭 = anchor 폭).
 *   anchor 가 없으면 relative 부모 안 absolute(입력 상자 바로 위/아래, 좌우 전체 폭).
 *
 * @example
 * const m = useUiMentionList({ count: users.length, open, onPick: i => insert(users[i]), onClose: close })
 * <div className="relative">
 *   {open && <UiMentionList id={m.id} options={users.map(u => ({ id: u.id, label: u.name, secondary: u.email, avatarUrl: u.avatar }))}
 *     activeIndex={m.active} onActiveChange={m.setActive} onPick={m.pick}
 *     heading="이 파일을 볼 수 있는 사람" footer="볼 권한이 없는 사람은 언급해도 알림이 가지 않습니다" />}
 *   <textarea {...m.inputProps} onKeyDown={e => { if (m.onKeyDown(e)) return; … }} />
 * </div>
 */
export function UiMentionList({
  id, options, activeIndex, onActiveChange, onPick, heading, footer, anchor, placement = 'top', ariaLabel, maxHeight = 240, size = 'default', className,
}: UiMentionListProps) {
  const { t } = useI18n()
  const chat = size === 'chat'
  const listRef = useRef<HTMLDivElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)

  // 선택 행 가시 영역 유지
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[id="${id}-${activeIndex}"]`)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [id, activeIndex])

  // anchor 기준 위치(위 → 공간 부족 시 아래, 반대 방향도 동일)
  useLayoutEffect(() => {
    if (!anchor) return
    const place = () => {
      const box = boxRef.current
      if (!box) return
      const r = toCssRect(anchor.getBoundingClientRect())
      const { vw, vh } = viewportCss()
      const h = box.offsetHeight
      const above = r.top - 4 - h, below = r.bottom + 4
      let top = placement === 'top' ? above : below
      if (placement === 'top' && above < 8 && below + h <= vh - 8) top = below
      if (placement === 'bottom' && below + h > vh - 8 && above >= 8) top = above
      const width = Math.min(r.width, vw - 16)
      setPos({ left: Math.max(8, Math.min(r.left, vw - width - 8)), top: Math.max(8, top), width })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [anchor, placement, options.length])

  const panel = (
    <div
      ref={boxRef}
      className={cn(
        'z-dropdown overflow-hidden rounded-lg border border-border bg-popover text-foreground shadow-md',
        anchor ? 'fixed' : cn('absolute left-0 right-0', placement === 'top' ? 'bottom-full mb-1' : 'top-full mt-1'),
        className,
      )}
      style={anchor ? { left: `${pos?.left ?? 0}px`, top: `${pos?.top ?? 0}px`, width: `${pos?.width ?? 0}px`, visibility: pos ? 'visible' : 'hidden' } : undefined}
    >
      {heading != null && <div className={cn('px-3 pb-1 pt-2 font-semibold text-muted-foreground', chat ? 'text-[12px]' : 'text-[11px]')}>{heading}</div>}
      <div
        ref={listRef}
        id={id}
        role="listbox"
        aria-label={ariaLabel ?? t('ui.mention.label')}
        className="overflow-y-auto p-1"
        style={{ maxHeight: `${maxHeight}px` }}
      >
        {options.map((o, i) => {
          const on = i === activeIndex
          const off = !!o.disabled
          return (
            <div
              key={o.id}
              id={`${id}-${i}`}
              role="option"
              aria-selected={on}
              aria-disabled={off || undefined}
              className={cn(
                'flex h-9 items-center gap-2 px-2 transition-colors', off ? 'cursor-not-allowed' : 'cursor-pointer',
                chat ? cn('rounded-md text-[14px]', on ? 'bg-overlay-selected' : 'hover:bg-overlay-hover') : cn('rounded-sm text-[13px]', on ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/40'),
              )}
              onMouseDown={(e) => { e.preventDefault(); if (!off) onPick(i) }}
              onMouseEnter={() => onActiveChange?.(i)}
            >
              <span className={cn('flex min-w-0 flex-1 items-center gap-2', off ? 'opacity-60' : '')}>
                {o.leading != null
                  ? <span className="flex shrink-0 items-center justify-center">{o.leading}</span>
                  : <UiAvatar src={o.avatarUrl} alt={o.label} fallback={(o.initial ?? (o.label || '?').charAt(0)).toUpperCase()} className="h-5 w-5 shrink-0" textSize={10} />}
                <span className={cn('min-w-0 shrink truncate font-medium', o.labelClassName)}>{o.label}</span>
                {o.secondary && <span className={cn('min-w-0 flex-1 truncate text-muted-foreground', chat ? 'text-[13px]' : 'text-xs')}>{o.secondary}</span>}
                {off && o.disabledReason && <span className={cn('min-w-0 shrink truncate text-muted-foreground', chat ? 'text-[13px]' : 'text-xs')}>{o.disabledReason}</span>}
              </span>
              {o.trailing != null && <span className={cn('ml-auto flex shrink-0 items-center', off ? 'opacity-60' : '')}>{o.trailing}</span>}
              {on && !off && <UiKeycap size={18} className={cn('shrink-0', o.trailing != null ? '' : 'ml-auto')} aria-hidden="true">↵</UiKeycap>}
            </div>
          )
        })}
      </div>
      {footer != null && <div className={cn('border-t border-border px-3 py-2 text-muted-foreground', chat ? 'text-[11px]' : 'text-xs')}>{footer}</div>}
    </div>
  )

  return anchor ? createPortal(panel, document.body) : panel
}

export default UiMentionList
