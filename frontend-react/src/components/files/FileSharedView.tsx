/**
 * 공유받음 뷰 — 다른 사용자가 본인에게 공유한 파일·폴더(/api/files/shared-with-me).
 * 시안 그림 없음 → 공통 규격(조밀 40 / 모바일 56). 열: 이름 · 소유자 · 수정 · 크기 · 다운로드.
 * 공유받은 폴더는 내부로 진입하여 탐색한다(GET /shared-with-me/{id}/list?path=). 상단 줄 36 에 경로(공유받음 › 폴더 › 하위)를 표시하며,
 * 파일 클릭은 부모(openItem)가 처리한다 — 미리보기·오피스(권한에 따라 보기/편집), 다운로드 버튼은 유지한다.
 * 권한 4단계: 이름 옆 배지 = 내 권한(댓글·편집·공동 소유, 보기는 배지 없음 — 이전 "편집 가능" 배지 자리). 행 끝 ⋮ 열(40)·우클릭 =
 *   파일 메뉴(부모 FileContextMenu — 권한에 해당하는 항목만: 공동 소유면 공유·이동·이름 바꾸기·휴지통). 시안 그림 없음 → 내 파일 목록 ⋮ 규격.
 * ref → { reload }.
 * 첫 목록 데스크톱 열 = 아이콘 40 · 이름 · 공유한 사람(아바타 20) 120 · 내 권한(틴트 배지 18 —
 *   보기 neutral · 댓글 primary · 편집 success · 공동 소유 warning) 128 · 받은 날 mono 110 · ⋮(more-horizontal) 40. 머리 36 · 행 40.
 *   내려받기는 ⋮ 메뉴에서 제공한다(시안에 열 없음).
 */
import { Fragment, useEffect, useImperativeHandle, useState, type MouseEvent, type Ref } from 'react'
import { useI18n } from '~/i18n'
import { useFiles, type FileItem, type SharedWithMeEntry } from '~/composables/useFiles'
import { formatDay, formatSize, formatStamp, roleLabelKey, roleOf } from '~/lib/files'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiBadge } from '~/components/ui/Badge'
import { UiAvatar } from '~/components/ui/Avatar'
import { ROLE_TONE } from './FileCommentsPanel'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { FilesFileTypeIcon } from './FileTypeIcon'

export interface FilesFileSharedViewHandle { reload: () => Promise<void> }

export interface FilesFileSharedViewProps {
  onOpen?: (item: FileItem) => void
  onMenu?: (e: MouseEvent, item: FileItem) => void
  ref?: Ref<FilesFileSharedViewHandle>
}

export function FilesFileSharedView({ onOpen, onMenu, ref }: FilesFileSharedViewProps) {
  const { sharedWithMe, fetchSharedWithMe, downloadSharedWithMe, loading, sharedBrowse, openSharedFolder, closeSharedFolder } = useFiles()
  const { t } = useI18n()

  const [error, setError] = useState('')
  async function load() {
    setError('')
    try { await fetchSharedWithMe() } catch (e: any) { setError(e?.data?.detail || t('files.shared.loadError')) }
  }
  // 폴더 내부 상태는 모듈 싱글턴이지만 루트 항목은 본 화면이 보유한다 — 재마운트 시 첫 목록부터 표시
  useEffect(() => { if (sharedBrowse) closeSharedFolder(); load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 현재 진입한 공유 루트(경로 조각·하위 이동에 사용)
  const [rootEntry, setRootEntry] = useState<SharedWithMeEntry | null>(null)
  async function enter(entry: SharedWithMeEntry, sub = '') {
    setError('')
    setRootEntry(entry)
    try { await openSharedFolder(entry, sub) } catch (e: any) { setError(e?.data?.detail || t('files.shared.loadError')) }
  }
  /** 공유받음 첫 목록 행 → 파일 항목(경로 = shared-with-me/<공유 id>) */
  function entryItem(s: SharedWithMeEntry): FileItem {
    return {
      name: s.name, path: `shared-with-me/${s.share_id}`, is_dir: s.is_dir, size: s.size, modified_at: s.modified_at,
      mime_type: null, owner: { id: s.owner.id, name: s.owner.display_name }, role: roleOf(s),
    }
  }
  function open(s: SharedWithMeEntry) {
    if (s.is_dir) { void enter(s); return }
    onOpen?.(entryItem(s))
  }
  function menuEntry(e: MouseEvent, s: SharedWithMeEntry) { onMenu?.(e, entryItem(s)) }
  function menuInside(e: MouseEvent, it: FileItem) {
    const b = sharedBrowse
    onMenu?.(e, { ...it, role: it.role ?? b?.role, owner: it.owner ?? (b ? { id: null, name: b.owner } : null) })
  }
  // 공동 소유자가 본 화면에서 삭제·이동한 항목을 재조회할 때 사용하는 루트 항목이 유실되지 않도록 — 폴더 내부이면 rootEntry 유지
  useImperativeHandle(ref, () => ({ reload: load }))
  /** 폴더 내부 행: 하위 폴더는 진입하고, 파일은 부모가 연다(내려받기 + 최근 기록) */
  function openInside(item: FileItem) {
    const b = sharedBrowse
    if (!b || !rootEntry) return
    if (item.is_dir) {
      const sub = item.path.split('/').slice(2).join('/')
      void enter(rootEntry, sub)
      return
    }
    onOpen?.(item)
  }
  const crumbs = (() => {
    const b = sharedBrowse
    if (!b) return []
    const parts = b.sub ? b.sub.split('/') : []
    return [{ label: b.rootName, sub: '' }, ...parts.map((p, i) => ({ label: p, sub: parts.slice(0, i + 1).join('/') }))]
  })()
  function back() {
    closeSharedFolder()
    setRootEntry(null)
    void load()
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto pb-24 md:pb-0">
      {sharedBrowse
        ? (
          // 공유받은 폴더 안
          <>
            <nav aria-label={t('files.shared.pathLabel')} className="flex h-11 items-center gap-1 overflow-x-auto whitespace-nowrap border-b border-border px-2 text-[13px] md:h-9">
              <button type="button" className="inline-flex h-10 items-center gap-1 rounded-sm px-2 text-muted-foreground hover:text-foreground md:h-8" onClick={back}>
                <UiIcon name="chevron-left" className="h-3.5 w-3.5" />{t('files.view.sharedWithMe')}
              </button>
              {crumbs.map((c, i) => (
                <Fragment key={c.sub}>
                  <UiIcon name="chevron-right" className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                  {i < crumbs.length - 1
                    ? (
                      <button
                        type="button"
                        className="inline-flex h-10 items-center rounded-sm px-1.5 text-muted-foreground hover:text-foreground md:h-8"
                        onClick={() => { if (rootEntry) enter(rootEntry, c.sub) }}
                      >{c.label}</button>
                    )
                    : <span className="px-1.5 font-semibold" aria-current="page">{c.label}</span>}
                </Fragment>
              ))}
              <span className="ml-auto shrink-0 pl-3 text-xs text-muted-foreground">{t('files.shared.ownerIs', { name: sharedBrowse.owner })}</span>
            </nav>
            {loading
              ? <UiSkeleton preset="list" rows={6} />
              : error
                ? <UiErrorTile placement="panel" title={error} onRetry={() => { if (rootEntry) enter(rootEntry, sharedBrowse.sub) }} />
                : !sharedBrowse.items.length
                  ? <UiEmptyState icon="folder" title={t('files.empty')} />
                  : (
                    <div role="table" aria-label={crumbs.at(-1)?.label} className="text-[13px]">
                      {sharedBrowse.items.map(it => (
                        <div key={it.path} role="row" className="cursor-pointer border-b border-border hover:bg-accent/40" onClick={() => openInside(it)} onContextMenu={(e) => { e.preventDefault(); menuInside(e, it) }}>
                          <div className="flex h-14 items-center gap-3 pl-4 pr-1 md:hidden">
                            <FilesFileTypeIcon item={it} className="h-[22px] w-[22px]" strokeWidth={1.9} />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[15px]">{it.name}</div>
                              <div className="truncate font-mono text-[11px] text-muted-foreground">{it.is_dir ? t('files.detail.folder') : formatSize(it.size)} · {formatDay(it.modified_at)}</div>
                            </div>
                            {!it.is_dir && <UiIconButton label={t('files.shared.downloadItem', { name: it.name })} icon="download" size="md" noTooltip onClick={(e) => { e.stopPropagation(); downloadSharedWithMe({ share_id: sharedBrowse.shareId, name: it.name, size: it.size }, it.path.split('/').slice(2).join('/')) }} />}
                            <UiIconButton label={t('files.action.menuFor', { name: it.name })} icon="more-vertical" size="md" noTooltip aria-haspopup="menu" onClick={(e) => { e.stopPropagation(); menuInside(e, it) }} />
                          </div>
                          <div className="hidden h-10 grid-cols-[40px_1fr_140px_120px_80px_40px_40px] items-center pr-2 md:grid">
                            <span />
                            <span role="cell" className="flex min-w-0 items-center gap-2.5">
                              <FilesFileTypeIcon item={it} className="h-4 w-4" />
                              <span className="truncate">{it.name}</span>
                            </span>
                            <span role="cell" className="truncate text-muted-foreground">{sharedBrowse.owner}</span>
                            <span role="cell" className="font-mono text-[11px] text-muted-foreground">{formatStamp(it.modified_at)}</span>
                            <span role="cell" className="text-right font-mono text-[11px] text-muted-foreground">{it.is_dir ? '—' : formatSize(it.size)}</span>
                            <span role="cell" className="grid place-items-center">
                              {!it.is_dir && <UiIconButton label={t('files.shared.downloadItem', { name: it.name })} icon="download" onClick={(e) => { e.stopPropagation(); downloadSharedWithMe({ share_id: sharedBrowse.shareId, name: it.name, size: it.size }, it.path.split('/').slice(2).join('/')) }} />}
                            </span>
                            <span role="cell" className="grid place-items-center">
                              <UiIconButton label={t('files.action.menuFor', { name: it.name })} icon="more-vertical" aria-haspopup="menu" onClick={(e) => { e.stopPropagation(); menuInside(e, it) }} />
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
          </>
        )
        : loading
          ? <UiSkeleton preset="list" rows={6} />
          : error
            ? <UiErrorTile placement="panel" title={error} onRetry={load} />
            : !sharedWithMe.length
              ? <UiEmptyState icon="users" title={t('files.shared.emptyTitle')} description={t('files.shared.emptyHint')} />
              : (
                <div role="table" aria-label={t('files.view.sharedWithMe')} className="text-[13px]">
                  <div role="row" className="sticky top-0 z-10 hidden h-9 grid-cols-[40px_1fr_120px_128px_110px_40px] items-center border-b border-border bg-background text-[11px] font-semibold tracking-wider text-muted-foreground md:grid">
                    <span />
                    <span role="columnheader">{t('files.list.nameColumn')}</span>
                    <span role="columnheader">{t('files.shared.sharedBy')}</span>
                    <span role="columnheader">{t('files.shared.myRole')}</span>
                    <span role="columnheader">{t('files.shared.receivedAt')}</span>
                    <span role="columnheader"><span className="sr-only">{t('files.list.actions')}</span></span>
                  </div>
                  {sharedWithMe.map(s => (
                    <div key={s.share_id} role="row" className="cursor-pointer border-b border-border hover:bg-accent/40" onClick={() => open(s)} onContextMenu={(e) => { e.preventDefault(); menuEntry(e, s) }}>
                      <div className="flex h-14 items-center gap-3 pl-4 pr-1 md:hidden">
                        <FilesFileTypeIcon item={{ name: s.name, is_dir: s.is_dir }} className="h-[22px] w-[22px]" strokeWidth={1.9} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[15px]">{s.name}</div>
                          <div className="truncate font-mono text-[11px] text-muted-foreground">{s.owner.display_name} · {s.is_dir ? t('files.detail.folder') : formatSize(s.size)} · {formatDay(s.modified_at)}</div>
                        </div>
                        {!s.is_dir && <UiIconButton label={t('files.shared.downloadItem', { name: s.name })} icon="download" size="md" noTooltip onClick={(e) => { e.stopPropagation(); downloadSharedWithMe(s) }} />}
                        <UiIconButton label={t('files.action.menuFor', { name: s.name })} icon="more-vertical" size="md" noTooltip aria-haspopup="menu" onClick={(e) => { e.stopPropagation(); menuEntry(e, s) }} />
                      </div>
                      <div className="hidden h-10 grid-cols-[40px_1fr_120px_128px_110px_40px] items-center text-[13px] md:grid">
                        <span className="grid place-items-center"><FilesFileTypeIcon item={{ name: s.name, is_dir: s.is_dir }} className="h-4 w-4" /></span>
                        <span role="cell" className="truncate">{s.name}</span>
                        <span role="cell" className="flex min-w-0 items-center gap-2 text-muted-foreground">
                          <UiAvatar fallback={s.owner.display_name.slice(0, 1)} textSize={10} className="h-5 w-5 shrink-0" />
                          <span className="truncate">{s.owner.display_name}</span>
                        </span>
                        <span role="cell"><UiBadge tone={ROLE_TONE[roleOf(s)]} tint size={18}>{t(roleLabelKey(roleOf(s)))}</UiBadge></span>
                        <span role="cell" className="font-mono text-[11px] text-muted-foreground">{formatDay(s.shared_at ?? s.modified_at)}</span>
                        <span role="cell" className="grid place-items-center">
                          <UiIconButton label={t('files.action.menuFor', { name: s.name })} icon="more-horizontal" aria-haspopup="menu" onClick={(e) => { e.stopPropagation(); menuEntry(e, s) }} />
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
    </div>
  )
}

export default FilesFileSharedView
