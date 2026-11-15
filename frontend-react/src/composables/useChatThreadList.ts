/**
 * 채널 스레드 목록.
 * GET /api/chat/channels/{id}/threads?archived= (chatApi22.fetchChannelThreads) — 정렬 = 최근 활동순(서버), 받은 뒤에도 같은 선으로 다시 줄 세운다.
 *
 * 실시간: useChat.onChatEvent 구독 —
 *   · new_message(parent_id 있음) · thread_update(root_id + reply) → 그 행의 마지막 답글·답글 수·시각·참여자 갱신, 맨 위로.
 *     보관 탭에 있던 행은 빼고(서버: 보관된 스레드에 답글 = 보관 해제), 활성 탭에 없는 스레드면 다시 읽는다(디바운스).
 *   · thread_follow → 팔로우 bell.
 * 이름 없는 스레드: 원문 첫 40자를 따옴표 안 기울임 — threadTitle().
 * 자동 보관: 1시간 · 24시간 · 3일 · 1주(THREAD_AUTO_ARCHIVE 분) → PATCH /channels/{id} default_thread_auto_archive_minutes.
 */
import { createStore, useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { i18n } from '~/i18n'
import { authStore } from '~/composables/useAuth'
import {
  fetchChannelThreads, setChannelThreadAutoArchive, updateThread, THREAD_AUTO_ARCHIVE,
  type ThreadAutoArchive, type ThreadListItem,
} from '~/composables/chatApi22'
import { followThread, onChatEvent, unfollowThread, type ChatMessage, type ThreadMeta } from '~/composables/useChat'

export type ThreadTab = 'active' | 'archived'

/** 자동 보관 옵션(분 → 라벨 키) */
export const AUTO_ARCHIVE_LABEL: Record<ThreadAutoArchive, string> = { 60: 'h1', 1440: 'h24', 4320: 'd3', 10080: 'w1' }
export const DEFAULT_AUTO_ARCHIVE: ThreadAutoArchive = 4320

/** 이름 없는 스레드 제목에 쓰는 원문 길이 */
export const UNNAMED_CHARS = 40

/** 마크다운 기호를 걷어 한 줄 요약으로(원문 첫 40자·마지막 답글 줄) */
export function plainLine(s: string | null | undefined): string {
  return (s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\|\|([^|]*)\|\|/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:#{1,3}|-#|>|[-*]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 스레드 제목. 이름이 있으면 그대로, 없으면 원문 첫 40자(코드 포인트 기준, 넘치면 …)를 “ ” 안에 — unnamed=true 면 기울임.
 * 원문이 비면(첨부만) 서버 display_name.
 */
export function threadTitle(meta: Pick<ThreadMeta, 'name' | 'display_name'> | null | undefined, root: Pick<ChatMessage, 'content'> | null | undefined): { text: string; unnamed: boolean } {
  const name = meta?.name?.trim()
  if (name) return { text: name, unnamed: false }
  const src = plainLine(root?.content) || plainLine(meta?.display_name)
  const cps = Array.from(src)
  const cut = cps.length > UNNAMED_CHARS ? cps.slice(0, UNNAMED_CHARS).join('').trimEnd() + '…' : src
  return { text: `“${cut}”`, unnamed: true }
}

/** 최근 활동 시각(마지막 답글 → 없으면 원문) */
export function lastActivity(it: ThreadListItem): number {
  const iso = it.thread?.last_reply_at || it.last_reply?.created_at || it.root?.created_at
  const n = iso ? new Date(iso).getTime() : 0
  return Number.isNaN(n) ? 0 : n
}
/** 최근 활동순(같으면 원문 id 로 고정) */
export function sortThreads(items: ThreadListItem[]): ThreadListItem[] {
  return [...items].sort((a, b) => lastActivity(b) - lastActivity(a) || (a.root.id < b.root.id ? -1 : 1))
}
/** 보관됨으로 보이나 — 명시 보관 또는 (마지막 활동 + 자동 보관) 지남 */
export function isThreadArchived(it: ThreadListItem, now = Date.now()): boolean {
  if (it.thread?.archived) return true
  const mins = it.thread?.auto_archive_minutes
  if (!mins) return false
  const last = lastActivity(it)
  return !!last && last + mins * 60_000 <= now
}

/** "10분 전" · "1시간 전" · "어제" · "9월 18일" */
export function threadAgo(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const sec = Math.floor((now.getTime() - d.getTime()) / 1000)
  const t = i18n.t
  if (sec < 60) return t('date.justNow')
  if (sec < 3600) return t('common.minutesAgo', { n: Math.floor(sec / 60) })
  const y = new Date(now); y.setDate(y.getDate() - 1)
  if (sec < 86400 && d.toDateString() === now.toDateString()) return t('common.hoursAgo', { n: Math.floor(sec / 3600) })
  if (d.toDateString() === y.toDateString()) return t('common.yesterday')
  if (sec < 86400) return t('common.hoursAgo', { n: Math.floor(sec / 3600) })
  const lang = i18n.locale === 'en' ? 'en-US' : 'ko-KR'
  return d.toLocaleDateString(lang, d.getFullYear() === now.getFullYear() ? { month: 'long', day: 'numeric' } : { year: 'numeric', month: 'long', day: 'numeric' })
}

/** 서버 기본값 → 옵션 값(모르는 값이면 3일) */
export function normalizeAutoArchive(n: number | null | undefined): ThreadAutoArchive {
  return (THREAD_AUTO_ARCHIVE as readonly number[]).includes(n as number) ? n as ThreadAutoArchive : DEFAULT_AUTO_ARCHIVE
}

/** 답글 하나를 행에 반영(마지막 답글 · 수 · 시각 · 참여자 맨 앞) */
export function applyReply(it: ThreadListItem, reply: ChatMessage, myId: string | null | undefined): ThreadListItem {
  const s = reply.sender
  const participants = s
    ? [{ id: s.id, username: s.username, display_name: s.display_name, avatar_url: s.avatar_url }, ...(it.participants || []).filter(p => p.id !== s.id)].slice(0, 5)
    : it.participants || []
  return {
    ...it,
    thread: { ...it.thread, archived: false, reply_count: (it.thread?.reply_count ?? 0) + 1, last_reply_at: reply.created_at },
    last_reply: { sender: s, content: reply.content, created_at: reply.created_at },
    participants,
    unread: s && s.id === myId ? it.unread : true,
  }
}

interface ThreadListState {
  channelId: string | null
  tab: ThreadTab
  items: ThreadListItem[]
  hasMore: boolean
  loading: boolean
  loadingMore: boolean
  error: string | null
  /** 활성 탭 개수(세그먼트 "활성 N") — 활성 탭을 읽었을 때 정해진다 */
  activeCount: number | null
  autoArchive: ThreadAutoArchive
}
const initial = (): ThreadListState => ({
  channelId: null, tab: 'active', items: [], hasMore: false, loading: false, loadingMore: false, error: null, activeCount: null, autoArchive: DEFAULT_AUTO_ARCHIVE,
})
export const threadListStore = createStore<ThreadListState>()(() => initial())
const S = () => threadListStore.getState()
const set = (p: Partial<ThreadListState>) => threadListStore.setState(p)
export function _resetThreadList() { threadListStore.setState(initial()); _seq++ }

let _seq = 0
function errText(e: any): string {
  const d = e?.data?.detail
  return (typeof d === 'string' ? d : d?.message) || i18n.t('chat.right.threads.loadError')
}

/** 채널·탭 목록 읽기(처음부터) */
export async function loadThreads(channelId: string, tab: ThreadTab = S().channelId === channelId ? S().tab : 'active') {
  const my = ++_seq
  const sameCh = S().channelId === channelId
  set({ channelId, tab, loading: true, error: null, ...(sameCh ? {} : { items: [], activeCount: null }) })
  try {
    const page = await fetchChannelThreads(channelId, tab === 'archived')
    if (my !== _seq) return
    const items = sortThreads(Array.isArray(page?.items) ? page.items : [])
    set({
      items,
      hasMore: !!page?.has_more,
      autoArchive: normalizeAutoArchive(page?.default_auto_archive_minutes),
      ...(tab === 'active' ? { activeCount: items.length } : {}),
    })
  } catch (e) {
    if (my === _seq) set({ items: [], error: errText(e) })
  } finally {
    if (my === _seq) set({ loading: false })
  }
}

/** 더 보기(마지막 행 활동 시각 이전) */
export async function loadMoreThreads() {
  const { channelId, tab, items, hasMore, loadingMore } = S()
  if (!channelId || !hasMore || loadingMore || !items.length) return
  const my = _seq
  set({ loadingMore: true })
  try {
    const before = new Date(lastActivity(items[items.length - 1])).toISOString()
    const page = await fetchChannelThreads(channelId, tab === 'archived', before)
    if (my !== _seq) return
    const seen = new Set(items.map(i => i.root.id))
    const more = (page?.items || []).filter(i => !seen.has(i.root.id))
    const next = sortThreads([...S().items, ...more])
    set({ items: next, hasMore: !!page?.has_more, ...(tab === 'active' ? { activeCount: next.length } : {}) })
  } catch (e) {
    if (my === _seq) set({ error: errText(e) })
  } finally {
    set({ loadingMore: false })
  }
}

export function setThreadTab(tab: ThreadTab) {
  const ch = S().channelId
  if (!ch || S().tab === tab) return
  void loadThreads(ch, tab)
}

/** 자동 보관 기간 바꾸기(낙관적, 실패하면 되돌림) */
export async function changeAutoArchive(minutes: ThreadAutoArchive) {
  const ch = S().channelId
  if (!ch) return
  const prev = S().autoArchive
  set({ autoArchive: minutes })
  try { await setChannelThreadAutoArchive(ch, minutes) }
  catch (e) { set({ autoArchive: prev }); throw e }
}

function patchItem(rootId: string, fn: (it: ThreadListItem) => ThreadListItem) {
  set({ items: S().items.map(it => (it.root.id === rootId ? fn(it) : it)) })
}

/** 팔로우 토글(행 bell) — useChat.followThread/unfollowThread */
export async function toggleThreadRowFollow(rootId: string) {
  const it = S().items.find(i => i.root.id === rootId)
  if (!it) return
  const want = !it.followed
  patchItem(rootId, x => ({ ...x, followed: want }))
  try {
    const r = want ? await followThread(rootId) : await unfollowThread(rootId)
    patchItem(rootId, x => ({ ...x, followed: !!r?.followed }))
  } catch (e) {
    patchItem(rootId, x => ({ ...x, followed: !want }))
    throw e
  }
}

/** 스레드 메타가 바뀜(이름·보관 — 스레드 패널이 부른다). 보관 상태가 탭과 안 맞으면 뺀다 */
export function applyThreadMeta(rootId: string, meta: ThreadMeta) {
  const { tab } = S()
  const it = S().items.find(i => i.root.id === rootId)
  if (!it) {
    // 지금 탭에 들어가야 하는 스레드면 다시 읽는다
    if (S().channelId && (meta.archived ? tab === 'archived' : tab === 'active')) scheduleReload()
    return
  }
  if (!!meta.archived !== (tab === 'archived')) {
    const items = S().items.filter(i => i.root.id !== rootId)
    set({ items, ...(tab === 'active' ? { activeCount: items.length } : {}) })
  } else patchItem(rootId, x => ({ ...x, thread: { ...x.thread, ...meta } }))
}

/** 이름·보관 PATCH(목록에서도 반영) */
export async function patchThread(rootId: string, patch: { name?: string | null; archived?: boolean }) {
  const meta = await updateThread(rootId, patch)
  if (meta) applyThreadMeta(rootId, meta)
  return meta
}

let _reloadTimer: ReturnType<typeof setTimeout> | null = null
function scheduleReload() {
  if (_reloadTimer) clearTimeout(_reloadTimer)
  _reloadTimer = setTimeout(() => {
    _reloadTimer = null
    const { channelId, tab } = S()
    if (channelId) void loadThreads(channelId, tab)
  }, 400)
}

/** 소켓 이벤트 반영(테스트에서도 부른다) */
export function handleThreadListEvent(data: any) {
  const { channelId, tab, items } = S()
  if (!channelId || !data) return
  let reply: ChatMessage | null = null
  let rootId: string | null = null
  if (data.type === 'new_message' && data.message?.parent_id) { reply = data.message; rootId = data.message.parent_id }
  else if (data.type === 'thread_update' && data.root_id) { reply = data.reply || null; rootId = data.root_id }
  else if (data.type === 'thread_follow' && data.root_id) {
    if (items.some(i => i.root.id === data.root_id)) patchItem(data.root_id, x => ({ ...x, followed: !!data.followed }))
    return
  } else return
  const ch = reply?.channel_id || data.channel_id
  if (ch !== channelId || !rootId) return
  const row = items.find(i => i.root.id === rootId)
  if (!row) { if (tab === 'active') scheduleReload(); return }
  // 같은 답글이 두 이벤트(new_message · thread_update)로 올 수 있다 — 마지막 답글 시각이 같으면 한 번만
  if (reply && row.last_reply?.created_at === reply.created_at && row.last_reply?.content === reply.content) return
  if (tab === 'archived') {
    // 보관된 스레드에 답글 = 보관 해제 → 보관 탭에서 빠진다
    set({ items: items.filter(i => i.root.id !== rootId) })
    return
  }
  if (!reply) { scheduleReload(); return }
  const me = authStore.getState().user?.id
  set({ items: sortThreads(items.map(i => (i.root.id === rootId ? applyReply(i, reply!, me) : i))) })
}

let _unsub: (() => void) | null = null
/** 구독은 한 번만(목록을 처음 열 때) */
export function ensureThreadListSubscribed() {
  if (!_unsub) _unsub = onChatEvent(handleThreadListEvent)
}

export function useThreadList() {
  return useStore(threadListStore, useShallow((s: ThreadListState) => s))
}
