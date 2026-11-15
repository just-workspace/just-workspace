/**
 * 탭 관리.
 * UiModal 480 "#채널 탭 관리":
 *  안내 13 muted → 목록(rounded-md border, 행 min-h-12):
 *    메시지 = lock 고정(옮기기·끄기 없음) · 나머지 = 끌기 손잡이(UiIconButton grip) + 아이콘 + 이름·설명 + UiSwitch.
 *    꺼진 모듈 = 흐리게 + 스위치 비활성 + 이유("{모듈} 모듈 꺼짐 — 관리자에게 요청").
 *    위키 = 연결된 스페이스 이름 · [바꾸기] — 스페이스를 고르기 전에는 켤 수 없다.
 *  → 아래 안내 12 muted. 바닥 [취소][저장] — 순서·끄기는 저장을 눌러야 채널 멤버 모두에게 적용된다.
 * 순서 바꾸기: 손잡이를 끌어 놓기(마우스) 또는 손잡이에서 ↑↓(키보드).
 * [바꾸기]·[폴더 연결]은 같은 창 안 하위 화면으로 들어가고, 거기서 연결하면 바로 저장된다(기존 동작).
 * 하위 화면: 제목 자리 = ‹(탭 관리로) + 제목(titleSlot).
 *  위키: UiInput 검색 → 스페이스 행 h-14(book-open · 이름 13 · "페이지 n · 공개범위|소유자" 12 muted), 고른 것 = primary 틴트 + 600 + ✓ →
 *        안내 12 muted "지금: …". 푸터 [뒤로][이 스페이스로].
 *  폴더: 경로 한 줄(13, 앞 칸 muted · › · 지금 칸 600) → 폴더 행 h-11(행 = 고르기, › = 들어가기; 더블클릭도 들어가기) → 안내.
 *        푸터 [뒤로]["이름" 연결] — 고른 행이 없으면 지금 들어와 있는 폴더.
 *  연결 해제 = 푸터 왼쪽 danger 글자 버튼, 누르면 확인형 모달(UiModal confirm sm) 뒤 해제.
 *  폴더 행의 "파일 n" 수와 "권한 없는 멤버 경고" 줄은 그리지 않는다 — 목록 API 에 하위 개수가 없고,
 *  폴더 연결은 채널 공유(FileShare.shared_with_channel_id)를 만들어 멤버 전원이 늘 읽을 수 있어 경고 대상이 생기지 않는다.
 */
import { Fragment, useEffect, useState, type DragEvent, type KeyboardEvent } from 'react'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { addToast, toast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { usePlatform } from '~/composables/usePlatform'
import { orderedTabs, updateTabs, type ChannelTabMovable, type ChannelTabsSummary } from '~/composables/useChannelTabs'
import type { FileItem, FileListResponse } from '~/composables/useFiles'
import { TAB_MODULE } from './ChannelTabs'
import { UiModal } from '~/components/ui/Modal'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiButton } from '~/components/ui/Button'
import { UiInput } from '~/components/ui/Input'
import { UiSwitch } from '~/components/ui/Switch'

export interface ChatChannelTabsManageProps {
  channelId: string
  /** 채널 이름(제목 "#이름 탭 관리") */
  channelName?: string
  /** 지금 탭 요약 */
  summary: ChannelTabsSummary | null
  onClose?: () => void
  /** 저장됨 — 새 요약 */
  onSaved?: (summary: ChannelTabsSummary) => void
}

interface Space {
  id: string
  name: string
  visibility?: string
  page_count?: number
  owner?: { display_name?: string | null; username?: string | null } | null
}
type View = 'tabs' | 'wiki' | 'folder'

const TAB_ICON: Record<ChannelTabMovable | 'messages', string> = {
  messages: 'chat', files: 'folder', wiki: 'book-open', meetings: 'video', tasks: 'check-square',
}

/** 탭 관리 모달(순서·끄기 + 위키 스페이스·폴더 연결) */
export function ChatChannelTabsManage({ channelId, channelName, summary, onClose, onSaved }: ChatChannelTabsManageProps) {
  const { t } = useI18n()
  const { isModuleEnabled } = usePlatform()
  const [view, setView] = useState<View>('tabs')
  const [busy, setBusy] = useState(false)

  // ── 순서·끄기(저장 전 초안) ──
  const [rows, setRows] = useState(() => orderedTabs(summary))
  const hasWiki = !!(summary?.wiki_space || summary?.wiki)
  const moduleOff = (k: ChannelTabMovable) => !isModuleEnabled(TAB_MODULE[k])
  const locked = (k: ChannelTabMovable) => moduleOff(k) || (k === 'wiki' && !hasWiki)

  function move(from: number, to: number) {
    if (to < 0 || to >= rows.length || from === to) return
    setRows((r) => {
      const next = [...r]
      const [x] = next.splice(from, 1)
      next.splice(to, 0, x)
      return next
    })
  }
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragArmed, setDragArmed] = useState<number | null>(null)
  function onDragStart(e: DragEvent, i: number) {
    if (dragArmed !== i) { e.preventDefault(); return }
    setDragFrom(i)
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', rows[i].key) } catch { /* 일부 브라우저 */ }
  }
  function onDragOver(e: DragEvent, i: number) {
    if (dragFrom === null) return
    e.preventDefault()
    if (dragFrom !== i) { move(dragFrom, i); setDragFrom(i); setDragArmed(i) }
  }
  function onHandleKey(e: KeyboardEvent, i: number) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const j = i + (e.key === 'ArrowUp' ? -1 : 1)
    move(i, j)
    // 옮긴 행의 손잡이에 포커스를 남긴다
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-tab-handle="${rows[i].key}"]`)?.focus()
    })
  }

  async function saveLayout() {
    setBusy(true)
    try {
      const s = await updateTabs(channelId, {
        layout: { order: rows.map(r => r.key), hidden: rows.filter(r => !r.visible).map(r => r.key) },
      })
      onSaved?.(s)
      toast({ type: 'success', title: t('chat.tabs.layoutSaved') })
      onClose?.()
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('chat.tabs.manageFailed'))
    } finally { setBusy(false) }
  }

  // ── 하위 화면: 연결(바로 저장) ──
  async function link(body: Parameters<typeof updateTabs>[1], msg: string) {
    setBusy(true)
    try {
      const s = await updateTabs(channelId, body)
      onSaved?.(s)
      toast({ type: 'success', title: msg })
      setView('tabs')
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('chat.tabs.manageFailed'))
    } finally { setBusy(false) }
  }

  // 위키 스페이스
  const [spaces, setSpaces] = useState<Space[]>([])
  const [spacesLoaded, setSpacesLoaded] = useState(false)
  const [spaceId, setSpaceId] = useState<string | null>(summary?.wiki_space?.id ?? null)
  const [spaceQuery, setSpaceQuery] = useState('')
  useEffect(() => {
    if (view !== 'wiki' || spacesLoaded) return
    void (async () => {
      try { setSpaces(await $fetch<Space[]>('/api/wiki/spaces')) } catch { setSpaces([]) } finally { setSpacesLoaded(true) }
    })()
  }, [view, spacesLoaded])
  const shownSpaces = (() => {
    const q = spaceQuery.trim().toLowerCase()
    return q ? spaces.filter(s => s.name.toLowerCase().includes(q)) : spaces
  })()
  // 행 보조 줄 "페이지 n · 전체 공개 | 소유자"
  const spaceMeta = (s: Space) => [
    t('chat.tabs.spacePages', { n: s.page_count ?? 0 }),
    s.visibility === 'public' ? t('chat.tabs.spacePublic') : (s.owner?.display_name || s.owner?.username || ''),
  ].filter(Boolean).join(' · ')

  // 폴더
  const [dir, setDir] = useState('my')
  const [folders, setFolders] = useState<FileItem[]>([])
  const [loadingDir, setLoadingDir] = useState(false)
  /** 행 클릭으로 고른 폴더(없으면 지금 들어와 있는 폴더를 연결) */
  const [picked, setPicked] = useState<string | null>(null)
  async function loadDir(p: string) {
    setLoadingDir(true)
    setPicked(null)
    try {
      const r = await $fetch<FileListResponse>('/api/files/list', { params: { path: p } })
      setDir(r.path || p)
      setFolders(r.items.filter(i => i.is_dir))
    } catch { setFolders([]) } finally { setLoadingDir(false) }
  }
  useEffect(() => {
    if (view === 'folder') void loadDir(summary?.folder?.mine && summary.folder.path ? summary.folder.path : 'my')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])
  const parts = dir.split('/').filter(Boolean)
  const crumbs = parts.map((p, i) => ({ label: i === 0 ? t('files.sidebar.myFiles') : p, path: parts.slice(0, i + 1).join('/') }))
  const folderNow = (() => {
    const f = summary?.folder
    if (!f) return ''
    return [f.mine ? t('files.sidebar.myFiles') : f.owner_name, ...f.segments].join(' › ')
  })()

  const title = channelName ? t('chat.tabs.manageTitle', { name: channelName }) : t('chat.tabs.manage')
  const inlineLink = 'h-auto p-0 align-baseline text-xs font-semibold'

  function desc(k: ChannelTabMovable) {
    const name = t(`chat.tabs.${k}`)
    if (moduleOff(k)) return t('chat.tabs.moduleOff', { name })
    if (k === 'wiki') {
      return hasWiki
        ? <>{summary?.wiki_space?.name ?? summary?.wiki?.title} · <UiButton variant="link" size="xs" className={inlineLink} onClick={() => setView('wiki')}>{t('chat.tabs.change')}</UiButton></>
        : <>{t('chat.tabs.descWikiNone')} · <UiButton variant="link" size="xs" className={inlineLink} onClick={() => setView('wiki')}>{t('chat.tabs.choose')}</UiButton></>
    }
    if (k === 'files') {
      return (
        <>
          {t('chat.tabs.descFiles')}
          {summary?.can_manage && <> · <UiButton variant="link" size="xs" className={inlineLink} onClick={() => setView('folder')}>{folderNow || t('chat.tabs.linkFolder')}</UiButton></>}
        </>
      )
    }
    return t(k === 'meetings' ? 'chat.tabs.descMeetings' : 'chat.tabs.descTasks')
  }

  // 폴더 화면: 연결할 대상 = 고른 행, 없으면 지금 들어와 있는 폴더(내 파일 맨 위는 연결 못 함)
  const folderTarget = picked ?? (dir !== 'my' ? dir : null)
  const folderTargetName = folderTarget ? folderTarget.split('/').filter(Boolean).pop() ?? '' : ''

  // 연결 해제 — 푸터 왼쪽 danger 글자 버튼 → 확인형 모달(sm) → 해제
  async function confirmUnlink(body: Parameters<typeof updateTabs>[1], msg: string, kind: 'wiki' | 'folder') {
    const ok = await confirmBox(t(kind === 'wiki' ? 'chat.tabs.unlinkWikiBody' : 'chat.tabs.unlinkFolderBody'), {
      title: t('chat.tabs.unlinkTitle'),
      confirmLabel: t('chat.tabs.unlink'),
      danger: true,
      size: 'sm',
    })
    if (ok) await link(body, msg)
  }
  const unlinkBtn = (body: Parameters<typeof updateTabs>[1], msg: string, kind: 'wiki' | 'folder') => (
    <UiButton variant="ghost" size="sm" className="mr-auto text-danger hover:text-danger" disabled={busy} onClick={() => { void confirmUnlink(body, msg, kind) }}>
      {t('chat.tabs.unlink')}
    </UiButton>
  )

  const footer = view === 'tabs'
    ? (
      <>
        <UiButton variant="outline" size="sm" onClick={() => onClose?.()}>{t('common.cancel')}</UiButton>
        <UiButton size="sm" disabled={busy} onClick={() => { void saveLayout() }}>{t('common.save')}</UiButton>
      </>
    )
    : view === 'wiki'
      ? (
        <>
          {hasWiki && unlinkBtn({ wiki_space_id: null }, t('chat.tabs.wikiUnlinked'), 'wiki')}
          <UiButton variant="outline" size="sm" onClick={() => setView('tabs')}>{t('common.back')}</UiButton>
          <UiButton size="sm" disabled={busy || !spaceId || spaceId === summary?.wiki_space?.id} onClick={() => { void link({ wiki_space_id: spaceId }, t('chat.tabs.spaceLinked')) }}>
            {t('chat.tabs.toThisSpace')}
          </UiButton>
        </>
      )
      : (
        <>
          {summary?.folder && unlinkBtn({ folder_path: null }, t('chat.tabs.folderUnlinked'), 'folder')}
          <UiButton variant="outline" size="sm" onClick={() => setView('tabs')}>{t('common.back')}</UiButton>
          <UiButton size="sm" disabled={busy || !folderTarget} onClick={() => { if (folderTarget) void link({ folder_path: folderTarget }, t('chat.tabs.folderLinked')) }}>
            {folderTarget ? t('chat.tabs.linkNamed', { name: folderTargetName }) : t('chat.tabs.linkThisFolder')}
          </UiButton>
        </>
      )

  // 하위 화면 제목 자리 = ‹ + 제목
  const subTitle = view === 'tabs' ? null : (
    <div className="flex items-center gap-1.5">
      <UiIconButton icon="chevron-left" label={t('chat.tabs.backToManage')} size="sm" onClick={() => setView('tabs')} />
      <span>{t(view === 'wiki' ? 'chat.tabs.wikiPickTitle' : 'chat.tabs.folderPickTitle')}</span>
    </div>
  )

  return (
    <UiModal
      title={view === 'tabs' ? title : undefined}
      titleSlot={subTitle ?? undefined}
      ariaLabel={view === 'tabs' ? undefined : t(view === 'wiki' ? 'chat.tabs.wikiPickTitle' : 'chat.tabs.folderPickTitle')}
      size="480"
      onClose={() => onClose?.()}
      footer={footer}
    >
      {view === 'tabs' && (
        <>
          <p className="text-[13px] text-muted-foreground">{t('chat.tabs.manageIntro')}</p>
          <div className="flex flex-col rounded-md border border-border">
            <div className="flex min-h-12 items-center gap-3 border-b border-border px-3 last:border-b-0">
              <UiIcon name="lock" className="h-4 w-4 text-muted-foreground" />
              <UiIcon name={TAB_ICON.messages} className="h-4 w-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold">{t('chat.tabs.messages')}</div>
                <div className="truncate text-xs text-muted-foreground">{t('chat.tabs.descMessages')}</div>
              </div>
            </div>
            {rows.map((r, i) => {
              const name = t(`chat.tabs.${r.key}`)
              const off = locked(r.key)
              return (
                <div
                  key={r.key}
                  draggable={dragArmed === i}
                  onDragStart={(e) => onDragStart(e, i)}
                  onDragOver={(e) => onDragOver(e, i)}
                  onDragEnd={() => { setDragFrom(null); setDragArmed(null) }}
                  onDrop={(e) => { e.preventDefault(); setDragFrom(null); setDragArmed(null) }}
                  className={cn('flex min-h-12 items-center gap-3 border-b border-border px-3 last:border-b-0', dragFrom === i && 'bg-accent/60', moduleOff(r.key) && 'opacity-50')}
                >
                  <UiIconButton
                    icon="grip"
                    label={t('chat.tabs.dragTab', { name })}
                    data-tab-handle={r.key}
                    className="cursor-grab active:cursor-grabbing"
                    onPointerDown={() => setDragArmed(i)}
                    onPointerUp={() => { if (dragFrom === null) setDragArmed(null) }}
                    onKeyDown={(e) => onHandleKey(e, i)}
                  />
                  <UiIcon name={TAB_ICON[r.key]} className="h-4 w-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold">{name}</div>
                    <div className="truncate text-xs text-muted-foreground">{desc(r.key)}</div>
                  </div>
                  <UiSwitch
                    ariaLabel={t('chat.tabs.showTab', { name })}
                    modelValue={r.visible && !off}
                    disabled={off}
                    onUpdateModelValue={(v) => setRows(rs => rs.map(x => (x.key === r.key ? { ...x, visible: v } : x)))}
                  />
                </div>
              )
            })}
          </div>
          <p className="text-xs text-muted-foreground">{t('chat.tabs.manageFoot')}</p>
        </>
      )}

      {view === 'wiki' && (
        <>
          <UiInput icon="search" modelValue={spaceQuery} onUpdateModelValue={setSpaceQuery} placeholder={t('chat.tabs.findSpace')} aria-label={t('chat.tabs.findSpace')} />
          <div className="flex flex-col rounded-md border border-border" role="listbox" aria-label={t('chat.tabs.pickSpace')}>
            {!spacesLoaded
              ? <UiSkeleton preset="list" rows={3} className="px-3" />
              : !shownSpaces.length
                ? <p className="px-3 py-3 text-xs text-muted-foreground">{t('chat.tabs.noSpaceMatch')}</p>
                : shownSpaces.map((s) => {
                  const on = s.id === spaceId
                  return (
                    <button
                      key={s.id}
                      type="button"
                      role="option"
                      aria-selected={on}
                      className={cn('flex h-14 items-center gap-3 border-b border-border px-3 text-left last:border-b-0 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', on ? 'bg-primary/15' : 'hover:bg-accent/50')}
                      onClick={() => setSpaceId(s.id)}
                    >
                      <UiIcon name="book-open" className={cn('h-4 w-4', on ? 'text-primary' : 'text-muted-foreground')} />
                      <div className="min-w-0 flex-1">
                        <div className={cn('truncate text-[13px]', on && 'font-semibold')}>{s.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{spaceMeta(s)}</div>
                      </div>
                      {on && <UiIcon name="check" className="h-4 w-4 text-primary" />}
                    </button>
                  )
                })}
          </div>
          <p className="text-xs text-muted-foreground">
            {summary?.wiki_space?.name ? t('chat.tabs.spaceNote', { name: summary.wiki_space.name }) : t('chat.tabs.spaceNoteNone')}
          </p>
        </>
      )}

      {view === 'folder' && (
        <>
          <nav className="flex flex-wrap items-center gap-1 text-[13px]" aria-label={t('chat.tabs.folderPath')}>
            {crumbs.map((c, i) => {
              const last = i === crumbs.length - 1
              return (
                <Fragment key={c.path}>
                  {i > 0 && <UiIcon name="chevron-right" className="h-3.5 w-3.5 text-muted-foreground" />}
                  {last
                    ? <span className="font-semibold" aria-current="location">{c.label}</span>
                    : <button type="button" className="rounded-sm text-muted-foreground hover:text-foreground hover:underline" onClick={() => { void loadDir(c.path) }}>{c.label}</button>}
                </Fragment>
              )
            })}
          </nav>
          <div className="flex flex-col rounded-md border border-border" role="listbox" aria-label={t('chat.tabs.folderPickTitle')}>
            {loadingDir
              ? <UiSkeleton preset="list" rows={3} className="px-3" />
              : !folders.length
                ? <p className="px-3 py-3 text-xs text-muted-foreground">{t('chat.tabs.noSubfolders')}</p>
                : folders.map((f) => {
                  const on = f.path === picked
                  return (
                    <div key={f.path} className={cn('flex h-11 items-center border-b border-border text-[13px] last:border-b-0', on ? 'bg-primary/15 font-semibold' : 'hover:bg-accent/50')}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={on}
                        className="flex h-full min-w-0 flex-1 items-center gap-3 pl-3 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        onClick={() => setPicked(f.path)}
                        onDoubleClick={() => { void loadDir(f.path) }}
                      >
                        <UiIcon name="folder" className={cn('h-4 w-4', on ? 'text-primary' : 'text-muted-foreground')} />
                        <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={t('chat.tabs.enterFolder', { name: f.name })}
                        className="grid h-full w-10 shrink-0 place-items-center text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        onClick={() => { void loadDir(f.path) }}
                      >
                        <UiIcon name="chevron-right" className="h-4 w-4" />
                      </button>
                    </div>
                  )
                })}
          </div>
          <p className="text-xs text-muted-foreground">{t('chat.tabs.linkFolderHint')}</p>
        </>
      )}
    </UiModal>
  )
}

export default ChatChannelTabsManage
