/**
 * 일정 폼 참석자 칩 입력(Vue components/calendar/CalendarAttendeesInput.vue · 시안 CL2 "참석자"):
 * 상자 min-h 40 · p 5/8 · gap 6, 칩 28 알약 primary/13
 * (이니셜 20 · 이름 · 상태[가능 = success 점 8 / 겹침 = warning 11/600] · ✕ 20(히트 40)) + "이름·이메일로 추가" 입력.
 * 자동완성 = 워크스페이스 사용자(/api/contacts/workspace-users). 목록에 없는 이메일은 외부 참석자로 추가.
 * 드롭다운은 회의 초대 창(MeetingsInviteModal)과 같은 규격(행 36 · popover · shadow-md).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { attendeeInitial } from '~/utils/calendarAttendees'
import { UiIcon } from '~/components/ui/Icon'
import { UiAvatar } from '~/components/ui/Avatar'
import { toCssRect, viewportCss } from '~/composables/useViewport'

export interface AttendeeChip {
  email: string
  name?: string | null
  user_id?: string | null
  response?: string | null
}

interface WsUser { id: string; username: string; display_name: string; email: string | null; avatar_url?: string | null }

export interface CalendarAttendeesInputProps {
  /** 참석자 목록(v-model) */
  modelValue: AttendeeChip[]
  onUpdateModelValue?: (v: AttendeeChip[]) => void
  /** 이메일(소문자) → 'free' | 'busy'(겹침). 없으면 표시 안 함(외부·모름) */
  availability?: Record<string, 'free' | 'busy'>
  /** 자동완성에서 뺄 이메일(주최자 본인) */
  excludeEmail?: string | null
  labelledby?: string
}

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)

/** 참석자 칩 입력(워크스페이스 사용자 자동완성 + 외부 이메일) */
export function CalendarAttendeesInput({ modelValue, onUpdateModelValue, availability, excludeEmail, labelledby }: CalendarAttendeesInputProps) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WsUser[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const uid = `cal-att-${useId().replace(/:/g, '')}`
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)

  // 타이머·blur 지연 처리에서 "지금" 값
  const live = useRef({ modelValue, query, results, excludeEmail })
  live.current = { modelValue, query, results, excludeEmail }
  const takenOf = (list: AttendeeChip[]) => new Set(list.map(a => a.email.toLowerCase()))
  const taken = takenOf(modelValue)

  function setModel(v: AttendeeChip[]) {
    live.current.modelValue = v
    onUpdateModelValue?.(v)
  }

  function onInput(value: string) {
    setQuery(value)
    live.current.query = value
    const q = value.trim()
    if (timer.current) clearTimeout(timer.current)
    if (!q) { setResults([]); setOpen(false); return }
    timer.current = setTimeout(async () => {
      const my = ++seq.current
      try {
        const r = await $fetch<{ users: WsUser[] }>('/api/contacts/workspace-users', { params: { q, limit: 8 } })
        if (my !== seq.current) return
        const ex = (live.current.excludeEmail || '').toLowerCase()
        const tk = takenOf(live.current.modelValue)
        setResults(r.users.filter(u => u.email && !tk.has(u.email.toLowerCase()) && u.email.toLowerCase() !== ex))
      } catch { if (my === seq.current) setResults([]) }
      setActive(0)
      setOpen(true)
    }, 250)
  }

  const q = query.trim()
  const showExternal = isEmail(q) && !taken.has(q.toLowerCase()) && !results.some(u => (u.email || '').toLowerCase() === q.toLowerCase())
  const optionCount = results.length + (showExternal ? 1 : 0)

  function reset() {
    setQuery('')
    live.current.query = ''
    setResults([])
    setOpen(false)
    inputRef.current?.focus()
  }

  function addUser(u: WsUser) {
    const cur = live.current.modelValue
    if (!u.email || takenOf(cur).has(u.email.toLowerCase())) return
    setModel([...cur, { email: u.email.toLowerCase(), name: u.display_name || u.username, user_id: u.id }])
    reset()
  }

  function addExternal() {
    const e = live.current.query.trim().toLowerCase()
    const cur = live.current.modelValue
    if (!isEmail(e) || takenOf(cur).has(e)) return
    setModel([...cur, { email: e, name: null }])
    reset()
  }

  function pick(i: number) {
    if (i < results.length) addUser(results[i])
    else if (showExternal) addExternal()
  }

  function remove(i: number) {
    setModel(live.current.modelValue.filter((_, k) => k !== i))
    inputRef.current?.focus()
  }

  function onKeydown(e: KeyboardEvent<HTMLInputElement>) {
    // 한글 조합 중 Enter 는 글자 확정이다(macOS 는 조합 중에도 key='Enter') — 고르기로 넘기면 마지막 글자가 입력칸에 남아 다시 검색된다
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'ArrowDown' && optionCount) { e.preventDefault(); setOpen(true); setActive((active + 1) % optionCount) }
    else if (e.key === 'ArrowUp' && optionCount) { e.preventDefault(); setActive((active - 1 + optionCount) % optionCount) }
    else if (e.key === 'Enter' || e.key === ',') {
      // 이 칸의 Enter 는 절대 폼 제출로 새지 않는다(자동완성 중 Enter = 고르기). 예전엔 목록이 뜨기 전·결과가
      // 없을 때 이름만 치고 Enter 를 누르면 참석자 없이 일정이 저장되고 창이 닫혔다.
      e.preventDefault()
      if (open && optionCount) pick(active)
      else if (isEmail(query.trim())) addExternal()
    } else if (e.key === 'Escape' && open) { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); e.preventDefault(); setOpen(false) }
    else if (e.key === 'Backspace' && !query && modelValue.length) remove(modelValue.length - 1)
  }

  function onBlur() {
    setTimeout(() => {
      setOpen(false)
      // 다 쓴 이메일을 두고 나가면 그대로 추가(입력이 사라지는 것 방지)
      if (isEmail(live.current.query.trim())) addExternal()
    }, 150)
  }

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  // ── 목록 위치 ── 모달 본문(overflow-y-auto) 안에 absolute 로 두면 푸터에 잘려 첫 줄만 보였다.
  // UiSelect·UiMenu 처럼 body 포털 + fixed(z-overlay)로 띄운다: 칸 아래, 자리가 없으면 위.
  const boxRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)
  const shown = open && optionCount > 0
  useLayoutEffect(() => {
    if (!shown) { setPos(null); return }
    const place = () => {
      const box = boxRef.current
      if (!box) return
      const r = toCssRect(box.getBoundingClientRect())
      const { vh } = viewportCss()
      const h = listRef.current?.offsetHeight ?? 0
      const below = r.bottom + 4
      const top = below + h > vh - 8 && r.top - 4 - h >= 8 ? r.top - 4 - h : below
      setPos({ left: r.left, top, width: r.width })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [shown, optionCount])

  function chipName(a: AttendeeChip) { return a.name || a.email }

  return (
    <div className="relative">
      <div
        ref={boxRef}
        className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-[5px] text-[13px] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/35"
        onClick={() => inputRef.current?.focus()}
      >
        {modelValue.map((a, i) => (
          <span
            key={a.email}
            className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-primary/[0.13] px-1"
            title={a.email}
          >
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-muted text-[9px] font-semibold" aria-hidden="true">{attendeeInitial(a.name, a.email)}</span>
            <span className="min-w-0 truncate">{chipName(a)}</span>
            {availability?.[a.email.toLowerCase()] === 'free'
              ? <span className="h-2 w-2 shrink-0 rounded-full bg-success" role="img" aria-label={t('calendar.form.attendeeFree')} />
              : availability?.[a.email.toLowerCase()] === 'busy'
                ? <span className="shrink-0 text-[11px] font-semibold text-warning">{t('calendar.form.conflict')}</span>
                : null}
            <button
              type="button"
              aria-label={t('calendar.form.removeAttendee', { name: chipName(a) })}
              className="relative grid h-5 w-5 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground before:absolute before:-inset-2.5 before:content-['']"
              onClick={(e) => { e.stopPropagation(); remove(i) }}
            ><UiIcon name="close" className="h-3 w-3" strokeWidth={2.4} /></button>
          </span>
        ))}
        <input
          id={uid}
          ref={inputRef}
          value={query}
          type="text"
          autoComplete="off"
          role="combobox"
          aria-expanded={open && optionCount > 0}
          aria-controls={`${uid}-list`}
          aria-labelledby={labelledby}
          aria-activedescendant={open && optionCount ? `${uid}-opt-${active}` : undefined}
          placeholder={modelValue.length ? '' : t('calendar.form.attendeesPlaceholder')}
          className="h-7 min-w-[8rem] flex-1 bg-transparent px-1 outline-hidden placeholder:text-muted-foreground"
          onChange={e => onInput(e.target.value)}
          onKeyDown={onKeydown}
          onBlur={onBlur}
        />
      </div>
      {shown && createPortal(
        <div
          ref={listRef}
          id={`${uid}-list`}
          role="listbox"
          className="fixed z-overlay max-h-56 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-md"
          style={{ left: `${pos?.left ?? 0}px`, top: `${pos?.top ?? 0}px`, width: pos ? `${pos.width}px` : undefined, opacity: pos ? 1 : 0 }}
        >
          {results.map((u, i) => (
            <button
              id={`${uid}-opt-${i}`}
              key={u.id}
              type="button"
              role="option"
              aria-selected={active === i}
              className={cn('flex h-9 w-full items-center gap-2 rounded-sm px-2.5 text-left text-[13px] hover:bg-accent', active === i ? 'bg-accent' : '')}
              onMouseDown={(e) => { e.preventDefault(); addUser(u) }}
            >
              <UiAvatar src={u.avatar_url} fallback={attendeeInitial(u.display_name, u.email || '')} className="h-5 w-5" textSize={9} />
              <span className="truncate font-medium">{u.display_name}</span>
              <span className="truncate text-xs text-muted-foreground">{u.email}</span>
            </button>
          ))}
          {showExternal && (
            <button
              id={`${uid}-opt-${results.length}`}
              type="button"
              role="option"
              aria-selected={active === results.length}
              className={cn('flex h-9 w-full items-center gap-1.5 rounded-sm px-2.5 text-left text-[13px] hover:bg-accent', active === results.length ? 'bg-accent' : '')}
              onMouseDown={(e) => { e.preventDefault(); addExternal() }}
            >
              <span className="text-muted-foreground">{t('calendar.form.addExternal')}</span>
              <span className="truncate font-medium">{query.trim()}</span>
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}

export default CalendarAttendeesInput
