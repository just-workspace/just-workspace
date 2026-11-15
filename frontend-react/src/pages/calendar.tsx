/**
 * 캘린더(Vue 원본: frontend/pages/calendar.vue).
 * 데스크톱: 사이드바 236(bg-card) + 커맨드 바 44(오늘 · ‹ › · 기간 15/600 … 일/주/월/일정 세그먼트 · ⋯).
 * 모바일(<md): 사이드바 대신 FAB(새 일정) + ⋯ 시트(캘린더 목록), 보기 세그먼트 일정/월/주, 월 날짜 탭 = 그날 시트.
 * 시간대 불일치 띠: 상단바 바로 아래·툴바 위 warning 틴트 h-44, [기기 시간대로 바꾸기](outline) · [○○ 그대로](ghost, = 닫기).
 *   툴바 오른쪽에 지금 시간대 mono 표시(항상).
 * 오류는 그리드를 지우지 않고 커맨드 바 아래 동기화 오류 띠 40. 빈 상태는 일정 목록·날짜 시트에서만.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { navigateTo, useRoute, type RouteLocation } from '~/lib/router'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useDesktopShell } from '~/composables/useDesktopShell'
import { useIsMobile } from '~/composables/useIsMobile'
import { useBreadcrumb } from '~/composables/useBreadcrumb'
import { usePageShortcuts } from '~/composables/useShortcuts'
import { addToast } from '~/composables/useToast'
import { alertBox } from '~/composables/useDialog'
import { useCalendar, calendarStore, applyDefaultViewOnce, type ViewMode } from '~/composables/useCalendar'
import { useUserPrefs, setTimezone } from '~/composables/useUserPrefs'
import { browserTimeZone } from '~/utils/calendarAttendees'
import { keepTzBand, tzBandKept, tzCity, tzMismatch, tzPlace, roParticle, utcOffsetLabel } from '~/utils/timezoneBand'
import { startOfWeek, addDays, fmtTime } from '~/utils/calendarLayout'
import { calendarZone, zAtTime, zDate, zp } from '~/utils/calTz'
import { UiButton } from '~/components/ui/Button'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiIcon } from '~/components/ui/Icon'
import { UiSegment } from '~/components/ui/Segment'
import { UiFab } from '~/components/ui/Fab'
import { UiTrans } from '~/components/ui/Trans'
import { UiTooltip } from '~/components/ui/Tooltip'
import { CalendarSidebar } from '~/components/calendar/CalendarSidebar'
import { CalendarMoreMenu } from '~/components/calendar/CalendarMoreMenu'
import { CalendarMonthView } from '~/components/calendar/CalendarMonthView'
import { CalendarWeekView } from '~/components/calendar/CalendarWeekView'
import { CalendarDayView } from '~/components/calendar/CalendarDayView'
import { CalendarAgendaView } from '~/components/calendar/CalendarAgendaView'
import { CalendarDaySheet } from '~/components/calendar/CalendarDaySheet'
import { CalendarEventPopover } from '~/components/calendar/CalendarEventPopover'
import { CalendarMobileMenu } from '~/components/calendar/CalendarMobileMenu'
import { CalendarEventModal } from '~/components/calendar/CalendarEventModal'
import { CalendarShareModal } from '~/components/calendar/CalendarShareModal'
import { CalendarIcsModal } from '~/components/calendar/CalendarIcsModal'

export default function CalendarPage() {
  const { t, tm, rt, locale } = useI18n()
  const { appName } = useSiteConfig()
  // 데스크톱 셸(Electron)이 nav=shell 로 범위 열(미니 달력·캘린더 목록)을 가져가면 사이드바를 그리지 않는다.
  const { navOwnedByShell } = useDesktopShell()
  const isMobile = useIsMobile()
  const pageRoute = useRoute()
  // 비동기 처리(onMounted 뒤 await)에서 "지금" 라우트를 읽는다(Vue 의 반응형 route)
  const routeRef = useRef<RouteLocation>(pageRoute)
  routeRef.current = pageRoute
  useHead({ title: `${t('nav.calendar')} | ${appName}` })

  const {
    viewMode, selectedDate, loadingEvents, eventsError, lastSyncedAt, weekStart, sheetDate, mobileMenuOpen, icsMode,
    fetchCalendars, fetchEvents, closeDaySheet, closePopover, openEventById, setMobileMenuOpen, setIcsMode,
    setViewMode, goToToday, navigatePrev, navigateNext, openCreateModal, selectDate,
  } = useCalendar()

  function openDateFromQuery() {
    const route = routeRef.current
    const q = route.query.date
    const m = typeof q === 'string' ? q.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null
    if (!m) return
    selectDate(zDate(+m[1], +m[2] - 1, +m[3], 9, 0))
    void navigateTo({ query: { ...route.query, date: undefined } }, { replace: true })
  }

  async function openEventFromQuery() {
    const route = routeRef.current
    const id = typeof route.query.event === 'string' ? route.query.event : ''
    if (!id) return
    const ok = await openEventById(id)
    if (!ok) addToast('error', t('calendar.error.eventNotFound'))
    void navigateTo({ query: { ...routeRef.current.query, event: undefined } }, { replace: true })
  }

  // 설정 › 캘린더 "기본 보기"(앱을 연 뒤 처음 한 번)
  const { prefs } = useUserPrefs()
  const defaultViewRef = useRef(prefs.calendarDefaultView)
  useLayoutEffect(() => { applyDefaultViewOnce(defaultViewRef.current, isMobile) }, [isMobile])

  useEffect(() => {
    void (async () => {
      await fetchCalendars()
      await fetchEvents()
      // 다른 모듈(연락처 "일정 잡기")이 ?new=1(&attendee=이메일&name=이름) 으로 새 일정 폼을 연다
      const route = routeRef.current
      if (route.query.new) {
        const email = typeof route.query.attendee === 'string' ? route.query.attendee : ''
        const name = typeof route.query.name === 'string' ? route.query.name : ''
        openCreateModal(new Date(), email ? { attendeeEmail: email, attendeeName: name || undefined } : undefined)
        await navigateTo({ query: { ...route.query, new: undefined, attendee: undefined, name: undefined } }, { replace: true })
      }
      // 회의 화면 "캘린더에서 보기"가 ?date=YYYY-MM-DD 로 그날을 연다
      openDateFromQuery()
      // 알림(일정 초대·응답)이 ?event=<id> 로 그 일정을 연다
      await openEventFromQuery()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // watch(() => route.query.date / .event) — immediate 아님
  const qDate = pageRoute.query.date
  const qEvent = pageRoute.query.event
  const firstQ = useRef({ date: true, event: true })
  useEffect(() => {
    if (firstQ.current.date) { firstQ.current.date = false; return }
    if (qDate) openDateFromQuery()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDate])
  // 이미 캘린더에 있을 때 알림을 눌러도 열리게
  useEffect(() => {
    if (firstQ.current.event) { firstQ.current.event = false; return }
    if (qEvent) void openEventFromQuery()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qEvent])

  // watch(selectedDate) → 다시 받기
  const firstSel = useRef(true)
  useEffect(() => {
    if (firstSel.current) { firstSel.current = false; return }
    void fetchEvents()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate])
  // 화면 폭이 바뀌면 모바일 전용 시트는 닫는다
  const firstMob = useRef(true)
  useEffect(() => {
    if (firstMob.current) { firstMob.current = false; return }
    if (!isMobile) { closeDaySheet(); setMobileMenuOpen(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile])
  // 월 보기를 떠나면 날짜 시트를 닫는다
  const firstView = useRef(true)
  useEffect(() => {
    if (firstView.current) { firstView.current = false; return }
    if (viewMode !== 'month') closeDaySheet()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => { closePopover(); closeDaySheet() }, [])

  // ── 동기화 오류 띠 ──
  // 닫으면 다음 오류까지 숨긴다. 일정 API 는 캘린더를 한꺼번에 받으므로 어느 캘린더인지는 가르지 않는다(디자이너 확인 필요).
  const [syncBandHidden, setSyncBandHidden] = useState(false)
  useEffect(() => { if (eventsError) setSyncBandHidden(false) }, [eventsError])
  const lastSyncText = lastSyncedAt ? fmtTime(lastSyncedAt) : ''
  function syncDetails() {
    void alertBox(calendarStore.getState().eventsError, { title: t('calendar.sync.failedTitle') })
  }

  // ── 시간대 불일치 띠 ──
  const deviceTz = browserTimeZone()
  const prefTz = prefs.timezone || ''
  // 캘린더가 실제로 쓰는 시간대(설정, 비었거나 잘못됐으면 기기) — 화면 전체가 이 기준(utils/calTz)
  const shownTz = calendarZone()
  const [tzKeptNow, setTzKeptNow] = useState('')
  const tzBand = shownTz === prefTz && tzMismatch(prefTz, deviceTz) && tzKeptNow !== `${prefTz}|${deviceTz}` && !tzBandKept(prefTz, deviceTz)
  const zoneText = (tz: string) => t('calendar.tzBand.zone', { city: tzCity(tz, locale), utc: utcOffsetLabel(tz) })
  function switchToDeviceTz() { setTimezone(deviceTz) }
  function keepPrefTz() { keepTzBand(prefTz, deviceTz); setTzKeptNow(`${prefTz}|${deviceTz}`) }

  const SHORT = (tm('calendar.weekdaysShort') as any[]).map(m => rt(m))

  /** 커맨드 바 기간 라벨(시안: "2026년 10월 12–18일") */
  const headerLabel = (() => {
    // 캘린더 시간대 기준
    const d = zp(selectedDate)
    if (viewMode === 'month' || viewMode === 'agenda') {
      return t('calendar.monthLabel', { y: d.year, m: d.month + 1 })
    }
    if (viewMode === 'week') {
      const ws = startOfWeek(selectedDate, weekStart)
      const s = zp(ws), e = zp(addDays(ws, 6))
      return s.month === e.month
        ? t('calendar.toolbar.weekRange', { y: s.year, m1: s.month + 1, d1: s.date, d2: e.date })
        : t('calendar.toolbar.weekRangeCrossMonth', { y: s.year, m1: s.month + 1, d1: s.date, m2: e.month + 1, d2: e.date })
    }
    return t('calendar.toolbar.dayLabel', { y: d.year, m: d.month + 1, d: d.date, w: SHORT[d.day] })
  })()

  // 상단바 3단 경로: 워크스페이스 / 캘린더 / 기간 (모바일은 이 값이 상단바 제목 — 시안 CM "2026년 10월")
  const crumb = isMobile
    ? t('calendar.monthLabel', { y: zp(selectedDate).year, m: zp(selectedDate).month + 1 })
    : headerLabel
  useBreadcrumb(crumb)

  const unit = viewMode === 'month' ? 'month' : viewMode === 'day' ? 'day' : 'week'
  const navLabels = { prev: t(`calendar.nav.prev.${unit}`), next: t(`calendar.nav.next.${unit}`) }

  const desktopModes = [
    { value: 'day', label: t('calendar.viewMode.day') },
    { value: 'week', label: t('calendar.viewMode.week') },
    { value: 'month', label: t('calendar.viewMode.month') },
    { value: 'agenda', label: t('calendar.viewMode.agenda') },
  ]
  const mobileModes = [
    { value: 'agenda', label: t('calendar.viewMode.agenda') },
    { value: 'month', label: t('calendar.viewMode.month') },
    { value: 'week', label: t('calendar.viewMode.week') },
  ]
  function setMode(v: string | number | null) { if (v) setViewMode(v as ViewMode) }

  function newEventFromFab() {
    openCreateModal(zAtTime(calendarStore.getState().selectedDate, 9))
  }

  // 단축키: T = 오늘(일정 편집 E·삭제 Del·닫기 Esc 는 팝오버가 맡는다)
  usePageShortcuts(t('nav.calendar'), [
    { keys: ['T'], label: t('calendar.shortcuts.today') },
    { keys: ['E'], label: t('calendar.shortcuts.edit') },
    { keys: ['Del'], label: t('calendar.shortcuts.delete') },
    { keys: ['Esc'], label: t('calendar.shortcuts.close') },
  ])
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable || e.ctrlKey || e.metaKey || e.altKey) return
      if (document.querySelector('[aria-modal="true"]')) return
      if (e.key === 't' || e.key === 'T') { e.preventDefault(); goToToday() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {tzBand && (
        <div role="status" className="flex h-11 shrink-0 items-center gap-2.5 border-b border-warning/40 bg-warning/10 px-4 text-[13px] low:h-9">
          <UiIcon name="globe" className="h-4 w-4 text-warning" />
          <UiTrans
            k="calendar.tzBand.text"
            className="min-w-0 flex-1 truncate"
            slots={{
              device: <b className="font-semibold">{zoneText(deviceTz)}</b>,
              pref: <b className="font-semibold">{zoneText(prefTz)}</b>,
            }}
            values={{ city: tzPlace(prefTz, locale) }}
          />
          {/* 띠 버튼은 한 줄 말줄임, 전체 문구는 툴팁(표에 없는 시간대는 "Almaty (UTC+5) 그대로"처럼 길어진다) */}
          {[
            { key: 'device', variant: 'outline' as const, onClick: switchToDeviceTz, text: t('calendar.tzBand.useDevice', { city: tzPlace(deviceTz, locale), ro: roParticle(tzPlace(deviceTz, locale)) }) },
            { key: 'keep', variant: 'ghost' as const, onClick: keepPrefTz, text: t('calendar.tzBand.keep', { city: tzPlace(prefTz, locale) }) },
          ].map(b => (
            <UiTooltip key={b.key} text={b.text}>
              <UiButton variant={b.variant} size="xs" className="min-w-0" onClick={b.onClick}><span className="truncate">{b.text}</span></UiButton>
            </UiTooltip>
          ))}
        </div>
      )}
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {/* 사이드바 236 (데스크톱만, 셸이 가져가면 생략) */}
      {!navOwnedByShell && (
        <aside className="hidden w-[236px] shrink-0 overflow-y-auto border-r border-border bg-card md:block">
          <CalendarSidebar />
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* 데스크톱 커맨드 바 44 */}
        <div className="hidden h-11 shrink-0 items-center gap-2 border-b border-border bg-card pl-3.5 pr-2.5 text-[13px] md:flex">
          <UiButton variant="outline" size="xs" className="h-8 bg-transparent px-3 text-[13px] font-medium" title={t('calendar.toolbar.todayKey')} onClick={goToToday}>
            {t('calendar.toolbar.today')}
          </UiButton>
          <UiIconButton label={navLabels.prev} icon="chevron-left" onClick={navigatePrev} />
          <UiIconButton label={navLabels.next} icon="chevron-right" onClick={navigateNext} />
          <h2 className="ml-1 min-w-0 truncate text-[15px] font-semibold text-foreground" aria-live="polite">{headerLabel}</h2>
          {loadingEvents && <UiIcon name="refresh" className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-label={t('common.loading')} />}
          <span className="flex-1" />
          <span className="font-mono text-xs text-muted-foreground" title={t('calendar.tzBand.current')}>{utcOffsetLabel(shownTz)} {tzCity(shownTz, locale)}</span>
          <UiSegment modelValue={viewMode} onUpdateModelValue={setMode} items={desktopModes} ariaLabel={t('calendar.viewMode.label')} />
          <CalendarMoreMenu />
        </div>

        {/* 모바일: 보기 세그먼트 + 이동 + 오늘 + ⋯ (제목은 상단바) */}
        <div className="flex shrink-0 items-center gap-1 py-2 pl-4 pr-1 md:hidden">
          <UiSegment modelValue={viewMode} onUpdateModelValue={setMode} items={mobileModes} size="lg" grow className="min-w-0 flex-1" ariaLabel={t('calendar.viewMode.label')} />
          <UiIconButton label={navLabels.prev} icon="chevron-left" size="md" noTooltip onClick={navigatePrev} />
          <UiIconButton label={navLabels.next} icon="chevron-right" size="md" noTooltip onClick={navigateNext} />
          <UiButton variant="outline" size="sm" className="h-9 bg-transparent px-3 text-[13px] font-normal" onClick={goToToday}>{t('calendar.toolbar.today')}</UiButton>
          <UiIconButton label={t('calendar.mobile.menu')} icon="more-horizontal" size="lg" noTooltip onClick={() => setMobileMenuOpen(true)} />
        </div>

        {/* 동기화 오류 띠 40(D4b) — 그리드는 그대로 둔다 */}
        {eventsError && !syncBandHidden && (
          <div
            role="alert"
            className="flex h-10 shrink-0 items-center gap-2.5 border-b border-warning/35 bg-warning/10 pl-3.5 pr-2.5 text-[13px] low:h-9"
          >
            <UiIcon name="alert-triangle" strokeWidth={2.2} className="h-[15px] w-[15px] text-warning" />
            <span className="min-w-0 flex-1 truncate">
              <b className="font-semibold">{t('calendar.sync.failedTitle')}</b>
              <span className="text-muted-foreground">
                {lastSyncText && <> · {t('calendar.sync.lastSuccess')} <span className="font-mono">{lastSyncText}</span></>} · {t('calendar.sync.mayBeStale')}
              </span>
            </span>
            <button
              type="button"
              className="relative inline-flex h-7 shrink-0 items-center rounded-sm border border-border px-2.5 text-xs font-semibold hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-['']"
              disabled={loadingEvents}
              onClick={() => void fetchEvents()}
            >{t('common.retry')}</button>
            <button
              type="button"
              className="relative h-7 shrink-0 px-1.5 text-xs font-semibold text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-['']"
              onClick={syncDetails}
            >{t('calendar.sync.details')}</button>
            <UiIconButton label={t('common.close')} icon="close" className="h-7 w-7" noTooltip onClick={() => setSyncBandHidden(true)} />
          </div>
        )}

        {/* 보기 */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {viewMode === 'month'
            ? <CalendarMonthView />
            : viewMode === 'week'
              ? <CalendarWeekView />
              : viewMode === 'day'
                ? <CalendarDayView />
                : <CalendarAgendaView />}

          {/* 모바일 월: 날짜 탭 → 그날 시트 */}
          {isMobile && sheetDate && viewMode === 'month' && <CalendarDaySheet />}
        </div>
      </div>

      {/* 모바일 FAB(새 일정) — 날짜 시트가 열려 있으면 시트 안 [+ 새 일정]이 대신한다 */}
      {!sheetDate && <UiFab label={t('calendar.event.newButton')} onClick={newEventFromFab} />}

      <CalendarEventPopover />
      {mobileMenuOpen && <CalendarMobileMenu />}
      <CalendarEventModal />
      <CalendarShareModal />
      {icsMode && <CalendarIcsModal mode={icsMode} onClose={() => setIcsMode(null)} />}
    </div>
    </div>
  )
}
