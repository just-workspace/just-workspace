/**
 * 채팅 화면. Vue 원본: frontend/pages/chat.vue
 * 데스크톱(22 셸, 디스코드식 4열): 레일 64(셸) · 채널 목록(기본 298, 드래그 199–367 · 더블클릭 298, 레일 채팅 아이콘을 다시 누르면 접힘)
 *   · 대화 1fr · 오른쪽 자리 하나(멤버 264 / 스레드 400 / 스레드 목록 400 / 검색 결과 400 / 고정 400 / 음성 글 채팅 340 — 서로 배타,
 *   새로 연 것이 바꿔 낀다, utils/chatRightColumn). 실효 폭 1180 미만이면 오른쪽 자리는 대화 위 덮개.
 *   채팅 화면엔 데스크톱 전역 상단바가 없다(routes.ts noDesktopTopbar) — 위쪽 크롬 = 채널 머리 49.
 *   세로 화면(실효 높이 > 폭): 채널 목록을 접고 머리 왼쪽 ☰ 로 여는 서랍(260), 채널을 고르기 전에는 260 으로 붙여 둔다(답 4).
 *   채팅 설정(useChatUi.settings)이 열리면 대화 영역 위 전체(레일 제외)를 덮는다 — ChatSettingsScreen(SETTINGS 담당, lazy).
 * 모바일(390): 한 번에 한 화면 — 목록 → 대화 → (스레드 · 스레드 목록 · 검색 · 멤버 · 고정 전체 화면). 대화 이상에서는 탭바를 숨긴다.
 *   목록으로 돌아가기: 상단 ‹(44) 또는 화면 왼쪽 가장자리에서 밀기. 단계는 주소에 싣는다(utils/chatStage).
 * 떠 있는 것: 프로필 팝아웃 · 사람별 음량 · 이모지 피커(COMPOSER).
 * 소켓은 앱 전체가 쓴다(layouts/default). 화면을 떠난다고 끊지 않는다 — 끊는 건 로그아웃.
 */
import { lazy, Suspense, useEffect, useRef, useState, type ComponentType, type TouchEvent } from 'react'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
// Vue :class 처럼 이어 붙이기만 한다(tailwind-merge 없이 — 원본과 같은 CSS 순서 규칙)
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { setSharedState } from '~/lib/state'
import { historyBackPath, routerApi, useRoute } from '~/lib/router'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useBreadcrumb } from '~/composables/useBreadcrumb'
import { useDesktopShell } from '~/composables/useDesktopShell'
import { useIsMobile } from '~/composables/useIsMobile'
import { useViewport } from '~/composables/useViewport'
import { clampChatListWidth, userPrefsStore } from '~/composables/useUserPrefs'
import { CHAT_DRAWER_WIDTH } from '~/lib/fluid'
import { useOwnMobileHeader } from '~/composables/useOwnMobileHeader'
import {
  chatStore, closeThread, deselectChannel, fetchThreads, getDMDisplayName, initChat, openThread,
  selectChannel, selectSelectedChannel, selectSortedChannels,
  setShowMemberPanel, setShowPinsPanel, setShowSearchPanel,
} from '~/composables/useChat'
import { chatUiStore, closeChatSettings, jumpTo, openChatSettings, setCollection, setThreadListOpen, type ChatCollection } from '~/composables/useChatUi'
import { voiceStore } from '~/composables/useVoice'
import { isChannelBold } from '~/lib/chatEvents'
import { STAGE_KEYS, depthOf, panelOf, sameStage, stageFromQuery, stageFromState } from '~/utils/chatStage'
import { RIGHT_COLUMN_WIDTH, resolveRightColumn, rightColumnDocked, type RightColumn } from '~/utils/chatRightColumn'
import { ChatSidebar } from '~/components/chat/ChatSidebar'
import { ChatListResizer } from '~/components/chat/ChatListResizer'
import { ChatCollectionView } from '~/components/chat/ChatCollectionView'
import { ChatConversation } from '~/components/chat/ChatConversation'
import { ChatSearchPanel } from '~/components/chat/ChatSearchPanel'
import { ChatThreadPanel } from '~/components/chat/ChatThreadPanel'
import { ChatThreadList } from '~/components/chat/ChatThreadList'
import { ChatMemberPanel } from '~/components/chat/ChatMemberPanel'
import { ChatPinsPanel } from '~/components/chat/ChatPinsPanel'
import { ChatCreateModal } from '~/components/chat/ChatCreateModal'
import { ChatNotifySheet } from '~/components/chat/ChatNotifySheet'
import { ChatInviteModal } from '~/components/chat/ChatInviteModal'
import { ChatEmojiPicker } from '~/components/chat/ChatEmojiPicker'
import { ChatProfilePopoutHost } from '~/components/chat/ChatProfilePopout'
import { ChatUserVolumeHost } from '~/components/chat/ChatUserVolume'
import { VoiceChannelView } from '~/components/voice/VoiceChannelView'

// 채팅 설정 전체 화면(SETTINGS 담당) — 파일이 생기면 glob 이 잡아 lazy 로 붙인다(없으면 자리만)
const settingsMods = import.meta.glob<{ ChatSettingsScreen?: ComponentType<{ onClose?: () => void }>; default?: ComponentType<{ onClose?: () => void }> }>(
  '../components/chat/settings/ChatSettingsScreen.tsx',
)
const settingsLoader = settingsMods['../components/chat/settings/ChatSettingsScreen.tsx']
const LazySettings = settingsLoader
  ? lazy(async () => {
    const m = await settingsLoader()
    return { default: (m.ChatSettingsScreen ?? m.default ?? (() => null)) as ComponentType<{ onClose?: () => void }> }
  })
  : null

function backToList() {
  deselectChannel()
  setCollection(null)
}

/** 오른쪽 자리 안의 패널 */
function RightPanel({ kind }: { kind: Exclude<RightColumn, null | 'voiceText'> }) {
  if (kind === 'search') return <ChatSearchPanel />
  if (kind === 'thread') return <ChatThreadPanel />
  if (kind === 'threads') return <ChatThreadList />
  if (kind === 'members') return <ChatMemberPanel />
  return <ChatPinsPanel />
}

export default function ChatPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: `${t('nav.chat')} | ${appName}` })

  // 렌더에 쓰는 값만 구독(Vue 의 useChat() 구조 분해)
  const selectedChannelId = useStore(chatStore, s => s.selectedChannelId)
  const selectedChannel = useStore(chatStore, s => selectSelectedChannel(s))
  useStore(chatStore, s => s.allUsers)   // DM 이름(경로 표시)
  const panelState = useStore(chatStore, useShallow(s => ({
    showSearchPanel: s.showSearchPanel, activeThreadId: s.activeThreadId, showMemberPanel: s.showMemberPanel, showPinsPanel: s.showPinsPanel,
  })))
  const activeThreadId = panelState.activeThreadId
  const ui = useStore(chatUiStore, useShallow(s => ({
    collection: s.collection, notifySheetChannelId: s.notifySheetChannelId, inviteOpen: s.inviteOpen, threadListOpen: s.threadListOpen,
    listCollapsed: s.listCollapsed, membersOpen: s.membersOpen, voiceTextOpen: s.voiceTextOpen, settings: s.settings,
  })))
  const { collection, notifySheetChannelId, inviteOpen } = ui
  const panel = panelOf(panelState, ui.threadListOpen)
  const voiceChannelId = useStore(voiceStore, s => s.channelId)
  // 옛 데스크톱 셸(0.3.0 이하)에는 네이티브 대화 목록이 있다. 그때만 숨긴다(두 벌 방지). 0.3.1+ 셸은 이 목록을 그대로 쓴다.
  const { shellDrawsLists } = useDesktopShell()
  const isMobile = useIsMobile()
  const route = useRoute()

  const [showCreateModal, setShowCreateModal] = useState(false)

  // 폭(실효 크기 기준)
  const { width: vw, portrait } = useViewport()
  const desktop = !isMobile
  const portraitDesk = desktop && portrait
  const savedListW = useStore(userPrefsStore, s => clampChatListWidth(s.prefs.chatSidebarWidth))
  const [previewW, setPreviewW] = useState<number | null>(null)
  const listW = previewW ?? savedListW
  const [drawerOpen, setDrawerOpen] = useState(false)
  // 채널을 고르면 서랍은 닫는다
  useEffect(() => { setDrawerOpen(false) }, [selectedChannelId])

  // 오른쪽 자리(하나) — 데스크톱
  const col = resolveRightColumn({
    panel,
    width: vw,
    membersOpen: ui.membersOpen,
    hasChannel: !!selectedChannelId,
    voiceTextAvailable: !!selectedChannel?.is_voice && voiceChannelId === selectedChannel.id,
    voiceTextOpen: ui.voiceTextOpen,
  })
  const docked = rightColumnDocked(col, vw)

  // 3단 경로: 워크스페이스 / 채팅 / #채널 (모아보기면 그 이름)
  const location = (() => {
    const ch = selectedChannel
    // 비공개 채널은 '#' 을 붙이지 않는다(헤더는 자물쇠 — 경로는 글자뿐이라 이름만)
    if (ch) return ch.type === 'dm' ? getDMDisplayName(ch) : ch.type === 'private' ? ch.name : `#${ch.name}`
    if (collection) return { threads: t('chat.sidebar.threads'), drafts: t('chat.sidebar.drafts'), saved: t('chat.sidebar.saved') }[collection]
    return ''
  })()
  useBreadcrumb(location)

  // 채널을 열면 모아보기는 닫는다
  const firstSel = useRef(true)
  useEffect(() => {
    if (firstSel.current) { firstSel.current = false; return }
    if (selectedChannelId) setCollection(null)
  }, [selectedChannelId])
  // 채널을 바꾸면 스레드 목록은 닫는다(그 채널의 목록이라)
  const firstSelT = useRef(true)
  useEffect(() => {
    if (firstSelT.current) { firstSelT.current = false; return }
    if (chatUiStore.getState().threadListOpen) setThreadListOpen(false)
  }, [selectedChannelId])

  // 모바일 화면 단계
  const hasDetail = !!selectedChannelId || !!collection

  // 모바일에서 대화 이상이 열려 있으면 하단 탭바를 숨긴다(목록에선 유지)
  useEffect(() => { setSharedState('mobile-detail-open', !!(isMobile && (hasDetail || panel))) }, [hasDetail, panel, isMobile])
  useEffect(() => () => { setSharedState('mobile-detail-open', false) }, [])
  // 모바일은 단계마다 채팅 자체 머리가 있다 — 공용 상단바를 숨겨 제목이 두 번 보이지 않게
  useOwnMobileHeader(true)

  // 모바일 뒤로 — 열린 가장 위 화면부터 닫는다
  function mobileBack() {
    const p = panelOf(chatStore.getState())
    if (p === 'thread') closeThread()
    else if (p === 'search') setShowSearchPanel(false)
    else if (p === 'threads') setThreadListOpen(false)
    else if (p === 'members') setShowMemberPanel(false)
    else if (p === 'pins') setShowPinsPanel(false)
    else if (chatStore.getState().selectedChannelId || chatUiStore.getState().collection) backToList()
  }

  const routeRef = useRef(route)
  routeRef.current = route
  const isMobileRef = useRef(isMobile)
  isMobileRef.current = isMobile
  const applyingRoute = useRef(false)

  // 화면 상태 → 주소
  const firstStateSync = useRef(true)
  useEffect(() => {
    if (firstStateSync.current) { firstStateSync.current = false; return }
    const r = routeRef.current
    if (!isMobile || applyingRoute.current || r.path !== '/chat') return
    const want = stageFromState()
    const now = stageFromQuery(r.query)
    if (sameStage(want, now)) return
    const rest = Object.fromEntries(Object.entries(r.query).filter(([k]) => !(STAGE_KEYS as readonly string[]).includes(k)))
    const target = { path: r.path, query: { ...rest, ...want } }
    const wantPath = routerApi.resolve(target).fullPath
    if (depthOf(want) < depthOf(now) && historyBackPath() === wantPath) routerApi.back()
    else if (depthOf(want) > depthOf(now)) void routerApi.push(target)
    else void routerApi.replace(target)
  }, [isMobile, selectedChannelId, collection, activeThreadId, panel])

  // 주소(뒤로가기·앞으로가기) → 화면 상태
  const firstRouteSync = useRef(true)
  useEffect(() => {
    if (firstRouteSync.current) { firstRouteSync.current = false; return }
    const r = routeRef.current
    if (!isMobileRef.current || r.path !== '/chat') return
    const q = stageFromQuery(r.query)
    const cur = stageFromState()
    if (sameStage(q, cur)) return
    applyingRoute.current = true
    void (async () => {
      try {
        const S = () => chatStore.getState()
        // 위 단계부터 닫는다
        if (!q.thread && S().activeThreadId) closeThread()
        if (q.panel !== 'search' && S().showSearchPanel) setShowSearchPanel(false)
        if (q.panel !== 'threads' && chatUiStore.getState().threadListOpen) setThreadListOpen(false)
        if (q.panel !== 'members' && S().showMemberPanel) setShowMemberPanel(false)
        if (q.panel !== 'pins' && S().showPinsPanel) setShowPinsPanel(false)
        if (!q.channel && !q.view && (S().selectedChannelId || chatUiStore.getState().collection)) backToList()
        // 앞으로가기·딥 링크로 다시 열기
        if (q.channel && q.channel !== S().selectedChannelId) await selectChannel(q.channel)
        if (q.view && !q.channel && chatUiStore.getState().collection !== q.view) setCollection(q.view as ChatCollection)
        if (q.thread && S().activeThreadId !== q.thread) await openThread(q.thread)
        if (q.panel === 'search') setShowSearchPanel(true)
        if (q.panel === 'threads') setThreadListOpen(true)
        if (q.panel === 'members') setShowMemberPanel(true)
        if (q.panel === 'pins') setShowPinsPanel(true)
      } finally {
        // Vue nextTick — 이번 변경으로 다시 그린 뒤(상태 → 주소 effect 가 돈 뒤)에 푼다
        await new Promise(res => setTimeout(res, 0))
        applyingRoute.current = false
      }
    })()
  }, [route.fullPath])

  // 왼쪽 가장자리에서 밀어 뒤로(M2 노트)
  const edgeX = useRef<number | null>(null)
  const edgeY = useRef(0)
  function onTouchStart(e: TouchEvent) {
    const p = e.touches[0]
    edgeX.current = p && p.clientX <= 20 ? p.clientX : null
    edgeY.current = p?.clientY ?? 0
  }
  function onTouchEnd(e: TouchEvent) {
    if (edgeX.current === null) return
    const p = e.changedTouches[0]
    if (p && p.clientX - edgeX.current > 60 && Math.abs(p.clientY - edgeY.current) < 50) mobileBack()
    edgeX.current = null
  }

  // 모바일 목록 "검색" — 채널을 안 골라도 전체 메시지 검색 패널을 연다
  function openSearch() {
    closeThread()
    setShowMemberPanel(false)
    setShowPinsPanel(false)
    setThreadListOpen(false)
    setShowSearchPanel(true)
  }

  // ─── 단축키(D8 · 실제 키는 여기 정의) ───
  // Alt+↑↓ 이전/다음 채널 · Alt+Shift+↑↓ 안 읽은 채널로 · Ctrl+Shift+T 전체 스레드 · Esc 패널 닫기
  useEffect(() => {
    function moveChannel(dir: 1 | -1, unreadOnly: boolean) {
      const sorted = selectSortedChannels(chatStore.getState())
      const list = [...sorted.channels, ...sorted.dms]
      if (!list.length) return
      let i = list.findIndex(c => c.id === chatStore.getState().selectedChannelId)
      for (let step = 0; step < list.length; step++) {
        i = (i + dir + list.length) % list.length
        const c = list[i]
        if (!unreadOnly || isChannelBold(c) || (c.mention_count || 0) > 0) { void selectChannel(c.id); return }
      }
    }
    function onKeydown(e: KeyboardEvent) {
      if (e.defaultPrevented) return
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        moveChannel(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey)
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        deselectChannel()
        setCollection('threads')
        void fetchThreads()
        return
      }
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]') && !chatUiStore.getState().settings) {
        const p = panelOf(chatStore.getState())
        if (p === 'search') setShowSearchPanel(false)
        else if (p === 'threads') setThreadListOpen(false)
        else if (p === 'members') setShowMemberPanel(false)
        else if (p === 'pins') setShowPinsPanel(false)
      }
    }
    window.addEventListener('keydown', onKeydown)
    void (async () => {
      await initChat()
      // 딥 링크: ?channel=…&thread=… (스레드 "새 창으로 열기"·링크 복사)
      const q = routeRef.current.query
      const channelId = typeof q.channel === 'string' ? q.channel : undefined
      const threadId = typeof q.thread === 'string' ? q.thread : undefined
      if (channelId) {
        await selectChannel(channelId)
        if (threadId) void openThread(threadId)
        // "링크 복사"가 만드는 &message= — 그 메시지로 간다(예전엔 아무도 안 읽어 채널 맨 아래만 열렸다)
        else if (typeof q.message === 'string' && q.message) jumpTo(channelId, q.message)
      }
      // 딥 링크: ?settings=roles|emoji|voice|policy|channel-perm|category-perm(&target=id) — 관리자 페이지 "채팅 설정 열기"(SETTINGS)
      if (typeof q.settings === 'string') openChatSettings(q.settings, typeof q.target === 'string' ? q.target : null)
    })()
    return () => window.removeEventListener('keydown', onKeydown)
  }, [])

  const sidebar = <ChatSidebar onCreateChannel={() => setShowCreateModal(true)} onSearch={openSearch} />
  // 데스크톱 오른쪽 자리(음성 글 채팅은 VoiceChannelView 가 직접 그린다)
  const deskRight = desktop && col && col !== 'voiceText' ? col : null
  const mobilePanel = isMobile && panel ? panel : null

  return (
    <div className="relative flex h-full overflow-hidden" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      {/* 채널 목록 — 옛 데스크톱 셸(0.3.0 이하)에서는 네이티브 목록이 이미 있다 */}
      {!shellDrawsLists && (portraitDesk && hasDetail
        // 세로 화면: 접힌 서랍(☰)
        ? drawerOpen && (
          <>
            <div className="absolute inset-0 z-drawer bg-scrim" aria-hidden="true" onClick={() => setDrawerOpen(false)} />
            <div
              className="absolute inset-y-0 left-0 z-drawer h-full shadow-xl"
              style={{ width: CHAT_DRAWER_WIDTH }}
              onKeyDown={(e) => { if (e.key === 'Escape') setDrawerOpen(false) }}
            >
              {sidebar}
            </div>
          </>
        )
        : desktop
          ? !ui.listCollapsed && (
            <aside
              aria-label={t('chat.shell.list.label')}
              className="relative h-full shrink-0"
              style={{ width: portraitDesk ? CHAT_DRAWER_WIDTH : listW }}
              data-testid="chat-list-column"
            >
              {sidebar}
              {!portraitDesk && <ChatListResizer width={listW} onPreview={setPreviewW} />}
            </aside>
          )
          : (
            <div className={cn('h-full w-full shrink-0', hasDetail || panel ? 'hidden' : 'block')}>
              {sidebar}
            </div>
          ))}

      {/* 대화 + 오른쪽 자리 */}
      <div className={cn('relative h-full min-w-0 flex-1', desktop ? 'flex' : hasDetail || panel ? 'flex' : 'hidden')}>
        <section className={cn('h-full min-w-0 flex-1 flex-col', mobilePanel ? 'hidden' : 'flex')}>
          {collection && !selectedChannelId
            ? <ChatCollectionView key={collection} kind={collection} onBack={backToList} />
            : selectedChannel?.is_voice
              // 음성 채널 — 글 대신 참가자 목록·들어가기. 다른 패널이 오른쪽 자리를 쓰면 글 채팅은 숨긴다
              ? <VoiceChannelView onBack={backToList} onOpenChannels={portraitDesk ? () => setDrawerOpen(true) : undefined} chatHidden={!!deskRight} />
              : <ChatConversation onBack={backToList} onOpenChannels={portraitDesk ? () => setDrawerOpen(true) : undefined} />}
        </section>

        {deskRight && (
          // 1180 이상이면 대화 옆에 붙고, 아니면 대화 위 덮개
          <div
            data-testid="chat-right-column"
            data-col={deskRight}
            className={cn(
              'flex h-full min-w-0 shrink-0 overflow-hidden border-l border-border bg-background [&>*]:w-full! [&>*]:max-w-none! [&>*]:border-l-0!',
              docked ? '' : 'absolute inset-y-0 right-0 z-drawer shadow-xl',
            )}
            style={{ width: RIGHT_COLUMN_WIDTH[deskRight], maxWidth: '100%' }}
          >
            <RightPanel kind={deskRight} />
          </div>
        )}
        {mobilePanel && (
          <div className="flex h-full w-full min-w-0">
            <RightPanel kind={mobilePanel} />
          </div>
        )}
      </div>

      {/* 채팅 설정 전체 화면(레일 제외 — 이 화면 전체를 덮는다). Esc 닫기는 설정 화면 쪽 */}
      {ui.settings && (
        <div className="absolute inset-0 z-drawer flex bg-background" data-testid="chat-settings-slot">
          {LazySettings
            ? <Suspense fallback={null}><LazySettings onClose={closeChatSettings} /></Suspense>
            : (
              <div className="m-auto flex flex-col items-center gap-3 p-6 text-center">
                <p className="text-[15px] text-muted-foreground">{t('chat.shell.settingsPending')}</p>
                <button type="button" className="h-9 rounded-md border border-border px-3 text-[14px] hover:bg-overlay-hover" onClick={closeChatSettings}>{t('common.close')}</button>
              </div>
            )}
        </div>
      )}

      {showCreateModal && <ChatCreateModal onClose={() => setShowCreateModal(false)} />}
      {notifySheetChannelId && <ChatNotifySheet />}
      {inviteOpen && selectedChannel && <ChatInviteModal />}
      {/* 이모지 피커 — useChatUi.emojiPicker 로 스스로 뜬다(컴포저 · 리액션) */}
      <ChatEmojiPicker />
      {/* 프로필 팝아웃 · 사람별 음량 */}
      <ChatProfilePopoutHost />
      <ChatUserVolumeHost />
    </div>
  )
}
