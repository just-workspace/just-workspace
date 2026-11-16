/**
 * 홈 대시보드 요약 — GET /api/dashboard/summary 1회 호출로 칩·운영 띠·카드 개수를 표시한다.
 * "오늘"은 캘린더 시간대(utils/calTz) 기준으로 전송한다(day_start/day_end).
 *
 * React: const { summary, loading, refresh } = useDashSummary()
 * 컴포넌트 외부: dashSummaryStore.getState().summary · refreshDashSummary() · todayRange()
 */
import { createStore, useStore } from 'zustand'
import { $fetch } from '~/lib/api'
import { zAddDays, zNow, zStartOfDay } from '~/utils/calTz'

export interface NextMeeting { id: string; title: string; start: string; end: string; join_url: string | null }
export interface ServiceIssue { name: string; status: 'down' | 'slow'; response_ms: number | null }
export interface DashSummary {
  unread_notifications: number
  mail_unread: number | null
  mentions_unread: number
  tasks_due_today: number
  tasks_overdue: number
  today_events: number
  next_meeting: NextMeeting | null
  admin: {
    services: { ok: number; total: number; issues: ServiceIssue[] }
    pending_users: number
    storage: { used: number; total: number } | null
  } | null
}

/** 캘린더 시간대의 오늘 [00:00, 다음 날 00:00) ISO */
export function todayRange(): { day_start: string; day_end: string } {
  const s = zStartOfDay(zNow())
  return { day_start: s.toISOString(), day_end: zAddDays(s, 1).toISOString() }
}

export const dashSummaryStore = createStore<{ summary: DashSummary | null; loading: boolean; error: boolean }>()(() => ({
  summary: null, loading: true, error: false,
}))

let inflight: Promise<void> | null = null
export function refreshDashSummary(): Promise<void> {
  if (inflight) return inflight
  dashSummaryStore.setState({ loading: true })
  inflight = (async () => {
    try {
      const s = await $fetch<DashSummary>('/api/dashboard/summary', { params: todayRange() })
      dashSummaryStore.setState({ summary: s, error: false })
    } catch {
      dashSummaryStore.setState({ error: true })
    } finally {
      dashSummaryStore.setState({ loading: false })
      inflight = null
    }
  })()
  return inflight
}

export function useDashSummary() {
  const summary = useStore(dashSummaryStore, s => s.summary)
  const loading = useStore(dashSummaryStore, s => s.loading)
  const error = useStore(dashSummaryStore, s => s.error)
  return { summary, loading, error, refresh: refreshDashSummary }
}
