/**
 * 관리 개요 › 상위 IP 가로 막대. 색 primary, 높이 240.
 */
import { useMemo } from 'react'
import { Bar } from 'react-chartjs-2'
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip } from 'chart.js'
import { useI18n } from '~/i18n'
import { useChartTokens } from '~/composables/useChartTokens'
import { UiEmptyState } from '~/components/ui/EmptyState'
import type { TopIP } from '~/composables/useAdminAnalytics'

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip)

export interface AdminAnalyticsTopIPsProps {
  /** GET /api/admin/analytics/top-ips 결과 */
  data: TopIP[]
}

export function AdminAnalyticsTopIPs({ data }: AdminAnalyticsTopIPsProps) {
  const { t } = useI18n()
  // 색 = CSS 변수 주입 — hex 하드코딩 제거
  const { tokens } = useChartTokens()

  const chartData = useMemo(() => ({
    labels: data.map(d => d.ip_address),
    datasets: [{
      data: data.map(d => d.count),
      backgroundColor: tokens.primary,
      borderRadius: 4,
    }],
  }), [data, tokens])

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    indexAxis: 'y' as const,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: tokens.axis }, grid: { color: tokens.grid }, beginAtZero: true },
      y: { ticks: { color: tokens.axis }, grid: { display: false } },
    },
  }), [tokens])

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h3 className="text-[13px] font-semibold text-foreground mb-3">{t('admin.analytics.topIPs.title')}</h3>
      <div className="h-[240px]">
        {data.length
          ? <Bar data={chartData} options={chartOptions} />
          : <UiEmptyState variant="panel" icon="activity" title={t('common.noData')} />}
      </div>
    </div>
  )
}

export default AdminAnalyticsTopIPs
