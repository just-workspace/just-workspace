/**
 * 입력: 라벨 위 12/600 muted, 높이 40(h-10) · 인증/모바일 44(h-11), border-input rounded-md bg-background,
 * 포커스 border-ring + ring-2 ring-ring/35, 오류 border-danger + 아이콘 문구, 비활성 bg-muted/50 opacity-70,
 * 읽기 전용 점선 + 복사 버튼. 도움말과 오류는 입력 아래 동일 위치에 표시한다.
 * variant="bare"(검색 줄 등): 테두리·배경 없음, 높이 44, 포커스 시 링·밑줄 없이 본 컴포넌트 외부 묶음(=줄)의 배경만 bg-accent
 * (:focus-within). 줄이 본 컴포넌트보다 크면(앞뒤에 다른 요소가 있으면) 해당 줄에 직접 focus-within:bg-accent 를 지정한다.
 *
 * className 은 외부 묶음(라벨+입력+도움말)에, 나머지 속성(name·maxLength·onKeyDown·onBlur 등)은 안쪽 <input> 에 전달된다.
 * ref 는 안쪽 <input>(focus()·select() 등).
 */
import type { ChangeEvent, InputHTMLAttributes, ReactNode, Ref } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { addToast } from '~/composables/useToast'
import { UiIcon } from './Icon'
import { useModel, useUid } from './internal'
import { writeClipboard } from '~/lib/clipboard'

export interface UiInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'value' | 'defaultValue' | 'type' | 'placeholder' | 'disabled' | 'readOnly' | 'required' | 'autoComplete'> {
  /** 값. 미지정 시 입력이 값을 자체 보유한다 */
  modelValue?: string | number | null
  /** 값 변경 시 호출(입력마다, 문자열) */
  onUpdateModelValue?: (v: string) => void
  /** input id(라벨 for). 미지정 시 자동 생성 */
  id?: string
  /** 위 라벨(12/600 muted, 오류면 danger) */
  label?: string
  /** 아래 도움말(오류가 없을 때) */
  hint?: string
  /** 오류 문구 — 테두리 danger + 아래 아이콘 문구, aria-invalid */
  error?: string
  /** md 40(기본) · lg 44(인증·모바일). variant="bare" 는 항상 44 */
  size?: 'md' | 'lg'
  /** default(테두리 상자) · bare(테두리·배경 없음, 높이 44, 포커스 시 바깥 줄 배경만 bg-accent — 검색 줄용) */
  variant?: 'default' | 'bare'
  /** input type(기본 'text') */
  type?: string
  placeholder?: string
  disabled?: boolean
  /** 읽기 전용 — 점선 테두리 + (copyable 이면) 복사 버튼 */
  readonly?: boolean
  /** 필수 — 라벨 뒤 빨간 * */
  required?: boolean
  /** autocomplete(기본 'off') */
  autocomplete?: string
  /** 숫자·코드·URL 등 mono 로 표기 */
  mono?: boolean
  /** 읽기 전용일 때 복사 버튼 표시(기본 활성화) */
  copyable?: boolean
  /** 왼쪽 아이콘(utils/icons 이름) */
  icon?: string
  /** 안쪽 <input> 에 추가할 클래스 */
  inputClass?: string
  /** 복사 버튼으로 복사 시 호출 */
  onCopied?: () => void
  /** 입력 칸 오른쪽 안에 겹쳐 배치할 내용 */
  trailing?: ReactNode
  /** 안쪽 <input> */
  ref?: Ref<HTMLInputElement>
}

/**
 * 한 줄 입력.
 * @example <UiInput label="이름" modelValue={name} onUpdateModelValue={setName} error={err} required />
 * @example 검색 줄: <UiInput variant="bare" icon="search" placeholder="검색" className="border-b border-border" />
 */
export function UiInput({
  modelValue, onUpdateModelValue, id, label, hint, error, size = 'md', variant = 'default', type = 'text', placeholder, disabled = false,
  readonly = false, required = false, autocomplete = 'off', mono = false, copyable = true, icon, inputClass = '',
  onCopied, trailing, className, onChange, ...rest
}: UiInputProps) {
  const { t } = useI18n()
  const [model, setModel] = useModel<string | number | null>(modelValue, '', onUpdateModelValue as ((v: string | number | null) => void) | undefined)
  const uid = useUid('ui-input')
  const inputId = id ?? uid
  const describedBy = (error || hint) ? `${inputId}-desc` : undefined
  const bare = variant === 'bare'

  async function copy() {
    try {
      await writeClipboard(String(model ?? ''))
      addToast('success', t('ui.input.copied'))
      onCopied?.()
    } catch { /* 클립보드 미지원 */ }
  }

  return (
    <div className={cn('flex flex-col gap-1.5', bare ? 'transition-colors focus-within:bg-accent' : '', className ?? '')}>
      {label && (
        <label htmlFor={inputId} className={cn('text-xs font-semibold', error ? 'text-danger' : 'text-muted-foreground')}>
          {label}{required && <span aria-hidden="true" className="ml-0.5 text-danger">*</span>}
        </label>
      )}

      <div className="relative flex items-center">
        {icon && <UiIcon name={icon} className="pointer-events-none absolute left-3 h-4 w-4 text-muted-foreground" />}
        <input
          {...rest}
          id={inputId}
          value={model ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => { setModel(e.target.value); onChange?.(e) }}
          type={type}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={readonly}
          required={required}
          autoComplete={autocomplete}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={describedBy}
          className={cn(
            'w-full min-w-0 px-3 text-sm text-foreground outline-hidden placeholder:text-muted-foreground',
            bare ? 'h-11 rounded-none border-0 bg-transparent shadow-none' : 'rounded-md border bg-background transition-[box-shadow,border-color]',
            !bare && (size === 'lg' ? 'h-11' : 'h-10'),
            icon ? 'pl-9' : '',
            readonly && copyable ? 'pr-20' : '',
            mono ? 'font-mono text-[13px]' : '',
            bare ? '' : error ? 'border-danger focus:border-danger focus:ring-2 focus:ring-danger/35' : 'border-input focus:border-ring focus:ring-2 focus:ring-ring/35',
            readonly && !bare ? 'border-dashed' : '',
            disabled ? cn('cursor-not-allowed text-muted-foreground opacity-70', bare ? '' : 'bg-muted/50') : '',
            inputClass,
          )}
        />
        {/* 읽기 전용 = 점선 + 복사 버튼. 좁은 폭(260~480)에서 "복사"가 두 줄로 줄바꿈되지 않도록 nowrap + 최소 56 */}
        {readonly && copyable && (
          <button
            type="button"
            className="absolute right-1.5 inline-flex h-7 min-w-14 shrink-0 items-center justify-center whitespace-nowrap rounded-sm border border-border px-2.5 text-xs text-foreground hover:bg-accent"
            onClick={copy}
          >{t('common.copy')}</button>
        )}
        {trailing}
      </div>

      {error
        ? (
          <p id={describedBy} className="flex items-center gap-1.5 text-xs font-medium text-danger">
            <UiIcon name="alert-circle" className="h-[13px] w-[13px]" strokeWidth={2.2} />{error}
          </p>
        )
        : hint ? <p id={describedBy} className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export default UiInput
