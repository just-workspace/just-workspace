/**
 * 채팅 백엔드 API — 얇은 fetch 함수와 응답 타입(한 곳).
 * 계약: 답장·점프·스레드(혼합형)·커스텀 이모지·검색(오른쪽 자리)·음소거 기간·프로필 팝아웃·포럼·여러 첨부.
 * 역할·권한·카테고리는 useChatRoles.ts · useChatLayout.ts 가 부른다.
 * 상태(zustand)는 각 화면의 composable 이 갖는다 — 여기는 네트워크만.
 */
import { $fetch } from '~/lib/api'
import type { ChatMessage, MessageSender, ThreadMeta, ThreadParticipant } from '~/composables/useChat'

const B = '/api/chat'

// ─── 점프(원문으로) ───
export interface AroundPage { messages: ChatMessage[]; has_more: boolean; has_more_after: boolean; thread_root_id?: string | null }
/** 원문 위치를 중심으로 위아래 반씩(원문 포함). 스레드 안 원문이면 messages 는 비고 thread_root_id */
export function fetchMessagesAround(channelId: string, messageId: string, limit = 50) {
  return $fetch<AroundPage>(`${B}/channels/${channelId}/messages`, { query: { around: messageId, limit } })
}
/** 점프한 곳에서 아래(최근) 방향 페이지 */
export function fetchMessagesAfter(channelId: string, afterSeq: number, limit = 50) {
  return $fetch<AroundPage>(`${B}/channels/${channelId}/messages`, { query: { after_seq: afterSeq, limit } })
}

// ─── 보내기(REST — 소켓 경로는 useChat.sendMessage) ───
export interface SendExtra {
  reply_to_id?: string | null
  reply_ping?: boolean
  silent?: boolean
  parent_id?: string | null
  also_to_channel?: boolean
}
export function postMessage(channelId: string, content: string, extra: SendExtra = {}) {
  return $fetch<ChatMessage>(`${B}/channels/${channelId}/messages`, { method: 'POST', body: { content, ...extra } })
}

/** 여러 첨부를 메시지 하나로(최대 10). spoilers = 스포일러로 가릴 파일 인덱스, alts = 인덱스별 대체 텍스트 */
export interface AttachmentUpload { file: File; spoiler?: boolean; alt?: string | null }
export function postAttachments(
  channelId: string,
  items: AttachmentUpload[],
  opts: SendExtra & { content?: string; onProgress?: (ratio: number) => void; signal?: AbortSignal } = {},
): Promise<ChatMessage> {
  const fd = new FormData()
  items.forEach(it => fd.append('files', it.file, it.file.name))
  const spoilers = items.map((it, i) => (it.spoiler ? i : -1)).filter(i => i >= 0)
  if (spoilers.length) fd.append('spoilers', spoilers.join(','))
  if (items.some(it => it.alt)) fd.append('alts', JSON.stringify(items.map(it => it.alt || null)))
  if (opts.content) fd.append('content', opts.content)
  for (const k of ['reply_to_id', 'parent_id'] as const) if (opts[k]) fd.append(k, String(opts[k]))
  for (const k of ['reply_ping', 'silent', 'also_to_channel'] as const) if (opts[k] != null) fd.append(k, String(!!opts[k]))
  // 진행 막대가 필요해 XHR(ofetch 는 업로드 진행을 주지 않는다). 같은 출처 쿠키 세션.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${B}/channels/${channelId}/attachments`)
    xhr.withCredentials = true
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total) }
    xhr.onload = () => {
      let body: unknown = null
      try { body = JSON.parse(xhr.responseText) } catch { /* 본문 없음 */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as ChatMessage)
      else reject(Object.assign(new Error(`upload ${xhr.status}`), { status: xhr.status, data: body }))
    }
    xhr.onerror = () => reject(Object.assign(new Error('network'), { status: 0 }))
    opts.signal?.addEventListener('abort', () => xhr.abort())
    xhr.send(fd)
  })
}

// ─── 스레드(혼합형) ───
export const THREAD_AUTO_ARCHIVE = [60, 1440, 4320, 10080] as const
export type ThreadAutoArchive = typeof THREAD_AUTO_ARCHIVE[number]
export interface ThreadListItem {
  root: ChatMessage
  thread: ThreadMeta
  last_reply: { sender: MessageSender | null; content: string; created_at: string } | null
  participants: ThreadParticipant[]
  unread: boolean
  followed: boolean
}
export interface ThreadListPage { items: ThreadListItem[]; has_more: boolean; default_auto_archive_minutes: number }
export function fetchChannelThreads(channelId: string, archived = false, before?: string, limit = 25) {
  return $fetch<ThreadListPage>(`${B}/channels/${channelId}/threads`, { query: { archived, limit, ...(before ? { before } : {}) } })
}
export function startThread(messageId: string, name?: string | null) {
  return $fetch<ThreadMeta>(`${B}/messages/${messageId}/thread`, { method: 'POST', body: { name: name || null } })
}
export function updateThread(messageId: string, patch: { name?: string | null; archived?: boolean; auto_archive_minutes?: ThreadAutoArchive }) {
  return $fetch<ThreadMeta>(`${B}/messages/${messageId}/thread`, { method: 'PATCH', body: patch })
}
export function setChannelThreadAutoArchive(channelId: string, minutes: ThreadAutoArchive) {
  return $fetch(`${B}/channels/${channelId}`, { method: 'PATCH', body: { default_thread_auto_archive_minutes: minutes } })
}

// ─── 커스텀 이모지 ───
export interface CustomEmoji {
  id: string
  name: string
  url: string
  animated: boolean
  created_by: { id: string; display_name: string | null; username: string } | null
  created_at: string
}
export interface CustomEmojiList { items: CustomEmoji[]; can_manage: boolean; limit: number }
export const EMOJI_NAME_RE = /^[a-z0-9_]{2,32}$/
export const EMOJI_MAX_BYTES = 256 * 1024
export type EmojiErrorCode = 'name_invalid' | 'name_taken' | 'too_large' | 'bad_type' | 'limit_reached' | 'forbidden'
export function fetchCustomEmojis() { return $fetch<CustomEmojiList>(`${B}/emojis`) }
export function uploadCustomEmoji(file: File, name: string) {
  const fd = new FormData()
  fd.append('file', file, file.name)
  fd.append('name', name)
  return $fetch<CustomEmoji>(`${B}/emojis`, { method: 'POST', body: fd })
}
export function renameCustomEmoji(id: string, name: string) {
  return $fetch<CustomEmoji>(`${B}/emojis/${id}`, { method: 'PATCH', body: { name } })
}
export function deleteCustomEmoji(id: string) { return $fetch(`${B}/emojis/${id}`, { method: 'DELETE' }) }
/** 서버 오류 → 이모지 오류 코드(detail.code). 모르면 null */
export function emojiErrorCode(e: unknown): EmojiErrorCode | null {
  const d = (e as { data?: { detail?: unknown } })?.data?.detail
  const code = d && typeof d === 'object' ? (d as { code?: string }).code : undefined
  return (code as EmojiErrorCode) || null
}

// ─── 검색(오른쪽 자리) ───
export type SearchHas = 'link' | 'file' | 'image' | 'video' | 'sound' | 'embed'
export interface SearchParams {
  q?: string
  from?: string
  mentions?: string
  in?: string
  has?: SearchHas[]
  before?: string
  after?: string
  during?: string
  pinned?: boolean
  sort?: 'new' | 'old'
  offset?: number
  limit?: number
}
export type SearchHit = ChatMessage & { channel_name: string; channel_type: string }
export interface SearchPage { items: SearchHit[]; total: number; offset: number; limit: number }
export const SEARCH_PAGE = 25
export function searchChat(p: SearchParams) {
  const query: Record<string, string | number | boolean> = { limit: p.limit ?? SEARCH_PAGE, offset: p.offset ?? 0, sort: p.sort ?? 'new' }
  for (const k of ['q', 'from', 'mentions', 'in', 'before', 'after', 'during'] as const) if (p[k]) query[k] = p[k] as string
  if (p.has?.length) query.has = p.has.join(',')
  if (p.pinned) query.pinned = true
  return $fetch<SearchPage>(`${B}/search`, { query })
}

// ─── 음소거 기간 ───
/** 채널 우클릭 "알림 끄기 ›" 6개 — 15분 · 1시간 · 3시간 · 8시간 · 24시간 · 내가 끌 때까지(null) */
export const MUTE_DURATIONS = [15, 60, 180, 480, 1440, null] as const
export function muteChannelFor(channelId: string, minutes: number | null) {
  return $fetch<{ muted: boolean; muted_until: string | null }>(`${B}/channels/${channelId}/prefs`, {
    method: 'PATCH', body: { muted: true, muted_minutes: minutes },
  })
}

// ─── 프로필 팝아웃 ───
export interface ChatProfile {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  job_title: string | null
  department: string | null
  bio: string | null
  /** IANA. 없으면 현지 시각 줄을 숨긴다 */
  timezone: string | null
  presence: { state?: string; emoji?: string | null; text?: string | null } | null
  custom_status: { emoji: string | null; text: string | null } | null
  is_me: boolean
}
export function fetchChatProfile(userId: string) { return $fetch<ChatProfile>(`${B}/users/${userId}/profile`) }
export function updateMyChatProfile(patch: { bio?: string | null; timezone?: string | null }) {
  return $fetch<ChatProfile>(`${B}/me/profile`, { method: 'PATCH', body: patch })
}

// ─── 포럼 ───
export function createForumChannel(name: string, type: 'public' | 'private', opts: { description?: string; board_id?: string; member_ids?: string[] } = {}) {
  return $fetch(`${B}/channels`, { method: 'POST', body: { name, type, forum: true, ...opts } })
}

// ─── 채팅 서버 설정(개요 · 알림 기본값) ───
export type ChatNotifyLevel = 'all' | 'mentions' | 'none'
export interface ChatServerSettings {
  /** 채팅 이름(사이드바 머리). 비면 사이트 이름 */
  name: string | null
  description: string | null
  /** 새 멤버·새 채널의 알림 기본값 */
  default_notify_level: ChatNotifyLevel
  can_edit: boolean
}
export function fetchServerSettings() { return $fetch<ChatServerSettings>(`${B}/server-settings`) }
export function updateServerSettings(patch: Partial<Omit<ChatServerSettings, 'can_edit'>>) {
  return $fetch<ChatServerSettings>(`${B}/server-settings`, { method: 'PUT', body: patch })
}
