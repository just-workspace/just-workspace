/**
 * 파일 목록(Vue components/files/FileList.vue · "조밀 40 — 표·파일·로그").
 * 데스크톱: 열 40 · 이름 · 소유자 120 · 수정 120 · 크기 80 · ⋮ 40, 행 40, 헤더 36 11px.
 * 소유자 열은 서버 owner(my/=나, shared/=처음 올린 사람, 모르면 —). 즐겨찾기는 이름 옆 채운 별(warning 12).
 * 모바일: 행 56 — 유형 아이콘 22 · 이름 15 + 공유 아이콘 · mono 메타 11 · ⋮ 40 상시.
 * 클릭 = 열기, Ctrl/⌘ 클릭 = 선택 토글, Shift 클릭 = 범위, Space = 상세, ↑↓ 이동, Enter 열기.
 * 체크박스·⋮ 는 hover/포커스 때(터치 기기는 상시), 하나라도 고르면 전 행 상시. 길게 누르기 = 선택 모드.
 * 새 폴더·이름 바꾸기는 인라인 편집 행(Enter/Esc). 행은 끌어서 폴더·경로·사이드바에 놓으면 이동.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { clsx } from 'clsx'
import { useI18n } from '~/i18n'
import { useFiles, type FileItem } from '~/composables/useFiles'
import { useIsMobile } from '~/composables/useIsMobile'
import { useAuth } from '~/composables/useAuth'
import { formatDay, formatSize, formatStamp, isComposingKey, parentLabel, rangeBetween, type FilesTranslate } from '~/lib/files'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiBadge } from '~/components/ui/Badge'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { FilesFileTypeIcon } from './FileTypeIcon'
import { FilesFileListError } from './FileListError'
import { revealClass, useInlineEdit, useLongPress, useRowDrag, useToggleWithAnchor } from './internal'

export interface FilesFileListProps {
  /** 행 열기(클릭·Enter) */
  onOpen?: (item: FileItem) => void
  /** ⋮·우클릭 메뉴 */
  onMenu?: (event: MouseEvent, item: FileItem) => void
  /** 상세(Space) */
  onDetail?: (item: FileItem) => void
  onDropMove?: (paths: string[], dst: string) => void
  onCommitNewFolder?: (name: string) => void
  onCommitRename?: (item: FileItem, name: string) => void
}

export function FilesFileList({ onOpen, onMenu, onDetail, onDropMove, onCommitNewFolder, onCommitRename }: FilesFileListProps) {
  const {
    sortedItems, sortField, sortDir, toggleSort, selectedItems, setSelectedItems, selectAll,
    loading, searchActive, isShared, listError,
  } = useFiles()
  const isMobile = useIsMobile()
  const { t } = useI18n()
  const { user } = useAuth()
  const tr: FilesTranslate = (k, p) => t(k, p ?? {})

  const anySelected = selectedItems.size > 0
  const isAllSelected = sortedItems.length > 0 && selectedItems.size === sortedItems.length
  const order = sortedItems.map(i => i.path)

  // ── 선택 ──
  const { anchor, onToggle } = useToggleWithAnchor()
  function setSelection(paths: string[]) { setSelectedItems(new Set(paths)) }

  const { inlineEdit, editName, setEditName, commitEdit, cancelEdit, setEditInput, isRenaming } = useInlineEdit({ sortedItems, onCommitNewFolder, onCommitRename })
  const press = useLongPress(onToggle)

  function onRowClick(e: MouseEvent, item: FileItem) {
    if (press.consumeSuppressed()) return
    if (inlineEdit?.kind === 'rename' && inlineEdit.path === item.path) return
    if (e.metaKey || e.ctrlKey) { onToggle(item); return }
    if (e.shiftKey) { setSelection(rangeBetween(order, anchor.current, item.path)); return }
    // 모바일 선택 모드에서는 탭 = 선택 토글
    if (isMobile && anySelected) { onToggle(item); return }
    onOpen?.(item)
  }

  // ── 키보드(행 포커스 이동) ──
  const [focusIndex, setFocusIndex] = useState(0)
  const rowEls = useRef<HTMLElement[]>([])
  const pendingFocus = useRef<number | null>(null)
  useEffect(() => {
    const n = sortedItems.length
    if (focusIndex >= n) setFocusIndex(Math.max(0, n - 1))
  }, [sortedItems.length]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (pendingFocus.current === null) return
    const i = pendingFocus.current
    pendingFocus.current = null
    rowEls.current[i]?.focus()
  })
  function focusRow(i: number) {
    const n = sortedItems.length
    if (!n) return
    const k = Math.max(0, Math.min(n - 1, i))
    if (k === focusIndex) { rowEls.current[k]?.focus(); return }
    setFocusIndex(k)
    pendingFocus.current = k
  }
  function onRowKey(e: KeyboardEvent, item: FileItem, i: number) {
    if (e.target !== e.currentTarget) return   // 안쪽 버튼·입력은 각자 처리
    if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(i + 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(i - 1) }
    else if (e.key === 'Home') { e.preventDefault(); focusRow(0) }
    else if (e.key === 'End') { e.preventDefault(); focusRow(sortedItems.length - 1) }
    else if (e.key === 'Enter') { e.preventDefault(); onOpen?.(item) }
    else if (e.key === ' ') { e.preventDefault(); onDetail?.(item) }
    else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); setSelection(order) }
  }

  // ── 정렬 헤더 ──
  function ariaSort(f: 'name' | 'modified_at' | 'size') {
    return sortField === f ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'
  }

  // ── 끌어서 이동 ──
  const drag = useRowDrag(onDropMove)

  function owner(item: FileItem) {
    const o = item.owner
    if (o) return o.id && o.id === user?.id ? t('files.detail.me') : o.name
    return item.path.startsWith('my/') ? t('files.detail.me') : '—'
  }
  function mobileMeta(item: FileItem) {
    if (searchActive) return parentLabel(item.path, tr)
    if (item.is_dir) return t('files.detail.folder')
    return [formatSize(item.size), formatDay(item.modified_at)].filter(Boolean).join(' · ')
  }

  const revealCls = revealClass(anySelected)

  function editKeys(e: KeyboardEvent<HTMLInputElement>) {
    if (isComposingKey(e)) return   // 한글 조합 중 Enter = 글자 확정
    if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit() }
  }

  function sortHeader(f: 'name' | 'modified_at' | 'size', label: string) {
    return (
      <button type="button" className={clsx('inline-flex items-center gap-1 hover:text-foreground', sortField === f ? 'text-foreground' : '')} onClick={() => toggleSort(f)}>
        {label}{sortField === f && <UiIcon name={sortDir === 'asc' ? 'chevron-up' : 'chevron-down'} className="h-3 w-3 text-primary" strokeWidth={2.6} />}
      </button>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto pb-24 md:pb-0">
      {/* 로딩 */}
      {loading
        ? <UiSkeleton preset="list" rows={8} className="pt-1" />
        : listError && !searchActive
          ? <FilesFileListError />
          : sortedItems.length || inlineEdit?.kind === 'new-folder'
          ? (
            <div
              role="grid"
              aria-label={t('files.detail.file')}
              aria-multiselectable={true}
              aria-rowcount={sortedItems.length}
              className="text-[13px]"
            >
              {/* 헤더(데스크톱) */}
              <div role="row" className="sticky top-0 z-10 hidden h-9 grid-cols-[40px_1fr_120px_120px_80px_40px] items-center border-b border-border bg-background pr-2 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground md:grid">
                <span role="columnheader" className="grid place-items-center">
                  <UiCheckbox modelValue={isAllSelected} indeterminate={anySelected && !isAllSelected} size={16} ariaLabel={t('files.commandBar.selectAll')} className="min-h-9" onUpdateModelValue={() => selectAll()} />
                </span>
                <span role="columnheader" aria-sort={ariaSort('name')}>{sortHeader('name', t('files.list.nameColumn'))}</span>
                <span role="columnheader">{t('files.detail.owner')}</span>
                <span role="columnheader" aria-sort={ariaSort('modified_at')}>{sortHeader('modified_at', t('files.detail.modified'))}</span>
                <span role="columnheader" aria-sort={ariaSort('size')} className="text-right">{sortHeader('size', t('files.list.sizeColumn'))}</span>
                <span role="columnheader"><span className="sr-only">{t('common.menu')}</span></span>
              </div>

              {/* 새 폴더 인라인 편집 행 */}
              {inlineEdit?.kind === 'new-folder' && (
                <div role="row" className="flex h-14 items-center gap-3 border-b border-border pl-4 pr-2 shadow-[inset_0_0_0_2px_hsl(var(--ring))] md:grid md:h-10 md:grid-cols-[40px_1fr] md:gap-0 md:pl-0">
                  <span className="hidden md:block" />
                  <span role="gridcell" className="flex min-w-0 items-center gap-2.5">
                    <FilesFileTypeIcon kind="folder" className="h-[22px] w-[22px] md:h-4 md:w-4" />
                    <input
                      ref={setEditInput}
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      aria-label={t('files.list.newFolderName')}
                      autoComplete="off"
                      className="h-8 min-w-0 flex-1 rounded-[6px] border border-ring bg-background px-2 text-[15px] outline-hidden md:h-7 md:max-w-xs md:flex-none md:min-w-[200px] md:text-[13px]"
                      onKeyDown={editKeys}
                      onBlur={commitEdit}
                    />
                    <span className="hidden text-[11px] text-muted-foreground md:inline">{t('files.list.createHint')}</span>
                  </span>
                </div>
              )}

              {/* 행 */}
              {sortedItems.map((item, i) => {
                const selected = selectedItems.has(item.path)
                const renaming = isRenaming(item)
                return (
                  <div
                    key={item.path}
                    ref={(el) => { if (el) rowEls.current[i] = el }}
                    role="row"
                    aria-selected={selected}
                    aria-rowindex={i + 1}
                    tabIndex={i === focusIndex ? 0 : -1}
                    draggable={!isMobile && !renaming}
                    className={clsx(
                      'group relative isolate cursor-pointer border-b border-border outline-hidden transition-colors hover:bg-accent/40 focus-visible:shadow-[inset_0_0_0_2px_hsl(var(--ring))]',
                      drag.dropTarget === item.path ? 'shadow-[inset_0_0_0_2px_hsl(var(--primary))]' : '',
                    )}
                    onClick={e => onRowClick(e, item)}
                    onFocus={(e) => { if (e.target === e.currentTarget) setFocusIndex(i) }}
                    onKeyDown={e => onRowKey(e, item, i)}
                    onContextMenu={(e) => { e.preventDefault(); onMenu?.(e, item) }}
                    onPointerDown={e => press.onPointerDown(e, item)}
                    onPointerMove={press.onPointerMove}
                    onPointerUp={press.cancelPress}
                    onPointerCancel={press.cancelPress}
                    onDragStart={e => drag.onDragStart(e, item)}
                    onDragEnd={drag.onDragEnd}
                    onDragOver={e => drag.onDragOver(e, item)}
                    onDragLeave={() => drag.setDropTarget(null)}
                    onDrop={e => drag.onDrop(e, item)}
                  >
                    {selected && <span className="absolute inset-0 -z-10 bg-primary/[0.13]" aria-hidden="true" />}

                    {/* 모바일 56 */}
                    <div className="flex h-14 items-center gap-3 pl-4 pr-1 md:hidden">
                      {anySelected
                        ? (
                          <span className="grid h-[22px] w-[22px] place-items-center" onClick={e => e.stopPropagation()}>
                            <UiCheckbox modelValue={selected} size={20} ariaLabel={t('files.list.selectItem', { name: item.name })} onUpdateModelValue={() => onToggle(item)} />
                          </span>
                        )
                        : <FilesFileTypeIcon item={item} className="h-[22px] w-[22px]" strokeWidth={1.9} />}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-[15px]">
                          {renaming && isMobile
                            ? (
                              <input
                                ref={setEditInput}
                                value={editName}
                                onChange={e => setEditName(e.target.value)}
                                aria-label={t('files.list.newName')}
                                autoComplete="off"
                                className="h-8 min-w-0 flex-1 rounded-[6px] border border-ring bg-background px-2 outline-hidden"
                                onClick={e => e.stopPropagation()}
                                onKeyDown={editKeys}
                                onBlur={commitEdit}
                              />
                            )
                            : <span className="truncate">{item.name}</span>}
                          {item.is_starred && !renaming && <UiIcon name="star" filled aria-label={t('files.sidebar.starred')} className="h-3 w-3 shrink-0 text-warning" strokeWidth={1.5} />}
                          {isShared(item) && !renaming && <span role="img" aria-label={t('files.detail.shared')} className="inline-flex shrink-0 text-primary"><UiIcon name="link" className="h-[13px] w-[13px]" strokeWidth={2.4} /></span>}
                        </div>
                        <div className="truncate font-mono text-[11px] text-muted-foreground">{mobileMeta(item)}</div>
                      </div>
                      <UiIconButton label={t('files.action.menuFor', { name: item.name })} icon="more-vertical" size="md" noTooltip onClick={(e) => { e.stopPropagation(); onMenu?.(e, item) }} onPointerDown={e => e.stopPropagation()} />
                    </div>

                    {/* 데스크톱 40 */}
                    <div className="hidden h-10 grid-cols-[40px_1fr_120px_120px_80px_40px] items-center pr-2 text-[13px] md:grid">
                      {/* 체크박스는 상시(메일 거터 체크박스와 같은 규칙), ⋮ 만 hover 로 드러난다 */}
                      <span role="gridcell" className="grid place-items-center" onClick={e => e.stopPropagation()}>
                        <UiCheckbox modelValue={selected} size={16} ariaLabel={t('files.list.selectItem', { name: item.name })} onUpdateModelValue={() => onToggle(item)} />
                      </span>
                      <span role="gridcell" className="flex min-w-0 items-center gap-2.5">
                        <FilesFileTypeIcon item={item} className="h-4 w-4" />
                        {renaming && !isMobile
                          ? (
                            <>
                              <input
                                ref={setEditInput}
                                value={editName}
                                onChange={e => setEditName(e.target.value)}
                                aria-label={t('files.list.newName')}
                                autoComplete="off"
                                className="h-7 min-w-[200px] max-w-xs rounded-[6px] border border-ring bg-background px-2 outline-hidden"
                                onClick={e => e.stopPropagation()}
                                onKeyDown={editKeys}
                                onBlur={commitEdit}
                              />
                              <span className="text-[11px] text-muted-foreground">{t('files.list.renameHint')}</span>
                            </>
                          )
                          : (
                            <>
                              <span className="truncate">{item.name}</span>
                              {item.is_starred && <UiIcon name="star" filled aria-label={t('files.sidebar.starred')} className="h-3 w-3 shrink-0 text-warning" strokeWidth={1.5} />}
                              {isShared(item) && (
                                <UiBadge tone="primary" tint size={18} className="shrink-0 gap-1">
                                  <UiIcon name="link" className="h-2.5 w-2.5" strokeWidth={3} />{t('files.detail.shared')}
                                </UiBadge>
                              )}
                              {searchActive && <span className="truncate text-[11px] text-muted-foreground">{parentLabel(item.path, tr)}</span>}
                            </>
                          )}
                      </span>
                      <span role="gridcell" className="truncate text-muted-foreground">{owner(item)}</span>
                      <span role="gridcell" className="font-mono text-[11px] text-muted-foreground">{formatStamp(item.modified_at)}</span>
                      <span role="gridcell" className="text-right font-mono text-[11px] text-muted-foreground">{item.is_dir ? '—' : formatSize(item.size)}</span>
                      <span role="gridcell" className={clsx('grid place-items-center', revealCls)}>
                        <UiIconButton label={t('files.action.menuFor', { name: item.name })} icon="more-vertical" onClick={(e) => { e.stopPropagation(); onMenu?.(e, item) }} />
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )
          : (
            // 빈 상태
            <UiEmptyState
              icon={searchActive ? 'search' : 'folder'}
              title={searchActive ? t('files.list.searchEmpty') : t('files.empty')}
              description={searchActive ? t('files.list.searchEmptyHint') : undefined}
            />
          )}
    </div>
  )
}

export default FilesFileList
