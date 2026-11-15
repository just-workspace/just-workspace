// Vue 원본: frontend/components/git/GitPathCrumbs.vue
// 코드 경로(저장소 이름 / 폴더 / … / 현재). 앞 조각은 tree 링크, 마지막은 글자. 가로로 넘치면 스크롤.
import { Fragment } from 'react'
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { useGit } from '~/composables/useGit'
import { gitPath } from '~/utils/gitRoute'
import { NuxtLink } from '~/components/NuxtLink'

export interface GitPathCrumbsProps {
  /** 저장소 안 경로(빈 문자열 = 루트 — 그리지 않는다) */
  path: string
  className?: string
}

/** 코드 경로 브레드크럼 */
export function GitPathCrumbs({ path, className }: GitPathCrumbsProps) {
  const { selectedRepo, currentBranch } = useGit()
  const { t } = useI18n()

  const r = selectedRepo
  if (!r || !path) return null
  const query = currentBranch && currentBranch !== r.default_branch ? { ref: currentBranch } : {}
  const parts = path.split('/')
  const segs = parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/'), last: i === parts.length - 1 }))

  return (
    <nav aria-label={t('git.path.aria')} className={cn('flex min-w-0 items-center gap-1 overflow-x-auto whitespace-nowrap text-sm scrollbar-none', className)}>
      <NuxtLink to={{ path: gitPath({ owner: r.owner.login, repo: r.name }), query }} className="shrink-0 font-semibold text-primary hover:underline">{r.name}</NuxtLink>
      {segs.map(s => (
        <Fragment key={s.path}>
          <span className="shrink-0 text-muted-foreground" aria-hidden="true">/</span>
          {s.last
            ? <span className="shrink-0 font-semibold text-foreground" aria-current="page">{s.name}</span>
            : <NuxtLink to={{ path: gitPath({ owner: r.owner.login, repo: r.name, path: s.path, kind: 'tree' }), query }} className="shrink-0 text-primary hover:underline">{s.name}</NuxtLink>}
        </Fragment>
      ))}
    </nav>
  )
}

export default GitPathCrumbs
