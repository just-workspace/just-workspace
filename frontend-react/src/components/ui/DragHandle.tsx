/**
 * 끌기 손잡이 + 놓을 자리 선.
 *
 * UiDragHandle — grip-vertical 16 아이콘 버튼(기본 24×24, touch 44). aria-label "순서 바꾸기"(바꿀 수 있음).
 *   hoverOnly 면 평소 투명, 부모 행(.group)에 호버 · 손잡이 포커스 때만 보인다 — 부모에 className="group" 을 붙인다.
 *   키보드: ↑ / ↓ = onMove(-1 | 1) — 실제 순서 바꾸기·aria-live 안내는 호출부(목록)가 한다. 끌기(HTML5 draggable·포인터)도 호출부 몫:
 *   나머지 속성(draggable·onDragStart·onPointerDown 등)은 <button> 에 그대로 붙는다.
 * UiDropLine — 놓을 자리 표시: 2px primary 선 + 왼쪽 8px 원(테두리 2 primary). aria-hidden. 행 사이에 끼워 넣는다.
 *
 * @example
 * <div className="group relative flex h-10 items-center gap-2">
 *   <UiDragHandle hoverOnly onMove={d => moveRole(r.id, d)} draggable onDragStart={…} />
 *   …
 * </div>
 * {dropIndex === i && <UiDropLine className="my-0.5" />}
 */
import type { ButtonHTMLAttributes, HTMLAttributes, KeyboardEvent, Ref } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { UiIcon } from './Icon'

export interface UiDragHandleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** ↑(-1) / ↓(1) 키 — 한 칸 옮기기 */
  onMove?: (delta: -1 | 1) => void
  /** 부모 .group 호버·포커스 때만 보이기 */
  hoverOnly?: boolean
  /** md 24(기본) · touch 44(모바일 순서 편집) */
  size?: 'md' | 'touch'
  /** 접근성 이름(기본 "순서 바꾸기") */
  ariaLabel?: string
  ref?: Ref<HTMLButtonElement>
}

/**
 * 끌기 손잡이(grip-vertical).
 */
export function UiDragHandle({ onMove, hoverOnly = false, size = 'md', ariaLabel, className, onKeyDown, disabled, ...rest }: UiDragHandleProps) {
  const { t } = useI18n()
  function onKey(e: KeyboardEvent<HTMLButtonElement>) {
    onKeyDown?.(e)
    if (e.defaultPrevented || disabled) return
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      onMove?.(e.key === 'ArrowUp' ? -1 : 1)
    }
  }
  return (
    <button
      {...rest}
      type="button"
      aria-label={ariaLabel ?? t('ui.kit22.reorder')}
      title={ariaLabel ?? t('ui.kit22.reorder')}
      disabled={disabled}
      className={cn(
        'inline-flex shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-muted-foreground transition-opacity hover:text-foreground active:cursor-grabbing focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-0',
        size === 'touch' ? 'h-11 w-11' : 'h-6 w-6',
        hoverOnly ? 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100' : '',
        className,
      )}
      onKeyDown={onKey}
    >
      <UiIcon name="grip-vertical" className={size === 'touch' ? 'h-5 w-5' : 'h-4 w-4'} />
    </button>
  )
}

export type UiDropLineProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'>

/**
 * 놓을 자리 선(2px primary + 왼쪽 8px 원). aria-hidden — 안내는 호출부 aria-live.
 */
export function UiDropLine({ className, ...rest }: UiDropLineProps) {
  return (
    <span {...rest} aria-hidden="true" data-drop-line="" className={cn('pointer-events-none flex items-center', className)}>
      <span className="h-2 w-2 shrink-0 rounded-full border-2 border-primary" />
      <span className="h-0.5 flex-1 bg-primary" />
    </span>
  )
}

export default UiDragHandle
