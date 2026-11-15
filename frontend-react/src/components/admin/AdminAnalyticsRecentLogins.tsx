/**
 * 관리 개요 › 최근 로그인 카드.
 * 최근 10건: 이름 · 가린 IP(a.b.x.x) · 상대 시각.
 */
import { useI18n } from '~/i18n'
import { UiEmptyState } from '~/components/ui/EmptyState'
import type { RecentLogin } from '~/composables/useAdminAnalytics'
import { analyticsTimeAgo, maskIp } from './analyticsFormat'

export interface AdminAnalyticsRecentLoginsProps {
  /** GET /api/admin/analytics/recent-logins 결과(앞 10건만 그림) */
  data: RecentLogin[]
}

export function AdminAnalyticsRecentLogins({ data }: AdminAnalyticsRecentLoginsProps) {
  const { t } = useI18n()
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h3 className="text-[13px] font-semibold text-foreground mb-3">{t('admin.analytics.recentLogins.title')}</h3>
      {data.length === 0
        ? <UiEmptyState variant="panel" icon="inbox" title={t('admin.analytics.recentLogins.empty')} />
        : (
          <div className="space-y-2">
            {data.slice(0, 10).map((l, i) => (
              <div key={i} className="flex items-center justify-between text-sm py-1.5 border-b border-border last:border-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium truncate">{l.display_name || l.username}</span>
                  <span className="text-muted-foreground text-xs">{maskIp(l.ip_address)}</span>
                </div>
                <span className="text-xs text-muted-foreground shrink-0 ml-2">{analyticsTimeAgo(l.login_at, t)}</span>
              </div>
            ))}
          </div>
        )}
    </div>
  )
}

export default AdminAnalyticsRecentLogins
