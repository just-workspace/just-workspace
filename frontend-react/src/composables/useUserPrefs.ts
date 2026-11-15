/**
 * 개인 설정 — 서버(/api/me/prefs)와 동기화.
 *
 * - 로그인하면 서버 값을 받아 적용한다(서버에 있는 키가 이긴다). 받기 전에 바꾼 키는 내 변경을 지킨다.
 * - 바꾸면 이 기기(localStorage)에 바로 쓰고, 600ms 모아서 PATCH 한다. 실패·오프라인이면 로컬 값으로 계속 쓰고
 *   다음 변경·온라인 복귀 때 다시 보낸다.
 * - 서버에 아무 설정도 없는 첫 로그인에는 이 기기의 기존 값(ws.prefs·mail.paperDark·colorMode·i18n 쿠키)을 한 번 올린다.
 *
 * 서버 키(백엔드 app/me/prefs.py TOP_LEVEL_KEYS):
 *   density · theme · language · timezone · week_start · tabbar_pinned([id]) · mail_dark_view · read_receipt_default
 * 설정 › 캘린더·채팅(접두사 키):
 *   calendar.default_view · calendar.default_reminder(분, 없으면 키 없음) ·
 *   chat.enter_key(send|newline) · chat.link_preview · chat.media_autoexpand · chat.keywords([단어], 서버가 20개로 정리하고
 *   메시지에 나오면 멘션처럼 알림 — app/chat/keywords.py)
 * 사용자 메뉴 상태 메시지 이모지: ui.status_emoji_recent([이모지], 최근 쓴 순 최대 8 — 사용자 단위라 기기 사이에서 이어진다)
 * 테마는 colorMode(~/composables/useColorMode), 언어는 i18n(~/i18n) 이 주인이라 여기서는 그 값을 지켜보다가 올리고,
 * 서버 값이 오면 그쪽에 적용만 한다.
 *
 * 프레즌스(온라인·자리 비움·방해 금지)·상태 메시지는 기기 상태라 로컬에만 둔다(서버 프레즌스는 채팅 소켓 담당).
 *
 * React: const { prefs, density, setDensity, ... } = useUserPrefs()
 * 컴포넌트 밖: userPrefsStore.getState().prefs, setPref 계열 함수 import
 */
import { createStore, useStore } from 'zustand'
import { $fetch } from '~/lib/api'
import { authStore } from '~/composables/useAuth'
import { colorModeStore, setColorPreference } from '~/composables/useColorMode'
import { i18n, LOCALES, onLocaleChange, setLocale } from '~/i18n'

export type Density = 'comfortable' | 'default' | 'compact'
export type Presence = 'online' | 'away' | 'dnd'
export type ReadReceiptPolicy = 'ask' | 'always' | 'never'
export type CalendarView = 'day' | 'week' | 'month' | 'agenda'
export type ChatEnterKey = 'send' | 'newline'
/** 채팅 메시지 표시 — cozy(아바타·이름 줄) · compact(시간 이름 본문 한 줄). 터치에선 compact 를 쓰지 않는다 */
export type ChatMessageDisplay = 'cozy' | 'compact'
/** 메시지 묶음 사이 간격(px) — 디스코드 설정 단계 0/4/8/16/24, 기본 16 */
export const CHAT_GROUP_GAPS = [0, 4, 8, 16, 24] as const
export type ChatGroupGap = typeof CHAT_GROUP_GAPS[number]
/** 채널 목록 폭(드래그) — 기본 298 · 199~367. 디스코드 실측: 레일 포함 사이드바 264~432(기본 375 = 레일 76 + 1 + 목록 298)
 *  → 우리 레일 64 + 1 을 빼면 목록 199~367(시안 240~432 대신 디스코드 값) */
export const CHAT_LIST_WIDTH = { def: 298, min: 199, max: 367 } as const
/** 음성 입력 방식 — 음성 감지(vad) · 눌러서 말하기(ptt) */
export type ChatVoiceMode = 'vad' | 'ptt'
/** 사람별 음량 범위(%) — 0~200, 5% 단계 */
export const USER_VOLUME = { min: 0, max: 200, def: 100, step: 5 } as const
/** 이모지 피커 "최근" 칸 수 */
export const CHAT_EMOJI_RECENT_MAX = 27
/** 채팅 알림 키워드 최대 개수(서버 app/me/prefs.py MAX_KEYWORDS 와 같음) */
export const MAX_CHAT_KEYWORDS = 20

export interface Prefs {
  density: Density
  presence: Presence
  statusMessage: string
  weekStart: 'locale' | 'mon' | 'sun' | 'sat'
  timezone: string
  pinnedTab: string
  mailDarkView: boolean
  readReceiptDefault: ReadReceiptPolicy
  /** 캘린더를 열 때 보기 */
  calendarDefaultView: CalendarView
  /** 새 일정에 붙는 알림(분 전). null = 없음 */
  calendarDefaultReminder: number | null
  /** 채팅 Enter 키 — send(Shift+Enter 줄바꿈) · newline(Ctrl+Enter 보내기). 모바일 키보드는 항상 줄바꿈 */
  chatEnterKey: ChatEnterKey
  /** 메시지 속 링크 미리보기 */
  chatLinkPreview: boolean
  /** 이미지·영상 자동 펼치기(끄면 파일 카드) */
  chatMediaAutoExpand: boolean
  /** 알림 키워드 */
  chatKeywords: string[]
  /** 메시지 표시 cozy/compact */
  chatMessageDisplay: ChatMessageDisplay
  /** 묶음 간격 px */
  chatGroupGap: ChatGroupGap
  /** 채널 목록 폭 px */
  chatSidebarWidth: number
  /** 상태 메시지 이모지 — 최근 쓴 순(최대 STATUS_EMOJI_RECENT_MAX) */
  statusEmojiRecent: string[]
  // ── 채팅 개인 설정 ──
  /** 답장할 때 대상에게 알림(@ 켬) — 마지막으로 고른 값 */
  chatReplyPing: boolean
  /** 사람별 음량(%) — user_id → 0~200. 100 은 저장하지 않는다 */
  chatUserVolumes: Record<string, number>
  /** 나만 음소거한 사람 */
  chatUserMuted: Record<string, boolean>
  /** 음성 입력 방식 */
  chatVoiceMode: ChatVoiceMode
  /** 눌러서 말하기 키(KeyboardEvent.code) — 기본 Backquote(`) */
  chatPttKey: string
  /** 키를 뗀 뒤 끊기까지(ms) */
  chatPttReleaseMs: number
  /** 이모지 최근 쓴 순(유니코드 또는 :커스텀:) */
  chatEmojiRecent: string[]
  /** 피부색 0(기본)~5 */
  chatEmojiSkin: number
}

/** 상태 메시지 이모지 "최근" 줄 칸 수(8×2 의 첫 줄) */
export const STATUS_EMOJI_RECENT_MAX = 8

const KEY = 'ws.prefs'
const OLD_PAPER_KEY = 'mail.paperDark'
const MIGRATED_KEY = 'ws.prefs.migrated'
const DEFAULTS: Prefs = {
  density: 'default', presence: 'online', statusMessage: '', weekStart: 'locale', timezone: '', pinnedTab: 'mail',
  mailDarkView: false, readReceiptDefault: 'ask',
  calendarDefaultView: 'month', calendarDefaultReminder: null,
  chatEnterKey: 'send', chatLinkPreview: true, chatMediaAutoExpand: true, chatKeywords: [],
  chatMessageDisplay: 'cozy', chatGroupGap: 16, chatSidebarWidth: CHAT_LIST_WIDTH.def,
  statusEmojiRecent: [],
  chatReplyPing: true, chatUserVolumes: {}, chatUserMuted: {}, chatVoiceMode: 'vad', chatPttKey: 'Backquote',
  chatPttReleaseMs: 200, chatEmojiRecent: [], chatEmojiSkin: 0,
}

/** 로컬 키 → 서버 키(서버에 저장하는 것만) */
type SyncedKey = 'density' | 'weekStart' | 'timezone' | 'pinnedTab' | 'mailDarkView' | 'readReceiptDefault'
  | 'calendarDefaultView' | 'calendarDefaultReminder' | 'chatEnterKey' | 'chatLinkPreview' | 'chatMediaAutoExpand' | 'chatKeywords' | 'statusEmojiRecent'
  | 'chatMessageDisplay' | 'chatGroupGap' | 'chatSidebarWidth'
  | 'chatReplyPing' | 'chatUserVolumes' | 'chatUserMuted' | 'chatVoiceMode' | 'chatPttKey' | 'chatPttReleaseMs' | 'chatEmojiRecent' | 'chatEmojiSkin'
const SERVER_KEY: Record<SyncedKey, string> = {
  density: 'density',
  weekStart: 'week_start',
  timezone: 'timezone',
  pinnedTab: 'tabbar_pinned',
  mailDarkView: 'mail_dark_view',
  readReceiptDefault: 'read_receipt_default',
  calendarDefaultView: 'calendar.default_view',
  calendarDefaultReminder: 'calendar.default_reminder',
  chatEnterKey: 'chat.enter_key',
  chatLinkPreview: 'chat.link_preview',
  chatMediaAutoExpand: 'chat.media_autoexpand',
  chatKeywords: 'chat.keywords',
  statusEmojiRecent: 'ui.status_emoji_recent',
  chatMessageDisplay: 'chat.message_display',
  chatGroupGap: 'chat.group_gap',
  chatSidebarWidth: 'chat.sidebar_width',
  chatReplyPing: 'chat.reply_ping',
  chatUserVolumes: 'chat.user_volumes',
  chatUserMuted: 'chat.user_muted',
  chatVoiceMode: 'chat.voice_mode',
  chatPttKey: 'chat.ptt_key',
  chatPttReleaseMs: 'chat.ptt_release_ms',
  chatEmojiRecent: 'chat.emoji_recent',
  chatEmojiSkin: 'chat.emoji_skin',
}
const SYNCED = Object.keys(SERVER_KEY) as SyncedKey[]

/** 서버 값 → 로컬 값(형식이 틀리면 undefined = 무시) */
export function fromServer(key: SyncedKey, v: unknown): Prefs[SyncedKey] | undefined {
  switch (key) {
    case 'density': return v === 'comfortable' || v === 'default' || v === 'compact' ? v : undefined
    case 'weekStart': return v === 'locale' || v === 'mon' || v === 'sun' || v === 'sat' ? v : undefined
    case 'timezone': return typeof v === 'string' ? v : undefined
    case 'pinnedTab': {
      const id = Array.isArray(v) ? v[0] : v
      return typeof id === 'string' && id ? id : undefined
    }
    case 'mailDarkView': return typeof v === 'boolean' ? v : undefined
    case 'readReceiptDefault': return v === 'ask' || v === 'always' || v === 'never' ? v : undefined
    case 'calendarDefaultView': return v === 'day' || v === 'week' || v === 'month' || v === 'agenda' ? v : undefined
    case 'calendarDefaultReminder': return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
    case 'chatEnterKey': return v === 'send' || v === 'newline' ? v : undefined
    case 'chatLinkPreview':
    case 'chatMediaAutoExpand': return typeof v === 'boolean' ? v : undefined
    case 'chatKeywords': return Array.isArray(v) && v.every(x => typeof x === 'string') ? v.slice(0, MAX_CHAT_KEYWORDS) : undefined
    case 'chatMessageDisplay': return v === 'cozy' || v === 'compact' ? v : undefined
    case 'chatGroupGap': return (CHAT_GROUP_GAPS as readonly unknown[]).includes(v) ? v as ChatGroupGap : undefined
    case 'chatSidebarWidth': return typeof v === 'number' && Number.isFinite(v) ? clampChatListWidth(v) : undefined
    case 'chatReplyPing': return typeof v === 'boolean' ? v : undefined
    case 'chatUserVolumes': return numMap<number>(v, x => typeof x === 'number' && x >= USER_VOLUME.min && x <= USER_VOLUME.max)
    case 'chatUserMuted': return numMap<boolean>(v, x => x === true)
    case 'chatVoiceMode': return v === 'vad' || v === 'ptt' ? v : undefined
    case 'chatPttKey': return typeof v === 'string' && v.length > 0 && v.length <= 32 ? v : undefined
    case 'chatPttReleaseMs': return typeof v === 'number' && v >= 0 && v <= 2000 ? v : undefined
    case 'chatEmojiRecent': return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 40).slice(0, CHAT_EMOJI_RECENT_MAX) : undefined
    case 'chatEmojiSkin': return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 5 ? v : undefined
    case 'statusEmojiRecent':
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 16).slice(0, STATUS_EMOJI_RECENT_MAX) : undefined
  }
}
/** { id: 값 } 모양 검사 — 값이 ok 인 것만 남긴다(4KB 한도라 최대 150명) */
function numMap<T>(v: unknown, ok: (x: unknown) => boolean): Record<string, T> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, T> = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 150)) if (ok(x)) out[k] = x as T
  return out
}
/** 채널 목록 폭을 허용 범위로 */
export function clampChatListWidth(w: number): number {
  return Math.round(Math.max(CHAT_LIST_WIDTH.min, Math.min(CHAT_LIST_WIDTH.max, w)))
}

/** 실제로 쓸 메시지 표시 — 터치 기기는 compact 를 끈다(원칙: 터치 목표 44) */
export function effectiveChatDisplay(pref: ChatMessageDisplay, coarse: boolean): ChatMessageDisplay {
  return coarse ? 'cozy' : pref
}

/** 로컬 값 → 서버 값 */
export function toServer(key: SyncedKey, v: Prefs[SyncedKey]): unknown {
  if (key === 'pinnedTab') return [v]
  if (key === 'timezone') return v || null // 빈 값 = 시스템 시간대 = 서버에서 지움
  if (key === 'calendarDefaultReminder') return v ?? null // 없음 = 키 지움
  if (key === 'chatKeywords' || key === 'statusEmojiRecent') return (v as string[]).length ? v : null
  return v
}

export type SyncState = 'local' | 'syncing' | 'synced' | 'offline'

export const userPrefsStore = createStore<{ prefs: Prefs; syncState: SyncState }>()(() => ({
  prefs: { ...DEFAULTS },
  syncState: 'local',
}))
const P = () => userPrefsStore.getState().prefs
const setPrefs = (prefs: Prefs) => userPrefsStore.setState({ prefs })
const setSyncState = (syncState: SyncState) => userPrefsStore.setState({ syncState })

let _loaded = false
let _syncStarted = false

// ── 서버 동기화 상태(모듈 싱글턴) ──
const dirty = new Set<string>() // 서버 키
let pulledFor: string | null = null // 서버 값을 받아 적용한 사용자 id
let flushTimer: ReturnType<typeof setTimeout> | null = null
/** 서버가 알고 있는 마지막 값(테마·언어 되울림 방지용) */
const serverSnapshot: Record<string, unknown> = {}
let themeRef: { get: () => string; set: (v: string) => void } | null = null
let langRef: { get: () => string; set: (v: string) => void; codes: () => string[] } | null = null
let currentUserId: () => string | null = () => null

function load() {
  if (_loaded) return
  _loaded = true
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}')
    const next: Prefs = { ...DEFAULTS, ...raw }
    // 예전 메일 어둡게 보기 키(기기별) → 이리로 옮긴다
    const oldPaper = localStorage.getItem(OLD_PAPER_KEY)
    if (oldPaper != null && raw.mailDarkView === undefined) next.mailDarkView = oldPaper === '1'
    setPrefs(next)
  } catch { setPrefs({ ...DEFAULTS }) }
  applyDensity()
}
function saveLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(P())) } catch {}
}
function isCoarse() {
  return window.matchMedia('(pointer: coarse)').matches
}
export function applyDensity() {
  // 터치 기기에서는 조밀을 막는다(터치 타깃 40 하한)
  const d = P().density === 'compact' && isCoarse() ? 'default' : P().density
  document.documentElement.setAttribute('data-density', d)
}

function markDirty(serverKey: string) {
  dirty.add(serverKey)
  scheduleFlush()
}
function scheduleFlush(delay = 600) {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => { flushTimer = null; void flush() }, delay)
}
function currentServerValue(serverKey: string): unknown {
  if (serverKey === 'theme') return themeRef?.get() ?? null
  if (serverKey === 'language') return langRef?.get() ?? null
  const local = SYNCED.find(k => SERVER_KEY[k] === serverKey)
  return local ? toServer(local, P()[local]) : undefined
}
async function flush() {
  if (!dirty.size || !currentUserId() || pulledFor !== currentUserId()) return
  if (typeof navigator !== 'undefined' && navigator.onLine === false) { setSyncState('offline'); return }
  const keys = [...dirty]
  const body: Record<string, unknown> = {}
  for (const k of keys) body[k] = currentServerValue(k) ?? null
  dirty.clear()
  setSyncState('syncing')
  try {
    await $fetch('/api/me/prefs', { method: 'PATCH', body: { prefs: body } })
    for (const k of keys) serverSnapshot[k] = body[k]
    setSyncState('synced')
  } catch (e: any) {
    // 400(허용 안 되는 키 등)은 다시 보내도 같다 — 버린다. 그 밖(네트워크·5xx)은 다음 기회에 다시.
    const status = e?.statusCode ?? e?.response?.status
    if (!(status >= 400 && status < 500)) for (const k of keys) dirty.add(k)
    setSyncState('offline')
  }
}

/** 서버 값 받기 → 적용(+ 첫 로그인이면 이 기기 값 올리기) */
async function pull(uid: string) {
  setSyncState('syncing')
  let server: Record<string, unknown>
  try {
    server = (await $fetch<{ prefs: Record<string, unknown> }>('/api/me/prefs')).prefs || {}
  } catch {
    setSyncState('offline')
    return // 로컬 값으로 계속 — 다음 로그인/새로고침 때 다시
  }
  if (currentUserId() !== uid) return
  pulledFor = uid
  let changed = false
  const next: Prefs = { ...P() }
  for (const k of SYNCED) {
    const sk = SERVER_KEY[k]
    if (!(sk in server)) continue
    serverSnapshot[sk] = server[sk]
    if (dirty.has(sk)) continue // 받기 전에 이 기기에서 바꿨으면 내 값을 지킨다
    const v = fromServer(k, server[sk])
    if (v !== undefined && next[k] !== v) { (next as any)[k] = v; changed = true }
  }
  if (changed) setPrefs(next)
  if ('theme' in server) {
    serverSnapshot.theme = server.theme
    const v = server.theme
    if (!dirty.has('theme') && (v === 'light' || v === 'dark' || v === 'system') && themeRef && themeRef.get() !== v) themeRef.set(v)
  }
  if ('language' in server) {
    serverSnapshot.language = server.language
    const v = server.language
    if (!dirty.has('language') && typeof v === 'string' && langRef && langRef.codes().includes(v) && langRef.get() !== v) langRef.set(v)
  }
  if (changed) { applyDensity(); saveLocal() }

  // 1회 이전: 서버가 비어 있고 이 사용자로 아직 안 옮겼으면 이 기기 값을 올린다
  let migrated = false
  try { migrated = localStorage.getItem(`${MIGRATED_KEY}:${uid}`) === '1' } catch {}
  if (!migrated) {
    const missing = [...SYNCED.map(k => SERVER_KEY[k]), 'theme', 'language'].filter(sk => !(sk in server))
    for (const sk of missing) {
      const v = currentServerValue(sk)
      const local = SYNCED.find(k => SERVER_KEY[k] === sk)
      // 기본값 그대로인 것은 올리지 않는다(서버가 비어 있으면 어차피 기본값)
      if (local && JSON.stringify(P()[local]) === JSON.stringify(DEFAULTS[local])) continue
      if (v != null && v !== '') dirty.add(sk)
    }
    try { localStorage.setItem(`${MIGRATED_KEY}:${uid}`, '1') } catch {}
  }
  setSyncState('synced')
  if (dirty.size) await flush()
}

/**
 * 처음 쓰는 곳(기본 레이아웃)에서 한 번 — 로그인 감시·테마/언어 감시·온라인 복귀 재전송.
 * useUserPrefs() 첫 호출 때 시작한다.
 * 감시는 앱 수명 동안 산다.
 */
function startSync() {
  if (_syncStarted) return
  _syncStarted = true
  currentUserId = () => authStore.getState().user?.id ?? null
  themeRef = { get: () => String(colorModeStore.getState().preference), set: (v) => { setColorPreference(v) } }
  langRef = {
    get: () => String(i18n.locale),
    set: (v) => { void setLocale(v) },
    codes: () => LOCALES.map(l => l.code),
  }
  // 테마·언어는 어디서 바꾸든(사용자 메뉴·설정 › 표시) 여기서 올린다. 서버 값을 적용한 것은 되울리지 않는다.
  colorModeStore.subscribe((s, prev) => {
    if (s.preference === prev.preference) return
    if (pulledFor && serverSnapshot.theme !== s.preference) markDirty('theme')
  })
  let lastLocale = i18n.locale
  onLocaleChange((v) => {
    if (v === lastLocale) return
    lastLocale = v
    if (pulledFor && serverSnapshot.language !== v) markDirty('language')
  })
  // 로그인 사용자 감시(immediate)
  const onUser = (uid: string | null) => {
    if (!uid) { pulledFor = null; dirty.clear(); setSyncState('local'); return }
    if (pulledFor !== uid) void pull(uid)
  }
  let lastUid = authStore.getState().user?.id ?? null
  onUser(lastUid)
  authStore.subscribe((s) => {
    const uid = s.user?.id ?? null
    if (uid === lastUid) return
    lastUid = uid
    onUser(uid)
  })
  window.addEventListener('online', () => { if (dirty.size) scheduleFlush(0) })
}

/** 설정 하나 바꾸기: 로컬 반영 + 저장 + 서버 예약 */
export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  setPrefs({ ...P(), [key]: value })
  saveLocal()
  if ((SYNCED as string[]).includes(key)) markDirty(SERVER_KEY[key as SyncedKey])
}

export function setDensity(d: Density) {
  if (d === 'compact' && isCoarse()) return
  setPref('density', d)
  applyDensity()
}
export function setChatMessageDisplay(d: ChatMessageDisplay) { setPref('chatMessageDisplay', d) }
export function setChatGroupGap(g: ChatGroupGap) { setPref('chatGroupGap', g) }
export function setChatSidebarWidth(w: number) { setPref('chatSidebarWidth', clampChatListWidth(w)) }
export function setPresence(p: Presence) { setPref('presence', p) }
export function setStatusMessage(s: string) { setPref('statusMessage', s) }
export function setPinnedTab(id: string) { setPref('pinnedTab', id) }
export function setWeekStart(w: Prefs['weekStart']) { setPref('weekStart', w) }
export function setTimezone(tz: string) { setPref('timezone', tz) }
export function setMailDarkView(v: boolean) { setPref('mailDarkView', v) }
export function setReadReceiptDefault(v: ReadReceiptPolicy) { setPref('readReceiptDefault', v) }
export function setChatReplyPing(v: boolean) { setPref('chatReplyPing', v) }
/** 사람별 음량 — 100 이면 지운다(기본값으로) */
export function setChatUserVolume(userId: string, pct: number) {
  const next = { ...P().chatUserVolumes }
  const v = Math.round(Math.max(USER_VOLUME.min, Math.min(USER_VOLUME.max, pct)) / USER_VOLUME.step) * USER_VOLUME.step
  if (v === USER_VOLUME.def) delete next[userId]; else next[userId] = v
  setPref('chatUserVolumes', next)
}
export function setChatUserMuted(userId: string, muted: boolean) {
  const next = { ...P().chatUserMuted }
  if (muted) next[userId] = true; else delete next[userId]
  setPref('chatUserMuted', next)
}
export function setChatVoiceMode(m: ChatVoiceMode) { setPref('chatVoiceMode', m) }
export function setChatPttKey(code: string) { setPref('chatPttKey', code) }
export function setChatPttReleaseMs(ms: number) { setPref('chatPttReleaseMs', ms) }
export function setChatEmojiSkin(n: number) { setPref('chatEmojiSkin', n) }
/** 이모지를 썼다 — 최근 맨 앞으로 */
export function pushChatEmojiRecent(e: string) {
  if (!e) return
  setPref('chatEmojiRecent', [e, ...P().chatEmojiRecent.filter(x => x !== e)].slice(0, CHAT_EMOJI_RECENT_MAX))
}
/** 상태 메시지 이모지를 썼다 — "최근" 줄 맨 앞으로(중복 제거, 최대 8) */
export function pushStatusEmojiRecent(emoji: string) {
  if (!emoji) return
  const next = [emoji, ...P().statusEmojiRecent.filter(e => e !== emoji)].slice(0, STATUS_EMOJI_RECENT_MAX)
  if (JSON.stringify(next) === JSON.stringify(P().statusEmojiRecent)) return
  setPref('statusEmojiRecent', next)
}

/** 컴포넌트 밖에서 설정을 읽기 전에(로컬 값 적재 + 동기화 시작) — store 안에서 부른다 */
export function ensureUserPrefs() {
  load()
  startSync()
}

export function useUserPrefs() {
  ensureUserPrefs()
  const prefs = useStore(userPrefsStore, s => s.prefs)
  const syncState = useStore(userPrefsStore, s => s.syncState)
  const compactAllowed = !isCoarse()

  return {
    prefs,
    syncState,
    density: prefs.density,
    presence: prefs.presence,
    statusMessage: prefs.statusMessage,
    pinnedTab: prefs.pinnedTab,
    mailDarkView: prefs.mailDarkView,
    readReceiptDefault: prefs.readReceiptDefault,
    compactAllowed,
    setDensity, setPresence, setStatusMessage, setPinnedTab, setWeekStart, setTimezone, setMailDarkView, setReadReceiptDefault,
    applyDensity,
  }
}
