/**
 * 배지(시안 I): 솔리드 = 알약 22 · 틴트 = 각진 칩(22 → 6px, 18 → 5px) × 중립·primary·success·warning·danger.
 * 숫자 배지(나를 부른 것)는 솔리드 primary 만. 상태는 항상 글자(또는 아이콘 children)와 함께.
 *
 * 기존 사용처 호환: variant(default/secondary/destructive/outline/success/warning) 는 tone 으로 매핑된다.
 */
import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '~/lib/utils'

export type UiBadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger'
type LegacyVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning'

export interface UiBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** 색 톤. 없으면 variant(호환)로 → 그것도 없으면 primary */
  tone?: UiBadgeTone
  /** 틴트(각진 칩). 기본은 솔리드(알약) */
  tint?: boolean
  /** 22(기본) · 18(표 안·메타 줄) */
  size?: 22 | 18
  /** @deprecated tone/tint 로 대체. 기존 화면 호환용 */
  variant?: LegacyVariant
  /** 배지 글자(앞에 svg 아이콘을 둘 수 있다 — 12px 로 맞춰진다) */
  children?: ReactNode
}

const SOLID: Record<UiBadgeTone, string> = {
  neutral: 'bg-secondary text-secondary-foreground',
  primary: 'bg-primary text-primary-foreground',
  success: 'bg-success text-background',
  warning: 'bg-warning text-background',
  danger: 'bg-danger text-background',
}
const TINT: Record<UiBadgeTone, string> = {
  neutral: 'bg-muted text-foreground/85',
  primary: 'bg-primary/15 text-primary',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/15 text-danger',
}

function resolveTone(tone: UiBadgeTone | undefined, tint: boolean, variant: LegacyVariant | undefined): { tone: UiBadgeTone; tint: boolean; outline: boolean } {
  if (tone) return { tone, tint, outline: false }
  switch (variant) {
    case 'secondary': return { tone: 'neutral', tint, outline: false }
    case 'destructive': return { tone: 'danger', tint, outline: false }
    case 'outline': return { tone: 'neutral', tint: false, outline: true }
    case 'success': return { tone: 'success', tint, outline: false }
    case 'warning': return { tone: 'warning', tint, outline: false }
    default: return { tone: 'primary', tint, outline: false }
  }
}

/**
 * 상태·개수 배지.
 * @example <UiBadge tone="warning" tint size={18}>승인 대기</UiBadge>
 */
export function UiBadge({ tone, tint = false, size = 22, variant, className, children, ...rest }: UiBadgeProps) {
  const r = resolveTone(tone, tint, variant)
  const shape = r.tint
    ? (size === 18 ? 'h-[18px] rounded-[5px] px-1.5 text-[11px]' : 'h-[22px] rounded-[6px] px-2 text-xs')
    : (size === 18 ? 'h-[18px] rounded-full px-1.5 text-[11px]' : 'h-[22px] rounded-full px-2 text-xs')
  const color = r.outline
    ? 'border border-border text-foreground'
    : (r.tint ? TINT[r.tone] : SOLID[r.tone])
  const classes = cn('inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-semibold leading-none [&>svg]:h-3 [&>svg]:w-3', shape, color)
  return (
    <span {...rest} className={cn(classes, className ?? '')}>
      {children}
    </span>
  )
}

export default UiBadge
