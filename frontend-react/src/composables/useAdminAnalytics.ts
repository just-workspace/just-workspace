/**
 * 관리 분석 데이터(GET /api/admin/analytics/*).
 * 싱글턴이 아니다 — 컴포넌트마다 따로인 지역 상태 hook.
 * 실패하면 빈 값(overview·gitStats·accessLogs = null, 목록 = []). 오류는 던지지 않는다.
 *
 * React: const { overview, dailyVisits, loading, fetchAll, fetchDailyVisits } = useAdminAnalytics()
 *   - 값은 렌더 시점 값. fetch 함수들은 렌더 사이에 같은 참조(useEffect deps 에 넣어도 됨).
 *   - fetchAccessLogs 는 받은 쪽을 돌려준다(상태는 다음 렌더에야 보이므로 반환값으로).
 */
import { useMemo, useState } from 'react'
import { $fetch } from '~/lib/api'

export interface AnalyticsOverview {
  total_visits: number
  unique_ips: number
  authenticated_visits: number
  unauthenticated_visits: number
  avg_response_time_ms: number
}

export interface DailyVisit {
  date: string
  total: number
  authenticated: number
  unauthenticated: number
}

export interface TopPage {
  path: string
  count: number
}

export interface TopIP {
  ip_address: string
  count: number
  paths: number
}

export interface ServiceUsage {
  service: string
  count: number
}

export interface ActiveUser {
  user_id: string
  username: string
  display_name: string | null
  path: string
  ip_address: string
  last_seen: string
}

export interface RecentLogin {
  user_id: string
  username: string
  display_name: string | null
  ip_address: string
  login_at: string
}

export interface AccessLogEntry {
  id: string
  ip_address: string
  method: string
  path: string
  status_code: number
  response_time_ms: number
  browser: string | null
  os: string | null
  device: string | null
  user_id: string | null
  username: string | null
  service: string | null
  created_at: string
}

export interface AccessLogPage {
  logs: AccessLogEntry[]
  total: number
  page: number
  limit: number
}

export interface GitActivityItem {
  repo_name: string
  repo_full_name: string
  event_type: string
  title: string
  user: string
  created_at: string
}

export interface GitStats {
  total_repos: number
  total_users: number
  total_issues: number
  total_pulls: number
}

/** 기간 → 일별 막대 일수(fetchAll 규칙: 30d=30 · 7d=7 · 그 밖=1) */
export function periodDays(period: string): number {
  return period === '30d' ? 30 : period === '7d' ? 7 : 1
}

export function useAdminAnalytics() {
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null)
  const [dailyVisits, setDailyVisits] = useState<DailyVisit[]>([])
  const [topPages, setTopPages] = useState<TopPage[]>([])
  const [topIPs, setTopIPs] = useState<TopIP[]>([])
  const [serviceUsage, setServiceUsage] = useState<ServiceUsage[]>([])
  const [activeUsers, setActiveUsers] = useState<ActiveUser[]>([])
  const [recentLogins, setRecentLogins] = useState<RecentLogin[]>([])
  const [accessLogs, setAccessLogs] = useState<AccessLogPage | null>(null)
  const [gitActivity, setGitActivity] = useState<GitActivityItem[]>([])
  const [gitStats, setGitStats] = useState<GitStats | null>(null)
  const [loading, setLoading] = useState(false)

  // setter 는 안정적 → 함수 묶음도 한 번만 만든다
  const fns = useMemo(() => {
    async function fetchOverview(period = 'today') {
      try { setOverview(await $fetch<AnalyticsOverview>('/api/admin/analytics/overview', { params: { period } })) }
      catch { setOverview(null) }
    }
    async function fetchDailyVisits(days = 30) {
      try { setDailyVisits(await $fetch<DailyVisit[]>('/api/admin/analytics/daily-visits', { params: { days } })) }
      catch { setDailyVisits([]) }
    }
    async function fetchTopPages(period = 'today', limit = 10) {
      try { setTopPages(await $fetch<TopPage[]>('/api/admin/analytics/top-pages', { params: { period, limit } })) }
      catch { setTopPages([]) }
    }
    async function fetchTopIPs(period = 'today', limit = 15) {
      try { setTopIPs(await $fetch<TopIP[]>('/api/admin/analytics/top-ips', { params: { period, limit } })) }
      catch { setTopIPs([]) }
    }
    async function fetchServiceUsage(period = 'today') {
      try { setServiceUsage(await $fetch<ServiceUsage[]>('/api/admin/analytics/service-usage', { params: { period } })) }
      catch { setServiceUsage([]) }
    }
    async function fetchActiveUsers() {
      try { setActiveUsers(await $fetch<ActiveUser[]>('/api/admin/analytics/active-users')) }
      catch { setActiveUsers([]) }
    }
    async function fetchRecentLogins(limit = 20) {
      try { setRecentLogins(await $fetch<RecentLogin[]>('/api/admin/analytics/recent-logins', { params: { limit } })) }
      catch { setRecentLogins([]) }
    }
    async function fetchAccessLogs(page = 1, limit = 50, service?: string, userId?: string): Promise<AccessLogPage | null> {
      try {
        const params: Record<string, string | number> = { page, limit }
        if (service) params.service = service
        if (userId) params.user_id = userId
        const r = await $fetch<AccessLogPage>('/api/admin/analytics/access-logs', { params })
        setAccessLogs(r)
        return r
      } catch { setAccessLogs(null); return null }
    }
    async function fetchGitActivity() {
      try { setGitActivity(await $fetch<GitActivityItem[]>('/api/admin/analytics/git-activity')) }
      catch { setGitActivity([]) }
    }
    async function fetchGitStats() {
      try { setGitStats(await $fetch<GitStats>('/api/admin/analytics/git-stats')) }
      catch { setGitStats(null) }
    }
    async function fetchAll(period = 'today') {
      setLoading(true)
      const days = periodDays(period)
      await Promise.all([
        fetchOverview(period),
        fetchDailyVisits(days),
        fetchTopPages(period),
        fetchTopIPs(period),
        fetchServiceUsage(period),
        fetchActiveUsers(),
        fetchRecentLogins(),
        fetchGitActivity(),
        fetchGitStats(),
      ])
      setLoading(false)
    }
    return {
      fetchOverview, fetchDailyVisits, fetchTopPages, fetchTopIPs,
      fetchServiceUsage, fetchActiveUsers, fetchRecentLogins,
      fetchAccessLogs, fetchAll, fetchGitActivity, fetchGitStats,
    }
  }, [])

  return {
    overview, dailyVisits, topPages, topIPs, serviceUsage,
    activeUsers, recentLogins, accessLogs, gitActivity, gitStats,
    loading,
    ...fns,
  }
}
