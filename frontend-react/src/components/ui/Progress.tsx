/**
 * 진행 막대 · 용량 막대. 값이 있으면 채움 비율을, 값이 없으면(null) "얼마나 남았는지 모르는 진행"을 표시한다.
 * - as="progressbar"(기본): 진행 — aria-valuenow 가 변경되어도 낭독되지 않는다(aria-live 없음). 숫자는 인접 글자로 표시할 것.
 * - as="meter": 용량 대비 사용량(권장 메모리 합계 등).
 * 색은 tone 으로만 지정한다(색만으로 상태를 전달하지 않는다 — 인접 위치에 글자·아이콘을 함께 배치할 것).
 */
import type { HTMLAttributes } from 'react'
import { cn } from '~/lib/utils'

export type UiProgressTone = 'primary' | 'success' | 'warning' | 'danger'

export interface UiProgressProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role'> {
  /** 현재 값(min~max). null 이면 종료 시점 미상의 진행(움직이는 막대) */
  value: number | null
  /** 최솟값(기본 0) */
  min?: number
  /** 최댓값(기본 100) */
  max?: number
  /** 접근성 이름(필수) */
  label: string
  /** 막대 색(기본 primary) */
  tone?: UiProgressTone
  /** sm 4 · md 8(기본) */
  size?: 'sm' | 'md'
  /** progressbar(기본) · meter */
  as?: 'progressbar' | 'meter'
}

const TONE: Record<UiProgressTone, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
}

/** 채움 비율(0~100). 범위를 벗어난 값은 범위 내로 제한 */
export function progressPercent(value: number, min: number, max: number): number {
  if (!(max > min)) return 0
  return Math.max(0, Math.min(100, Math.round(((value - min) / (max - min)) * 100)))
}

/**
 * 진행 막대.
 * @example <UiProgress label="설치 진행" value={3} max={7} />
 * @example <UiProgress as="meter" label="권장 메모리" value={7} max={16} tone="primary" />
 */
export function UiProgress({ value, min = 0, max = 100, label, tone = 'primary', size = 'md', as = 'progressbar', className, ...rest }: UiProgressProps) {
  const known = value != null
  const pct = known ? progressPercent(value, min, max) : 0
  return (
    <div
      {...rest}
      role={as}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={known ? Math.max(min, Math.min(max, value)) : undefined}
      className={cn('w-full overflow-hidden rounded-full bg-muted', size === 'sm' ? 'h-1' : 'h-2', className ?? '')}
    >
      {known
        ? <div data-slot="bar" className={cn('h-full rounded-full transition-[width] duration-300 ease-out motion-reduce:transition-none', TONE[tone])} style={{ width: `${pct}%` }} />
        : <div data-slot="bar" className={cn('h-full w-1/3 rounded-full animate-pulse motion-reduce:animate-none', TONE[tone])} />}
    </div>
  )
}

export default UiProgress
