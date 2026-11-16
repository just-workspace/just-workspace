/**
 * 라디오: 18 원, 선택 = inset ring 1.5 primary + 안쪽 9px 점. 네이티브 input 유지(그룹은 동일 name).
 * 그룹의 각 라디오에 동일한 modelValue/onUpdateModelValue 와 개별 value 를 전달한다.
 * className 은 외부 <label> 에, 나머지 속성은 내부 <input> 에 적용된다. ref 는 내부 <input>.
 */
import type { ChangeEvent, InputHTMLAttributes, ReactNode, Ref } from 'react'
import { cn } from '~/lib/utils'
import { useModel, useUid } from './internal'

type RadioValue = string | number | boolean

export interface UiRadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'checked' | 'defaultChecked' | 'name' | 'disabled'> {
  /** 그룹에서 선택된 값 */
  modelValue?: RadioValue | null
  /** 본 라디오 선택 시 — 본 라디오의 value 로 호출 */
  onUpdateModelValue?: (v: RadioValue | null) => void
  /** 이 라디오의 값(필수) */
  value: RadioValue
  /** 그룹 이름(같은 name) */
  name?: string
  /** input id. 미지정 시 자동 생성 */
  id?: string
  /** 인접 라벨 글자(children 이 있으면 children 우선) */
  label?: string
  /** 하단 보조 글 */
  description?: string
  disabled?: boolean
  /** 라벨 영역 내용(label 대체) */
  children?: ReactNode
  /** 안쪽 <input> */
  ref?: Ref<HTMLInputElement>
}

/**
 * 라디오 하나.
 * @example <UiRadio name="vis" value="public" label="공개" modelValue={vis} onUpdateModelValue={setVis} />
 */
export function UiRadio({ modelValue, onUpdateModelValue, value, name, id, label, description, disabled = false, children, className, onChange, ...rest }: UiRadioProps) {
  const [model, setModel] = useModel<RadioValue | null>(modelValue, null, onUpdateModelValue)
  const uid = useUid('ui-radio')
  const inputId = id ?? uid
  const checked = model === value
  return (
    <label
      htmlFor={inputId}
      className={cn('inline-flex min-h-10 cursor-pointer items-center gap-2 text-[13px] text-foreground', disabled ? 'cursor-not-allowed opacity-60' : '', className ?? '')}
    >
      <span className="relative inline-grid place-items-center">
        <input
          {...rest}
          id={inputId}
          checked={checked}
          onChange={(e: ChangeEvent<HTMLInputElement>) => { if (e.target.checked) setModel(value); onChange?.(e) }}
          type="radio"
          name={name}
          value={String(value)}
          disabled={disabled}
          className="peer absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
        />
        <span
          aria-hidden="true"
          className={cn(
            'grid h-[18px] w-[18px] place-items-center rounded-full ring-offset-background transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2',
            checked ? 'shadow-[inset_0_0_0_1.5px_hsl(var(--primary))]' : 'shadow-[inset_0_0_0_1.5px_hsl(var(--muted-foreground))]',
          )}
        >
          {checked && <span className="h-[9px] w-[9px] rounded-full bg-primary" />}
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

export default UiRadio
