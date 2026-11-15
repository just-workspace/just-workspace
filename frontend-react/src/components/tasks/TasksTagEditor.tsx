/**
 * 작업 태그 줄(Vue components/tasks/TasksTagEditor.vue · 시안 TK1 패널 "태그": 칩 22 = 테두리 + primary 점 7 + 글자 12 · 점선 "+" 칩).
 *  "+" → 같은 높이 입력(자동완성 = GET /api/tasks/facets 의 tags, 네이티브 datalist). Enter/쉼표 = 추가, Esc = 닫기.
 *  칩의 ✕ = 빼기(누를 수 있는 영역 40). 바꿀 때마다 태그 목록 전체를 onCommit 한다.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { normalizeTag } from '~/utils/taskQuick'
import { UiIcon } from '~/components/ui/Icon'

export interface TasksTagEditorProps {
  tags: readonly string[]
  /** 자동완성 후보 */
  suggestions: readonly string[]
  /** 모바일 속성 카드 안(글자 13) */
  size?: 'md' | 'lg'
  className?: string
  /** 바뀐 태그 목록 전체 */
  onCommit?: (tags: string[]) => void
}

/** 작업 태그 칩 줄 + 추가 입력 */
export function TasksTagEditor({ tags, suggestions, size = 'md', className, onCommit }: TasksTagEditorProps) {
  const { t } = useI18n()

  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const draftRef = useRef('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listId = `task-tags-${useId().replace(/:/g, '')}`
  const options = suggestions.filter(s => !tags.includes(s))

  function setDraftV(v: string) { draftRef.current = v; setDraft(v) }

  function open() {
    setAdding(true)
    setDraftV('')
  }
  useEffect(() => { if (adding) inputRef.current?.focus() }, [adding])

  function add() {
    const v = normalizeTag(draftRef.current.replace(/,+$/, ''))
    setDraftV('')
    if (!v || tags.includes(v)) return
    onCommit?.([...tags, v])
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    // 한글 조합 중 Enter 는 글자 확정이다(macOS 는 조합 중에도 key='Enter') — 넘기면 마지막 글자가 남거나 두 번 들어간다
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() }
    else if (e.key === 'Escape') { e.preventDefault(); setDraftV(''); setAdding(false) }
    else if (e.key === 'Backspace' && !draftRef.current && tags.length) onCommit?.(tags.slice(0, -1))
  }
  function onBlur() {
    if (draftRef.current.trim()) add()
    setAdding(false)
  }
  function remove(tag: string) { onCommit?.(tags.filter(x => x !== tag)) }

  return (
    <span className={cn('flex min-w-0 flex-wrap items-center gap-1.5', size === 'lg' ? 'text-[13px]' : 'text-xs', className)}>
      {tags.map(tag => (
        <span
          key={tag}
          className="group/tag inline-flex h-[22px] items-center gap-[5px] rounded-[6px] border border-border pl-2 pr-0.5"
        >
          <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-primary" aria-hidden="true" />
          <span className="max-w-[140px] truncate">{tag}</span>
          <button
            type="button"
            className="relative grid h-4 w-4 place-items-center rounded-sm text-muted-foreground before:absolute before:-inset-3 before:content-[''] hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('tasks.detail.removeTag', { tag })}
            onClick={() => remove(tag)}
          ><UiIcon name="close" className="h-2.5 w-2.5" strokeWidth={2.6} /></button>
        </span>
      ))}
      {adding
        ? (
          <>
            <input
              ref={inputRef}
              value={draft}
              onChange={e => setDraftV(e.target.value)}
              list={listId}
              autoComplete="off"
              maxLength={40}
              aria-label={t('tasks.detail.newTag')}
              placeholder={t('tasks.detail.newTagPlaceholder')}
              className="h-[22px] w-28 rounded-[6px] border border-ring bg-background px-2 outline-hidden ring-2 ring-ring/35"
              onKeyDown={onKey}
              onBlur={onBlur}
            />
            <datalist id={listId}>
              {options.map(o => <option key={o} value={o} />)}
            </datalist>
          </>
        )
        : (
          <button
            type="button"
            className="relative inline-flex h-[22px] items-center rounded-[6px] border border-dashed border-border px-2 text-muted-foreground before:absolute before:-inset-y-[9px] before:inset-x-0 before:content-[''] hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('tasks.detail.addTag')}
            onClick={open}
          >+</button>
        )}
    </span>
  )
}

export default TasksTagEditor
