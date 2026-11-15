/**
 * 채팅 이모지 데이터 한 곳(handover-22 "이모지 피커" · 자동완성 `:` · 리액션 · 커스텀 이모지 관리).
 * COMPOSER 가 만들고 MESSAGES(리액션·본문 :name: 그림)·SETTINGS(커스텀 이모지 관리)도 쓴다.
 *
 * 데이터: emojibase-data(ko/compact.json — 한국어 이름·태그·분류·피부색, en/shortcodes/github.json — `:fire:` 같은 영어 이름).
 *   초기 번들에 넣지 않으려고 dynamic import 로 지연 로드한다(loadEmojiData). 읽기 전에는 검색 결과가 비고 이름은 null.
 * 커스텀: GET /api/chat/emojis(chatApi22.fetchCustomEmojis) 결과를 캐시. 메시지·리액션 안의 커스텀은 `:name:` 문자열.
 * 최근·피부색: useUserPrefs(chatEmojiRecent · chatEmojiSkin, 사람마다 서버 동기화).
 *
 * API
 * - loadEmojiData(): Promise<EmojiEntry[]> — 유니코드 이모지(한 번만 읽음). emojiDataReady()
 * - useChatEmoji(): { ready, entries, custom, canManage, customLoaded, recent, skin } — 렌더용 훅(데이터·커스텀을 처음 쓸 때 읽기 시작)
 * - loadCustomEmojis(force?): Promise<CustomEmoji[]> · customEmojiByName(name): CustomEmoji | null · setCustomEmojis(items)(관리 화면이 바꾼 뒤)
 * - searchEmoji(q, { limit, includeCustom }): EmojiHit[] — 영어 이름(:fire:) · 한국어 이름(불) · 태그. 커스텀 포함
 * - EMOJI_CATEGORIES — 피커 분류 탭 10(자주 쓴 · 워크스페이스 · 사람 · 자연 · 음식 · 활동 · 여행 · 사물 · 기호 · 깃발)
 * - emojisInCategory(key): EmojiEntry[]
 * - emojiName(glyph): 'thumbsup' 처럼 콜론 없는 영어 이름(피부색 무시). 모르면 null. emojiLabel(glyph): 한국어 이름
 * - applySkin(glyph, skin 0-5): 피부색을 지원하는 이모지면 그 피부색 글리프, 아니면 그대로(0 = 기본)
 * - parseCustomToken(':name:'): 'name' | null · baseGlyph(glyph): 피부색 수식 뺀 글리프
 */
import { createStore, useStore } from 'zustand'
import { useEffect } from 'react'
import { fetchCustomEmojis, type CustomEmoji } from '~/composables/chatApi22'
import { userPrefsStore } from '~/composables/useUserPrefs'

export interface EmojiEntry {
  /** 글리프(기본 피부색) */
  glyph: string
  /** 대표 영어 이름(콜론 없음) */
  name: string
  /** 영어 이름 전부 */
  shortcodes: string[]
  /** 한국어 이름 */
  label: string
  tags: string[]
  /** emojibase group(0 웃는 얼굴 · 1 사람 · 3 자연 · 4 음식 · 5 여행 · 6 활동 · 7 사물 · 8 기호 · 9 깃발) */
  group: number
  order: number
  /** 피부색 1–5 글리프(지원하면) */
  skins?: string[]
}

export type EmojiHit =
  | { kind: 'unicode'; key: string; entry: EmojiEntry }
  | { kind: 'custom'; key: string; custom: CustomEmoji }

export type EmojiCategoryKey = 'recent' | 'custom' | 'people' | 'nature' | 'food' | 'activity' | 'travel' | 'objects' | 'symbols' | 'flags'
/** 분류 탭(시안 Picker22 순서). groups = emojibase group 번호. i18n 이름은 chat.compose.emoji.cat.<key> */
export const EMOJI_CATEGORIES: ReadonlyArray<{ key: EmojiCategoryKey; glyph: string; groups: number[] }> = [
  { key: 'recent', glyph: '🕘', groups: [] },
  { key: 'custom', glyph: '🚢', groups: [] },
  { key: 'people', glyph: '😀', groups: [0, 1] },
  { key: 'nature', glyph: '🌿', groups: [3] },
  { key: 'food', glyph: '🍔', groups: [4] },
  { key: 'activity', glyph: '⚽', groups: [6] },
  { key: 'travel', glyph: '✈️', groups: [5] },
  { key: 'objects', glyph: '💡', groups: [7] },
  { key: 'symbols', glyph: '🔣', groups: [8] },
  { key: 'flags', glyph: '🏁', groups: [9] },
]
/** 아직 쓴 이모지가 없을 때 "자주 쓴" 칸(시안 freq) */
export const DEFAULT_FREQUENT = ['👍', '👀', '🎉', '🔥', '✅', '🙏', '😂', '❤️', '🚀', '💯', '🤔', '👏', '😅', '🙌', '⏰', '📌', '🐛', '☕']
/** 피부색 수식(1–5) */
export const SKIN_MODIFIERS = ['\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}']
const SKIN_HEX = ['1F3FB', '1F3FC', '1F3FD', '1F3FE', '1F3FF']

interface EmojiState {
  entries: EmojiEntry[]
  ready: boolean
  custom: CustomEmoji[]
  customLoaded: boolean
  canManage: boolean
  limit: number
}
export const chatEmojiStore = createStore<EmojiState>()(() => ({ entries: [], ready: false, custom: [], customLoaded: false, canManage: false, limit: 200 }))
const S = () => chatEmojiStore.getState()

// glyph(피부색·FE0F 뺀 것) → entry
let _byGlyph = new Map<string, EmojiEntry>()
const norm = (g: string) => g.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '').replace(/️/g, '')

/** 피부색 수식을 뺀 글리프(FE0F 는 그대로) */
export function baseGlyph(glyph: string): string {
  return glyph.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '')
}

interface RawEmoji { hexcode: string; label: string; unicode: string; group?: number; order?: number; tags?: string[]; skins?: RawEmoji[] }

/** emojibase 원본 → EmojiEntry (테스트·로더 공용) */
export function buildEntries(raw: RawEmoji[], shortcodes: Record<string, string | string[]>): EmojiEntry[] {
  const out: EmojiEntry[] = []
  for (const e of raw) {
    if (e.group == null || e.group === 2) continue   // 분류 없음(지역 지표) · 구성 요소(피부색 견본)
    const sc = shortcodes[e.hexcode]
    const codes = sc == null ? [] : Array.isArray(sc) ? sc : [sc]
    // 이름: 사람이 읽는 것을 먼저(github 는 '+1' 이 첫째)
    const name = codes.find(c => /^[a-z]/.test(c)) || codes[0] || e.hexcode.toLowerCase()
    let skins: string[] | undefined
    if (e.skins?.length) {
      const picked = SKIN_HEX.map(hex => e.skins!.find(s => {
        const mods = s.hexcode.split('-').filter(h => SKIN_HEX.includes(h))
        return mods.length > 0 && mods.every(m => m === hex)
      })?.unicode)
      if (picked.every(Boolean)) skins = picked as string[]
    }
    out.push({ glyph: e.unicode, name, shortcodes: codes, label: e.label, tags: e.tags || [], group: e.group, order: e.order ?? 0, skins })
  }
  out.sort((a, b) => a.order - b.order)
  return out
}

/** 이미 만든 목록을 넣는다(테스트 · 로더) */
export function setEmojiEntries(entries: EmojiEntry[]) {
  _byGlyph = new Map(entries.map(e => [norm(e.glyph), e]))
  chatEmojiStore.setState({ entries, ready: true })
}

let _loading: Promise<EmojiEntry[]> | null = null
export function loadEmojiData(): Promise<EmojiEntry[]> {
  if (S().ready) return Promise.resolve(S().entries)
  if (!_loading) {
    _loading = Promise.all([
      import('emojibase-data/ko/compact.json'),
      import('emojibase-data/en/shortcodes/github.json'),
    ]).then(([d, s]) => {
      const raw = ((d as { default?: unknown }).default ?? d) as RawEmoji[]
      const sc = ((s as { default?: unknown }).default ?? s) as Record<string, string | string[]>
      const entries = buildEntries(raw, sc)
      setEmojiEntries(entries)
      return entries
    }).catch((e) => { _loading = null; throw e })
  }
  return _loading
}
export const emojiDataReady = () => S().ready

let _customLoading: Promise<CustomEmoji[]> | null = null
/** 커스텀 이모지(워크스페이스) — 실패(옛 서버)면 빈 목록 */
export function loadCustomEmojis(force = false): Promise<CustomEmoji[]> {
  if (S().customLoaded && !force) return Promise.resolve(S().custom)
  if (_customLoading && !force) return _customLoading
  _customLoading = fetchCustomEmojis()
    .then((r) => {
      const items = Array.isArray(r?.items) ? r.items : []
      chatEmojiStore.setState({ custom: items, customLoaded: true, canManage: !!r?.can_manage, limit: r?.limit ?? 200 })
      return items
    })
    .catch(() => { chatEmojiStore.setState({ custom: [], customLoaded: true }); return [] as CustomEmoji[] })
    .finally(() => { _customLoading = null })
  return _customLoading
}
/** 관리 화면이 올리기·이름 바꾸기·지우기 뒤 목록을 바로 바꾼다 */
export function setCustomEmojis(items: CustomEmoji[]) {
  chatEmojiStore.setState({ custom: items, customLoaded: true })
}
export function customEmojiByName(name: string): CustomEmoji | null {
  const n = name.replace(/^:|:$/g, '')
  return S().custom.find(c => c.name === n) || null
}
/** ':name:' → 'name' (커스텀 이모지 토큰 모양이 아니면 null) */
export function parseCustomToken(s: string): string | null {
  const m = /^:([a-z0-9_]{2,32}):$/.exec(s)
  return m ? m[1] : null
}

export function emojiEntry(glyph: string): EmojiEntry | null {
  return _byGlyph.get(norm(glyph)) || null
}
/** 영어 이름(콜론 없음). 모르면 null */
export function emojiName(glyph: string): string | null {
  return emojiEntry(glyph)?.name ?? null
}
/** 한국어 이름. 모르면 null */
export function emojiLabel(glyph: string): string | null {
  return emojiEntry(glyph)?.label ?? null
}
/** 피부색 적용(0 = 기본). 지원하지 않거나 데이터가 아직 없으면 그대로 */
export function applySkin(glyph: string, skin: number): string {
  const e = emojiEntry(glyph)
  if (!e?.skins) return glyph
  if (!skin || skin < 1 || skin > 5) return e.glyph
  return e.skins[skin - 1] || glyph
}

export function emojisInCategory(key: EmojiCategoryKey, entries: EmojiEntry[] = S().entries): EmojiEntry[] {
  const cat = EMOJI_CATEGORIES.find(c => c.key === key)
  if (!cat || !cat.groups.length) return []
  return entries.filter(e => cat.groups.includes(e.group))
}

/**
 * 검색 — 점수: 영어 이름 일치 0 · 이름 시작 1 · 한국어 이름 시작 2 · 이름/한국어 포함 3 · 태그 4. 같은 점수면 데이터 순서.
 * 앞뒤 콜론은 무시(`:fire` · `fire:`). 커스텀은 이름으로만(같은 점수 규칙, 같은 점수면 커스텀 먼저).
 */
export function searchEmoji(q: string, opts: { limit?: number; includeCustom?: boolean } = {}): EmojiHit[] {
  const query = q.trim().toLowerCase().replace(/^:+|:+$/g, '')
  if (!query) return []
  const limit = opts.limit ?? 200
  const scored: Array<{ s: number; o: number; hit: EmojiHit }> = []
  if (opts.includeCustom !== false) {
    for (const c of S().custom) {
      const n = c.name.toLowerCase()
      const s = n === query ? 0 : n.startsWith(query) ? 1 : n.includes(query) ? 3 : -1
      if (s >= 0) scored.push({ s, o: -1, hit: { kind: 'custom', key: `:${c.name}:`, custom: c } })
    }
  }
  for (const e of S().entries) {
    let s = -1
    for (const c of e.shortcodes) {
      const v = c === query ? 0 : c.startsWith(query) ? 1 : c.includes(query) ? 3 : -1
      if (v >= 0 && (s < 0 || v < s)) s = v
    }
    const label = e.label.toLowerCase()
    if (s < 0 || s > 2) { if (label.startsWith(query)) s = 2; else if (s < 0 && label.includes(query)) s = 3 }
    if (s < 0 && e.tags.some(tg => tg.toLowerCase().includes(query))) s = 4
    if (s >= 0) scored.push({ s, o: e.order, hit: { kind: 'unicode', key: e.glyph, entry: e } })
  }
  scored.sort((a, b) => a.s - b.s || a.o - b.o)
  return scored.slice(0, limit).map(x => x.hit)
}

/** 렌더용 — 처음 쓰는 컴포넌트가 데이터·커스텀 읽기를 시작한다 */
export function useChatEmoji(opts: { load?: boolean } = {}) {
  const load = opts.load !== false
  const ready = useStore(chatEmojiStore, s => s.ready)
  const entries = useStore(chatEmojiStore, s => s.entries)
  const custom = useStore(chatEmojiStore, s => s.custom)
  const customLoaded = useStore(chatEmojiStore, s => s.customLoaded)
  const canManage = useStore(chatEmojiStore, s => s.canManage)
  const recent = useStore(userPrefsStore, s => s.prefs.chatEmojiRecent)
  const skin = useStore(userPrefsStore, s => s.prefs.chatEmojiSkin)
  useEffect(() => {
    if (!load) return
    void loadEmojiData().catch(() => { /* 데이터를 못 읽어도 커스텀·최근은 쓴다 */ })
    void loadCustomEmojis()
  }, [load])
  return { ready, entries, custom, customLoaded, canManage, recent, skin }
}
