/**
 * 채팅 검색(handover-22 "검색" · §5.5 오른쪽 자리 · 시안 Chat22 #search-* · Side22 search · Mob22 #m-search).
 *
 * 헤더 검색칸(ChatSearchBox)에 쓴 필터 칩 + 글자 → SearchParams → GET /api/chat/search(chatApi22.searchChat)
 * → 결과는 오른쪽 자리(ChatSearchResults, 400 · 기존 chatStore.showSearchPanel 자리)에 뜬다.
 *
 * 필터(시안 순서·문구): from: 보낸 사람 · in: 채널 · has: 링크·임베드·파일·이미지·영상·소리 · mentions: 멘션된 사람
 *   · before: 이 날 이전 · after: 이 날 이후 · during: 이 날 하루 · is:pinned 고정된 메시지
 * 칩 값: from/mentions = username(표시는 이름) · in = 채널 id(표시는 채널 이름) · has = 영문 값(표시는 한국어)
 *   · before/after/during = 'YYYY-MM-DD' · is:pinned = 값 없음.
 *
 * 순수 함수(테스트 대상): chipsToParams ↔ paramsToChips(왕복) · parseSearchText(붙여 넣은 "from:a has:link 낱말")
 *   · liveConvert(입력 중 `from:` → 칩) · describeChips · groupByChannel(연속한 같은 채널끼리 묶음) · highlightParts.
 * 상태(zustand): 칩·글자·대기 칩(값 고르는 중) · 마지막으로 찾은 질의 · 결과 쪽(25개씩) · 정렬.
 */
import { createStore, useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { i18n } from '~/i18n'
import { searchChat, SEARCH_PAGE, type SearchHas, type SearchHit, type SearchParams } from '~/composables/chatApi22'
import { closeThread, setShowMemberPanel, setShowPinsPanel, setShowSearchPanel } from '~/composables/useChat'
import { setThreadListOpen } from '~/composables/useChatUi'

// ─── 필터 정의 ───
export type FilterKey = 'from' | 'in' | 'has' | 'mentions' | 'before' | 'after' | 'during' | 'pinned'
/** 시안 필터 안내 목록 순서 */
export const FILTER_ORDER: FilterKey[] = ['from', 'in', 'has', 'mentions', 'before', 'after', 'during', 'pinned']
/** 모바일 칩 줄(Mob22 #m-search) */
export const MOBILE_FILTER_KEYS: FilterKey[] = ['from', 'in', 'has', 'during', 'pinned']
export const DATE_KEYS: FilterKey[] = ['before', 'after', 'during']
export const PERSON_KEYS: FilterKey[] = ['from', 'mentions']
/** has: 값 순서(시안 "링크 · 임베드 · 파일 · 이미지 · 영상 · 소리") */
export const HAS_VALUES: SearchHas[] = ['link', 'embed', 'file', 'image', 'video', 'sound']

export interface SearchChip {
  key: FilterKey
  /** 서버로 가는 값(위 머리 주석) */
  value: string
  /** 칩에 보일 값(사람 이름·채널 이름). 없으면 value(has 는 i18n 이름) */
  label?: string
}

/** 칩 앞 키 글자(mono) */
export function filterToken(k: FilterKey): string { return k === 'pinned' ? 'is:pinned' : `${k}:` }

/** has 값의 표시 이름 */
export function hasLabel(v: string): string {
  const key = `chat.right.search.has.${v}`
  const s = i18n.t(key)
  return s === key ? v : s
}
/** has 값 — 영문 또는 표시 이름(링크·이미지…) 둘 다 받는다 */
export function normalizeHas(raw: string): SearchHas | null {
  const v = raw.trim().toLowerCase()
  if ((HAS_VALUES as string[]).includes(v)) return v as SearchHas
  for (const h of HAS_VALUES) {
    if (hasLabel(h).toLowerCase() === v || HAS_ALIASES[h].includes(v)) return h
  }
  return null
}
// 화면 언어와 상관없이 받는 이름(ko 화면에서 has:image, en 화면에서 has:링크)
const HAS_ALIASES: Record<SearchHas, string[]> = {
  link: ['링크', 'links'], embed: ['임베드', 'embeds'], file: ['파일', 'files'],
  image: ['이미지', '사진', 'images'], video: ['영상', '동영상', 'videos'], sound: ['소리', '오디오', 'audio'],
}
const YMD = /^\d{4}-\d{2}-\d{2}$/
export function isYmd(s: string) { return YMD.test(s) }

export function chipLabel(c: SearchChip): string {
  if (c.key === 'pinned') return ''
  if (c.key === 'has') return hasLabel(c.value)
  return c.label || c.value
}

// ─── 칩 ↔ SearchParams ───
/** 칩 + 글자 → 서버 질의. 한 값 필터는 마지막 칩이 이긴다, has 는 여러 개(중복 제거) */
export function chipsToParams(chips: SearchChip[], text: string): SearchParams {
  const p: SearchParams = {}
  const q = text.trim().replace(/\s+/g, ' ')
  if (q) p.q = q
  for (const c of chips) {
    if (c.key === 'pinned') { p.pinned = true; continue }
    if (!c.value) continue
    if (c.key === 'has') {
      const h = normalizeHas(c.value)
      if (h && !(p.has || []).includes(h)) p.has = [...(p.has || []), h]
      continue
    }
    if (DATE_KEYS.includes(c.key) && !isYmd(c.value)) continue
    p[c.key as 'from' | 'in' | 'mentions' | 'before' | 'after' | 'during'] = c.value
  }
  return p
}

/** 서버 질의 → 칩 + 글자(시안 순서). labels 로 사람·채널 표시 이름을 붙인다 */
export function paramsToChips(
  p: SearchParams,
  labels: { user?: (username: string) => string | undefined; channel?: (id: string) => string | undefined } = {},
): { chips: SearchChip[]; text: string } {
  const chips: SearchChip[] = []
  for (const k of FILTER_ORDER) {
    if (k === 'pinned') { if (p.pinned) chips.push({ key: 'pinned', value: '' }); continue }
    if (k === 'has') { for (const h of p.has || []) chips.push({ key: 'has', value: h }); continue }
    const v = p[k]
    if (!v) continue
    const label = PERSON_KEYS.includes(k) ? labels.user?.(v) : k === 'in' ? labels.channel?.(v) : undefined
    chips.push(label ? { key: k, value: v, label } : { key: k, value: v })
  }
  return { chips, text: p.q || '' }
}

/** 질의가 비었나(글자도 필터도 없음) */
export function isEmptyQuery(p: SearchParams): boolean {
  return !p.q && !p.from && !p.mentions && !p.in && !p.has?.length && !p.before && !p.after && !p.during && !p.pinned
}

const KEY_RE = /^(from|mentions|in|has|before|after|during):(.*)$/i

/**
 * 붙여 넣거나 다 쓴 글 "from:doyun has:link 릴리스" → 칩 + 남은 글자.
 * resolve 로 사람·채널 이름 → 값을 바꾼다(못 찾으면 쓴 그대로). 틀린 날짜·has 는 글자로 남긴다.
 */
export function parseSearchText(
  raw: string,
  resolve: { user?: (q: string) => { value: string; label?: string } | null; channel?: (q: string) => { value: string; label?: string } | null } = {},
): { chips: SearchChip[]; text: string } {
  const chips: SearchChip[] = []
  const rest: string[] = []
  for (const tok of raw.split(/\s+/).filter(Boolean)) {
    if (tok.toLowerCase() === 'is:pinned' || tok.toLowerCase() === 'pinned:true') { chips.push({ key: 'pinned', value: '' }); continue }
    const m = KEY_RE.exec(tok)
    if (!m || !m[2]) { rest.push(tok); continue }
    const key = m[1].toLowerCase() as FilterKey
    const val = m[2]
    if (key === 'has') {
      const h = normalizeHas(val)
      if (h) chips.push({ key, value: h }); else rest.push(tok)
    } else if (DATE_KEYS.includes(key)) {
      if (isYmd(val)) chips.push({ key, value: val }); else rest.push(tok)
    } else if (key === 'in') {
      const r = resolve.channel?.(val.replace(/^#/, ''))
      chips.push(r ? { key, ...r } : { key, value: val })
    } else {
      const r = resolve.user?.(val.replace(/^@/, ''))
      chips.push(r ? { key, ...r } : { key, value: val })
    }
  }
  return { chips, text: rest.join(' ') }
}

/**
 * 입력 중 변환 — 글자 끝이 (처음 또는 빈칸 뒤) `from:` 같은 키면 그 키를 떼어 대기 칩으로, `is:pinned` 는 바로 칩으로.
 * 바뀐 게 없으면 null.
 */
export function liveConvert(text: string): { text: string; pending?: FilterKey; chip?: SearchChip } | null {
  const pin = /(^|\s)is:pinned(\s|$)/i.exec(text)
  if (pin) return { text: (text.slice(0, pin.index) + pin[1] + text.slice(pin.index + pin[0].length)).replace(/\s+/g, ' ').trimStart(), chip: { key: 'pinned', value: '' } }
  const m = /(^|\s)(from|mentions|in|has|before|after|during):$/i.exec(text)
  if (!m) return null
  return { text: text.slice(0, m.index + m[1].length).replace(/\s+$/, m[1] ? ' ' : ''), pending: m[2].toLowerCase() as FilterKey }
}

/** 결과 개수 줄 뒤 조건 요약 — "from:이도윤 has:링크" */
export function describeChips(chips: SearchChip[]): string {
  return chips.map(c => filterToken(c.key) + chipLabel(c)).join(' ')
}

// ─── 결과 묶음 · 강조 ───
export interface SearchGroup { key: string; channelId: string; channelName: string; channelType: string; items: SearchHit[] }
/** 정렬 순서를 지키며 연속한 같은 채널끼리 묶는다(채널이 바뀌면 새 제목) */
export function groupByChannel(items: SearchHit[]): SearchGroup[] {
  const out: SearchGroup[] = []
  for (const it of items) {
    const last = out[out.length - 1]
    if (last && last.channelId === it.channel_id) last.items.push(it)
    else out.push({ key: `${it.channel_id}:${it.id}`, channelId: it.channel_id, channelName: it.channel_name || '', channelType: it.channel_type || 'public', items: [it] })
  }
  return out
}

/** 본문을 일치 부분(hit)과 나머지로 자른다. 낱말 여러 개는 각각, 대소문자 무시 */
export function highlightParts(content: string, q: string | undefined): Array<{ t: string; hit: boolean }> {
  const terms = (q || '').split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length)
  if (!terms.length || !content) return [{ t: content || '', hit: false }]
  const re = new RegExp(`(${terms.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return content.split(re).filter(s => s !== '').map(s => ({ t: s, hit: terms.some(x => x.toLowerCase() === s.toLowerCase()) }))
}

// ─── 상태 ───
export type SearchSort = 'new' | 'old'
export interface ChatSearchState {
  /** 검색칸의 칩(값이 정해진 것) */
  chips: SearchChip[]
  /** 칩 뒤 글자(대기 칩이 있으면 그 값을 찾는 글자) */
  text: string
  /** 값을 고르는 중인 키(칩 모양으로 보이되 값 없음 — 시안 #search-chips "during:") */
  pending: FilterKey | null
  /** 검색칸이 넓게(360) 펼쳐짐 — 포커스이거나 칩·글자가 있다. 헤더(SHELL)는 이때 채널 탭을 숨긴다(시안 tabsOn = !sBig) */
  focused: boolean
  /** 마지막으로 찾은 질의(결과 화면 기준) */
  query: SearchParams | null
  /** 마지막으로 찾은 칩(결과 개수 줄 요약) */
  queryChips: SearchChip[]
  sort: SearchSort
  offset: number
  items: SearchHit[]
  total: number
  loading: boolean
  error: string | null
}
const initial = (): ChatSearchState => ({
  chips: [], text: '', pending: null, focused: false, query: null, queryChips: [], sort: 'new', offset: 0, items: [], total: 0, loading: false, error: null,
})
export const chatSearchStore = createStore<ChatSearchState>()(() => initial())
const S = () => chatSearchStore.getState()
const set = (p: Partial<ChatSearchState>) => chatSearchStore.setState(p)
export function _resetChatSearch() { chatSearchStore.setState(initial()) }

export const setSearchChips = (chips: SearchChip[]) => set({ chips })
export const setSearchText = (text: string) => set({ text })
export const setSearchPending = (pending: FilterKey | null) => set({ pending })
export const setSearchFocused = (focused: boolean) => set({ focused })
export function addSearchChip(c: SearchChip) {
  // 한 값 필터는 같은 키를 바꿔 끼운다, has 는 쌓는다(같은 값 제외)
  const cur = S().chips
  const next = c.key === 'has'
    ? (cur.some(x => x.key === 'has' && x.value === c.value) ? cur : [...cur, c])
    : c.key === 'pinned' ? (cur.some(x => x.key === 'pinned') ? cur : [...cur, c]) : [...cur.filter(x => x.key !== c.key), c]
  set({ chips: next, pending: null })
}
export function removeSearchChip(i: number) { set({ chips: S().chips.filter((_, j) => j !== i) }) }

/** 검색칸이 넓은가(포커스 · 칩 · 글자 · 대기 칩) — SHELL 헤더가 채널 탭을 숨기는 기준 */
export function selectSearchExpanded(s: ChatSearchState): boolean {
  return s.focused || s.chips.length > 0 || !!s.text || !!s.pending
}
export function useChatSearchExpanded(): boolean { return useStore(chatSearchStore, selectSearchExpanded) }

/** 오른쪽 자리를 검색 결과로(다른 오른쪽 패널과 배타) */
export function openSearchResults() {
  closeThread()
  setShowPinsPanel(false)
  setShowMemberPanel(false)
  setThreadListOpen(false)
  setShowSearchPanel(true)
}
export function closeSearchResults() { setShowSearchPanel(false) }

let _seq = 0
async function fetchPage() {
  const q = S().query
  if (!q) return
  const my = ++_seq
  set({ loading: true, error: null })
  try {
    const page = await searchChat({ ...q, sort: S().sort, offset: S().offset, limit: SEARCH_PAGE })
    if (my !== _seq) return
    set({ items: Array.isArray(page?.items) ? page.items : [], total: typeof page?.total === 'number' ? page.total : (page?.items?.length ?? 0) })
  } catch (e: any) {
    if (my !== _seq) return
    const d = e?.data?.detail
    set({ items: [], total: 0, error: (typeof d === 'string' ? d : d?.message) || i18n.t('chat.right.search.error') })
  } finally {
    if (my === _seq) set({ loading: false })
  }
}

/** 지금 검색칸 값으로 찾는다(Enter). 빈 질의면 false */
export async function runSearch(): Promise<boolean> {
  const { chips, text } = S()
  const params = chipsToParams(chips, text)
  if (isEmptyQuery(params)) return false
  set({ query: params, queryChips: chips, offset: 0, pending: null })
  openSearchResults()
  await fetchPage()
  return true
}
/** 질의를 바로 넣어 찾기(테스트·딥 링크) */
export async function searchWith(params: SearchParams, chips: SearchChip[] = paramsToChips(params).chips) {
  if (isEmptyQuery(params)) return
  set({ query: params, queryChips: chips, offset: 0 })
  openSearchResults()
  await fetchPage()
}
export async function setSearchSort(sort: SearchSort) {
  if (S().sort === sort) return
  set({ sort, offset: 0 })
  await fetchPage()
}
/** 쪽 넘김(0부터) */
export async function goSearchPage(page: number) {
  const max = Math.max(0, Math.ceil(S().total / SEARCH_PAGE) - 1)
  const p = Math.min(Math.max(0, page), max)
  set({ offset: p * SEARCH_PAGE })
  await fetchPage()
}
export const retrySearch = () => fetchPage()
/** 검색칸 비우기(✕) — 결과 화면은 그대로 둔다 */
export function clearSearchBox() { set({ chips: [], text: '', pending: null }) }

/** 쪽 번호 창(최대 5칸) */
export function pageWindow(current: number, count: number, size = 5): number[] {
  if (count <= 0) return []
  const start = Math.max(0, Math.min(current - Math.floor(size / 2), count - size))
  return Array.from({ length: Math.min(size, count) }, (_, i) => start + i)
}

export function useChatSearch() {
  return useStore(chatSearchStore, useShallow((s: ChatSearchState) => s))
}
