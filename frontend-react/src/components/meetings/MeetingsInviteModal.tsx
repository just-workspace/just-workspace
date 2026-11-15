/**
 * 회의 예약 / 지금 시작: UiModal 520(모바일 바텀시트). Vue 판 components/meetings/MeetingsInviteModal.vue 그대로.
 *  회의 이름 → [날짜 1.3fr · 시작 1fr · 길이 1fr] → 초대(사람·이메일 칩 입력) → 비밀번호(선택, 보기 토글) → [취소][예약]
 *  지금 시작(mode="now")은 날짜·시작·길이 줄을 뺀다.
 * 초대 칩: 워크스페이스 사람 = primary/13 알약, 외부 = 테두리 알약 + "외부". ✕ 20(히트 40).
 *  [비밀번호 1fr | "외부 손님은 대기실" 스위치 1fr] → "내 캘린더에 일정으로 추가하고 초대 메일 보내기" 체크(예약일 때).
 * mode="edit": 같은 창으로 회의 수정(PATCH) — 기존 초대 대상은 상세(by-id)에서 받아 칩으로, 뺀 사람은 remove_invitee_ids,
 *  새 사람은 add_invitees. 비밀번호는 비워 두면 그대로, "비밀번호 해제" 체크로 지운다. 캘린더 체크는 없다(호스트 일정은 서버가 따라 옮긴다).
 * ★백엔드 갭: 채널 초대(사람·이메일만) — 그리지 않는다.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { ymd } from '~/utils/taskQuick'
import { getMeeting, type MeetingRoomInfo, type MeetingUpdate } from '~/composables/useMeetings'
import { UiModal } from '~/components/ui/Modal'
import { UiInput } from '~/components/ui/Input'
import { UiSelect } from '~/components/ui/Select'
import { UiPasswordInput } from '~/components/ui/PasswordInput'
import { UiSwitch } from '~/components/ui/Switch'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiButton } from '~/components/ui/Button'
import { UiBadge } from '~/components/ui/Badge'
import { UiIcon } from '~/components/ui/Icon'

interface Invitee {
  type: 'internal' | 'external'
  user_id?: string
  username?: string
  display_name?: string
  email?: string
  label: string
  /** 수정 모드: 이미 초대된 사람의 초대 id */
  inviteeId?: string
  /** 수정 모드: 그 사람의 응답 */
  response?: string
}

interface SearchResult {
  id?: string
  username?: string
  display_name?: string
  name?: string
  email: string
  organization?: string
  sources?: string[]
}

export interface MeetingCreatePayload {
  name: string
  invitees: Omit<Invitee, 'label' | 'inviteeId' | 'response'>[]
  scheduled_at: string | null
  duration_minutes: number
  password: string | null
  waiting_room: boolean
  add_to_calendar: boolean
}

export interface MeetingsInviteModalProps {
  /** 예약(schedule) · 지금 시작(now) · 수정(edit). 기본 schedule */
  mode?: 'schedule' | 'now' | 'edit'
  /** 서버 요청 중(버튼 잠금·바깥 클릭 무시) */
  busy?: boolean
  /** 수정할 회의(mode="edit") */
  room?: MeetingRoomInfo | null
  /** 서버가 이름을 거절했을 때(409 같은 이름) 이름 칸 아래에 */
  serverNameError?: string
  onClose?: () => void
  onCreate?: (payload: MeetingCreatePayload) => void
  onUpdate?: (patch: MeetingUpdate) => void
}

// 기본 예약 = 다음 정시(30분 단위 올림)
function nextSlot() {
  const d = new Date()
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() <= 30 ? 30 : 60)
  return d
}
function hhmmOf(d: Date) { return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
function isValidEmail(str: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str)
}
const strip = ({ label: _l, inviteeId: _i, response: _r, ...rest }: Invitee) => rest

/** 회의 예약·지금 시작·수정 창 */
export function MeetingsInviteModal({
  mode = 'schedule', busy = false, room = null, serverNameError = '', onClose, onCreate, onUpdate,
}: MeetingsInviteModalProps) {
  const { t } = useI18n()
  const isEdit = mode === 'edit'

  const [slot] = useState(nextSlot)
  const [roomName, setRoomNameRaw] = useState('')
  const [invitees, setInvitees] = useState<Invitee[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [showDropdown, setShowDropdown] = useState(false)
  const [scheduledDate, setScheduledDate] = useState(() => ymd(slot))
  const [scheduledTime, setScheduledTime] = useState(() => hhmmOf(slot))
  const [durationMinutes, setDurationMinutes] = useState<string | number | null>(60)
  const [password, setPassword] = useState('')
  const [nameError, setNameError] = useState('')
  const [waitingRoom, setWaitingRoom] = useState(true)
  const [addToCalendar, setAddToCalendar] = useState(true)
  const [clearPassword, setClearPassword] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)

  // watch(roomName, () => nameError = '')
  function setRoomName(v: string) { setRoomNameRaw(v); setNameError('') }
  // watch(serverNameError, v => { if (v) nameError = v })
  useEffect(() => { if (serverNameError) setNameError(serverNameError) }, [serverNameError])

  // ── 수정 모드: 지금 값으로 채우기 ──
  const original = useRef<{ title: string; date: string; time: string; duration: number; waiting: boolean; invitees: Invitee[] } | null>(null)
  useEffect(() => {
    const r = room
    if (!isEdit || !r) return
    let alive = true
    void (async () => {
      const title = r.title || r.name
      setRoomName(title)
      let date = ''
      let time = hhmmOf(slot)
      if (r.scheduled_at) {
        const d = new Date(r.scheduled_at)
        date = ymd(d)
        time = hhmmOf(d)
        setScheduledTime(time)
      }
      setScheduledDate(date)
      const duration = r.duration_minutes || 60
      setDurationMinutes(duration)
      const waiting = r.waiting_room ?? true
      setWaitingRoom(waiting)
      let current: Invitee[] = []
      if (r.meeting_id) {
        setLoadingDetail(true)
        try {
          const d = await getMeeting(r.meeting_id)
          current = d.invitees.map(i => ({
            type: i.user_id ? 'internal' : 'external',
            user_id: i.user_id || undefined,
            email: i.email || undefined,
            display_name: i.display_name || undefined,
            label: i.display_name || i.email || '?',
            inviteeId: i.id,
            response: i.response,
          }))
        } catch { /* 초대 목록 없이 고친다 */ }
        finally { if (alive) setLoadingDetail(false) }
      }
      if (!alive) return
      setInvitees(current)
      original.current = { title, date, time, duration: Number(duration) || 60, waiting, invitees: [...current] }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (debounceTimer.current) clearTimeout(debounceTimer.current) }, [])
  const inputRef = useRef<HTMLInputElement | null>(null)
  const inviteesRef = useRef(invitees)
  inviteesRef.current = invitees

  const durationOptions = (() => {
    const list: { value: number; label: string }[] = [
      { value: 30, label: t('meetings.invite.duration30') },
      { value: 60, label: t('meetings.invite.duration60') },
      { value: 120, label: t('meetings.invite.duration120') },
    ]
    // 다른 길이로 저장된 회의(캘린더에서 만든 회의 등)를 고칠 때 그 값도 고를 수 있게
    const cur = Number(durationMinutes)
    if (cur && !list.some(o => o.value === cur)) list.push({ value: cur, label: t('meetings.invite.durationN', { n: cur }) })
    return list
  })()

  // 사람 검색(최근 보낸 수신인 · 워크스페이스 · 주소록 통합) — 기존 동작 유지
  function onSearchInput(value: string) {
    setSearchQuery(value)
    const q = value.trim()
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    if (q.length < 1) {
      setSearchResults([])
      setShowDropdown(false)
      return
    }
    debounceTimer.current = setTimeout(async () => {
      try {
        const results = await $fetch<SearchResult[]>('/api/contacts/suggest', { params: { q, limit: 8 }, credentials: 'include' })
        const added = new Set(inviteesRef.current.map(i => (i.email || '').toLowerCase()).filter(Boolean))
        setSearchResults(results.filter(r => !added.has((r.email || '').toLowerCase())))
        setShowDropdown(true)
      } catch {
        setSearchResults([])
      }
    }, 300)
  }

  function addSuggestion(r: SearchResult) {
    if (invitees.some(i => (i.email || '').toLowerCase() === (r.email || '').toLowerCase())) return
    const label = r.display_name || r.name || r.username || r.email
    if (r.id) {
      // 워크스페이스 계정 — 캘린더 일정까지 만들어 주는 internal 경로
      setInvitees([...invitees, { type: 'internal', user_id: r.id, username: r.username, display_name: r.display_name || r.name, email: r.email, label }])
    } else {
      setInvitees([...invitees, { type: 'external', email: r.email, label }])
    }
    setSearchQuery('')
    setSearchResults([])
    setShowDropdown(false)
    inputRef.current?.focus()
  }

  function sourceLabel(r: SearchResult): string {
    const s = r.sources || []
    if (s.includes('user')) return t('meetings.invite.sourceWorkspace')
    if (s.includes('contact')) return t('meetings.invite.sourceContacts')
    if (s.includes('recent')) return t('meetings.invite.sourceRecent')
    return ''
  }

  function addExternalEmail() {
    const email = searchQuery.trim()
    if (!isValidEmail(email) || invitees.some(i => i.email === email)) return
    setInvitees([...invitees, { type: 'external', email, label: email }])
    setSearchQuery('')
    setSearchResults([])
    setShowDropdown(false)
    inputRef.current?.focus()
  }

  function handleKeydown(e: KeyboardEvent<HTMLInputElement>) {
    // 한글 조합 중 Enter 는 글자를 확정하는 키다. 그대로 두면 브라우저에 따라 폼이 통째로 제출되거나(초대 없이 회의 생성)
    // 한 글자 전 검색 결과가 들어가고 마지막 글자가 칸에 남는다 — 조합 확정만 하게 삼킨다.
    if (e.key !== 'Escape' && (e.nativeEvent.isComposing || e.keyCode === 229)) {
      if (e.key === 'Enter' || e.nativeEvent.code === 'Enter' || e.nativeEvent.code === 'NumpadEnter') e.preventDefault()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const q = searchQuery.trim()
      if (searchResults.length > 0) addSuggestion(searchResults[0])
      else if (isValidEmail(q)) addExternalEmail()
    }
    if (e.key === 'Escape' && showDropdown) { e.stopPropagation(); setShowDropdown(false) }
    if (e.key === 'Backspace' && !searchQuery && invitees.length) setInvitees(invitees.slice(0, -1))
  }

  function removeInvitee(idx: number) {
    setInvitees(invitees.filter((_, i) => i !== idx))
    inputRef.current?.focus()
  }

  function onBlurInput() {
    setTimeout(() => { setShowDropdown(false) }, 200)
  }

  function scheduledIso(): string | null {
    if (!scheduledDate) return null
    // 로컬 시각 → 시간대 포함 ISO(예전엔 시간대 없이 보내 서버가 UTC 로 읽어 9시간 밀렸다)
    const [y, m, d] = scheduledDate.split('-').map(Number)
    const [hh, mm] = (scheduledTime || '00:00').split(':').map(Number)
    return new Date(y, m - 1, d, hh, mm).toISOString()
  }

  function handleSubmit(e?: FormEvent) {
    e?.preventDefault()
    if (busy || loadingDetail) return
    if (!roomName.trim()) { setNameError(t('meetings.invite.nameRequired')); return }
    if (isEdit) { submitEdit(); return }
    onCreate?.({
      name: roomName.trim(),
      invitees: invitees.map(strip),
      scheduled_at: mode === 'schedule' ? scheduledIso() : null,
      duration_minutes: Number(durationMinutes) || 60,
      password: password.trim() || null,
      waiting_room: waitingRoom,
      add_to_calendar: mode === 'schedule' && !!scheduledDate && addToCalendar,
    })
  }

  /** 수정: 바뀐 것만 보낸다 */
  function submitEdit() {
    const o = original.current
    const patch: MeetingUpdate = {}
    const title = roomName.trim()
    if (!o || title !== o.title) patch.title = title
    if (!o || scheduledDate !== o.date || scheduledTime !== o.time) patch.scheduled_at = scheduledIso()
    const dur = Number(durationMinutes) || 60
    if (!o || dur !== o.duration) patch.duration_minutes = dur
    if (!o || waitingRoom !== o.waiting) patch.waiting_room = waitingRoom
    if (clearPassword) patch.password = ''
    else if (password.trim()) patch.password = password.trim()
    const keep = new Set(invitees.filter(i => i.inviteeId).map(i => i.inviteeId!))
    const removed = (o?.invitees || []).filter(i => i.inviteeId && !keep.has(i.inviteeId)).map(i => i.inviteeId!)
    if (removed.length) patch.remove_invitee_ids = removed
    const added = invitees.filter(i => !i.inviteeId).map(strip)
    if (added.length) patch.add_invitees = added
    if (!Object.keys(patch).length) { onClose?.(); return }
    onUpdate?.(patch)
  }

  function responseLabel(r?: string) {
    if (!r || r === 'pending') return ''
    return t(`meetings.rsvp.${r}`)
  }

  const q = searchQuery.trim()

  return (
    <UiModal
      title={mode === 'now' ? t('meetings.startNow') : isEdit ? t('meetings.edit.title') : t('meetings.schedule')}
      size="lg"
      persistent={busy}
      onClose={() => onClose?.()}
      footer={(
        <>
          <UiButton variant="outline" size="sm" type="button" disabled={busy} onClick={() => onClose?.()}>{t('common.cancel')}</UiButton>
          <UiButton size="sm" type="submit" form="meeting-create" className="font-semibold" disabled={busy || loadingDetail}>
            {busy ? (isEdit ? t('common.saving') : t('meetings.invite.creatingNow')) : mode === 'now' ? t('meetings.invite.startBtn') : isEdit ? t('common.save') : t('meetings.invite.scheduleBtn')}
          </UiButton>
        </>
      )}
    >
      <form id="meeting-create" className="flex flex-col gap-3.5" onSubmit={handleSubmit}>
        <UiInput
          modelValue={roomName}
          onUpdateModelValue={setRoomName}
          label={t('meetings.invite.meetingName')}
          placeholder={t('meetings.invite.meetingNamePlaceholder')}
          data-autofocus
          error={nameError}
          maxLength={100}
        />

        {mode !== 'now' && (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-[1.3fr_1fr_1fr]">
            <UiInput modelValue={scheduledDate} onUpdateModelValue={setScheduledDate} type="date" label={t('meetings.invite.date')} className="col-span-2 sm:col-span-1" />
            <UiInput modelValue={scheduledTime} onUpdateModelValue={setScheduledTime} type="time" label={t('meetings.invite.start')} mono />
            <UiSelect modelValue={durationMinutes} onUpdateModelValue={setDurationMinutes} options={durationOptions} label={t('meetings.invite.length')} />
          </div>
        )}

        {/* 초대: 칩 + 입력 한 상자 */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="meeting-invite-input" className="text-xs font-semibold text-muted-foreground">{t('meetings.invite.inviteLabel')}</label>
          <div className="relative">
            <div
              className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-[5px] text-[13px] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/35"
              onClick={() => inputRef.current?.focus()}
            >
              {invitees.map((inv, idx) => (
                <span
                  key={idx}
                  className={cn('inline-flex h-7 items-center gap-1.5 rounded-full pl-2.5 pr-1', inv.type === 'internal' ? 'bg-primary/[0.13]' : 'border border-border')}
                >
                  {inv.label}
                  {inv.type === 'external' && <span className="text-[11px] text-muted-foreground">{t('meetings.invite.externalTag')}</span>}
                  {responseLabel(inv.response) && (
                    <span className={cn('text-[11px]', inv.response === 'accepted' ? 'text-success' : inv.response === 'declined' ? 'text-danger' : 'text-muted-foreground')}>{responseLabel(inv.response)}</span>
                  )}
                  <button
                    type="button"
                    aria-label={t('meetings.invite.removeInvitee', { name: inv.label })}
                    className="relative grid h-5 w-5 place-items-center rounded-full text-muted-foreground hover:text-foreground before:absolute before:-inset-2.5 before:content-['']"
                    onClick={(e) => { e.stopPropagation(); removeInvitee(idx) }}
                  ><UiIcon name="close" className="h-3 w-3" strokeWidth={2.4} /></button>
                </span>
              ))}
              <input
                id="meeting-invite-input"
                ref={inputRef}
                value={searchQuery}
                type="text"
                autoComplete="off"
                role="combobox"
                aria-expanded={showDropdown}
                aria-controls="meeting-invite-list"
                placeholder={t('meetings.invite.peoplePlaceholder')}
                className="h-7 min-w-[8rem] flex-1 bg-transparent px-1 outline-hidden placeholder:text-muted-foreground"
                onChange={e => onSearchInput(e.target.value)}
                onKeyDown={handleKeydown}
                onBlur={onBlurInput}
                onFocus={() => { if (searchQuery.trim() && searchResults.length) setShowDropdown(true) }}
              />
            </div>
            {showDropdown && (searchResults.length > 0 || (q && isValidEmail(q))) && (
              <div
                id="meeting-invite-list"
                role="listbox"
                className="absolute inset-x-0 top-full z-dropdown mt-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-md"
              >
                {searchResults.map(r => (
                  <button
                    key={r.email}
                    type="button"
                    role="option"
                    className="flex h-9 w-full items-center gap-2 rounded-sm px-2.5 text-left text-[13px] hover:bg-accent"
                    onMouseDown={(e) => { e.preventDefault(); addSuggestion(r) }}
                  >
                    <span className="truncate font-medium">{r.display_name || r.name || r.email}</span>
                    <span className="truncate text-xs text-muted-foreground">{r.username ? `@${r.username}` : r.email}</span>
                    {sourceLabel(r) && <UiBadge tone="neutral" tint size={18} className="ml-auto">{sourceLabel(r)}</UiBadge>}
                  </button>
                ))}
                {isValidEmail(q) && !searchResults.some(r => r.email === q) && (
                  <button
                    type="button"
                    role="option"
                    className="flex h-9 w-full items-center gap-1.5 rounded-sm px-2.5 text-left text-[13px] hover:bg-accent"
                    onMouseDown={(e) => { e.preventDefault(); addExternalEmail() }}
                  >
                    <span className="text-muted-foreground">{t('meetings.invite.external')}</span>
                    <span className="truncate font-medium">{q}</span>
                  </button>
                )}
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {invitees.length ? t('meetings.invite.inviteSummary', { n: invitees.length }) : t('meetings.invite.maxParticipantsHint')}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 sm:items-end">
          <UiPasswordInput
            modelValue={password}
            onUpdateModelValue={setPassword}
            label={t('meetings.invite.passwordOptional')}
            autocomplete="new-password"
            placeholder={isEdit && room?.has_password ? t('meetings.edit.passwordKeep') : t('meetings.invite.passwordPlaceholder')}
          />
          <UiSwitch modelValue={waitingRoom} onUpdateModelValue={setWaitingRoom} label={t('meetings.invite.waitingRoom')} labelFirst={false} className="h-10" />
        </div>
        <p className="-mt-1.5 text-xs text-muted-foreground">{waitingRoom ? t('meetings.invite.passwordHint') : t('meetings.invite.waitingRoomOffHint')}</p>
        {isEdit && room?.has_password && <UiCheckbox modelValue={clearPassword} onUpdateModelValue={setClearPassword} label={t('meetings.edit.clearPassword')} />}
        {mode === 'schedule' && (
          <UiCheckbox
            modelValue={addToCalendar}
            onUpdateModelValue={setAddToCalendar}
            disabled={!scheduledDate}
            label={t('meetings.invite.addToCalendar')}
          />
        )}
      </form>
    </UiModal>
  )
}

export default MeetingsInviteModal
