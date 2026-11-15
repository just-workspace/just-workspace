/**
 * AI 대화 목록(모바일, Vue components/ai/AiMobileList.vue · 시안 AIM1 AiMobile:14-16): 머리 56(h1 18/600 "AI" + 대화 검색 44)
 *  · 묶음 머리 11/600(12 16 4) · 행 min 56(제목 15/600 + 미리보기 13 muted 한 줄 · ⋮ 40)
 *  · 오른쪽 아래 확장 FAB "+ 새 대화"(56, 탭바 위). 탭바는 보인다.
 * 검색: 시안은 아이콘만 — 누르면 머리 아래에 검색 입력이 열린다(디자이너 확인 필요).
 * Wave5(시안 J2-7): 묶음 = 프로젝트(폴더 · 공유받음 배지 · 대화 수) → 최근 대화(프로젝트 밖) → 임시 대화(눈 감김 · 창 닫으면 삭제).
 */
import { Fragment, useEffect, useRef, useState } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { ApprovalsEntry } from '~/components/approvals/ApprovalsEntry'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiFab } from '~/components/ui/Fab'
import { UiBadge } from '~/components/ui/Badge'
import { UiIcon } from '~/components/ui/Icon'
import { aiConvGroup, type AiConv, type AiProject } from '~/utils/aiAssist'

export interface AiMobileListProps {
  /** 대화 목록(서버 순서) */
  conversations: AiConv[]
  /** 루트에 덧붙일 클래스 */
  className?: string
  /** 대화 열기 — id */
  onSelect?: (id: string) => void
  /** 새 대화(FAB) */
  onCreate?: () => void
  /** 이름 바꾸기 */
  onRename?: (conv: AiConv) => void
  /** 삭제 */
  onRemove?: (conv: AiConv) => void
  /** 프로젝트(내 것 + 공유받은 것) */
  projects?: AiProject[]
  /** 임시 대화 */
  temporary?: AiConv[]
  /** 프로젝트 열기 */
  onOpenProject?: (id: string) => void
}

export function AiMobileList({ conversations, className, onSelect, onCreate, onRename, onRemove, projects = [], temporary = [], onOpenProject }: AiMobileListProps) {
  const { t } = useI18n()
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const searchEl = useRef<HTMLInputElement | null>(null)

  function toggleSearch() {
    const next = !searching
    setSearching(next)
    if (!next) setQuery('')
  }
  // nextTick(() => searchEl.focus())
  useEffect(() => { if (searching) searchEl.current?.focus() }, [searching])

  const q = query.trim().toLowerCase()
  // 프로젝트 대화는 프로젝트 안에서 — 최근 대화에는 프로젝트 밖 대화만(데스크톱 사이드바와 같게)
  const projectIds = new Set(projects.map(p => p.id))
  const recent = conversations.filter(c => !c.project_id || !projectIds.has(c.project_id))
  const filtered = !q
    ? recent
    : conversations.filter(c => (c.title || '').toLowerCase().includes(q) || (c.preview || '').toLowerCase().includes(q))
  const groups = (['today', 'week', 'earlier'] as const)
    .map(k => ({ key: k, label: t(`ai.sidebar.${k}`), items: filtered.filter(c => aiConvGroup(c.updated_at) === k) }))
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

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <header className="flex h-14 shrink-0 items-center border-b border-border pl-4 pr-1">
        <h1 className="m-0 flex-1 text-lg font-semibold text-foreground">{t('ai.title')}</h1>
        <UiIconButton label={t('ai.sidebar.search')} icon="search" size="lg" noTooltip pressed={searching} className="text-muted-foreground [&>svg]:h-5 [&>svg]:w-5" onClick={toggleSearch} />
      </header>
      <ApprovalsEntry variant="mobile" />
      {searching && (
        <div className="shrink-0 border-b border-border px-4 py-2">
          <label className="block">
            <span className="sr-only">{t('ai.sidebar.search')}</span>
            <input
              ref={searchEl}
              value={query}
              type="search"
              autoComplete="off"
              placeholder={t('ai.sidebar.search')}
              className="h-10 w-full rounded-[10px] border border-input bg-background px-3 text-[15px] text-foreground placeholder:text-muted-foreground focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') toggleSearch() }}
            />
          </label>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-y-auto pb-24">
        {!q && !!projects.length && (
          <>
            <div className="px-4 pb-1 pt-3 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{t('ai.project.section')}</div>
            {projects.map(p => (
              <button
                key={p.id}
                type="button"
                className="flex min-h-14 w-full items-center gap-3 border-b border-border px-4 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => onOpenProject?.(p.id)}
              >
                <UiIcon name={p.role === 'member' ? 'users' : 'folder'} className="h-[18px] w-[18px] shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-foreground">{p.name}</span>
                {p.role === 'member'
                  ? <UiBadge tone="primary" tint size={18}>{t('ai.project.sharedWithMe')}</UiBadge>
                  : <span className="font-mono text-xs text-muted-foreground">{p.conversation_count}</span>}
              </button>
            ))}
            {!!groups.length && <div className="px-4 pb-0 pt-3 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{t('ai.project.recent')}</div>}
          </>
        )}
        {groups.map(g => (
          <Fragment key={g.key}>
            <div className="px-4 pb-1 pt-3 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{g.label}</div>
            {g.items.map(c => (
              <div key={c.id} className="flex min-h-14 items-center gap-3 border-b border-border pl-4 pr-1">
                <button type="button" className="min-w-0 flex-1 py-2 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" onClick={() => onSelect?.(c.id)}>
                  <span className="block truncate text-[15px] font-semibold text-foreground">{c.title || t('ai.untitled')}</span>
                  {c.preview && <span className="block truncate text-[13px] text-muted-foreground">{c.preview}</span>}
                </button>
                <UiMenu
                  items={rowMenu}
                  label={t('ai.sidebar.mobileRowMenu', { title: c.title || t('ai.untitled') })}
                  title={c.title || t('ai.untitled')}
                  triggerIcon="more-vertical"
                  triggerSize="md"
                  className="shrink-0 text-muted-foreground"
                  onSelect={(k: string) => onRowMenu(k, c)}
                />
              </div>
            ))}
          </Fragment>
        ))}
        {!q && !!temporary.length && (
          <>
            <div className="px-4 pb-1 pt-3 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{t('ai.temp.section')}</div>
            {temporary.map(c => (
              <button
                key={c.id}
                type="button"
                className="flex min-h-14 w-full items-center gap-3 border-b border-dashed border-border px-4 text-left text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => onSelect?.(c.id)}
              >
                <UiIcon name="eye-off" className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-[15px] text-foreground">{c.title || t('ai.untitled')}</span>
                <span className="shrink-0 text-xs">{t('ai.temp.deleteOnClose')}</span>
              </button>
            ))}
          </>
        )}
        {!conversations.length && !projects.length && !temporary.length
          ? <UiEmptyState variant="panel" icon="sparkles" title={t('ai.sidebar.empty')} />
          : q && !filtered.length
            ? <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">{t('ai.sidebar.noMatch')}</p>
            : null}
      </div>

      <UiFab label={t('ai.newChat')} extended onClick={() => onCreate?.()} />
    </div>
  )
}

export default AiMobileList
