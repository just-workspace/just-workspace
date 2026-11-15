// Vue 원본: frontend/components/git/GitIssueList.vue
/**
 * 이슈 목록(시안 GT3 왼쪽 560 · GTM2 모바일).
 *  머리 52: 열림 n / 닫힘 세그먼트 · 라벨 ▾(GitLabelPicker 필터 — 기존 기능 유지) · 담당 ▾ · 새 이슈(primary 32)
 *  행 60: 상태 아이콘 16(열림 success · 닫힘 muted) · 제목 13.5/600 + 라벨 칩 · "#n · 작성자 · 언제" · 댓글 수
 *  모바일: 세그먼트·칩 36, 행 15/600 · 아이콘 18, 새 이슈는 FAB.
 * 담당자 필터는 ★백엔드 갭(이슈 목록 필터 파라미터 없음) — 비활성.
 */
import { useI18n } from '~/i18n'
import { timeAgo } from '~/lib/date'
import { cn } from '~/lib/utils'
import { gitPath } from '~/utils/gitRoute'
import { gitStore, useGit } from '~/composables/useGit'
import { useIsMobile } from '~/composables/useIsMobile'
import { NuxtLink } from '~/components/NuxtLink'
import { UiIcon } from '~/components/ui/Icon'
import { UiSegment } from '~/components/ui/Segment'
import { UiChip } from '~/components/ui/Chip'
import { UiButton } from '~/components/ui/Button'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiFab } from '~/components/ui/Fab'
import { WorkStateIcon } from '~/components/work/WorkStateIcon'
import { GitLabelPicker } from './GitLabelPicker'
import { GitLabelChip } from './GitLabelChip'

export interface GitIssueListProps {
  /** 지금 열린 이슈 번호(행 강조) */
  selected: number | null
  /** 새 이슈 */
  onCreateIssue?: () => void
}

/** 이슈 목록 */
export function GitIssueList({ selected, onCreateIssue }: GitIssueListProps) {
  const {
    selectedRepo, issues, issueState, setIssueState, issuesLoading, issuesError, fetchIssues,
    labelFilter, setLabelFilter, labelById, currentBranch, repoStats,
  } = useGit()
  const isMobile = useIsMobile()
  const { t } = useI18n()

  const stateItems = [
    // 열림/닫힘 수는 GET /stats(없으면 열린 수만 저장소 값). 라벨 필터가 걸리면 목록 수와 다르므로 숨김.
    { value: 'open', label: t('git.issue.state_open'), count: labelFilter.length ? undefined : (repoStats?.open_issues ?? selectedRepo?.open_issues_count) },
    { value: 'closed', label: t('git.issue.state_closed'), count: labelFilter.length ? undefined : (repoStats?.closed_issues ?? undefined) },
  ]

  function removeFilter(id: number) {
    setLabelFilter(gitStore.getState().labelFilter.filter(x => x !== id))
    void fetchIssues()
  }

  const r = selectedRepo
  const query = r && currentBranch && currentBranch !== r.default_branch ? { ref: currentBranch } : {}
  function issueTo(n: number) {
    const rr = selectedRepo!
    return { path: gitPath({ owner: rr.owner.login, repo: rr.name, tab: 'issues', number: n }), query }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 머리 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-border px-4 py-2 md:h-[52px] md:flex-nowrap md:border-b md:px-3.5 md:py-0">
        <UiSegment
          modelValue={issueState}
          onUpdateModelValue={(v) => { setIssueState(v as 'open' | 'closed'); void fetchIssues() }}
          items={stateItems}
          size={isMobile ? 'lg' : 'md'}
          ariaLabel={t('git.issueList.stateAria')}
        />
        <GitLabelPicker modelValue={labelFilter} onUpdateModelValue={setLabelFilter} mode="filter" onCommit={() => { void fetchIssues() }} />
        <UiChip variant="static" label={t('git.shared.assignee')} disabled size={isMobile ? 'lg' : 'md'} className="max-md:hidden" title={t('git.shared.comingSoon')} />
        <span className="flex-1" />
        <UiButton size="xs" className="hidden font-semibold md:inline-flex" onClick={() => onCreateIssue?.()}>{t('git.issue.newButton')}</UiButton>
      </div>
      {/* 선택된 라벨 필터 — 지울 수 있는 칩 */}
      {labelFilter.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-border px-4 pb-2 md:px-3.5 md:pt-2">
          {labelFilter.map(id => (
            <UiChip key={id} variant="static" removable label={labelById(id).name} size="sm" onRemove={() => removeFilter(id)} />
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto pb-24 md:pb-0">
        {issuesLoading && !issues.length ? (
          <UiSkeleton preset="list" rows={6} className="p-3" />
        ) : issuesError ? (
          <UiErrorTile placement="panel" title={t('git.issueList.loadFailed')} onRetry={() => { void fetchIssues() }} />
        ) : !issues.length ? (
          <UiEmptyState
            variant="panel"
            icon="check-circle"
            title={labelFilter.length ? t('git.issueList.noMatch') : issueState === 'open' ? t('git.issue.emptyOpen') : t('git.issue.emptyClosed')}
            actionLabel={issueState === 'open' && !labelFilter.length ? t('git.issue.newButton') : undefined}
            onAction={() => onCreateIssue?.()}
          />
        ) : (
          <ul role="list">
            {issues.map(i => (
              <li key={i.number}>
                <NuxtLink
                  to={issueTo(i.number)}
                  aria-current={i.number === selected ? 'page' : undefined}
                  className={cn(
                    'relative isolate flex gap-2.5 border-b border-border px-4 py-3 hover:bg-accent/40 focus-visible:outline-hidden focus-visible:shadow-[inset_0_0_0_2px_hsl(var(--ring))] md:min-h-[60px] md:px-3.5 md:py-2.5',
                    i.number === selected ? 'bg-primary/[0.13] hover:bg-primary/[0.13]' : '',
                  )}
                >
                  <WorkStateIcon
                    state={i.state === 'open' ? 'open' : 'closed'}
                    className={cn('mt-px h-[18px] w-[18px] shrink-0 md:mt-0.5 md:h-4 md:w-4', i.state === 'open' ? 'text-success' : 'text-muted-foreground')}
                    role="img"
                    aria-label={i.state === 'open' ? t('git.issue.state_open') : t('git.issue.state_closed')}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-[15px] font-semibold text-foreground md:text-[13.5px]">
                      <span className="min-w-0 break-words">{i.title}</span>
                      {i.labels.map(l => <GitLabelChip key={l.id} label={l} className="max-md:hidden" />)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <span className="font-mono">#{i.number}</span> · {i.user?.login} · {timeAgo(i.created_at)}
                      {i.labels.length > 0 && <span className="md:hidden"> · {i.labels.map(l => l.name).join(', ')}</span>}
                    </div>
                  </div>
                  {i.comments > 0 && (
                    <span className="flex shrink-0 items-start gap-1 pt-0.5 font-mono text-[11px] text-muted-foreground" aria-label={t('git.shared.commentCount', { n: i.comments })}>
                      <UiIcon name="message-square" className="mt-px h-3 w-3" />{i.comments}
                    </span>
                  )}
                </NuxtLink>
              </li>
            ))}
          </ul>
        )}
      </div>

      <UiFab label={t('git.issue.newButton')} onClick={() => onCreateIssue?.()} />
    </div>
  )
}

export default GitIssueList
