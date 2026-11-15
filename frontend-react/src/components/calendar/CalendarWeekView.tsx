/**
 * 주·일 보기(Vue components/calendar/CalendarWeekView.vue · 시안 CL1·캘3): 시간 열 56, 1시간 48,
 * 일정은 시작·길이 기준 절대 배치 + 겹침 열, 현재 시각 선(danger 2px + 점 10) + 시간 열 배지, 종일 줄은 날짜를 가로질러 span.
 * 날짜·시각은 전부 캘린더 시간대(utils/calTz) 벽시계 — 서머타임 날도 칸 위치는 벽시계 분, 종일은 날짜 그대로.
 * days=7 이면 주, days=1 이면 일. 빈 칸 클릭 = 그 시각에 새 일정, 일정 클릭 = 읽기 팝오버, 더블클릭 = 편집.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useCalendar, type CalendarEvent } from '~/composables/useCalendar'
import {
  startOfWeek, startOfDay, addDays, isSameDay, layoutOverlaps, eventBg, eventBar, fmtTime, gmtLabel,
} from '~/utils/calendarLayout'
import { calendarZone, eventRange, zAtTime, zDayNumber, zMinutesOfDay, zNow, zp } from '~/utils/calTz'
import { UiIcon } from '~/components/ui/Icon'
import { CalendarEventChip } from './CalendarEventChip'
import { getUiZoom } from '~/composables/useViewport'

const HOUR_PX = 48
const HOURS = Array.from({ length: 24 }, (_, i) => i)

export interface CalendarWeekViewProps {
  /** 7 = 주 보기(기본) · 1 = 일 보기 */
  days?: 1 | 7
}

interface Lane { ev: CalendarEvent; col: number; span: number; row: number }
interface Block { ev: CalendarEvent; top: number; height: number; left: string; width: string; time: string }

function spansDays(ev: { start: string; end: string; all_day: boolean }) {
  if (ev.all_day) return true
  const s = new Date(ev.start), e = new Date(ev.end)
  // 날짜가 바뀌고 벽시계로 하루 이상(서머타임 날 23·25시간도 "하루")
  return !isSameDay(s, new Date(e.getTime() - 1)) && e.getTime() >= addDays(s, 1).getTime()
}

/** 범위 첫날부터 몇째 날 칸인가(캘린더 시간대 날짜 차이) — 끝(배타)이 자정이면 그 앞날까지 */
function dayCol(rangeStart: Date, at: number, exclusiveEnd = false): number {
  const n = zDayNumber(at) - zDayNumber(rangeStart)
  return exclusiveEnd && zMinutesOfDay(at) === 0 && zp(at).seconds === 0 ? n : n + (exclusiveEnd ? 1 : 0)
}

function hourLabel(h: number) { return h === 0 ? '' : `${String(h).padStart(2, '0')}:00` }

/** 주·일 보기 시간 그리드 */
export function CalendarWeekView({ days = 7 }: CalendarWeekViewProps) {
  const { t, tm, rt } = useI18n()
  const {
    selectedDate, visibleEvents, weekStart, popoverEvent,
    openCreateModal, openEditModal, openPopover, popoverJustClosed,
  } = useCalendar()

  const DAY_LABELS = (tm('calendar.weekdaysShort') as any[]).map(m => rt(m))

  // 캘린더 시간대가 바뀌면 칸을 다시 계산한다
  const zone = calendarZone()
  const dayList = useMemo((): Date[] => {
    if (days === 1) return [startOfDay(selectedDate)]
    const start = startOfWeek(selectedDate, weekStart)
    return Array.from({ length: 7 }, (_, i) => addDays(start, i))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zone
  }, [days, selectedDate, weekStart, zone])

  const rangeStart = dayList[0]
  const rangeEnd = addDays(dayList[dayList.length - 1], 1)

  const gridCols = `56px repeat(${days}, minmax(0, 1fr))`

  // ── 현재 시각 ──
  const [now, setNow] = useState(() => zNow())
  useEffect(() => {
    const timer = setInterval(() => { setNow(zNow()) }, 60_000)
    return () => clearInterval(timer)
  }, [])

  const nowTop = zMinutesOfDay(now) / 60 * HOUR_PX
  const todayIndex = dayList.findIndex(d => isSameDay(d, now))
  const isToday = (d: Date) => isSameDay(d, now)

  // ── 종일·여러 날 일정: 날짜를 가로지르는 줄(lane) ──
  const rs = rangeStart.getTime(), re = rangeEnd.getTime()
  const allDayLanes = useMemo((): Lane[] => {
    const n = days
    const items = visibleEvents
      .filter(ev => spansDays(ev))
      .map(ev => {
        const r = eventRange(ev)
        return { ev, s: r.start.getTime(), e: r.end.getTime() }
      })
      .filter(x => x.s < re && x.e > rs)
      .sort((a, b) => a.s - b.s || b.e - a.e)
    const rowEnds: number[] = [] // 각 줄에서 마지막으로 차지한 열(exclusive)
    const out: Lane[] = []
    const first = new Date(rs)
    for (const x of items) {
      const col = Math.max(0, dayCol(first, Math.max(x.s, rs)))
      const endCol = Math.min(n, dayCol(first, Math.min(x.e, re), true))
      const span = Math.max(1, endCol - col)
      let row = rowEnds.findIndex(e => e <= col)
      if (row === -1) { row = rowEnds.length; rowEnds.push(col + span) } else rowEnds[row] = col + span
      out.push({ ev: x.ev, col, span, row })
    }
    return out
  }, [visibleEvents, days, rs, re])

  // ── 시간 일정: 날마다 절대 배치 ──
  const blocksByDay = useMemo((): Block[][] => {
    return dayList.map((day) => {
      // 그날 [00:00, 다음날 00:00) — 서머타임 날은 23·25시간. 칸 위치는 벽시계 분으로(02:00 이 빠진 날도 03:00 은 03:00 줄)
      const ds = startOfDay(day).getTime(), de = addDays(startOfDay(day), 1).getTime()
      const evs = visibleEvents
        .filter(ev => !spansDays(ev))
        .map(ev => ({ ev, s: new Date(ev.start).getTime(), e: new Date(ev.end).getTime() }))
        .filter(x => x.s < de && x.e > ds)
      const boxes = layoutOverlaps(evs.map(x => ({ id: x.ev.id, start: Math.max(x.s, ds), end: Math.min(x.e, de) })))
      const byId = new Map(boxes.map(b => [b.id, b]))
      const wallMin = (ms: number, isEnd: boolean) => (isEnd && ms >= de ? 24 * 60 : ms <= ds ? 0 : zMinutesOfDay(ms))
      return evs.map((x) => {
        const b = byId.get(x.ev.id)!
        const m0 = wallMin(x.s, false), m1 = Math.max(m0, wallMin(x.e, true))
        const top = m0 / 60 * HOUR_PX + 1
        const height = Math.max(20, (m1 - m0) / 60 * HOUR_PX - 3)
        const left = `calc(${b.col * 100 / b.cols}% + 2px)`
        const width = `calc(${100 / b.cols}% - 4px)`
        return { ev: x.ev, top, height, left, width, time: `${fmtTime(new Date(x.s))}–${fmtTime(new Date(x.e))}` }
      })
    })
  }, [dayList, visibleEvents])

  function onColumnClick(day: Date, e: MouseEvent<HTMLDivElement>) {
    if (popoverJustClosed()) return
    const rect = e.currentTarget.getBoundingClientRect()
    const hour = Math.max(0, Math.min(23, Math.floor((e.clientY - rect.top) / (HOUR_PX * getUiZoom()))))
    openCreateModal(zAtTime(day, hour))
  }

  function onBlockClick(ev: CalendarEvent, e: MouseEvent<HTMLButtonElement>) {
    openPopover(ev, e.currentTarget)
  }

  // 처음 열면 현재 시각(오늘이 보일 때) 또는 07:00 으로 스크롤 — 마운트·days 변경 때만(Vue onMounted + watch(days))
  const scroller = useRef<HTMLDivElement | null>(null)
  const todayIdxRef = useRef(todayIndex)
  todayIdxRef.current = todayIndex
  useEffect(() => {
    const h = todayIdxRef.current >= 0 ? Math.max(0, zp(zNow()).hours - 1) : 7
    if (scroller.current) scroller.current.scrollTop = h * HOUR_PX
  }, [days])

  const gmt = gmtLabel(now)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 요일 머리 48 */}
      <div className="grid shrink-0 border-b border-border" style={{ gridTemplateColumns: gridCols }}>
        <div className="pl-2 pt-2 font-mono text-[10px] text-muted-foreground">{gmt}</div>
        {dayList.map((day, i) => (
          <div key={i} className="flex h-12 items-center gap-1.5 border-l border-border px-2.5">
            <span className={cn('text-xs', isToday(day) ? 'font-semibold text-primary' : 'text-muted-foreground')}>{DAY_LABELS[zp(day).day]}</span>
            <span
              className={cn('grid h-7 w-7 place-items-center rounded-full font-mono text-[13px]', isToday(day) ? 'bg-primary font-bold text-primary-foreground' : 'font-semibold text-foreground')}
              aria-current={isToday(day) ? 'date' : undefined}
            >{zp(day).date}</span>
          </div>
        ))}
      </div>

      {/* 종일 줄 */}
      <div className="grid min-h-[30px] shrink-0 border-b border-border" style={{ gridTemplateColumns: gridCols }}>
        <div className="pl-2 pt-2 text-[10px] text-muted-foreground">{t('calendar.allDay')}</div>
        <div
          className="relative grid gap-y-0.5 py-1"
          style={{ gridColumn: `2 / span ${days}`, gridTemplateColumns: `repeat(${days}, minmax(0, 1fr))` }}
        >
          {allDayLanes.map(lane => (
            <div
              key={lane.ev.id}
              className="min-w-0 px-1"
              style={{ gridColumn: `${lane.col + 1} / span ${lane.span}`, gridRow: lane.row + 1 }}
            >
              <CalendarEventChip
                event={lane.ev}
                selected={popoverEvent?.id === lane.ev.id}
                noTime
                onClick={(ev, el) => openPopover(ev, el)}
                onEdit={openEditModal}
              />
            </div>
          ))}
        </div>
      </div>

      {/* 시간 그리드 */}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="relative grid" style={{ gridTemplateColumns: gridCols, height: `${24 * HOUR_PX}px` }}>
          {/* 시간 열 */}
          <div className="relative">
            {/* 맨 위(0시) 라벨은 위로 올리지 않는다(종일 줄 밑으로 잘림), 현재 시각 라벨과 겹치는 시 라벨은 숨긴다 */}
            {HOURS.map(h => (
              <div
                key={h}
                className={cn(
                  'pr-2 text-right font-mono text-[10px] text-muted-foreground',
                  h === 0 ? '' : '-translate-y-1.5',
                  todayIndex >= 0 && Math.abs(nowTop - h * HOUR_PX) < 12 ? 'invisible' : '',
                )}
                style={{ height: `${HOUR_PX}px` }}
              >{hourLabel(h)}</div>
            ))}
            {todayIndex >= 0 && (
              <span
                className="absolute right-1 -translate-y-1/2 rounded-[4px] bg-danger px-1 py-px font-mono text-[10px] font-bold text-background"
                style={{ top: `${nowTop}px` }}
                aria-hidden="true"
              >{fmtTime(now)}</span>
            )}
          </div>

          {/* 날짜 열 */}
          {dayList.map((day, di) => (
            <div
              key={di}
              className="relative cursor-pointer border-l border-border"
              style={{ background: `repeating-linear-gradient(to bottom, transparent 0 ${HOUR_PX - 1}px, hsl(var(--border)) ${HOUR_PX - 1}px ${HOUR_PX}px)` }}
              onClick={e => onColumnClick(day, e)}
            >
              {blocksByDay[di].map(b => (
                <button
                  key={b.ev.id}
                  type="button"
                  className={cn(
                    'absolute box-border overflow-hidden rounded-[6px] px-2 py-1 text-left leading-[1.3] transition-opacity hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                    popoverEvent?.id === b.ev.id ? 'ring-2 ring-ring' : '',
                    b.ev.hatched ? 'bg-cat-hatch' : '',
                  )}
                  style={{
                    top: `${b.top}px`, height: `${b.height}px`, left: b.left, width: b.width,
                    backgroundColor: eventBg(b.ev.color), boxShadow: `inset 3px 0 0 ${eventBar(b.ev.color)}`,
                  }}
                  title={`${b.ev.title} · ${b.time}`}
                  onClick={(e) => { e.stopPropagation(); onBlockClick(b.ev, e) }}
                  onDoubleClick={(e) => { e.stopPropagation(); openEditModal(b.ev) }}
                >
                  <div className="truncate text-xs font-semibold text-foreground">
                    {(b.ev.is_recurring || b.ev.is_occurrence) && <UiIcon name="refresh" className="mr-0.5 inline h-3 w-3 align-[-2px] text-foreground/75" />}{b.ev.title}
                  </div>
                  <div className="font-mono text-[10.5px] text-foreground/75">{b.time}</div>
                </button>
              ))}

              {/* 현재 시각 선 */}
              {di === todayIndex && (
                <div
                  className="pointer-events-none absolute -left-px right-0 h-0.5 bg-danger"
                  style={{ top: `${nowTop}px` }}
                  aria-hidden="true"
                >
                  <span className="absolute -left-1 -top-1 h-2.5 w-2.5 rounded-full bg-danger" />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default CalendarWeekView
