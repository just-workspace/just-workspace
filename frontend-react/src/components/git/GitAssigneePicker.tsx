// Vue 원본: frontend/components/git/GitAssigneePicker.vue
// 이슈 담당자 고르기 — GitLabelPicker 와 같은 겉모습(점선 ghost 칩 트리거 + 212 드롭다운, 체크 행 34).
// 후보는 워크스페이스 사용자 검색(GET /api/chat/users?q=) — Gitea 로그인 이름 = 워크스페이스 아이디.
// 닫을 때 한 번만 commit 한다(체크마다 요청하지 않는다).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { $fetch } from '~/lib/api'
import { UiIcon } from '~/components/ui/Icon'
import { UiAvatar } from '~/components/ui/Avatar'

export interface GitAssigneePickerProps {
  /** 지금 담당자(Gitea 로그인 이름) */
  modelValue: string[]
  /** 닫을 때 값이 바뀌었으면 한 번 */
  onCommit?: (v: string[]) => void
}

interface Candidate { id: string; username: string; display_name: string | null; avatar_url: string | null }

/** 담당자 고르기(드롭다운) */
export function GitAssigneePicker({ modelValue, onCommit }: GitAssigneePickerProps) {
  const { t } = useI18n()

  const rootRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [draft, setDraft] = useState<string[]>([...modelValue])
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [loading, setLoading] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)

  async function search(query: string) {
    const my = ++seq.current
    setLoading(true)
    try {
      const list = await $fetch<Candidate[]>('/api/chat/users', { params: { q: query.trim() } })
      if (my === seq.current) setCandidates(list.slice(0, 30))
    } catch {
      if (my === seq.current) setCandidates([])
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }
  // watch(q) — 입력 200ms 뒤 검색(처음 마운트는 건너뜀)
  const firstQ = useRef(true)
  useEffect(() => {
    if (firstQ.current) { firstQ.current = false; return }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void search(q) }, 200)
     
  }, [q])
  // watch(open) — 열 때 현재 값으로 draft, 검색어 비우고 바로 검색
  useEffect(() => {
    if (!open) return
    setDraft([...modelValue])
    setQ('')
    void search('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 이미 담당인데 후보 목록(검색 결과)에 없는 사람도 맨 위에 보인다 — 해제할 수 있게
  const names = new Set(candidates.map(c => c.username))
  const extra: Candidate[] = draft.filter(n => !names.has(n)).map(n => ({ id: `login:${n}`, username: n, display_name: null, avatar_url: null }))
  const rows = [...extra, ...candidates]

  function toggle(login: string) {
    setDraft(d => (d.includes(login) ? d.filter(x => x !== login) : [...d, login]))
  }

  function close() {
    if (!open) return
    setOpen(false)
    const same = draft.length === modelValue.length && draft.every(n => modelValue.includes(n))
    if (!same) onCommit?.(draft)
  }
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) closeRef.current()
    }
    document.addEventListener('click', onDocClick)
    return () => { document.removeEventListener('click', onDocClick); if (timer.current) clearTimeout(timer.current) }
  }, [])
  function onKey(e: KeyboardEvent) { if (open && e.key === 'Escape') { e.stopPropagation(); close() } }

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKey}>
      <button
        type="button"
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-dashed border-accent px-2.5 text-[12.5px] text-muted-foreground transition-colors hover:border-primary hover:text-primary"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <UiIcon name="plus" className="h-3 w-3" />
        <span className="truncate">{modelValue.length ? t('git.assignee.edit') : t('git.assignee.add')}</span>
      </button>

      {open && (
        <div className="absolute left-0 z-dropdown mt-1 w-[212px] overflow-hidden rounded-[10px] border border-accent bg-card shadow-lg">
          <div className="flex h-9 items-center gap-2 border-b border-border px-3">
            <UiIcon name="search" className="h-3.5 w-3.5 text-muted-foreground/80" />
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              autoComplete="off"
              aria-label={t('git.assignee.search')}
              placeholder={t('git.assignee.search')}
              className="w-full bg-transparent text-[12.5px] outline-hidden"
            />
          </div>
          <div className="max-h-[280px] overflow-y-auto p-1" role="listbox" aria-label={t('git.shared.assignee')} aria-multiselectable="true">
            {rows.map(c => (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={draft.includes(c.username)}
                className="flex min-h-[34px] w-full items-center gap-2.5 rounded-[7px] px-2 hover:bg-accent/55"
                onClick={() => toggle(c.username)}
              >
                <span
                  className={cn('grid h-3.5 w-3.5 shrink-0 place-items-center rounded border', draft.includes(c.username) ? 'border-primary bg-primary text-primary-foreground' : 'border-accent')}
                >
                  {draft.includes(c.username) && <UiIcon name="check" className="h-2 w-2" strokeWidth={3} />}
                </span>
                <UiAvatar
                  src={c.avatar_url}
                  alt={c.display_name || c.username}
                  fallback={(c.display_name || c.username || '?').charAt(0).toUpperCase()}
                  className="h-5 w-5 text-[9px]"
                />
                <span className="truncate text-[12.5px]">{c.display_name || c.username}</span>
                <span className="ml-auto truncate font-mono text-[10.5px] text-muted-foreground/80">{c.username}</span>
              </button>
            ))}
            {!rows.length && !loading && <p className="px-2 py-3 text-center text-[12px] text-muted-foreground">{t('git.assignee.empty')}</p>}
          </div>
        </div>
      )}
    </div>
  )
}

export default GitAssigneePicker
