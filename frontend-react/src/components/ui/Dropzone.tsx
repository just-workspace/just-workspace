/**
 * 파일 업로드 영역 — 끌어다 놓거나 버튼으로 선택한다. 내부에 실제 <input type="file"> 이 있으며, 버튼은 해당 input 을 연다
 * (키보드만으로도 선택 가능하다). 끌어다 놓는 동안 테두리·바탕이 변경된다.
 * - layout="area"(기본): 점선 큰 영역(아이콘 · 안내 · 버튼 · 보조 글).
 * - layout="row": 한 줄(아이콘 · 제목/보조 글 · 버튼) — 파일 칸 여러 개를 세로로 배치할 때. `filled` 면 실선 카드로 변경된다.
 * 선택한 파일은 onFiles 로만 전달한다(본 컴포넌트는 파일을 보유하지 않는다).
 */
import { useRef, useState, type DragEvent, type HTMLAttributes, type ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { UiButton } from './Button'
import { UiIcon } from './Icon'
import { useUid } from './internal'

export interface UiDropzoneProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'onDrop'> {
  /** 파일 선택 또는 드롭 시 호출 */
  onFiles: (files: File[]) => void
  /** 안내 글(area: 가운데 한 줄 · row: 제목, 필수) */
  title: ReactNode
  /** 보조 글(형식 안내·선택한 파일 이름 등) */
  description?: ReactNode
  /** 버튼 글자(필수) */
  buttonLabel: string
  /** input accept(예: '.pem,.crt') */
  accept?: string
  /** 여러 개 허용 */
  multiple?: boolean
  disabled?: boolean
  /** area(기본) · row */
  layout?: 'area' | 'row'
  /** row 전용 — 파일이 이미 지정된 칸(실선 카드 + 파일 아이콘) */
  filled?: boolean
  /** 아이콘 이름(기본: 빈 칸 upload · 찬 칸 file) */
  icon?: string
  /** 버튼 왼쪽 아이콘 */
  buttonIcon?: string
  /** 영역 아래에 추가할 내용(진행 막대 등) */
  children?: ReactNode
}

/**
 * 파일 올리기 영역.
 * @example <UiDropzone title="백업 파일을 여기에 끌어다 놓습니다" buttonLabel="파일 고르기" onFiles={fs => upload(fs[0])} />
 */
export function UiDropzone({ onFiles, title, description, buttonLabel, accept, multiple = false, disabled = false, layout = 'area', filled = false, icon, buttonIcon, className, children, ...rest }: UiDropzoneProps) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const id = useUid('ui-drop')

  function take(list: FileList | null | undefined) {
    if (disabled || !list || list.length === 0) return
    const files = Array.from(list)
    onFiles(multiple ? files : files.slice(0, 1))
  }
  const drag = {
    onDragOver: (e: DragEvent<HTMLDivElement>) => { if (disabled) return; e.preventDefault(); setOver(true) },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent<HTMLDivElement>) => { if (disabled) return; e.preventDefault(); setOver(false); take(e.dataTransfer?.files) },
  }
  const file = (
    <input
      ref={input}
      id={id}
      type="file"
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      accept={accept}
      multiple={multiple}
      disabled={disabled}
      onChange={e => { take(e.target.files); e.target.value = '' }}
    />
  )
  const glyph = icon ?? (filled ? 'file' : 'upload')
  const button = (size: 'sm' | 'default') => (
    <UiButton type="button" variant="outline" size={size} icon={buttonIcon} disabled={disabled} onClick={() => input.current?.click()}>{buttonLabel}</UiButton>
  )

  if (layout === 'row') {
    return (
      <div
        {...rest}
        {...drag}
        data-over={over || undefined}
        className={cn(
          'flex flex-col gap-3 rounded-xl px-4 py-3 transition-colors',
          filled ? 'border border-border bg-card' : 'border border-dashed border-muted-foreground/50',
          over && 'border-primary bg-primary/5',
          disabled && 'opacity-50',
          className ?? '',
        )}
      >
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex shrink-0 text-muted-foreground"><UiIcon name={glyph} aria-hidden="true" className="size-[18px]" /></span>
          <span className="flex min-w-0 flex-1 basis-40 flex-col">
            <span className="text-[13.5px] font-semibold leading-5">{title}</span>
            {description != null && <span className="break-all text-xs leading-4 text-muted-foreground">{description}</span>}
          </span>
          {button('sm')}
          {file}
        </div>
        {children}
      </div>
    )
  }
  return (
    <div
      {...rest}
      {...drag}
      data-over={over || undefined}
      className={cn(
        'flex flex-col items-center gap-3 rounded-xl border border-dashed border-muted-foreground/50 px-4 py-10 text-center transition-colors',
        over && 'border-primary bg-primary/5',
        disabled && 'opacity-50',
        className ?? '',
      )}
    >
      <span className="flex text-muted-foreground"><UiIcon name={glyph} aria-hidden="true" className="size-6" /></span>
      <span className="text-[13.5px]">{title}</span>
      {button('default')}
      {description != null && <span className="text-xs text-muted-foreground">{description}</span>}
      {file}
      {children}
    </div>
  )
}

export default UiDropzone
