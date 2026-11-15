/**
 * 채팅 상태 리듀서 — 프레임워크에 의존하지 않는 순수 함수와 타입.
 *
 * useChat.ts 가 REST 응답·WS 이벤트를 상태에 반영할 때 여기 함수를 부른다.
 * 분리한 이유는 하나다: vitest 에서 앱 런타임 없이 바로 검증하기 위해(tests/lib/chatEvents.test.ts).
 * 전부 입력을 바꾸지 않고 새 값을 돌려준다. 바꿀 게 없으면 입력을 그대로(같은 참조) 돌려주므로
 * 호출 쪽은 `===` 로 "변화 없음" 을 알 수 있다(발신 기기로 되돌아온 draft_update 등).
 *
 * 백엔드 스펙: backend/app/chat/router.py · service.py · presence.py · notify.py
 */

// ─── 프레즌스 ───

/** 남에게 보이는 실효 상태. invisible 은 offline 으로 보인다(presence.effective_state). */
export type PresenceState = 'online' | 'away' | 'dnd' | 'offline'
/** 내가 고르는 모드(PUT /api/chat/me/status). */
export type StatusMode = 'auto' | 'away' | 'dnd' | 'invisible'

export interface UserPresence {
  state: PresenceState
  emoji: string | null
  text: string | null
}

/** GET/PUT /api/chat/me/status 응답 — 저장된 설정 + 지금의 실효 상태. */
export interface MyStatus {
  mode: StatusMode
  custom_emoji: string | null
  custom_text: string | null
  custom_expires_at: string | null
  dnd_until: string | null
  state: PresenceState
}
/** PUT 바디 — 보낸 필드만 바뀐다. null 을 명시하면 비운다. */
export type MyStatusUpdate = Partial<Omit<MyStatus, 'state'>>

export interface PresenceSnapshot {
  online_user_ids: string[]
  statuses?: Record<string, UserPresence>
}

/** WS presence — `status` 는 예전 두 값(online|offline), `state` 가 네 가지 실효 상태. */
export interface PresenceEvent {
  user_id: string
  username?: string | null
  status?: 'online' | 'offline'
  state?: PresenceState
  emoji?: string | null
  text?: string | null
}

export const OFFLINE: UserPresence = { state: 'offline', emoji: null, text: null }

/** 구서버(state 없음)와 신서버 이벤트를 같은 모양으로. */
export function presenceFromEvent(evt: PresenceEvent): UserPresence {
  const state: PresenceState = evt.state ?? (evt.status === 'online' ? 'online' : 'offline')
  return { state, emoji: evt.emoji ?? null, text: evt.text ?? null }
}

export function applyPresence(
  presences: Record<string, UserPresence>, evt: PresenceEvent,
): Record<string, UserPresence> {
  const next = presenceFromEvent(evt)
  const cur = presences[evt.user_id]
  if (cur && cur.state === next.state && cur.emoji === next.emoji && cur.text === next.text) return presences
  return { ...presences, [evt.user_id]: next }
}

/** GET /api/chat/presence 응답 → presences 맵 + 온라인 집합(구필드 online_user_ids 와 일치시킨다). */
export function presencesFromSnapshot(snap: PresenceSnapshot): { presences: Record<string, UserPresence>; online: Set<string> } {
  const presences: Record<string, UserPresence> = {}
  for (const [uid, p] of Object.entries(snap.statuses || {})) {
    presences[uid] = { state: p.state, emoji: p.emoji ?? null, text: p.text ?? null }
  }
  const online = new Set<string>(snap.online_user_ids || [])
  // statuses 가 없는 구서버 — 온라인 목록만으로 채운다
  for (const uid of online) if (!presences[uid]) presences[uid] = { state: 'online', emoji: null, text: null }
  return { presences, online }
}

// ─── 채널 알림 설정 · 안 읽음 ───

export type NotifyLevel = 'all' | 'mentions' | 'none'

export interface ChannelPrefs {
  channel_id: string
  notify_level: NotifyLevel
  muted: boolean
  /** 기기 알림 세부(GET/PATCH /channels/{id}/prefs). false = 그 경로로는 알리지 않음, true = 위 설정 따름 */
  desktop?: boolean
  push?: boolean
  /** 저장만 된다(이메일 발송은 아직 없음) */
  email?: boolean
  /** 따라가는 스레드의 새 답글 알림 */
  thread_replies?: boolean
}

export type ChannelDevicePrefs = Pick<ChannelPrefs, 'desktop' | 'push' | 'email' | 'thread_replies'>

/** 리듀서가 건드리는 채널 필드만. useChat 의 Channel 이 이걸 만족한다. */
export interface ChannelLike {
  id: string
  type: string
  unread_count: number
  mention_count?: number
  group_mention?: boolean
  last_read_seq?: number | null
  notify_level?: NotifyLevel
  muted?: boolean
}

export interface ChannelUnreadEvent {
  channel_id: string
  seq: number
  unread_count: number
  mention_count: number
  group_mention: boolean
}

/** POST /channels/{id}/unread 응답 · WS channel_unread — 되감은 포인터와 다시 센 배지를 그대로 받는다. */
export function applyChannelUnread<C extends ChannelLike>(channels: C[], evt: ChannelUnreadEvent): C[] {
  let changed = false
  const out = channels.map((c) => {
    if (c.id !== evt.channel_id) return c
    changed = true
    return {
      ...c,
      unread_count: evt.unread_count,
      mention_count: evt.mention_count,
      group_mention: !!evt.group_mention,
      last_read_seq: evt.seq,
    }
  })
  return changed ? out : channels
}

/** PATCH /channels/{id}/prefs 응답 · WS channel_prefs. */
export function applyChannelPrefs<C extends ChannelLike>(channels: C[], evt: ChannelPrefs): C[] {
  let changed = false
  const out = channels.map((c) => {
    if (c.id !== evt.channel_id) return c
    if (c.notify_level === evt.notify_level && !!c.muted === !!evt.muted) return c
    changed = true
    return { ...c, notify_level: evt.notify_level, muted: !!evt.muted }
  })
  return changed ? out : channels
}

/**
 * 뮤트 규칙(백엔드 notify.py 와 같은 선): 뮤트는 "굵게(미읽음)" 표시에서만 빠지고 멘션 숫자는 그대로다.
 * DM 의 미읽음은 멘션처럼 세지만(나를 부른 것), 그 DM 을 뮤트했으면 세지 않는다 — 뮤트 DM 은 푸시도 안 가므로.
 */
export function isChannelBold(c: ChannelLike): boolean {
  return !c.muted && (c.unread_count || 0) > 0
}

export function channelMentionCount(c: ChannelLike): number {
  if (c.type === 'dm') return c.muted ? 0 : (c.unread_count || 0)
  return c.mention_count || 0
}

export interface UnreadSummary {
  /** 굵게 표시되는(뮤트 아닌) 채널의 미읽음 합 */
  totalUnread: number
  /** 레일·탭바 숫자 — 멘션 + 뮤트 아닌 DM 미읽음 */
  totalMentions: number
  /** 굵게 표시할 채널 id */
  boldChannelIds: string[]
}

export function summarizeUnread(channels: ChannelLike[]): UnreadSummary {
  let totalUnread = 0
  let totalMentions = 0
  const boldChannelIds: string[] = []
  for (const c of channels) {
    if (isChannelBold(c)) { totalUnread += c.unread_count; boldChannelIds.push(c.id) }
    totalMentions += channelMentionCount(c)
  }
  return { totalUnread, totalMentions, boldChannelIds }
}

// ─── 메시지 ───

export interface MessageLike {
  id: string
  channel_id: string
  parent_id: string | null
  thread_broadcast?: boolean
  pinned_at?: string | null
  pinned_by?: string | null
  seq?: number
}

/** 메인 타임라인에 보이는가 — 원 메시지, 또는 "채널에도 보내기" 한 답글(service.main_timeline_filter). */
export function isMainTimelineMessage(msg: MessageLike): boolean {
  return !msg.parent_id || !!msg.thread_broadcast
}

/** 스레드 참여자 한 명(메시지 thread_participants 항목) */
export interface ThreadParticipantLike {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
}

/**
 * 새 답글이 왔을 때 원 메시지의 스레드 요약(답글 수·마지막 답글 시각·참여자 아바타)을 갱신한다.
 * 참여자는 서버(get_thread_meta)와 같은 선 — 최근 답글 순, 중복 없이 최대 5명.
 */
export function bumpThreadMeta<M extends { reply_count: number; last_reply_at?: string | null; thread_participants?: ThreadParticipantLike[] }>(
  root: M,
  reply: { created_at: string; sender: ThreadParticipantLike | null },
): M {
  const prev = root.thread_participants || []
  const s = reply.sender
  const parts = s
    ? [{ id: s.id, username: s.username, display_name: s.display_name, avatar_url: s.avatar_url }, ...prev.filter(p => p.id !== s.id)].slice(0, 5)
    : prev
  return { ...root, reply_count: (root.reply_count || 0) + 1, last_reply_at: reply.created_at, thread_participants: parts }
}

/**
 * WS message_update(핀·편집) — 같은 id 를 통째로 갈아 끼운다. 목록에 없으면 그대로.
 * 서버 dict 에 없는 필드(reactions·read_by·reply_count)는 기존 값을 지킨다.
 */
export function replaceMessage<M extends { id: string }>(list: M[], message: Partial<M> & { id: string }): M[] {
  let changed = false
  const out = list.map((m) => {
    if (m.id !== message.id) return m
    changed = true
    const merged: M = { ...m }
    for (const [k, v] of Object.entries(message)) {
      if (v !== undefined) (merged as Record<string, unknown>)[k] = v
    }
    return merged
  })
  return changed ? out : list
}

/** 핀 목록에 message_update 를 반영 — 핀이 풀리면 빼고, 이 채널의 새 핀이면 맨 앞에 넣는다. */
export function applyPinUpdate<M extends MessageLike>(pins: M[], message: M, channelId: string | null): M[] {
  const has = pins.some(p => p.id === message.id)
  if (!message.pinned_at) return has ? pins.filter(p => p.id !== message.id) : pins
  if (has) return replaceMessage(pins, message)
  if (channelId && message.channel_id !== channelId) return pins
  return [message, ...pins]
}

// ─── 스레드 ───

export interface ThreadLastReply {
  id: string
  seq: number
  sender_id: string | null
  sender_name: string
  content: string
  created_at: string
}

/** GET /api/chat/threads 항목 — 팔로우 중인 스레드의 원 메시지 요약(service.get_my_threads). */
export interface ThreadSummary {
  id: string
  channel_id: string
  channel_name: string
  channel_type: string
  sender_id: string | null
  sender_name: string
  content: string
  created_at: string
  reply_count: number
  unread_replies: number
  followed: boolean
  last_read_seq: number | null
  last_reply: ThreadLastReply | null
}

export interface ThreadUnreadCount { threads: number; replies: number }

/** GET /messages/{id}/thread 가 replies 와 함께 주는 내 팔로우 상태. */
export interface ThreadFollowState {
  followed: boolean
  unread_replies: number
  last_read_seq: number | null
}

export interface ThreadReplyLike extends MessageLike {
  content: string
  created_at: string
  sender?: { id: string; username: string; display_name: string | null } | null
}

export interface ThreadUpdateEvent {
  root_id: string
  channel_id: string
  reply: ThreadReplyLike
  unread_replies: number
}
export interface ThreadReadEvent { root_id: string; seq: number }
export interface ThreadFollowEvent { root_id: string; channel_id: string; followed: boolean }

function sortThreads(list: ThreadSummary[]): ThreadSummary[] {
  return [...list].sort((a, b) => {
    const ka = a.last_reply?.created_at || a.created_at
    const kb = b.last_reply?.created_at || b.created_at
    return ka < kb ? 1 : ka > kb ? -1 : 0
  })
}

/**
 * WS thread_update — 목록에 있는 스레드면 답글 수·미읽음·마지막 답글을 갱신하고 맨 위로 올린다.
 * 목록에 없으면 그대로 돌려준다(호출 쪽이 목록을 다시 읽는다 — 자동 팔로우로 새로 생긴 스레드).
 */
export function applyThreadUpdate(threads: ThreadSummary[], evt: ThreadUpdateEvent): ThreadSummary[] {
  const idx = threads.findIndex(t => t.id === evt.root_id)
  if (idx < 0) return threads
  const t = threads[idx]
  const r = evt.reply
  const seen = t.last_reply?.id === r.id
  const next: ThreadSummary = {
    ...t,
    reply_count: seen ? t.reply_count : t.reply_count + 1,
    unread_replies: evt.unread_replies,
    last_reply: {
      id: r.id,
      seq: r.seq ?? t.last_reply?.seq ?? 0,
      sender_id: r.sender?.id ?? null,
      sender_name: r.sender?.display_name || r.sender?.username || '알 수 없음',
      content: r.content,
      created_at: r.created_at,
    },
  }
  const out = threads.slice()
  out[idx] = next
  return sortThreads(out)
}

/** WS thread_read · POST /threads/{id}/read — 포인터가 마지막 답글에 닿았으면 미읽음 0. */
export function applyThreadRead(threads: ThreadSummary[], evt: ThreadReadEvent): ThreadSummary[] {
  let changed = false
  const out = threads.map((t) => {
    if (t.id !== evt.root_id) return t
    if (t.last_read_seq !== null && t.last_read_seq >= evt.seq && t.unread_replies === 0) return t
    changed = true
    const caughtUp = !t.last_reply || t.last_reply.seq <= evt.seq
    return { ...t, last_read_seq: evt.seq, unread_replies: caughtUp ? 0 : t.unread_replies }
  })
  return changed ? out : threads
}

/** WS thread_follow — 끊으면 목록에서 빠진다. 켰는데 목록에 없으면 그대로(호출 쪽이 다시 읽는다). */
export function applyThreadFollow(threads: ThreadSummary[], evt: ThreadFollowEvent): ThreadSummary[] {
  const has = threads.some(t => t.id === evt.root_id)
  if (!evt.followed) return has ? threads.filter(t => t.id !== evt.root_id) : threads
  if (!has) return threads
  return threads.map(t => (t.id === evt.root_id && !t.followed) ? { ...t, followed: true } : t)
}

/** 목록만으로 셸 배지를 다시 센다(목록을 다 받은 경우에만 정확하다). */
export function countThreadUnread(threads: ThreadSummary[]): ThreadUnreadCount {
  let n = 0, replies = 0
  for (const t of threads) if (t.unread_replies > 0) { n++; replies += t.unread_replies }
  return { threads: n, replies }
}

// ─── 임시글 ───

export interface ChatDraft {
  channel_id: string
  parent_id: string | null
  content: string
  updated_at: string | null
}

/** WS draft_update — content null 이면 삭제. */
export interface DraftUpdateEvent {
  channel_id: string
  parent_id: string | null
  content: string | null
  updated_at: string | null
}

/** 채널 입력창은 `채널id`, 스레드 입력창은 `채널id:루트id`. */
export function draftKey(channelId: string, parentId?: string | null): string {
  return parentId ? `${channelId}:${parentId}` : channelId
}

/**
 * draft_update 반영. 발신 기기도 같은 이벤트를 받으므로 내용이 이미 같으면 입력을 그대로 돌려준다
 * (같은 참조 → watcher 가 울리지 않아 타이핑 중인 입력창을 건드리지 않는다).
 * `localContent` 는 아직 서버에 안 보낸 이 기기의 입력값 — 그것과 같은 이벤트도 무시한다.
 */
export function applyDraftUpdate(
  drafts: Record<string, ChatDraft>, evt: DraftUpdateEvent, localContent?: string,
): Record<string, ChatDraft> {
  const key = draftKey(evt.channel_id, evt.parent_id)
  const cur = drafts[key]
  if (evt.content === null || evt.content === '') {
    if (!cur) return drafts
    if (localContent !== undefined && localContent === '') return drafts
    const { [key]: _gone, ...rest } = drafts
    return rest
  }
  if (cur?.content === evt.content) return drafts
  if (localContent !== undefined && localContent === evt.content) return drafts
  return {
    ...drafts,
    [key]: { channel_id: evt.channel_id, parent_id: evt.parent_id ?? null, content: evt.content, updated_at: evt.updated_at },
  }
}

export function draftsFromList(items: ChatDraft[]): Record<string, ChatDraft> {
  const out: Record<string, ChatDraft> = {}
  for (const d of items) out[draftKey(d.channel_id, d.parent_id)] = { ...d, parent_id: d.parent_id ?? null }
  return out
}

/** 예전 ChatInput 이 localStorage 에 남긴 `chat-draft-<채널id>` 항목을 읽어 온다(서버로 옮기기 위해). */
export function collectLocalDrafts(storage: Pick<Storage, 'length' | 'key' | 'getItem'>): Array<{ key: string; channelId: string; content: string }> {
  const out: Array<{ key: string; channelId: string; content: string }> = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (!key || !key.startsWith('chat-draft-')) continue
    const content = storage.getItem(key)
    if (!content || !content.trim()) continue
    out.push({ key, channelId: key.slice('chat-draft-'.length), content })
  }
  return out
}
