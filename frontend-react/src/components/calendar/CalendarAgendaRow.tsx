/**
 * 일정 목록 행(Vue components/calendar/CalendarAgendaRow.vue):
 * 56, 시각 열 48 mono 12(시작 600 / 끝 muted), 색 바 3, 제목 15/600, 메타 12 muted.
 */
import { useI18n } from '~/i18n'
import { useCalendar, type CalendarEvent } from '~/composables/useCalendar'
import { eventBar, fmtTime } from '~/utils/calendarLayout'
import { UiIcon } from '~/components/ui/Icon'

export interface CalendarAgendaRowProps {
  event: CalendarEvent
  /** 행 클릭 — 일정과 행 요소(팝오버 기준) */
  onClick?: (event: CalendarEvent, el: HTMLElement) => void
}

/** 일정 목록·날짜 시트의 일정 행 */
export function CalendarAgendaRow({ event, onClick }: CalendarAgendaRowProps) {
  const { calendarName } = useCalendar()
  const { t } = useI18n()
  const start = new Date(event.start)
  const end = new Date(event.end)
  const meta = [event.is_invited ? t('calendar.popover.invited') : calendarName(event.calendar_id), event.location].filter(Boolean).join(' · ')

  return (
    <button
      type="button"
      className="flex min-h-14 w-full items-center gap-3 border-b border-border px-4 text-left transition-colors hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onClick={e => onClick?.(event, e.currentTarget)}
    >
      <span className="w-12 shrink-0 font-mono text-xs leading-[1.4]">
        {event.all_day
          ? <b className="font-semibold">{t('calendar.allDay')}</b>
          : (
            <>
              <b className="font-semibold text-foreground">{fmtTime(start)}</b><br />
              <span className="text-muted-foreground">{fmtTime(end)}</span>
            </>
          )}
      </span>
      <span className="my-2.5 w-[3px] self-stretch rounded-[2px]" style={{ background: eventBar(event.color) }} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold text-foreground">
          {(event.is_recurring || event.is_occurrence) && <UiIcon name="refresh" className="mr-1 inline h-3 w-3 align-[-1px] text-muted-foreground" />}{event.title}
        </span>
        {meta && <span className="block truncate text-xs text-muted-foreground">{meta}</span>}
      </span>
    </button>
  )
}

export default CalendarAgendaRow
