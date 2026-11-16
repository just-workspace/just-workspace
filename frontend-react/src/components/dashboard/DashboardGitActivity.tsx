/**
 * Git 활동: 범위 [내 것|전체], Git 계정이 없으면 [전체] 하나(공개 저장소 활동).
 * 두 줄 행 56 = 상태 아이콘(리뷰·병합 PR primary · 열린 이슈 success · 닫힘·커밋 muted) + "PR #482 제목" /
 * "상태 · 작성자"(커밋 그룹은 "main 에 3커밋" / "저장소 · 작성자들") + 시각. 헤더 "Git ›".
 * 서버: GET /api/git/activity?scope=mine|all&limit=n (backend app/git/router.py)
 */
import { useCallback, useEffect, useState } from 'react'
import { $fetch } from '~/lib/api'
import { useI18n } from '~/i18n'
import { gitPath } from '~/utils/gitRoute'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { DashCard, DashRow, DashRows, DashRowsSkeleton, shortTime, useCardStatus, useDash } from './DashCard'

export type GitActivityKind =
  | 'review' | 'assigned' | 'mention'
  | 'pr_open' | 'pr_merged' | 'pr_closed'
  | 'issue_open' | 'issue_closed'
  | 'commits'

export interface GitActivityItem {
  kind: GitActivityKind
  is_pull: boolean
  number: number | null
  title: string
  repo_full_name: string
  repo_name: string
  author: string
  at: string
  /** commits 그룹: 커밋 수 */
  count: number | null
  /** commits 그룹: 작성자 목록(앞선 순) */
  authors: string[]
  /** commits 그룹: 브랜치 */
  branch: string
}

export interface GitActivityResponse {
  connected: boolean
  scope: 'mine' | 'all'
  items: GitActivityItem[]
}

type Scope = 'mine' | 'all'

/** 아이콘 · 상태색(시안: 리뷰·병합 PR primary, 열린 이슈 success, 닫힘·커밋 muted) */
export function gitActivityIcon(it: GitActivityItem): { icon: string; cls: string } {
  if (it.kind === 'commits') return { icon: 'git-branch', cls: 'text-muted-foreground' }
  if (it.is_pull) return { icon: 'git-merge', cls: it.kind === 'pr_closed' ? 'text-muted-foreground' : 'text-primary' }
  if (it.kind === 'issue_closed') return { icon: 'issue-closed', cls: 'text-muted-foreground' }
  return { icon: 'issue-open', cls: 'text-success' }
}

function itemLink(it: GitActivityItem): string {
  const [owner, repo] = it.repo_full_name.split('/')
  if (!owner || !repo) return '/code'
  if (it.kind === 'commits') return gitPath({ owner, repo, tab: 'commits' })
  return gitPath({ owner, repo, tab: it.is_pull ? 'pulls' : 'issues', number: it.number })
}

/** 대시보드 Git 활동 카드 */
export function DashboardGitActivity() {
  const { t } = useI18n()
  const { maxRows } = useDash()
  const limit = Math.max(3, maxRows - 2)
  const [scope, setScope] = useState<Scope>('mine')
  const [connected, setConnected] = useState<boolean | null>(null)
  const [data, setData] = useState<GitActivityResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const load = useCallback(async (s: Scope) => {
    setLoading(true); setError(false)
    try {
      const r = await $fetch<GitActivityResponse>('/api/git/activity', { params: { scope: s, limit } })
      setConnected(r.connected)
      // 계정이 없으면 "내 것"이 존재하지 않음 — 범위를 [전체] 하나로 전환
      if (!r.connected && s === 'mine') { setScope('all'); return }
      setData(r)
    } catch { setError(true) } finally { setLoading(false) }
  }, [limit])
  useEffect(() => { void load(scope) }, [load, scope])
  const items = data?.items ?? []
  useCardStatus('git', loading && !data ? 'loading' : error ? 'error' : items.length ? 'ready' : 'empty')

  function headline(it: GitActivityItem): string {
    if (it.kind === 'commits') {
      return it.branch
        ? t('dashboard.gitActivity.commits', { branch: it.branch, n: it.count ?? 0 })
        : t('dashboard.gitActivity.commitsNoBranch', { n: it.count ?? 0 })
    }
    return `${t(it.is_pull ? 'dashboard.gitActivity.pr' : 'dashboard.gitActivity.issue', { n: it.number ?? '' })} ${it.title}`
  }
  function detail(it: GitActivityItem): string {
    if (it.kind === 'commits') {
      const [first, ...rest] = it.authors
      const who = first ? (rest.length ? t('dashboard.gitActivity.authorsMore', { name: first, n: rest.length }) : first) : ''
      return [it.repo_name, who].filter(Boolean).join(' · ')
    }
    return [t(`dashboard.d17.git.state.${it.kind}`), it.author].filter(Boolean).join(' · ')
  }

  const scopes = connected === false
    ? [{ value: 'all', label: t('dashboard.gitActivity.all') }]
    : [{ value: 'mine', label: t('dashboard.gitActivity.mine') }, { value: 'all', label: t('dashboard.gitActivity.all') }]
  return (
    <DashCard
      cardKey="git"
      title={t('dashboard.gitActivity.title')}
      scope={{ label: t('dashboard.gitActivity.scope'), value: scope, onChange: v => setScope(v === 'all' ? 'all' : 'mine'), items: scopes }}
      link={{ label: 'Git', to: '/code' }}
    >
      {loading && !data ? <DashRowsSkeleton rows={3} />
        : error ? <UiErrorTile placement="card" title={t('dashboard.gitActivity.loadFailed')} className="m-3.5" onRetry={() => { void load(scope) }} />
          : !items.length ? <DashRows><DashRow icon="git-branch" title={t(scope === 'mine' ? 'dashboard.gitActivity.emptyMine' : 'dashboard.gitActivity.emptyAll')} titleClass="text-muted-foreground" meta=" " /></DashRows>
            : (
              <DashRows busy={loading}>
                {items.slice(0, limit).map((it) => {
                  const ic = gitActivityIcon(it)
                  return (
                    <DashRow
                      key={`${it.kind}:${it.repo_full_name}:${it.number ?? ''}`}
                      icon={ic.icon}
                      iconClass={ic.cls}
                      title={headline(it)}
                      meta={detail(it)}
                      time={shortTime(it.at, t('common.yesterday'))}
                      to={itemLink(it)}
                    />
                  )
                })}
              </DashRows>
            )}
    </DashCard>
  )
}

export default DashboardGitActivity
