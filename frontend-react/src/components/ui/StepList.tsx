/**
 * 단계 목록 — 여러 화면을 차례로 지나는 흐름의 "지금 어디인지".
 * 단계 상태 네 가지: done(완료) · current(현재) · todo(남음) · skipped(건너뜀). 색만으로 구분하지 않는다 —
 * 완료는 체크, 건너뜀은 줄표 + 취소선 + "건너뜀" 글자, 현재는 채운 번호 + aria-current="step".
 * 번호는 건너뛴 단계를 빼고 매긴다.
 * - variant="list": 세로 목록(<ol>) — 넓은 화면의 옆 칸.
 * - variant="compact": "3/11 단계 이름" 한 줄 + 진행 막대 — 좁은 화면의 위쪽 줄.
 * 문구(상태 이름)는 호출처가 준다(키트는 번역 키를 갖지 않는다).
 */
import type { HTMLAttributes } from 'react'
import { cn } from '~/lib/utils'
import { UiIcon } from './Icon'
import { UiProgress } from './Progress'

export type UiStepState = 'done' | 'current' | 'todo' | 'skipped'

export interface UiStep {
  id: string
  label: string
  state: UiStepState
}

export interface UiStepListLabels {
  /** 화면 낭독기용 상태 이름 */
  done: string
  current: string
  todo: string
  /** 건너뛴 단계 오른쪽에 보이는 글자 */
  skipped: string
}

export interface UiStepListProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  /** 단계(필수) — 건너뛴 것도 자리 그대로 넣는다 */
  steps: UiStep[]
  /** 묶음 접근성 이름(필수). 예: '설치 단계' */
  label: string
  /** 상태 이름(필수) */
  labels: UiStepListLabels
  /** list(기본) · compact */
  variant?: 'list' | 'compact'
}

/** 건너뛴 단계를 뺀 번호·현재 위치·전체 수 */
export function stepPosition(steps: UiStep[]): { numbers: Array<number | null>; now: number; total: number; current: UiStep | null } {
  let n = 0
  const numbers = steps.map(s => (s.state === 'skipped' ? null : ++n))
  const idx = steps.findIndex(s => s.state === 'current')
  return { numbers, now: idx >= 0 ? (numbers[idx] ?? 0) : 0, total: n, current: idx >= 0 ? steps[idx] : null }
}

/**
 * 단계 목록.
 * @example <UiStepList label="설치 단계" labels={{ done: '완료', current: '현재 단계', todo: '남음', skipped: '건너뜀' }} steps={steps} />
 */
export function UiStepList({ steps, label, labels, variant = 'list', className, ...rest }: UiStepListProps) {
  const pos = stepPosition(steps)

  if (variant === 'compact') {
    return (
      <div {...rest} className={cn('flex flex-col gap-2', className ?? '')}>
        <div className="flex items-baseline gap-2 text-[13.5px]">
          <span className="font-mono text-muted-foreground">{pos.now}/{pos.total}</span>
          <span className="min-w-0 truncate font-semibold">{pos.current?.label ?? ''}</span>
        </div>
        <UiProgress size="sm" label={label} value={pos.now} min={1} max={Math.max(pos.total, 1)} />
      </div>
    )
  }

  return (
    <ol {...rest} aria-label={label} className={cn('m-0 flex list-none flex-col gap-1 p-0', className ?? '')}>
      {steps.map((s, i) => {
        const now = s.state === 'current'
        const done = s.state === 'done'
        const skip = s.state === 'skipped'
        return (
          <li
            key={s.id}
            data-state={s.state}
            aria-current={now ? 'step' : undefined}
            className={cn(
              'flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px]',
              now ? 'bg-accent font-semibold text-foreground' : (done ? 'text-foreground' : 'text-muted-foreground'),
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'flex size-[22px] shrink-0 items-center justify-center rounded-full border-[1.5px] font-mono text-[11px] font-medium',
                now && 'border-primary bg-primary text-primary-foreground',
                done && 'border-success text-success',
                skip && 'border-dashed border-muted-foreground/50',
                s.state === 'todo' && 'border-muted-foreground/50',
              )}
            >
              {done || skip
                ? <UiIcon name={skip ? 'minus' : 'check'} strokeWidth={2.4} className="size-3" />
                : pos.numbers[i]}
            </span>
            <span className={cn('min-w-0 flex-1', skip && 'line-through')}>{s.label}</span>
            {skip
              ? <span className="shrink-0 text-xs">{labels.skipped}</span>
              : <span className="sr-only">{done ? labels.done : (now ? labels.current : labels.todo)}</span>}
          </li>
        )
      })}
    </ol>
  )
}

export default UiStepList
