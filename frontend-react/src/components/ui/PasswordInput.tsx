/**
 * 비밀번호 입력 + 표시/숨김 토글.
 *
 * NIST SP 800-63B-4 는 검증자가 입력한 비밀 문자열을 일시적으로 볼 수 있는
 * 수단을 제공해야 한다(SHOULD)고 명시한다. 모바일에서 오타로 인한 재설정
 * 요청 감소에 효과적이다.
 *
 * 입력 규격(UiInput 과 동일한 테두리·포커스·오류)을 기본으로 사용하며, 기존 호출처가 전달하는 inputClass 는
 * 그대로 추가하여 호환을 유지한다(미지정 시 기본 규격). 표시 토글은 32px 아이콘 버튼 — 히트 영역은 세로 전체 높이.
 *
 * 키 이벤트: onKeyDown·onKeyUp·onBlur 는 내부 <input> 의 이벤트를 그대로 전달한다.
 * Caps Lock: 입력 중 Caps Lock 상태를 capsLock/onUpdateCapsLock으로 전달하고,
 * capsLockHint 지정 시 입력 하단에 ↑ 경고(warning 12/500, role=status)를 직접 렌더링한다. 포커스 이탈 시 제거한다.
 *
 * className·나머지 속성은 외부 래퍼(div)에 적용된다(내부 <input> 아님). ref 는 내부 <input>.
 */
import { useEffect, useRef, useState, type FocusEvent, type HTMLAttributes, type KeyboardEvent, type Ref } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useCapsLock } from '~/composables/useCapsLock'
import { UiIcon } from './Icon'
import { useModel, useUid } from './internal'

export interface UiPasswordInputProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onKeyDown' | 'onKeyUp' | 'onBlur' | 'id'> {
  /** 값 */
  modelValue?: string
  /** 값 변경 */
  onUpdateModelValue?: (v: string) => void
  /** Caps Lock 활성 여부(입력 중에만 판정) */
  capsLock?: boolean
  /** Caps Lock 상태 변경 */
  onUpdateCapsLock?: (v: boolean) => void
  /** input id(라벨 for). 미지정 시 자동 생성 */
  id?: string
  /** 상단 라벨 */
  label?: string
  /** 오류 문구 */
  error?: string
  /** 하단 도움말(오류가 없을 때) */
  hint?: string
  /** autocomplete(기본 'current-password', 새 비밀번호는 'new-password') */
  autocomplete?: string
  placeholder?: string
  /** 내부 <input> 에 추가할 클래스(기존 호출처 호환) */
  inputClass?: string
  /** 초기 포커스 부여 */
  autofocus?: boolean
  /** md 40(기본) · lg 44(인증·모바일) */
  size?: 'md' | 'lg'
  /** Caps Lock 활성 시 입력 하단에 표시할 문구 */
  capsLockHint?: string
  /** 안쪽 <input> keydown */
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void
  /** 안쪽 <input> keyup */
  onKeyUp?: (e: KeyboardEvent<HTMLInputElement>) => void
  /** 안쪽 <input> blur */
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void
  /** 안쪽 <input> */
  ref?: Ref<HTMLInputElement>
}

/**
 * 비밀번호 입력(보기 토글·Caps Lock 경고).
 * @example <UiPasswordInput label="비밀번호" size="lg" modelValue={pw} onUpdateModelValue={setPw} capsLockHint={t('auth.capsLockOn')} />
 */
export function UiPasswordInput({
  modelValue, onUpdateModelValue, capsLock: capsLockProp, onUpdateCapsLock, id, label, error, hint,
  autocomplete = 'current-password', placeholder, inputClass = '', autofocus = false, size = 'md', capsLockHint,
  onKeyDown, onKeyUp, onBlur, ref, className, ...rest
}: UiPasswordInputProps) {
  const { t } = useI18n()
  const [model, setModel] = useModel(modelValue, '', onUpdateModelValue)
  const [capsLock, setCapsLockModel] = useModel(capsLockProp, false, onUpdateCapsLock)

  const caps = useCapsLock()
  // Caps Lock 상태를 모델에 반영(변경 시에만)
  const first = useRef(true)
  const setCapsRef = useRef(setCapsLockModel)
  setCapsRef.current = setCapsLockModel
  useEffect(() => {
    if (first.current) { first.current = false; return }
    setCapsRef.current(caps.capsLock)
  }, [caps.capsLock])

  const [revealed, setRevealed] = useState(false)
  const uid = useUid('ui-pw')

  return (
    <div {...rest} className={cn('flex flex-col gap-1.5', className)}>
      {label && <label htmlFor={id ?? uid} className={cn('text-xs font-semibold', error ? 'text-danger' : 'text-muted-foreground')}>{label}</label>}
      <div className="relative">
        <input
          ref={ref}
          id={id ?? uid}
          value={model}
          onChange={e => setModel(e.target.value)}
          type={revealed ? 'text' : 'password'}
          autoComplete={autocomplete}
          placeholder={placeholder}
          autoFocus={autofocus}
          aria-invalid={error ? 'true' : undefined}
          onKeyDown={(e) => { caps.onKey(e); onKeyDown?.(e) }}
          onKeyUp={(e) => { caps.onKey(e); onKeyUp?.(e) }}
          onBlur={(e) => { caps.reset(); onBlur?.(e) }}
          className={cn(
            'w-full min-w-0 rounded-md border bg-background px-3 text-sm text-foreground outline-hidden transition-[box-shadow,border-color] placeholder:text-muted-foreground',
            size === 'lg' ? 'h-11' : 'h-10',
            error ? 'border-danger focus:ring-2 focus:ring-danger/35' : 'border-input focus:border-ring focus:ring-2 focus:ring-ring/35',
            inputClass,
            'pr-10',
          )}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={revealed ? t('auth.hidePassword') : t('auth.showPassword')}
          aria-pressed={revealed}
          className="absolute right-0 top-0 flex h-full w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setRevealed(v => !v)}
        >
          <UiIcon name={revealed ? 'eye-off' : 'eye'} className="h-4 w-4" />
        </button>
      </div>
      {capsLockHint && capsLock && (
        <span role="status" className="flex items-center gap-1.5 text-xs font-medium text-warning">
          <UiIcon name="arrow-up" className="h-[13px] w-[13px]" strokeWidth={2.2} />{capsLockHint}
        </span>
      )}
      {error
        ? (
          <p className="flex items-center gap-1.5 text-xs font-medium text-danger">
            <UiIcon name="alert-circle" className="h-[13px] w-[13px]" strokeWidth={2.2} />{error}
          </p>
        )
        : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export default UiPasswordInput
