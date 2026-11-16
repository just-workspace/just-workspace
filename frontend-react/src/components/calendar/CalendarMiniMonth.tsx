/**
 * 사이드바 미니 달력:
 * 머리 13/600 + ‹ › 28, 요일 24 muted, 날짜 28 mono 11.
 * 오늘 = primary 원(700) · 선택한 주(주 보기) 또는 선택한 날 = primary/13 · 다른 달 = muted/60.
 * ‹ › 는 시각 28 유지, 히트 영역은 40.
 */
import { useEffect, useMemo, useState } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useCalendar } from '~/composables/useCalendar'
import { addDays, isSameDay, startOfWeek } from '~/utils/calendarLayout'
import { calendarZone, zDate, zNow, zp } from '~/utils/calTz'
import { UiIcon } from '~/components/ui/Icon'

export interface CalendarMiniMonthProps {
  /** 선택한 날짜(해당 월을 표시) */
  selectedDate: Date
  /** 날짜 클릭 시 */
  onSelect?: (date: Date) => void
}

interface Cell { date: Date; inMonth: boolean; today: boolean; inWeek: boolean; selected: boolean }

// 컴포넌트 최초 생성 시점의 오늘을 사용한다
const mountedToday = () => zNow()

/** 사이드바 미니 달력 */
export function CalendarMiniMonth({ selectedDate, onSelect }: CalendarMiniMonthProps) {
  const { t, tm, rt } = useI18n()
  const { weekStart, weekRange, viewMode } = useCalendar()

  const [viewDate, setViewDate] = useState(() => new Date(selectedDate))
  useEffect(() => { setViewDate(new Date(selectedDate)) }, [selectedDate])
  const [today] = useState(mountedToday)

  // i18n weekdaysShort 는 [일, 월, …] — 주 시작에 맞춰 회전
  const raw = (tm('calendar.weekdaysShort') as any[]).map(m => rt(m))
  const DAY_LABELS = [...raw.slice(weekStart), ...raw.slice(0, weekStart)]

  const vp = zp(viewDate)
  const monthLabel = t('calendar.monthLabel', { y: vp.year, m: vp.month + 1 })
  const zone = calendarZone()

  const wStart = weekRange.start.getTime(), wEnd = weekRange.end.getTime()
  const cells = useMemo((): Cell[] => {
    const d = zp(viewDate)
    const first = zDate(d.year, d.month, 1)
    const start = startOfWeek(first, weekStart)
    const out: Cell[] = []
    const highlightWeek = viewMode === 'week'
    for (let i = 0; i < 42; i++) {
      const date = addDays(start, i)
      // 6주째가 전부 다음 달이면 생략
      if (i >= 35 && zp(date).month !== d.month && i % 7 === 0) break
      const inMonth = zp(date).month === d.month
      const isToday = isSameDay(date, today)
      const inWeek = highlightWeek && date.getTime() >= wStart && date.getTime() <= wEnd
      const selected = !highlightWeek && isSameDay(date, selectedDate)
      out.push({ date, inMonth, today: isToday, inWeek, selected })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zone: 캘린더 시간대 변경 시 재계산
  }, [viewDate, weekStart, viewMode, wStart, wEnd, selectedDate, today, zone])

  // 해당 월 1일로 이동한다(31일에서 월을 넘기면 다음다음 달로 넘어가던 문제 방지)
  function prevMonth() { setViewDate(zDate(vp.year, vp.month - 1, 1)) }
  function nextMonth() { setViewDate(zDate(vp.year, vp.month + 1, 1)) }

  function ariaFor(c: Cell) {
    return `${zp(c.date).month + 1}/${zp(c.date).date}${c.today ? ` ${t('common.today')}` : ''}`
  }

  const navBtn = "relative grid h-7 w-7 place-items-center rounded-sm hover:bg-accent hover:text-foreground after:absolute after:-inset-1.5 after:content-[''] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"

  return (
    <div className="select-none">
      <div className="flex items-center justify-between px-1 pb-1.5 text-[13px] font-semibold text-foreground">
        <span>{monthLabel}</span>
        <span className="flex gap-0.5 text-muted-foreground">
          <button type="button" className={navBtn} aria-label={t('calendar.nav.prevMonth')} onClick={prevMonth}><UiIcon name="chevron-left" className="h-4 w-4" /></button>
          <button type="button" className={navBtn} aria-label={t('calendar.nav.nextMonth')} onClick={nextMonth}><UiIcon name="chevron-right" className="h-4 w-4" /></button>
        </span>
      </div>
      <div className="grid grid-cols-7 gap-y-0.5 text-center font-mono text-[11px]">
        {DAY_LABELS.map(label => (
          <span key={label} className="h-6 font-sans leading-6 text-muted-foreground">{label}</span>
        ))}
        {cells.map(c => (
          <button
            key={c.date.getTime()}
            type="button"
            aria-label={ariaFor(c)}
            aria-current={c.today ? 'date' : undefined}
            className={cn(
              'grid h-7 place-items-center transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              c.today ? 'rounded-full bg-primary font-bold text-primary-foreground'
                : c.inWeek || c.selected ? 'bg-primary/[0.13] text-foreground'
                  : c.inMonth ? 'text-foreground hover:bg-accent/60' : 'text-muted-foreground/60 hover:bg-accent/40',
            )}
            onClick={() => onSelect?.(c.date)}
          >{zp(c.date).date}</button>
        ))}
      </div>
    </div>
  )
}

export default CalendarMiniMonth
