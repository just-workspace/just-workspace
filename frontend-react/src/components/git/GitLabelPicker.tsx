// 라벨 선택 드롭다운 — 목록 필터 · 이슈 상세 · 새 이슈 모달 공용.
// 닫을 때 1회만 commit 한다(체크마다 요청하지 않는다).
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { useGit } from '~/composables/useGit'
import { labelDot } from '~/utils/labelColor'

export interface GitLabelPickerProps {
  /** 선택된 label id */
  modelValue: number[]
  /** 닫을 때 값이 변경된 경우 호출(commit 직전) */
  onUpdateModelValue?: (v: number[]) => void
  /** 닫을 때 값이 변경된 경우 1회 호출 */
  onCommit?: (v: number[]) => void
  /** filter 는 '만들기' 줄을 숨김 */
  mode?: 'assign' | 'filter'
  /** ghost 는 점선 '+ 편집' 칩 트리거 */
  variant?: 'default' | 'ghost'
}

/** 라벨 선택(드롭다운) */
export function GitLabelPicker({ modelValue, onUpdateModelValue, onCommit, mode = 'assign', variant = 'default' }: GitLabelPickerProps) {
  const { t } = useI18n()
  const { labels, labelCounts, createLabel } = useGit()

  const rootRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [draft, setDraft] = useState<number[]>([...modelValue])

  // 8개 초과 시에만 검색줄 표시
  const searchable = labels.length > 8
  const s = q.trim().toLowerCase()
  const filtered = s ? labels.filter(l => l.name.toLowerCase().includes(s)) : labels
  const canCreate = mode !== 'filter' && q.trim().length > 0 && filtered.length === 0

  const triggerText = variant === 'ghost'
    ? (modelValue.length ? t('git.labels.edit') : t('git.labels.add'))
    : t('git.labels.title')

  // 트리거를 열 때마다 현재 값으로 draft 를 동기화한다(외부에서 변경되었을 수 있음)
  function openPicker() {
    setDraft([...modelValue])
    setOpen(true)
  }

  function toggle(id: number) {
    setDraft(d => (d.includes(id) ? d.filter(x => x !== id) : [...d, id]))
  }

  // 닫을 때 1회만 커밋
  function close() {
    if (!open) return
    setOpen(false); setQ('')
    const same = draft.length === modelValue.length && draft.every(id => modelValue.includes(id))
    if (!same) { onUpdateModelValue?.(draft); onCommit?.(draft) }
  }
  const closeRef = useRef(close)
  closeRef.current = close

  async function create() {
    const made = await createLabel(q.trim())
    if (made) { setDraft(d => [...d, made.id]); setQ('') }
  }

  // 바깥 클릭 시 닫기(수동)
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) closeRef.current()
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [])

  return (
    <div ref={rootRef} className="relative">
      {/* ghost: 점선 '+ 편집' 칩 / default: 테두리 트리거 */}
      <button
        type="button"
        onClick={() => (open ? close() : openPicker())}
        className={cn(
          'flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] transition-colors',
          variant === 'ghost'
            ? 'border border-dashed border-accent text-muted-foreground hover:border-primary hover:text-primary'
            : (open ? 'border border-primary text-foreground' : 'border border-border text-muted-foreground hover:bg-accent/50'),
        )}
      >
        {variant === 'ghost' && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3 w-3"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>}
        <span className="truncate">{triggerText}</span>
        {variant !== 'ghost' && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-2.5 w-2.5 text-muted-foreground/80"><polyline points="6 9 12 15 18 9" /></svg>}
      </button>

      {open && (
        <div className="absolute left-0 z-dropdown mt-1 w-[212px] overflow-hidden rounded-[10px] border border-accent bg-card shadow-lg">
          {searchable && (
            <div className="flex h-9 items-center gap-2 border-b border-border px-3">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5 text-muted-foreground/80"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              <input
                autoComplete="off"
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder={t('git.labels.search')}
                className="w-full bg-transparent text-[12.5px] outline-hidden"
              />
            </div>
          )}

          <div className="max-h-[280px] overflow-y-auto p-1">
            {filtered.map(l => (
              <button
                key={l.id}
                type="button"
                onClick={() => toggle(l.id)}
                className="flex min-h-[34px] w-full items-center gap-2.5 rounded-[7px] px-2 hover:bg-accent/55"
              >
                <span
                  className={cn('grid h-3.5 w-3.5 shrink-0 place-items-center rounded border', draft.includes(l.id) ? 'border-primary bg-primary text-primary-foreground' : 'border-accent')}
                >
                  {draft.includes(l.id) && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-2 w-2"><polyline points="20 6 9 17 4 12" /></svg>}
                </span>
                {/* 색은 점에만 적용. 명도 하한을 적용하여 어두운 라벨도 식별 가능하게 한다 */}
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: labelDot(l.color) }} />
                <span className="truncate text-[12.5px]">{l.name}</span>
                <span className="ml-auto font-mono text-[10.5px] text-muted-foreground/80">
                  {labelCounts.get(l.id) ?? 0}
                </span>
              </button>
            ))}

            {canCreate && (
              <button
                type="button"
                onClick={() => { void create() }}
                className="mt-1 flex min-h-[34px] w-full items-center gap-2.5 border-t border-border px-2 text-[12.5px] text-primary"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                <span className="truncate">{t('git.labels.create', { name: q.trim() })}</span>
              </button>
            )}

            {!filtered.length && !canCreate && (
              <p className="px-2 py-3 text-center text-[12px] text-muted-foreground">
                {t('git.labels.empty')}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default GitLabelPicker
