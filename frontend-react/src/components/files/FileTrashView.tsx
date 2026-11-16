/**
 * 휴지통 뷰(서버 측 기존 구현, 화면만 필요). 시안에 그림이 없어 공통 규격(조밀 40 / 모바일 56) 적용.
 * 열: 이름 · 원래 위치 · 지운 날 · 크기 · 복원 · 영구 삭제(DELETE /trash/{trash_name}, 확인 후). 비우기는 커맨드 바(데스크톱)·보기 시트(모바일)에서 제공.
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { useFiles, type TrashEntry } from '~/composables/useFiles'
import { useToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { formatSize, formatStamp, parentLabel, type FilesTranslate } from '~/lib/files'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiButton } from '~/components/ui/Button'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { FilesFileTypeIcon } from './FileTypeIcon'

export function FilesFileTrashView() {
  const { trashItems, fetchTrash, restoreTrash, deleteTrashItem, loading, navigateTo, trashRetentionDays } = useFiles()
  const { toast, addToast } = useToast()
  const { t } = useI18n()
  const tr: FilesTranslate = (k, p) => t(k, p ?? {})

  const [error, setError] = useState('')
  async function load() {
    setError('')
    try { await fetchTrash() } catch (e: any) { setError(e?.data?.detail || t('files.trash.loadError')) }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const [busy, setBusy] = useState<string | null>(null)
  async function restore(x: TrashEntry) {
    setBusy(x.trash_name)
    try {
      const r = await restoreTrash(x.trash_name)
      const parent = r.restored_path.split('/').slice(0, -1).join('/') || 'my'
      toast({ type: 'success', title: t('files.trash.restored', { name: x.name }), action: { label: t('files.action.openLocation'), onClick: () => navigateTo(parent) } })
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('files.versions.restoreError'))
    } finally {
      setBusy(null)
    }
  }

  async function purge(x: TrashEntry) {
    if (!await confirmBox(t('files.trash.purgeConfirm', { name: x.name }), { title: t('files.page.deleteForever'), confirmLabel: t('files.page.deleteForever'), danger: true })) return
    setBusy(x.trash_name)
    try {
      await deleteTrashItem(x.trash_name)
      toast({ type: 'success', title: t('files.trash.purged', { name: x.name }) })
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('files.trash.purgeError'))
    } finally {
      setBusy(null)
    }
  }

  const d = trashRetentionDays
  const hint = d && d > 0 ? t('files.trash.retentionHint', { d }) : undefined

  return (
    <div className="min-h-0 flex-1 overflow-auto pb-24 md:pb-0">
      {loading
        ? <UiSkeleton preset="list" rows={6} />
        : error
          ? <UiErrorTile placement="panel" title={error} onRetry={load} />
          : !trashItems.length
            ? <UiEmptyState icon="trash" title={t('files.trash.emptyTitle')} description={hint} />
            : (
              <div role="table" aria-label={t('files.view.trash')} className="text-[13px]">
                <div role="row" className="sticky top-0 z-10 hidden h-9 grid-cols-[40px_1fr_220px_120px_80px_128px] items-center border-b border-border bg-background pr-2 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground md:grid">
                  <span />
                  <span role="columnheader">{t('files.list.nameColumn')}</span>
                  <span role="columnheader">{t('files.trash.originalLocation')}</span>
                  <span role="columnheader">{t('files.trash.deletedAt')}</span>
                  <span role="columnheader" className="text-right">{t('files.list.sizeColumn')}</span>
                  <span role="columnheader"><span className="sr-only">{t('files.list.actions')}</span></span>
                </div>
                {hint && <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">{hint}</p>}
                {trashItems.map(x => (
                  <div key={x.trash_name} role="row" className="border-b border-border hover:bg-accent/40">
                    {/* 모바일 */}
                    <div className="flex h-14 items-center gap-3 pl-4 pr-1 md:hidden">
                      <FilesFileTypeIcon item={{ name: x.name }} className="h-[22px] w-[22px]" strokeWidth={1.9} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[15px]">{x.name}</div>
                        <div className="truncate font-mono text-[11px] text-muted-foreground">{parentLabel(x.original_path, tr)} · {formatStamp(x.trashed_at)}</div>
                      </div>
                      <button type="button" className="h-10 px-3 text-sm font-semibold text-primary disabled:opacity-50" disabled={busy === x.trash_name} onClick={() => restore(x)}>{t('files.versions.restore')}</button>
                      <UiIconButton label={t('files.trash.purgeItem', { name: x.name })} icon="trash" size="md" noTooltip className="text-danger hover:text-danger" disabled={busy === x.trash_name} onClick={() => purge(x)} />
                    </div>
                    {/* 데스크톱 */}
                    <div className="hidden h-10 grid-cols-[40px_1fr_220px_120px_80px_128px] items-center pr-2 md:grid">
                      <span />
                      <span role="cell" className="flex min-w-0 items-center gap-2.5">
                        <FilesFileTypeIcon item={{ name: x.name }} className="h-4 w-4" />
                        <span className="truncate">{x.name}</span>
                      </span>
                      <span role="cell" className="truncate text-muted-foreground">{parentLabel(x.original_path, tr) || '—'}</span>
                      <span role="cell" className="font-mono text-[11px] text-muted-foreground">{formatStamp(x.trashed_at)}</span>
                      <span role="cell" className="text-right font-mono text-[11px] text-muted-foreground">{formatSize(x.size)}</span>
                      <span role="cell" className="flex items-center justify-end gap-1">
                        <UiButton variant="outline" size="xs" disabled={busy === x.trash_name} aria-label={t('files.trash.restoreItem', { name: x.name })} onClick={() => restore(x)}>{t('files.versions.restore')}</UiButton>
                        <UiIconButton label={t('files.trash.purgeItem', { name: x.name })} icon="trash" className="text-danger hover:text-danger" disabled={busy === x.trash_name} onClick={() => purge(x)} />
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
    </div>
  )
}

export default FilesFileTrashView
