/**
 * 모바일 상단(Vue components/files/FileMobileHeader.vue · 시안 FilesMobile header 56):
 * ‹ 상위 폴더(44) · 폴더 이름 16/600 + 위치 12 muted · 검색(44) · ⋯ 보기·정렬(44).
 * 선택 모드(PatMobile): ‹ 선택 해제 · "N개 선택됨" · "전체 선택"(primary 14/600).
 * 검색: 돋보기를 누르면 같은 줄이 입력창으로 바뀐다(시안에 그림 없음 — 공통 규격 검색 입력).
 */
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { useFiles } from '~/composables/useFiles'
import { UiIconButton } from '~/components/ui/IconButton'

export interface FilesFileMobileHeaderProps {
  /** ⋯ 보기·정렬 시트 열기 */
  onOpenViewSheet?: () => void
}

export function FilesFileMobileHeader({ onOpenViewSheet }: FilesFileMobileHeaderProps) {
  const { breadcrumbs, navigateTo, view, selectedItems, setSelectedItems, sortedItems, selectAll, searchFiles, exitSearch, searchActive } = useFiles()
  const { t } = useI18n()

  const VIEW_LABEL: Record<string, string> = { 'shared-with-me': t('files.view.sharedWithMe'), recent: t('files.sidebar.recent'), starred: t('files.sidebar.starred'), links: t('files.share.linkLabel'), trash: t('files.view.trash') }

  const title = view !== 'files' ? VIEW_LABEL[view] : (breadcrumbs.at(-1)?.label ?? t('files.detail.file'))
  const parents = breadcrumbs.slice(0, -1)
  const subtitle = view !== 'files' ? t('files.detail.file') : (parents.length ? parents.map(c => c.label).join(' / ') : t('files.detail.file'))
  const parentPath = view === 'files' && breadcrumbs.length > 1 ? breadcrumbs.at(-2)!.path : null

  const selCount = selectedItems.size
  const allSelected = sortedItems.length > 0 && selCount === sortedItems.length

  // 검색
  const [searching, setSearching] = useState(false)
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firstQ = useRef(true)
  useEffect(() => {
    if (firstQ.current) { firstQ.current = false; return }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => searchFiles(q), 300)
  }, [q]) // eslint-disable-line react-hooks/exhaustive-deps
  const firstA = useRef(true)
  useEffect(() => {
    if (firstA.current) { firstA.current = false; return }
    if (!searchActive && !searching) setQ('')
    // 검색 결과가 떠 있다가 밖에서 닫혔다(경로 이동 등) — 검색 칸에 옛 검색어가 남지 않게 같이 닫는다
    else if (!searchActive && q.trim()) { if (timer.current) clearTimeout(timer.current); setSearching(false); setQ('') }
  }, [searchActive]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  // nextTick(focus)
  useEffect(() => { if (searching) inputRef.current?.focus() }, [searching])
  function openSearch() {
    setSearching(true)
  }
  function closeSearch() {
    if (timer.current) clearTimeout(timer.current)
    setSearching(false)
    setQ('')
    exitSearch()
  }

  const backCls = 'text-foreground [&>svg]:h-[22px] [&>svg]:w-[22px]'

  return (
    <header className="flex h-14 shrink-0 items-center border-b border-border px-1 md:hidden">
      {view === 'files' && selCount > 0
        ? (
          // 선택 모드
          <>
            <UiIconButton label={t('files.mobile.clearSelection')} icon="chevron-left" size="lg" className={backCls} onClick={() => setSelectedItems(new Set())} />
            <span className="flex-1 text-base font-semibold" aria-live="polite">{t('files.commandBar.selectedCount', { n: selCount })}</span>
            <button type="button" className="h-11 px-3.5 text-sm font-semibold text-primary" onClick={() => selectAll()}>{allSelected ? t('files.mobile.deselectAll') : t('files.mobile.selectAll')}</button>
          </>
        )
        : searching
          ? (
            // 검색
            <>
              <UiIconButton label={t('files.mobile.closeSearch')} icon="chevron-left" size="lg" className={backCls} onClick={closeSearch} />
              <input
                ref={inputRef}
                value={q}
                onChange={e => setQ(e.target.value)}
                type="search"
                autoComplete="off"
                aria-label={t('files.commandBar.searchHere')}
                placeholder={t('files.commandBar.searchHere')}
                className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-[15px] outline-hidden focus:border-ring focus:ring-2 focus:ring-ring/35"
                onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSearch() } }}
              />
              <span className="w-1" />
            </>
          )
          : (
            // 보통
            <>
              {parentPath
                ? <UiIconButton label={t('files.mobile.parentFolder')} icon="chevron-left" size="lg" className={backCls} onClick={() => navigateTo(parentPath)} />
                : <span className="w-3" />}
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-base font-semibold">{title}</h1>
                <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
              </div>
              {view === 'files' && <UiIconButton label={t('common.search')} icon="search" size="lg" onClick={openSearch} />}
              <UiIconButton label={t('files.mobile.viewSort')} icon="more-horizontal" size="lg" onClick={() => onOpenViewSheet?.()} />
            </>
          )}
    </header>
  )
}

export default FilesFileMobileHeader
