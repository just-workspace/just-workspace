/**
 * 일정 목록(agenda) 보기(Vue components/calendar/CalendarAgendaView.vue): 날짜 머리 36 bg-card 13/600 + "오늘" 틴트 배지, 행 56.
 * 선택한 날짜부터 60일. 빈 상태는 여기(와 날짜 시트)에서만 띄운다(시안 캘6) — 그리드 위에는 안 띄움.
 */
import { Fragment, useMemo, useState } from 'react'
import { useI18n } from '~/i18n'
import { useCalendar, type CalendarEvent } from '~/composables/useCalendar'
import { startOfDay, addDays, isSameDay } from '~/utils/calendarLayout'
import { calendarZone, eventRange, zNow, zp } from '~/utils/calTz'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiBadge } from '~/components/ui/Badge'
import { CalendarAgendaRow } from './CalendarAgendaRow'

interface Group { key: number; date: Date; today: boolean; events: CalendarEvent[] }

/** 일정 목록 보기 */
export function CalendarAgendaView() {
  const { t, tm, rt } = useI18n()
  const { selectedDate, visibleEvents, loadingEvents, events, openPopover, openCreateModal } = useCalendar()

  const DAY_LABELS = (tm('calendar.weekdaysShort') as any[]).map(m => rt(m))
  const [today] = useState(() => zNow())
  const zone = calendarZone()

  const groups = useMemo((): Group[] => {
    const from = startOfDay(selectedDate)
    const to = addDays(from, 60)
    const map = new Map<number, Group>()
    // 종일은 날짜 그대로(eventRange), 정렬도 화면 기준 시작으로
    const list = [...visibleEvents]
      .map(e => ({ e, r: eventRange(e) }))
      .filter(({ r }) => r.end > from && r.start < to)
      .sort((a, b) => a.r.start.getTime() - b.r.start.getTime() || Number(b.e.all_day) - Number(a.e.all_day))
    for (const { e, r } of list) {
      const s = r.start
      const day = s < from ? from : startOfDay(s)
      const key = day.getTime()
      if (!map.has(key)) map.set(key, { key, date: day, today: isSameDay(day, today), events: [] })
      map.get(key)!.events.push(e)
    }
    return [...map.values()]
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zone
  }, [selectedDate, visibleEvents, today, zone])

  function dayLabel(d: Date) {
    return t('calendar.agenda.dayLabel', { m: zp(d).month + 1, d: zp(d).date, w: DAY_LABELS[zp(d).day] })
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {loadingEvents && events.length === 0
        ? <UiSkeleton preset="list" rows={6} />
        : groups.length === 0
          ? (
            <UiEmptyState
              icon="calendar"
              title={t('calendar.agenda.empty')}
              description={t('calendar.agenda.emptyDesc')}
              actionLabel={t('calendar.event.newButton')}
              onAction={() => openCreateModal(selectedDate)}
            />
          )
          : groups.map(g => (
            <Fragment key={g.key}>
              <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-4 text-[13px] font-semibold text-foreground">
                {dayLabel(g.date)}
                {g.today && <UiBadge tone="primary" tint size={18}>{t('common.today')}</UiBadge>}
              </div>
              {g.events.map(e => (
                <CalendarAgendaRow key={e.id} event={e} onClick={(ev, el) => openPopover(ev, el)} />
              ))}
            </Fragment>
          ))}
    </div>
  )
}

export default CalendarAgendaView
