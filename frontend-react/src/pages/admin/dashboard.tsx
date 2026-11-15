/**
 * 관리 › 개요 —
 * 헤더형 + 기간 세그먼트(24시간·7일·30일),
 * 운영 요약 4칸(승인 대기 · 마지막 백업 · SSL D-n · 서비스, 칸마다 바로 가는 행동) — GET /api/admin/ops-summary 한 번(useAdminOps)
 * → 일별 활동(1.6fr) + 서비스 상태(1fr) → 나머지 분석. 접근 로그는 시스템 › 접근 로그(/admin/logs)로 옮겼다.
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { navigateTo } from '~/lib/router'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useAuth } from '~/composables/useAuth'
import { useAdminAnalytics } from '~/composables/useAdminAnalytics'
import { useAdminOps } from '~/composables/useAdminOps'
import { useServices } from '~/composables/useServices'
import { AdminPageShell } from '~/components/admin/AdminPageShell'
import { AdminAnalyticsDailyChart } from '~/components/admin/AdminAnalyticsDailyChart'
import { AdminAnalyticsOverview } from '~/components/admin/AdminAnalyticsOverview'
import { AdminAnalyticsTopPages } from '~/components/admin/AdminAnalyticsTopPages'
import { AdminAnalyticsTopIPs } from '~/components/admin/AdminAnalyticsTopIPs'
import { AdminAnalyticsServiceUsage } from '~/components/admin/AdminAnalyticsServiceUsage'
import { AdminAnalyticsActiveUsers } from '~/components/admin/AdminAnalyticsActiveUsers'
import { AdminAnalyticsRecentLogins } from '~/components/admin/AdminAnalyticsRecentLogins'
import { AdminAnalyticsGitActivity } from '~/components/admin/AdminAnalyticsGitActivity'
import { buildOpsTiles, latencyWarnMsOf } from '~/components/admin/dashboardTiles'
import { AdminOpsTile } from '~/components/admin/AdminOpsTile'
import { AdminServiceStatusCard } from '~/components/admin/AdminServiceStatusCard'
import { UiSegment } from '~/components/ui/Segment'
import { UiSkeleton } from '~/components/ui/Skeleton'

const PERIODS = [
  { value: 'today', labelKey: 'admin.dashboard.period24h', days: 1 },
  { value: '7d', labelKey: 'admin.period.7d', days: 7 },
  { value: '30d', labelKey: 'admin.period.30d', days: 30 },
] as const
type Period = typeof PERIODS[number]['value']

export default function AdminDashboardPage() {
  const { t } = useI18n()
  const { appName, config } = useSiteConfig()
  useHead({ title: t('admin.common.headTitle', { page: t('admin.dashboard.pageTitle'), app: appName }) })

  const { user } = useAuth()
  useEffect(() => { if (user && !user.is_admin) void navigateTo('/') }, [user])

  const {
    overview, dailyVisits, topPages, topIPs, serviceUsage,
    activeUsers, recentLogins, gitActivity, gitStats,
    loading, fetchAll, fetchDailyVisits,
  } = useAdminAnalytics()

  const [period, setPeriod] = useState<Period>('7d')

  async function load(p: Period = period) {
    await fetchAll(p)
    // 일별 막대는 기간과 같은 일수로(24시간이면 최근 7일을 그대로 보여 준다)
    const days = PERIODS.find(x => x.value === p)?.days ?? 7
    await fetchDailyVisits(Math.max(days, 7))
  }
  function setPeriodModel(v: string | number | null) { const p = v as Period; setPeriod(p); void load(p) }

  // ── 운영 요약 ──
  const { ops, refresh } = useAdminOps()
  const { services, loading: svcLoading, fetchServices } = useServices()
  const latencyWarnMs = latencyWarnMsOf(config)
  const tiles = buildOpsTiles(ops, t)

  useEffect(() => {
    void load()
    void refresh()
    void fetchServices()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!user?.is_admin) return null

  return (
    <AdminPageShell
      title={t('admin.dashboard.pageTitle')}
      subtitle={t('admin.dashboard.pageSubtitle')}
      actions={<UiSegment modelValue={period} onUpdateModelValue={setPeriodModel} items={PERIODS.map(p => ({ value: p.value, label: t(p.labelKey) }))} ariaLabel={t('admin.dashboard.periodAria')} />}
    >
      {/* 운영 요약 4칸 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map(tile => <AdminOpsTile key={tile.key} tile={tile} />)}
      </div>

      {/* 일별 활동 + 서비스 상태 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
        <AdminAnalyticsDailyChart data={dailyVisits} loading={loading && !dailyVisits.length} />
        <AdminServiceStatusCard services={services} loading={svcLoading} latencyWarnMs={latencyWarnMs} />
      </div>

      {/* 나머지 분석(기존 카드 유지) */}
      {loading && !overview
        ? <UiSkeleton preset="card" rows={2} />
        : (
          <>
            <AdminAnalyticsOverview data={overview} />
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <AdminAnalyticsTopPages data={topPages} />
              <AdminAnalyticsTopIPs data={topIPs} />
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <AdminAnalyticsServiceUsage data={serviceUsage} />
              <AdminAnalyticsActiveUsers data={activeUsers} />
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <AdminAnalyticsRecentLogins data={recentLogins} />
              <AdminAnalyticsGitActivity activity={gitActivity} stats={gitStats} />
            </div>
          </>
        )}
    </AdminPageShell>
  )
}
