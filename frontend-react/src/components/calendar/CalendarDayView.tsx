/** 일 보기(Vue components/calendar/CalendarDayView.vue) = 주 보기와 같은 그리드(시안 캘3)를 하루 열로. */
import { CalendarWeekView } from './CalendarWeekView'

/** 일 보기 */
export function CalendarDayView() {
  return <CalendarWeekView days={1} />
}

export default CalendarDayView
