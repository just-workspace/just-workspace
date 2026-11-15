/**
 * 카드형 라디오: 선택 = 1.5px primary 테두리 + primary/8 바탕.
 * 안은 children(미리보기 그림)과 제목 + mono 보조.
 *
 * layout="row"(가로형): 높이 56 한 줄 — 라디오 점 18 · 제목 13/600 · 설명 한 줄(12 muted, 넘치면 …) · 오른쪽 meta.
 * 선택 = border-primary + bg-primary/5. 세로로 쌓아 목록처럼 쓴다(`flex flex-col gap-2` 안에).
 */
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { useModel } from './internal'

export interface UiRadioCardProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'title' | 'type' | 'role' | 'disabled' | 'name'> {
  /** 그룹에서 고른 값(Vue v-model) */
  modelValue?: string | number | null
  /** 이 카드를 골랐을 때 — 이 카드의 value 로 불린다 */
  onUpdateModelValue?: (v: string | number | null) => void
  /** 이 카드의 값(필수) */
  value: string | number
  /** 제목(13/600, 필수) */
  title: string
  /** card: 제목 옆 mono 보조(예: 56) · row: 오른쪽 끝 mono 글자(metaSlot 이 없을 때) */
  meta?: string
  /** row 전용 — 오른쪽 끝 자리(배지·아이콘 등). 있으면 meta 대신 그린다 */
  metaSlot?: ReactNode
  /** card: 제목 아래 보조 글 · row: 제목 아래 한 줄(12 muted, truncate) */
  description?: string
  /** card(기본) — 미리보기 그림 + 제목 세로 카드 · row — 높이 56 가로형(점 18 · 제목 · 설명 한 줄 · 오른쪽 meta) */
  layout?: 'card' | 'row'
  disabled?: boolean
  /** (Vue 판에 있던 prop — 그려지지 않는다) */
  name?: string
  /** card 전용 — 제목 위 미리보기 그림 */
  children?: ReactNode
}

/**
 * 카드형 라디오.
 * @example <UiRadioCard value="compact" title="촘촘하게" meta="32" modelValue={density} onUpdateModelValue={setDensity}><DensityPreview/></UiRadioCard>
 * @example <UiRadioCard layout="row" value="this" title="이 일정만" description="다른 반복은 그대로 둡니다" meta="10월 17일" modelValue={scope} onUpdateModelValue={setScope} />
 */
export function UiRadioCard({ modelValue, onUpdateModelValue, value, title, meta, metaSlot, description, layout = 'card', disabled = false, name: _name, children, className, onClick, ...rest }: UiRadioCardProps) {
  const [model, setModel] = useModel<string | number | null>(modelValue, null, onUpdateModelValue)
  const checked = model === value
  function select() { if (!disabled) setModel(value) }
  const common = {
    ...rest,
    type: 'button' as const,
    role: 'radio',
    'aria-checked': checked,
    'aria-disabled': disabled || undefined,
    disabled,
    onClick: (e: MouseEvent<HTMLButtonElement>) => { onClick?.(e); select() },
  }

  if (layout === 'row') {
    return (
      <button
        {...common}
        className={cn(
          'flex h-14 w-full items-center gap-3 rounded-lg border px-3.5 text-left transition-colors ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          checked ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/40',
          disabled ? 'cursor-not-allowed opacity-50' : '',
          className,
        )}
      >
        {/* 라디오 점 18 — UiRadio 와 같은 모양(바깥 테두리 + 안 점 8) */}
        <span
          aria-hidden="true"
          className={cn(
            'grid size-[18px] shrink-0 place-items-center rounded-full transition-colors',
            checked ? 'shadow-[inset_0_0_0_1.5px_hsl(var(--primary))]' : 'shadow-[inset_0_0_0_1.5px_hsl(var(--muted-foreground))]',
          )}
        >
          {checked && <span className="size-[9px] rounded-full bg-primary" />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-semibold text-foreground">{title}</span>
          {description && <span className="truncate text-xs text-muted-foreground">{description}</span>}
        </span>
        {metaSlot != null
          ? <span className="flex shrink-0 items-center">{metaSlot}</span>
          : meta && <span className="shrink-0 font-mono text-[11px] font-medium text-muted-foreground">{meta}</span>}
      </button>
    )
  }

  return (
    <button
      {...common}
      className={cn(
        'flex flex-col gap-2.5 rounded-lg p-3 text-left transition-colors ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        checked ? 'border-[1.5px] border-primary bg-primary/[0.08]' : 'border border-border hover:bg-accent/40',
        disabled ? 'cursor-not-allowed opacity-50' : '',
        className,
      )}
    >
      {children}
      <span className="text-[13px] font-semibold text-foreground">
        {title}
        {meta && <>{' '}<span className="ml-1 font-mono text-[11px] font-medium text-muted-foreground">{meta}</span></>}
      </span>
      {description && <span className="-mt-1.5 text-xs text-muted-foreground">{description}</span>}
    </button>
  )
}

export default UiRadioCard
