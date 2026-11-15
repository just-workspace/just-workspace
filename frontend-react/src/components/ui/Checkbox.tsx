/**
 * 체크박스(시안 F): 18 rounded-5, 해제 = inset ring 1.5 muted-foreground, 체크 = primary 채움 + ✓.
 * 실제 <input type=checkbox> 를 시각적으로 숨기고 라벨로 감싼다(시맨틱·키보드·폼 제출 유지). 히트 영역 40.
 * className 은 바깥 <label> 에, 나머지 속성(name·onChange 등)은 안쪽 <input> 에. ref 는 안쪽 <input>.
 */
import { useEffect, useRef, type ChangeEvent, type InputHTMLAttributes, type ReactNode, type Ref } from 'react'
import { cn } from '~/lib/utils'
import { UiIcon } from './Icon'
import { mergeRefs, useModel, useUid } from './internal'

export interface UiCheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type' | 'checked' | 'defaultChecked' | 'disabled' | 'aria-label'> {
  /** 체크 여부(Vue v-model) */
  modelValue?: boolean
  /** 체크 바뀜 */
  onUpdateModelValue?: (v: boolean) => void
  /** input id. 없으면 자동 */
  id?: string
  /** 옆 글자(children 이 있으면 그쪽) */
  label?: string
  /** 아래 보조 글(12 muted) */
  description?: string
  disabled?: boolean
  /** 18(기본) · 16(표 안 등 좁은 곳) · 20 */
  size?: 18 | 16 | 20
  /** 접근성 라벨(라벨 글자 없이 쓸 때) */
  ariaLabel?: string
  /** 일부 선택(− 표시) */
  indeterminate?: boolean
  /** 라벨 자리 내용(label 대신) */
  children?: ReactNode
  /** 안쪽 <input> */
  ref?: Ref<HTMLInputElement>
}

/**
 * 체크박스.
 * @example <UiCheckbox label="기억하기" modelValue={remember} onUpdateModelValue={setRemember} />
 */
export function UiCheckbox({
  modelValue, onUpdateModelValue, id, label, description, disabled = false, size = 18, ariaLabel, indeterminate = false,
  children, ref, className, onChange, ...rest
}: UiCheckboxProps) {
  const [model, setModel] = useModel(modelValue, false, onUpdateModelValue)
  const uid = useUid('ui-check')
  const inputId = id ?? uid
  const box = size === 16 ? 'h-4 w-4 rounded-[4px]' : size === 20 ? 'h-5 w-5 rounded-[5px]' : 'h-[18px] w-[18px] rounded-[5px]'
  const inner = useRef<HTMLInputElement | null>(null)
  // React 는 indeterminate 속성을 모른다 — DOM 속성으로 직접
  useEffect(() => { if (inner.current) inner.current.indeterminate = indeterminate }, [indeterminate])

  return (
    <label
      htmlFor={inputId}
      className={cn('group inline-flex min-h-10 cursor-pointer items-center gap-2 text-[13px] text-foreground', disabled ? 'cursor-not-allowed opacity-60' : '', className ?? '')}
    >
      <span className="relative inline-grid place-items-center">
        <input
          {...rest}
          ref={mergeRefs(inner, ref)}
          id={inputId}
          checked={!!model}
          onChange={(e: ChangeEvent<HTMLInputElement>) => { setModel(e.target.checked); onChange?.(e) }}
          type="checkbox"
          disabled={disabled}
          aria-label={ariaLabel}
          className="peer absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
        />
        <span
          aria-hidden="true"
          className={cn(
            'grid place-items-center transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 ring-offset-background',
            box,
            model || indeterminate ? 'bg-primary text-primary-foreground' : 'shadow-[inset_0_0_0_1.5px_hsl(var(--muted-foreground))]',
          )}
        >
          {indeterminate && !model
            ? <UiIcon name="minus" className="h-3 w-3" strokeWidth={3.5} />
            : model ? <UiIcon name="check" className="h-3 w-3" strokeWidth={3.5} /> : null}
        </span>
      </span>
      {(label || description || children != null) && (
        <span className="flex flex-col">
          {children ?? <span>{label}</span>}
          {description && <span className="text-xs text-muted-foreground">{description}</span>}
        </span>
      )}
    </label>
  )
}

export default UiCheckbox
