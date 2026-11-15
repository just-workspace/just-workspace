/**
 * 관리 개요 › Git 활동 카드 — Vue components/admin/AdminAnalyticsGitActivity.vue.
 * 머리 오른쪽에 저장소·이슈·PR 수, 본문은 최근 10건(종류 칩 · 저장소 / 제목 · 사람 · 상대 시각).
 */
import { useI18n } from '~/i18n'
import { UiEmptyState } from '~/components/ui/EmptyState'
import type { GitActivityItem, GitStats } from '~/composables/useAdminAnalytics'
import { analyticsTimeAgo } from './analyticsFormat'

export interface AdminAnalyticsGitActivityProps {
  /** 최근 Git 활동(앞 10건만 그림) */
  activity: GitActivityItem[]
  /** 저장소·이슈·PR 합계. null 이면 머리 숫자 숨김 */
  stats: GitStats | null
}

const eventIcons: Record<string, string> = {
  push: 'commit',
  issue: 'issue',
  pull_request: 'PR',
}

export function AdminAnalyticsGitActivity({ activity, stats }: AdminAnalyticsGitActivityProps) {
  const { t } = useI18n()
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[13px] font-semibold text-foreground">{t('admin.analytics.git.title')}</h3>
        {stats && (
          <div className="flex gap-3 text-xs text-muted-foreground">
            <span>{t('admin.analytics.git.repos', { n: stats.total_repos })}</span>
            <span>{t('admin.analytics.git.issues', { n: stats.total_issues })}</span>
            <span>PR {stats.total_pulls}</span>
          </div>
        )}
      </div>
      {activity.length === 0
        ? <UiEmptyState variant="panel" icon="inbox" title={t('admin.analytics.git.empty')} />
        : (
          <div className="space-y-2">
            {activity.slice(0, 10).map((item, i) => (
              <div key={i} className="flex items-start gap-2 text-sm py-1.5 border-b border-border last:border-0">
                <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded border border-border bg-card text-[11px] font-medium text-muted-foreground mt-0.5">
                  {eventIcons[item.event_type] || item.event_type}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate">
                    <span className="text-muted-foreground">{item.repo_name}</span>
                    <span className="mx-1 text-muted-foreground">/</span>
                    <span>{item.title}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {item.user} &middot; {analyticsTimeAgo(item.created_at, t)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
    </div>
  )
}

export default AdminAnalyticsGitActivity
