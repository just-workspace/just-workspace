/**
 * 빠른 입력 한 줄: 44, rounded-10, bg-card, 포커스 ring + ring/30 2px.
 * 입력 중 날짜(primary)·!우선순위(색)·@담당(muted) 토큰을 글자 위에 바로 칠한다 — 투명 글자 입력 + 같은 자리 거울 레이어.
 * Enter = 추가. 자세한 건 상세 패널에서.
 * @담당은 페이지가 사용자로 찾아 담당자로 저장한다(못 찾으면 제목에 남김). @ 가 없으면 나에게 배정.
 * ref → { clear, focus }.
 */
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { parseQuickTask, type QuickParse } from '~/utils/taskQuick'
import { UiIcon } from '~/components/ui/Icon'

export interface TasksQuickInputHandle {
  clear: () => void
  focus: () => void
}

export interface TasksQuickInputProps {
  /** 추가 중(입력 잠금) */
  busy?: boolean
  /** 모바일 시트 안(44 · 15px) */
  size?: 'md' | 'lg'
  autofocus?: boolean
  className?: string
  /** Enter — 풀어 낸 결과(제목·마감·우선순위·@담당) */
  onSubmit?: (parsed: QuickParse) => void
  ref?: Ref<TasksQuickInputHandle | null>
}

/** 작업 빠른 입력 한 줄(토큰 색칠) */
export function TasksQuickInput({ busy = false, size = 'md', autofocus = false, className, onSubmit, ref }: TasksQuickInputProps) {
  const { t } = useI18n()

  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const mirrorRef = useRef<HTMLDivElement | null>(null)

  const parsed = parseQuickTask(text)

  function tokenClass(kind: string) {
    if (kind === 'date') return 'font-semibold text-primary'
    if (kind === 'assignee') return 'font-semibold text-muted-foreground'
    const p = parsed.priority
    return p === 'urgent' ? 'font-semibold text-danger' : p === 'high' ? 'font-semibold text-warning' : 'font-semibold text-muted-foreground'
  }

  // 거울 레이어 조각: 일반 글자 / 토큰(색)
  const segments: Array<{ t: string; cls: string }> = []
  let cur = 0
  for (const tk of parsed.tokens) {
    if (tk.start > cur) segments.push({ t: text.slice(cur, tk.start), cls: '' })
    segments.push({ t: text.slice(tk.start, tk.end), cls: tokenClass(tk.kind) })
    cur = tk.end
  }
  if (cur < text.length) segments.push({ t: text.slice(cur), cls: '' })

  // 긴 입력에서 가로 스크롤을 거울에 맞춘다
  function syncScroll() {
    if (mirrorRef.current && inputRef.current) mirrorRef.current.scrollLeft = inputRef.current.scrollLeft
  }

  function submit() {
    if (busy) return
    if (!parsed.title) return
    onSubmit?.(parsed)
  }

  function clear() { setText('') }
  function focus() { inputRef.current?.focus() }
  useImperativeHandle(ref, () => ({ clear, focus }))

  // 마운트 뒤 포커스. 시트(UiModal) 안에서는 모달이 뒤이어 첫 포커스 요소(닫기)로 옮긴다
  useEffect(() => { if (autofocus) focus() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-md border border-input bg-card px-3 transition-[box-shadow,border-color] focus-within:border-ring focus-within:shadow-[0_0_0_2px_hsl(var(--ring)/0.3)]',
        size === 'lg' ? 'h-11 text-[15px]' : 'h-11 text-sm',
        className,
      )}
    >
      <UiIcon name="plus" className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={2.4} />
      <div className="relative min-w-0 flex-1">
        {/* 거울: 입력과 같은 글꼴·패딩. 색만 입힌다 */}
        <div
          ref={mirrorRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre text-foreground"
        >{segments.map((s, i) => <span key={i} className={s.cls}>{s.t}</span>)}</div>
        <input
          ref={inputRef}
          value={text}
          type="text"
          autoComplete="off"
          enterKeyHint="done"
          aria-label={t('tasks.new.inputLabel')}
          placeholder={t('tasks.new.placeholder')}
          className="relative w-full bg-transparent text-transparent caret-foreground outline-hidden placeholder:text-muted-foreground selection:bg-primary/25 selection:text-transparent"
          disabled={busy}
          onChange={(e) => { setText(e.target.value); syncScroll() }}
          onScroll={syncScroll}
          onKeyUp={syncScroll}
          onKeyDown={(e) => {
            // 한글 조합 중 Enter 는 글자 확정이다(macOS 는 조합 중에도 key='Enter') — 넘기면 추가 뒤 마지막 글자가 입력칸에 남는다
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Enter') { e.preventDefault(); submit() }
            else if (e.key === 'Escape') clear()
          }}
        />
      </div>
      <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">{t('tasks.new.inlineHint')}</span>
    </div>
  )
}

export default TasksQuickInput
