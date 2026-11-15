/**
 * 모바일 월 보기 날짜 시트: 페이지 아래에 붙는 372 시트, 핸들 36×4,
 * 머리 "10월 15일 목요일 오늘" 17/600 + [+ 새 일정] 36, 행은 CalendarAgendaRow. 빈 날은 "일정 없음 + 새 일정".
 * 탭바는 그대로(목록 화면이라 숨기지 않음).
 */
import { useI18n } from '~/i18n'
import { useCalendar } from '~/composables/useCalendar'
import { isSameDay } from '~/utils/calendarLayout'
import { zAtTime, zNow, zp } from '~/utils/calTz'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { CalendarAgendaRow } from './CalendarAgendaRow'

/** 모바일 월 보기 날짜 시트(sheetDate 가 있을 때 페이지가 그린다) */
export function CalendarDaySheet() {
  const { t, tm, rt } = useI18n()
  const { sheetDate, eventsOnDay, openPopover, openCreateModal, closeDaySheet } = useCalendar()

  const FULL = (tm('calendar.weekdaysFull') as any[]).map(m => rt(m))
  const date = sheetDate as Date
  const isToday = isSameDay(date, zNow())
  const dp = zp(date)
  const label = t('calendar.sheet.title', { m: dp.month + 1, d: dp.date, w: FULL[dp.day] })
  const list = eventsOnDay(date)

  function create() {
    openCreateModal(zAtTime(date, 9))
  }

  return (
    <div
      role="dialog"
      aria-label={label}
      className="absolute inset-x-0 bottom-0 z-drawer flex h-[372px] max-h-[70%] flex-col rounded-t-sheet border-t border-border bg-card shadow-lg animate-slide-up"
    >
      <button
        type="button"
        className="mx-auto mb-1.5 mt-2.5 grid h-4 w-16 shrink-0 place-items-center"
        aria-label={t('calendar.sheet.close')}
        onClick={closeDaySheet}
      >
        <span className="block h-1 w-9 rounded-full bg-muted" />
      </button>
      <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-1">
        <span className="min-w-0 flex-1 truncate text-[17px] font-semibold text-foreground">
          {label}
          {isToday && <>{' '}<span className="text-[13px] font-medium text-primary">{t('common.today')}</span></>}
        </span>
        <UiButton size="sm" className="h-9 gap-1 px-3 text-[13px] font-semibold" onClick={create}>
          <UiIcon name="plus" className="h-3.5 w-3.5" strokeWidth={2.6} />{t('calendar.event.newButton')}
        </UiButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">
        {list.length === 0 && (
          <UiEmptyState
            variant="panel"
            icon="calendar"
            title={t('calendar.agenda.empty')}
            actionLabel={t('calendar.event.newButton')}
            onAction={create}
          />
        )}
        {list.map(e => (
          <CalendarAgendaRow key={e.id} event={e} onClick={(ev, el) => openPopover(ev, el)} />
        ))}
      </div>
    </div>
  )
}

export default CalendarDaySheet
