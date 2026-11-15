/**
 * 대화 영역(머리 · 연결 끊김 띠 · 메시지 목록 · 컴포저 · 드롭 오버레이). Vue 원본: frontend/components/chat/ChatConversation.vue
 * 채널을 안 골랐으면(데스크톱) 빈 상태.
 * 채널 탭(메시지·파일·회의·작업)은 머리 안 세그먼트 sm 로 옮겼다(탭 줄 없음, 탭 관리는 머리 채널 메뉴).
 *   포럼 채널(forum_board_id)은 탭 대신 글 목록/갤러리 전환 — 본문은 ChatForumView(RIGHT 담당, 파일이 생기면 자동으로 붙는다).
 *   연결 끊김(#offline)은 머리 바로 아래 전체 폭 띠 40. 대화 열은 전체 폭.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentType, type DragEvent } from 'react'
import { useI18n } from '~/i18n'
import { loadMore, openThread, sendMessage, sendTyping, useChat } from '~/composables/useChat'
import { fetchSummary, type ChannelTabKey, type ChannelTabsSummary } from '~/composables/useChannelTabs'
import { addFiles } from '~/composables/useChatAttachments'
import { usePlatform } from '~/composables/usePlatform'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiIcon } from '~/components/ui/Icon'
import { ChatHeader, type ForumView } from './ChatHeader'
import { setForumView, useForumView } from '~/composables/useChatForum'
import { visibleChannelTabs } from './ChannelTabs'
import { ChatNotifyBanner } from './ChatNotifyBanner'
import { ChatMessageList } from './ChatMessageList'
import { ChatTypingIndicator } from './ChatTypingIndicator'
import { ChatConnectionBanner } from './ChatConnectionBanner'
import { ChatInput } from './ChatInput'
import { ChatChannelFilesTab } from './ChannelFilesTab'
import { ChatChannelWikiTab } from './ChannelWikiTab'
import { ChatChannelMeetingsTab } from './ChannelMeetingsTab'
import { ChatChannelTasksTab } from './ChannelTasksTab'
import { ChatChannelTabsManage } from './ChannelTabsManage'
import { UiTrans } from '~/components/ui/Trans'
import type { SegmentItem } from '~/components/ui/Segment'

// 포럼 보기(RIGHT 담당 ChatForumView) — 파일이 아직 없으면 자리표시. 생기면 glob 이 잡아 붙인다.
const forumMods = import.meta.glob<{ ChatForumView?: ComponentType<{ channel: NonNullable<ReturnType<typeof useChat>['selectedChannel']>; view: ForumView }> }>('./ChatForumView.tsx')
const forumLoader = forumMods['./ChatForumView.tsx']
const LazyForumView = forumLoader
  ? lazy(async () => { const m = await forumLoader(); return { default: (m.ChatForumView ?? (() => null)) as ComponentType<any> } })
  : null

export interface ChatConversationProps {
  /** 모바일 ‹ 뒤로(목록으로) */
  onBack?: () => void
  /** 세로 화면: 머리 ☰ 로 채널 목록 서랍 열기(ChatHeader 로 넘김) */
  onOpenChannels?: () => void
}

function hasFiles(e: DragEvent) {
  return Array.from(e.dataTransfer?.types || []).includes('Files')
}
function countFiles(e: DragEvent) {
  const items = e.dataTransfer?.items
  if (!items) return 0
  let n = 0
  for (let i = 0; i < items.length; i++) if (items[i].kind === 'file') n++
  return n
}

/** 대화 영역 */
export function ChatConversation({ onBack, onOpenChannels }: ChatConversationProps) {
  const { t } = useI18n()
  const chat = useChat()
  const selectedChannel = chat.selectedChannel
  const { messages, loadingMessages, hasMoreMessages, loadingMore, typingUsers } = chat

  // ─── 채널 탭: 메시지 + 채널 설정 순서의 파일 · 위키 · 회의 · 작업 + 톱니(탭 관리) ───
  // 1:1 대화(DM)에는 탭이 없다. 채널을 바꾸면 메시지 탭으로 돌아간다.
  const [tab, setTab] = useState<ChannelTabKey>('messages')
  const [tabsSummary, setTabsSummary] = useState<ChannelTabsSummary | null>(null)
  const [manageOpen, setManageOpen] = useState(false)
  // 포럼 보기(글 목록/갤러리) — 사람마다 기억(useChatForum · 헤더의 ForumViewToggle 과 같은 값)
  const forumView: ForumView = useForumView()
  const tabsOn = !!selectedChannel && selectedChannel.type !== 'dm'
  const chRef = useRef(selectedChannel)
  chRef.current = selectedChannel
  const loadTabs = useCallback(async () => {
    const ch = chRef.current
    if (!ch || ch.type === 'dm') { setTabsSummary(null); return }
    try { setTabsSummary(await fetchSummary(ch.id)) } catch { setTabsSummary(null) }
  }, [])
  const chId = selectedChannel?.id
  useEffect(() => { setTab('messages'); setManageOpen(false); void loadTabs() }, [chId, loadTabs])
  // 파일 탭 숫자는 새 첨부가 오면 달라진다 — 탭을 다시 열 때 갱신
  const firstTab = useRef(true)
  useEffect(() => {
    if (firstTab.current) { firstTab.current = false; return }
    if (tab !== 'messages') void loadTabs()
  }, [tab, loadTabs])
  // 고른 탭이 꺼지거나(탭 관리·모듈) 위키 연결이 풀리면 메시지로
  const { isModuleEnabled } = usePlatform()
  const shown = visibleChannelTabs(tabsSummary, isModuleEnabled)
  const isForum = !!selectedChannel?.forum_board_id
  const tabCount = (k: ChannelTabKey): number | undefined => {
    if (!tabsSummary) return undefined
    if (k === 'files') return tabsSummary.files_count
    if (k === 'wiki') return tabsSummary.wiki_space?.pages
    if (k === 'meetings') return tabsSummary.meetings_upcoming
    if (k === 'tasks') return tabsSummary.tasks_open
    return undefined
  }
  const segItems: SegmentItem[] = [
    { value: 'messages', label: t('chat.tabs.messages') },
    ...shown.map(k => ({ value: k, label: t(`chat.tabs.${k}`), count: tabCount(k) || undefined })),
  ]
  useEffect(() => {
    if (tab !== 'messages' && tabsSummary && !shown.includes(tab)) setTab('messages')
  }, [tab, tabsSummary, shown])

  // ─── 대화 영역 전체 드롭 오버레이 ───
  // 드래그가 대화 영역에 들어오면 표시, 놓으면 ChatInput 의 첨부 트레이로 들어간다(즉시 전송 아님).
  const depth = useRef(0)
  const [dragDepth, setDragDepthState] = useState(0)
  const setDragDepth = (v: number) => { depth.current = v; setDragDepthState(v) }
  const [dragFileCount, setDragFileCount] = useState(0)
  const dropActive = dragDepth > 0

  const dropTargetName = !selectedChannel ? ''
    : selectedChannel.type === 'dm' ? `@${chat.getDMDisplayName(selectedChannel)}` : `#${selectedChannel.name}`

  function onDragEnter(e: DragEvent) {
    if (!hasFiles(e)) return
    e.preventDefault()
    setDragDepth(depth.current + 1)
    const n = countFiles(e)
    if (n) setDragFileCount(n)
  }
  function onDragOver(e: DragEvent) {
    if (!hasFiles(e)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }
  function onDragLeave(e: DragEvent) {
    if (!hasFiles(e)) return
    setDragDepth(Math.max(0, depth.current - 1))
    if (depth.current === 0) setDragFileCount(0)
  }
  function onDrop(e: DragEvent) {
    if (!hasFiles(e)) return
    e.preventDefault()
    setDragDepth(0)
    setDragFileCount(0)
    const files = e.dataTransfer?.files
    if (files && files.length && selectedChannel) addFiles(selectedChannel.id, files)
  }
  // 창 밖으로 드래그가 나가 dragleave 가 안 맞는 경우 대비
  useEffect(() => {
    const resetDrag = () => { depth.current = 0; setDragDepthState(0); setDragFileCount(0) }
    window.addEventListener('dragend', resetDrag)
    window.addEventListener('drop', resetDrag)
    return () => { window.removeEventListener('dragend', resetDrag); window.removeEventListener('drop', resetDrag) }
  }, [])

  if (!selectedChannel) {
    // 아무 대화도 안 고른 상태(데스크톱)
    return (
      <UiEmptyState
        icon="chat"
        title={t('chat.conversation.emptyTitle')}
        description={t('chat.conversation.emptyDesc')}
      />
    )
  }

  return (
    <div
      className="relative flex h-full flex-col"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <ChatHeader
        onBack={onBack}
        onOpenChannels={onOpenChannels}
        tabs={tabsOn ? segItems : null}
        tab={tab}
        onTab={v => setTab(v as ChannelTabKey)}
        forumView={isForum ? forumView : null}
        onForumView={setForumView}
        onManageTabs={tabsOn && tabsSummary?.can_manage ? () => setManageOpen(true) : undefined}
      />
      <ChatConnectionBanner />
      {isForum
        ? (
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {LazyForumView
              ? <Suspense fallback={null}><LazyForumView channel={selectedChannel} view={forumView} /></Suspense>
              : <UiEmptyState icon="messages-square" title={t('chat.shell.forum.pendingTitle')} description={t('chat.shell.forum.pendingDesc')} />}
          </div>
        )
        : tab === 'messages' || !tabsOn
        ? (
          <>
            <ChatNotifyBanner />
            <ChatMessageList
              messages={messages}
              loading={loadingMessages}
              hasMore={hasMoreMessages}
              loadingMore={loadingMore}
              onLoadMore={loadMore}
              onOpenThread={openThread}
            />
            {/* 모바일: 입력 중 표시는 컴포저 위 / 데스크톱: 컴포저 아래(D1) */}
            <ChatTypingIndicator typingUsers={typingUsers} className="md:hidden" />
            {/* 대화 열 전체 폭 */}
            <div className="w-full">
              {/* 입력 중 표시는 컴포저 아래 24 예약 자리(ChatInput typing) */}
              <ChatInput onSend={sendMessage} onTyping={sendTyping} typing={<ChatTypingIndicator typingUsers={typingUsers} className="hidden px-0 md:block md:px-0" />} />
            </div>
          </>
        )
        : tab === 'files'
          ? (
            <ChatChannelFilesTab
              channelId={selectedChannel.id}
              canManage={!!tabsSummary?.can_manage}
              onManage={() => setManageOpen(true)}
              onSwitch={setTab}
              onChanged={() => { void loadTabs() }}
            />
          )
          : tab === 'wiki'
            ? (
              <ChatChannelWikiTab
                key={tabsSummary?.wiki_space?.id ?? 'none'}
                space={tabsSummary?.wiki_space ?? null}
                initialPageId={tabsSummary?.wiki?.id ?? null}
                canManage={!!tabsSummary?.can_manage}
                onManage={() => setManageOpen(true)}
                onChanged={() => { void loadTabs() }}
              />
            )
            : tab === 'tasks'
              ? <ChatChannelTasksTab channelId={selectedChannel.id} onChanged={() => { void loadTabs() }} />
              : <ChatChannelMeetingsTab channelId={selectedChannel.id} onChanged={() => { void loadTabs() }} />}
      {manageOpen && tabsOn && (
        <ChatChannelTabsManage
          channelId={selectedChannel.id}
          channelName={selectedChannel.name}
          summary={tabsSummary}
          onClose={() => setManageOpen(false)}
          onSaved={setTabsSummary}
        />
      )}

      {/* 드롭 오버레이(D2) — 헤더~컴포저 전체 scrim/72 + 점선 primary */}
      {dropActive && (
        <div
          className="absolute inset-0 z-30 flex bg-[hsl(var(--scrim)/0.72)] p-4"
          aria-live="polite"
        >
          <div className="pointer-events-none flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-primary bg-primary/[0.08]">
            <div className="grid h-14 w-14 place-items-center rounded-2xl bg-primary text-primary-foreground" aria-hidden="true">
              <UiIcon name="upload" className="h-[26px] w-[26px]" />
            </div>
            <UiTrans k="chat.input.drop.title" as="p" className="text-center text-lg font-semibold text-foreground" slots={{ channel: <span className="text-primary">{dropTargetName}</span> }} />
            <p className="text-center text-[13px] text-foreground/80">
              {dragFileCount > 0 && (
                <>
                  <UiTrans k="chat.input.drop.files" as="span" slots={{ n: <span className="font-mono">{dragFileCount}</span> }} />{' · '}
                </>
              )}{t('chat.input.drop.hint')}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

export default ChatConversation
