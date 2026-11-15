/**
 * 관리 개요 › 분석 요약 4칸 — Vue components/admin/AdminAnalyticsOverview.vue.
 * 총 방문 · 고유 방문자 · 로그인 방문 · 평균 응답(ms). data 가 null 이면 아무 칸도 그리지 않는다(빈 격자).
 */
import { useI18n } from '~/i18n'
import type { AnalyticsOverview } from '~/composables/useAdminAnalytics'

export interface AdminAnalyticsOverviewProps {
  /** GET /api/admin/analytics/overview 결과(실패 null) */
  data: AnalyticsOverview | null
}

export function AdminAnalyticsOverview({ data }: AdminAnalyticsOverviewProps) {
  const { t } = useI18n()
  const stats = !data ? [] : [
    { label: t('admin.analytics.overview.totalVisits'), value: data.total_visits.toLocaleString() },
    { label: t('admin.analytics.overview.uniqueVisitors'), value: data.unique_ips.toLocaleString() },
    { label: t('admin.analytics.overview.authenticatedVisits'), value: data.authenticated_visits.toLocaleString() },
    { label: t('admin.analytics.overview.avgResponseTime'), value: `${data.avg_response_time_ms}ms` },
  ]
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {stats.map(s => (
        <div key={s.label} className="rounded-lg border border-border bg-card p-5">
          <div className="text-[13px] text-muted-foreground">{s.label}</div>
          <div className="mt-1 font-mono text-2xl font-bold text-foreground">{s.value}</div>
        </div>
      ))}
    </div>
  )
}

export default AdminAnalyticsOverview
