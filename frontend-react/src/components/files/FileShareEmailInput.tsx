/**
 * 받는 사람 이메일 칩 입력(R7 — 공유 링크를 이메일로 보내기). 시안 없음 → 공유 모달 "사람·채널" 칩 입력과 같은 문법
 * (칩 h-7 알약 bg-primary/13 · 추천 목록 행 40 · 키보드 ↑↓ Enter · Backspace 로 마지막 칩 빼기) — 디자이너 확인 필요.
 * - 쉼표·공백·세미콜론·Enter·칸 벗어남·붙여넣기로 칩이 된다. 형식이 틀리면 글자를 남기고 아래 오류 문구.
 * - 워크스페이스 사용자는 이름·이메일로 자동완성(/api/auth/users). 밖 주소 칩은 "외부" 표시(최종 판정은 서버 기록).
 * - 한 번에 SHARE_EMAIL_MAX(20)명까지(서버와 같은 한도).
 */
import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { clsx } from 'clsx'
import { useI18n } from '~/i18n'
import { useAuth } from '~/composables/useAuth'
import { searchUsers, type DirectoryUser } from '~/composables/useFiles'
import { addEmails, isExternalEmail, splitEmails, SHARE_EMAIL_MAX } from '~/lib/files'
import { UiIcon } from '~/components/ui/Icon'
import { UiAvatar } from '~/components/ui/Avatar'

export interface FilesShareEmailInputProps {
  /** 칩으로 들어간 주소들(소문자) */
  modelValue: string[]
  /** 칩 목록 바뀜 */
  onUpdateModelValue: (v: string[]) => void
  /** 아는 사용자(디렉터리) — 외부 표시·이름 표시용. 없으면 자동완성 결과만 */
  directory?: DirectoryUser[]
  /** 위 라벨 */
  label?: string
  /** 아래 도움말(오류가 없을 때) */
  hint?: string
  disabled?: boolean
  /** 칸에 칩이 못 된 글자(형식 오류 등)가 남았는지 — 남았으면 보내기를 막는 데 쓴다 */
  onPendingChange?: (pending: boolean) => void
}

const initial = (s: string) => (s || '?').trim().slice(0, 1).toUpperCase()

export function FilesShareEmailInput({ modelValue, onUpdateModelValue, directory = [], label, hint, disabled = false, onPendingChange }: FilesShareEmailInputProps) {
  const { t } = useI18n()
  const { user } = useAuth()
  const uid = useId()
  const [q, setQ] = useState('')
  const [error, setError] = useState('')
  const [results, setResults] = useState<DirectoryUser[]>([])
  const [known, setKnown] = useState<DirectoryUser[]>([])
  const [active, setActive] = useState(0)
  const el = useRef<HTMLInputElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const people = [...directory, ...known]
  const byEmail = (e: string) => people.find(u => (u.email || '').toLowerCase() === e)
  const knownEmails = people.map(u => u.email || '')

  // 칸 글자 → 칩
  function commit(text: string, keepBad = true) {
    const parts = splitEmails(text)
    if (!parts.length) { setQ(''); return }
    const r = addEmails(modelValue, parts)
    if (r.list.length !== modelValue.length) onUpdateModelValue(r.list)
    if (r.bad.length) setError(t('files.shareEmail.badEmail', { email: r.bad[0] }))
    else if (r.overflow) setError(t('files.shareEmail.tooMany', { n: SHARE_EMAIL_MAX }))
    else setError('')
    setQ(keepBad ? r.bad.join(', ') : '')
  }
  useEffect(() => { onPendingChange?.(!!q.trim()) }, [q]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setActive(0)
    if (timer.current) clearTimeout(timer.current)
    const term = q.trim()
    if (!term || /[\s,;]/.test(term)) { setResults([]); return }
    timer.current = setTimeout(async () => {
      try {
        const list = await searchUsers(term)
        setResults(list.filter(u => !u.is_self && u.email && !modelValue.includes(u.email.toLowerCase())).slice(0, 6))
      } catch { setResults([]) }
    }, 250)
  }, [q]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  function pick(u: DirectoryUser) {
    if (!u.email) return
    if (!people.some(p => p.id === u.id)) setKnown(k => [...k, u])
    commit(u.email, false)
    setResults([])
    el.current?.focus()
  }
  function remove(i: number) {
    onUpdateModelValue(modelValue.filter((_, j) => j !== i))
    setError('')
    el.current?.focus()
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    // 한글 이름으로 사람을 찾는 중(조합 중) Enter·공백은 글자 확정이다
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'ArrowDown' && results.length) { e.preventDefault(); setActive((active + 1) % results.length) }
    else if (e.key === 'ArrowUp' && results.length) { e.preventDefault(); setActive((active + results.length - 1) % results.length) }
    else if (e.key === 'Enter') {
      if (results.length) { e.preventDefault(); pick(results[Math.min(active, results.length - 1)]) }
      else if (q.trim()) { e.preventDefault(); commit(q) }
    } else if ((e.key === ',' || e.key === ';' || e.key === ' ') && q.trim()) { e.preventDefault(); commit(q) }
    else if (e.key === 'Backspace' && !q && modelValue.length) { onUpdateModelValue(modelValue.slice(0, -1)) }
  }
  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text')
    if (/[\s,;]/.test(text.trim())) { e.preventDefault(); commit(`${q} ${text}`) }
  }

  const listId = `${uid}-sug`
  const descId = `${uid}-desc`
  return (
    <div className="flex flex-col gap-1.5">
      {label && <label htmlFor={`${uid}-in`} className={clsx('text-xs font-semibold', error ? 'text-danger' : 'text-muted-foreground')}>{label}</label>}
      <div
        className={clsx(
          'flex min-h-10 min-w-0 cursor-text flex-wrap items-center gap-1.5 rounded-md border bg-background px-2 py-[5px] text-[13px] focus-within:ring-2',
          error ? 'border-danger focus-within:border-danger focus-within:ring-danger/35' : 'border-input focus-within:border-ring focus-within:ring-ring/30',
          disabled ? 'cursor-not-allowed opacity-70' : '',
        )}
        onClick={() => el.current?.focus()}
      >
        {modelValue.map((em, i) => {
          const u = byEmail(em)
          const ext = isExternalEmail(em, knownEmails, user?.email)
          return (
            <span key={em} className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-primary/[0.13] pl-1" title={ext ? t('files.shareEmail.externalTitle') : em}>
              {u
                ? <UiAvatar src={u.avatar_url} fallback={initial(u.display_name)} className="h-5 w-5" textSize={9} />
                : <span className="grid h-5 w-5 place-items-center rounded-full bg-muted" aria-hidden="true"><UiIcon name="mail" className="h-3 w-3" /></span>}
              <span className="max-w-[200px] truncate">{u ? u.display_name : em}</span>
              {ext && <span className="text-[11px] font-semibold text-warning">{t('files.shareEmail.external')}</span>}
              <button
                type="button"
                aria-label={t('files.shareEmail.remove', { email: em })}
                disabled={disabled}
                className="relative grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring before:absolute before:-inset-1.5 before:content-['']"
                onClick={(e) => { e.stopPropagation(); remove(i) }}
              ><UiIcon name="close" strokeWidth={2.4} className="h-3 w-3" /></button>
            </span>
          )
        })}
        <input
          ref={el}
          id={`${uid}-in`}
          value={q}
          onChange={e => { setQ(e.target.value); if (error) setError('') }}
          onKeyDown={onKey}
          onPaste={onPaste}
          onBlur={() => { if (q.trim()) commit(q) }}
          type="text"
          autoComplete="off"
          disabled={disabled || modelValue.length >= SHARE_EMAIL_MAX}
          role="combobox"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded={results.length > 0}
          aria-activedescendant={results.length ? `${listId}-${active}` : undefined}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={(error || hint) ? descId : undefined}
          placeholder={modelValue.length ? '' : t('files.shareEmail.placeholder')}
          className="h-7 min-w-[120px] flex-1 bg-transparent outline-hidden placeholder:text-muted-foreground"
        />
      </div>
      {results.length > 0 && (
        <ul id={listId} role="listbox" aria-label={t('files.shareEmail.suggest')} className="overflow-hidden rounded-md border border-border bg-background text-[13px]">
          {results.map((u, i) => (
            <li
              id={`${listId}-${i}`}
              key={u.id}
              role="option"
              aria-selected={i === active}
              className={clsx('flex h-10 cursor-pointer items-center gap-2.5 px-3', i === active ? 'bg-primary/[0.13]' : 'hover:bg-accent/40')}
              onMouseDown={(e) => { e.preventDefault(); pick(u) }}
              onMouseEnter={() => setActive(i)}
            >
              <UiAvatar src={u.avatar_url} fallback={initial(u.display_name)} className="h-6 w-6 shrink-0" textSize={10} />
              <span className="truncate">{u.display_name}</span>
              <span className="min-w-0 truncate text-muted-foreground">{u.email}</span>
            </li>
          ))}
        </ul>
      )}
      {error
        ? (
          <p id={descId} className="flex items-center gap-1.5 text-xs font-medium text-danger">
            <UiIcon name="alert-circle" className="h-[13px] w-[13px]" strokeWidth={2.2} />{error}
          </p>
        )
        : hint ? <p id={descId} className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export default FilesShareEmailInput
