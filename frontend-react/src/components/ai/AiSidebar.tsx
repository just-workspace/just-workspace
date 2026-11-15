/**
 * AI 대화 사이드바(데스크톱, Vue components/ai/AiSidebar.vue).
 *  [+ 새 대화](primary 36) + [접기] → 대화 검색(서버: 제목+본문, 결과 행 = 제목 + 일치 조각 강조 · 프로젝트/날짜)
 *  → 프로젝트(＋ 만들기, 행 = 폴더/공유 아이콘 · 이름 · 내 대화 수 mono) → 최근 대화(오늘·이번 주·이전, 프로젝트 대화 제외)
 *  → 임시 대화(점선 행 · 눈 감은 아이콘 · "창 닫으면 삭제"). 아래 고정: AI 설정 · 개인 키 · 연결된 도구.
 */
import { Fragment, useEffect, useRef, useState } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { NuxtLink } from '~/components/NuxtLink'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { ApprovalsEntry } from '~/components/approvals/ApprovalsEntry'
import { aiConvGroup, aiHighlightParts, type AiConv, type AiProject, type AiSearchResult } from '~/utils/aiAssist'

export interface AiSidebarProps {
  /** 대화 목록(서버 순서, 임시 대화 제외) */
  conversations: AiConv[]
  /** 임시 대화 */
  temporary?: AiConv[]
  /** 볼 수 있는 프로젝트 */
  projects?: AiProject[]
  /** 열린 대화 id */
  activeId: string | null
  /** 열린 프로젝트 id */
  activeProjectId?: string | null
  /** 관리자 — "AI 설정" 링크가 /admin/ai 로 */
  isAdmin?: boolean
  /** 개인 API 키 허용 — "개인 키" 링크 */
  allowUserKeys?: boolean
  /** 대화 열기 */
  onSelect?: (id: string) => void
  /** 새 대화 */
  onCreate?: () => void
  /** 사이드바 접기 */
  onCollapse?: () => void
  /** 이름 바꾸기(⋯ · 더블클릭) */
  onRename?: (conv: AiConv) => void
  /** 삭제 */
  onRemove?: (conv: AiConv) => void
  /** 프로젝트 열기 */
  onOpenProject?: (id: string) => void
  /** 프로젝트 만들기 */
  onCreateProject?: () => void
}

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v)
  useEffect(() => { const h = setTimeout(() => setD(v), ms); return () => clearTimeout(h) }, [v, ms])
  return d
}

export function AiSidebar({
  conversations, temporary = [], projects = [], activeId, activeProjectId, isAdmin, allowUserKeys,
  onSelect, onCreate, onCollapse, onRename, onRemove, onOpenProject, onCreateProject,
}: AiSidebarProps) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const q = useDebounced(query.trim(), 250)
  const [results, setResults] = useState<AiSearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    if (!q) { setResults(null); return }
    const my = ++seq.current
    setSearching(true)
    $fetch<{ results: AiSearchResult[] }>(`/api/ai/search?q=${encodeURIComponent(q)}`, { credentials: 'include' })
      .then((r) => { if (my === seq.current) setResults(r?.results || []) })
      .catch(() => { if (my === seq.current) setResults([]) })
      .finally(() => { if (my === seq.current) setSearching(false) })
  }, [q])

  const projectIds = new Set(projects.map(p => p.id))
  // 프로젝트 대화는 프로젝트 안에서 — 볼 수 없는 프로젝트(공유 해제 등)의 대화는 최근 대화로
  const recent = conversations.filter(c => !c.project_id || !projectIds.has(c.project_id))
  const groups = (['today', 'week', 'earlier'] as const)
    .map(k => ({ key: k, label: t(`ai.sidebar.${k}`), items: recent.filter(c => aiConvGroup(c.updated_at) === k) }))
    .filter(g => g.items.length)

  const rowMenu: UiMenuItem[] = [
    { key: 'rename', label: t('ai.menu.rename'), icon: 'edit' },
    { key: 'pin', label: t('ai.menu.pin'), icon: 'pin', disabled: true, badge: t('ai.menu.soon') },
    { key: 'delete', label: t('ai.menu.delete'), icon: 'trash', danger: true, separated: true },
  ]

  function onRowMenu(key: string, c: AiConv) {
    if (key === 'rename') onRename?.(c)
    else if (key === 'delete') onRemove?.(c)
  }

  const head = 'flex items-center px-2 pb-1 pt-3 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground'

  function convRow(c: AiConv) {
    return (
      <div
        key={c.id}
        className={cn(
          'group relative flex h-[34px] items-center rounded-lg',
          activeId === c.id ? 'bg-primary/[0.13] font-semibold text-foreground' : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
        )}
      >
        <button
          type="button"
          className="h-full min-w-0 flex-1 truncate rounded-lg pl-2.5 pr-1 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          aria-current={activeId === c.id ? 'true' : undefined}
          onClick={() => onSelect?.(c.id)}
          onDoubleClick={() => onRename?.(c)}
        >{c.title || t('ai.untitled')}</button>
        {/* ⋯: 선택 행은 늘, 나머지는 hover·키보드 포커스 때 */}
        <UiMenu
          items={rowMenu}
          label={t('ai.sidebar.rowMenu')}
          className={cn('mr-1 shrink-0', activeId === c.id ? '' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100')}
          onSelect={(k: string) => onRowMenu(k, c)}
          trigger={({ toggle, open, controls }) => (
            <button
              type="button"
              aria-label={t('ai.sidebar.rowMenu')}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-controls={controls}
              className="relative grid h-[26px] w-[26px] place-items-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring before:absolute before:-inset-[7px] before:content-['']"
              onClick={(e) => { e.stopPropagation(); toggle() }}
            >
              <UiIcon name="more-horizontal" className="h-4 w-4" />
            </button>
          )}
        />
      </div>
    )
  }

  const projectName = (id?: string | null) => (id ? projects.find(p => p.id === id)?.name : undefined)
  const shortDate = (v?: string | null) => {
    if (!v) return ''
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? '' : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  return (
    <aside aria-label={t('ai.sidebar.label')} className="flex w-sidebar shrink-0 flex-col border-r border-border bg-card px-2.5 py-3 text-[13.5px]">
      <div className="mb-2.5 flex gap-1.5">
        <button
          type="button"
          className="flex h-9 flex-1 items-center justify-center gap-1 rounded-[10px] bg-primary text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background"
          onClick={() => onCreate?.()}
        >
          <UiIcon name="plus" className="h-3.5 w-3.5" />{t('ai.newChat')}
        </button>
        <UiIconButton
          label={t('ai.sidebar.collapse')}
          icon="panel-left"
          variant="outline"
          className="h-9 w-9 rounded-[10px] text-muted-foreground [&>svg]:h-[15px] [&>svg]:w-[15px]"
          onClick={() => onCollapse?.()}
        />
      </div>
      <label className="relative mb-1.5 block">
        <span className="sr-only">{t('ai.search.placeholder')}</span>
        <UiIcon name="search" className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          type="search"
          autoComplete="off"
          placeholder={t('ai.search.placeholder')}
          className="h-8 w-full rounded-[10px] border border-input bg-background pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          onChange={e => setQuery(e.target.value)}
        />
      </label>

      <nav className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {query.trim() ? (
          // 검색 결과
          <div aria-label={t('ai.search.results')} role="region" aria-busy={searching}>
            {(results ?? []).map(r => (
              <button
                key={r.id}
                type="button"
                className={cn('flex w-full flex-col gap-0.5 rounded-lg p-2.5 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring', activeId === r.id ? 'bg-accent' : 'hover:bg-accent/40')}
                onClick={() => onSelect?.(r.id)}
              >
                <span className="truncate text-[13.5px] text-foreground">
                  {r.match === 'title' ? <Highlight text={r.title || t('ai.untitled')} q={query} /> : (r.title || t('ai.untitled'))}
                </span>
                {(r.snippet || projectName(r.project_id) || r.updated_at) && (
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {r.snippet && <Highlight text={r.snippet} q={query} />}
                    {r.snippet && ' · '}
                    {projectName(r.project_id) || <span className="font-mono">{shortDate(r.updated_at)}</span>}
                  </span>
                )}
              </button>
            ))}
            {searching && results === null && <p className="px-2.5 py-2 text-xs text-muted-foreground" role="status">{t('ai.search.searching')}</p>}
            {results !== null && !results.length && <p className="px-2 py-4 text-center text-xs text-muted-foreground">{t('ai.search.none')}</p>}
            <p className="mx-2.5 mt-1 text-xs text-muted-foreground">{t('ai.search.tempNote')}</p>
          </div>
        ) : (
          <>
            {/* 프로젝트 */}
            <div className={head}>
              <span className="flex-1">{t('ai.project.section')}</span>
              {onCreateProject && (
                <UiIconButton label={t('ai.project.create')} icon="plus" size="sm" className="-my-1 h-7 w-7" onClick={() => onCreateProject()} />
              )}
            </div>
            {projects.map(p => (
              <button
                key={p.id}
                type="button"
                aria-current={activeProjectId === p.id ? 'true' : undefined}
                className={cn(
                  'flex h-[34px] w-full items-center gap-2 rounded-lg px-2.5 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                  activeProjectId === p.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                )}
                onClick={() => onOpenProject?.(p.id)}
              >
                <UiIcon name={p.role === 'member' ? 'users' : 'folder'} className={cn('h-4 w-4 shrink-0', activeProjectId === p.id && 'text-primary')} />
                <span className="min-w-0 flex-1 truncate">
                  {p.name}
                  {p.role === 'member' && <span className="text-[11.5px]"> {t('ai.project.sharedSuffix')}</span>}
                </span>
                <span className="font-mono text-[11.5px] text-muted-foreground">{p.conversation_count}</span>
              </button>
            ))}

            {/* 최근 대화 */}
            {groups.map(g => (
              <Fragment key={g.key}>
                <div className={head}>{g.label}</div>
                {g.items.map(convRow)}
              </Fragment>
            ))}
            {!recent.length && !temporary.length && <p className="px-2 py-4 text-center text-xs text-muted-foreground">{t('ai.sidebar.empty')}</p>}

            {/* 임시 대화 */}
            {!!temporary.length && (
              <>
                <div className={head}>{t('ai.temp.section')}</div>
                {temporary.map(c => (
                  <button
                    key={c.id}
                    type="button"
                    aria-current={activeId === c.id ? 'true' : undefined}
                    className={cn(
                      'mb-1 flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-2.5 py-2 text-left text-[13px] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                      activeId === c.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                    )}
                    onClick={() => onSelect?.(c.id)}
                  >
                    <UiIcon name="eye-off" className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{c.title || t('ai.untitled')}</span>
                    <span className="shrink-0 text-[11.5px]">{t('ai.temp.deleteOnClose')}</span>
                  </button>
                ))}
              </>
            )}
          </>
        )}
      </nav>

      <ApprovalsEntry className="mt-1.5" />
      <div className="mt-auto flex flex-wrap items-center gap-x-1 p-2 text-xs text-muted-foreground">
        <NuxtLink to={isAdmin ? '/admin/ai' : '/settings/ai'} className="hover:text-foreground hover:underline">{t('ai.sidebar.settings')}</NuxtLink>
        {allowUserKeys && (
          <>
            <span aria-hidden="true">·</span>
            <NuxtLink to="/settings/ai" className="hover:text-foreground hover:underline">{t('ai.sidebar.keys')}</NuxtLink>
          </>
        )}
        <span aria-hidden="true">·</span>
        <NuxtLink to="/settings/ai/mcp" className="hover:text-foreground hover:underline">{t('ai.sidebar.tools')}</NuxtLink>
      </div>
    </aside>
  )
}

function Highlight({ text, q }: { text: string; q: string }) {
  const parts = aiHighlightParts(text, q)
  if (parts.length < 3) return <>{text}</>
  return <>{parts[0]}<mark className="rounded-sm bg-warning/25 text-inherit">{parts[1]}</mark>{parts[2]}</>
}

export default AiSidebar
