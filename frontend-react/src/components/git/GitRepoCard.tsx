// Vue 원본: frontend/components/git/GitRepoCard.vue
// 저장소 카드(시안 GT1): 16 패딩 · rounded-12 · bg-card. "소유자 /" muted + 이름 14/600 + 공개 칩 18(muted)
// → 설명 13 muted → 언어 점 9(primary — 인라인 hex 폐지) · ★ n · 갱신 시각(mono). 카드 전체가 링크.
import type { RepoSummary } from '~/composables/useGit'
import { useI18n } from '~/i18n'
import { timeAgo } from '~/lib/date'
import { gitPath } from '~/utils/gitRoute'
import { NuxtLink } from '~/components/NuxtLink'
import { UiIcon } from '~/components/ui/Icon'

export interface GitRepoCardProps {
  /** 목록 항목 */
  repo: RepoSummary
}

/** 저장소 카드(카드 전체가 저장소 링크) */
export function GitRepoCard({ repo }: GitRepoCardProps) {
  const { t } = useI18n()
  const to = gitPath({ owner: repo.owner.login, repo: repo.name })
  return (
    <NuxtLink
      to={to}
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background"
    >
      <div className="flex min-w-0 items-center gap-2">
        <b className="min-w-0 truncate text-sm font-semibold text-foreground">
          <span className="font-normal text-muted-foreground">{repo.owner.login} /</span> {repo.name}
        </b>
        <span className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] bg-muted px-1.5 text-[11px] font-semibold">{repo.private ? 'Private' : 'Public'}</span>
      </div>
      <p className="line-clamp-2 min-h-5 text-[13px] text-muted-foreground">{repo.description}</p>
      <div className="flex items-center gap-3.5 text-xs text-muted-foreground">
        {repo.language && <span className="flex items-center gap-[5px]"><span className="h-[9px] w-[9px] rounded-full bg-primary" aria-hidden="true" />{repo.language}</span>}
        <span aria-label={t('git.shared.starCount', { n: repo.stars_count })}><UiIcon name="star" className="inline-block h-3 w-3 align-[-1px]" aria-hidden="true" /> <span className="font-mono">{repo.stars_count}</span></span>
        <span className="ml-auto font-mono">{timeAgo(repo.updated_at)}</span>
      </div>
    </NuxtLink>
  )
}

export default GitRepoCard
