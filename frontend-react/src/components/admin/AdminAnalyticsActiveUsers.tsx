/**
 * 관리 개요 › 지금 활동 중인 사용자 카드 — Vue components/admin/AdminAnalyticsActiveUsers.vue.
 * 이름(표시 이름 없으면 사용자명) · 보고 있는 경로 · 마지막 활동(방금/n분 전). 비면 빈 상태.
 */
import { useI18n } from '~/i18n'
import { UiEmptyState } from '~/components/ui/EmptyState'
import type { ActiveUser } from '~/composables/useAdminAnalytics'
import { analyticsTimeAgo } from './analyticsFormat'

export interface AdminAnalyticsActiveUsersProps {
  /** GET /api/admin/analytics/active-users 결과 */
  data: ActiveUser[]
}

export function AdminAnalyticsActiveUsers({ data }: AdminAnalyticsActiveUsersProps) {
  const { t } = useI18n()
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h3 className="text-[13px] font-semibold text-foreground mb-3">{t('admin.analytics.activeUsers.title')}</h3>
      {data.length === 0
        ? <UiEmptyState variant="panel" icon="inbox" title={t('admin.analytics.activeUsers.empty')} />
        : (
          <div className="space-y-2">
            {data.map(u => (
              <div key={u.user_id} className="flex items-center justify-between text-sm py-1.5 border-b border-border last:border-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium truncate">{u.display_name || u.username}</span>
                  <span className="text-muted-foreground truncate">{u.path}</span>
                </div>
                <span className="text-xs text-muted-foreground shrink-0 ml-2">{analyticsTimeAgo(u.last_seen, t, true)}</span>
              </div>
            ))}
          </div>
        )}
    </div>
  )
}

export default AdminAnalyticsActiveUsers
