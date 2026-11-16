/**
 * 저장소 안 머리: 커맨드 바 대신 제목 줄 + 밑줄 탭 2단.
 *  제목 줄: ‹(저장소 목록으로) · 소유자 / 이름 18/700 · 공개 칩 20 · ★ 스타 n · Gitea에서 열기 ↗
 *  탭 줄 40: 코드 · 이슈 n · PR · 커밋 — 라우트로 이동(/code/o/r/(issues|pulls|commits)).
 *  1024 미만: 제목 아래 한 줄 메타(설명 2줄 + 언어 · ★ · 브랜치) + "정보 더보기" 시트. 모바일 탭 44.
 * ★ 스타 = 내 스타 토글(PUT/DELETE /star). Gitea 계정이 없으면(409) 클릭 시 안내 토스트를 표시하고, 이후에는 개수만 표시한다.
 * 탭 숫자: 이슈 = 열린 이슈(저장소 값), PR = 열린 PR, 커밋 = 기본 브랜치 총수(GET /stats, 조회 실패 시 생략).
 */
import { useState } from 'react'
import { useI18n } from '~/i18n'
import type { GitTab } from '~/utils/gitRoute'
import { gitPath } from '~/utils/gitRoute'
import { gitStore, useGit } from '~/composables/useGit'
import { addToast } from '~/composables/useToast'
import { NuxtLink } from '~/components/NuxtLink'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiTabs, type TabItem } from '~/components/ui/Tabs'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { UiModal } from '~/components/ui/Modal'
import { GitRepoAbout } from './GitRepoAbout'
import { writeClipboard } from '~/lib/clipboard'

export interface GitRepoHeaderProps {
  /** 현재 탭 */
  tab: GitTab
}

/** 저장소 머리(제목 줄 + 탭 줄) */
export function GitRepoHeader({ tab }: GitRepoHeaderProps) {
  const { selectedRepo, currentBranch, branches, repoStats, starred, starUnavailable, toggleStar } = useGit()
  const { t } = useI18n()
  const [showAbout, setShowAbout] = useState(false)

  // 탭 = 라우터 링크(UiTabs to). 브랜치는 ?ref= 로 유지된다.
  // 코드 탭 경로(/code/o/r)는 다른 탭의 접두 경로이므로 정확 일치 + 폴더·파일 보기(/tree·/blob)에서도 선택 처리한다.
  const tabs: TabItem[] = (() => {
    const r = selectedRepo
    if (!r) return []
    const q = currentBranch && currentBranch !== r.default_branch ? `?ref=${encodeURIComponent(currentBranch)}` : ''
    const to = (tb: GitTab) => gitPath({ owner: r.owner.login, repo: r.name, tab: tb }) + q
    const root = gitPath({ owner: r.owner.login, repo: r.name, tab: 'code' })
    return [
      { key: 'code', label: t('git.tab.code'), to: to('code'), exact: true, activeOn: [`${root}/tree`, `${root}/blob`] },
      { key: 'issues', label: t('git.tab.issues'), to: to('issues'), count: r.open_issues_count || undefined },
      { key: 'pulls', label: 'PR', to: to('pulls'), count: repoStats?.open_pulls || undefined },
      { key: 'commits', label: t('git.tab.commits'), to: to('commits'), count: repoStats?.commits ? repoStats.commits.toLocaleString() : undefined },
    ]
  })()

  const visibility = selectedRepo?.private ? 'Private' : 'Public'

  const [starring, setStarring] = useState(false)
  async function onStar() {
    if (starring) return
    if (gitStore.getState().starUnavailable) { addToast('info', t('git.header.starUnavailable')); return }
    setStarring(true)
    try {
      if (await toggleStar() === 'unavailable') addToast('info', t('git.header.starUnavailable'))
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('git.header.starFailed'))
    } finally {
      setStarring(false)
    }
  }

  // 모바일 ⋯ 메뉴
  const [menuOpen, setMenuOpen] = useState(false)
  const menuItems: UiMenuItem[] = [
    { key: 'about', label: t('git.shared.repoInfo'), icon: 'info' },
    { key: 'star', label: starred ? t('git.header.unstar') : t('git.header.star'), icon: 'star' },
    { key: 'clone', label: t('git.header.copyClone'), icon: 'copy' },
    { key: 'gitea', label: t('git.commandBar.openInGitea'), icon: 'external-link' },
  ]
  async function onMenu(key: string) {
    const r = gitStore.getState().selectedRepo
    if (!r) return
    if (key === 'about') setShowAbout(true)
    if (key === 'star') void onStar()
    if (key === 'gitea') window.open(r.html_url, '_blank', 'noopener')
    if (key === 'clone') {
      try { await writeClipboard(r.clone_url || ''); addToast('success', t('git.shared.cloneCopied')) } catch { addToast('error', t('common.copyFailed')) }
    }
  }

  if (!selectedRepo) return null
  const r = selectedRepo
  return (
    <div className="shrink-0 bg-card">
      {/* 제목 줄 */}
      <div className="flex items-center gap-2 px-1 pt-1 md:gap-2.5 md:px-6 md:pt-3.5">
        <NuxtLink
          to="/code"
          aria-label={t('git.header.backToList')}
          title={t('git.header.backToList')}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring md:-ml-2.5 md:h-8 md:w-8"
        >
          <UiIcon name="chevron-left" className="h-5 w-5 md:h-4 md:w-4" />
        </NuxtLink>
        <h1 className="flex min-w-0 flex-1 items-baseline gap-1.5 md:flex-none">
          <span className="hidden shrink-0 text-lg text-muted-foreground md:inline">{r.owner.login} /</span>
          <span className="truncate text-[17px] font-semibold text-foreground md:text-lg md:font-bold">{r.name}</span>
        </h1>
        <span className="hidden h-5 shrink-0 items-center rounded-[5px] bg-muted px-[7px] text-[11px] font-semibold md:inline-flex">{visibility}</span>
        <span className="hidden flex-1 md:block" />
        <button
          type="button"
          className="hidden h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 md:inline-flex"
          aria-pressed={starred === true}
          aria-label={t('git.shared.starCount', { n: r.stars_count })}
          title={starUnavailable ? t('git.header.starUnavailable') : starred ? t('git.header.unstar') : t('git.header.star')}
          disabled={starring}
          onClick={() => { void onStar() }}
        >
          <UiIcon name="star" filled={starred === true} className="h-3.5 w-3.5" /> {t('git.header.star')} <span className="font-mono text-muted-foreground">{r.stars_count}</span>
        </button>
        <a
          href={r.html_url}
          target="_blank"
          rel="noopener"
          className="hidden h-8 items-center gap-1 rounded-md border border-border px-2.5 text-xs hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring md:inline-flex"
        >{t('git.commandBar.openInGitea')} <UiIcon name="external-link" className="h-3 w-3" /></a>
        <UiIconButton label={t('common.more')} icon="more-horizontal" size="lg" noTooltip className="md:hidden" onClick={() => setMenuOpen(true)} />
      </div>
      <p className="-mt-1 truncate pb-1 pl-[52px] pr-4 text-xs text-muted-foreground md:hidden">{r.owner.login} · {visibility}</p>

      {/* 1024 미만: 한 줄 메타 + 정보 더보기(코드 탭에서만) */}
      {tab === 'code' && (
        <div className="border-t border-border px-4 py-3 md:px-6 lg:hidden">
          {r.description && <p className="line-clamp-2 text-sm leading-[1.55]">{r.description}</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
            {r.language && <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-primary" aria-hidden="true" />{r.language}</span>}
            <span><UiIcon name="star" className="inline-block h-3 w-3 align-[-1px]" aria-hidden="true" /> <span className="font-mono">{r.stars_count}</span></span>
            <span>{currentBranch} · {t('git.branch.count', { n: branches.length })}</span>
            <button type="button" className="relative font-semibold text-primary before:absolute before:-inset-3 before:content-['']" onClick={() => setShowAbout(true)}>{t('git.header.moreInfo')}</button>
          </div>
        </div>
      )}

      {/* 탭 줄 */}
      <UiTabs items={tabs} ariaLabel={t('git.header.tabsAria')} className="mt-0 px-2 max-md:h-11 max-md:text-sm md:mt-2 md:px-6 md:[&>button:first-child]:-ml-3" />

      {menuOpen && (
        <UiMenu dense width={220} items={menuItems} anchor={null} title={r.full_name} onSelect={(k) => { void onMenu(k) }} onClose={() => setMenuOpen(false)} />
      )}
      {showAbout && (
        <UiModal title={t('git.shared.repoInfo')} onClose={() => setShowAbout(false)}>
          <GitRepoAbout />
        </UiModal>
      )}
    </div>
  )
}

export default GitRepoHeader
