/**
 * 필터 칩: 32 알약, 선택 = primary/13 + border primary/50 + ✓(색만 아님), 카운트 mono.
 * 모바일은 36(size="lg"). 점선 "+ 필터" 는 variant="add". aria-pressed 토글 버튼.
 * 켜짐 값은 modelValue/onUpdateModelValue. 미지정 시 칩이 토글 상태를 자체 보유한다.
 * surface="raised": 팝오버·시트·모달(card 바탕 + 그림자) 위에 배치될 때 — 꺼진 칩·✕ 테두리를 border-muted-foreground/35 로 적용한다(border 토큰은 card 위에서 거의 식별되지 않는다).
 */
import type { HTMLAttributes, MouseEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { UiIcon } from './Icon'
import { useModel } from './internal'

export interface UiChipProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'onClick'> {
  /** 켜짐(토글형) */
  modelValue?: boolean
  /** 켜짐 상태 변경 시 호출 */
  onUpdateModelValue?: (v: boolean) => void
  /** 칩 글자(필수) */
  label: string
  /** 오른쪽 mono 카운트 */
  count?: number | string
  /** 앞 아이콘(꺼짐일 때 muted, success 톤 켜짐에서는 success 색) */
  icon?: string
  /** sm 28 · md 32(기본) · lg 36(모바일) */
  size?: 'md' | 'lg' | 'sm'
  /** toggle(기본) · add = 점선 "+ 필터" 버튼(토글 아님) · static(토글 미수행) */
  variant?: 'toggle' | 'add' | 'static'
  /** 선택 색 톤(관리 사용자 "승인 대기" 는 warning, 열림·연결 같은 켜짐 상태는 success). 기본 primary */
  tone?: 'primary' | 'warning' | 'success'
  disabled?: boolean
  /** 제거 가능한 칩(받는이 등) — ✕ 아이콘 버튼, onRemove */
  removable?: boolean
  /** 칩 클릭(토글 이후 호출됨) */
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void
  /** ✕ 클릭 */
  onRemove?: () => void
  /** 배치 면 — page(기본, 본문) · raised(팝오버·시트·모달 위: 꺼진 칩·✕ 테두리 muted-foreground/35) */
  surface?: 'page' | 'raised'
}

const H = { sm: 'h-7 px-2.5 text-xs', md: 'h-8 px-2.5 text-xs', lg: 'h-9 px-3 text-[13px]' } as const
const TONE_ON = {
  warning: 'border-warning/50 bg-warning/[0.12] font-semibold text-foreground',
  success: 'border-success/45 bg-success/10 font-semibold text-foreground',
  primary: 'border-primary/50 bg-primary/[0.13] font-semibold text-foreground',
} as const
const TONE_ICON = { warning: 'text-warning', success: 'text-success', primary: 'text-primary' } as const

/**
 * 필터·토글 칩.
 * @example <UiChip label="안 읽음" count={12} modelValue={unread} onUpdateModelValue={setUnread} />
 * @example 팝오버·모달 위 제거 칩: <UiChip variant="static" removable surface="raised" label="긴급" onRemove={…} />
 */
export function UiChip({
  modelValue, onUpdateModelValue, label, count, icon, size = 'md', variant = 'toggle', tone = 'primary',
  disabled = false, removable = false, onClick, onRemove, surface = 'page', className, ...rest
}: UiChipProps) {
  const { t } = useI18n()
  const [model, setModel] = useModel(modelValue, false, onUpdateModelValue)
  const h = H[size]
  const offBorder = surface === 'raised' ? 'border-muted-foreground/35' : 'border-border'
  const on = variant === 'toggle' && model
  // success 톤은 켜짐 상태를 아이콘으로 표현한다(✓ 대신 아이콘을 success 색으로 표시)
  const onIcon = tone === 'success' && icon ? icon : 'check'

  function handleClick(e: MouseEvent<HTMLButtonElement>) {
    if (disabled) return
    if (variant === 'toggle') setModel(!model)
    onClick?.(e)
  }

  return (
    <span {...rest} className={cn('inline-flex items-center', className)}>
      <button
        type="button"
        aria-pressed={variant === 'toggle' ? model : undefined}
        disabled={disabled}
        className={cn(
          'inline-flex items-center gap-1 whitespace-nowrap rounded-full border transition-colors ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50',
          h,
          removable ? 'rounded-r-none border-r-0 pr-1.5' : '',
          on ? TONE_ON[tone] : cn(offBorder, 'text-foreground hover:bg-accent/40'),
          variant === 'add' ? 'border-dashed text-muted-foreground hover:text-foreground' : '',
        )}
        onClick={handleClick}
      >
        {on
          ? <UiIcon name={onIcon} className={cn(onIcon === 'check' ? 'h-3 w-3' : 'h-3.5 w-3.5', TONE_ICON[tone])} strokeWidth={onIcon === 'check' ? 3 : 2} />
          : variant === 'add'
            ? <UiIcon name="plus" className="h-3 w-3" strokeWidth={2.4} />
            : icon
              ? <UiIcon name={icon} className="h-3.5 w-3.5 text-muted-foreground" />
              : null}
        <span>{label}</span>
        {count !== undefined && <span className="font-mono font-medium text-muted-foreground">{count}</span>}
      </button>
      {/* 제거 버튼은 별도 버튼(히트 영역 분리). ✕ 28 → 히트 40 확장은 before 로 처리 */}
      {removable && (
        <button
          type="button"
          aria-label={t('ui.chip.remove', { label })}
          className={cn('relative inline-flex items-center justify-center rounded-r-full border border-l-0 text-muted-foreground hover:text-foreground before:absolute before:-inset-y-2 before:-right-2 before:left-0 before:content-[\'\']', offBorder, h, 'px-1.5')}
          onClick={() => onRemove?.()}
        >
          <UiIcon name="close" className="h-3 w-3" strokeWidth={2.4} />
        </button>
      )}
    </span>
  )
}

export default UiChip
