/**
 * 스위치: 36×20, 손잡이 16. 켬 = primary 트랙 + primary-foreground 손잡이,
 * 끔 = muted 트랙 + inset 1px 테두리 + muted-foreground 손잡이(끔 상태도 손잡이 색으로 구분). role=switch aria-checked.
 * 히트 영역 40(min-h-10 라벨). 스위치만 있는 행은 즉시 저장 + "저장됨 ✓" 가 규칙(UiSettingsRow 담당).
 * className 은 외부 래퍼에, 나머지 속성은 스위치 <button> 에 적용된다. ref 는 <button>.
 */
import type { ButtonHTMLAttributes, MouseEvent, Ref } from 'react'
import { cn } from '~/lib/utils'
import { useModel, useUid } from './internal'

export interface UiSwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'role' | 'disabled' | 'aria-label'> {
  /** 켬 여부 */
  modelValue?: boolean
  /** 켬 상태 변경 */
  onUpdateModelValue?: (v: boolean) => void
  /** 스위치 id(라벨 for). 미지정 시 자동 생성 */
  id?: string
  /** 라벨(13/500) */
  label?: string
  /** 라벨 하단 보조 글(12 muted) */
  description?: string
  /** 라벨 글자 없이 사용할 때 필수(aria-label) */
  ariaLabel?: string
  disabled?: boolean
  /** 라벨을 스위치 앞(왼쪽)에 배치할지 여부. 기본 활성화 — 설정 행처럼 라벨 왼쪽·스위치 오른쪽 */
  labelFirst?: boolean
  /** 스위치 <button> */
  ref?: Ref<HTMLButtonElement>
}

/**
 * 켬/끔 스위치.
 * @example <UiSwitch label="알림 받기" description="새 메일이 오면 알림" modelValue={on} onUpdateModelValue={save} />
 */
export function UiSwitch({ modelValue, onUpdateModelValue, id, label, description, ariaLabel, disabled = false, labelFirst = true, className, onClick, ...rest }: UiSwitchProps) {
  const [model, setModel] = useModel(modelValue, false, onUpdateModelValue)
  const uid = useUid('ui-switch')
  const switchId = id ?? uid

  function toggle() { if (!disabled) setModel(!model) }

  return (
    <div className={cn('inline-flex min-h-10 items-center gap-3', labelFirst ? 'flex-row' : 'flex-row-reverse', className ?? '')}>
      {(label || description) && (
        <label htmlFor={switchId} className={cn('flex min-w-0 flex-1 cursor-pointer flex-col text-[13px]', disabled ? 'opacity-60' : '')}>
          <span className="font-medium text-foreground">{label}</span>
          {description && <span className="text-xs text-muted-foreground">{description}</span>}
        </label>
      )}
      <button
        {...rest}
        id={switchId}
        type="button"
        role="switch"
        aria-checked={!!model}
        aria-label={ariaLabel}
        disabled={disabled}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
          model ? 'bg-primary' : 'bg-muted shadow-[inset_0_0_0_1px_hsl(var(--muted-foreground)/0.5)]',
        )}
        onClick={(e: MouseEvent<HTMLButtonElement>) => { onClick?.(e); toggle() }}
      >
        <span
          aria-hidden="true"
          className={cn('block h-4 w-4 rounded-full transition-transform', model ? 'translate-x-4 bg-primary-foreground' : 'translate-x-0 bg-muted-foreground')}
        />
      </button>
    </div>
  )
}

export default UiSwitch
