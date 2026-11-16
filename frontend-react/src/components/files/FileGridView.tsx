/**
 * 그리드 보기: 1440 에서 6열 · gap 14 · p 16, 카드 rounded-12 bg-card,
 * 썸네일 4:3(빗금 바탕 + 유형 아이콘 32 / 이미지는 미리보기), 아래 이름 12.5/500 + mono 10.5 시각 + ⋮ 28.
 * 선택 = inset 2px primary + 왼쪽 위 체크 20, 공유됨 = 오른쪽 위 22 타일. 목록과 동일한 클릭·선택·드래그 규칙.
 */
import type { KeyboardEvent, MouseEvent } from 'react'
import { clsx } from 'clsx'
import { useI18n } from '~/i18n'
import { useFiles, type FileItem } from '~/composables/useFiles'
import { useIsMobile } from '~/composables/useIsMobile'
import { formatStamp, isComposingKey, parentLabel, rangeBetween, type FilesTranslate } from '~/lib/files'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { FilesFileTypeIcon } from './FileTypeIcon'
import { FilesFileListError } from './FileListError'
import { revealClass, useInlineEdit, useLongPress, useRowDrag, useToggleWithAnchor } from './internal'

export interface FilesFileGridViewProps {
  onOpen?: (item: FileItem) => void
  onMenu?: (event: MouseEvent, item: FileItem) => void
  onDetail?: (item: FileItem) => void
  onDropMove?: (paths: string[], dst: string) => void
  onCommitNewFolder?: (name: string) => void
  onCommitRename?: (item: FileItem, name: string) => void
}

const stripes = 'repeating-linear-gradient(135deg, hsl(var(--muted) / 0.6) 0 6px, hsl(var(--card)) 6px 12px)'

export function FilesFileGridView({ onOpen, onMenu, onDetail, onDropMove, onCommitNewFolder, onCommitRename }: FilesFileGridViewProps) {
  const { sortedItems, selectedItems, setSelectedItems, getPreviewUrl, loading, searchActive, isShared, listError } = useFiles()
  const { t } = useI18n()
  const tr: FilesTranslate = (k, p) => t(k, p ?? {})
  const isMobile = useIsMobile()

  // ── 인라인 편집(새 폴더 카드 · 이름 바꾸기) — 목록과 동일한 규칙(Enter/Esc) ──
  const { inlineEdit, editName, setEditName, commitEdit, cancelEdit, setEditInput, isRenaming } = useInlineEdit({ sortedItems, onCommitNewFolder, onCommitRename })

  const anySelected = selectedItems.size > 0
  const order = sortedItems.map(i => i.path)
  const { anchor, onToggle } = useToggleWithAnchor()
  const press = useLongPress(onToggle)

  function onClick(e: MouseEvent, item: FileItem) {
    if (press.consumeSuppressed()) return
    if (isRenaming(item)) return
    if (e.metaKey || e.ctrlKey) { onToggle(item); return }
    if (e.shiftKey) { setSelectedItems(new Set(rangeBetween(order, anchor.current, item.path))); return }
    if (isMobile && anySelected) { onToggle(item); return }
    onOpen?.(item)
  }
  function onKey(e: KeyboardEvent, item: FileItem) {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter') { e.preventDefault(); onOpen?.(item) }
    else if (e.key === ' ') { e.preventDefault(); onDetail?.(item) }
  }

  const drag = useRowDrag(onDropMove)

  function isImage(item: FileItem) { return !item.is_dir && !!item.mime_type?.startsWith('image/') }

  const revealCls = revealClass(anySelected)

  function editKeys(e: KeyboardEvent<HTMLInputElement>) {
    if (isComposingKey(e)) return   // 한글 조합 중 Enter = 글자 확정
    if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit() }
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4 pb-24 md:pb-4">
      {loading
        ? <UiSkeleton preset="grid" rows={12} />
        : listError && !searchActive
          ? <FilesFileListError />
          : sortedItems.length === 0 && inlineEdit?.kind !== 'new-folder'
          ? (
            <UiEmptyState
              icon={searchActive ? 'search' : 'folder'}
              title={searchActive ? t('files.list.searchEmpty') : t('files.empty')}
            />
          )
          : (
            <div role="list" aria-label={t('files.detail.file')} className="grid grid-cols-2 content-start gap-3.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {/* 새 폴더 카드 */}
              {inlineEdit?.kind === 'new-folder' && (
                <div role="listitem" className="overflow-hidden rounded-lg border border-ring bg-card shadow-[inset_0_0_0_1px_hsl(var(--ring))]">
                  <div className="grid aspect-[4/3] place-items-center" style={{ background: stripes }}>
                    <FilesFileTypeIcon kind="folder" className="h-8 w-8" strokeWidth={1.6} />
                  </div>
                  <div className="p-2">
                    <input
                      ref={setEditInput}
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      aria-label={t('files.list.newFolderName')}
                      autoComplete="off"
                      className="h-7 w-full rounded-[6px] border border-ring bg-background px-2 text-[12.5px] outline-hidden"
                      onKeyDown={editKeys}
                      onBlur={commitEdit}
                    />
                    <div className="mt-1 text-[10.5px] text-muted-foreground">{t('files.list.createHint')}</div>
                  </div>
                </div>
              )}
              {sortedItems.map((item) => {
                const selected = selectedItems.has(item.path)
                const renaming = isRenaming(item)
                return (
                  <div
                    key={item.path}
                    role="listitem"
                    aria-selected={selected}
                    aria-label={item.name}
                    tabIndex={0}
                    draggable={!isMobile && !renaming}
                    className={clsx(
                      'group relative cursor-pointer overflow-hidden rounded-lg border border-border bg-card outline-hidden transition-colors hover:bg-accent/40 focus-visible:shadow-[inset_0_0_0_2px_hsl(var(--ring))]',
                      drag.dropTarget === item.path ? 'shadow-[inset_0_0_0_2px_hsl(var(--primary))]' : '',
                    )}
                    onClick={e => onClick(e, item)}
                    onKeyDown={e => onKey(e, item)}
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
                    <div className="grid aspect-[4/3] place-items-center overflow-hidden" style={{ background: stripes }}>
                      {isImage(item)
                        ? <img src={getPreviewUrl(item.path)} alt="" loading="lazy" className="h-full w-full object-cover" />
                        : <FilesFileTypeIcon item={item} className="h-8 w-8" strokeWidth={1.6} />}
                    </div>
                    <div className="flex items-center gap-1.5 py-2 pl-2.5 pr-1">
                      <div className="min-w-0 flex-1">
                        {renaming
                          ? (
                            <input
                              ref={setEditInput}
                              value={editName}
                              onChange={e => setEditName(e.target.value)}
                              aria-label={t('files.list.newName')}
                              autoComplete="off"
                              className="h-6 w-full rounded-[6px] border border-ring bg-background px-1.5 text-[12.5px] outline-hidden"
                              onClick={e => e.stopPropagation()}
                              onKeyDown={editKeys}
                              onBlur={commitEdit}
                            />
                          )
                          : <div className="truncate text-[12.5px] font-medium">{item.name}</div>}
                        <div className="truncate font-mono text-[10.5px] text-muted-foreground">{searchActive ? parentLabel(item.path, tr) : formatStamp(item.modified_at)}</div>
                      </div>
                      <UiIconButton
                        label={t('files.action.menuFor', { name: item.name })}
                        icon="more-vertical"
                        noTooltip
                        className="relative h-7 w-7 before:absolute before:-inset-1.5 before:content-['']"
                        onClick={(e) => { e.stopPropagation(); onMenu?.(e, item) }}
                        onPointerDown={e => e.stopPropagation()}
                      />
                    </div>

                    {selected && <span className="pointer-events-none absolute inset-0 rounded-lg shadow-[inset_0_0_0_2px_hsl(var(--primary))]" aria-hidden="true" />}
                    <span className={clsx('absolute -left-0.5 -top-0.5', selected ? 'opacity-100' : revealCls)} onClick={e => e.stopPropagation()}>
                      <UiCheckbox modelValue={selected} size={20} ariaLabel={t('files.list.selectItem', { name: item.name })} className="min-h-10 min-w-10 justify-center" onUpdateModelValue={() => onToggle(item)} />
                    </span>
                    {isShared(item) && (
                      <span role="img" aria-label={t('files.detail.shared')} className="absolute right-2 top-2 grid h-[22px] w-[22px] place-items-center rounded-[6px] bg-card text-primary">
                        <UiIcon name="link" className="h-3 w-3" strokeWidth={2.6} />
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
    </div>
  )
}

export default FilesFileGridView
