/**
 * 최근 · 즐겨찾기 뷰 — GET /api/files/recent(파일을 열 때 POST 로 쌓임) · GET /api/files/stars.
 * 시안 그림 없음 → 공통 규격(조밀 40 / 모바일 56). 열: 이름 · 위치 · 연 시각(즐겨찾기는 추가한 시각) · 크기 · 행동.
 * 행 클릭 = 열기(파일 목록과 같은 규칙), 행 끝: 위치 열기 · 즐겨찾기 빼기(즐겨찾기 뷰). 원본이 없어진 즐겨찾기는 흐리게 + "원본 없음".
 */
import { useEffect, useState } from 'react'
import { clsx } from 'clsx'
import { useI18n } from '~/i18n'
import { useFiles, type FileItem, type QuickItem } from '~/composables/useFiles'
import { useToast } from '~/composables/useToast'
import { formatDay, formatSize, formatStamp, parentLabel, sharedSubPath, type FilesTranslate } from '~/lib/files'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiBadge } from '~/components/ui/Badge'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { FilesFileTypeIcon } from './FileTypeIcon'

export interface FilesFileQuickViewProps {
  kind: 'recent' | 'starred'
  onOpen?: (item: FileItem) => void
}

export function FilesFileQuickView({ kind, onOpen }: FilesFileQuickViewProps) {
  const { recentItems, starredItems, fetchRecent, fetchStars, setStar, openFileLocation, loading } = useFiles()
  const { addToast } = useToast()
  const { t } = useI18n()
  const tr: FilesTranslate = (k, p) => t(k, p ?? {})

  const [error, setError] = useState('')
  async function load() {
    setError('')
    try { await (kind === 'recent' ? fetchRecent() : fetchStars()) } catch (e: any) { setError(e?.data?.detail || t('files.quick.loadError')) }
  }
  // onMounted(load) + watch(kind, load)
  useEffect(() => { load() }, [kind]) // eslint-disable-line react-hooks/exhaustive-deps

  const rows = (kind === 'recent' ? recentItems : starredItems) as readonly QuickItem[]
  const stamp = (r: QuickItem) => (kind === 'recent' ? r.accessed_at : r.starred_at) ?? null

  function location(r: QuickItem) {
    return sharedSubPath(r.path) ? t('files.view.sharedWithMe') : (parentLabel(r.path, tr) || '—')
  }
  function open(r: QuickItem) {
    if (r.exists === false) return
    onOpen?.(r as FileItem)
  }
  function canLocate(r: QuickItem) { return r.exists !== false && !sharedSubPath(r.path) }
  async function unstar(r: QuickItem) {
    try {
      await setStar(r.path, false)
      addToast('success', t('files.star.removed'))
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('files.star.error'))
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto pb-24 md:pb-0">
      {loading
        ? <UiSkeleton preset="list" rows={6} />
        : error
          ? <UiErrorTile placement="panel" title={error} onRetry={load} />
          : !rows.length
            ? (
              <UiEmptyState
                icon={kind === 'recent' ? 'clock' : 'star'}
                title={kind === 'recent' ? t('files.quick.recentEmpty') : t('files.quick.starredEmpty')}
                description={kind === 'recent' ? t('files.quick.recentEmptyHint') : t('files.quick.starredEmptyHint')}
              />
            )
            : (
              <div role="table" aria-label={kind === 'recent' ? t('files.sidebar.recent') : t('files.sidebar.starred')} className="text-[13px]">
                <div role="row" className="sticky top-0 z-10 hidden h-9 grid-cols-[40px_1fr_220px_120px_80px_80px] items-center border-b border-border bg-background pr-2 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground md:grid">
                  <span />
                  <span role="columnheader">{t('files.list.nameColumn')}</span>
                  <span role="columnheader">{t('files.detail.location')}</span>
                  <span role="columnheader">{kind === 'recent' ? t('files.quick.openedAt') : t('files.quick.starredAt')}</span>
                  <span role="columnheader" className="text-right">{t('files.list.sizeColumn')}</span>
                  <span role="columnheader"><span className="sr-only">{t('files.list.actions')}</span></span>
                </div>
                {rows.map(r => (
                  <div
                    key={r.path}
                    role="row"
                    className={clsx('border-b border-border', r.exists === false ? 'opacity-60' : 'cursor-pointer hover:bg-accent/40')}
                    onClick={() => open(r)}
                  >
                    {/* 모바일 56 */}
                    <div className="flex h-14 items-center gap-3 pl-4 pr-1 md:hidden">
                      <FilesFileTypeIcon item={r} className="h-[22px] w-[22px]" strokeWidth={1.9} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[15px]">{r.name}</div>
                        <div className="truncate font-mono text-[11px] text-muted-foreground">
                          {r.exists === false ? t('files.quick.missing') : <>{location(r)} · {formatDay(stamp(r))}</>}
                        </div>
                      </div>
                      {kind === 'starred'
                        ? <UiIconButton label={t('files.star.removeItem', { name: r.name })} size="md" noTooltip className="text-warning hover:text-warning" onClick={(e) => { e.stopPropagation(); unstar(r) }}><UiIcon name="star" filled /></UiIconButton>
                        : canLocate(r) ? <UiIconButton label={t('files.action.openLocation')} icon="folder" size="md" noTooltip onClick={(e) => { e.stopPropagation(); openFileLocation(r as FileItem) }} /> : null}
                    </div>
                    {/* 데스크톱 40 */}
                    <div className="hidden h-10 grid-cols-[40px_1fr_220px_120px_80px_80px] items-center pr-2 md:grid">
                      <span />
                      <span role="cell" className="flex min-w-0 items-center gap-2.5">
                        <FilesFileTypeIcon item={r} className="h-4 w-4" />
                        <span className="truncate">{r.name}</span>
                        {r.exists === false && <UiBadge tone="neutral" tint size={18} className="shrink-0">{t('files.quick.missing')}</UiBadge>}
                      </span>
                      <span role="cell" className="truncate text-muted-foreground">{location(r)}</span>
                      <span role="cell" className="font-mono text-[11px] text-muted-foreground">{formatStamp(stamp(r))}</span>
                      <span role="cell" className="text-right font-mono text-[11px] text-muted-foreground">{r.is_dir || r.exists === false ? '—' : formatSize(r.size)}</span>
                      <span role="cell" className="flex items-center justify-end gap-0.5">
                        {canLocate(r) && <UiIconButton label={t('files.action.openLocation')} icon="folder" onClick={(e) => { e.stopPropagation(); openFileLocation(r as FileItem) }} />}
                        {kind === 'starred' && <UiIconButton label={t('files.star.removeItem', { name: r.name })} className="text-warning hover:text-warning" onClick={(e) => { e.stopPropagation(); unstar(r) }}><UiIcon name="star" filled /></UiIconButton>}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
    </div>
  )
}

export default FilesFileQuickView
