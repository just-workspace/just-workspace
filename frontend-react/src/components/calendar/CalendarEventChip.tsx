/**
 * 일정 칩(Vue components/calendar/CalendarEventChip.vue · 월 보기·종일 줄):
 * 배경 범주 색/0.2 + 왼쪽 3px 색 바(빗금 대상이면 bg-cat-hatch) + rounded 6, 제목 12/600, 시각 mono 10.5.
 * 클릭 = 읽기 팝오버(앵커 요소를 함께 올림), 더블클릭 = 편집(시안 캘1).
 */
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import type { CalendarEvent } from '~/composables/useCalendar'
import { eventBg, eventBar, fmtTime } from '~/utils/calendarLayout'
import { UiIcon } from '~/components/ui/Icon'

export interface CalendarEventChipProps {
  event: CalendarEvent
  /** 팝오버가 열린 일정이면 ring */
  selected?: boolean
  /** 시각 숨김(종일 줄 등) */
  noTime?: boolean
  /** 클릭 — 일정과 칩 요소(팝오버 기준) */
  onClick?: (event: CalendarEvent, el: HTMLElement) => void
  /** 더블클릭 = 편집 */
  onEdit?: (event: CalendarEvent) => void
}

/** 월 보기·종일 줄의 일정 칩 */
export function CalendarEventChip({ event, selected, noTime, onClick, onEdit }: CalendarEventChipProps) {
  const { t } = useI18n()
  let timeLabel: string
  if (event.all_day) timeLabel = t('calendar.allDay')
  else { try { timeLabel = fmtTime(new Date(event.start)) } catch { timeLabel = '' } }

  return (
    <button
      type="button"
      className={cn(
        'relative flex h-[22px] w-full items-center gap-1 overflow-hidden rounded-[6px] px-1.5 pl-2.5 text-left transition-opacity hover:opacity-85 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
        selected ? 'ring-2 ring-ring' : '',
        event.hatched ? 'bg-cat-hatch' : '',
      )}
      style={{ backgroundColor: eventBg(event.color), boxShadow: `inset 3px 0 0 ${eventBar(event.color)}` }}
      title={event.title}
      onClick={(e) => { e.stopPropagation(); onClick?.(event, e.currentTarget) }}
      onDoubleClick={(e) => { e.stopPropagation(); onEdit?.(event) }}
    >
      {!event.all_day && !noTime && <span className="shrink-0 font-mono text-[10.5px] text-foreground/75">{timeLabel}</span>}
      {(event.is_recurring || event.is_occurrence) && <UiIcon name="refresh" className="h-3 w-3 shrink-0 text-foreground/75" />}
      <span className="truncate text-xs font-semibold text-foreground">{event.title}</span>
    </button>
  )
}

export default CalendarEventChip
