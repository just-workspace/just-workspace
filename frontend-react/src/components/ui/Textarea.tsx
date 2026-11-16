/**
 * 여러 줄 입력: 패딩 10/12, 테두리·포커스·오류 규격은 UiInput 과 동일하다.
 * className 은 외부 래퍼에, 나머지 속성(name·maxLength·onKeyDown 등)은 내부 <textarea> 에 적용된다. ref 는 <textarea>.
 *
 * autoGrow(프롬프트 입력): 높이 = 내용 높이(1~maxRows줄, 기본 6), 포커스와 무관 — 포커스만으로는 확장되지 않는다.
 * 비어 있으면 1줄(높이 44), 줄이 늘면 maxRows 까지 확장되고 이를 초과하면 내부 스크롤. rows·resizable 은 사용하지 않는다.
 */
import { useLayoutEffect, useRef, type ChangeEvent, type Ref, type TextareaHTMLAttributes } from 'react'
import { cn } from '~/lib/utils'
import { UiIcon } from './Icon'
import { mergeRefs, useModel, useUid } from './internal'

/** 접힌 높이(1줄) */
const COLLAPSED_H = 44
/** 계산값을 읽을 수 없을 때(테스트 환경 등) 사용하는 기본값 — text-sm 줄 20 · 위아래 패딩 11 · 테두리 1 */
const num = (v: string, d: number) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d }

export interface UiTextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'defaultValue' | 'placeholder' | 'rows' | 'disabled' | 'readOnly' | 'required'> {
  /** 값. 미지정 시 내부에서 값을 보유 */
  modelValue?: string
  /** 값 변경 */
  onUpdateModelValue?: (v: string) => void
  /** textarea id(라벨 for). 미지정 시 자동 생성 */
  id?: string
  /** 상단 라벨 */
  label?: string
  /** 하단 도움말(오류가 없을 때) */
  hint?: string
  /** 오류 문구 */
  error?: string
  placeholder?: string
  /** 줄 수(기본 3) */
  rows?: number
  disabled?: boolean
  /** 읽기 전용 — 점선 테두리 */
  readonly?: boolean
  /** 필수 — 라벨 뒤 * */
  required?: boolean
  /** mono 글꼴 13px */
  mono?: boolean
  /** 세로 크기 조절 허용 */
  resizable?: boolean
  /** 높이 = 내용(1줄 44 ~ maxRows 줄, 프롬프트 입력). 포커스와 무관, 비어 있으면 1줄 */
  autoGrow?: boolean
  /** autoGrow 최대 줄 수(기본 6) — 초과 시 내부 스크롤 */
  maxRows?: number
  /** 안쪽 <textarea> */
  ref?: Ref<HTMLTextAreaElement>
}

/**
 * 여러 줄 입력.
 * @example <UiTextarea label="설명" rows={4} modelValue={desc} onUpdateModelValue={setDesc} />
 * @example 프롬프트: <UiTextarea autoGrow maxRows={6} placeholder="무엇을 도와드릴까요?" modelValue={prompt} onUpdateModelValue={setPrompt} />
 */
export function UiTextarea({
  modelValue, onUpdateModelValue, id, label, hint, error, placeholder, rows = 3, disabled = false, readonly = false,
  required = false, mono = false, resizable = false, autoGrow = false, maxRows = 6, className, onChange, ref, ...rest
}: UiTextareaProps) {
  const [model, setModel] = useModel(modelValue, '', onUpdateModelValue)
  const uid = useUid('ui-textarea')
  const inputId = id ?? uid
  const describedBy = (error || hint) ? `${inputId}-desc` : undefined

  const inner = useRef<HTMLTextAreaElement | null>(null)
  // autoGrow 높이 = 내용 높이(1~maxRows 줄) · 비어 있으면 1줄 · 포커스와 무관. 초과 시 내부 스크롤
  useLayoutEffect(() => {
    const el = inner.current
    if (!autoGrow || !el) return
    const cs = getComputedStyle(el)
    const line = num(cs.lineHeight, 20)
    const border = num(cs.borderTopWidth, 1) + num(cs.borderBottomWidth, 1)
    const pad = num(cs.paddingTop, 11) + num(cs.paddingBottom, 11)
    const maxH = Math.max(COLLAPSED_H, Math.round(line * Math.max(1, maxRows) + pad + border))
    el.style.height = 'auto'
    const contentH = el.scrollHeight + border
    const h = model ? Math.min(Math.max(COLLAPSED_H, contentH), maxH) : COLLAPSED_H
    el.style.height = `${h}px`
    el.style.overflowY = model && contentH > maxH ? 'auto' : 'hidden'
    // 1줄 초과 여부(스타일 훅용)
    el.dataset.expanded = h > COLLAPSED_H ? 'true' : 'false'
  }, [autoGrow, maxRows, model, mono])
  return (
    <div className={cn('flex flex-col gap-1.5', className ?? '')}>
      {label && (
        <label htmlFor={inputId} className={cn('text-xs font-semibold', error ? 'text-danger' : 'text-muted-foreground')}>
          {label}{required && <span aria-hidden="true" className="ml-0.5 text-danger">*</span>}
        </label>
      )}
      <textarea
        {...rest}
        id={inputId}
        value={model}
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) => { setModel(e.target.value); onChange?.(e) }}
        ref={mergeRefs(inner, ref)}
        rows={autoGrow ? 1 : rows}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readonly}
        required={required}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={describedBy}
        className={cn(
          'w-full min-w-0 rounded-md border bg-background px-3 text-sm text-foreground outline-hidden transition-[box-shadow,border-color] placeholder:text-muted-foreground',
          autoGrow ? 'min-h-11 resize-none py-[11px] leading-5' : cn('py-2.5', resizable ? 'resize-y' : 'resize-none'),
          mono ? 'font-mono text-[13px]' : '',
          error ? 'border-danger focus:ring-2 focus:ring-danger/35' : 'border-input focus:border-ring focus:ring-2 focus:ring-ring/35',
          readonly ? 'border-dashed' : '',
          disabled ? 'cursor-not-allowed bg-muted/50 text-muted-foreground opacity-70' : '',
        )}
      />
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

export default UiTextarea
