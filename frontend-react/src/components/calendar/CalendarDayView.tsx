/** 일 보기 = 주 보기와 동일한 그리드를 하루 열로 표시. */
import { CalendarWeekView } from './CalendarWeekView'

/** 일 보기 */
export function CalendarDayView() {
  return <CalendarWeekView days={1} />
}

export default CalendarDayView
