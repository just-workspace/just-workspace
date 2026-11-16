/**
 * Git. 화면은 라우트가 결정한다(utils/gitRoute):
 *  /code → 저장소 목록 · /code/:owner/:repo/(tree|blob|issues|pulls|commits) → 저장소 안(제목 줄 + 밑줄 탭).
 *  이슈·PR 은 목록 560 + 상세(1024↑ 2단). 1024 미만은 목록 → 상세 전환(모바일 상세는 탭바 숨김 + 뒤로 막대).
 * 주의: nginx 가 /git/ 를 Gitea 로 전달하므로, 이 주소를 새로고침하거나 외부에서 열면 Gitea 의 동일 화면이 표시된다.
 */
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { navigateTo, useRoute } from '~/lib/router'
import { useHead } from '~/lib/head'
import { parseGitRoute, gitPath } from '~/utils/gitRoute'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useIsMobile } from '~/composables/useIsMobile'
import { useBreadcrumb } from '~/composables/useBreadcrumb'
import {
  gitStore, useGit, fetchRepos, ensureRepo, setBranch, openFile, fetchContents, fetchCommits,
  fetchIssues, fetchPulls, loadIssue, clearIssue, loadPull, clearPull,
} from '~/composables/useGit'
import { NuxtLink } from '~/components/NuxtLink'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiIcon } from '~/components/ui/Icon'
import { LayoutMobileDetailBar } from '~/components/layout/MobileDetailBar'
import { GitRepoList } from '~/components/git/GitRepoList'
import { GitRepoHeader } from '~/components/git/GitRepoHeader'
import { GitFileViewer } from '~/components/git/GitFileViewer'
import { GitCodeView } from '~/components/git/GitCodeView'
import { GitIssueList } from '~/components/git/GitIssueList'
import { GitPullList } from '~/components/git/GitPullList'
import { GitIssueDetail } from '~/components/git/GitIssueDetail'
import { GitPullDetail } from '~/components/git/GitPullDetail'
import { GitBranchSelector } from '~/components/git/GitBranchSelector'
import { GitCommitList } from '~/components/git/GitCommitList'
import { GitCreateIssueModal } from '~/components/git/GitCreateIssueModal'

export default function Page() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  const route = useRoute()
  const isMobile = useIsMobile()

  const r = parseGitRoute(route.params.slug as string[] | undefined)
  const repoRoute = r.view === 'repo' ? r : null

  const { selectedRepo, repoError, repoLoading } = useGit()

  useHead({ title: `${selectedRepo && repoRoute ? selectedRepo.name : t('nav.git')} | ${appName}` })
  useBreadcrumb(repoRoute ? (selectedRepo?.name ?? repoRoute.repo) : t('git.repos.title'))

  const [showCreateIssue, setShowCreateIssue] = useState(false)

  // 라우트 → 데이터. 동일 키면 재조회하지 않는다(이슈 목록 ↔ 상세 이동 시 목록 유지)
  const lastKey = useRef({ repos: false, list: '', detail: '' })
  const refQ = (route.query.ref as string) || null
  const slugRef = useRef(route.params.slug)
  slugRef.current = route.params.slug
  const refQRef = useRef(refQ)
  refQRef.current = refQ

  async function sync() {
    const cur = parseGitRoute(slugRef.current as string[] | undefined)
    if (cur.view === 'repos') {
      if (!lastKey.current.repos || !gitStore.getState().repos.length) void fetchRepos(1)
      lastKey.current = { repos: true, list: '', detail: '' }
      return
    }
    if (cur.view !== 'repo') return
    const ref = refQRef.current
    await ensureRepo(cur.owner, cur.repo, ref)
    const repo = gitStore.getState().selectedRepo
    if (!repo) return
    if (!ref && gitStore.getState().currentBranch !== repo.default_branch) setBranch(repo.default_branch)
    const base = `${cur.owner}/${cur.repo}@${gitStore.getState().currentBranch}`

    if (cur.tab === 'code') {
      const key = `${base}|${cur.kind}|${cur.path}`
      if (key !== lastKey.current.list) {
        if (cur.kind === 'blob') void openFile(cur.path)
        else void fetchContents(cur.path)
      }
      lastKey.current = { repos: false, list: key, detail: '' }
      return
    }
    if (cur.tab === 'commits') {
      const key = `${base}|commits`
      if (key !== lastKey.current.list) void fetchCommits(1)
      lastKey.current = { repos: false, list: key, detail: '' }
      return
    }
    // 이슈·PR
    const listKey = `${cur.owner}/${cur.repo}|${cur.tab}`
    if (listKey !== lastKey.current.list) void (cur.tab === 'issues' ? fetchIssues() : fetchPulls())
    const detailKey = cur.number ? `${listKey}#${cur.number}` : ''
    if (detailKey !== lastKey.current.detail) {
      if (cur.tab === 'issues') { if (cur.number) void loadIssue(cur.number); else clearIssue() }
      else { if (cur.number) void loadPull(cur.number); else clearPull() }
    }
    lastKey.current = { repos: false, list: listKey, detail: detailKey }
  }
  // watch(() => [route.path, route.query.ref], sync, { immediate: true })
  useEffect(() => {
    void sync()
     
  }, [route.path, refQ])

  function retryRepo() {
    const cur = repoRoute
    if (!cur) return
    lastKey.current = { repos: false, list: '', detail: '' }
    void ensureRepo(cur.owner, cur.repo, refQ).then(sync)
  }

  const listPath = repoRoute ? gitPath({ owner: repoRoute.owner, repo: repoRoute.repo, tab: repoRoute.tab }) : '/code'
  const hasDetail = !!repoRoute?.number
  // 파일 보기(blob): 모바일 머리 = 파일 이름 + 저장소, 뒤로 = 해당 파일이 속한 폴더
  const isBlob = repoRoute?.tab === 'code' && repoRoute.kind === 'blob'
  const blobName = (repoRoute?.path || '').split('/').pop() || ''
  const blobParent = (() => {
    const cur = repoRoute
    if (!cur) return '/code'
    const dir = (cur.path || '').split('/').slice(0, -1).join('/')
    return gitPath({ owner: cur.owner, repo: cur.repo, tab: 'code', kind: 'tree', path: dir || undefined })
  })()

  function onIssueCreated(n: number) {
    const cur = repoRoute
    if (cur) void navigateTo(gitPath({ owner: cur.owner, repo: cur.repo, tab: 'issues', number: n }))
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {r.view === 'repos' ? (
        /* 저장소 목록 */
        <GitRepoList />
      ) : r.view === 'invalid' ? (
        /* 잘못된 주소 */
        <UiErrorTile
          placement="page"
          title={t('git.page.invalid')}
          noRetry
          secondaryLabel={t('git.commandBar.repoList')}
          secondaryTo="/code"
        />
      ) : repoRoute ? (
        /* 저장소 안 */
        repoLoading && !selectedRepo ? (
          <div className="shrink-0 border-b border-border bg-card px-6 pb-3 pt-4">
            <UiSkeleton className="h-6 w-64" />
            <UiSkeleton className="mt-4 h-5 w-80" />
          </div>
        ) : repoError ? (
          <UiErrorTile
            placement="page"
            title={repoError === 'notfound' ? t('git.page.repoNotFound') : t('git.repos.loadFailed')}
            detail={repoError === 'notfound' ? t('git.page.repoNotFoundDetail', { repo: `${repoRoute.owner}/${repoRoute.repo}` }) : t('git.shared.giteaUnreachable')}
            noRetry={repoError === 'notfound'}
            secondaryLabel={t('git.commandBar.repoList')}
            secondaryTo="/code"
            onRetry={retryRepo}
          />
        ) : selectedRepo ? (
          <>
            {/* 머리(모바일 상세·파일 보기에서는 뒤로 막대로 대체된다 — 공용 상단바 + 저장소 머리 이중 표시 방지) */}
            {isMobile && isBlob ? (
              <LayoutMobileDetailBar
                title={blobName}
                subtitle={selectedRepo.name}
                subtitleMono
                backTo={blobParent}
                backLabel={t('git.page.backToList')}
              />
            ) : !(isMobile && hasDetail) ? (
              <GitRepoHeader tab={repoRoute.tab} />
            ) : null}

            {repoRoute.tab === 'code' ? (
              /* 코드 */
              repoRoute.kind === 'blob' ? <GitFileViewer path={repoRoute.path} /> : <GitCodeView path={repoRoute.path} />
            ) : repoRoute.tab === 'issues' || repoRoute.tab === 'pulls' ? (
              /* 이슈·PR: 목록 560 + 상세 */
              <div className="flex min-h-0 flex-1">
                <section
                  aria-label={repoRoute.tab === 'issues' ? t('git.page.issueList') : t('git.page.pullList')}
                  className={cn('min-h-0 w-full flex-col border-border lg:flex lg:w-[560px] lg:shrink-0 lg:border-r', hasDetail ? 'hidden' : 'flex')}
                >
                  {repoRoute.tab === 'issues'
                    ? <GitIssueList selected={repoRoute.number} onCreateIssue={() => setShowCreateIssue(true)} />
                    : <GitPullList selected={repoRoute.number} />}
                </section>
                <section
                  aria-label={repoRoute.tab === 'issues' ? t('git.page.issueDetail') : t('git.page.pullDetail')}
                  className={cn('min-h-0 min-w-0 flex-1 flex-col', hasDetail ? 'flex' : 'hidden lg:flex')}
                >
                  {isMobile && hasDetail ? (
                    <LayoutMobileDetailBar
                      title={repoRoute.tab === 'issues' ? t('git.page.issueTitle', { n: repoRoute.number ?? '' }) : t('git.page.pullTitle', { n: repoRoute.number ?? '' })}
                      subtitle={selectedRepo.name}
                      subtitleMono
                      backTo={listPath}
                      backLabel={t('git.page.backToList')}
                    />
                  ) : hasDetail ? (
                    <NuxtLink
                      to={listPath}
                      className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-4 text-xs text-muted-foreground hover:text-foreground lg:hidden"
                    ><UiIcon name="chevron-left" className="h-3.5 w-3.5" />{repoRoute.tab === 'issues' ? t('git.page.issueList') : t('git.page.pullList')}</NuxtLink>
                  ) : null}
                  {hasDetail ? (
                    repoRoute.tab === 'issues' ? <GitIssueDetail /> : <GitPullDetail />
                  ) : (
                    <UiEmptyState
                      variant="panel"
                      className="m-auto"
                      icon={repoRoute.tab === 'issues' ? 'check-circle' : 'git-branch'}
                      title={repoRoute.tab === 'issues' ? t('git.page.pickIssue') : t('git.page.pickPull')}
                    />
                  )}
                </section>
              </div>
            ) : repoRoute.tab === 'commits' ? (
              /* 커밋 */
              <>
                <div className="flex shrink-0 items-center gap-2 px-4 pt-3 md:px-6">
                  <GitBranchSelector />
                </div>
                <GitCommitList />
              </>
            ) : null}
          </>
        ) : null
      ) : null}

      {showCreateIssue && <GitCreateIssueModal onClose={() => setShowCreateIssue(false)} onCreated={onIssueCreated} />}
    </div>
  )
}
