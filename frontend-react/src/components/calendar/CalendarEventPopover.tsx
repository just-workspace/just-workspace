/**
 * 일정 읽기 팝오버: 폭 340, rounded-lg, shadow-xl,
 * 머리 40(색 10 + 캘린더 이름 12 muted, 편집(E)·삭제·닫기 32),
 * 본문 p-14 gap-12: 제목 16/600 · 날짜 13 muted(시각 mono · 반복 요약) · 화상 회의 줄([참여] 30 primary).
 * 데스크톱은 일정 옆(왼쪽 우선, 자리가 없으면 오른쪽)에 붙고, 모바일은 바텀시트로 같은 내용을 보여 준다.
 * 참석자 줄: 이니셜 24 겹침(-6, 최대 4) + "참석자 N · 수락 a · 미정 b · 거절 c". 내가 참석자면 "내 응답" 세그먼트(수락·미정·거절).
 * 초대받은 일정(is_invited)은 내 캘린더가 아니므로 편집·삭제 없이 응답만 한다.
 * 키보드: E = 편집, Delete = 삭제, Esc = 닫기. 더블클릭 = 편집은 그리드 쪽.
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useAuth } from '~/composables/useAuth'
import { useIsMobile } from '~/composables/useIsMobile'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { useCalendar, calendarStore, type DeleteScope } from '~/composables/useCalendar'
import { eventBar, fmtTime, isSameDay, parseRRule } from '~/utils/calendarLayout'
import { eventRange, zp } from '~/utils/calTz'
import { countResponses, attendeeInitial, type AttendeeResponse } from '~/utils/calendarAttendees'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiButton } from '~/components/ui/Button'
import { UiSegment } from '~/components/ui/Segment'
import { getUiZoom, viewportCss } from '~/composables/useViewport'
import { CalendarScopeModal } from './CalendarScopeModal'

const W = 340
const GAP = 12

/** 일정 읽기 팝오버(데스크톱) · 바텀시트(모바일). popoverEvent 가 있을 때만 보인다 */
export function CalendarEventPopover() {
  const { t, tm, rt } = useI18n()
  const { user } = useAuth()
  const isMobile = useIsMobile()
  const {
    popoverEvent, popoverAnchor, calendars,
    closePopover, openEditModal, deleteEventScoped, rsvpEvent,
  } = useCalendar()

  const ev = popoverEvent
  const cal = calendars.find(c => c.id === ev?.calendar_id)
  const canWrite = !!cal && cal.can_write !== false && !ev?.is_invited
  const headerName = cal?.name || (ev?.is_invited ? t('calendar.popover.invited') : '')

  // ── 참석자 · 내 응답 ──
  const attendees = ev?.attendees || []
  const counts = countResponses(attendees)
  const attendeeSummary = (() => {
    const c = counts
    const parts = [t('calendar.popover.attendeesN', { n: c.total })]
    if (c.accepted) parts.push(t('calendar.popover.acceptedN', { n: c.accepted }))
    if (c.tentative) parts.push(t('calendar.popover.tentativeN', { n: c.tentative }))
    if (c.declined) parts.push(t('calendar.popover.declinedN', { n: c.declined }))
    if (c.pending) parts.push(t('calendar.popover.pendingN', { n: c.pending }))
    return parts
  })()
  const faces = attendees.slice(0, 4).map(a => ({ key: a.email, initial: attendeeInitial(a.name, a.email), title: `${a.name || a.email} · ${t(`calendar.rsvp.${a.response === 'needs-action' ? 'pending' : a.response}`)}` }))
  const isAttendee = !!ev?.my_response
  const [rsvpBusy, setRsvpBusy] = useState(false)
  const rsvpItems = (['accepted', 'tentative', 'declined'] as const).map(v => ({
    value: v,
    label: t(`calendar.rsvp.${v}`),
    // 수락한 칸은 ✓ 글리프 대신 check 아이콘
    icon: ev?.my_response === v && v === 'accepted' ? 'check' : undefined,
    disabled: rsvpBusy,
  }))
  const rsvpModel = ev?.my_response && ev.my_response !== 'needs-action' ? ev.my_response : null
  const busyRef = useRef(false)
  async function respond(r: AttendeeResponse) {
    const target = calendarStore.getState().popoverEvent
    if (!target || busyRef.current || target.my_response === r) return
    busyRef.current = true
    setRsvpBusy(true)
    try { await rsvpEvent(target, r) }
    catch { addToast('error', t('calendar.rsvp.failed')) }
    finally { busyRef.current = false; setRsvpBusy(false) }
  }
  function onRsvp(v: string | number | null) { if (v) respond(v as AttendeeResponse) }

  const SHORT = (tm('calendar.weekdaysShort') as any[]).map(m => rt(m))
  function dayText(d: Date) {
    const p = zp(d)
    return t('calendar.popover.day', { m: p.month + 1, d: p.date, w: SHORT[p.day] })
  }

  // 종일은 날짜 그대로(시간대 변환 없음) — 화면 배치용 범위
  const range = ev ? eventRange(ev) : null
  const start = range ? range.start : new Date()
  const end = range ? range.end : new Date()

  const whenParts = (() => {
    if (!ev) return { day: '', time: '' }
    const s = start, e = end
    if (ev.all_day) {
      const last = new Date(e.getTime() - 1)
      return isSameDay(s, last) || last < s
        ? { day: dayText(s), time: t('calendar.allDay') }
        : { day: `${dayText(s)} – ${dayText(last)}`, time: '' }
    }
    if (!isSameDay(s, e)) return { day: `${dayText(s)} ${fmtTime(s)} – ${dayText(e)} ${fmtTime(e)}`, time: '' }
    return { day: dayText(s), time: `${fmtTime(s)}–${fmtTime(e)}` }
  })()

  const repeatText = (() => {
    const r = parseRRule(ev?.recurrence_rule)
    if (!r || !r.freq) return ''
    const n = r.interval
    if (r.freq === 'WEEKLY') {
      const FULL = (tm('calendar.weekdaysFull') as any[]).map(m => rt(m))
      const days = (r.byday.length ? r.byday : [zp(start).day]).map(i => FULL[i]).join('·')
      return n > 1 ? t('calendar.popover.everyNWeeks', { n, days }) : t('calendar.popover.weekly', { days })
    }
    const key = ({ DAILY: 'daily', MONTHLY: 'monthly', YEARLY: 'yearly' } as Record<string, string>)[r.freq]
    return n > 1 ? t(`calendar.popover.everyN.${key}`, { n }) : t(`calendar.popover.${key}`)
  })()

  // 화상 회의: meeting_url 우선. 예전 회의 → 캘린더 연동은 location 에 참여 URL 을 넣었다(meetings/invite.py)
  const loc = ev?.location?.trim() || ''
  const locationUrl = /^https?:\/\//i.test(loc) ? loc : ''
  const m = ev?.meeting_url?.trim() || ''
  const meetingUrl = /^https?:\/\//i.test(m) ? m : locationUrl
  const meetingLabel = (() => {
    if (!meetingUrl) return ''
    try { return new URL(meetingUrl).pathname.split('/').filter(Boolean).pop() || new URL(meetingUrl).host } catch { return meetingUrl }
  })()
  const placeText = locationUrl ? '' : ev?.location?.trim() || ''

  function join() { if (meetingUrl) window.open(meetingUrl, '_blank', 'noopener') }

  const [scopeOpen, setScopeOpen] = useState(false)
  // 확인 대화 상자가 떠 있는 동안 바깥 클릭으로 팝오버가 닫히지 않게
  const [confirming, setConfirming] = useState(false)

  // 리스너에서 "지금" 값을 읽는다
  const live = useRef({ canWrite, scopeOpen, confirming, isMobile })
  live.current = { canWrite, scopeOpen, confirming, isMobile }

  function edit() {
    const cur = calendarStore.getState().popoverEvent
    if (cur && live.current.canWrite) openEditModal(cur)
  }

  async function remove() {
    const target = calendarStore.getState().popoverEvent
    if (!target || !live.current.canWrite) return
    // "이 일정만" 수정된 회차(예외 행)도 반복의 한 회차다 — 범위를 묻는다. 예전엔 단일 일정처럼 확인만 받고
    // scope=all 로 보내 시리즈 전체가 지워졌다.
    if (target.is_recurring || target.is_occurrence || target.is_exception) { setScopeOpen(true); live.current.scopeOpen = true; return }
    setConfirming(true)
    live.current.confirming = true
    try {
      const ok = await confirmBox(t('calendar.event.deleteConfirm'), { danger: true, confirmLabel: t('common.delete') })
      if (!ok) return
      await deleteEventScoped(target, 'all')
      closePopover()
    } catch { addToast('error', t('calendar.event.deleteError')) }
    finally { setConfirming(false); live.current.confirming = false }
  }

  async function onScopeConfirm(scope: DeleteScope, notify = false) {
    setScopeOpen(false)
    const cur = calendarStore.getState().popoverEvent
    if (!cur) return
    try {
      const n = await deleteEventScoped(cur, scope, { notify })
      closePopover()
      if (n) addToast('success', t('calendar.scope.notified', { n }))
    } catch { addToast('error', t('calendar.event.deleteError')) }
  }

  // ── 위치(데스크톱) ──
  const panel = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 })

  function place() {
    // 화면 배율(루트 zoom): 기준 사각형은 화면 좌표 → style 에 넣을 CSS px 로
    const raw = calendarStore.getState().popoverAnchor
    const z = getUiZoom()
    const a = raw && { x: raw.x / z, y: raw.y / z, w: raw.w / z, h: raw.h / z }
    const { vw, vh } = viewportCss()
    const h = panel.current?.offsetHeight ?? 220
    if (!a) { setPos({ left: (vw - W) / 2, top: Math.max(8, (vh - h) / 2) }); return }
    let left = a.x - W - GAP
    if (left < 8) left = a.x + a.w + GAP
    if (left + W > vw - 8) left = Math.max(8, vw - W - 8)
    const top = Math.min(Math.max(8, a.y), vh - h - 8)
    setPos({ left, top })
  }

  // watch([ev, popoverAnchor], immediate) → nextTick(place)
  useLayoutEffect(() => {
    if (ev && !isMobile) place()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ev, popoverAnchor])

  const fns = useRef({ edit, remove, place })
  fns.current = { edit, remove, place }
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!calendarStore.getState().popoverEvent || live.current.scopeOpen || live.current.confirming) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return
      if (e.key === 'Escape') { e.preventDefault(); closePopover() }
      else if ((e.key === 'e' || e.key === 'E') && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); fns.current.edit() }
      else if (e.key === 'Delete') { e.preventDefault(); fns.current.remove() }
    }
    function onOutside(e: MouseEvent) {
      if (!calendarStore.getState().popoverEvent || live.current.isMobile || live.current.scopeOpen || live.current.confirming) return
      if (panel.current && !panel.current.contains(e.target as Node)) closePopover()
    }
    const onResize = () => fns.current.place()
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    // 일정 칩 클릭이 먼저 처리되도록 캡처 단계가 아닌 버블 단계에서 바깥 클릭을 본다
    document.addEventListener('mousedown', onOutside)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('mousedown', onOutside)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const facesEl = (
    <span className="flex" aria-hidden="true">
      {faces.map(f => (
        <span key={f.key} title={f.title} className="-mr-1.5 grid h-6 w-6 place-items-center rounded-full bg-muted text-[10px] font-semibold shadow-[0_0_0_2px_hsl(var(--card))]">{f.initial}</span>
      ))}
    </span>
  )

  const whenEl = (
    <>
      {whenParts.day}
      {whenParts.time && <> · <span className="font-mono">{whenParts.time}</span></>}
      {repeatText && <> · {repeatText}</>}
    </>
  )

  return (
    <>
      {ev && createPortal(
        isMobile
          ? (
            /* 모바일: 바닥 시트 */
            <div className="fixed inset-0 z-modal flex flex-col justify-end bg-scrim" onClick={(e) => { if (e.target === e.currentTarget) closePopover() }}>
              <div
                role="dialog"
                aria-label={ev.title}
                className="max-h-[85dvh] overflow-y-auto rounded-t-sheet border-t border-border bg-card animate-slide-up"
                style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
              >
                <div className="mx-auto mt-2.5 h-1 w-9 rounded-full bg-muted" aria-hidden="true" />
                <div className="flex h-12 items-center gap-0.5 pl-4 pr-1 text-muted-foreground">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: eventBar(ev.color) }} aria-hidden="true" />
                  <span className="ml-2 min-w-0 flex-1 truncate text-[13px]">{headerName}</span>
                  {canWrite && (
                    <>
                      <UiIconButton label={t('common.edit')} icon="edit" size="md" noTooltip onClick={edit} />
                      <UiIconButton label={t('common.delete')} icon="trash" size="md" noTooltip onClick={remove} />
                    </>
                  )}
                  <UiIconButton label={t('common.close')} icon="close" size="md" noTooltip onClick={closePopover} />
                </div>
                <div className="flex flex-col gap-3.5 px-4 pb-6 pt-1">
                  <div>
                    <div className="text-lg font-semibold text-foreground">{ev.title}</div>
                    <div className="text-[13px] text-muted-foreground">{whenEl}</div>
                  </div>
                  {meetingUrl && (
                    <div className="flex items-center gap-2.5 text-sm">
                      <UiIcon name="video" className="h-[15px] w-[15px] shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{t('calendar.popover.meeting')} · <span className="font-mono text-xs text-muted-foreground">{meetingLabel}</span></span>
                      <UiButton size="sm" className="h-10 px-4 font-semibold" onClick={join}>{t('calendar.popover.join')}</UiButton>
                    </div>
                  )}
                  {placeText && <div className="text-sm text-foreground">{placeText}</div>}
                  {attendees.length > 0 && (
                    <div className="flex items-center gap-2.5 text-sm">
                      {facesEl}
                      <span className="ml-2 min-w-0">
                        {attendeeSummary.map((p, i) => <Fragment key={i}>{i ? ' · ' : ''}{p}</Fragment>)}
                      </span>
                    </div>
                  )}
                  {ev.description && <p className="whitespace-pre-wrap break-words text-[13px] text-muted-foreground">{ev.description}</p>}
                  {isAttendee && (
                    <div className="flex items-center gap-2 border-t border-border pt-3 text-[13px]">
                      <span className="text-muted-foreground">{t('calendar.rsvp.mine')}</span>
                      <UiSegment modelValue={rsvpModel} onUpdateModelValue={onRsvp} items={rsvpItems} size="lg" grow className="min-w-0 flex-1" ariaLabel={t('calendar.rsvp.mine')} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
          : (
            /* 데스크톱: 일정 옆 팝오버 */
            <div
              ref={panel}
              role="dialog"
              aria-label={ev.title}
              // z-overlay: body 포털이라 z-dropdown(100)이면 셸 주메뉴(z-sidebar 250) 밑으로 들어갔다.
              // 확인·범위 대화 상자(z-modal 300)가 떠 있는 동안은 그 위로 올라오지 않게 숨긴다.
              className={cn('fixed z-overlay overflow-hidden rounded-lg border border-border bg-card shadow-xl', scopeOpen || confirming ? 'invisible' : '')}
              style={{ left: `${pos.left}px`, top: `${pos.top}px`, width: `${W}px` }}
            >
              <div className="flex h-10 items-center gap-0.5 border-b border-border pl-3.5 pr-1.5 text-muted-foreground">
                <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: eventBar(ev.color) }} aria-hidden="true" />
                <span className="ml-2 min-w-0 flex-1 truncate text-xs">{headerName}</span>
                {canWrite && (
                  <>
                    <UiIconButton label={t('common.edit')} icon="edit" keys={['E']} onClick={edit} />
                    <UiIconButton label={t('common.delete')} icon="trash" keys={['Del']} onClick={remove} />
                  </>
                )}
                <UiIconButton label={t('common.close')} icon="close" keys={['Esc']} onClick={closePopover} />
              </div>
              <div className="flex flex-col gap-3 p-3.5">
                <div>
                  <div className="text-base font-semibold text-foreground">{ev.title}</div>
                  <div className="text-[13px] text-muted-foreground">{whenEl}</div>
                </div>
                {meetingUrl && (
                  <div className="flex items-center gap-2.5 text-[13px]">
                    <UiIcon name="video" className="h-[15px] w-[15px] shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{t('calendar.popover.meeting')} · <span className="font-mono text-xs text-muted-foreground">{meetingLabel}</span></span>
                    <button
                      type="button"
                      className="inline-flex h-[30px] items-center rounded-sm bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-card"
                      onClick={join}
                    >{t('calendar.popover.join')}</button>
                  </div>
                )}
                {placeText && <div className="text-[13px] text-foreground">{placeText}</div>}
                {attendees.length > 0 && (
                  <div className="flex items-center gap-2.5 text-[13px]">
                    {facesEl}
                    <span className="ml-2 min-w-0">
                      {attendeeSummary.map((p, i) => <Fragment key={i}>{i ? ' · ' : ''}<span className={cn(i === 0 ? 'font-mono' : '')}>{p}</span></Fragment>)}
                    </span>
                  </div>
                )}
                {ev.description && <p className="line-clamp-4 whitespace-pre-wrap break-words text-[13px] text-muted-foreground">{ev.description}</p>}
                {isAttendee && (
                  <div className="flex items-center gap-2 border-t border-border pt-2.5 text-xs">
                    <span className="text-muted-foreground">{t('calendar.rsvp.mine')}</span>
                    <UiSegment modelValue={rsvpModel} onUpdateModelValue={onRsvp} items={rsvpItems} ariaLabel={t('calendar.rsvp.mine')} />
                  </div>
                )}
              </div>
            </div>
          ),
        document.body,
      )}

      {scopeOpen && ev && (
        <CalendarScopeModal
          mode="delete"
          isOccurrence={!!ev.is_occurrence}
          event={ev}
          myEmail={user?.email}
          onClose={() => setScopeOpen(false)}
          onConfirm={onScopeConfirm}
        />
      )}
    </>
  )
}

export default CalendarEventPopover
