/**
 * 아이콘 전용 버튼(시안 9-a): 32(데스크톱) / 40(터치) / 44(모바일 상단바). aria-label 필수, 툴팁 자동.
 * 시안의 <span aria-label> 자리는 전부 이 <button> 으로.
 *
 * 툴팁 래퍼는 상자를 만들지 않으므로(display: contents) 부르는 쪽의 위치 클래스(absolute …)가 이 버튼에 그대로 먹는다.
 * 기본 relative 는 children 안 배지(absolute 점)의 기준 — 부르는 쪽이 absolute/fixed 를 주면 cn() 이 그쪽으로 덮는다.
 * className 과 나머지 속성(onClick·aria-*·data-* 등)은 모두 안쪽 <button> 에 붙는다.
 */
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { cn } from '~/lib/utils'
import { UiIcon } from './Icon'
import { UiTooltip } from './Tooltip'

export interface UiIconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** 툴팁 문구 = aria-label (필수) */
  label: string
  /** utils/icons.ts 아이콘 이름. 없으면 children 으로 그린다 */
  icon?: string
  /** sm 32(기본) · md 40 · lg 44 */
  size?: 'sm' | 'md' | 'lg'
  /** ghost(기본) · outline(테두리+카드 바탕, 상단바 벨) · solid(primary) · muted(채움, 미니 통화 창) */
  variant?: 'ghost' | 'outline' | 'solid' | 'muted'
  /** 토글 버튼(별표·고정)일 때 aria-pressed. 안 주면 속성 없음 */
  pressed?: boolean
  /** 툴팁에 병기할 단축키. 예: ['Esc'] */
  keys?: string[]
  /** 툴팁 끄기(라벨만 aria 로) */
  noTooltip?: boolean
  disabled?: boolean
  /** 기본 'button' */
  type?: 'button' | 'submit'
  /** 안쪽 <button> */
  ref?: Ref<HTMLButtonElement>
  /** icon 대신 그릴 내용(아이콘 + 배지 점 등) */
  children?: ReactNode
}

const SIZE = {
  sm: 'h-8 w-8 rounded-sm [&>svg]:h-[15px] [&>svg]:w-[15px]',
  md: 'h-10 w-10 rounded-md [&>svg]:h-[18px] [&>svg]:w-[18px]',
  lg: 'h-11 w-11 rounded-md [&>svg]:h-5 [&>svg]:w-5',
} as const

const VARIANT = {
  ghost: 'text-muted-foreground hover:bg-accent hover:text-foreground',
  outline: 'border border-border bg-card text-muted-foreground hover:text-foreground',
  solid: 'bg-primary text-primary-foreground hover:bg-primary/90',
  muted: 'bg-muted text-foreground hover:bg-accent',
} as const

/**
 * 아이콘 버튼(+툴팁).
 * @example <UiIconButton label="닫기" icon="close" keys={['Esc']} onClick={onClose} />
 */
export function UiIconButton({
  label, icon, size = 'sm', variant = 'ghost', pressed, keys = [], noTooltip = false, disabled = false, type = 'button',
  className, children, ...rest
}: UiIconButtonProps) {
  return (
    <UiTooltip text={label} keys={keys} disabled={noTooltip}>
      <button
        {...rest}
        type={type}
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        className={cn(
          'relative inline-flex shrink-0 items-center justify-center transition-colors ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
          SIZE[size], VARIANT[variant],
          pressed ? 'text-foreground' : '',
          className ?? '',
        )}
      >
        {children ?? (icon ? <UiIcon name={icon} /> : null)}
      </button>
    </UiTooltip>
  )
}

export default UiIconButton
