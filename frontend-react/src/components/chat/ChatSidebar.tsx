/**
 * 채팅 사이드바(handover-21+22 "디스코드와 동등" · 시안 Chat22 #list #voice #cat-* #drag* #mute-menu · Mob22 #m-list #m-order).
 * 데스크톱: 머리 48(워크스페이스 이름 + chevron-down 메뉴 · 오른쪽 32 아이콘 3개 = 내 스레드·임시 저장·저장한 메시지, 새 글 = danger 점)
 *   → 구역(분류 없음 · 사용자 카테고리 · 시스템 "보관된 프로젝트" · 다이렉트 메시지, useChatLayout.buildSections)
 *   → 맨 아래 계정 패널(SHELL 의 ChatAccountPanel — 음성 접속 줄 포함).
 * 음성 접속자 줄 우클릭·길게 누르기 = 사람별 음량(SHELL 의 openUserVolume — 그리는 곳은 pages/chat 의 ChatUserVolumeHost).
 * 모바일: 머리 56(이름 · 검색 44 · ⋯ 44 = 워크스페이스 메뉴 · 순서 편집) → 3칸 버튼 44 → 구역(행 44). 순서 편집은 ChatSidebarOrderMobile.
 * 정렬·이름·만들기는 MANAGE_CHANNELS(useChatRoles.canWorkspace) 가 있어야 보인다. 접힘은 사람마다(localStorage).
 * 끌기(HTML5 DnD): 채널 → 다른 자리(자리 선 UiDropLine) · 다른 카테고리 제목 위(강조 + 600ms 머물면 펼침) · 보관된 프로젝트(= 보관).
 *   카테고리 제목째 끌기(사용자 카테고리만). DM·시스템 카테고리는 끌기 불가. 놓으면 PATCH /layout(useChatLayout), 실패하면 다시 읽어 되돌리고 토스트.
 *   키보드 대안: 채널 행 Alt+Shift+↑↓ · 카테고리 제목 Alt(+Shift)+↑↓ / F2 이름 바꾸기, 결과는 aria-live.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useStore } from 'zustand'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { useChat, type Channel, type VoicePresence } from '~/composables/useChat'
import { chatUiStore, openChatSettings, setCollection, setInviteOpen } from '~/composables/useChatUi'
import {
  buildSections, chatLayoutStore, loadCategories, setCollapsed, toggleCollapsed, useChatLayout, type SidebarSection,
} from '~/composables/useChatLayout'
import { canWorkspace, loadMyWorkspacePerms, PERM, useChatRoles } from '~/composables/useChatRoles'
import { useChatServerName } from '~/components/chat/settings/serverSettingsStore'
import { addToast } from '~/composables/useToast'
import { isChannelBold } from '~/lib/chatEvents'
import { joinVoice, voiceStore } from '~/composables/useVoice'
import { useIsMobile } from '~/composables/useIsMobile'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiIcon } from '~/components/ui/Icon'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiDropLine } from '~/components/ui/DragHandle'
import {
  categoryDropIndex, categoryMovedText, channelLabel, channelMovedText, dropIndexFromPointer, fullIndexFromVisible,
  isDraggableSection, isDropSection, moveCategoryTo, moveChannelTo, movingText, sectionVisibleChannels, stepCategory, stepChannel,
} from '~/utils/chatSidebarDnd'
import { ChatChannelItem } from './ChatChannelItem'
import { ChatChannelMenu } from './ChatChannelMenu'
import { ChatCategorySection } from './ChatCategorySection'
import { ChatCategoryMenu } from './ChatCategoryMenu'
import { ChatCategoryCreateDialog, ChatCategoryDeleteDialog, ChatNewDmDialog } from './ChatCategoryDialogs'
import { ChatCreateModal } from './ChatCreateModal'
import { ChatSidebarOrderMobile } from './ChatSidebarOrderMobile'
import { ChatAccountPanel } from './ChatAccountPanel'
import { openUserVolume } from './ChatUserVolume'

export interface ChatSidebarProps {
  /** 채널·모아보기로 이동했다(모바일 단계 전환용) */
  onNavigate?: () => void
  /** (호환) 새 채널 만들기 — 사이드바가 자체 모달을 띄우므로 쓰지 않는다 */
  onCreateChannel?: () => void
  /** 모바일 머리 🔍 — 메시지 검색 */
  onSearch?: () => void
}

type Drag = { kind: 'channel'; id: string; sectionId: string } | { kind: 'category'; id: string }
type Over =
  | { kind: 'row'; sectionId: string; vIndex: number }
  | { kind: 'header'; sectionId: string }
  | { kind: 'cat'; sectionId: string; after: boolean }

const SKELETON_W = ['46%', '62%', '38%', '54%']
const HOVER_EXPAND_MS = 600
const rowDomId = (id: string) => `chat-row-${id}`

/** 떠 있는 고스트(끌기 이미지) — primary/60 테두리 + 그림자. 끌기 시작 순간 만들고 다음 틱에 지운다 */
function setGhost(e: DragEvent<HTMLElement>, text: string) {
  try {
    const g = document.createElement('div')
    g.className = 'pointer-events-none fixed left-0 top-[-1000px] flex h-8 items-center gap-2 rounded-lg border border-primary/60 bg-popover px-2 text-[16px] font-semibold text-foreground shadow-xl'
    g.style.width = '250px'
    g.textContent = text
    document.body.appendChild(g)
    e.dataTransfer.setDragImage(g, 16, 16)
    setTimeout(() => g.remove(), 0)
  } catch { /* 고스트 없이도 끌린다 */ }
}

/** 채널 목록(데스크톱 사이드바 · 모바일 첫 화면) */
export function ChatSidebar({ onNavigate, onSearch }: ChatSidebarProps) {
  const { t, locale } = useI18n()
  const chat = useChat()
  const { channels, selectedChannelId, loadingChannels, channelsError, threadUnread, drafts } = chat
  const collection = useStore(chatUiStore, s => s.collection)
  // 머리 이름 = 채팅 서버 설정 이름(Settings22 개요), 비면 사이트 이름 — SETTINGS 연결
  const appName = useChatServerName()
  const isMobile = useIsMobile()
  const myVoiceId = useStore(voiceStore, s => s.channelId)
  const categories = useChatLayout(s => s.categories)
  const archiveId = useChatLayout(s => s.archiveCategoryId)
  const collapsed = useChatLayout(s => s.collapsed)
  const canManage = useChatRoles(s => canWorkspace(PERM.MANAGE_CHANNELS, s))

  // 앱 시작 — 카테고리·내 워크스페이스 권한
  useEffect(() => { void loadCategories(); void loadMyWorkspacePerms() }, [])

  const sections = useMemo(
    () => buildSections(channels, categories, archiveId, collapsed, { archive: t('chat.side.archive'), dm: t('chat.side.dm') }),
    [channels, categories, archiveId, collapsed, t],
  )
  const userSections = sections.filter(s => s.kind === 'user')

  // ─── 화면 상태 ───
  const [chMenu, setChMenu] = useState<{ channel: Channel; anchor: DOMRect } | null>(null)
  const [catMenu, setCatMenu] = useState<{ section: SidebarSection; anchor: HTMLElement } | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [newCat, setNewCat] = useState(false)
  const [delCat, setDelCat] = useState<SidebarSection | null>(null)
  const [createIn, setCreateIn] = useState<{ categoryId: string | null } | null>(null)
  const [newDm, setNewDm] = useState(false)
  const [ordering, setOrdering] = useState(false)
  const [live, setLive] = useState('')
  const [liveAssert, setLiveAssert] = useState('')
  function onOccupantMenu(p: VoicePresence, r: DOMRect) {
    if (!p.user_id) return
    openUserVolume({ userId: p.user_id, name: p.name, avatarUrl: p.avatar_url, anchor: { x: r.left, y: r.top, w: r.width, h: r.height } })
  }

  // ─── 끌기 ───
  const [drag, setDrag] = useState<Drag | null>(null)
  const [over, setOver] = useState<Over | null>(null)
  const expandTimer = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const clearExpand = () => { if (expandTimer.current) clearTimeout(expandTimer.current.timer); expandTimer.current = null }
  useEffect(() => clearExpand, [])

  const nameOf = (s: SidebarSection) => (s.kind === 'uncategorized' ? t('chat.side.uncategorized') : s.name)
  const visibleOf = (s: SidebarSection) => sectionVisibleChannels(s, selectedChannelId, isChannelBold, myVoiceId)

  async function onSelect(id: string) {
    await chat.selectChannel(id)
    onNavigate?.()
  }
  // 음성 채널(handover-20): 누르면 바로 들어가고(벨 없음) 본문도 그 채널로. 실패는 세션이 토스트로 알린다.
  async function onVoice(id: string) {
    void chat.selectChannel(id)
    onNavigate?.()
    try { await joinVoice(id) } catch { /* 토스트는 useVoice 가 띄웠다 */ }
  }

  const draftCount = Object.values(drafts).filter(d => d.content.trim()).length
  function openCollection(kind: 'threads' | 'drafts' | 'saved') {
    chat.deselectChannel()
    setCollection(kind)
    if (kind === 'threads') void chat.fetchThreads()
    else if (kind === 'saved') void chat.fetchSaved()
    onNavigate?.()
  }

  // ─── 옮기기(끌기·키보드 공용) ───
  async function doMoveChannel(c: Channel, toSectionId: string, index: number, refocus = false) {
    try {
      const plan = await moveChannelTo(sections, c.id, toSectionId, index)
      if (!plan) return
      const sec = sections.find(s => s.id === plan.toSectionId)
      setLive(channelMovedText(t, locale, c, sec ? nameOf(sec) : '', plan.index))
      if (refocus) requestAnimationFrame(() => document.getElementById(rowDomId(c.id))?.focus())
    } catch {
      addToast('error', t('chat.side.moveFailed'))
    }
  }
  async function doMoveCategory(id: string, index: number) {
    const name = sections.find(s => s.id === id)?.name || ''
    try {
      await moveCategoryTo(id, index)
      setLive(categoryMovedText(t, locale, name, index))
    } catch {
      addToast('error', t('chat.side.moveFailed'))
    }
  }
  function stepCh(c: Channel, d: -1 | 1) {
    const s = stepChannel(sections, c.id, d)
    if (s) void doMoveChannel(c, s.toSectionId, s.index, true)
  }
  function stepCat(id: string, d: -1 | 1) {
    const i = stepCategory(chatLayoutStore.getState().categories, id, d)
    if (i !== null) void doMoveCategory(id, i)
  }
  function collapseAll() {
    for (const s of sections) if (s.kind !== 'uncategorized') setCollapsed(s.id, true)
  }

  // ─── HTML5 끌기 핸들러 ───
  function endDrag() {
    clearExpand()
    setDrag(null)
    setOver(null)
    setLiveAssert('')
  }
  function rowDragStart(e: DragEvent<HTMLElement>, s: SidebarSection, c: Channel) {
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', c.id) } catch { /* 일부 브라우저 */ }
    setGhost(e, channelLabel(c))
    setDrag({ kind: 'channel', id: c.id, sectionId: s.id })
    setLiveAssert(movingText(t, locale, channelLabel(c)))
  }
  function headerDragStart(e: DragEvent<HTMLElement>, s: SidebarSection) {
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', s.id) } catch { /* 일부 브라우저 */ }
    setGhost(e, t('chat.side.ghostCat', { name: s.name, n: s.channels.length }))
    setDrag({ kind: 'category', id: s.id })
    setLiveAssert(t('chat.side.catMoving', { name: s.name }))
  }
  function rowDragOver(e: DragEvent<HTMLElement>, s: SidebarSection, vIndex: number) {
    if (drag?.kind !== 'channel' || !isDropSection(s)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (s.kind === 'system') { setOver({ kind: 'header', sectionId: s.id }); return }
    const idx = dropIndexFromPointer(vIndex, e.clientY, e.currentTarget.getBoundingClientRect())
    setOver(o => (o?.kind === 'row' && o.sectionId === s.id && o.vIndex === idx ? o : { kind: 'row', sectionId: s.id, vIndex: idx }))
  }
  function headerDragOver(e: DragEvent<HTMLElement>, s: SidebarSection) {
    if (drag?.kind !== 'channel' || !isDropSection(s)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setOver(o => (o?.kind === 'header' && o.sectionId === s.id ? o : { kind: 'header', sectionId: s.id }))
    // 잠시 머물면 펼친다
    if (s.collapsed && expandTimer.current?.id !== s.id) {
      clearExpand()
      expandTimer.current = { id: s.id, timer: setTimeout(() => { setCollapsed(s.id, false); expandTimer.current = null }, HOVER_EXPAND_MS) }
    }
  }
  function headerDragLeave(_e: DragEvent<HTMLElement>, s: SidebarSection) {
    if (expandTimer.current?.id === s.id) clearExpand()
  }
  function bodyDragOver(e: DragEvent<HTMLElement>, s: SidebarSection) {
    if (!drag) return
    if (drag.kind === 'channel') {
      if (e.defaultPrevented || !isDropSection(s)) return
      e.preventDefault()
      if (s.kind === 'system') { setOver({ kind: 'header', sectionId: s.id }); return }
      // 빈 칸·구역 아래 여백 = 맨 아래로
      const v = visibleOf(s).filter(c => c.id !== drag.id).length
      setOver(o => (o?.kind === 'row' && o.sectionId === s.id && o.vIndex >= v ? o : { kind: 'row', sectionId: s.id, vIndex: visibleOf(s).length }))
      return
    }
    // 카테고리 끌기 — 사용자 카테고리 앞/뒤, 보관·DM 위 = 사용자 카테고리 맨 끝, 분류 없음 = 맨 앞
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    let next: Over
    if (s.kind === 'user') {
      const r = e.currentTarget.getBoundingClientRect()
      next = { kind: 'cat', sectionId: s.id, after: e.clientY > r.top + r.height / 2 }
    } else if (s.kind === 'uncategorized') next = { kind: 'cat', sectionId: s.id, after: true }
    else {
      const firstNonUser = sections.find(x => x.kind === 'system' || x.kind === 'dm')
      next = { kind: 'cat', sectionId: firstNonUser?.id || s.id, after: false }
    }
    setOver(o => (o?.kind === 'cat' && o.sectionId === next.sectionId && (o as { after: boolean }).after === (next as { after: boolean }).after ? o : next))
  }
  function onDrop(e: DragEvent<HTMLElement>) {
    if (!drag || !over) { endDrag(); return }
    e.preventDefault()
    e.stopPropagation()
    const d = drag
    const o = over
    endDrag()
    if (d.kind === 'channel') {
      const c = channels.find(x => x.id === d.id)
      const s = sections.find(x => x.id === o.sectionId)
      if (!c || !s) return
      if (o.kind === 'header') {
        void doMoveChannel(c, s.id, s.channels.filter(x => x.id !== c.id).length)
      } else if (o.kind === 'row') {
        void doMoveChannel(c, s.id, fullIndexFromVisible(s, visibleOf(s), o.vIndex, c.id))
      }
      return
    }
    if (o.kind !== 'cat' || o.sectionId === d.id) return
    const s = sections.find(x => x.id === o.sectionId)
    if (!s) return
    const cats = chatLayoutStore.getState().categories
    let idx: number | null
    if (s.kind === 'user') idx = categoryDropIndex(cats, d.id, s.id, o.after)
    else if (s.kind === 'uncategorized') idx = 0
    else idx = cats.filter(c => !c.system && c.id !== d.id).length
    if (idx !== null) void doMoveCategory(d.id, idx)
  }

  // ─── 메뉴 ───
  const headerMenu: UiMenuItem[] = [
    { key: 'settings', label: t('chat.side.menuSettings'), icon: 'settings' },
    ...(canManage ? [{ key: 'newCat', label: t('chat.side.menuNewCategory'), icon: 'folder', separated: true }] : []),
    { key: 'newCh', label: t('chat.side.menuNewChannel'), icon: 'plus', separated: !canManage },
    ...(isMobile ? [{ key: 'newDm', label: t('chat.side.menuNewDm'), icon: 'edit' }] : []),
    ...(isMobile && canManage ? [{ key: 'order', label: t('chat.side.menuOrder'), icon: 'grip-vertical', separated: true }] : []),
  ]
  function runHeaderMenu(k: string) {
    if (k === 'settings') openChatSettings()
    else if (k === 'newCat') setNewCat(true)
    else if (k === 'newCh') setCreateIn({ categoryId: null })
    else if (k === 'newDm') setNewDm(true)
    else if (k === 'order') setOrdering(true)
  }

  const shortcuts = [
    { kind: 'threads' as const, icon: 'threads', label: t('chat.side.myThreads'), short: t('chat.side.threadsShort'), dot: threadUnread.threads > 0 },
    { kind: 'drafts' as const, icon: 'edit-3', label: t('chat.side.drafts'), short: t('chat.side.drafts'), dot: false, count: draftCount },
    { kind: 'saved' as const, icon: 'bookmark', label: t('chat.side.saved'), short: t('chat.side.savedShort'), dot: false },
  ]

  const showSkeleton = loadingChannels && channels.length === 0
  const listFailed = !loadingChannels && !!channelsError && channels.length === 0
  const nothing = channels.length === 0 && userSections.length === 0

  // ─── 모바일 순서 편집 ───
  if (isMobile && ordering) {
    return <ChatSidebarOrderMobile sections={sections} onDone={() => setOrdering(false)} />
  }

  function renderSection(s: SidebarSection) {
    const visible = visibleOf(s)
    const isUserCat = s.kind === 'user'
    const renamable = canManage && !!s.category && (isUserCat || s.kind === 'system')
    const headerHi = drag?.kind === 'channel' && over?.kind === 'header' && over.sectionId === s.id && s.id !== drag.sectionId
    const catLine = drag?.kind === 'category' && over?.kind === 'cat' && over.sectionId === s.id ? (over.after ? 'after' : 'before') : null
    const rowLine = drag?.kind === 'channel' && over?.kind === 'row' && over.sectionId === s.id ? over.vIndex : -1
    const canDragRows = canManage && !isMobile && s.kind !== 'dm'
    return (
      <ChatCategorySection
        key={s.id || 'uncategorized'}
        section={s}
        mobile={isMobile}
        canManage={canManage}
        renaming={renamingId === s.id}
        onRenameDone={() => setRenamingId(null)}
        onToggle={() => toggleCollapsed(s.id)}
        onMenu={s.kind === 'user' || s.kind === 'system' ? (el) => setCatMenu({ section: s, anchor: el }) : undefined}
        onAdd={s.kind === 'dm' ? () => setNewDm(true) : isUserCat && canManage ? () => setCreateIn({ categoryId: s.id }) : undefined}
        onRename={renamable ? () => setRenamingId(s.id) : undefined}
        onMoveCategory={canManage && isUserCat ? (d) => stepCat(s.id, d) : undefined}
        dropHighlight={headerHi}
        catLine={catLine}
        ghosted={drag?.kind === 'category' && drag.id === s.id}
        headerDraggable={canManage && !isMobile && isUserCat}
        onHeaderDragStart={(e) => headerDragStart(e, s)}
        onHeaderDragEnd={endDrag}
        onHeaderDragOver={(e) => headerDragOver(e, s)}
        onHeaderDragLeave={(e) => headerDragLeave(e, s)}
        onHeaderDrop={onDrop}
        onBodyDragOver={(e) => bodyDragOver(e, s)}
        onBodyDrop={onDrop}
      >
        {visible.map((c, i) => (
          <div key={c.id} className="flex flex-col">
            {rowLine === i && <UiDropLine className="my-0.5" />}
            <ChatChannelItem
              channel={c}
              rowId={rowDomId(c.id)}
              selected={c.id === selectedChannelId}
              dmName={c.type === 'dm' ? chat.getDMDisplayName(c) : undefined}
              mobile={isMobile}
              sectionCollapsed={s.collapsed}
              ghosted={drag?.kind === 'channel' && drag.id === c.id}
              canManage={canManage}
              onClick={() => { void (c.is_voice ? onVoice(c.id) : onSelect(c.id)) }}
              onMenu={(anchor) => setChMenu({ channel: c, anchor })}
              onKeyMove={canManage && isDraggableSection(s) ? (d) => stepCh(c, d) : undefined}
              onInvite={c.type !== 'dm' ? () => { void chat.selectChannel(c.id).then(() => setInviteOpen(true)) } : undefined}
              onSettings={() => openChatSettings('channel-perm', c.id)}
              onOccupantMenu={onOccupantMenu}
              draggable={canDragRows}
              onDragStart={canDragRows ? (e) => rowDragStart(e, s, c) : undefined}
              onDragEnd={endDrag}
              onDragOver={(e) => rowDragOver(e, s, i)}
              onDrop={onDrop}
            />
          </div>
        ))}
        {rowLine >= visible.length && rowLine >= 0 && <UiDropLine className="my-0.5" />}
      </ChatCategorySection>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background md:border-r md:border-border">
      {/* 머리 */}
      {isMobile
        ? (
          <>
            <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border pl-4 pr-1">
              <h2 className="min-w-0 flex-1 truncate text-[18px] font-semibold text-foreground">{appName}</h2>
              <UiIconButton label={t('chat.header.searchMessages')} icon="search" size="lg" onClick={() => onSearch?.()} />
              <UiMenu
                label={t('chat.side.workspaceMenuMobile')}
                title={appName}
                triggerSize="lg"
                items={headerMenu}
                onSelect={runHeaderMenu}
              />
            </header>
            <nav aria-label={t('chat.sidebar.pinnedNav')} className="grid shrink-0 grid-cols-3 gap-2 px-3 pt-3">
              {shortcuts.map(k => (
                <button
                  key={k.kind}
                  type="button"
                  aria-label={k.label}
                  aria-pressed={collection === k.kind}
                  className={cn('relative flex h-11 items-center justify-center gap-1.5 rounded-lg text-[14px] font-medium', collection === k.kind ? 'bg-overlay-selected' : 'bg-card')}
                  onClick={() => openCollection(k.kind)}
                >
                  <UiIcon name={k.icon} className="h-[18px] w-[18px] text-muted-foreground" />
                  {k.short}
                  {k.dot && <span className="h-2 w-2 rounded-full bg-danger" aria-hidden="true" />}
                </button>
              ))}
            </nav>
          </>
        )
        : (
          <div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-border pl-3 pr-1.5">
            <UiMenu
              label={t('chat.side.workspaceMenu')}
              title={appName}
              align="start"
              items={headerMenu}
              onSelect={runHeaderMenu}
              trigger={({ toggle, open, controls }) => (
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={open}
                  aria-controls={controls}
                  className="flex min-w-0 flex-1 items-center gap-1 rounded-md py-1 text-left text-[16px] font-semibold text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={toggle}
                >
                  <span className="truncate">{appName}</span>
                  <UiIcon name="chevron-down" className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              )}
              className="flex min-w-0 flex-1"
            />
            {shortcuts.map(k => (
              <UiIconButton
                key={k.kind}
                label={k.count ? `${k.label} ${k.count}` : k.label}
                pressed={collection === k.kind}
                className={cn('relative hover:bg-overlay-hover', collection === k.kind ? 'bg-overlay-selected text-foreground' : 'text-muted-foreground hover:text-foreground')}
                onClick={() => openCollection(k.kind)}
              >
                <UiIcon name={k.icon} className="h-5 w-5" />
                {k.dot && <span aria-hidden="true" className="absolute right-1 top-1 h-2 w-2 rounded-full bg-danger ring-2 ring-background" />}
              </UiIconButton>
            ))}
          </div>
        )}

      {/* 목록 */}
      {showSkeleton
        ? (
          <div aria-busy="true" aria-label={t('chat.sidebar.loadingList')} className="skeleton-delay flex-1 overflow-hidden px-2 py-3">
            <div className="px-1 py-1.5"><span className="block h-2.5 w-16 rounded-md bg-muted" /></div>
            {SKELETON_W.map(w => (
              <div key={w} className={cn('flex items-center gap-2 px-2', isMobile ? 'h-11' : 'h-8')}>
                <span className="h-5 w-5 rounded bg-muted" /><span className="h-3 rounded-md bg-muted" style={{ width: w }} />
              </div>
            ))}
          </div>
        )
        : listFailed
          ? (
            <UiErrorTile
              placement="page"
              retryVariant="outline"
              title={t('chat.sidebar.loadFailed')}
              detail={t('chat.sidebar.loadFailedHint')}
              onRetry={() => { void chat.fetchChannels(); void loadCategories() }}
            />
          )
          : (
            <nav
              aria-label={t('chat.side.listLabel')}
              className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-3', isMobile ? 'gap-3' : 'gap-4')}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null) }}
            >
              {nothing
                ? (
                  <UiEmptyState
                    variant="panel"
                    icon="chat"
                    title={t('chat.sidebar.noChannels')}
                    description={t('chat.sidebar.noChannelsHint')}
                    actionLabel={t('chat.side.menuNewChannel')}
                    onAction={() => setCreateIn({ categoryId: null })}
                  />
                )
                : sections.map(renderSection)}
              {canManage && !isMobile && <p className="sr-only">{t('chat.side.kbdHint')}</p>}
            </nav>
          )}

      {/* 계정 패널(SHELL ChatAccountPanel — 음성 접속 중이면 위쪽 접속 줄). 모바일은 셸이 탭 바 위에 접속 바를 그린다 */}
      {!isMobile && <ChatAccountPanel />}

      {/* 안내(끌기·키보드 옮기기) */}
      <p className="sr-only" aria-live="polite" role="status">{live}</p>
      <p className="sr-only" aria-live="assertive">{liveAssert}</p>

      {/* 메뉴 · 대화 상자 */}
      {chMenu && (
        <ChatChannelMenu
          channel={chMenu.channel}
          displayName={chMenu.channel.type === 'dm' ? chat.getDMDisplayName(chMenu.channel) : chMenu.channel.name}
          anchor={chMenu.anchor}
          canManage={canManage}
          onClose={() => setChMenu(null)}
        />
      )}
      {catMenu && (
        <ChatCategoryMenu
          section={catMenu.section}
          anchor={catMenu.anchor}
          canManage={canManage}
          canUp={userSections.findIndex(x => x.id === catMenu.section.id) > 0}
          canDown={(() => { const i = userSections.findIndex(x => x.id === catMenu.section.id); return i >= 0 && i < userSections.length - 1 })()}
          onClose={() => setCatMenu(null)}
          onCreateChannel={() => setCreateIn({ categoryId: catMenu.section.id })}
          onRename={() => setRenamingId(catMenu.section.id)}
          onMove={(d) => stepCat(catMenu.section.id, d)}
          onCollapseAll={collapseAll}
          onDelete={() => setDelCat(catMenu.section)}
        />
      )}
      {newCat && <ChatCategoryCreateDialog onClose={() => setNewCat(false)} />}
      {delCat && <ChatCategoryDeleteDialog section={delCat} onClose={() => setDelCat(null)} />}
      {createIn && <ChatCreateModal categoryId={createIn.categoryId} onClose={() => setCreateIn(null)} />}
      {newDm && <ChatNewDmDialog onClose={() => setNewDm(false)} onOpened={onNavigate} />}
    </div>
  )
}

export default ChatSidebar
