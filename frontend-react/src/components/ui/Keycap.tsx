/**
 * 키캡(11-B8): 하나로 통일 — 높이 20, 좌우 패딩 5, 10px mono 600, bg-muted.
 * 팰릿·메뉴·상단바·단축키 도움말 모두 20. 툴팁 안(반전색 바탕)만 18 테두리형.
 */
import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '~/lib/utils'

export interface UiKeycapProps extends HTMLAttributes<HTMLElement> {
  /** 20(기본, 어디서나) · 18(툴팁 안, 반전색) */
  size?: 20 | 18
  /** 툴팁 등 반전색 바탕 위에 올릴 때 — 테두리형 */
  inverted?: boolean
  /** 키 글자(예: 'Ctrl' · 'K' · 'Esc') */
  children?: ReactNode
}

/**
 * 단축키 키캡(`<kbd>`).
 * @example <UiKeycap>Ctrl</UiKeycap><UiKeycap>K</UiKeycap>
 */
export function UiKeycap({ size = 20, inverted = false, className, children, ...rest }: UiKeycapProps) {
  return (
    <kbd
      {...rest}
      className={cn(
        'inline-flex items-center justify-center rounded-[6px] font-mono font-semibold leading-none',
        size === 18 ? 'h-[18px] min-w-[18px] rounded-[5px] px-1 text-[10px]' : 'h-5 min-w-5 px-[5px] text-[10px]',
        inverted
          ? 'border border-b-2 border-background/35 text-inherit'
          : 'bg-muted text-foreground',
        className,
      )}
    >{children}</kbd>
  )
}

export default UiKeycap
