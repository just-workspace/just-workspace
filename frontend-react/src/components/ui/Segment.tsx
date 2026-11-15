/**
 * 세그먼트 1종(시안 D): bg-muted 트랙 2px 패딩 + 선택 칸 bg-card(그림자 scrim/30), 32(안 28).
 * 이슈·PR·캘린더 월/주/일·관리 기간·테마 라이트/다크/시스템 공용. 모바일 탭 세그먼트는 size="lg"(40, 안 36).
 * role=radiogroup/radio(단일 선택). 아이콘만 쓰는 칸은 ariaLabel 로 이름을 준다. ←→ 로 이동·선택.
 */
import type { HTMLAttributes, KeyboardEvent } from 'react'
import { cn } from '~/lib/utils'
import { UiIcon } from './Icon'
import { UiTooltip } from './Tooltip'
import { useModel } from './internal'

export interface SegmentItem {
  value: string | number
  label?: string
  /** 아이콘 이름(utils/icons) */
  icon?: string
  /** 오른쪽 mono 카운트 */
  count?: number | string
  /** 아이콘만 쓸 때 접근성 이름 */
  ariaLabel?: string
  disabled?: boolean
  /**
   * 칸 툴팁(UiTooltip). disabled 와 같이 주면 왜 못 고르는지 보여 준다 —
   * 이때 칸은 aria-disabled 로 남아 호버·포커스를 받는다(눌러도 바뀌지 않음).
   */
  tooltip?: string
  /** 선택됐을 때 글자색(예: 작업 상태 진행 중 = warning · 완료 = success). 없으면 foreground */
  tone?: 'primary' | 'success' | 'warning' | 'danger'
}

const TONE_TEXT: Record<NonNullable<SegmentItem['tone']>, string> = {
  primary: 'text-primary', success: 'text-success', warning: 'text-warning', danger: 'text-danger',
}

export interface UiSegmentProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role'> {
  /** 고른 값(Vue v-model) */
  modelValue?: string | number | null
  /** 값 바뀜 */
  onUpdateModelValue?: (v: string | number | null) => void
  /** 칸 목록(필수) */
  items: SegmentItem[]
  /** sm 28(안 24, 메뉴 안) · md 32(기본, 안 28) · lg 40(안 36, 모바일) */
  size?: 'sm' | 'md' | 'lg'
  /** 칸을 균등 폭으로(모바일 탭) */
  grow?: boolean
  /** 묶음 접근성 이름 */
  ariaLabel?: string
}

const INNER = { sm: 'h-6 px-2 text-xs', md: 'h-7 px-3 text-xs', lg: 'h-9 px-3 text-[13px]' } as const
const TRACK = { sm: 'rounded-sm p-0.5', md: 'rounded-md p-0.5', lg: 'rounded-md p-0.5' } as const

/**
 * 세그먼트(단일 선택).
 * @example <UiSegment items={[{ value: 'month', label: '월' }, { value: 'week', label: '주' }]} modelValue={view} onUpdateModelValue={setView} />
 */
export function UiSegment({ modelValue, onUpdateModelValue, items, size = 'md', grow = false, ariaLabel, className, ...rest }: UiSegmentProps) {
  const [model, setModel] = useModel<string | number | null>(modelValue, null, onUpdateModelValue)
  const inner = INNER[size]
  const track = TRACK[size]

  function onKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const n = items.length
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    let j = i
    for (let k = 0; k < n; k++) {
      j = e.key === 'ArrowRight' ? (j + 1) % n : (j - 1 + n) % n
      if (!items[j].disabled) break
    }
    setModel(items[j].value)
    ;(e.currentTarget as HTMLElement).closest('[role=radiogroup]')?.querySelectorAll<HTMLElement>('[role=radio]')[j]?.focus()
  }

  return (
    <div {...rest} role="radiogroup" aria-label={ariaLabel} className={cn('inline-flex bg-muted', track, grow ? 'flex w-full' : '', className)}>
      {items.map((it, i) => {
        // 툴팁이 있는 비활성 칸은 disabled 대신 aria-disabled(비활성 버튼은 마우스 이벤트를 안 받아 툴팁이 안 뜬다)
        const softDisabled = !!it.disabled && !!it.tooltip
        const btn = (
        <button
          key={String(it.value)}
          type="button"
          role="radio"
          aria-checked={model === it.value}
          aria-label={it.ariaLabel}
          disabled={it.disabled && !softDisabled}
          aria-disabled={softDisabled || undefined}
          tabIndex={model === it.value || (model === null && i === 0) ? 0 : -1}
          className={cn(
            'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm font-medium transition-colors ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50',
            inner,
            grow ? 'flex-1' : '',
            model === it.value ? cn('bg-card font-semibold shadow-[0_1px_2px_hsl(var(--scrim)/0.3)]', it.tone ? TONE_TEXT[it.tone] : 'text-foreground') : 'text-muted-foreground hover:text-foreground',
            !it.label && it.icon ? (size === 'lg' ? 'w-9 px-0' : size === 'sm' ? 'w-6 px-0' : 'w-7 px-0') : '',
            softDisabled ? 'cursor-not-allowed opacity-50 hover:text-muted-foreground' : '',
          )}
          onClick={() => { if (!it.disabled) setModel(it.value) }}
          onKeyDown={e => onKey(e, i)}
        >
          {it.icon && <UiIcon name={it.icon} className="h-3.5 w-3.5" />}
          {it.label && <span>{it.label}</span>}
          {it.count !== undefined && <span className={cn('font-mono text-[11px] font-medium', model === it.value ? 'text-muted-foreground' : '')}>{it.count}</span>}
        </button>
        )
        return it.tooltip ? <UiTooltip key={String(it.value)} text={it.tooltip}>{btn}</UiTooltip> : btn
      })}
    </div>
  )
}

export default UiSegment
