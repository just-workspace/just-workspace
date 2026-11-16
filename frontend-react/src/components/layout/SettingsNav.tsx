/**
 * 설정·관리 좌측 내비: 240, "설정 찾기" 32 입력,
 * 그룹 라벨 11/600 0.08em, 항목 34(관리 32) rounded-sm, 선택 = primary/13 + 왼쪽 3px 바 + 600, 보조 글자 mono 11 / 경고 틴트 배지.
 * 검색어가 있으면 그룹 대신 일치 항목(키워드 포함)만 표시한다.
 */
import { useState, type KeyboardEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useRoute } from '~/lib/router'
import { NuxtLink } from '~/components/NuxtLink'
import { useSettingsNav } from '~/composables/useSettingsNav'
import { UiIcon } from '~/components/ui/Icon'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiBadge } from '~/components/ui/Badge'

export interface LayoutSettingsNavProps {
  scope: 'settings' | 'admin'
  /** 항목 클릭으로 이동 시 호출 */
  onNavigate?: () => void
  className?: string
}

export function LayoutSettingsNav({ scope, onNavigate, className }: LayoutSettingsNavProps) {
  const { t } = useI18n()
  const route = useRoute()
  const { groups, flat, find } = useSettingsNav(scope)
  const [q, setQ] = useState('')
  const results = find(q)

  // 하위 경로 항목이 별도로 있으면(/settings/ai/mcp) 해당 항목만 활성화한다 — 가장 길게 일치하는 항목 하나
  const matchTo = (path: string) => flat.filter(i => path === i.to || path.startsWith(i.to + '/')).sort((x, y) => y.to.length - x.to.length)[0]?.to
  const activeTo = matchTo(route.path)
  const isActive = (to: string) => to === activeTo
  function go() { setQ(''); onNavigate?.() }

  return (
    <nav aria-label={scope === 'admin' ? t('shell.adminNav.menu') : t('shell.settingsNav.menu')} className={cn('flex w-60 shrink-0 flex-col border-r border-border px-3 py-4 text-[13.5px]', className)}>
      <div className="relative mb-2.5">
        <UiIcon name="search" className="pointer-events-none absolute left-2.5 top-1/2 h-[13px] w-[13px] -translate-y-1/2 text-muted-foreground" />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          type="search"
          placeholder={t('shell.settingsNav.find')}
          aria-label={t('shell.settingsNav.find')}
          autoComplete="off"
          className="h-8 w-full rounded-md border border-input bg-card pl-7 pr-2 text-xs text-foreground outline-hidden placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/35"
          onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Escape') setQ('') }}
        />
      </div>

      {q.trim() ? (
        /* 검색 결과 */
        <>
          <div className="px-2 pb-1 pt-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{t('shell.settingsNav.results')} <span className="font-mono">{results.length}</span></div>
          {!results.length && <UiEmptyState variant="inline" title={t('shell.settingsNav.noMatch')} />}
          {results.map(r => (
            <NuxtLink
              key={r.to + (r.matched ?? '')}
              to={r.to}
              className="flex h-[34px] items-center gap-2 rounded-sm px-2.5 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
              onClick={go}
            >
              <span className="min-w-0 flex-1 truncate">{r.label}{r.matched && <span className="text-xs"> · {r.matched}</span>}</span>
              <span className="text-[11px]">{r.group}</span>
            </NuxtLink>
          ))}
        </>
      ) : (
        /* 그룹 */
        groups.map(g => (
          <div key={g.label} className="flex flex-col gap-0.5">
            <div className="px-2 pb-1 pt-2.5 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{g.label}</div>
            {g.items.map(it => (
              <NuxtLink
                key={it.to}
                to={it.to}
                aria-current={isActive(it.to) ? 'page' : undefined}
                className={cn(
                  'relative flex items-center gap-2 rounded-sm px-2.5 transition-colors',
                  scope === 'admin' ? 'h-8' : 'h-[34px]',
                  isActive(it.to) ? 'bg-primary/[0.13] font-semibold text-foreground' : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                )}
                onClick={go}
              >
                {isActive(it.to) && <span className="absolute left-0 h-3.5 w-[3px] rounded-full bg-primary" aria-hidden="true" />}
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {it.meta && it.metaTone === 'warning'
                  ? <UiBadge tone="warning" tint size={18}>{it.meta}</UiBadge>
                  : it.meta ? <span className="font-mono text-[11px]">{it.meta}</span> : null}
              </NuxtLink>
            ))}
          </div>
        ))
      )}
    </nav>
  )
}

export default LayoutSettingsNav
