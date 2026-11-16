/**
 * 개인 설정 — 서버(/api/me/prefs)와 동기화.
 *
 * - 로그인 시 서버 값을 수신하여 적용한다(서버에 존재하는 키가 우선). 수신 전에 변경한 키는 로컬 변경을 유지한다.
 * - 변경 시 이 기기(localStorage)에 즉시 기록하고, 600ms 동안 모아 PATCH 한다. 실패·오프라인 시 로컬 값을 계속 사용하며
 *   다음 변경·온라인 복귀 시 재전송한다.
 * - 서버에 설정이 전혀 없는 첫 로그인에는 이 기기의 기존 값(ws.prefs·mail.paperDark·colorMode·i18n 쿠키)을 1회 업로드한다.
 *
 * 서버 키(백엔드 app/me/prefs.py TOP_LEVEL_KEYS):
 *   density · theme · language · timezone · week_start · tabbar_pinned([id]) · mail_dark_view · read_receipt_default
 * 설정 › 캘린더·채팅(접두사 키):
 *   calendar.default_view · calendar.default_reminder(분, 없으면 키 없음) ·
 *   chat.enter_key(send|newline) · chat.link_preview · chat.media_autoexpand · chat.keywords([단어], 서버가 20개로 제한하며
 *   메시지에 포함되면 멘션과 동일하게 알림 — app/chat/keywords.py)
 * 사용자 메뉴 상태 메시지 이모지: ui.status_emoji_recent([이모지], 최근 사용 순 최대 8 — 사용자 단위이므로 기기 간에 유지된다)
 * 테마는 colorMode(~/composables/useColorMode), 언어는 i18n(~/i18n) 이 소유하므로 본 모듈은 해당 값을 감시하여 업로드하고,
 * 서버 값 수신 시 해당 모듈에 적용만 한다.
 *
 * 프레즌스(온라인·자리 비움·방해 금지)·상태 메시지는 기기 상태이므로 로컬에만 저장한다(서버 프레즌스는 채팅 소켓 담당).
 *
 * React: const { prefs, density, setDensity, ... } = useUserPrefs()
 * 컴포넌트 외부: userPrefsStore.getState().prefs, setPref 계열 함수 import
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
/** 채팅 메시지 표시 — cozy(아바타·이름 줄) · compact(시간 이름 본문 한 줄). 터치 기기에서는 compact 를 사용하지 않는다 */
export type ChatMessageDisplay = 'cozy' | 'compact'
/** 메시지 묶음 사이 간격(px) — 디스코드 설정 단계 0/4/8/16/24, 기본 16 */
export const CHAT_GROUP_GAPS = [0, 4, 8, 16, 24] as const
export type ChatGroupGap = typeof CHAT_GROUP_GAPS[number]
/** 채널 목록 폭(드래그) — 기본 298 · 199~367. 디스코드 실측: 레일 포함 사이드바 264~432(기본 375 = 레일 76 + 1 + 목록 298)
 *  → 본 프로젝트의 레일 64 + 1 을 제외하면 목록 199~367(시안 240~432 대신 디스코드 값) */
export const CHAT_LIST_WIDTH = { def: 298, min: 199, max: 367 } as const
/** 음성 입력 방식 — 음성 감지(vad) · 눌러서 말하기(ptt) */
export type ChatVoiceMode = 'vad' | 'ptt'
/** 사용자별 음량 범위(%) — 0~200, 5% 단계 */
export const USER_VOLUME = { min: 0, max: 200, def: 100, step: 5 } as const
/** 이모지 피커 "최근" 칸 수 */
export const CHAT_EMOJI_RECENT_MAX = 27
/** 채팅 알림 키워드 최대 개수(서버 app/me/prefs.py MAX_KEYWORDS 와 동일) */
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
  /** 캘린더 진입 시 기본 보기 */
  calendarDefaultView: CalendarView
  /** 새 일정에 추가되는 알림(분 전). null = 없음 */
  calendarDefaultReminder: number | null
  /** 채팅 Enter 키 — send(Shift+Enter 줄바꿈) · newline(Ctrl+Enter 보내기). 모바일 키보드는 항상 줄바꿈 */
  chatEnterKey: ChatEnterKey
  /** 메시지 속 링크 미리보기 */
  chatLinkPreview: boolean
  /** 이미지·영상 자동 펼치기(비활성화 시 파일 카드) */
  chatMediaAutoExpand: boolean
  /** 알림 키워드 */
  chatKeywords: string[]
  /** 메시지 표시 cozy/compact */
  chatMessageDisplay: ChatMessageDisplay
  /** 묶음 간격 px */
  chatGroupGap: ChatGroupGap
  /** 채널 목록 폭 px */
  chatSidebarWidth: number
  /** 상태 메시지 이모지 — 최근 사용 순(최대 STATUS_EMOJI_RECENT_MAX) */
  statusEmojiRecent: string[]
  // ── 채팅 개인 설정 ──
  /** 답장 시 대상에게 알림(@ 켬) — 마지막으로 선택한 값 */
  chatReplyPing: boolean
  /** 사용자별 음량(%) — user_id → 0~200. 100 은 저장하지 않는다 */
  chatUserVolumes: Record<string, number>
  /** 본인에게만 음소거한 사용자 */
  chatUserMuted: Record<string, boolean>
  /** 음성 입력 방식 */
  chatVoiceMode: ChatVoiceMode
  /** 눌러서 말하기 키(KeyboardEvent.code) — 기본 Backquote(`) */
  chatPttKey: string
  /** 키를 뗀 뒤 전송 중단까지의 시간(ms) */
  chatPttReleaseMs: number
  /** 이모지 최근 사용 순(유니코드 또는 :커스텀:) */
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

/** 로컬 키 → 서버 키(서버에 저장하는 항목만) */
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

/** 서버 값 → 로컬 값(형식 불일치 시 undefined = 무시) */
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
/** { id: 값 } 형태 검사 — 값이 ok 인 항목만 유지한다(4KB 한도이므로 최대 150명) */
function numMap<T>(v: unknown, ok: (x: unknown) => boolean): Record<string, T> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, T> = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 150)) if (ok(x)) out[k] = x as T
  return out
}
/** 채널 목록 폭을 허용 범위로 제한 */
export function clampChatListWidth(w: number): number {
  return Math.round(Math.max(CHAT_LIST_WIDTH.min, Math.min(CHAT_LIST_WIDTH.max, w)))
}

/** 실제 적용할 메시지 표시 — 터치 기기는 compact 를 비활성화한다(원칙: 터치 목표 44) */
export function effectiveChatDisplay(pref: ChatMessageDisplay, coarse: boolean): ChatMessageDisplay {
  return coarse ? 'cozy' : pref
}

/** 로컬 값 → 서버 값 */
export function toServer(key: SyncedKey, v: Prefs[SyncedKey]): unknown {
  if (key === 'pinnedTab') return [v]
  if (key === 'timezone') return v || null // 빈 값 = 시스템 시간대 = 서버에서 삭제
  if (key === 'calendarDefaultReminder') return v ?? null // 없음 = 키 삭제
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
/** 서버가 보유한 마지막 값(테마·언어 에코 방지용) */
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
    // 구 메일 어둡게 보기 키(기기별) → 본 설정으로 이전한다
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
  // 터치 기기에서는 조밀 모드를 차단한다(터치 타깃 40 하한)
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
    // 400(허용되지 않는 키 등)은 재전송해도 결과가 동일하므로 폐기한다. 그 외(네트워크·5xx)는 다음 기회에 재전송.
    const status = e?.statusCode ?? e?.response?.status
    if (!(status >= 400 && status < 500)) for (const k of keys) dirty.add(k)
    setSyncState('offline')
  }
}

/** 서버 값 수신 → 적용(+ 첫 로그인이면 이 기기 값 업로드) */
async function pull(uid: string) {
  setSyncState('syncing')
  let server: Record<string, unknown>
  try {
    server = (await $fetch<{ prefs: Record<string, unknown> }>('/api/me/prefs')).prefs || {}
  } catch {
    setSyncState('offline')
    return // 로컬 값으로 계속 동작 — 다음 로그인/새로고침 시 재시도
  }
  if (currentUserId() !== uid) return
  pulledFor = uid
  let changed = false
  const next: Prefs = { ...P() }
  for (const k of SYNCED) {
    const sk = SERVER_KEY[k]
    if (!(sk in server)) continue
    serverSnapshot[sk] = server[sk]
    if (dirty.has(sk)) continue // 수신 전에 이 기기에서 변경한 경우 로컬 값을 유지한다
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

  // 1회 이전: 서버가 비어 있고 이 사용자로 아직 이전하지 않았으면 이 기기 값을 업로드한다
  let migrated = false
  try { migrated = localStorage.getItem(`${MIGRATED_KEY}:${uid}`) === '1' } catch {}
  if (!migrated) {
    const missing = [...SYNCED.map(k => SERVER_KEY[k]), 'theme', 'language'].filter(sk => !(sk in server))
    for (const sk of missing) {
      const v = currentServerValue(sk)
      const local = SYNCED.find(k => SERVER_KEY[k] === sk)
      // 기본값과 동일한 항목은 업로드하지 않는다(서버가 비어 있으면 어차피 기본값 적용)
      if (local && JSON.stringify(P()[local]) === JSON.stringify(DEFAULTS[local])) continue
      if (v != null && v !== '') dirty.add(sk)
    }
    try { localStorage.setItem(`${MIGRATED_KEY}:${uid}`, '1') } catch {}
  }
  setSyncState('synced')
  if (dirty.size) await flush()
}

/**
 * 최초 사용 지점(기본 레이아웃)에서 1회 — 로그인 감시·테마/언어 감시·온라인 복귀 재전송.
 * useUserPrefs() 첫 호출 시 시작한다.
 * 감시는 앱 수명 동안 유지된다.
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
  // 테마·언어는 변경 위치(사용자 메뉴·설정 › 표시)와 무관하게 여기서 업로드한다. 서버 값을 적용한 경우는 재전송하지 않는다.
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

/** 설정 1건 변경: 로컬 반영 + 저장 + 서버 전송 예약 */
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
/** 사용자별 음량 — 100 이면 삭제한다(기본값으로 복귀) */
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
/** 이모지 사용 시 — 최근 목록 맨 앞으로 이동 */
export function pushChatEmojiRecent(e: string) {
  if (!e) return
  setPref('chatEmojiRecent', [e, ...P().chatEmojiRecent.filter(x => x !== e)].slice(0, CHAT_EMOJI_RECENT_MAX))
}
/** 상태 메시지 이모지 사용 시 — "최근" 줄 맨 앞으로 이동(중복 제거, 최대 8) */
export function pushStatusEmojiRecent(emoji: string) {
  if (!emoji) return
  const next = [emoji, ...P().statusEmojiRecent.filter(e => e !== emoji)].slice(0, STATUS_EMOJI_RECENT_MAX)
  if (JSON.stringify(next) === JSON.stringify(P().statusEmojiRecent)) return
  setPref('statusEmojiRecent', next)
}

/** 컴포넌트 외부에서 설정을 읽기 전에 호출(로컬 값 적재 + 동기화 시작) — store 내부에서 호출한다 */
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
