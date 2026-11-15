/**
 * 관리 개요 › 서비스별 사용 도넛.
 * 범주 색 = --cat-1…8 순서(useChartTokens.category), 범례 오른쪽. 높이 240.
 */
import { useMemo } from 'react'
import { Doughnut } from 'react-chartjs-2'
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js'
import { useI18n } from '~/i18n'
import { useChartTokens } from '~/composables/useChartTokens'
import { UiEmptyState } from '~/components/ui/EmptyState'
import type { ServiceUsage } from '~/composables/useAdminAnalytics'

ChartJS.register(ArcElement, Tooltip, Legend)

export interface AdminAnalyticsServiceUsageProps {
  /** GET /api/admin/analytics/service-usage 결과 */
  data: ServiceUsage[]
}

export function AdminAnalyticsServiceUsage({ data }: AdminAnalyticsServiceUsageProps) {
  const { t } = useI18n()
  // 색 = CSS 변수 주입 — hex 하드코딩 제거
  const { tokens } = useChartTokens()

  const SERVICE_LABELS = useMemo<Record<string, string>>(() => ({
    mail: t('admin.analytics.services.mail'), calendar: t('admin.analytics.services.calendar'), contacts: t('admin.analytics.services.contacts'), files: t('admin.analytics.services.files'),
    meetings: t('admin.analytics.services.meetings'), git: 'Git', lab: 'Lab', dashboard: t('admin.analytics.services.dashboard'),
    admin: t('admin.analytics.services.admin'), auth: t('admin.analytics.services.auth'), services: t('admin.analytics.services.services'),
  }), [t])

  const chartData = useMemo(() => ({
    labels: data.map(d => SERVICE_LABELS[d.service] || d.service),
    datasets: [{
      data: data.map(d => d.count),
      backgroundColor: data.map((_, i) => tokens.category[i % tokens.category.length]),
      borderWidth: 0,
    }],
  }), [data, SERVICE_LABELS, tokens])

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'right' as const,
        labels: {
          color: tokens.axis,
          usePointStyle: true,
          pointStyleWidth: 10,
          padding: 12,
        },
      },
    },
  }), [tokens])

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h3 className="text-[13px] font-semibold text-foreground mb-3">{t('admin.analytics.serviceUsage.title')}</h3>
      <div className="h-[240px]">
        {data.length
          ? <Doughnut data={chartData} options={chartOptions} />
          : <UiEmptyState variant="panel" icon="activity" title={t('common.noData')} />}
      </div>
    </div>
  )
}

export default AdminAnalyticsServiceUsage
