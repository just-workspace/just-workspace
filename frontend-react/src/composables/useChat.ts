/**
 * Chat — WebSocket 클라이언트 + 상태 관리. Vue 판 composables/useChat.ts 그대로(모듈 싱글턴).
 *
 * 상태 반영 규칙(이벤트 → 상태)은 lib/chatEvents.ts 의 순수 함수에 있다. 여기는 네트워크·타이머·상태만.
 *
 * React: const { channels, messages, selectChannel, sendMessage, ... } = useChat()
 *   - 멤버 이름은 Vue 판과 같다. 값은 .value 없이(렌더 시점 값). 읽은 필드만 구독한다(useTrackedStore).
 *   - Vue 에서 바깥이 대입하던 상태는 setter: setShowMemberPanel · setShowPinsPanel · setShowSearchPanel ·
 *     setSearchQuery · setShowNotifyBanner
 * 컴포넌트 밖: chatStore.getState() / 아래 export 함수들(initChat, selectChannel, sendMessage …)
 *   이벤트 처리기 안에서 "지금" 값이 필요하면 chatStore.getState().messages 처럼 store 를 직접 읽는다.
 * 셸 진입점: initChat()(= Vue useChat().init()) · cleanupChat()(= cleanup, 로그아웃 때 useAuth 가 자동으로 부른다)
 */
import { createStore } from 'zustand'
import { $fetch } from '~/lib/api'
import { wsUrl, wsProtocols } from '~/lib/runtimeConfig'
import { authStore, onBeforeLogout } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import {
  ensurePushSubscription,
  fetchNotifications,
  handleNotificationEvent,
  requestBrowserPermission,
} from '~/composables/useNotifications'
import { useTrackedStore } from '~/composables/useTrackedStore'
import {
  applyChannelPrefs,
  applyChannelUnread,
  applyDraftUpdate,
  applyPinUpdate,
  applyPresence,
  applyThreadFollow,
  applyThreadRead,
  applyThreadUpdate,
  bumpThreadMeta,
  collectLocalDrafts,
  draftKey,
  draftsFromList,
  isChannelBold,
  isMainTimelineMessage,
  OFFLINE,
  presencesFromSnapshot,
  replaceMessage,
  summarizeUnread,
} from '~/lib/chatEvents'
import type {
  ChannelDevicePrefs,
  ChannelPrefs,
  ChatDraft,
  MyStatus,
  MyStatusUpdate,
  NotifyLevel,
  PresenceEvent,
  PresenceSnapshot,
  ThreadFollowState,
  ThreadSummary,
  ThreadUnreadCount,
  UnreadSummary,
  UserPresence,
} from '~/lib/chatEvents'

// UI 가 한 곳에서 가져가게 다시 내보낸다
export type {
  ChannelDevicePrefs,
  ChannelPrefs,
  ChatDraft,
  MyStatus,
  MyStatusUpdate,
  NotifyLevel,
  PresenceState,
  StatusMode,
  ThreadFollowState,
  ThreadLastReply,
  ThreadSummary,
  ThreadUnreadCount,
  UserPresence,
} from '~/lib/chatEvents'

export interface ChannelLastMessage {
  content: string
  message_type: string
  created_at: string
  sender_name: string | null
}

export interface Channel {
  id: string
  name: string
  type: 'public' | 'private' | 'dm'
  description: string | null
  created_by: string
  is_archived: boolean
  /** 음성 채널(handover-20) — 종류는 그대로, LiveKit 방 voice-<id> 가 붙는다 */
  is_voice?: boolean
  created_at: string
  updated_at: string
  member_count: number
  unread_count: number
  mention_count?: number
  group_mention?: boolean
  last_read_seq?: number | null
  last_message_seq?: number | null
  last_message?: ChannelLastMessage | null
  /** 채널별 알림 수준 — 서버가 기본값(DM all, 그 외 mentions)을 풀어서 내려준다 */
  notify_level?: NotifyLevel
  /** 뮤트 — 굵게(미읽음) 표시만 빠지고 멘션 숫자는 그대로(백엔드 규칙) */
  muted?: boolean
  /** 음소거 기간(handover-22 "알림 끄기 ›") — 이 시각까지. null = 내가 끌 때까지 */
  muted_until?: string | null
  /** 카테고리(r24 chat_categories) — null = 분류 없음 */
  category_id?: string | null
  /** 카테고리 안 순서(작을수록 위) */
  position?: number | null
  /** 포럼 채널 = 이 게시판의 채팅 쪽 보기(handover-22 §5.1) */
  forum_board_id?: string | null
  /** 이 채널 새 스레드 자동 보관(분) */
  default_thread_auto_archive_minutes?: number | null
}

export interface MessageSender {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
}

export interface ReadByUser {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
}

export interface ReactionGroup {
  emoji: string
  count: number
  user_ids: string[]
  reacted: boolean
}

export interface ChatMessage {
  id: string
  channel_id: string
  sender: MessageSender | null
  content: string
  message_type: 'text' | 'file' | 'system'
  file_meta: string | null
  parent_id: string | null
  reply_count: number
  is_edited: boolean
  is_deleted: boolean
  created_at: string
  updated_at: string
  read_by?: ReadByUser[]
  reactions?: ReactionGroup[]
  seq?: number
  /** 답글인데 "채널에도 보내기" 한 것 — parent_id 가 있어도 메인 타임라인에 보인다 */
  thread_broadcast?: boolean
  pinned_at?: string | null
  pinned_by?: string | null
  /** GET /channels/{id}/pins 항목에만 붙는다 */
  pinned_by_name?: string | null
  /** 내가 저장했는지(목록·스레드 응답에 붙는다. 실시간 이벤트에는 없을 수 있다) */
  is_saved?: boolean
  /** 답글이 있는 루트에만 — 최근 답글 순 최대 5명 */
  thread_participants?: ThreadParticipant[]
  /** 답글이 있는 루트에만 — 마지막 답글 시각(ISO) */
  last_reply_at?: string | null
  /** 링크 미리보기 카드(R5 B12) — 서버가 첫 외부 링크를 비동기로 읽어 채운다(WS link_preview). 없거나 지웠으면 null */
  link_preview?: LinkPreview | null
  // ── handover-22 ──
  /** 인라인 답장 대상 */
  reply_to_id?: string | null
  /** 답장 대상에게 알림(@ 켬) */
  reply_ping?: boolean
  /** 답장 원문 요약(서버가 붙인다) */
  reply_to?: ReplyRef | null
  /** @silent 로 보냄 — 알림 없음 */
  silent?: boolean
  /** 첨부(file_meta 를 서버가 풀어 준 것 — 옛 단일 첨부도 1개짜리) */
  attachments?: ChatAttachment[]
  /** 스레드가 시작된 루트에만 */
  thread?: ThreadMeta | null
  /** (로컬 전용) 첨부 묶음 보내기 중인 낙관적 줄 — id 'local-up-…'. 동작은 useChatAttachments retryUpload/discardUpload(localId) */
  _upload?: { localId: string; state: 'uploading' | 'failed' | 'too_large'; progress: number; error?: string | null }
}

/** 보내기 옵션(handover-22) — 인라인 답장 · @silent. 소켓 send_message · REST · 대기함 모두 실린다 */
export interface SendOptions { reply_to_id?: string | null; reply_ping?: boolean; silent?: boolean }

/** 답장 원문 상태: ok · 삭제됨 · 불러올 수 없음 · 권한 없음 */
export type ReplyState = 'ok' | 'deleted' | 'unavailable' | 'forbidden'
export interface ReplyRef {
  id: string
  state: ReplyState
  sender: MessageSender | null
  /** 요약(최대 200자, 마크다운 원문). 첨부만이면 '' */
  content: string
  message_type: 'text' | 'file' | 'system'
  has_attachment: boolean
  attachment_kind: 'image' | 'video' | 'audio' | 'file' | null
}
export interface ChatAttachment {
  id: string
  filename: string
  size: number
  mime_type: string
  url: string
  width?: number | null
  height?: number | null
  duration?: number | null
  spoiler: boolean
  alt: string | null
}
export interface ThreadMeta {
  name: string | null
  /** name 이 없으면 원문 첫 40자 */
  display_name: string
  archived: boolean
  auto_archive_minutes: number
  reply_count: number
  last_reply_at: string | null
}

/** 링크 미리보기 카드 값(백엔드 app/chat/link_preview.py public_preview) */
export interface LinkPreview {
  url: string
  /** 사이트 이름(og:site_name, 없으면 호스트) */
  site: string | null
  title: string
  description: string | null
  /** 서버 프록시 썸네일 경로(/api/chat/link-preview/images/…). 없으면 null = 썸네일 칸 없음 */
  image: string | null
}

export interface ThreadParticipant {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
}

export interface ChannelMember {
  user_id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  role: string
  is_online: boolean
}

export interface TypingUser {
  user_id: string
  username: string
  timeout: ReturnType<typeof setTimeout>
}

export interface WorkspaceUser {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
}

// 채널 통화 상태 — 채널 id → 지금 통화에 있는 사람(백엔드 app/meetings/calls.py 가 LiveKit 웹훅으로 유지)
export interface CallState { count: number; names: string[]; since: number | null }

/** 음성 채널 접속자 한 명(서버 presence — app/chat/voice.py) */
export interface VoicePresence {
  identity: string
  user_id: string | null
  name: string
  avatar_url: string | null
  muted: boolean
  deafened: boolean
  tier: 'voice' | 'music' | 'lossless' | 'hires'
  joined_at: number
}
export interface VoiceChannelState { participants: VoicePresence[]; since: number | null }

// 전송 대기함 — 끊긴 동안 보낸 메시지. 연결되면 순서대로 보낸다. 새로고침해도 남게 localStorage 에 둔다.
export interface OutboxItem {
  localId: string; channelId: string; content: string; createdAt: string
  /** 답장 · @silent(재전송 때 유지) */
  opts?: SendOptions
  /** 서버가 거절했다(4xx — 채널을 나갔거나 권한이 없어짐). 줄에 "보내지 못했습니다 · 다시 보내기 · 삭제"(handover-21 #failed) */
  failed?: boolean
}

export interface ChatState {
  channels: Channel[]
  /** 채널 목록 불러오기 실패 — 시안 B1 "불러오기 실패" 타일(원인 한 줄 + 다시 시도)을 그리려면 실패를 삼키지 말아야 한다 */
  channelsError: string | null
  selectedChannelId: string | null
  messages: ChatMessage[]
  members: ChannelMember[]
  loadingChannels: boolean
  loadingMessages: boolean
  hasMoreMessages: boolean
  loadingMore: boolean
  wsConnected: boolean
  onlineUsers: Set<string>
  typingUsers: Map<string, TypingUser>
  showMemberPanel: boolean
  allUsers: WorkspaceUser[]
  callStates: Record<string, CallState>
  /** 음성 채널별 접속자(voice_state 이벤트 · GET /api/chat/voice/states) */
  voiceStates: Record<string, VoiceChannelState>
  showNotifyBanner: boolean

  // Thread state
  activeThreadId: string | null
  threadMessages: ChatMessage[]
  threadParent: ChatMessage | null
  loadingThread: boolean
  /** 열어 둔 스레드의 내 팔로우 상태(GET /messages/{id}/thread 가 replies 와 함께 준다) */
  activeThreadState: ThreadFollowState | null
  /** 내가 팔로우하는 스레드 목록(GET /api/chat/threads) — 셸의 "스레드" 모아보기. 열 때만 읽는다. */
  threads: ThreadSummary[]
  loadingThreads: boolean
  /** 셸 배지 — 미읽음 답글이 있는 스레드 수·답글 총수(GET /api/chat/threads/unread-count) */
  threadUnread: ThreadUnreadCount

  // Search state
  searchQuery: string
  searchResults: any[]
  searchLoading: boolean
  showSearchPanel: boolean

  /** 프레즌스 — 사용자 id → {state, emoji, text}. onlineUsers(Set) 는 하위호환으로 함께 유지한다. */
  presences: Record<string, UserPresence>
  /** 내 상태 설정(GET/PUT /api/chat/me/status) */
  myStatus: MyStatus | null

  /** 핀 — 열어 둔 채널의 핀 목록(GET /channels/{id}/pins). 채널을 바꾸면 비운다. */
  pins: ChatMessage[]
  loadingPins: boolean
  showPinsPanel: boolean

  /**
   * 저장한 메시지(POST/DELETE /messages/{id}/save · GET /saved) — 사이드바 고정 항목 "저장한 메시지"와 액션 바 "저장".
   * 저장 여부는 메시지 응답의 is_saved 가 기준이다. 이 기기에서 방금 누른 것은 savedOverride 가 앞선다
   * (목록(/saved)은 최근 일부만 오므로 오래된 저장 메시지는 is_saved 로만 알 수 있다).
   */
  savedMessages: ChatMessage[]
  savedOverride: Record<string, boolean>
  loadingSaved: boolean

  /** 임시글 — draftKey(채널, 루트) → 서버 저장본. 입력은 디바운스로 PUT, 전송하면 서버가 지운다. */
  drafts: Record<string, ChatDraft>

  /**
   * 읽음 처리(R-22) — "봤다"는 건 창이 보이고 포커스가 있고 목록 맨 아래가 화면에 있을 때뿐이다.
   * 그 조건이 안 되면 읽음을 미뤘다가 조건이 맞는 순간 보낸다.
   */
  viewAtBottom: boolean
  /** 위로 스크롤해 있는 동안 아래에 쌓인 새 메시지 수("새 메시지 N") */
  newBelowCount: number

  /** 연결 상태(R-23) — 끊긴 시각과 다음 재시도 시각. 배너는 3초 넘게 끊겼을 때만 띄운다. */
  disconnectedAt: number | null
  reconnectAt: number | null

  outbox: OutboxItem[]
  /** 점프(handover-22 #jump-far)로 옛 위치를 보는 중 — 아래(최근)에 더 있다. 이 동안 새 메시지는 붙이지 않고 "새 메시지 N" 만 센다 */
  hasMoreAfter: boolean
}

// Module-level singleton state
export const chatStore = createStore<ChatState>()(() => ({
  channels: [],
  channelsError: null,
  selectedChannelId: null,
  messages: [],
  members: [],
  loadingChannels: false,
  loadingMessages: false,
  hasMoreMessages: false,
  loadingMore: false,
  wsConnected: false,
  onlineUsers: new Set(),
  typingUsers: new Map(),
  showMemberPanel: false,
  allUsers: [],
  callStates: {},
  voiceStates: {},
  showNotifyBanner: false,
  activeThreadId: null,
  threadMessages: [],
  threadParent: null,
  loadingThread: false,
  activeThreadState: null,
  threads: [],
  loadingThreads: false,
  threadUnread: { threads: 0, replies: 0 },
  searchQuery: '',
  searchResults: [],
  searchLoading: false,
  showSearchPanel: false,
  presences: {},
  myStatus: null,
  pins: [],
  loadingPins: false,
  showPinsPanel: false,
  savedMessages: [],
  savedOverride: {},
  loadingSaved: false,
  drafts: {},
  viewAtBottom: true,
  newBelowCount: 0,
  disconnectedAt: null,
  reconnectAt: null,
  outbox: [],
  hasMoreAfter: false,
}))

const S = () => chatStore.getState()
const set = (p: Partial<ChatState>) => chatStore.setState(p)
const me = () => authStore.getState().user

/** Vue 판의 채널 객체 제자리 수정(ch.unread_count++ 등)을 새 배열로 */
function patchChannel(id: string, fn: (c: Channel) => Channel) {
  const list = S().channels
  if (!list.some(c => c.id === id)) return
  set({ channels: list.map(c => (c.id === id ? fn(c) : c)) })
}

let _threadsLoaded = false
let _savedLoaded = false

const DRAFT_DEBOUNCE_MS = 1000
const _draftTimers = new Map<string, ReturnType<typeof setTimeout>>()
const _draftPending = new Map<string, string>()   // 아직 PUT 안 된 이 기기의 입력값
let _draftsMigrated = false

let _ws: WebSocket | null = null
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null
let _reconnectDelay = 1000
let _pingInterval: ReturnType<typeof setInterval> | null = null
let _everConnected = false   // 첫 연결 이후의 연결은 재접속이다(끊긴 동안 놓친 것을 다시 읽는다)
let _typingThrottleTimer: ReturnType<typeof setTimeout> | null = null
let _initialized = false
let _pendingRead: { channelId: string; messageId: string } | null = null
let _visibilityHooked = false

let _lastPong = 0

// 대기함은 사용자별로 — 같은 브라우저에서 다른 사람이 로그인했을 때 앞사람의 대기 글이 그 사람 이름으로 나가지 않게
const OUTBOX_KEY_LEGACY = 'jw-chat-outbox'
const outboxKey = () => `jw-chat-outbox:${me()?.id ?? 'anon'}`
/** 최근에 처리한 new_message id — 중복 이벤트 걸러내기용(크기 제한) */
const _seenMsgIds = new Set<string>()
/** seq 순서를 지켜 끼워 넣는다. 보통은 맨 뒤 — 재접속 보충분이 실시간 메시지보다 늦게 도착했을 때만 앞에 들어간다 */
function insertBySeq(list: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  const last = list[list.length - 1]
  if (!msg.seq || !last?.seq || last.seq < msg.seq) return [...list, msg]
  let i = list.length
  while (i > 0 && (list[i - 1].seq ?? 0) > msg.seq) i--
  return [...list.slice(0, i), msg, ...list.slice(i)]
}
let _outboxLoaded = false
let _flushingOutbox = false

// 재접속 복구 커서(R-16) — 받은 메시지 중 가장 큰 seq. 끊긴 동안 생긴 것만 /api/chat/changes 로 받는다
let _lastSeq = 0

// ─── 바깥에서 대입하던 상태(Vue 의 x.value = v) ───

export const setShowMemberPanel = (v: boolean) => set({ showMemberPanel: v })
export const setShowPinsPanel = (v: boolean) => set({ showPinsPanel: v })
export const setShowSearchPanel = (v: boolean) => set({ showSearchPanel: v })
export const setSearchQuery = (v: string) => set({ searchQuery: v })
export const setShowNotifyBanner = (v: boolean) => set({ showNotifyBanner: v })

// ─── 계산 값(Vue computed) — 컴포넌트 밖에서도 쓰게 state 를 받는 함수로 ───

export function selectSelectedChannel(s: ChatState = S()): Channel | null {
  return s.channels.find(c => c.id === s.selectedChannelId) || null
}
export function selectSortedChannels(s: ChatState = S()): { channels: Channel[]; dms: Channel[]; voice: Channel[] } {
  // 음성 채널은 따로 묶는다(handover-20 답 §5.1 — 사이드바 별도 "음성" 구역)
  const pub = s.channels.filter(c => c.type !== 'dm' && !c.is_voice)
  const dms = s.channels.filter(c => c.type === 'dm')
  const voice = s.channels.filter(c => c.type !== 'dm' && !!c.is_voice)
  return { channels: pub, dms, voice }
}
// 뮤트 규칙은 lib/chatEvents.summarizeUnread 에 — 뮤트 채널은 굵게(미읽음)에서 빠지고 멘션 숫자는 남는다
const _summaryCache = new WeakMap<Channel[], UnreadSummary>()
export function selectUnreadSummary(s: ChatState = S()): UnreadSummary {
  let v = _summaryCache.get(s.channels)
  if (!v) { v = summarizeUnread(s.channels); _summaryCache.set(s.channels, v) }
  return v
}
/** 열어 둔 스레드의 임시글(스레드 입력창용) */
export function selectActiveThreadDraft(s: ChatState = S()): string {
  return (s.selectedChannelId && s.activeThreadId)
    ? s.drafts[draftKey(s.selectedChannelId, s.activeThreadId)]?.content || ''
    : ''
}
/** 열어 둔 채널의 임시글(채널 입력창용) */
export function selectSelectedChannelDraft(s: ChatState = S()): string {
  return s.selectedChannelId ? s.drafts[draftKey(s.selectedChannelId)]?.content || '' : ''
}

// ─── REST Actions ───

export async function fetchChannels() {
  set({ loadingChannels: true })
  try {
    const data = await $fetch<Channel[]>('/api/chat/channels')
    set({ channels: data, channelsError: null })
  } catch (e: any) {
    console.error('fetchChannels error:', e)
    set({ channelsError: e?.data?.detail || e?.message || '네트워크 오류' })
  } finally {
    set({ loadingChannels: false })
  }
}

/** 대화를 닫고 목록만 남긴다(모바일 ‹ 뒤로). 열린 패널·핀·스레드도 함께 비운다 — 안 보는 채널을 읽음 처리하지 않게. */
export function deselectChannel() {
  _pendingRead = null
  set({
    selectedChannelId: null,
    messages: [],
    members: [],
    typingUsers: new Map(),
    newBelowCount: 0,
    activeThreadId: null,
    threadMessages: [],
    threadParent: null,
    activeThreadState: null,
    showSearchPanel: false,
    showMemberPanel: false,
    showPinsPanel: false,
    pins: [],
  })
}

/**
 * 채널에 들어온 순간의 안 읽음 수. 목록을 다 불러오면 곧바로 읽음 처리돼 unread_count 가 0 이 되므로,
 * "새 메시지" 구분선은 이 값을 쓴다(예전엔 0 이 된 뒤에 읽어 구분선이 거의 안 떴다). 한 번 쓰면 비운다.
 */
let _entryUnread: { channelId: string; count: number } | null = null
export function takeEntryUnread(channelId: string | null | undefined): number | null {
  const e = _entryUnread
  if (!e || !channelId || e.channelId !== channelId) return null
  _entryUnread = null
  return e.count
}

export async function selectChannel(id: string) {
  _pendingRead = null
  _entryUnread = { channelId: id, count: S().channels.find(c => c.id === id)?.unread_count || 0 }
  set({
    selectedChannelId: id,
    messages: [],
    typingUsers: new Map(),
    viewAtBottom: true,
    newBelowCount: 0,
    // Close thread/search panels on channel switch
    activeThreadId: null,
    threadMessages: [],
    threadParent: null,
    activeThreadState: null,
    showSearchPanel: false,
    // 핀은 채널 단위 — 비우고, 패널이 열려 있으면 새 채널 것을 읽는다
    pins: [],
  })
  await Promise.all([fetchMessages(), fetchMembers(), S().showPinsPanel ? fetchPins(id) : Promise.resolve()])
}

export async function fetchMessages(before?: string) {
  // 요청한 채널을 잡아 둔다 — 응답이 오기 전에 다른 채널로 옮겼으면 버린다
  // (예전엔 A 의 늦은 응답이 B 화면에 그려지고, 이어서 B 를 읽음 처리해 배지까지 지웠다)
  const chId = S().selectedChannelId
  if (!chId) return
  if (before) {
    set({ loadingMore: true })
  } else {
    set({ loadingMessages: true })
  }
  try {
    const params: Record<string, any> = { limit: 50 }
    if (before) params.before = before

    const data = await $fetch<{ messages: ChatMessage[]; has_more: boolean }>(
      `/api/chat/channels/${chId}/messages`,
      { params },
    )
    if (S().selectedChannelId !== chId) return

    if (before) {
      set({ messages: [...data.messages, ...S().messages] })
    } else {
      set({ messages: data.messages })
    }
    set({ hasMoreMessages: data.has_more })
    if (!before) set({ hasMoreAfter: false })

    // 진입 직후 맨 아래를 보고 있으면 읽음 — 창이 안 보이면 보일 때까지 미룬다(R-22)
    if (!before && data.messages.length > 0) {
      const last = data.messages[data.messages.length - 1]
      set({ newBelowCount: 0 })
      requestRead(chId, last.id)
    }
  } catch (e: any) {
    console.error('fetchMessages error:', e)
  } finally {
    if (S().selectedChannelId === chId) set({ loadingMessages: false, loadingMore: false })
  }
}

export async function fetchMembers() {
  const chId = S().selectedChannelId
  if (!chId) return
  try {
    const data = await $fetch<ChannelMember[]>(
      `/api/chat/channels/${chId}/members`,
    )
    if (S().selectedChannelId !== chId) return   // 그새 다른 채널로 옮겼다
    // Merge online status
    const online = S().onlineUsers
    set({ members: data.map(m => ({ ...m, is_online: online.has(m.user_id) })) })
  } catch (e: any) {
    console.error('fetchMembers error:', e)
  }
}

export async function createChannel(name: string, type: string, description?: string, memberIds?: string[], voice = false) {
  const result = await $fetch<{ id: string; name: string; type: string; is_voice?: boolean }>(
    '/api/chat/channels',
    {
      method: 'POST',
      body: { name, type, description, member_ids: memberIds || [], voice },
    },
  )
  await fetchChannels()
  return result
}

export async function addMembers(channelId: string, userIds: string[]) {
  await $fetch(`/api/chat/channels/${channelId}/members`, {
    method: 'POST',
    body: { user_ids: userIds },
  })
  await fetchMembers()
}

export async function leaveChannel(channelId: string) {
  const user = me()
  if (!user) return
  await $fetch(`/api/chat/channels/${channelId}/members/${user.id}`, {
    method: 'DELETE',
  })
  set({ channels: S().channels.filter(c => c.id !== channelId) })
  if (S().selectedChannelId === channelId) deselectChannel()
}

/** 채널 삭제(소유자) — 서버가 메시지·스레드까지 지우고 멤버들에게 목록 갱신을 알린다 */
export async function deleteChannel(channelId: string) {
  await $fetch(`/api/chat/channels/${channelId}`, { method: 'DELETE' })
  set({ channels: S().channels.filter(c => c.id !== channelId) })
  if (S().selectedChannelId === channelId) deselectChannel()
}

export async function openDM(userId: string) {
  const result = await $fetch<{ id: string; name: string; type: string }>(
    '/api/chat/dm',
    { method: 'POST', body: { user_id: userId } },
  )
  await fetchChannels()
  await selectChannel(result.id)
}

export async function searchUsers(query: string) {
  if (!query.trim()) return []
  return await $fetch<Array<{ id: string; username: string; display_name: string | null; avatar_url: string | null }>>(
    '/api/chat/users',
    { params: { q: query } },
  )
}

async function sendMessageREST(channelId: string, content: string, messageType = 'text', fileMeta?: string, opts?: SendOptions) {
  return await $fetch<ChatMessage>(
    `/api/chat/channels/${channelId}/messages`,
    {
      method: 'POST',
      body: { content, message_type: messageType, file_meta: fileMeta, ...sendExtra(opts) },
    },
  )
}
/** 보내기 옵션 → 요청 필드(값이 있는 것만 — 옛 서버는 모르는 필드를 무시) */
function sendExtra(opts?: SendOptions): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  if (opts?.reply_to_id) { o.reply_to_id = opts.reply_to_id; o.reply_ping = opts.reply_ping !== false }
  if (opts?.silent) o.silent = true
  return o
}

export async function editMessage(messageId: string, content: string) {
  const msg = await $fetch<ChatMessage | null>(`/api/chat/messages/${messageId}`, {
    method: 'PATCH',
    body: { content },
  })
  // 응답을 바로 반영 — 다른 사람·다른 기기는 서버의 message_update 이벤트로 바뀐다
  if (msg?.id) applyMessageUpdate(msg)
}

export async function deleteMessage(messageId: string) {
  await $fetch(`/api/chat/messages/${messageId}`, {
    method: 'DELETE',
  })
  applyMessageDelete(messageId)
}

/** 지운 메시지를 모든 목록에서 뺀다(내가 지웠을 때 · WS message_delete). 스레드 답글이면 원문의 답글 수도 줄인다. */
function applyMessageDelete(messageId: string, parentId?: string | null) {
  const s = S()
  const gone = s.messages.find(m => m.id === messageId) || s.threadMessages.find(m => m.id === messageId)
  const pid = parentId ?? gone?.parent_id ?? null
  const wasCounted = !!gone || !!parentId   // 이 화면이 그 답글을 세고 있었을 때만 줄인다
  const dec = <M extends ChatMessage>(m: M): M => (pid && wasCounted && m.id === pid ? { ...m, reply_count: Math.max(0, (m.reply_count || 0) - 1) } : m)
  set({
    messages: s.messages.filter(m => m.id !== messageId).map(dec),
    threadMessages: s.threadMessages.filter(m => m.id !== messageId),
    pins: s.pins.filter(m => m.id !== messageId),
    savedMessages: s.savedMessages.filter(m => m.id !== messageId),
    ...(s.threadParent ? { threadParent: dec(s.threadParent) } : {}),
  })
  // 열어 둔 스레드의 원문이 지워졌으면 패널을 닫는다
  if (S().activeThreadId === messageId) closeThread()
}

export async function fetchPresence() {
  try {
    const data = await $fetch<PresenceSnapshot>('/api/chat/presence')
    const snap = presencesFromSnapshot(data)
    set({
      presences: snap.presences,
      onlineUsers: snap.online,
      members: S().members.map(m => ({ ...m, is_online: snap.online.has(m.user_id) })),
    })
  } catch (e: any) {
    console.error('fetchPresence error:', e)
  }
}

// ─── 프레즌스 · 내 상태 ───

/** 사용자 1명의 실효 상태. 모르는 사람은 offline. (hook 의 presenceOf 는 렌더 시점 값으로 구독한다) */
export function presenceOf(userId: string, s: ChatState = S()): UserPresence {
  return s.presences[userId] || (s.onlineUsers.has(userId) ? { state: 'online', emoji: null, text: null } : OFFLINE)
}

export async function fetchMyStatus() {
  try {
    set({ myStatus: await $fetch<MyStatus>('/api/chat/me/status') })
  } catch (e: any) {
    console.error('fetchMyStatus error:', e)
  }
}

/**
 * 내 상태 바꾸기 — 보낸 필드만 바뀐다(null 명시 = 비우기). 서버가 전원에게 presence 를 쏘므로
 * 내 presences 항목은 그 이벤트로 맞춰진다. 응답은 저장된 설정 전체.
 */
export async function updateMyStatus(patch: MyStatusUpdate) {
  const res = await $fetch<MyStatus>('/api/chat/me/status', { method: 'PUT', body: patch })
  set({ myStatus: res })
  return res
}

/** 모드만(auto|away|dnd|invisible). dnd 는 dnd_until 로 기한을 둘 수 있다. */
export function setStatusMode(mode: MyStatus['mode'], dndUntil?: string | null) {
  const patch: MyStatusUpdate = { mode }
  if (dndUntil !== undefined) patch.dnd_until = dndUntil
  return updateMyStatus(patch)
}

/** 커스텀 상태(이모지+문구, 만료 시각). 문구를 비우면 서버가 이모지·만료도 함께 비운다. */
export function setCustomStatus(text: string | null, emoji?: string | null, expiresAt?: string | null) {
  const patch: MyStatusUpdate = { custom_text: text || null }
  if (emoji !== undefined) patch.custom_emoji = emoji
  if (expiresAt !== undefined) patch.custom_expires_at = expiresAt
  return updateMyStatus(patch)
}

export function clearCustomStatus() {
  return updateMyStatus({ custom_text: null, custom_emoji: null, custom_expires_at: null })
}

// ─── 안 읽음 · 채널 알림 설정 ───

/**
 * "여기부터 안 읽음" — 읽음 포인터를 그 메시지 바로 앞으로 되감는다. 응답의 배지를 그대로 반영하고,
 * 미뤄 둔 자동 읽음을 버려서 바로 다시 읽음 처리되는 일을 막는다(다음 새 메시지가 오면 다시 읽는다).
 */
export async function markUnread(channelId: string, messageId: string) {
  const res = await $fetch<{ ok: boolean; channel_id: string; last_read_seq: number; unread_count: number; mention_count: number; group_mention: boolean }>(
    `/api/chat/channels/${channelId}/unread`, { method: 'POST', body: { message_id: messageId } },
  )
  if (_pendingRead?.channelId === channelId) _pendingRead = null
  set({ channels: applyChannelUnread(S().channels, { ...res, seq: res.last_read_seq }) })
  return res
}

/** 사이드바 채널 메뉴 "읽음으로 표시"(handover-22 #mute-menu) — 마지막 메시지까지 읽음(WS mark_read) */
export async function markChannelRead(channelId: string) {
  const r = await $fetch<{ messages: ChatMessage[] }>(`/api/chat/channels/${channelId}/messages`, { params: { limit: 1 } })
  const last = r?.messages?.[r.messages.length - 1]
  if (last) markRead(channelId, last.id)
  else patchChannel(channelId, c => ({ ...c, unread_count: 0, mention_count: 0, group_mention: false }))
}

/** 채널별 알림 수준·뮤트(PATCH /channels/{id}/prefs). 내 멤버행만 바뀐다. */
export async function fetchChannelPrefs(channelId: string) {
  return await $fetch<ChannelPrefs>(`/api/chat/channels/${channelId}/prefs`)
}

export async function updateChannelPrefs(channelId: string, patch: { notify_level?: NotifyLevel; muted?: boolean } & ChannelDevicePrefs) {
  const res = await $fetch<ChannelPrefs>(`/api/chat/channels/${channelId}/prefs`, { method: 'PATCH', body: patch })
  set({ channels: applyChannelPrefs(S().channels, res) })
  return res
}

export function setNotifyLevel(channelId: string, level: NotifyLevel) {
  return updateChannelPrefs(channelId, { notify_level: level })
}

export function toggleMute(channelId: string, muted?: boolean) {
  const ch = S().channels.find(c => c.id === channelId)
  return updateChannelPrefs(channelId, { muted: muted ?? !ch?.muted })
}

// ─── 핀 ───

export async function fetchPins(channelId?: string) {
  const id = channelId || S().selectedChannelId
  if (!id) return
  set({ loadingPins: true })
  try {
    const data = await $fetch<{ items: ChatMessage[] }>(`/api/chat/channels/${id}/pins`)
    if (id === S().selectedChannelId) set({ pins: data.items })   // 그새 다른 채널로 옮겼으면 버린다
  } catch (e: any) {
    console.error('fetchPins error:', e)
  } finally {
    set({ loadingPins: false })
  }
}

/** 서버가 message_update 로 전원에게 알리므로 응답은 확인용 — 바로 반영해 둔다(내 화면이 먼저 바뀌게). */
export async function pinMessage(messageId: string) {
  const msg = await $fetch<ChatMessage>(`/api/chat/messages/${messageId}/pin`, { method: 'POST' })
  applyMessageUpdate(msg)
  return msg
}

export async function unpinMessage(messageId: string) {
  const msg = await $fetch<ChatMessage>(`/api/chat/messages/${messageId}/pin`, { method: 'DELETE' })
  applyMessageUpdate(msg)
  return msg
}

export function togglePin(messageId: string) {
  const m = S().messages.find(x => x.id === messageId) || S().pins.find(x => x.id === messageId)
  return m?.pinned_at ? unpinMessage(messageId) : pinMessage(messageId)
}

/** WS message_update(핀·편집) — 같은 id 를 모든 목록에서 갈아 끼운다. */
function applyMessageUpdate(msg: ChatMessage) {
  const s = S()
  set({
    messages: replaceMessage(s.messages, msg),
    threadMessages: replaceMessage(s.threadMessages, msg),
    ...(s.threadParent?.id === msg.id ? { threadParent: { ...s.threadParent, ...msg } } : {}),
    pins: applyPinUpdate(s.pins, msg, s.selectedChannelId),
    savedMessages: replaceMessage(s.savedMessages, msg),
  })
}

/** WS link_preview — 카드가 생겼거나(값) 지워졌다(null). 메시지의 그 필드만 바꾼다. */
function applyLinkPreview(messageId: string, preview: LinkPreview | null) {
  const s = S()
  const patch = { id: messageId, link_preview: preview }
  set({
    messages: replaceMessage(s.messages, patch),
    threadMessages: replaceMessage(s.threadMessages, patch),
    ...(s.threadParent?.id === messageId ? { threadParent: { ...s.threadParent, link_preview: preview } } : {}),
    savedMessages: replaceMessage(s.savedMessages, patch),
  })
}

/** 링크 미리보기 지우기(보낸 사람만 — 서버가 403 으로 막는다). 내 화면은 바로, 다른 사람은 이벤트로. */
export async function dismissLinkPreview(messageId: string) {
  await $fetch(`/api/chat/messages/${messageId}/link-preview`, { method: 'DELETE' })
  applyLinkPreview(messageId, null)
}

// ─── 저장한 메시지 ───

export async function fetchSaved() {
  set({ loadingSaved: true })
  try {
    const data = await $fetch<{ items: ChatMessage[] }>('/api/chat/saved')
    set({ savedMessages: data.items })
    _savedLoaded = true
  } catch (e: any) {
    console.error('fetchSaved error:', e)
  } finally {
    set({ loadingSaved: false })
  }
}

/** 저장했나. (hook 의 isSaved 는 렌더 시점 값으로 구독한다) */
export function isSaved(messageId: string, s: ChatState = S()): boolean {
  const o = s.savedOverride[messageId]
  if (o !== undefined) return o
  if (s.savedMessages.some(m => m.id === messageId)) return true
  const m = s.messages.find(x => x.id === messageId)
    || s.threadMessages.find(x => x.id === messageId)
    || (s.threadParent?.id === messageId ? s.threadParent : undefined)
    || s.pins.find(x => x.id === messageId)
  return !!m?.is_saved
}

function _setSavedOverride(messageId: string, v: boolean) {
  set({ savedOverride: { ...S().savedOverride, [messageId]: v } })
}

/** 저장 — 목록 맨 앞에 바로 넣는다(서버는 최근 저장 순). 아직 목록을 안 읽었으면 읽어 둔다. */
export async function saveMessage(messageId: string) {
  const local = S().messages.find(m => m.id === messageId)
    || S().threadMessages.find(m => m.id === messageId)
    || S().pins.find(m => m.id === messageId)
  await $fetch(`/api/chat/messages/${messageId}/save`, { method: 'POST' })
  _setSavedOverride(messageId, true)
  if (!_savedLoaded) { await fetchSaved(); return }
  if (local && !S().savedMessages.some(m => m.id === messageId)) set({ savedMessages: [{ ...local, is_saved: true }, ...S().savedMessages] })
}

export async function unsaveMessage(messageId: string) {
  await $fetch(`/api/chat/messages/${messageId}/save`, { method: 'DELETE' })
  _setSavedOverride(messageId, false)
  set({ savedMessages: S().savedMessages.filter(m => m.id !== messageId) })
}

export function toggleSave(messageId: string) {
  return isSaved(messageId) ? unsaveMessage(messageId) : saveMessage(messageId)
}

// ─── 임시글 ───

export async function fetchDrafts() {
  try {
    const data = await $fetch<{ items: ChatDraft[] }>('/api/chat/drafts')
    // 아직 PUT 안 된 이 기기 입력값은 서버본보다 새롭다 — 덮어쓰지 않는다
    const next = draftsFromList(data.items)
    for (const [key, content] of _draftPending) {
      if (!content) { delete next[key]; continue }
      const [channel_id, parent_id = null] = key.split(':', 2)
      next[key] = { channel_id, parent_id, content, updated_at: next[key]?.updated_at ?? null }
    }
    set({ drafts: next })
  } catch (e: any) {
    console.error('fetchDrafts error:', e)
  }
}

/**
 * 저장된 임시글 본문(없으면 ''). 입력창을 채울 때 쓴다.
 * 이 기기에서 아직 PUT 안 된 값(_draftPending)이 먼저다 — 그 값은 store 밖이라 이 함수는 호출 시점 값을 돌려준다.
 */
export function draftFor(channelId: string, parentId?: string | null): string {
  const key = draftKey(channelId, parentId)
  return _draftPending.get(key) ?? S().drafts[key]?.content ?? ''
}

/**
 * 입력이 바뀔 때마다 부른다 — 매 키마다 PUT 하지 않고 약 1초 디바운스. 빈 문자열은 삭제와 같다.
 * 로컬 상태는 즉시 바꿔서(다른 입력창·탭 전환이 바로 보게), 서버는 잠잠해진 뒤 한 번만.
 */
export function setDraft(channelId: string, parentId: string | null | undefined, content: string) {
  const key = draftKey(channelId, parentId)
  const pid = parentId || null
  const drafts = S().drafts
  // 비어 있는데 저장된 것도 대기 중인 것도 없으면 할 일이 없다(입력창 마운트 때의 빈 호출)
  if (!content && !drafts[key] && !_draftPending.has(key)) return
  if (content) {
    set({ drafts: { ...drafts, [key]: { channel_id: channelId, parent_id: pid, content, updated_at: drafts[key]?.updated_at ?? null } } })
  } else if (drafts[key]) {
    const { [key]: _gone, ...rest } = drafts
    set({ drafts: rest })
  }
  _draftPending.set(key, content)
  const t = _draftTimers.get(key)
  if (t) clearTimeout(t)
  _draftTimers.set(key, setTimeout(() => flushDraft(channelId, pid), DRAFT_DEBOUNCE_MS))
}

/** 디바운스를 기다리지 않고 지금 서버에 쓴다(탭을 떠날 때 등). */
export async function flushDraft(channelId: string, parentId?: string | null) {
  const key = draftKey(channelId, parentId)
  const t = _draftTimers.get(key)
  if (t) { clearTimeout(t); _draftTimers.delete(key) }
  if (!_draftPending.has(key)) return
  const content = _draftPending.get(key) || ''
  try {
    const res = await $fetch<Omit<ChatDraft, 'content'> & { content: string | null }>('/api/chat/drafts', {
      method: 'PUT', body: { channel_id: channelId, parent_id: parentId || null, content },
    })
    // 보낸 뒤 또 바뀌었으면 그건 다음 flush 가 처리한다
    if (_draftPending.get(key) === content) {
      _draftPending.delete(key)
      if (res.content) set({ drafts: { ...S().drafts, [key]: { ...res, content: res.content } } })
    }
  } catch (e: any) {
    // 끊긴 상태 등 — 로컬 값은 남아 있으니 다음 입력·재접속 때 다시 쓴다
    console.error('flushDraft error:', e)
  }
}

/** 임시글 삭제(전송 직후 등). 서버가 전송 때 자동 삭제하지만, 대기 중인 PUT 이 되살리지 않게 먼저 끊는다. */
export function clearDraft(channelId: string, parentId?: string | null, { remote = true } = {}) {
  const key = draftKey(channelId, parentId)
  const t = _draftTimers.get(key)
  if (t) { clearTimeout(t); _draftTimers.delete(key) }
  _draftPending.delete(key)
  const drafts = S().drafts
  if (drafts[key]) {
    const { [key]: _gone, ...rest } = drafts
    set({ drafts: rest })
  }
  if (!remote) return Promise.resolve()
  const params: Record<string, string> = { channel_id: channelId }
  if (parentId) params.parent_id = parentId
  return $fetch('/api/chat/drafts', { method: 'DELETE', params }).catch(() => { /* 이미 없으면 그만 */ })
}

/**
 * 예전 ChatInput 이 localStorage(`chat-draft-<채널id>`)에 남긴 임시글을 서버로 옮긴다 — 한 번만.
 * 내 채널 목록에 있는 것만(아니면 403), 서버에 이미 있는 자리는 서버본을 우선한다. 옮긴 키는 지운다.
 */
async function migrateLocalDrafts() {
  if (_draftsMigrated) return
  _draftsMigrated = true
  let found: ReturnType<typeof collectLocalDrafts>
  try { found = collectLocalDrafts(localStorage) } catch { return }
  if (!found.length) return
  const mine = new Set(S().channels.map(c => c.id))
  for (const d of found) {
    if (!mine.has(d.channelId)) continue
    const key = draftKey(d.channelId)
    try {
      if (!S().drafts[key]) {
        await $fetch('/api/chat/drafts', { method: 'PUT', body: { channel_id: d.channelId, parent_id: null, content: d.content } })
        set({ drafts: { ...S().drafts, [key]: { channel_id: d.channelId, parent_id: null, content: d.content, updated_at: null } } })
      }
      localStorage.removeItem(d.key)
    } catch (e: any) {
      console.error('migrateLocalDrafts error:', e)   // 다음 로드에 다시 시도된다(_draftsMigrated 는 메모리뿐)
    }
  }
}

export async function fetchAllUsers() {
  try {
    const data = await $fetch<WorkspaceUser[]>('/api/chat/users')
    set({ allUsers: data })
  } catch (e: any) {
    console.error('fetchAllUsers error:', e)
  }
}

// ─── Threads ───

/**
 * 스레드 열기. 원 메시지는 타임라인·핀 목록에서 찾고, 없으면(스레드 모아보기에서 들어온 경우)
 * 요약으로 임시 parent 를 만든다. 열었으니 보고 있는 중이면 읽음 처리한다.
 */
export async function openThread(messageId: string) {
  const s = S()
  set({
    activeThreadId: messageId,
    activeThreadState: null,
    threadParent: s.messages.find(m => m.id === messageId)
      || s.pins.find(m => m.id === messageId)
      || threadParentFromSummary(s.threads.find(t => t.id === messageId)),
  })
  await fetchThreadReplies(messageId)
  const st = S().activeThreadState
  if (S().activeThreadId === messageId && (st?.unread_replies || 0) > 0 && canSeeThread()) {
    markThreadRead(messageId).catch(() => {})
  }
}

function threadParentFromSummary(t: ThreadSummary | undefined): ChatMessage | null {
  if (!t) return null
  return {
    id: t.id, channel_id: t.channel_id, content: t.content, created_at: t.created_at, updated_at: t.created_at,
    sender: t.sender_id ? { id: t.sender_id, username: t.sender_name, display_name: t.sender_name, avatar_url: null } : null,
    message_type: 'text', file_meta: null, parent_id: null, reply_count: t.reply_count, is_edited: false, is_deleted: false,
  }
}

export function closeThread() {
  set({ activeThreadId: null, threadMessages: [], threadParent: null, activeThreadState: null })
}

export async function fetchThreadReplies(parentId: string) {
  set({ loadingThread: true })
  try {
    const data = await $fetch<{ replies: ChatMessage[]; parent?: ChatMessage | null } & Partial<ThreadFollowState>>(
      `/api/chat/messages/${parentId}/thread`,
    )
    if (S().activeThreadId !== parentId) return   // 그새 다른 스레드로 옮겼다
    set({
      // 딥 링크·검색으로 들어와 원문이 화면 목록에 없을 때 — 서버가 준 원문으로 채운다(있던 값의 리액션 등은 지킨다)
      ...(data.parent ? { threadParent: { ...data.parent, ...(S().threadParent?.id === parentId ? S().threadParent : {}) } as ChatMessage } : {}),
      threadMessages: data.replies,
      activeThreadState: {
        followed: !!data.followed,
        unread_replies: data.unread_replies ?? 0,
        last_read_seq: data.last_read_seq ?? null,
      },
    })
  } catch (e: any) {
    console.error('fetchThreadReplies error:', e)
  } finally {
    set({ loadingThread: false })
  }
}

/** 답글 전송. alsoToChannel 이면 채널 타임라인에도 보인다("채널에도 보내기"). */
export function sendThreadReply(content: string, parentId: string, alsoToChannel = false, opts?: SendOptions) {
  const channelId = S().selectedChannelId
  if (!channelId) return
  clearDraft(channelId, parentId, { remote: false })   // 서버가 전송 때 지운다 — 대기 PUT 만 끊는다
  // 서버는 답글을 쓴 사람을 자동으로 팔로우한다(_auto_follow_on_reply) — 알약이 "따라가기"로 남지 않게 바로 맞춘다
  const st = S().activeThreadState
  if (S().activeThreadId === parentId && st && !st.followed) set({ activeThreadState: { ...st, followed: true } })
  if (_ws?.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify({
      type: 'send_message',
      channel_id: channelId,
      content,
      message_type: 'text',
      parent_id: parentId,
      also_to_channel: alsoToChannel,
      ...sendExtra(opts),
    }))
  } else {
    $fetch<ChatMessage>(`/api/chat/channels/${channelId}/messages`, {
      method: 'POST',
      body: { content, message_type: 'text', parent_id: parentId, also_to_channel: alsoToChannel, ...sendExtra(opts) },
    }).then((msg) => {
      if (S().activeThreadId === parentId && !S().threadMessages.find(m => m.id === msg.id)) {
        set({ threadMessages: [...S().threadMessages, msg] })
      }
    }).catch((e) => {
      console.error('sendThreadReply REST fallback error:', e)
      addToast('error', '답글을 보내지 못했습니다')
    })
  }
}

/** REST 로 만든 답글(스레드 첨부 업로드 응답) — 실시간 이벤트보다 먼저 오거나 WS 가 끊겼을 때 패널에 넣는다 */
export function ingestThreadReply(msg: ChatMessage) {
  if (!msg?.parent_id || msg.parent_id !== S().activeThreadId) return
  if (!S().threadMessages.find(m => m.id === msg.id)) set({ threadMessages: [...S().threadMessages, msg] })
}

// ─── 스레드 팔로우 · 읽음 · 모아보기 ───

/** 스레드 패널을 사람이 보고 있나 — 창이 보이고 포커스가 있다(스크롤 위치는 패널이 짧아 보지 않는다). */
function canSeeThread(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

async function setThreadFollow(rootId: string, followed: boolean) {
  const res = await $fetch<{ root_id: string; channel_id: string; followed: boolean }>(
    `/api/chat/messages/${rootId}/follow`, { method: followed ? 'POST' : 'DELETE' },
  )
  applyThreadFollowEvent(res)
  return res
}
export function followThread(rootId: string) { return setThreadFollow(rootId, true) }
export function unfollowThread(rootId: string) { return setThreadFollow(rootId, false) }
export function toggleThreadFollow(rootId: string) {
  const s = S()
  const cur = rootId === s.activeThreadId
    ? s.activeThreadState?.followed
    : s.threads.find(t => t.id === rootId)?.followed
  return setThreadFollow(rootId, !cur)
}

/** 스레드 읽음 — seq 를 비우면 마지막 답글까지. */
export async function markThreadRead(rootId: string, seq?: number) {
  const res = await $fetch<{ ok: boolean; root_id: string; last_read_seq: number | null }>(
    `/api/chat/threads/${rootId}/read`, { method: 'POST', body: seq !== undefined ? { seq } : {} },
  )
  if (res.last_read_seq !== null) applyThreadReadEvent({ root_id: rootId, seq: res.last_read_seq })
  return res
}

export async function fetchThreads() {
  set({ loadingThreads: true })
  try {
    const data = await $fetch<{ items: ThreadSummary[] }>('/api/chat/threads')
    set({ threads: data.items })
    _threadsLoaded = true
  } catch (e: any) {
    console.error('fetchThreads error:', e)
  } finally {
    set({ loadingThreads: false })
  }
}

export async function fetchThreadUnreadCount() {
  try {
    set({ threadUnread: await $fetch<ThreadUnreadCount>('/api/chat/threads/unread-count') })
  } catch (e: any) {
    console.error('fetchThreadUnreadCount error:', e)
  }
}

function applyThreadFollowEvent(evt: { root_id: string; channel_id: string; followed: boolean }) {
  const before = S().threads
  const after = applyThreadFollow(before, evt)
  set({ threads: after })
  // 켰는데 목록에 없다 — 목록을 열어 봤던 사람만 다시 읽는다
  if (evt.followed && _threadsLoaded && after === before && !before.some(t => t.id === evt.root_id)) void fetchThreads()
  const s = S()
  if (s.activeThreadId === evt.root_id && s.activeThreadState) {
    set({ activeThreadState: { ...s.activeThreadState, followed: evt.followed } })
  }
  void fetchThreadUnreadCount()
}

function applyThreadReadEvent(evt: { root_id: string; seq: number }) {
  set({ threads: applyThreadRead(S().threads, evt) })
  const s = S()
  if (s.activeThreadId === evt.root_id && s.activeThreadState) {
    const last = s.threadMessages[s.threadMessages.length - 1]
    const caughtUp = !last?.seq || last.seq <= evt.seq
    set({
      activeThreadState: {
        ...s.activeThreadState,
        last_read_seq: evt.seq,
        unread_replies: caughtUp ? 0 : s.activeThreadState.unread_replies,
      },
    })
  }
  void fetchThreadUnreadCount()
}

// ─── Reactions ───

export function toggleReaction(messageId: string, emoji: string) {
  if (_ws?.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify({
      type: 'toggle_reaction',
      message_id: messageId,
      emoji,
    }))
  } else {
    // REST fallback
    $fetch(`/api/chat/messages/${messageId}/reactions`, {
      method: 'POST',
      body: { emoji },
    }).then((result: any) => {
      applyReactionUpdate(messageId, result.reactions)
    }).catch(e => console.error('toggleReaction error:', e))
  }
}

function applyReactionUpdate(messageId: string, reactions: any[]) {
  const uid = me()?.id
  const mapped: ReactionGroup[] = (reactions || []).map((r: any) => ({
    emoji: r.emoji,
    count: r.count,
    user_ids: r.user_ids || [],
    reacted: uid ? (r.user_ids || []).includes(uid) : false,
  }))

  set({
    // Update in main messages
    messages: S().messages.map(m => (m.id === messageId ? { ...m, reactions: mapped } : m)),
    // Update in thread messages
    threadMessages: S().threadMessages.map(m => (m.id === messageId ? { ...m, reactions: mapped } : m)),
  })
}

// ─── Search ───

export async function searchMessages(query: string, channelId?: string) {
  set({ searchLoading: true })
  try {
    const params: Record<string, any> = { q: query, limit: 20 }
    if (channelId) params.channel_id = channelId
    set({ searchResults: await $fetch<any[]>('/api/chat/messages/search', { params }) })
  } catch (e: any) {
    console.error('searchMessages error:', e)
    set({ searchResults: [] })
  } finally {
    set({ searchLoading: false })
  }
}

// ─── WebSocket ───

export async function fetchCallStates() {
  try {
    set({ callStates: await $fetch<Record<string, CallState>>('/api/meetings/channel-calls') })
  } catch { /* 회의 기능이 꺼진 설치면 404 — 표시만 안 한다 */ }
}

/** 음성 채널 접속자 전부(처음·재접속·내가 나간 뒤) */
export async function fetchVoiceStates() {
  try {
    set({ voiceStates: await $fetch<Record<string, VoiceChannelState>>('/api/chat/voice/states') })
  } catch { /* 옛 백엔드면 404 — 표시만 안 한다 */ }
}

/** 한 채널의 접속 상태를 바로 반영(POST …/voice/state 응답 — 소켓 이벤트를 기다리지 않는다) */
export function applyVoiceState(channelId: string, state: VoiceChannelState | null) {
  const next = { ...S().voiceStates }
  if (state && state.participants?.length) next[channelId] = state
  else delete next[channelId]
  set({ voiceStates: next })
}

/**
 * 재접속 직후: 끊긴 동안 놓친 것을 다시 불러온다. WS 는 연결 중일 때 온 이벤트만 주므로
 * 이걸 안 하면 그 사이 메시지·채널 변화가 화면에 영영 안 나타난다.
 * 열린 채널은 마지막으로 가진 메시지 뒤(after)만 받아 붙이고, 너무 많이 밀렸으면 통째로 다시 읽는다.
 */
async function resyncAfterReconnect() {
  void fetchCallStates()   // 끊긴 동안 열리고 닫힌 통화
  void fetchVoiceStates()  // 끊긴 동안 드나든 음성 채널
  // 끊긴 동안의 상태 변화·스레드 답글·다른 기기의 임시글 — seq 커서에 안 잡히는 것들
  void fetchPresence()
  void fetchThreadUnreadCount()
  if (_threadsLoaded) void fetchThreads()
  if (S().showPinsPanel && S().selectedChannelId) void fetchPins(S().selectedChannelId!)
  // 1) seq 커서가 있으면 내 모든 채널의 빠진 메시지만 받아 실시간 이벤트처럼 흘려 넣는다
  if (_lastSeq > 0) {
    try {
      const ch = await $fetch<{ messages: ChatMessage[]; too_many: boolean; latest_seq: number }>(
        '/api/chat/changes', { params: { since_seq: _lastSeq } },
      )
      if (!ch.too_many) {
        for (const m of ch.messages) handleWSMessage({ type: 'new_message', message: m })
        _lastSeq = Math.max(_lastSeq, ch.latest_seq || 0)
        try { await fetchChannels() } catch { /* 배지는 다음 기회에 */ }
        if (S().activeThreadId) {
          try { await fetchThreadReplies(S().activeThreadId!) } catch { /* noop */ }
        }
        return
      }
      _lastSeq = ch.latest_seq || _lastSeq   // 너무 많이 밀림 → 아래 풀 리프레시
    } catch { /* 구버전 서버 등 — 아래 방식으로 */ }
  }
  // 2) 커서가 없거나 너무 많이 밀렸으면 채널 목록과 열린 채널을 다시 읽는다
  try { await fetchChannels() } catch { /* 목록은 다음 기회에 */ }
  const chId = S().selectedChannelId
  if (chId) {
    const msgs = S().messages
    const last = msgs[msgs.length - 1]
    if (!last) {
      await fetchMessages()
    } else {
      try {
        const data = await $fetch<{ messages: ChatMessage[]; has_more: boolean }>(
          `/api/chat/channels/${chId}/messages`,
          { params: { after: last.id, limit: 100 } },
        )
        if (S().selectedChannelId !== chId) return   // 그새 다른 채널로 옮겼다
        if (data.has_more) {
          await fetchMessages()   // 100개 넘게 밀림 → 이어 붙이기보다 새로 읽는 게 정확하다
        } else if (data.messages.length) {
          const have = new Set(S().messages.map(m => m.id))
          const fresh = data.messages.filter(m => !have.has(m.id))
          if (fresh.length) {
            set({ messages: [...S().messages, ...fresh] })
            requestRead(chId, fresh[fresh.length - 1].id)
          }
        }
      } catch (e) {
        console.error('resync messages error:', e)
      }
    }
  }
  if (S().activeThreadId) {
    try { await fetchThreadReplies(S().activeThreadId!) } catch { /* noop */ }
  }
}

export function connectWS() {
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return

  // 웹은 Vue 판과 같이 현재 창 주소 기준. 번들 앱은 apiBase 호스트 + 인증 하위 프로토콜(토큰은 쿼리에 싣지 않는다)
  const url = wsUrl('/ws/chat')

  _ws = new WebSocket(url, wsProtocols())

  _ws.onopen = () => {
    set({ wsConnected: true, disconnectedAt: null, reconnectAt: null })
    _reconnectDelay = 1000
    _lastPong = Date.now()
    if (_everConnected) void resyncAfterReconnect()
    _everConnected = true
    // 대기함을 다 보낸 뒤 임시글을 다시 받는다 — 끊기기 전 서버에 저장된 옛 임시글("hel")이, 대기함으로 이미 보낸 글 뒤에 입력창에 되살아났다
    void flushOutbox().then(() => fetchDrafts())
    flushPendingRead()
    // 핑 — 첫 회는 0~10초 지터(서버 재시작 뒤 수백 명이 같은 박자로 치지 않게), 이후 30초.
    // 90초 동안 pong 이 없으면 반쯤 죽은 연결(NAT 만료·절전 복귀)로 보고 끊는다 → onclose 의 백오프 재접속.
    const ws = _ws
    const tick = () => {
      if (!ws || ws !== _ws || ws.readyState !== WebSocket.OPEN) return
      if (Date.now() - _lastPong > 90_000) { ws.close(); return }
      ws.send(JSON.stringify({ type: 'ping' }))
    }
    _pingInterval = setTimeout(() => {
      tick()
      _pingInterval = setInterval(tick, 30_000)
    }, Math.random() * 10_000) as unknown as ReturnType<typeof setInterval>
  }

  _ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      handleWSMessage(data)
    } catch (e) {
      console.error('WS parse error:', e)
    }
  }

  _ws.onclose = () => {
    set({ wsConnected: false })
    if (S().disconnectedAt === null) set({ disconnectedAt: Date.now() })
    if (_pingInterval) {
      clearInterval(_pingInterval)
      clearTimeout(_pingInterval as unknown as ReturnType<typeof setTimeout>)
      _pingInterval = null
    }
    // Reconnect with exponential backoff
    set({ reconnectAt: Date.now() + _reconnectDelay })
    _reconnectTimer = setTimeout(() => {
      _reconnectDelay = Math.min(_reconnectDelay * 2, 30000)
      connectWS()
    }, _reconnectDelay)
  }

  _ws.onerror = () => {
    // onclose will fire after onerror
  }
}

/** 배너의 "다시 시도" — 기다리지 않고 바로 붙는다. */
export function retryNow() {
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer)
    _reconnectTimer = null
  }
  _reconnectDelay = 1000
  set({ reconnectAt: null })
  connectWS()
}

export function disconnectWS() {
  set({ disconnectedAt: null, reconnectAt: null })
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer)
    _reconnectTimer = null
  }
  if (_pingInterval) {
    clearInterval(_pingInterval)
    clearTimeout(_pingInterval as unknown as ReturnType<typeof setTimeout>)
    _pingInterval = null
  }
  if (_ws) {
    _ws.onclose = null  // prevent reconnect
    _ws.close()
    _ws = null
  }
  set({ wsConnected: false })
}

const _wsListeners = new Set<(data: any) => void>()
/** 소켓 이벤트 구독(새 화면 composable 용 — useChat 을 키우지 않으려고). 해제 함수를 돌려준다 */
export function onChatEvent(fn: (data: any) => void): () => void {
  _wsListeners.add(fn)
  return () => { _wsListeners.delete(fn) }
}

/** 테스트에서 이벤트 반영을 확인하려고 내보낸다(앱 코드는 소켓 onmessage 만 부른다) */
export function handleWSMessage(data: any) {
  // handover-22 — 역할·카테고리 변경(r24 관리 화면) · 다른 모듈 구독자(스레드 목록 등)
  if (data?.type === 'chat_roles_changed' || data?.type === 'chat_member_roles_changed') void import('~/composables/useChatRoles').then(m => m.handleRolesEvent(data))
  if (data?.type === 'chat_layout_changed') void import('~/composables/useChatLayout').then(m => m.handleLayoutEvent(data))
  for (const fn of _wsListeners) { try { fn(data) } catch { /* 구독자 오류는 소켓을 막지 않는다 */ } }
  switch (data.type) {
    case 'new_message': {
      const msg = data.message as ChatMessage
      if (msg.seq && msg.seq > _lastSeq) _lastSeq = msg.seq
      // 같은 메시지가 두 번 올 수 있다(재접속 보충 /changes 와 그 사이 도착한 실시간 이벤트) — 안 읽음 수·답글 수를 두 번 올리지 않는다
      if (_seenMsgIds.has(msg.id)) break
      _seenMsgIds.add(msg.id)
      if (_seenMsgIds.size > 600) { let n = 0; for (const id of _seenMsgIds) { if (n++ >= 200) break; _seenMsgIds.delete(id) } }
      // Thread reply handling
      if (msg.parent_id) {
        // If this thread is currently open, append to thread messages
        if (msg.parent_id === S().activeThreadId) {
          if (!S().threadMessages.find(m => m.id === msg.id)) {
            set({ threadMessages: insertBySeq(S().threadMessages, msg) })
          }
        }
        // Increment reply_count on parent in main messages
        set({ messages: S().messages.map(m => (m.id === msg.parent_id ? bumpThreadMeta(m, msg) : m)) })
        const tp = S().threadParent
        if (tp?.id === msg.parent_id) {
          set({ threadParent: bumpThreadMeta(tp, msg) })
        }
        // "채널에도 보내기" 한 답글은 메인 타임라인에도 넣고 채널 미읽음으로 센다(서버 main_timeline_filter 와 같은 선)
        if (!isMainTimelineMessage(msg)) break
      }
      // Main timeline message
      if (msg.channel_id === S().selectedChannelId) {
        // Avoid duplicates · 옛 위치를 보는 중(점프)이면 붙이지 않는다 — 끝에 닿으면 이어 읽는다(useChatJump)
        if (!S().hasMoreAfter && !S().messages.find(m => m.id === msg.id)) {
          set({ messages: insertBySeq(S().messages, msg) })
        }
        // 보고 있을 때만 읽음. 위로 스크롤해 있으면 "새 메시지 N" 을 띄운다(R-22)
        const mine = msg.sender?.id === me()?.id
        if (!mine && !S().viewAtBottom) set({ newBelowCount: S().newBelowCount + 1 })
        if (mine) markRead(msg.channel_id, msg.id)
        else requestRead(msg.channel_id, msg.id)
        // Clear typing for sender
        if (msg.sender) {
          const t = S().typingUsers.get(msg.sender.id)
          if (t) {
            clearTimeout(t.timeout)
            const next = new Map(S().typingUsers)
            next.delete(msg.sender.id)
            set({ typingUsers: next })
          }
        }
      } else {
        // Increment unread for other channel
        const ch = S().channels.find(c => c.id === msg.channel_id)
        if (ch && msg.sender?.id !== me()?.id) patchChannel(ch.id, c => ({ ...c, unread_count: c.unread_count + 1 }))
      }
      break
    }

    case 'typing': {
      const uid = data.user_id as string
      if (uid === me()?.id) break
      if (data.channel_id !== S().selectedChannelId) break

      // Clear existing timeout
      const existing = S().typingUsers.get(uid)
      if (existing) clearTimeout(existing.timeout)

      const timeout = setTimeout(() => {
        const next = new Map(S().typingUsers)
        next.delete(uid)
        set({ typingUsers: next })
      }, 3000)

      const next = new Map(S().typingUsers)
      next.set(uid, {
        user_id: uid,
        username: data.username,
        timeout,
      })
      set({ typingUsers: next })
      break
    }

    case 'presence': {
      // 신서버는 state(online|away|dnd|offline)·emoji·text, 구서버는 status(online|offline)만 — 둘 다 받는다
      const evt = data as PresenceEvent
      const uid = evt.user_id
      const presences = applyPresence(S().presences, evt)
      const online = presences[uid]?.state !== 'offline'
      const onlineUsers = new Set(S().onlineUsers)
      if (online) {
        onlineUsers.add(uid)
      } else {
        onlineUsers.delete(uid)
      }
      // Update members list
      const members = S().members.some(m => m.user_id === uid)
        ? S().members.map(m => (m.user_id === uid ? { ...m, is_online: online } : m))
        : S().members
      set({ presences, onlineUsers, members })
      // 내 상태가 다른 기기에서 바뀌었으면 설정도 다시 읽는다(실효 상태만 이벤트에 오므로)
      const ms = S().myStatus
      if (uid === me()?.id && ms && ms.state !== presences[uid]?.state) void fetchMyStatus()
      break
    }

    case 'channel_unread': {
      // 내 다른 기기에서 "여기부터 안 읽음" — 되감은 배지를 그대로 받는다
      set({ channels: applyChannelUnread(S().channels, data) })
      if (_pendingRead?.channelId === data.channel_id) _pendingRead = null
      break
    }

    case 'channel_prefs':
      set({ channels: applyChannelPrefs(S().channels, data) })
      break

    case 'message_delete':
      if (typeof data.message_id === 'string') applyMessageDelete(data.message_id, data.parent_id as string | null | undefined)
      break

    case 'message_update':
      // 핀·편집 — 메시지를 통째로 갈아 끼운다
      if (data.message) applyMessageUpdate(data.message as ChatMessage)
      break

    case 'link_preview':
      // 링크 미리보기 카드가 생김/지워짐(R5 B12)
      if (typeof data.message_id === 'string') applyLinkPreview(data.message_id, (data.link_preview ?? null) as LinkPreview | null)
      break

    case 'thread_update': {
      // 팔로우하는 스레드에 답글 — 목록·배지·열린 패널을 맞춘다(답글 자체는 new_message 로도 온다)
      const before = S().threads
      const after = applyThreadUpdate(before, data)
      set({ threads: after })
      if (after === before && _threadsLoaded && !before.some(t => t.id === data.root_id)) void fetchThreads()
      if (S().activeThreadId === data.root_id) {
        const reply = data.reply as ChatMessage
        if (reply && !S().threadMessages.find(m => m.id === reply.id)) {
          set({ threadMessages: [...S().threadMessages, reply] })
        }
        const ats = S().activeThreadState
        if (ats) set({ activeThreadState: { ...ats, unread_replies: data.unread_replies } })
        // 패널을 보고 있으면 바로 읽음 — 아니면 미읽음으로 남겨 돌아왔을 때 표시한다
        if (canSeeThread()) { markThreadRead(data.root_id).catch(() => {}); break }
      }
      void fetchThreadUnreadCount()
      break
    }

    case 'thread_read':
      applyThreadReadEvent(data)
      break

    case 'thread_follow':
      applyThreadFollowEvent(data)
      break

    case 'draft_update': {
      // 발신 기기도 받는다 — 이 기기가 지금 쓰고 있는 자리(PUT 대기 중)면 내 입력이 더 새로우니 통째로 무시하고,
      // 아니면 내용이 같을 때 리듀서가 같은 참조를 돌려줘 입력창을 건드리지 않는다
      const key = draftKey(data.channel_id, data.parent_id)
      if (_draftPending.has(key)) break
      set({ drafts: applyDraftUpdate(S().drafts, data) })
      break
    }

    case 'message_read': {
      const readUserId = data.user_id as string
      const readMessageId = data.message_id as string
      if (data.channel_id !== S().selectedChannelId) break
      if (readUserId === me()?.id) break

      const reader: ReadByUser = {
        id: readUserId,
        username: data.username,
        display_name: data.username,
        avatar_url: data.avatar_url || null,
      }

      // Find the read message's created_at to update all messages up to that point
      const readMsg = S().messages.find(m => m.id === readMessageId)
      if (!readMsg) break

      const readTs = readMsg.created_at
      set({
        messages: S().messages.map((m) => {
          if (m.created_at <= readTs && m.sender?.id !== readUserId) {
            const existing = m.read_by || []
            if (!existing.find(r => r.id === readUserId)) {
              return { ...m, read_by: [...existing, reader] }
            }
          }
          return m
        }),
      })
      break
    }

    case 'notification': {
      handleNotificationEvent(data.notification, { quiet: !!data.quiet })
      break
    }

    case 'reaction_update': {
      const msgId = data.message_id as string
      applyReactionUpdate(msgId, data.reactions)
      break
    }

    case 'channel_update':
      // Refresh channel list
      void fetchChannels()
      break

    case 'channel_read': {
      // 내 다른 기기·탭에서 읽었다 — 이 기기의 배지도 끈다
      patchChannel(data.channel_id, c => ({
        ...c,
        unread_count: 0,
        mention_count: 0,
        group_mention: false,
        ...(data.seq ? { last_read_seq: data.seq } : {}),
      }))
      break
    }

    case 'mention_count': {
      const ch = S().channels.find(c => c.id === data.channel_id)
      // 열어 둔 채널이라도 지금 안 보고 있으면(다른 창·위로 스크롤) 배지를 살린다
      if (ch && !(data.channel_id === S().selectedChannelId && canSeeLatest())) {
        patchChannel(ch.id, c => ({ ...c, mention_count: data.count, group_mention: !!data.group }))
      }
      break
    }

    case 'call_state': {
      const chId = data.channel_id as string
      const next = { ...S().callStates }
      if (data.count > 0) next[chId] = { count: data.count, names: data.names || [], since: data.since ?? null }
      else delete next[chId]
      set({ callStates: next })
      break
    }

    case 'voice_state': {
      const chId = data.channel_id as string
      const next = { ...S().voiceStates }
      const parts = (data.participants || []) as VoicePresence[]
      if (parts.length > 0) next[chId] = { participants: parts, since: data.since ?? null }
      else delete next[chId]
      set({ voiceStates: next })
      break
    }

    case 'pong':
      _lastPong = Date.now()
      break

    case 'error':
      console.error('WS error:', data.detail)
      // 소켓 전송은 확인 응답이 없다 — 서버가 거절하면(권한 없음·답장 원문 삭제 등) 이 이벤트가 유일한 신호다
      addToast('error', typeof data.detail === 'string' && data.detail ? data.detail : '메시지를 보내지 못했습니다')
      break
  }
}

export function sendMessage(content: string, messageType = 'text', fileMeta?: string | null, opts?: SendOptions) {
  const channelId = S().selectedChannelId
  if (!channelId) return
  afterFirstSend()
  // 보냈으니 그 자리 임시글은 끝 — 서버가 지우고 draft_update 를 보내지만, 대기 중인 PUT 이 되살리지 않게 먼저 끊는다
  if (messageType === 'text') clearDraft(channelId, null, { remote: false })
  // 끊긴 동안의 텍스트는 대기함에 — 연결되면 순서대로 보낸다(파일은 업로드가 이미 끝난 것이라 REST 로 바로)
  if (_ws?.readyState !== WebSocket.OPEN && messageType === 'text' && (S().disconnectedAt !== null || S().outbox.length)) {
    enqueueOutbox(channelId, content, opts)
    return
  }
  if (_ws?.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify({
      type: 'send_message',
      channel_id: channelId,
      content,
      message_type: messageType,
      file_meta: fileMeta || null,
      ...sendExtra(opts),
    }))
  } else {
    // Fallback to REST
    sendMessageREST(channelId, content, messageType, fileMeta || undefined, opts)
      .then((msg) => {
        if (channelId === S().selectedChannelId && !S().messages.find(m => m.id === msg.id)) {
          set({ messages: [...S().messages, msg] })
        }
      })
      .catch((e) => {
        console.error('sendMessage REST fallback error:', e)
        // 보낸 채널로 대기시킨다 — 예전엔 이 시점의 선택 채널을 다시 읽어, 그새 채널을 옮겼으면 다른 채널로 나갔다
        if (messageType === 'text') enqueueOutbox(channelId, content, opts)
        else addToast('error', '메시지를 보내지 못했습니다')
      })
  }
}

// ─── 전송 대기함 ───

function loadOutbox() {
  if (_outboxLoaded) return
  _outboxLoaded = true
  try {
    // 예전(사용자 구분 없는) 키에 남은 것은 한 번만 지금 사용자 것으로 옮긴다
    const legacy = localStorage.getItem(OUTBOX_KEY_LEGACY)
    if (legacy) { if (!localStorage.getItem(outboxKey())) localStorage.setItem(outboxKey(), legacy); localStorage.removeItem(OUTBOX_KEY_LEGACY) }
    set({ outbox: JSON.parse(localStorage.getItem(outboxKey()) || '[]') })
  } catch { set({ outbox: [] }) }
}
function saveOutbox() {
  try { localStorage.setItem(outboxKey(), JSON.stringify(S().outbox)) } catch { /* 저장 못 해도 메모리엔 있다 */ }
}
function enqueueOutbox(channelId: string, content: string, opts?: SendOptions) {
  loadOutbox()
  set({
    outbox: [...S().outbox, {
      localId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channelId, content, createdAt: new Date().toISOString(), ...(opts && (opts.reply_to_id || opts.silent) ? { opts } : {}),
    }],
  })
  saveOutbox()
}
export function discardOutbox(localId: string) {
  set({ outbox: S().outbox.filter(o => o.localId !== localId) })
  saveOutbox()
}
/** 보내지 못한 메시지 다시 보내기 */
export function retryOutbox(localId: string) {
  set({ outbox: S().outbox.map(o => (o.localId === localId ? { ...o, failed: false } : o)) })
  saveOutbox()
  void flushOutbox()
}
/** 연결되면 대기 메시지를 순서대로 REST 로 보낸다(응답으로 확인 — 실패하면 그 자리에서 멈춘다). */
async function flushOutbox() {
  loadOutbox()
  if (_flushingOutbox || !S().outbox.length) return
  _flushingOutbox = true
  try {
    for (;;) {
      const item = S().outbox.find(o => !o.failed)
      if (!item) break
      try {
        const msg = await sendMessageREST(item.channelId, item.content, 'text', undefined, item.opts)
        if (item.channelId === S().selectedChannelId && !S().messages.find(m => m.id === msg.id)) {
          set({ messages: [...S().messages, msg] })
        }
      } catch (e: any) {
        const status = e?.response?.status || e?.statusCode
        if (status && status >= 400 && status < 500) {
          // 채널에서 나갔거나 권한이 없어진 것 — 그 줄에 "보내지 못했습니다"로 남긴다(다시 보내기 · 삭제는 사용자가)
          set({ outbox: S().outbox.map(o => (o.localId === item.localId ? { ...o, failed: true } : o)) })
          saveOutbox()
          continue
        } else {
          break   // 아직 네트워크가 안 됨 — 다음 연결 때
        }
      }
      set({ outbox: S().outbox.filter(o => o.localId !== item.localId) })
      saveOutbox()
    }
  } finally {
    _flushingOutbox = false
  }
}

// ─── 알림 권한(R-25) — 첫 메시지를 보낸 뒤에야 묻는다(배너, 사용자가 누를 때만 브라우저 프롬프트) ───

function afterFirstSend() {
  if (!('Notification' in window)) return
  if (Notification.permission !== 'default') return
  try {
    const until = Number(localStorage.getItem('jw-notify-banner-snooze') || 0)
    if (until > Date.now()) return
  } catch { /* noop */ }
  set({ showNotifyBanner: true })
}
export async function acceptNotifyBanner() {
  set({ showNotifyBanner: false })
  await requestBrowserPermission()
}
export function snoozeNotifyBanner() {
  set({ showNotifyBanner: false })
  try { localStorage.setItem('jw-notify-banner-snooze', String(Date.now() + 7 * 24 * 3600_000)) } catch { /* noop */ }
}

export function sendTyping() {
  const channelId = S().selectedChannelId
  if (!channelId) return
  if (_typingThrottleTimer) return
  if (_ws?.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify({
      type: 'typing',
      channel_id: channelId,
    }))
    _typingThrottleTimer = setTimeout(() => {
      _typingThrottleTimer = null
    }, 2000)
  }
}

function markRead(channelId: string, messageId: string) {
  patchChannel(channelId, c => ({ ...c, unread_count: 0, mention_count: 0, group_mention: false }))
  if (_ws?.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify({
      type: 'mark_read',
      channel_id: channelId,
      message_id: messageId,
    }))
  } else {
    _pendingRead = { channelId, messageId }   // 연결되면 보낸다
  }
}

/** 지금 이 채널의 맨 아래를 사람이 보고 있나 — 창이 보이고, 포커스가 있고, 맨 아래까지 내려와 있다. */
function canSeeLatest(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus() && S().viewAtBottom
}

/** 볼 수 있을 때만 읽음. 아니면 미뤄 두고, 보이게 되는 순간(flushPendingRead) 보낸다. */
function requestRead(channelId: string, messageId: string) {
  if (canSeeLatest()) {
    _pendingRead = null
    markRead(channelId, messageId)
    return
  }
  _pendingRead = { channelId, messageId }
  // 열어 둔 채널이어도 못 보고 있으면 미읽음으로 센다(탭 제목·레일 숫자가 맞게)
  if (channelId === S().selectedChannelId) patchChannel(channelId, c => ({ ...c, unread_count: (c.unread_count || 0) + 1 }))
}

function flushPendingRead() {
  if (!_pendingRead || !canSeeLatest()) return
  if (_pendingRead.channelId !== S().selectedChannelId) { _pendingRead = null; return }
  const { channelId, messageId } = _pendingRead
  _pendingRead = null
  markRead(channelId, messageId)
}

/** ChatMessageList 가 스크롤할 때 알려 준다. 맨 아래에 닿으면 미뤄 둔 읽음을 보낸다. */
export function setViewAtBottom(atBottom: boolean) {
  set({ viewAtBottom: atBottom })
  if (atBottom) {
    set({ newBelowCount: 0 })
    flushPendingRead()
  }
}

function hookVisibility() {
  if (_visibilityHooked) return
  _visibilityHooked = true
  document.addEventListener('visibilitychange', flushPendingRead)
  window.addEventListener('focus', flushPendingRead)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') probeConnection() })
  window.addEventListener('online', probeConnection)
}

/**
 * 절전 복귀·와이파이 전환 직후엔 소켓이 OPEN 으로 보여도 실제로는 죽어 있을 수 있다. 그 상태로 보낸 글은 조용히 사라진다
 * (정기 핑은 90초 뒤에야 알아챈다). 돌아온 즉시 핑을 보내 5초 안에 답이 없으면 끊고 다시 붙는다.
 */
function probeConnection() {
  const ws = _ws
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  const sentAt = Date.now()
  try { ws.send(JSON.stringify({ type: 'ping' })) } catch { ws.close(); return }
  setTimeout(() => { if (ws === _ws && ws.readyState === WebSocket.OPEN && _lastPong < sentAt) ws.close() }, 5000)
}

/** 점프(handover-22): 원문 주변 창으로 목록을 바꾼다. hasMoreAfter = 아래(최근)에 더 있음 */
export function replaceMessagesWindow(list: ChatMessage[], hasMore: boolean, hasMoreAfter: boolean) {
  set({ messages: list, hasMoreMessages: hasMore, hasMoreAfter, newBelowCount: hasMoreAfter ? S().newBelowCount : 0 })
}
/** 점프한 창 아래로 이어 붙인다(겹치는 것은 뺀다). 다 따라잡으면 hasMoreAfter = false → 실시간 메시지가 다시 붙는다 */
export function appendMessagesAfter(list: ChatMessage[], hasMoreAfter: boolean) {
  const have = new Set(S().messages.map(m => m.id))
  set({ messages: [...S().messages, ...list.filter(m => !have.has(m.id))], hasMoreAfter })
  if (!hasMoreAfter) set({ newBelowCount: 0 })
}

export async function loadMore() {
  if (!S().hasMoreMessages || S().loadingMore) return
  if (S().messages.length === 0) return
  const oldest = S().messages[0]
  await fetchMessages(oldest.id)
}

/** DM 표시 이름. (hook 의 getDMDisplayName 은 렌더 시점 allUsers 로 구독한다) */
export function getDMDisplayName(channel: Channel, s: ChatState = S()): string {
  const user = me()
  if (!user) return channel.name
  const names = channel.name.split(',')
  const otherUsername = names.find(n => n !== user.username) || channel.name
  // Look up display_name from allUsers
  const otherUser = s.allUsers.find(u => u.username === otherUsername)
  return otherUser?.display_name || otherUsername
}

// ─── Init ───

/** 앱 전체 실시간 연결 시작(Vue useChat().init()). 이미 시작했으면 아무것도 안 한다. */
export async function initChat() {
  if (_initialized) return
  _initialized = true
  hookVisibility()
  loadOutbox()
  ensurePushSubscription()
  await Promise.all([
    fetchChannels(), fetchPresence(), fetchAllUsers(), fetchNotifications(), fetchCallStates(), fetchVoiceStates(),
    fetchMyStatus(), fetchThreadUnreadCount(), fetchDrafts(), fetchSaved(),
    $fetch<{ seq: number }>('/api/chat/latest-seq').then(r => { _lastSeq = Math.max(_lastSeq, r.seq || 0) }).catch(() => {}),
  ])
  connectWS()
  void migrateLocalDrafts()   // 채널 목록·서버 임시글을 받은 뒤에(멤버 아닌 채널은 403, 서버본 우선)
}

/** 연결 끊고 사용자별 상태 비우기(Vue useChat().cleanup()) — 로그아웃 직전에 useAuth 가 부른다 */
export function cleanupChat() {
  _initialized = false
  _lastSeq = 0
  disconnectWS()
  for (const t of _draftTimers.values()) clearTimeout(t)
  _draftTimers.clear()
  _draftPending.clear()
  _threadsLoaded = false
  _draftsMigrated = false
  _savedLoaded = false
  _outboxLoaded = false
  _everConnected = false
  _pendingRead = null
  _seenMsgIds.clear()
  set({
    outbox: [],
    channels: [],
    selectedChannelId: null,
    messages: [],
    members: [],
    threadMessages: [],
    threadParent: null,
    activeThreadId: null,
    myStatus: null,
    presences: {},
    drafts: {},
    threads: [],
    pins: [],
    savedMessages: [],
    threadUnread: { threads: 0, replies: 0 },
  })
}

// Vue 판 useAuth().logout 이 부르던 useChat().cleanup() — 다음 사용자에게 이전 사용자의 이벤트가 가지 않게
onBeforeLogout(cleanupChat)

export function useChat() {
  const { state: s, track } = useTrackedStore(chatStore)
  return {
    // State (읽기 전용 — 바꾸는 건 아래 함수·setter 로)
    get channels() { return track('channels') },
    get channelsError() { return track('channelsError') },
    get selectedChannelId() { return track('selectedChannelId') },
    get messages() { return track('messages') },
    get members() { return track('members') },
    get loadingChannels() { return track('loadingChannels') },
    get loadingMessages() { return track('loadingMessages') },
    get hasMoreMessages() { return track('hasMoreMessages') },
    get loadingMore() { return track('loadingMore') },
    get wsConnected() { return track('wsConnected') },
    get onlineUsers() { return track('onlineUsers') },
    get typingUsers() { return track('typingUsers') },
    get showMemberPanel() { return track('showMemberPanel') },
    setShowMemberPanel,
    get allUsers() { return track('allUsers') },
    get callStates() { return track('callStates') },
    get voiceStates() { return track('voiceStates') },
    get newBelowCount() { return track('newBelowCount') },
    get disconnectedAt() { return track('disconnectedAt') },
    get reconnectAt() { return track('reconnectAt') },
    get outbox() { return track('outbox') },
    get showNotifyBanner() { return track('showNotifyBanner') },
    setShowNotifyBanner,
    // Thread state
    get activeThreadId() { return track('activeThreadId') },
    get threadMessages() { return track('threadMessages') },
    ingestThreadReply,
    get threadParent() { return track('threadParent') },
    get loadingThread() { return track('loadingThread') },
    get activeThreadState() { return track('activeThreadState') },
    get threads() { return track('threads') },
    get loadingThreads() { return track('loadingThreads') },
    get threadUnread() { return track('threadUnread') },
    // Presence · my status
    get presences() { return track('presences') },
    get myStatus() { return track('myStatus') },
    // Pins
    get pins() { return track('pins') },
    get loadingPins() { return track('loadingPins') },
    get showPinsPanel() { return track('showPinsPanel') },
    setShowPinsPanel,
    // Saved
    get savedMessages() { return track('savedMessages') },
    get loadingSaved() { return track('loadingSaved') },
    // Drafts
    get drafts() { return track('drafts') },
    get selectedChannelDraft() { track('selectedChannelId'); track('drafts'); return selectSelectedChannelDraft(s) },
    get activeThreadDraft() { track('selectedChannelId'); track('activeThreadId'); track('drafts'); return selectActiveThreadDraft(s) },
    // Search state
    get searchQuery() { return track('searchQuery') },
    setSearchQuery,
    get searchResults() { return track('searchResults') },
    get searchLoading() { return track('searchLoading') },
    get showSearchPanel() { return track('showSearchPanel') },
    setShowSearchPanel,
    // Computed
    get selectedChannel() { track('channels'); track('selectedChannelId'); return selectSelectedChannel(s) },
    get sortedChannels() { track('channels'); return selectSortedChannels(s) },
    get totalUnread() { track('channels'); return selectUnreadSummary(s).totalUnread },
    get totalMentions() { track('channels'); return selectUnreadSummary(s).totalMentions },
    get unreadSummary() { track('channels'); return selectUnreadSummary(s) },
    isChannelBold,
    // Actions
    init: initChat,
    cleanup: cleanupChat,
    fetchChannels,
    fetchAllUsers,
    selectChannel,
    deselectChannel,
    fetchMessages,
    fetchMembers,
    createChannel,
    addMembers,
    leaveChannel,
    openDM,
    searchUsers,
    sendMessage,
    sendTyping,
    editMessage,
    deleteMessage,
    loadMore,
    /** DM 표시 이름 — 렌더 중 호출하면 allUsers 를 구독한다 */
    getDMDisplayName: (channel: Channel) => { track('allUsers'); return getDMDisplayName(channel, s) },
    connectWS,
    retryNow,
    setViewAtBottom,
    discardOutbox,
    acceptNotifyBanner,
    snoozeNotifyBanner,
    disconnectWS,
    // Thread actions
    openThread,
    closeThread,
    fetchThreadReplies,
    sendThreadReply,
    followThread,
    unfollowThread,
    toggleThreadFollow,
    markThreadRead,
    fetchThreads,
    fetchThreadUnreadCount,
    // Unread · channel prefs
    markUnread,
    updateChannelPrefs,
    fetchChannelPrefs,
    setNotifyLevel,
    toggleMute,
    // Presence · my status
    fetchPresence,
    /** 사용자 실효 상태 — 렌더 중 호출하면 presences·onlineUsers 를 구독한다 */
    presenceOf: (userId: string) => { track('presences'); track('onlineUsers'); return presenceOf(userId, s) },
    fetchMyStatus,
    updateMyStatus,
    setStatusMode,
    setCustomStatus,
    clearCustomStatus,
    // Pins
    fetchPins,
    pinMessage,
    unpinMessage,
    togglePin,
    // Saved
    fetchSaved,
    /** 저장 여부 — 렌더 중 호출하면 관련 목록을 구독한다 */
    isSaved: (messageId: string) => {
      track('savedOverride'); track('savedMessages'); track('messages'); track('threadMessages'); track('threadParent'); track('pins')
      return isSaved(messageId, s)
    },
    saveMessage,
    unsaveMessage,
    toggleSave,
    // Drafts
    fetchDrafts,
    /** 임시글 본문 — 렌더 중 호출하면 drafts 를 구독한다(아직 PUT 안 된 입력값이 먼저) */
    draftFor: (channelId: string, parentId?: string | null) => { track('drafts'); return draftFor(channelId, parentId) },
    setDraft,
    flushDraft,
    clearDraft,
    // Reaction actions
    toggleReaction,
    // Search actions
    searchMessages,
  }
}
