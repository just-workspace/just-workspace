/**
 * 월 보기(Vue components/calendar/CalendarMonthView.vue). 데스크톱: 칩 3개 + "+n"(클릭 → 그날 일 보기), 빈 칸 클릭 = 새 일정.
 * 모바일(시안 CM1): 칸 52, 날짜 28 mono 13, 점 ≤3 + "+n", 날짜 탭 = 그날 일정 시트(시안 캘2).
 */
import { useState } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useCalendar, type CalendarEvent } from '~/composables/useCalendar'
import { useIsMobile } from '~/composables/useIsMobile'
import { startOfWeek, addDays, isSameDay } from '~/utils/calendarLayout'
import { zDate, zNow, zp } from '~/utils/calTz'
import { CalendarEventChip } from './CalendarEventChip'

interface DayCell {
  date: Date
  isCurrentMonth: boolean
  isToday: boolean
  isSelected: boolean
  events: CalendarEvent[]
}

/** 월 보기 */
export function CalendarMonthView() {
  const {
    selectedDate, weekStart, popoverEvent, sheetDate,
    openCreateModal, openEditModal, openPopover, openDaySheet, eventsOnDay, selectDate, setViewMode, popoverJustClosed,
  } = useCalendar()
  const isMobile = useIsMobile()

  const { t, tm, rt } = useI18n()
  const raw = (tm('calendar.weekdaysShort') as any[]).map(m => rt(m))
  const DAY_LABELS = [...raw.slice(weekStart), ...raw.slice(0, weekStart)]

  // Vue 는 컴포넌트 setup 시점의 오늘
  const [today] = useState(() => zNow())

  const weeks: DayCell[][] = (() => {
    // 캘린더 시간대의 그달
    const d = zp(selectedDate)
    const year = d.year
    const month = d.month
    const start = startOfWeek(zDate(year, month, 1), weekStart)

    const result: DayCell[][] = []
    let current = new Date(start)
    for (let w = 0; w < 6; w++) {
      const week: DayCell[] = []
      for (let i = 0; i < 7; i++) {
        const date = new Date(current)
        week.push({
          date,
          isCurrentMonth: zp(date).month === month,
          isToday: isSameDay(date, today),
          isSelected: !!sheetDate && isSameDay(date, sheetDate),
          events: eventsOnDay(date),
        })
        current = addDays(current, 1)
      }
      result.push(week)
      const c = zp(current)
      if (c.month !== month && (c.month > month || c.year > year) && w >= 3) break
    }
    return result
  })()

  function onCellClick(day: DayCell) {
    if (isMobile) openDaySheet(day.date)
    else if (!popoverJustClosed()) openCreateModal(day.date)
  }

  function showDay(day: DayCell) {
    selectDate(day.date)
    setViewMode('day')
  }

  function cellAria(day: DayCell) {
    return t('calendar.month.dayAria', { m: zp(day.date).month + 1, d: zp(day.date).date, n: day.events.length })
  }

  return (
    <div className="flex h-full flex-col">
      {/* 요일 머리 */}
      <div className={cn('grid grid-cols-7 border-b border-border md:border-b', isMobile ? 'px-2' : '')}>
        {DAY_LABELS.map(label => (
          <div
            key={label}
            className="h-6 text-center text-[11px] leading-6 text-muted-foreground md:py-2 md:font-semibold md:leading-none md:tracking-[0.06em]"
          >{label}</div>
        ))}
      </div>

      {/* 주 행 */}
      <div
        className={cn('grid md:flex-1', isMobile ? 'px-2' : '')}
        style={{ gridTemplateRows: isMobile ? 'auto' : `repeat(${weeks.length}, minmax(0, 1fr))` }}
      >
        {weeks.map((week, wi) => (
          <div key={wi} className="grid grid-cols-7 md:border-b md:border-border md:last:border-b-0">
            {week.map((day, di) => (
              <div
                key={di}
                className={cn(
                  'relative flex cursor-pointer flex-col border-t border-border transition-colors md:border-t-0 md:border-r md:p-1 md:last:border-r-0 md:hover:bg-accent/40 h-[52px] items-center pt-1 md:h-auto md:items-stretch md:overflow-hidden md:pt-1',
                  !isMobile && (zp(day.date).day === 0 || zp(day.date).day === 6) ? 'md:bg-card/50' : '',
                )}
                onClick={() => onCellClick(day)}
              >
                {/* 날짜 숫자(모바일 28 · 데스크톱 24). 키보드 진입점(클릭은 칸으로 올라가 칸 동작 = 모바일 날짜 시트 / 데스크톱 새 일정). 히트 영역은 칸 전체 */}
                <button
                  type="button"
                  aria-label={cellAria(day)}
                  aria-current={day.isToday ? 'date' : undefined}
                  className={cn(
                    'grid h-7 w-7 shrink-0 place-items-center rounded-full font-mono text-[13px] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring md:mb-0.5 md:h-6 md:w-6 md:text-[11px]',
                    day.isToday ? 'bg-primary font-bold text-primary-foreground'
                      : day.isSelected ? 'bg-primary/[0.13] font-semibold text-foreground'
                        : !day.isCurrentMonth ? 'text-muted-foreground/50' : 'text-foreground',
                  )}
                >{zp(day.date).date}</button>

                {isMobile
                  ? (
                    /* 모바일: 점 ≤3 + "+n" */
                    <span className="mt-[3px] flex h-2 items-center gap-[3px]" aria-hidden="true">
                      {Array.from({ length: Math.min(day.events.length, 3) }, (_, n) => (
                        <span key={n} className="h-[5px] w-[5px] rounded-full bg-foreground/70" />
                      ))}
                      {day.events.length > 3 && <span className="font-mono text-[9px] font-bold text-foreground">+{day.events.length - 3}</span>}
                    </span>
                  )
                  : (
                    /* 데스크톱: 칩 */
                    <div className="w-full min-w-0 space-y-0.5">
                      {day.events.slice(0, 3).map(event => (
                        <CalendarEventChip
                          key={event.id}
                          event={event}
                          selected={popoverEvent?.id === event.id}
                          onClick={(ev, el) => openPopover(ev, el)}
                          onEdit={openEditModal}
                        />
                      ))}
                      {day.events.length > 3 && (
                        <button
                          type="button"
                          className="px-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                          onClick={(e) => { e.stopPropagation(); showDay(day) }}
                        >{t('calendar.event.moreCount', { n: day.events.length - 3 })}</button>
                      )}
                    </div>
                  )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

export default CalendarMonthView
