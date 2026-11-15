/**
 * PR 상세(읽기 전용, 리뷰·머지·diff 는 "Gitea에서 열기").
 * 이슈 상세와 같은 틀: 제목 20/700 + #n → 상태 칩(열림 success · 병합 primary · 닫힘 중립) + 작성 + head → base
 * → 라벨 → 본문 카드 → Gitea 안내 카드(primary 버튼). 시안에 PR 화면이 없어 이슈 상세 규격으로 구성.
 */
import { useI18n } from '~/i18n'
import { timeAgo } from '~/lib/date'
import { useGit } from '~/composables/useGit'
import { UiIcon } from '~/components/ui/Icon'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiButton } from '~/components/ui/Button'
import { WorkStateChip } from '~/components/work/WorkStateChip'
import { GitLabelChip } from './GitLabelChip'
import { GitMarkdownRenderer } from './GitMarkdownRenderer'

/** PR 상세(읽기 전용) */
export function GitPullDetail() {
  const { t } = useI18n()
  const { selectedRepo, selectedPull, pullLoading, pullError, loadPull } = useGit()

  const p = selectedPull
  const state: 'open' | 'closed' | 'merged' = !p ? 'open' : p.merged ? 'merged' : p.state === 'open' ? 'open' : 'closed'
  const giteaUrl = selectedRepo && p ? `${selectedRepo.html_url}/pulls/${p.number}` : ''

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {pullLoading && !p ? (
        <UiSkeleton preset="text" rows={6} className="p-6" />
      ) : pullError ? (
        <UiErrorTile
          placement="panel"
          className="mt-6"
          title={pullError === 'notfound' ? t('git.pullDetail.notFound') : t('git.pullDetail.loadFailed')}
          noRetry={pullError === 'notfound'}
          onRetry={() => { if (p) void loadPull(p.number) }}
        />
      ) : p ? (
        <article className="px-4 py-4 md:px-6 md:py-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-start">
            <h1 className="flex-1 text-xl font-bold leading-[1.4]">
              {p.title}{' '}
              <span className="font-mono font-normal text-muted-foreground">#{p.number}</span>
            </h1>
            <a
              href={giteaUrl}
              target="_blank"
              rel="noopener"
              className="inline-flex h-8 shrink-0 items-center gap-1 self-start rounded-md border border-border px-3 text-xs hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >{t('git.commandBar.openInGitea')} <UiIcon name="external-link" className="h-3 w-3" /></a>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
            <WorkStateChip state={state} />
            <span>{t('git.shared.authored', { user: p.user?.login ?? '', when: timeAgo(p.created_at) })}</span>
            {p.head_branch && p.base_branch && (
              <span className="inline-flex items-center gap-1">
                ·
                <code className="rounded-[5px] bg-muted px-1.5 py-px font-mono text-xs text-foreground">{p.head_branch}</code>
                →
                <code className="rounded-[5px] bg-muted px-1.5 py-px font-mono text-xs text-foreground">{p.base_branch}</code>
              </span>
            )}
          </div>

          {p.labels.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-semibold text-muted-foreground">{t('git.labels.title')}</span>
              {p.labels.map(l => <GitLabelChip key={l.id} label={l} />)}
            </div>
          )}

          <div className="mt-4 rounded-lg border border-border px-4 py-3.5 text-sm leading-[1.7]">
            {p.body
              ? <GitMarkdownRenderer content={p.body} />
              : <p className="text-muted-foreground">{t('git.pull.noDescription')}</p>}
          </div>

          <div className="mt-4 flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1 text-[13px]">
              <p className="font-semibold">{t('git.pullDetail.giteaTitle')}</p>
              <p className="mt-0.5 text-muted-foreground">{t('git.pullDetail.giteaBody')}</p>
            </div>
            <UiButton as="a" href={giteaUrl} target="_blank" rel="noopener" size="sm" iconRight="external-link" className="shrink-0 font-semibold">
              {t('git.commandBar.openInGitea')}
            </UiButton>
          </div>
        </article>
      ) : null}
    </div>
  )
}

export default GitPullDetail
