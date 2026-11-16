/**
 * 코드 탭 — 폴더 보기.
 *  본문: 브랜치 ▾ + "브랜치 n" → 경로 → 파일 표 카드(최신 커밋 줄 44 + 행 40) → README 카드
 *  오른쪽 280(1024↑): 저장소 정보(GitRepoAbout). 1024 미만은 머리의 한 줄 메타 + "정보 더보기" 시트로 대체한다.
 * 행(데스크톱 24 · 220 · 1fr · 90): 아이콘 · 이름 · 마지막 커밋 메시지(muted) · 시각 mono.
 *  마지막 커밋은 목록을 먼저 렌더링한 후 contents?with_commits=true 로 채운다 — 수신 전에는 오른쪽 칸에 파일 크기를 표시한다.
 * 브랜치 줄: "브랜치 n · 태그 n"(GET /stats).
 * 모바일 행 52 · 15px.
 */
import { useI18n } from '~/i18n'
import { gitPath } from '~/utils/gitRoute'
import { timeAgo, formatSize } from '~/lib/date'
import { cn } from '~/lib/utils'
import { useGit } from '~/composables/useGit'
import { NuxtLink } from '~/components/NuxtLink'
import { UiIcon } from '~/components/ui/Icon'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { GitBranchSelector } from './GitBranchSelector'
import { GitPathCrumbs } from './GitPathCrumbs'
import { GitShaChip } from './GitShaChip'
import { GitMarkdownRenderer } from './GitMarkdownRenderer'
import { GitRepoAbout } from './GitRepoAbout'

export interface GitCodeViewProps {
  /** 폴더 경로(빈 문자열 = 루트) */
  path: string
}

const ROW = 'flex h-[52px] items-center gap-3 border-b border-border px-4 text-[15px] hover:bg-accent/40 focus-visible:outline-hidden focus-visible:shadow-[inset_0_0_0_2px_hsl(var(--ring))] md:grid md:h-10 md:grid-cols-[24px_220px_minmax(0,1fr)_90px] md:gap-2 md:px-3.5 md:text-[13px]'

/** 코드 탭 폴더 보기 */
export function GitCodeView({ path }: GitCodeViewProps) {
  const { t } = useI18n()
  const { selectedRepo, contents, contentsLoading, contentsError, latestCommit, branches, currentBranch, fetchContents, repoStats } = useGit()

  const r = selectedRepo
  const query = r && currentBranch && currentBranch !== r.default_branch ? { ref: currentBranch } : {}
  function entryTo(e: { type: string; path: string }) {
    const rr = selectedRepo!
    return { path: gitPath({ owner: rr.owner.login, repo: rr.name, path: e.path, kind: e.type === 'dir' ? 'tree' : 'blob' }), query }
  }
  const parentTo = !r || !path
    ? null
    : { path: gitPath({ owner: r.owner.login, repo: r.name, path: path.split('/').slice(0, -1).join('/'), kind: 'tree' }), query }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex gap-6 px-4 py-4 md:px-6 md:py-[18px]">
        <div className="flex min-w-0 flex-1 flex-col gap-3.5">
          {/* 브랜치 줄 */}
          <div className="flex items-center gap-2 text-[13px]">
            <GitBranchSelector />
            <span className="text-muted-foreground">{t('git.branch.label')} <span className="font-mono">{branches.length}</span>{repoStats?.tags != null && <> · {t('git.about.tags')} <span className="font-mono">{repoStats.tags}</span></>}</span>
          </div>

          <GitPathCrumbs path={path} />

          {/* 파일 표 카드 */}
          <div className="overflow-hidden rounded-lg border border-border">
            {/* 최신 커밋 줄 44 */}
            {latestCommit && (
              <div className="flex h-11 items-center gap-2.5 border-b border-border bg-card px-3.5 text-[13px]">
                <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-muted text-[10px] font-semibold" aria-hidden="true">{(latestCommit.author?.name || '?').charAt(0).toUpperCase()}</span>
                <b className="hidden shrink-0 font-semibold sm:inline">{latestCommit.author?.name}</b>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{latestCommit.message.split('\n')[0]}</span>
                <GitShaChip sha={latestCommit.sha} size="sm" />
                <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground sm:inline">{timeAgo(latestCommit.author?.date || '')}</span>
              </div>
            )}

            {contentsLoading ? (
              <UiSkeleton preset="list" rows={6} className="p-2" />
            ) : contentsError ? (
              <UiErrorTile
                placement="panel"
                title={contentsError === 'notfound' ? t('git.code.pathNotFound') : t('git.code.loadFailed')}
                noRetry={contentsError === 'notfound'}
                onRetry={() => { void fetchContents(path) }}
              />
            ) : !contents.length ? (
              <UiEmptyState variant="panel" icon="folder" title={t('git.code.emptyFolder')} />
            ) : (
              <ul role="list">
                {parentTo && (
                  <li>
                    <NuxtLink to={parentTo} className={cn(ROW, 'text-muted-foreground')}>
                      <UiIcon name="folder" className="h-[18px] w-[18px] text-warning md:h-[15px] md:w-[15px]" />
                      <span>..</span>
                    </NuxtLink>
                  </li>
                )}
                {contents.map(e => (
                  <li key={e.path} className="[&:last-child>a]:border-b-0">
                    <NuxtLink to={entryTo(e)} className={ROW}>
                      <UiIcon
                        name={e.type === 'dir' ? 'folder' : 'file-text'}
                        className={cn('h-[18px] w-[18px] shrink-0 md:h-[15px] md:w-[15px]', e.type === 'dir' ? 'text-warning' : 'text-muted-foreground')}
                        aria-label={e.type === 'dir' ? t('git.code.folder') : t('git.code.file')}
                      />
                      <span className="min-w-0 flex-1 truncate text-foreground">{e.name}</span>
                      <span className="hidden min-w-0 truncate text-muted-foreground md:block" title={e.last_commit?.message || undefined}>{e.last_commit?.message ?? ''}</span>
                      <span
                        className="shrink-0 text-right font-mono text-[11px] text-muted-foreground"
                        title={e.last_commit ? `${e.last_commit.author_name} · ${e.last_commit.date}` : undefined}
                      >{e.last_commit?.date ? timeAgo(e.last_commit.date) : (e.type === 'dir' || !e.size ? '' : formatSize(e.size))}</span>
                    </NuxtLink>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* README */}
          {!path && selectedRepo?.readme && (
            <div className="rounded-lg border border-border px-4 py-4 md:px-5">
              <div className="mb-2 text-xs font-semibold text-muted-foreground">README.md</div>
              <GitMarkdownRenderer content={selectedRepo.readme} />
            </div>
          )}
        </div>

        <aside aria-label={t('git.shared.repoInfo')} className="hidden w-[280px] shrink-0 lg:block">
          <GitRepoAbout />
        </aside>
      </div>
    </div>
  )
}

export default GitCodeView
