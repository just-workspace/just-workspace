// Vue 원본: frontend/components/git/GitRepoList.vue
/**
 * 저장소 목록: 커맨드 바 44(bg-card) — "저장소 n개" · 찾기 220×32 · Gitea에서 새 저장소 ↗
 * → 카드 그리드 3열(gap 14, 패딩 20/24). 모바일 1열 · 찾기는 줄 아래 전체 폭.
 * 저장소 만들기·포크는 Gitea 로.
 */
import { useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { useGit } from '~/composables/useGit'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { UiIcon } from '~/components/ui/Icon'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiButton } from '~/components/ui/Button'
import { GitRepoCard } from './GitRepoCard'
import { UiTrans } from '~/components/ui/Trans'

/** 저장소 목록 화면(/code) */
export function GitRepoList() {
  const { repos, reposTotal, reposLoading, reposError, searchQuery, setSearchQuery, fetchRepos } = useGit()
  const { giteaUrl } = useSiteConfig()
  const { t } = useI18n()

  const [page, setPage] = useState(1)
  const totalPages = Math.max(1, Math.ceil(reposTotal / 20))

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function onSearch() {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { setPage(1); void fetchRepos(1) }, 300)
  }
  function changePage(p: number) {
    setPage(p)
    void fetchRepos(p)
  }
  const newRepoUrl = giteaUrl ? `${giteaUrl.replace(/\/$/, '')}/repo/create` : '/git/repo/create'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 커맨드 바 44 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-2 text-[13px] md:h-11 md:flex-nowrap md:py-0 md:pl-4 md:pr-2.5">
        <b className="font-semibold">{t('git.repos.title')}</b>
        <span className="text-muted-foreground"><UiTrans k="git.repos.count" slots={{ n: <span className="font-mono">{reposTotal}</span> }} /></span>
        <span className="flex-1" />
        <label className="flex h-10 w-full items-center gap-2 rounded-md border border-input bg-background px-2 text-sm text-muted-foreground focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/35 max-md:order-last md:h-8 md:w-[220px] md:text-xs">
          <UiIcon name="search" className="h-3.5 w-3.5 shrink-0" />
          <input
            value={searchQuery}
            type="search"
            autoComplete="off"
            aria-label={t('git.repos.search')}
            placeholder={t('git.repos.search')}
            className="min-w-0 flex-1 bg-transparent text-foreground outline-hidden placeholder:text-muted-foreground"
            onChange={(e) => { setSearchQuery(e.target.value); onSearch() }}
            onKeyDown={(e) => { if (e.key === 'Enter') changePage(1) }}
          />
        </label>
        <a
          href={newRepoUrl}
          target="_blank"
          rel="noopener"
          className="inline-flex h-10 shrink-0 items-center gap-1 rounded-md border border-border px-3 text-xs hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring md:h-8"
        >{t('git.repos.newInGitea')} <UiIcon name="external-link" className="h-3 w-3" /></a>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-5">
        {reposLoading && !repos.length ? (
          <UiSkeleton preset="grid" rows={6} />
        ) : reposError ? (
          <UiErrorTile placement="page" title={t('git.repos.loadFailed')} detail={t('git.shared.giteaUnreachable')} onRetry={() => { void fetchRepos(page) }} />
        ) : !repos.length ? (
          <UiEmptyState
            icon="git-branch"
            title={searchQuery ? t('git.repos.noMatch') : t('git.repoList.empty')}
            description={searchQuery ? t('git.repos.noMatchHint') : t('git.repos.emptyHint')}
          />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
              {repos.map(r => <GitRepoCard key={r.id} repo={r} />)}
            </div>
            {totalPages > 1 && (
              <div className="mt-6 flex items-center justify-center gap-2">
                <UiButton variant="outline" size="sm" disabled={page <= 1} onClick={() => changePage(page - 1)}>{t('common.prev')}</UiButton>
                <span className="font-mono text-sm text-muted-foreground">{page} / {totalPages}</span>
                <UiButton variant="outline" size="sm" disabled={page >= totalPages} onClick={() => changePage(page + 1)}>{t('common.next')}</UiButton>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default GitRepoList
