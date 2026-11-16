/**
 * 파일 사이드바: 236 · p 12/10 · bg-card · 13.5px,
 * 행 34 rounded-8 gap 10 아이콘 16, 선택 primary/13 + 600, 나머지 muted, 오른쪽 메타 11px. 아래 저장 공간 카드(12px, mono 수치, 4px 막대).
 * 뷰: 내 파일 · 공유받음 · 최근 · 즐겨찾기 · 공유 링크 · 휴지통(보관 기간 표기).
 *   "공유 파일"(팀 공유 폴더 shared/)·"전체 사용자"(관리자)는 기존 기능이므로 유지 — 시안에 없음.
 *   최근(GET /recent — 파일을 열 때 POST)·즐겨찾기(GET /stars)는 각각 별도 뷰.
 * 행은 드롭 대상(내 파일·공유 파일) — 앱 내 드래그(이동)만 허용한다.
 * (데스크톱 셸이 위치 열을 렌더링하면 파일 화면은 이 사이드바를 사용하지 않는다 — navOwnedByShell)
 */
import { useEffect, useState, type DragEvent } from 'react'
import { clsx } from 'clsx'
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { DRAG_MIME, formatSize } from '~/lib/files'
import { useFiles, type FilesView } from '~/composables/useFiles'
import { useAuth } from '~/composables/useAuth'

export interface FilesFileSidebarProps {
  className?: string
  /** 행을 눌러 이동한 경우 호출 */
  onNavigate?: () => void
  /** 앱 내 드래그를 행에 드롭 */
  onDropMove?: (paths: string[], dst: string) => void
}

interface NavRow { key: string; label: string; d: string; meta?: string; path?: string; view?: FilesView; disabled?: boolean }

// path 는 시안 nav 표와 동일
const D = {
  my: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  sharedWithMe: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  recent: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2',
  star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  trash: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  team: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 14h6',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
}

export function FilesFileSidebar({ className, onNavigate, onDropMove }: FilesFileSidebarProps) {
  const { currentPath, navigateTo, storageInfo, fetchStorageInfo, view, setView, shareLinks, fetchShareLinks, trashRetentionDays } = useFiles()
  const { user } = useAuth()
  const { t } = useI18n()

  useEffect(() => {
    fetchStorageInfo()
    fetchShareLinks()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const d = trashRetentionDays ?? 30
  const trashMeta = d > 0 ? t('files.sidebar.retention', { d }) : ''

  const rows: NavRow[] = [
    { key: 'my', label: t('files.sidebar.myFiles'), d: D.my, path: 'my' },
    { key: 'shared-with-me', label: t('files.view.sharedWithMe'), d: D.sharedWithMe, view: 'shared-with-me' },
    { key: 'shared', label: t('files.sidebar.sharedFiles'), d: D.team, path: 'shared' },
    { key: 'recent', label: t('files.sidebar.recent'), d: D.recent, view: 'recent' },
    { key: 'starred', label: t('files.sidebar.starred'), d: D.star, view: 'starred' },
    { key: 'links', label: t('files.share.linkLabel'), d: D.link, view: 'links', meta: shareLinks.length ? String(shareLinks.length) : '' },
    { key: 'trash', label: t('files.view.trash'), d: D.trash, view: 'trash', meta: trashMeta },
  ]
  if (user?.is_admin) rows.push({ key: 'users', label: t('files.sidebar.allUsers'), d: D.users, path: 'users' })

  function isActive(row: NavRow) {
    if (row.view) return view === row.view
    if (view !== 'files' || !row.path) return false
    return currentPath === row.path || currentPath.startsWith(row.path + '/')
  }

  function go(row: NavRow) {
    if (row.disabled) return
    if (row.view) setView(row.view)
    else if (row.path) navigateTo(row.path)
    onNavigate?.()
  }

  // ── 드래그 앤 드롭(이동) ──
  const [dropKey, setDropKey] = useState<string | null>(null)
  function canDrop(row: NavRow, e: DragEvent) {
    return !!row.path && row.path !== 'users' && !!e.dataTransfer?.types.includes(DRAG_MIME)
  }
  function onDragOver(row: NavRow, e: DragEvent) {
    if (!canDrop(row, e)) return
    e.preventDefault()
    e.dataTransfer!.dropEffect = 'move'
    setDropKey(row.key)
  }
  function onDrop(row: NavRow, e: DragEvent) {
    setDropKey(null)
    if (!canDrop(row, e)) return
    e.preventDefault()
    e.stopPropagation()
    try {
      const paths = JSON.parse(e.dataTransfer!.getData(DRAG_MIME) || '[]') as string[]
      if (paths.length) onDropMove?.(paths, row.path!)
    } catch { /* 잘못된 데이터 무시 */ }
  }

  const s = storageInfo
  const usedPercent = !s || !s.total_capacity ? 0 : Math.min(100, Math.round(s.disk_used / s.total_capacity * 100))

  return (
    <aside className={cn('flex h-full w-sidebar shrink-0 flex-col overflow-y-auto border-r border-border bg-card px-2.5 py-3 text-[13.5px]', className)} aria-label={t('files.sidebar.label')}>
      <nav className="flex flex-col">
        {rows.map(row => (
          <button
            key={row.key}
            type="button"
            disabled={row.disabled}
            aria-current={isActive(row) ? 'page' : undefined}
            title={row.disabled ? t('files.sidebar.comingSoon') : undefined}
            className={clsx(
              'flex h-[34px] w-full items-center gap-2.5 rounded-sm px-2.5 text-left transition-colors focus-visible:outline-hidden focus-visible:shadow-[inset_0_0_0_2px_hsl(var(--ring))] disabled:cursor-not-allowed disabled:opacity-50',
              isActive(row) ? 'bg-primary/[0.13] font-semibold text-foreground' : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
              dropKey === row.key ? 'shadow-[inset_0_0_0_2px_hsl(var(--primary))]' : '',
            )}
            onClick={() => go(row)}
            onDragOver={e => onDragOver(row, e)}
            onDragLeave={() => setDropKey(null)}
            onDrop={e => onDrop(row, e)}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={row.d} /></svg>
            <span className="flex-1 truncate">{row.label}</span>
            {row.meta && <span className={clsx('text-[11px] font-normal', row.key === 'links' ? 'font-mono' : '')}>{row.meta}</span>}
          </button>
        ))}
      </nav>

      {/* 저장 공간 */}
      {storageInfo && !!storageInfo.total_capacity && (
        <div className="mt-4 rounded-md border border-border p-3 text-xs">
          <div className="flex justify-between gap-2">
            <span>{t('files.sidebar.storageSpace')}</span>
            <span className="font-mono">{formatSize(storageInfo.disk_used)} / {formatSize(storageInfo.total_capacity)}</span>
          </div>
          <div className="mt-2 h-1 rounded-full bg-muted" role="progressbar" aria-valuenow={usedPercent} aria-valuemin={0} aria-valuemax={100} aria-label={t('files.sidebar.storageUsage')}>
            <div className="h-full rounded-full bg-primary" style={{ width: `${usedPercent}%` }} />
          </div>
        </div>
      )}
    </aside>
  )
}

export default FilesFileSidebar
