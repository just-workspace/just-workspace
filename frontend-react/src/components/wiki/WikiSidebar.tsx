/**
 * 위키 왼쪽 트리 패널(트리 화면).
 *  데스크톱 — 스페이스 전환(▾) / 페이지 찾기 + 새 페이지(현재 페이지 아래) / 고정 / 페이지 트리 / 바닥 "스페이스 설정 · 멤버 N".
 *  모바일   — 56 헤더(스페이스명 ▾ 18/600 + "위키 · 페이지 N") + 검색 44, 트리 행 48, FAB 새 페이지.
 * 상태(인라인 새 페이지·이름 바꾸기)는 호스트(pages/wiki)가 들고, 여기는 그리기와 이벤트만.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import type { WikiPageNode, WikiSpace } from '~/composables/useWiki'
import { WikiPageTreeNode, type TreeNode, type DropPosition } from './WikiPageTreeNode'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiFab } from '~/components/ui/Fab'
import { UiTooltip } from '~/components/ui/Tooltip'

export interface WikiSidebarProps {
  space: WikiSpace | null
  tree: TreeNode[]
  pages: WikiPageNode[]
  selectedId: string | undefined
  canWrite: boolean
  /** 인라인 새 페이지 행 위치 — undefined: 없음, null: 최상위, id: 그 페이지 아래 */
  draftParentId: string | null | undefined
  renamingId: string | null
  memberCount: number | null
  searchResults: WikiPageNode[]
  mobile: boolean
  className?: string
  onSelect?: (id: string) => void
  onSpaceMenu?: (ev: MouseEvent<HTMLElement>) => void
  onNewPage?: () => void
  onAddChild?: (id: string) => void
  onMenu?: (node: TreeNode, ev: MouseEvent<HTMLElement>) => void
  onRename?: (id: string, title: string) => void
  onCancelRename?: () => void
  onCreateDraft?: (parentId: string | null, title: string) => void
  onCancelDraft?: () => void
  onMove?: (payload: { id: string; targetId: string; position: DropPosition }) => void
  onSearch?: (q: string) => void
  /** 스페이스가 하나도 없을 때 "스페이스 만들기"(모바일 빈 상태) */
  onCreateSpace?: () => void
  onOpenSettings?: () => void
}

/** 위키 트리 패널(데스크톱 aside / 모바일 전체 화면) */
export function WikiSidebar(props: WikiSidebarProps) {
  const {
    space, tree, pages, selectedId, canWrite, draftParentId, renamingId, memberCount, searchResults, mobile, className,
    onSelect, onSpaceMenu, onNewPage, onAddChild, onMenu, onRename, onCancelRename, onCreateDraft, onCancelDraft, onMove,
    onSearch, onCreateSpace, onOpenSettings,
  } = props
  const { t } = useI18n()

  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)   // 모바일: 헤더 검색 아이콘으로 입력 행을 연다
  const searchInput = useRef<HTMLInputElement | null>(null)
  const onSearchRef = useRef(onSearch); onSearchRef.current = onSearch
  // watch(query) — 첫 값은 건너뛴다
  const firstQuery = useRef(true)
  useEffect(() => {
    if (firstQuery.current) { firstQuery.current = false; return }
    const timer = setTimeout(() => onSearchRef.current?.(query), 250)
    return () => clearTimeout(timer)
  }, [query])
  function openSearch() {
    const next = !searchOpen
    setSearchOpen(next)
    if (next) requestAnimationFrame(() => searchInput.current?.focus())
    else setQuery('')
  }
  function pickResult(id: string) {
    setQuery('')
    setSearchOpen(false)
    onSelect?.(id)
  }

  const pinned = pages.filter(p => p.is_pinned)
  const initial = (space?.name ?? '').trim().charAt(0)
  const searching = query.trim().length > 0

  // 최상위 인라인 새 페이지 행
  const [rootDraft, setRootDraft] = useState('')
  const rootDraftRef = useRef(rootDraft); rootDraftRef.current = rootDraft
  const rootDraftInput = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (draftParentId === null) { setRootDraft(''); requestAnimationFrame(() => rootDraftInput.current?.focus()) }
  }, [draftParentId])
  function submitRootDraft() {
    const v = rootDraftRef.current.trim()
    if (v) onCreateDraft?.(null, v)
    else onCancelDraft?.()
  }

  const nodeBindings = {
    selectedId,
    depth: 0,
    mobile,
    canWrite,
    draftParentId: draftParentId ?? null,
    renamingId,
    onSelect: (id: string) => onSelect?.(id),
    onAddChild: (id: string) => onAddChild?.(id),
    onMenu: (n: TreeNode, e: MouseEvent<HTMLElement>) => onMenu?.(n, e),
    onRename: (id: string, v: string) => onRename?.(id, v),
    onCancelRename: () => onCancelRename?.(),
    onCreateDraft: (p: string | null, v: string) => onCreateDraft?.(p, v),
    onCancelDraft: () => onCancelDraft?.(),
    onMove: (p: { id: string; targetId: string; position: DropPosition }) => onMove?.(p),
  }

  const rootDraftKeys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); submitRootDraft() }
    else if (e.key === 'Escape') { e.preventDefault(); onCancelDraft?.() }
  }

  // ───────── 모바일 ─────────
  if (mobile) {
    return (
      <div className={cn('flex h-full min-h-0 flex-col bg-background', className)}>
        <header className="flex h-14 shrink-0 items-center border-b border-border pl-4 pr-1">
          <button
            type="button"
            className="min-w-0 flex-1 text-left"
            aria-haspopup="menu"
            aria-label={t('wiki.sidebar.switchSpace')}
            onClick={e => onSpaceMenu?.(e)}
          >
            <span className="flex items-center gap-1 text-lg font-semibold text-foreground">
              <span className="truncate">{space?.name ?? t('wiki.title')}</span>
              <UiIcon name="chevron-down" className="h-4 w-4 shrink-0" strokeWidth={2.4} />
            </span>
            <span className="block text-xs text-muted-foreground">{t('wiki.sidebar.pagesCountPrefix')} <span className="font-mono">{pages.length}</span></span>
          </button>
          <UiIconButton label={t('common.search')} icon="search" size="lg" noTooltip pressed={searchOpen} onClick={openSearch} />
        </header>
        {searchOpen && (
          <div className="shrink-0 border-b border-border px-4 py-2">
            <input
              ref={searchInput}
              value={query}
              onChange={e => setQuery(e.target.value)}
              type="search"
              autoComplete="off"
              aria-label={t('wiki.sidebar.findPage')}
              placeholder={t('wiki.sidebar.findPage')}
              className="h-11 w-full rounded-md border border-input bg-card px-3 text-[15px] text-foreground outline-hidden placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/35"
            />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto pb-24 pt-1.5" role="tree" aria-label={t('wiki.pages')}>
          {searching ? (
            <>
              {searchResults.map(r => (
                <button
                  key={r.id}
                  type="button"
                  className="flex h-12 w-full items-center px-4 text-left text-[15px] text-foreground active:bg-accent"
                  onClick={() => pickResult(r.id)}
                ><span className="truncate">{r.title}</span></button>
              ))}
              {!searchResults.length && <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('wiki.sidebar.noMatch')}</p>}
            </>
          ) : (
            <>
              {draftParentId === null && (
                <div className="flex h-12 items-center pl-12 pr-2">
                  <input
                    ref={rootDraftInput}
                    value={rootDraft}
                    onChange={e => setRootDraft(e.target.value)}
                    type="text"
                    aria-label={t('wiki.tree.newTitle')}
                    placeholder={t('wiki.tree.newTitle')}
                    className="h-10 min-w-0 flex-1 rounded-sm border border-ring bg-background px-2 text-[15px] text-foreground outline-hidden ring-2 ring-ring/35 placeholder:text-muted-foreground"
                    onKeyDown={rootDraftKeys}
                    onBlur={submitRootDraft}
                  />
                </div>
              )}
              {tree.map(node => <WikiPageTreeNode key={node.id} node={node} {...nodeBindings} />)}
              {/* 스페이스가 없으면 데스크톱과 같은 상태("스페이스가 없습니다 · 스페이스 만들기") */}
              {!space ? (
                <UiEmptyState
                  variant="panel"
                  icon="book-open"
                  title={t('wiki.noSpaces.title')}
                  description={t('wiki.noSpaces.desc')}
                  actionLabel={t('wiki.createSpace')}
                  onAction={() => onCreateSpace?.()}
                />
              ) : !tree.length && draftParentId === undefined ? (
                <UiEmptyState
                  variant="panel"
                  icon="book-open"
                  title={t('wiki.sidebar.emptyYet')}
                  description={canWrite ? t('wiki.sidebar.emptyHint') : undefined}
                />
              ) : null}
            </>
          )}
        </div>
        {canWrite && space && <UiFab label={t('wiki.createPage')} onClick={() => onNewPage?.()} />}
      </div>
    )
  }

  // ───────── 데스크톱 ─────────
  return (
    <aside className={cn('flex h-full w-[260px] shrink-0 flex-col border-r border-border bg-card px-2 py-2.5 text-[13.5px]', className)} aria-label={t('wiki.sidebar.label')}>
      <button
        type="button"
        className="flex h-9 w-full items-center gap-2 rounded-sm px-2 text-left font-semibold text-foreground hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        aria-haspopup="menu"
        aria-label={t('wiki.sidebar.switchSpace')}
        onClick={e => onSpaceMenu?.(e)}
      >
        <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-[6px] bg-primary/15 text-[11px] text-primary" aria-hidden="true">
          {initial ? initial : <UiIcon name="book-open" className="h-3 w-3" />}
        </span>
        <span className="min-w-0 flex-1 truncate">{space?.name ?? t('wiki.sidebar.pickSpace')}</span>
        <UiIcon name="chevron-down" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={2.4} />
      </button>

      <div className="mb-2.5 mt-1.5 flex gap-1.5">
        <div className="relative min-w-0 flex-1">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            type="search"
            autoComplete="off"
            aria-label={t('wiki.sidebar.findPage')}
            placeholder={t('wiki.sidebar.findPage')}
            disabled={!space}
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-hidden placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/35"
          />
        </div>
        {canWrite && (
          <UiTooltip text={t('wiki.sidebar.newUnderCurrent')}>
            <button
              type="button"
              aria-label={t('wiki.sidebar.newUnderCurrent')}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border text-foreground hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onNewPage?.()}
            ><UiIcon name="plus" className="h-3.5 w-3.5" strokeWidth={2.4} /></button>
          </UiTooltip>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* 검색 결과 */}
        {searching ? (
          <>
            <div className="px-2 pb-1 pt-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{t('board.view.search')}</div>
            {searchResults.map(r => (
              <button
                key={r.id}
                type="button"
                className="flex h-8 w-full items-center rounded-sm px-2 text-left text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                onClick={() => pickResult(r.id)}
              ><span className="truncate">{r.title}</span></button>
            ))}
            {!searchResults.length && <p className="px-2 py-4 text-xs text-muted-foreground">{t('wiki.sidebar.noMatch')}</p>}
          </>
        ) : (
          <>
            {pinned.length > 0 && (
              <>
                <div className="px-2 py-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{t('wiki.sidebar.pinnedHeading')}</div>
                {pinned.map(p => (
                  <button
                    key={`pin-${p.id}`}
                    type="button"
                    className={cn('flex h-8 w-full items-center gap-1.5 rounded-sm px-2 text-left hover:bg-accent/40 hover:text-foreground', selectedId === p.id ? 'font-semibold text-foreground' : 'text-muted-foreground')}
                    onClick={() => onSelect?.(p.id)}
                  >
                    <UiIcon name="star" filled className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">{p.title}</span>
                  </button>
                ))}
              </>
            )}

            <div className="px-2 pb-1 pt-2.5 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{t('wiki.pages')}</div>
            <div role="tree" aria-label={t('wiki.pages')}>
              {draftParentId === null && (
                <div className="flex h-8 items-center gap-1 px-1">
                  <span className="w-4 shrink-0" aria-hidden="true" />
                  <input
                    ref={rootDraftInput}
                    value={rootDraft}
                    onChange={e => setRootDraft(e.target.value)}
                    type="text"
                    aria-label={t('wiki.tree.newTitle')}
                    placeholder={t('wiki.tree.newTitle')}
                    className="h-7 min-w-0 flex-1 rounded-sm border border-ring bg-background px-2 text-[13.5px] text-foreground outline-hidden ring-2 ring-ring/35 placeholder:text-muted-foreground"
                    onKeyDown={rootDraftKeys}
                    onBlur={submitRootDraft}
                  />
                </div>
              )}
              {tree.map(node => <WikiPageTreeNode key={node.id} node={node} {...nodeBindings} />)}
            </div>
            {space && !tree.length && draftParentId === undefined && (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {t('wiki.sidebar.emptyYet')}{canWrite ? t('wiki.sidebar.emptyHintShort') : ''}
              </p>
            )}
          </>
        )}
      </div>

      {space && (
        <button
          type="button"
          className="mt-auto shrink-0 rounded-sm p-2 text-left text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground"
          onClick={() => onOpenSettings?.()}
        >{t('wiki.settings.title')}{memberCount !== null && <> · {t('wiki.settings.members')} <span className="font-mono">{memberCount}</span></>}</button>
      )}
    </aside>
  )
}

export default WikiSidebar
