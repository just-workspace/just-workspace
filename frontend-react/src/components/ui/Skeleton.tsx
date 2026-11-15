/**
 * 스켈레톤(시안 H): 프리셋 5종 — list(목록 행) · card · table(표 행) · grid(타일) · text(본문 문단).
 * 프리셋 없이 className 만 주면 예전처럼 막대 하나(기존 대시보드 사용처 호환).
 * 300ms 안에 끝나는 로딩은 보이지 않게(.skeleton-delay). 즉시 보여야 하면 delay={false}.
 */
import type { HTMLAttributes } from 'react'
import { cn } from '~/lib/utils'

export interface UiSkeletonProps extends HTMLAttributes<HTMLDivElement> {
  /** list(아바타 28 + 두 줄) · card(제목·큰 숫자·본문) · table(36 행) · grid(타일) · text(문단). 없으면 막대 하나 */
  preset?: 'list' | 'card' | 'table' | 'grid' | 'text'
  /** 행·타일 개수(list/table/grid/text). 기본 3 */
  rows?: number
  /** 300ms 지연 표시(기본 켬) */
  delay?: boolean
  /** 카드 틀(border+bg-card)로 감쌀지 */
  framed?: boolean
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

/**
 * 로딩 자리.
 * @example <UiSkeleton preset="list" rows={5} />  ·  <UiSkeleton className="h-4 w-32" />
 */
export function UiSkeleton({ preset, rows = 3, delay = true, framed = false, className, ...rest }: UiSkeletonProps) {
  // 막대 하나(호환)
  if (!preset) {
    return (
      <div
        {...rest}
        aria-hidden="true"
        className={cn('animate-pulse rounded-md bg-muted', delay ? 'skeleton-delay' : '', className ?? '')}
      />
    )
  }

  return (
    <div
      {...rest}
      aria-busy="true"
      aria-live="polite"
      className={cn(
        'animate-pulse',
        delay ? 'skeleton-delay' : '',
        framed ? 'rounded-lg border border-border bg-card' : '',
        className ?? '',
      )}
    >
      {/* 목록 행: 아바타 28 + 두 줄 */}
      {preset === 'list' && range(rows).map(i => (
        <div key={i} className="flex h-row items-center gap-2.5 px-3.5">
          <span className="h-7 w-7 shrink-0 rounded-full bg-muted" />
          <span className="flex flex-1 flex-col gap-1.5">
            <span className="h-2.5 w-[70%] rounded-[6px] bg-muted" />
            <span className="h-2 w-[45%] rounded-[6px] bg-muted/60" />
          </span>
        </div>
      ))}

      {/* 카드: 제목 · 큰 숫자 · 본문 */}
      {preset === 'card' && (
        <div className="flex flex-col gap-2.5 p-3.5">
          <span className="h-2.5 w-[40%] rounded-[6px] bg-muted" />
          <span className="h-6 w-[60%] rounded-[6px] bg-muted" />
          <span className="h-9 w-full rounded-[6px] bg-muted/60" />
        </div>
      )}

      {/* 표 행: 36 */}
      {preset === 'table' && range(rows).map(i => (
        <div key={i} className="flex h-9 items-center gap-2.5 border-b border-border px-3 last:border-b-0">
          <span className="h-[9px] w-[30%] rounded-[6px] bg-muted" />
          <span className="h-[9px] w-[25%] rounded-[6px] bg-muted/60" />
          <span className="ml-auto h-[9px] w-[15%] rounded-[6px] bg-muted/60" />
        </div>
      ))}

      {/* 그리드 타일 */}
      {preset === 'grid' && (
        <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-4">
          {range(rows).map(i => (
            <div key={i} className="flex flex-col gap-1.5">
              <span className="h-11 rounded-sm bg-muted" />
              <span className="h-2 w-[70%] rounded-[6px] bg-muted/60" />
            </div>
          ))}
        </div>
      )}

      {/* 본문 문단 */}
      {preset === 'text' && (
        <div className="flex flex-col gap-2 p-3.5">
          <span className="h-3.5 w-[55%] rounded-[6px] bg-muted" />
          {range(rows).map(i => (
            <span key={i} className="h-2 rounded-[6px] bg-muted/60" style={{ width: `${[100, 94, 80, 88, 72][(i - 1) % 5]}%` }} />
          ))}
        </div>
      )}
    </div>
  )
}

export default UiSkeleton
