/**
 * 비밀번호 입력 + 표시/숨김 토글.
 *
 * NIST SP 800-63B-4 는 검증자가 입력한 비밀 문자열을 일시적으로 볼 수 있는
 * 수단을 제공해야 한다(SHOULD)고 명시한다. 모바일에서 오타로 인한 재설정
 * 요청을 줄이는 효과가 크다.
 *
 * 시안 F 입력 규격(UiInput 과 같은 테두리·포커스·오류)을 기본으로 쓰고, 기존 호출처가 넘기는 inputClass 는
 * 그대로 덧붙여 호환한다(비우면 기본 규격). 보기 토글은 32px 아이콘 버튼 — 히트 영역은 세로로 전체 높이.
 *
 * 키 이벤트: onKeyDown·onKeyUp·onBlur 는 안쪽 <input> 에서 그대로 내보낸다(Vue 판 keydown·keyup·blur 이벤트).
 * Caps Lock(시안 A1 · AuthForm:18): 입력 중 Caps Lock 상태를 capsLock/onUpdateCapsLock(Vue v-model:caps-lock)으로 알려 주고,
 * capsLockHint 를 주면 입력 아래에 ↑ 경고(warning 12/500, role=status)를 직접 그린다. 포커스가 빠지면 내린다.
 *
 * Vue 판과 같이 className·나머지 속성은 바깥 묶음(div)에 붙는다(안쪽 <input> 아님). ref 는 안쪽 <input>.
 */
import { useEffect, useRef, useState, type FocusEvent, type HTMLAttributes, type KeyboardEvent, type Ref } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useCapsLock } from '~/composables/useCapsLock'
import { UiIcon } from './Icon'
import { useModel, useUid } from './internal'

export interface UiPasswordInputProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onKeyDown' | 'onKeyUp' | 'onBlur' | 'id'> {
  /** 값(Vue v-model) */
  modelValue?: string
  /** 값 바뀜 */
  onUpdateModelValue?: (v: string) => void
  /** Caps Lock 켜짐 여부(입력 중에만 판단, Vue v-model:caps-lock) */
  capsLock?: boolean
  /** Caps Lock 상태 바뀜 */
  onUpdateCapsLock?: (v: boolean) => void
  /** input id(라벨 for). 없으면 자동 */
  id?: string
  /** 위 라벨 */
  label?: string
  /** 오류 문구 */
  error?: string
  /** 아래 도움말(오류가 없을 때) */
  hint?: string
  /** autocomplete(기본 'current-password', 새 비밀번호는 'new-password') */
  autocomplete?: string
  placeholder?: string
  /** 안쪽 <input> 에 덧붙일 클래스(기존 호출처 호환) */
  inputClass?: string
  /** 처음에 포커스 */
  autofocus?: boolean
  /** md 40(기본) · lg 44(인증·모바일) */
  size?: 'md' | 'lg'
  /** Caps Lock 이 켜져 있을 때 입력 아래에 보일 문구 */
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
  // Vue watch(caps.capsLock) → 모델에 반영(바뀔 때만)
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
