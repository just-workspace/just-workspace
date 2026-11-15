// Vue 원본: frontend/components/git/GitBranchSelector.vue
// 브랜치 선택("⑂ main ▾"). 고르면 ?ref= 로 라우트를 바꾼다(코드·커밋 탭이 따라 다시 불린다).
// 브랜치 검색·만들기·태그는 ★백엔드 갭(브랜치 목록만 있음).
import { useState, type MouseEvent } from 'react'
import { useI18n } from '~/i18n'
import { navigateTo, useRoute } from '~/lib/router'
import { useGit } from '~/composables/useGit'
import { UiIcon } from '~/components/ui/Icon'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'

/** 브랜치 고르기 버튼 + 메뉴 */
export function GitBranchSelector() {
  const { t } = useI18n()
  const { branches, currentBranch, selectedRepo } = useGit()
  const route = useRoute()
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [open, setOpen] = useState(false)

  const items: UiMenuItem[] = branches.map(b => ({
    key: b.name,
    label: b.name,
    icon: 'git-branch',
    radio: true,
    checked: b.name === currentBranch,
    hint: b.name === selectedRepo?.default_branch ? t('common.default') : undefined,
  }))

  function toggle(e: MouseEvent<HTMLButtonElement>) {
    setAnchor(e.currentTarget.getBoundingClientRect())
    setOpen(v => !v)
  }

  function select(name: string) {
    const q: Record<string, unknown> = { ...route.query }
    if (name === selectedRepo?.default_branch) delete q.ref
    else q.ref = name
    void navigateTo({ path: route.path, query: q })
  }

  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('git.branch.aria', { name: currentBranch })}
        className="inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-md border border-border px-2.5 text-[13px] hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring max-md:h-10"
        onClick={toggle}
      >
        <UiIcon name="git-branch" className="h-[13px] w-[13px] shrink-0 text-muted-foreground" />
        <span className="truncate">{currentBranch || t('git.branch.menu')}</span>
        <UiIcon name="chevron-down" className="h-3 w-3 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <UiMenu dense items={items} anchor={anchor} title={t('git.branch.menu')} align="start" width={260} onSelect={select} onClose={() => setOpen(false)} />
      )}
    </>
  )
}

export default GitBranchSelector
