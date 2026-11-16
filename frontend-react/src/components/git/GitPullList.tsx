/**
 * PR 목록(시안에 PR 화면이 없어 이슈 목록 규격을 그대로 적용한다).
 *  머리 52: 열림/닫힘 세그먼트(이슈와 같은 UiSegment — 자체 구현 세그먼트 2종 통일) · Gitea에서 새 PR ↗
 *  행 60: 상태 아이콘(열림 success · 병합 primary · 닫힘 muted) · 제목 + 라벨 칩 · "#n · 작성자 · 언제 · head → base"
 */
import { useI18n } from '~/i18n'
import { timeAgo } from '~/lib/date'
import { cn } from '~/lib/utils'
import { gitPath } from '~/utils/gitRoute'
import { useGit } from '~/composables/useGit'
import { useIsMobile } from '~/composables/useIsMobile'
import { NuxtLink } from '~/components/NuxtLink'
import { UiIcon } from '~/components/ui/Icon'
import { UiSegment } from '~/components/ui/Segment'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { WorkStateIcon } from '~/components/work/WorkStateIcon'
import { GitLabelChip } from './GitLabelChip'

export interface GitPullListProps {
  /** 현재 열린 PR 번호(행 강조) */
  selected: number | null
}

function prState(p: { state: string; merged: boolean }): 'open' | 'closed' | 'merged' {
  return p.merged ? 'merged' : p.state === 'open' ? 'open' : 'closed'
}
const STATE_TEXT = { open: 'text-success', merged: 'text-primary', closed: 'text-muted-foreground' }

/** PR 목록 */
export function GitPullList({ selected }: GitPullListProps) {
  const { selectedRepo, pulls, pullState, setPullState, pullsLoading, pullsError, fetchPulls, currentBranch, repoStats } = useGit()
  const isMobile = useIsMobile()
  const { t } = useI18n()

  // 열림/닫힘 수 = GET /stats(조회 실패 시 생략)
  const stateItems = [
    { value: 'open', label: t('git.issue.state_open'), count: repoStats?.open_pulls ?? undefined },
    { value: 'closed', label: t('git.issue.state_closed'), count: repoStats?.closed_pulls ?? undefined },
  ]
  const STATE_LABEL = { open: t('git.issue.state_open'), merged: t('git.pullList.merged'), closed: t('git.issue.state_closed') }

  const r = selectedRepo
  const query = r && currentBranch && currentBranch !== r.default_branch ? { ref: currentBranch } : {}
  function pullTo(n: number) {
    const rr = selectedRepo!
    return { path: gitPath({ owner: rr.owner.login, repo: rr.name, tab: 'pulls', number: n }), query }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 py-2 md:h-[52px] md:border-b md:border-border md:px-3.5 md:py-0">
        <UiSegment
          modelValue={pullState}
          onUpdateModelValue={(v) => { setPullState(v as 'open' | 'closed'); void fetchPulls() }}
          items={stateItems}
          size={isMobile ? 'lg' : 'md'}
          ariaLabel={t('git.pullList.stateAria')}
        />
        <span className="flex-1" />
        {selectedRepo && (
          <a
            href={`${selectedRepo.html_url}/compare`}
            target="_blank"
            rel="noopener"
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-border px-2.5 text-xs hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring max-md:h-10"
          >{t('git.pullList.newInGitea')} <UiIcon name="external-link" className="h-3 w-3" /></a>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        {pullsLoading && !pulls.length ? (
          <UiSkeleton preset="list" rows={5} className="p-3" />
        ) : pullsError ? (
          <UiErrorTile placement="panel" title={t('git.pullList.loadFailed')} onRetry={() => { void fetchPulls() }} />
        ) : !pulls.length ? (
          <UiEmptyState variant="panel" icon="git-branch" title={pullState === 'open' ? t('git.pull.emptyOpen') : t('git.pull.emptyClosed')} />
        ) : (
          <ul role="list">
            {pulls.map(p => (
              <li key={p.number}>
                <NuxtLink
                  to={pullTo(p.number)}
                  aria-current={p.number === selected ? 'page' : undefined}
                  className={cn(
                    'flex gap-2.5 border-b border-border px-4 py-3 hover:bg-accent/40 focus-visible:outline-hidden focus-visible:shadow-[inset_0_0_0_2px_hsl(var(--ring))] md:min-h-[60px] md:px-3.5 md:py-2.5',
                    p.number === selected ? 'bg-primary/[0.13] hover:bg-primary/[0.13]' : '',
                  )}
                >
                  <WorkStateIcon
                    state={prState(p)}
                    className={cn('mt-px h-[18px] w-[18px] shrink-0 md:mt-0.5 md:h-4 md:w-4', STATE_TEXT[prState(p)])}
                    role="img"
                    aria-label={STATE_LABEL[prState(p)]}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-[15px] font-semibold md:text-[13.5px]">
                      <span className="min-w-0 break-words">{p.title}</span>
                      {p.labels.map(l => <GitLabelChip key={l.id} label={l} className="max-md:hidden" />)}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      <span className="font-mono">#{p.number}</span> · {p.user?.login} · {timeAgo(p.created_at)}
                      {p.head_branch && p.base_branch && <> · <span className="font-mono">{p.head_branch} → {p.base_branch}</span></>}
                    </div>
                  </div>
                  {p.comments > 0 && (
                    <span className="flex shrink-0 items-start gap-1 pt-0.5 font-mono text-[11px] text-muted-foreground" aria-label={t('git.shared.commentCount', { n: p.comments })}>
                      <UiIcon name="message-square" className="mt-px h-3 w-3" />{p.comments}
                    </span>
                  )}
                </NuxtLink>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export default GitPullList
