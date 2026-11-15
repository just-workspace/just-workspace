/**
 * 색 견본 고르기: 36 원 한 줄(간격 8).
 * 고른 것 = 흰(bg-background 색) 체크 + 2px ring(foreground, offset 2). 마지막 "색 없음" = 점선 원 + ban 아이콘.
 * 값 = 옵션 value 문자열 | null(색 없음).
 * 기본 옵션 ROLE_COLOR_OPTIONS = 백엔드 역할 색 키 8개(순서 고정, permissions.ROLE_COLOR_TOKENS) → 견본 bg-role-1…8.
 *   다른 쓰임(라벨·캘린더)은 options 로 {value, colorClass, label} 를 준다(colorClass 는 정적 Tailwind 클래스).
 * 역할 색 키 → 클래스 변환은 roleColorToken / ROLE_BG_CLASS / ROLE_TEXT_CLASS(옛 "cat-N" 키도 받는다).
 * 접근성: role=radiogroup · 원 role=radio(aria-label = 라벨, 기본 "색 N") · 고른 원만 Tab(roving) · ←→↑↓ Home End 로 옮기며 고른다.
 *
 * @example
 * <UiColorSwatches ariaLabel="역할 색" modelValue={role.color} onUpdateModelValue={c => patch({ color: c })} />
 * <span className={ROLE_TEXT_CLASS[roleColorToken(role.color) ?? 'role-1']}>최수아</span>
 */
import type { HTMLAttributes, KeyboardEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { UiIcon } from './Icon'
import { useModel } from './internal'

export interface UiColorSwatchOption {
  /** 저장 값(예: 'primary' · 'cat-3') */
  value: string
  /** 원 바탕 클래스(정적 문자열, 예: 'bg-role-1') */
  colorClass: string
  /** 접근성 이름·툴팁(없으면 "색 N") */
  label?: string
}

/** 역할 색 토큰(role-1…8) */
export type RoleColorToken = 'role-1' | 'role-2' | 'role-3' | 'role-4' | 'role-5' | 'role-6' | 'role-7' | 'role-8'

/** 백엔드 역할 색 키(순서 고정 — i 번째 → role-(i+1)) */
export const ROLE_COLOR_KEYS = ['primary', 'accent', 'success', 'warning', 'danger', 'destructive', 'muted-foreground', 'foreground'] as const

/** 역할 토큰 → 바탕 클래스(Tailwind 가 읽도록 정적 문자열) */
export const ROLE_BG_CLASS: Record<RoleColorToken, string> = {
  'role-1': 'bg-role-1', 'role-2': 'bg-role-2', 'role-3': 'bg-role-3', 'role-4': 'bg-role-4',
  'role-5': 'bg-role-5', 'role-6': 'bg-role-6', 'role-7': 'bg-role-7', 'role-8': 'bg-role-8',
}
/** 역할 토큰 → 글자 클래스 */
export const ROLE_TEXT_CLASS: Record<RoleColorToken, string> = {
  'role-1': 'text-role-1', 'role-2': 'text-role-2', 'role-3': 'text-role-3', 'role-4': 'text-role-4',
  'role-5': 'text-role-5', 'role-6': 'text-role-6', 'role-7': 'text-role-7', 'role-8': 'text-role-8',
}

/**
 * 역할 색 키 → role 토큰. 'primary'…'foreground'(백엔드 키) · 'cat-1'…'cat-8' · 'role-1'…'role-8' 를 받는다.
 * 모르는 값·null = null(색 없음).
 */
export function roleColorToken(key: string | null | undefined): RoleColorToken | null {
  if (!key) return null
  const i = (ROLE_COLOR_KEYS as readonly string[]).indexOf(key)
  if (i >= 0) return `role-${i + 1}` as RoleColorToken
  const m = /^(?:cat|role)-([1-8])$/.exec(key)
  return m ? (`role-${m[1]}` as RoleColorToken) : null
}

/** 기본 옵션: 백엔드 역할 색 키 8개 → bg-role-1…8 */
export const ROLE_COLOR_OPTIONS: UiColorSwatchOption[] = ROLE_COLOR_KEYS.map((value, i) => ({
  value,
  colorClass: ROLE_BG_CLASS[`role-${i + 1}` as RoleColorToken],
}))

export interface UiColorSwatchesProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role'> {
  /** 고른 값. null = 색 없음 */
  modelValue?: string | null
  /** 값 바뀜 */
  onUpdateModelValue?: (v: string | null) => void
  /** 견본(기본 ROLE_COLOR_OPTIONS) */
  options?: UiColorSwatchOption[]
  /** 마지막 "색 없음" 점선 원(기본 켬) */
  allowNone?: boolean
  /** "색 없음" 이름 */
  noneLabel?: string
  /** 묶음 접근성 이름 */
  ariaLabel?: string
  disabled?: boolean
}

const RING = 'ring-2 ring-foreground ring-offset-2 ring-offset-background'

/**
 * 36 원 색 견본 고르기.
 */
export function UiColorSwatches({
  modelValue, onUpdateModelValue, options = ROLE_COLOR_OPTIONS, allowNone = true, noneLabel, ariaLabel, disabled = false, className, ...rest
}: UiColorSwatchesProps) {
  const { t } = useI18n()
  const [model, setModel] = useModel<string | null>(modelValue, null, onUpdateModelValue)
  const items: Array<{ value: string | null; colorClass?: string; label: string }> = options.map((o, i) => ({
    value: o.value, colorClass: o.colorClass, label: o.label ?? t('ui.kit22.color', { n: i + 1 }),
  }))
  if (allowNone) items.push({ value: null, label: noneLabel ?? t('ui.kit22.noColor') })
  const cur = items.findIndex(it => it.value === model)
  const tabbable = cur >= 0 ? cur : 0

  function onKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const n = items.length
    let j: number
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % n
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + n) % n
    else if (e.key === 'Home') j = 0
    else if (e.key === 'End') j = n - 1
    else return
    e.preventDefault()
    if (disabled) return
    setModel(items[j].value)
    ;(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role=radio]')[j])?.focus()
  }

  return (
    <div {...rest} role="radiogroup" aria-label={ariaLabel} aria-disabled={disabled || undefined} className={cn('flex flex-wrap gap-2', className)}>
      {items.map((it, i) => {
        const on = i === cur
        const none = it.value === null
        return (
          <button
            key={it.value ?? '__none'}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={it.label}
            title={it.label}
            disabled={disabled}
            tabIndex={i === tabbable ? 0 : -1}
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-shadow focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
              none ? 'border-2 border-dashed border-border' : it.colorClass,
              on ? RING : '',
            )}
            onClick={() => { if (!disabled) setModel(it.value) }}
            onKeyDown={e => onKey(e, i)}
          >
            {on && !none && <UiIcon name="check" strokeWidth={3} className="h-4 w-4 text-background" />}
            {none && <UiIcon name="ban" className="h-4 w-4 text-muted-foreground" />}
          </button>
        )
      })}
    </div>
  )
}

export default UiColorSwatches
