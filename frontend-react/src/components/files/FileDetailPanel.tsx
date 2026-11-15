/**
 * 상세 패널(Vue components/files/FileDetailPanel.vue):
 * 헤더 44(유형 아이콘 · 이름 13/600 · 공유 · 닫기) + 밑줄 탭 정보 / 버전 N / 활동 / 댓글.
 * 버전: 행 = 원 28(작성자 이니셜, 모르면 시계) · v번호 mono 12 + "현재" success 틴트 · 메타 12 muted(시각 · 작성자) ·
 *   옛 버전은 "내려받기"(GET /versions/download) · "이 버전으로 복원"(확인 후). 시안의 "미리보기" 자리는 옛 버전 내려받기로 둔다.
 * 활동 탭: GET /activity(폴더면 하위 포함) — 행 = 원 28 이니셜 · "누가 무엇을" 13 · 시각 mono 12. 시안 그림 없어 버전 행 규격을 따랐다.
 * 헤더에 즐겨찾기 별(채운 별 = 켜짐).
 * 댓글 탭: 내 파일(my/)·공유받은 항목(shared-with-me/)만 — FileCommentsPanel(시안 그림 없음, 게시판 댓글 규격). 보기 권한이면 읽기만.
 * 공유받은 항목: 별(즐겨찾기)은 서버가 내 경로만 받아 숨기고, 공유 버튼은 공동 소유일 때만.
 * 모바일: 전체 화면 푸시 + 탭바 숨김. 상단 바는 셸 LayoutMobileDetailBar(navigate=false — 뒤로 = 패널 닫기).
 *
 * v-model:tab → tab + onUpdateTab.
 *
 * 추가된 것:
 *  폭 360, 탭 순서 = 정보 · 댓글(n) · 버전 · 활동(모바일은 활동 탭 없음). 댓글 수는 패널이 열릴 때 읽는다.
 *  정보 탭 = (공동 소유자면) 맨 위 이름 UiInput + hint "이동·삭제는 원 소유자만", 그 아래 80/1fr 격자:
 *   내 권한(배지 + 할 수 있는 것) · 소유자(아바타 20 + 이름) · 크기 · 수정 · 유형 · 위치 · 공유.
 *  모바일 머리 보조 줄 = "내 권한 · 원 소유자"(공유받은 항목).
 * 모바일은 탭을 늘리지 않고 정보 탭 맨 아래에 "활동" 묶음(최근 5개 + "모두 보기") —
 *  "모두 보기" = 같은 판 안 전체 화면 목록(상단 바 ‹ 활동 · 파일 이름, 뒤로 = 정보로). 행 규격은 데스크톱 활동 탭과 같다.
 *  묶음 머리(12/600 muted + 오른쪽 link xs)는 시안 그림이 없어 기존 패널 머리 규격을 따랐다(디자이너 확인 필요).
 */
import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { clsx } from 'clsx'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { useFiles, type FileActivityEntry, type FileItem, type VersionEntry } from '~/composables/useFiles'
import { useFileComments } from '~/composables/useFileComments'
import { useAuth } from '~/composables/useAuth'
import { useToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { useIsMobile } from '~/composables/useIsMobile'
import { useSharedState } from '~/lib/state'
import { activityKey, fileKind, formatSize, formatStamp, KIND_META, parentLabel, previewKind, roleAtLeast, roleLabelKey, sharedSubPath, type FilesTranslate } from '~/lib/files'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiTabs } from '~/components/ui/Tabs'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiBadge } from '~/components/ui/Badge'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiInput } from '~/components/ui/Input'
import { UiButton } from '~/components/ui/Button'
import { LayoutMobileDetailBar } from '~/components/layout/MobileDetailBar'
import { FilesFileTypeIcon } from './FileTypeIcon'
import { FilesFileCommentsPanel, ROLE_TONE } from './FileCommentsPanel'

export type FileDetailTab = 'info' | 'versions' | 'activity' | 'comments'

export interface FilesFileDetailPanelProps {
  item: FileItem
  /** 지금 탭(기본 info) */
  tab?: FileDetailTab
  onUpdateTab?: (v: FileDetailTab) => void
  onClose?: () => void
  /** 공유 버튼 */
  onShare?: (item: FileItem) => void
  /** 즐겨찾기 별 */
  onStar?: (item: FileItem) => void
  /** 정보 탭에서 이름을 바꿨다(공동 소유자) — 새 이름·경로가 담긴 항목 */
  onRenamed?: (item: FileItem) => void
}

const initialOf = (s: string | null | undefined) => (s || '').trim().slice(0, 1).toUpperCase()

export function FilesFileDetailPanel({ item, tab: tabProp, onUpdateTab, onClose, onShare, onStar, onRenamed }: FilesFileDetailPanelProps) {
  // defineModel(default 'info') — 부모가 안 주면 자체 상태
  const [localTab, setLocalTab] = useState<FileDetailTab>('info')
  const tab = tabProp ?? localTab
  const setTab = (v: FileDetailTab) => { setLocalTab(v); onUpdateTab?.(v) }

  const { getPreviewUrl, fetchVersionInfo, restoreVersion, isShared, fetchActivity } = useFiles()
  const { user } = useAuth()
  const { toast, addToast } = useToast()
  const isMobile = useIsMobile()
  const { t } = useI18n()
  const tr: FilesTranslate = (k, p) => t(k, p ?? {})

  const versionable = !item.is_dir && item.path.startsWith('my/')
  const sharedIn = !!sharedSubPath(item.path)
  const commentable = item.path.startsWith('my/') || sharedIn
  const canShare = !sharedIn || roleAtLeast(item.role, 'owner')
  useEffect(() => { if (!commentable && tab === 'comments') setTab('info') }, [commentable]) // eslint-disable-line react-hooks/exhaustive-deps
  // 모바일은 활동 탭이 없다
  useEffect(() => { if (isMobile && tab === 'activity') setTab('info') }, [isMobile]) // eslint-disable-line react-hooks/exhaustive-deps

  // 댓글 — 탭 숫자 "댓글 n" 을 위해 패널이 열릴 때 읽는다(댓글 탭은 같은 상태를 쓴다)
  const comments = useFileComments(item.path)
  useEffect(() => { if (commentable) void comments.load() }, [item.path, commentable]) // eslint-disable-line react-hooks/exhaustive-deps

  // 이름 바꾸기(공동 소유자 — 정보 탭 맨 위)
  const canRename = sharedIn && item.role === 'owner'
  const [nameDraft, setNameDraft] = useState(item.name)
  useEffect(() => { setNameDraft(item.name) }, [item.path, item.name])
  const [renaming, setRenaming] = useState(false)
  async function commitRename() {
    const name = nameDraft.trim()
    if (!name || name === item.name || renaming) { setNameDraft(item.name); return }
    setRenaming(true)
    try {
      const r = await $fetch<{ ok: boolean; new_name: string; path: string }>('/api/files/rename', { method: 'PATCH', body: { path: item.path, new_name: name } })
      toast({ type: 'success', title: t('files.detail.renamed') })
      onRenamed?.({ ...item, name: r.new_name, path: r.path })
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('files.detail.renameError'))
      setNameDraft(item.name)
    } finally {
      setRenaming(false)
    }
  }

  const [versions, setVersions] = useState<VersionEntry[]>([])
  const [currentAuthor, setCurrentAuthor] = useState<{ id: string; name: string } | null>(null)
  const [vLoading, setVLoading] = useState(false)
  const [vError, setVError] = useState('')

  const itemRef = useRef(item)
  itemRef.current = item
  async function loadVersions() {
    const it = itemRef.current
    if (!(!it.is_dir && it.path.startsWith('my/'))) { setVersions([]); setCurrentAuthor(null); return }
    setVLoading(true)
    setVError('')
    try {
      const r = await fetchVersionInfo(it.path)
      setVersions(r.versions)
      setCurrentAuthor(r.currentAuthor)
    } catch (e: any) {
      setVError(e?.data?.detail || t('files.versions.loadError'))
    } finally {
      setVLoading(false)
    }
  }
  useEffect(() => { loadVersions() }, [item.path]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!versionable && tab === 'versions') setTab('info') }, [versionable]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 활동 ──
  const [activity, setActivity] = useState<FileActivityEntry[]>([])
  const [aLoading, setALoading] = useState(false)
  const [aError, setAError] = useState('')
  const aLoadedFor = useRef('')
  async function loadActivity() {
    const it = itemRef.current
    setALoading(true)
    setAError('')
    try {
      setActivity(await fetchActivity(it.path, it.is_dir))
      aLoadedFor.current = it.path
    } catch (e: any) {
      setAError(e?.data?.detail || t('files.activity.loadError'))
    } finally {
      setALoading(false)
    }
  }
  // 활동을 보여 줄 때만 받는다(파일을 고를 때마다 부르지 않게) — 데스크톱 = 활동 탭, 모바일 = 정보 탭 맨 아래 묶음
  const showsActivity = tab === 'activity' || (isMobile && tab === 'info')
  useEffect(() => { if (showsActivity && aLoadedFor.current !== item.path) loadActivity() }, [showsActivity, item.path]) // eslint-disable-line react-hooks/exhaustive-deps
  // 모바일 "모두 보기" 전체 화면 목록
  const [allActivity, setAllActivity] = useState(false)
  useEffect(() => { setAllActivity(false) }, [item.path])
  useEffect(() => { if (!isMobile) setAllActivity(false) }, [isMobile])
  function who(u: { id: string | null; name: string } | null | undefined) {
    if (!u) return t('files.activity.someone')
    return u.id && u.id === user?.id ? t('files.detail.me') : u.name
  }
  function activityText(a: FileActivityEntry) {
    const name = a.sub_path ? a.sub_path.split('/').pop() || a.sub_path : ''
    const base = t(activityKey(a.action), { who: who(a.user), version: a.detail?.version ? formatStamp(new Date(Number(a.detail.version)).toISOString()) : '' })
    return name ? `${base} — ${name}` : base
  }

  const tabs = [
    { key: 'info', label: t('files.detail.tabInfo') },
    { key: 'comments', label: t('files.detail.tabComments'), count: commentable ? comments.items.length : undefined, disabled: !commentable },
    { key: 'versions', label: t('files.detail.tabVersions'), count: versionable ? versions.length + 1 : undefined, disabled: !versionable },
    ...(isMobile ? [] : [{ key: 'activity', label: t('files.detail.tabActivity') }]),
  ]
  const onTabModel = (v: string | null) => { if (v === 'info' || v === 'versions' || v === 'activity' || v === 'comments') setTab(v) }

  // 현재본 + 스냅샷(최신순) → v 번호는 오래된 것이 1
  const n = versions.length
  const curAuthor = currentAuthor ? who(currentAuthor) : ''
  const rows = [
    { key: 'current', v: `v${n + 1}`, cur: true, initial: initialOf(curAuthor), url: '', meta: [formatStamp(item.modified_at), formatSize(item.size), curAuthor, t('files.versions.currentViewing')].filter(Boolean) },
    ...versions.map((s, i) => {
      const author = s.author ? who(s.author) : ''
      return { key: s.version, v: `v${n - i}`, cur: false, initial: initialOf(author), url: s.download_url || '', meta: [formatStamp(s.created_at), formatSize(s.size), author].filter(Boolean) }
    }),
  ]

  const [restoring, setRestoring] = useState<string | null>(null)
  async function onRestore(version: string, label: string) {
    const ok = await confirmBox(t('files.versions.restoreConfirm', { name: item.name, label }), { title: t('files.versions.restoreThis'), confirmLabel: t('files.versions.restore') })
    if (!ok) return
    setRestoring(version)
    try {
      await restoreVersion(item.path, version)
      await loadVersions()
      toast({ type: 'success', title: t('files.versions.restored', { label }) })
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('files.versions.restoreError'))
    } finally {
      setRestoring(null)
    }
  }

  const kind = KIND_META[fileKind(item)]
  // 시안 #info 격자(80 / 1fr): 내 권한 · 소유자 · 크기 · 수정 + 기존 칸(유형 · 위치 · 공유)
  const ownerName = item.owner ? who(item.owner) : (item.path.startsWith('my/') ? t('files.detail.me') : '—')
  const infoRows: { label: string; value: string; mono?: boolean }[] = []
  if (!item.is_dir) infoRows.push({ label: t('files.detail.size'), value: formatSize(item.size), mono: true })
  infoRows.push({ label: t('files.detail.modified'), value: formatStamp(item.modified_at), mono: true })
  infoRows.push({ label: t('files.detail.type'), value: t(kind.labelKey) })
  infoRows.push({ label: t('files.detail.location'), value: parentLabel(item.path, tr) || '—' })
  if (item.path.startsWith('my/')) infoRows.push({ label: t('common.share'), value: isShared(item) ? t('files.detail.shared') : t('files.detail.notShared') })
  const myRole = sharedIn && item.role ? item.role : null
  const mobileSub = myRole ? [t(roleLabelKey(myRole)), item.owner?.name].filter(Boolean).join(' · ') : t(kind.labelKey)
  const isImage = previewKind(item) === 'image'

  // 모바일: 탭바 숨김
  const [, setDetailOpen] = useSharedState<boolean>('mobile-detail-open', () => false)
  useEffect(() => { setDetailOpen(isMobile) }, [isMobile, setDetailOpen])
  useEffect(() => () => { setDetailOpen(false) }, [setDetailOpen])

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); if (allActivity) setAllActivity(false); else onClose?.() }
  }

  // 활동 행(데스크톱 활동 탭 · 모바일 묶음 · 모바일 전체 목록 공통)
  const activityRows = (list: FileActivityEntry[]) => (
    <ul>
      {list.map(a => (
        <li key={a.id} className="flex gap-2.5 border-b border-border px-3.5 py-3 text-[13px]">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold" aria-hidden="true">{initialOf(who(a.user)) || '?'}</span>
          <div className="min-w-0 flex-1">
            <div className="break-words">{activityText(a)}</div>
            <div className="font-mono text-xs text-muted-foreground">{formatStamp(a.created_at)}</div>
          </div>
        </li>
      ))}
    </ul>
  )
  const activityBody = (list: FileActivityEntry[], placement: 'panel' | 'inline') => (
    aLoading
      ? <UiSkeleton preset="list" rows={placement === 'panel' ? 4 : 3} />
      : aError
        ? <UiErrorTile placement={placement === 'panel' ? 'panel' : 'card'} title={aError} onRetry={loadActivity} />
        : !activity.length
          ? <UiEmptyState variant={placement} icon="activity" title={t('files.activity.empty')} />
          : activityRows(list)
  )

  // 모바일 활동 전체 화면 — 같은 판 안에서 바꿔 그린다
  if (isMobile && allActivity) {
    return (
      <aside aria-label={t('files.detail.tabActivity')} className="fixed inset-0 z-drawer flex flex-col bg-background" onKeyDown={onKey}>
        <LayoutMobileDetailBar
          title={t('files.detail.tabActivity')}
          subtitle={item.name}
          navigate={false}
          hideTabbar={false}
          onBack={() => setAllActivity(false)}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">{activityBody(activity, 'panel')}</div>
      </aside>
    )
  }

  const starLabel = item.is_starred ? t('files.star.remove') : t('files.star.add')

  return (
    <aside
      aria-label={t('files.detail.label')}
      className={clsx('flex flex-col bg-card', isMobile ? 'fixed inset-0 z-drawer bg-background' : 'h-full w-[360px] shrink-0 border-l border-border')}
      onKeyDown={onKey}
    >
      {isMobile
        ? (
          // 모바일 상단 바
          <LayoutMobileDetailBar
            title={item.name}
            subtitle={mobileSub}
            navigate={false}
            hideTabbar={false}
            onBack={() => onClose?.()}
            actions={(
              <>
                {!sharedIn && <UiIconButton label={starLabel} pressed={!!item.is_starred} size="lg" noTooltip className={item.is_starred ? 'text-warning hover:text-warning' : ''} onClick={() => onStar?.(item)}><UiIcon name="star" filled={!!item.is_starred} /></UiIconButton>}
                {canShare && <UiIconButton label={t('common.share')} icon="share" size="lg" noTooltip onClick={() => onShare?.(item)} />}
              </>
            )}
          />
        )
        : (
          // 데스크톱 헤더 44
          <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border pl-4 pr-1.5">
            <FilesFileTypeIcon item={item} className="h-4 w-4" />
            <span className="ml-1.5 min-w-0 flex-1 truncate text-[13px] font-semibold">{item.name}</span>
            {!sharedIn && <UiIconButton label={starLabel} pressed={!!item.is_starred} className={item.is_starred ? 'text-warning hover:text-warning' : ''} onClick={() => onStar?.(item)}><UiIcon name="star" filled={!!item.is_starred} /></UiIconButton>}
            {canShare && <UiIconButton label={t('common.share')} icon="share" onClick={() => onShare?.(item)} />}
            <UiIconButton label={t('common.close')} icon="close" keys={['Esc']} onClick={() => onClose?.()} />
          </div>
        )}

      <UiTabs modelValue={tab} onUpdateModelValue={onTabModel} items={tabs} size="sm" ariaLabel={t('files.detail.tabsLabel')} className="border-b border-border px-2" />

      {/* 댓글 — 입력이 바닥에 붙어야 해서 스크롤 영역 밖에 둔다 */}
      {tab === 'comments' && commentable
        ? <FilesFileCommentsPanel path={item.path} state={comments} />
        : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* 정보 */}
            {tab === 'info' && (
              <>
                {isImage && (
                  <div className="border-b border-border p-3.5">
                    <img src={getPreviewUrl(item.path)} alt={item.name} className="aspect-[4/3] w-full rounded-md bg-muted object-contain" />
                  </div>
                )}
                <div className="flex flex-col gap-4 p-4 text-[13px]">
                  {canRename && (
                    <UiInput
                      label={t('files.detail.renameLabel')}
                      modelValue={nameDraft}
                      onUpdateModelValue={setNameDraft}
                      hint={t('files.detail.renameHint')}
                      disabled={renaming}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); void commitRename() }
                        else if (e.key === 'Escape') { e.stopPropagation(); setNameDraft(item.name) }
                      }}
                      onBlur={() => { void commitRename() }}
                    />
                  )}
                  <dl className="grid items-center gap-x-3 gap-y-2.5" style={{ gridTemplateColumns: '80px 1fr' }}>
                    {myRole && (
                      <>
                        <dt className="text-muted-foreground">{t('files.detail.myRole')}</dt>
                        <dd className="flex min-w-0 items-center gap-2">
                          <UiBadge tone={ROLE_TONE[myRole]} tint size={18} className="shrink-0">{t(roleLabelKey(myRole))}</UiBadge>
                          <span className="truncate text-xs text-muted-foreground">{t(`files.detail.roleNote.${myRole}`)}</span>
                        </dd>
                      </>
                    )}
                    <dt className="text-muted-foreground">{t('files.detail.owner')}</dt>
                    <dd className="flex min-w-0 items-center gap-2">
                      {ownerName !== '—' && <UiAvatar fallback={initialOf(ownerName)} textSize={10} className="h-5 w-5 shrink-0" />}
                      <span className="truncate">{ownerName}</span>
                    </dd>
                    {infoRows.map(r => (
                      <Fragment key={r.label}>
                        <dt className="text-muted-foreground">{r.label}</dt>
                        <dd className={clsx('min-w-0 truncate', r.mono ? 'font-mono text-xs' : '')}>{r.value}</dd>
                      </Fragment>
                    ))}
                  </dl>
                </div>
                {/* 모바일: 정보 탭 맨 아래 활동 묶음(최근 5개 + 모두 보기) */}
                {isMobile && (
                  <section aria-label={t('files.detail.tabActivity')} className="border-t border-border">
                    <div className="flex h-11 items-center gap-2 px-4">
                      <h3 className="flex-1 text-xs font-semibold text-muted-foreground">{t('files.detail.tabActivity')}</h3>
                      {activity.length > 0 && !aLoading && !aError && (
                        <UiButton variant="link" size="xs" className="h-auto p-0 text-xs font-semibold" onClick={() => setAllActivity(true)}>{t('files.activity.viewAll')}</UiButton>
                      )}
                    </div>
                    {activityBody(activity.slice(0, 5), 'inline')}
                  </section>
                )}
              </>
            )}

            {/* 버전 */}
            {tab === 'versions' && (
              vLoading
                ? <UiSkeleton preset="list" rows={4} />
                : vError
                  ? <UiErrorTile placement="panel" title={vError} onRetry={loadVersions} />
                  : (
                    <>
                      {rows.map(r => (
                        <div key={r.key} className="flex gap-2.5 border-b border-border px-3.5 py-3 text-[13px]">
                          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground" aria-hidden="true">
                            {r.initial ? <span className="text-foreground">{r.initial}</span> : <UiIcon name="clock" className="h-3.5 w-3.5" />}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <b className="font-mono text-xs">{r.v}</b>
                              {r.cur && <UiBadge tone="success" tint size={18}>{t('files.versions.current')}</UiBadge>}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {r.meta.map((m, i) => (
                                <Fragment key={i}>{i ? <span> · </span> : null}<span className={i < 2 ? 'font-mono' : ''}>{m}</span></Fragment>
                              ))}
                            </div>
                            {!r.cur && (
                              <div className="mt-1 flex gap-2.5 text-xs font-semibold text-primary">
                                {r.url && <a href={r.url} download className="hover:underline" aria-label={t('files.versions.downloadItem', { label: r.v })}>{t('common.download')}</a>}
                                <button type="button" className="hover:underline disabled:opacity-50" disabled={restoring !== null} onClick={() => onRestore(r.key, r.v)}>
                                  {restoring === r.key ? t('files.versions.restoring') : t('files.versions.restoreThis')}
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                      <p className="px-3.5 py-3 text-xs text-muted-foreground">{t('files.versions.hint')}</p>
                    </>
                  )
            )}

            {/* 활동 */}
            {tab === 'activity' && activityBody(activity, 'panel')}
          </div>
        )}
    </aside>
  )
}

export default FilesFileDetailPanel
