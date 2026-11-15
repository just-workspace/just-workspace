/**
 * 3단 토글(handover-22 "3단 토글" · 시안 Settings22 채널 덮어쓰기): 거부 / 상속 / 허용 중 하나.
 * 모양: 1px border · rounded-md 묶음 안 3칸, 칸 32(h-8) · 아이콘 14 + 글자 12, 간격 4, 좌우 10.
 *   선택 바탕 — 거부 ✕ danger/15(글자 danger) · 상속 ／ foreground/20(글자 foreground) · 허용 ✓ success/15(글자 success).
 *   안 고른 칸은 muted-foreground, 호버 bg-overlay-hover.
 * size="touch"(모바일): 칸 44 정사각, 아이콘만(16) — 글자는 aria-label 로만.
 * 접근성: role=radiogroup(ariaLabel = 권한 이름) · 칸 role=radio aria-checked. 고른 칸만 Tab 으로 들어온다(roving).
 *   ←↑ / →↓ = 이전/다음 칸으로 옮기며 고른다(끝에서 돈다) · Home/End = 처음/끝.
 *
 * @example
 * <UiTriToggle ariaLabel="메시지 보내기" modelValue={ov.send} onUpdateModelValue={v => setOv('send', v)} />
 * <UiTriToggle size="touch" ariaLabel="메시지 보내기" modelValue="inherit" />
 */
import type { HTMLAttributes, KeyboardEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { UiIcon } from './Icon'
import { useModel } from './internal'

export type UiTriValue = 'deny' | 'inherit' | 'allow'

export const UI_TRI_VALUES: readonly UiTriValue[] = ['deny', 'inherit', 'allow'] as const

export interface UiTriToggleProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role'> {
  /** 고른 값(Vue v-model). 안 주면 부품이 가진다(처음 = inherit) */
  modelValue?: UiTriValue
  /** 값 바뀜 */
  onUpdateModelValue?: (v: UiTriValue) => void
  /** md 32(기본, 아이콘+글자) · touch 44 정사각(아이콘만) */
  size?: 'md' | 'touch'
  /** 묶음 접근성 이름(권한 이름) */
  ariaLabel?: string
  /** 칸 글자 바꾸기(기본 거부·상속·허용 — i18n ui.kit22) */
  labels?: Partial<Record<UiTriValue, string>>
  disabled?: boolean
}

const ICON: Record<UiTriValue, string> = { deny: 'close', inherit: 'slash', allow: 'check' }
const ON: Record<UiTriValue, string> = {
  deny: 'bg-danger/15 text-danger',
  inherit: 'bg-foreground/20 text-foreground',
  allow: 'bg-success/15 text-success',
}

/**
 * 거부 / 상속 / 허용 3단 토글.
 */
export function UiTriToggle({ modelValue, onUpdateModelValue, size = 'md', ariaLabel, labels, disabled = false, className, ...rest }: UiTriToggleProps) {
  const { t } = useI18n()
  const [model, setModel] = useModel<UiTriValue>(modelValue, 'inherit', onUpdateModelValue)
  const touch = size === 'touch'
  const label = (v: UiTriValue) => labels?.[v] ?? t(`ui.kit22.${v}`)

  function onKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const n = UI_TRI_VALUES.length
    let j: number
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % n
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + n) % n
    else if (e.key === 'Home') j = 0
    else if (e.key === 'End') j = n - 1
    else return
    e.preventDefault()
    if (disabled) return
    setModel(UI_TRI_VALUES[j])
    ;(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role=radio]')[j])?.focus()
  }

  return (
    <div
      {...rest}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={cn('inline-flex shrink-0 overflow-hidden rounded-md border border-border', disabled ? 'opacity-50' : '', className)}
    >
      {UI_TRI_VALUES.map((v, i) => {
        const on = model === v
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={touch ? label(v) : undefined}
            title={touch ? label(v) : undefined}
            data-value={v}
            disabled={disabled}
            tabIndex={on ? 0 : -1}
            className={cn(
              'inline-flex items-center justify-center transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed',
              touch ? 'h-11 w-11' : 'h-8 gap-1 px-2.5 text-[12px] font-medium',
              on ? ON[v] : 'text-muted-foreground hover:bg-overlay-hover hover:text-foreground',
            )}
            onClick={() => { if (!disabled) setModel(v) }}
            onKeyDown={e => onKey(e, i)}
          >
            <UiIcon name={ICON[v]} strokeWidth={touch ? 2.4 : 2.6} className={touch ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
            {!touch && <span>{label(v)}</span>}
          </button>
        )
      })}
    </div>
  )
}

export default UiTriToggle
