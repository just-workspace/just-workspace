/**
 * 일별 활동 막대 차트(시안 AdminPage overview) — Vue components/admin/AdminAnalyticsDailyChart.vue.
 * 카드 패딩 16/18, 제목 13/600 + 범례(10px 각진 칸 + 12) 오른쪽, 막대 2계열, 높이 220.
 * 색 = CSS 변수 주입(primary · success), 축 글자 muted-foreground, 격자 border(useChartTokens).
 * ★ 시안의 두 번째 계열 "메시지"는 분석 API 에 일별 메시지 수가 없어 "로그인 방문"(authenticated)으로 둔다(디자이너 확인 필요).
 */
import { useMemo } from 'react'
import { Bar } from 'react-chartjs-2'
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip } from 'chart.js'
import { useI18n } from '~/i18n'
import { useChartTokens } from '~/composables/useChartTokens'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEmptyState } from '~/components/ui/EmptyState'
import type { DailyVisit } from '~/composables/useAdminAnalytics'
import { mmddLabel } from './analyticsFormat'

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip)

export interface AdminAnalyticsDailyChartProps {
  /** 일별 방문(GET /api/admin/analytics/daily-visits) */
  data: DailyVisit[]
  /** 불러오는 중이면 스켈레톤 */
  loading?: boolean
}

export function AdminAnalyticsDailyChart({ data, loading }: AdminAnalyticsDailyChartProps) {
  const { t } = useI18n()
  const { tokens } = useChartTokens()

  const SERIES = useMemo(() => [
    { key: 'total' as const, label: t('adminParts.daily.visits'), color: tokens.primary, swatch: 'bg-primary' },
    { key: 'authenticated' as const, label: t('adminParts.daily.loginVisits'), color: tokens.success, swatch: 'bg-success' },
  ], [t, tokens])

  const chartData = useMemo(() => ({
    labels: data.map(d => mmddLabel(d.date)),
    datasets: SERIES.map(s => ({
      label: s.label,
      data: data.map(d => d[s.key]),
      backgroundColor: s.color,
      borderRadius: 2,
      maxBarThickness: 28,
    })),
  }), [data, SERIES])

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: tokens.axis, font: { family: 'JetBrains Mono', size: 10 } }, grid: { display: false }, border: { color: tokens.grid } },
      y: { ticks: { color: tokens.axis, font: { size: 11 } }, grid: { color: tokens.grid }, border: { display: false }, beginAtZero: true },
    },
  }), [tokens])

  return (
    <section className="rounded-lg border border-border bg-card px-[18px] py-4">
      <div className="mb-3 flex items-center gap-4">
        <h3 className="flex-1 text-[13px] font-semibold text-foreground">{t('adminParts.daily.title')}</h3>
        {SERIES.map(s => (
          <span key={s.key} className="flex items-center gap-1.5 text-xs text-foreground">
            <span className={`h-2.5 w-2.5 rounded-[3px] ${s.swatch}`} aria-hidden="true" />{s.label}
          </span>
        ))}
      </div>
      <div className="h-[220px]">
        {loading
          ? <UiSkeleton className="h-full w-full" />
          : data.length
            ? <Bar data={chartData} options={chartOptions} aria-label={t('adminParts.daily.chartLabel')} role="img" />
            : <UiEmptyState variant="panel" icon="activity" title={t('adminParts.daily.empty')} />}
      </div>
    </section>
  )
}

export default AdminAnalyticsDailyChart
