/**
 * 데스크톱 커맨드 바(Vue components/files/FileCommandBar.vue · 시안 FilesDesktop): 44 · bg-card · border-b,
 * 순서 경로 → 검색(180) → 보기 세그먼트 → 업로드(outline 32) → 새로 만들기 ▾(primary 32).
 * 선택 모드(결정 3 ②): 하나라도 고르면 바가 바뀐다 — primary/10 바탕 + primary/35 밑줄, ✕(선택 해제 Esc) · "N개 선택" ·
 * 공유 · 이동 · 다운로드 · 삭제(32, 12px) · 오른쪽 "모두 선택".
 * 업로드 진행은 전송 패널 한 곳(결정 9) — 업로드 버튼은 파일 고르기만 연다(진행 모달 폐지).
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { clsx } from 'clsx'
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { useClickOutside } from '~/lib/dom'
import { useFiles } from '~/composables/useFiles'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiSegment } from '~/components/ui/Segment'
import { FilesFileBreadcrumb } from './FileBreadcrumb'
import { FilesFileTypeIcon } from './FileTypeIcon'

export interface FilesFileCommandBarProps {
  className?: string
  /** 업로드할 파일을 골랐다 */
  onUpload?: (files: File[]) => void
  onNewFolder?: () => void
  onNewDoc?: () => void
  onNewSheet?: () => void
  onNewSlide?: () => void
  onBulkShare?: () => void
  onBulkMove?: () => void
  onBulkDownload?: () => void
  /** 선택 항목을 서버에서 압축해 내려받기(S4 — AI 압축과 같은 작업) */
  onBulkZip?: () => void
  /** 지금 검색 결과 전부를 압축해 내려받기 */
  onSearchZip?: () => void
  onBulkDelete?: () => void
  /** 휴지통 비우기(휴지통 뷰) */
  onEmptyTrash?: () => void
  /** 경로 조각에 끌어다 놓음 */
  onDropMove?: (paths: string[], dst: string) => void
}

// 선택 모드 액션 — 시안 selActs(공용 아이콘)
const SEL_ACTS = [
  { key: 'share', labelKey: 'common.share', icon: 'share-up' },
  { key: 'move', labelKey: 'common.move', icon: 'folder-move' },
  { key: 'download', labelKey: 'common.download', icon: 'download' },
  { key: 'zip', labelKey: 'files.zip.action', icon: 'file-zip' },
  { key: 'delete', labelKey: 'common.delete', icon: 'trash' },
] as const

export function FilesFileCommandBar(props: FilesFileCommandBarProps) {
  const { className } = props
  const { viewMode, setViewMode, selectedItems, setSelectedItems, sortedItems, selectAll, searchFiles, exitSearch, searchActive, view, trashItems } = useFiles()
  const { t } = useI18n()

  // ── 검색(이 폴더 아래 재귀, 300ms) ──
  const [searchInput, setSearchInput] = useState('')
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firstInput = useRef(true)
  useEffect(() => {
    if (firstInput.current) { firstInput.current = false; return }
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => searchFiles(searchInput), 300)
  }, [searchInput]) // eslint-disable-line react-hooks/exhaustive-deps
  const firstActive = useRef(true)
  useEffect(() => {
    if (firstActive.current) { firstActive.current = false; return }
    if (!searchActive && searchInput) setSearchInput('')
  }, [searchActive]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current) }, [])
  function clearSearch() {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    setSearchInput('')
    exitSearch()
  }

  const selCount = selectedItems.size
  const allSelected = sortedItems.length > 0 && selCount === sortedItems.length
  function clearSelection() { setSelectedItems(new Set()) }

  // ── 새로 만들기 ▾ ──
  const [showNew, setShowNew] = useState(false)
  const newWrap = useRef<HTMLDivElement | null>(null)
  useClickOutside(newWrap, () => setShowNew(false))
  const fileInput = useRef<HTMLInputElement | null>(null)
  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const input = e.target
    const files = Array.from(input.files || [])
    if (files.length) props.onUpload?.(files)
    input.value = ''
  }
  function newItem(kind: 'folder' | 'doc' | 'sheet' | 'slide') {
    setShowNew(false)
    if (kind === 'folder') props.onNewFolder?.()
    else if (kind === 'doc') props.onNewDoc?.()
    else if (kind === 'sheet') props.onNewSheet?.()
    else props.onNewSlide?.()
  }

  function selAct(key: typeof SEL_ACTS[number]['key']) {
    if (key === 'share') props.onBulkShare?.()
    else if (key === 'move') props.onBulkMove?.()
    else if (key === 'download') props.onBulkDownload?.()
    else if (key === 'zip') props.onBulkZip?.()
    else props.onBulkDelete?.()
  }

  const viewItems = [
    { value: 'list', icon: 'list', ariaLabel: t('files.commandBar.list') },
    { value: 'grid', icon: 'grid', ariaLabel: t('files.commandBar.grid') },
  ]
  const setView = (v: string | number | null) => { if (v === 'list' || v === 'grid') setViewMode(v) }

  // 선택 모드
  if (view === 'files' && selCount > 0) {
    return (
      <div
        role="toolbar"
        aria-label={t('files.selectBar.label')}
        className={cn('flex h-11 shrink-0 items-center gap-1 border-b border-primary/35 bg-primary/10 px-2.5 text-[13px]', className)}
      >
        <UiIconButton label={t('files.commandBar.clearSelection')} icon="close" onClick={clearSelection} />
        <b className="mr-3 font-semibold" aria-live="polite">{t('files.commandBar.selected', { n: selCount })}</b>
        {SEL_ACTS.filter(a => a.key !== 'zip' || props.onBulkZip).map(a => (
          <button
            key={a.key}
            type="button"
            className={clsx(
              'inline-flex h-8 items-center gap-1.5 rounded-sm px-2.5 text-xs font-medium transition-colors hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
              a.key === 'delete' ? 'text-danger hover:bg-danger/10' : '',
            )}
            onClick={() => selAct(a.key)}
          >
            <UiIcon name={a.icon} className="h-[15px] w-[15px]" />
            {t(a.labelKey)}
          </button>
        ))}
        <span className="flex-1" />
        <button
          type="button"
          className="h-8 rounded-sm px-2 text-xs font-semibold text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => selectAll()}
        >{allSelected ? t('files.commandBar.deselectAll') : t('files.commandBar.selectAll')}</button>
      </div>
    )
  }

  // 보통
  return (
    <div className={cn('flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card pl-3.5 pr-2.5 text-[13px]', className)}>
      <FilesFileBreadcrumb className="min-w-0 flex-1" onDropMove={(p, d) => props.onDropMove?.(p, d)} />

      {view === 'files'
        ? (
          <>
            <div className="relative w-[180px] shrink-0">
              <UiIcon name="search" className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                type="search"
                autoComplete="off"
                aria-label={t('files.commandBar.searchHere')}
                placeholder={t('files.commandBar.searchHere')}
                className="h-8 w-full rounded-md border border-input bg-background pl-7 pr-7 text-xs outline-hidden transition-[box-shadow,border-color] placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/35 [&::-webkit-search-cancel-button]:hidden"
                onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); clearSearch() } }}
              />
              {searchInput && (
                <button
                  type="button"
                  aria-label={t('files.commandBar.clearSearch')}
                  className="absolute right-0 top-0 grid h-8 w-8 place-items-center text-muted-foreground hover:text-foreground"
                  onClick={clearSearch}
                ><UiIcon name="close" className="h-3.5 w-3.5" /></button>
              )}
            </div>

            {searchActive && props.onSearchZip && (
              <button
                type="button"
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-xs transition-colors hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => props.onSearchZip?.()}
              ><UiIcon name="file-zip" className="h-3.5 w-3.5" />{t('files.zip.searchAction')}</button>
            )}

            <UiSegment modelValue={viewMode} onUpdateModelValue={setView} items={viewItems} ariaLabel={t('files.commandBar.view')} />

            <button
              type="button"
              className="inline-flex h-8 shrink-0 items-center rounded-md border border-border px-3 text-xs transition-colors hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => fileInput.current?.click()}
            >{t('files.commandBar.upload')}</button>
            <input ref={fileInput} type="file" multiple className="hidden" tabIndex={-1} aria-hidden="true" onChange={onPick} />

            {/* Esc 는 감싸는 칸에서 — 포커스가 버튼에 남아 있어 메뉴 칸만으로는 안 닫히고 페이지(선택 해제)로 갔다 */}
            <div ref={newWrap} className="relative shrink-0" onKeyDown={(e) => { if (showNew && e.key === 'Escape') { e.stopPropagation(); setShowNew(false) } }}>
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={showNew}
                className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background"
                onClick={() => setShowNew(v => !v)}
              >
                {t('files.commandBar.newMenu')}
                <UiIcon name="chevron-down" className="h-3 w-3" strokeWidth={2.4} />
              </button>
              {showNew && (
                <div
                  role="menu"
                  aria-label={t('files.commandBar.newMenu')}
                  className="absolute right-0 top-full z-dropdown mt-1 w-56 rounded-lg border border-border bg-popover p-1 shadow-md"
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setShowNew(false) } }}
                >
                  <button type="button" role="menuitem" className="flex h-9 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-sm hover:bg-accent/40" onClick={() => newItem('folder')}>
                    <FilesFileTypeIcon kind="folder" className="h-[15px] w-[15px]" />{t('files.commandBar.newFolder')}
                  </button>
                  <div className="my-1 border-t border-border" role="separator" />
                  <button type="button" role="menuitem" className="flex h-9 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-sm hover:bg-accent/40" onClick={() => newItem('doc')}>
                    <FilesFileTypeIcon kind="doc" className="h-[15px] w-[15px]" />{t('files.commandBar.newDoc')}
                  </button>
                  <button type="button" role="menuitem" className="flex h-9 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-sm hover:bg-accent/40" onClick={() => newItem('sheet')}>
                    <FilesFileTypeIcon kind="sheet" className="h-[15px] w-[15px]" />{t('files.commandBar.newSheet')}
                  </button>
                  <button type="button" role="menuitem" className="flex h-9 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-sm hover:bg-accent/40" onClick={() => newItem('slide')}>
                    <FilesFileTypeIcon kind="slide" className="h-[15px] w-[15px]" />{t('files.commandBar.newSlide')}
                  </button>
                </div>
              )}
            </div>
          </>
        )
        : view === 'trash' && trashItems.length
          ? (
            <button
              type="button"
              className="inline-flex h-8 shrink-0 items-center rounded-md border border-danger/40 px-3 text-xs font-medium text-danger transition-colors hover:bg-danger/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => props.onEmptyTrash?.()}
            >{t('files.trash.empty')}</button>
          )
          : null}
    </div>
  )
}

export default FilesFileCommandBar
