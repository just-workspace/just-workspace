// Vue 원본: frontend/components/git/GitCommitList.vue
/**
 * 커밋: 날짜 머리 32(sticky · 12/600 muted) + 카드(rounded-12) 안 행 56.
 *  행: 아바타 28(이니셜) · 메시지 13.5/600 · "작성자 · 시각(mono)" · SHA 칩 + 복사 상시 · ↗ Gitea 커밋(32, 히트 40)
 * 커밋 상세·diff 는 범위 밖(↗ 로 Gitea). "더 보기" = 다음 페이지 이어 붙이기.
 */
import { useI18n } from '~/i18n'
import { useGit, type CommitEntry } from '~/composables/useGit'
import { UiIcon } from '~/components/ui/Icon'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiButton } from '~/components/ui/Button'
import { GitShaChip } from './GitShaChip'

function dayKey(iso: string) {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}
function hhmm(iso: string) {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 커밋 목록(날짜별 묶음) */
export function GitCommitList() {
  const { t } = useI18n()
  const { commits, commitsLoading, commitsError, commitsHasMore, commitsPage, fetchCommits } = useGit()

  function dayLabel(iso: string) {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return t('git.commits.noDate')
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const that = new Date(d); that.setHours(0, 0, 0, 0)
    const diff = Math.round((today.getTime() - that.getTime()) / 86400000)
    const md = t('git.commits.monthDay', { m: d.getMonth() + 1, d: d.getDate() })
    const full = d.getFullYear() === today.getFullYear() ? md : t('git.commits.yearDate', { y: d.getFullYear(), date: md })
    if (diff === 0) return t('git.commits.todayDate', { date: full })
    if (diff === 1) return t('git.commits.yesterdayDate', { date: full })
    return full
  }

  const groups: { key: string; label: string; items: CommitEntry[] }[] = []
  for (const c of commits) {
    const iso = c.author?.date || ''
    const k = dayKey(iso)
    if (!groups.length || groups[groups.length - 1].key !== k) groups.push({ key: k, label: dayLabel(iso), items: [] })
    groups[groups.length - 1].items.push(c)
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 md:px-6">
      {commitsLoading && !commits.length ? (
        <UiSkeleton preset="list" rows={6} framed />
      ) : commitsError && !commits.length ? (
        <UiErrorTile placement="panel" title={t('git.commits.loadFailed')} onRetry={() => { void fetchCommits(1) }} />
      ) : !commits.length ? (
        <UiEmptyState variant="panel" icon="git-branch" title={t('git.commits.emptyBranch')} />
      ) : (
        <>
          {groups.map(g => (
            <section key={g.key} aria-label={g.label}>
              <h2 className="sticky top-0 z-[1] flex h-8 items-center bg-background text-xs font-semibold text-muted-foreground">{g.label}</h2>
              <ul role="list" className="mb-3 overflow-hidden rounded-lg border border-border">
                {g.items.map(c => (
                  <li
                    key={c.sha}
                    className="flex min-h-14 items-center gap-3 border-b border-border py-2 pl-3.5 pr-1.5 last:border-b-0"
                  >
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold" aria-hidden="true">{(c.author?.name || '?').charAt(0).toUpperCase()}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-semibold" title={c.message}>{c.message.split('\n')[0]}</p>
                      <p className="truncate text-xs text-muted-foreground">{c.author?.name || t('common.unknown')} · <span className="font-mono">{hhmm(c.author?.date || '')}</span></p>
                    </div>
                    <GitShaChip sha={c.sha} />
                    {c.html_url && (
                      <a
                        href={c.html_url}
                        target="_blank"
                        rel="noopener"
                        aria-label={t('git.commits.viewInGitea')}
                        title={t('git.commits.viewInGitea')}
                        className="relative grid h-8 w-8 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground before:absolute before:-inset-1 before:content-[''] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <UiIcon name="external-link" className="h-[15px] w-[15px]" />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {commitsError ? (
            <UiErrorTile placement="card" title={t('git.commits.loadMoreFailed')} onRetry={() => { void fetchCommits(commitsPage + 1) }} />
          ) : commitsHasMore ? (
            <div className="flex justify-center pb-4">
              <UiButton variant="outline" size="sm" disabled={commitsLoading} onClick={() => { void fetchCommits(commitsPage + 1) }}>{commitsLoading ? t('git.shared.loadingMore') : t('git.shared.loadMore')}</UiButton>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

export default GitCommitList
