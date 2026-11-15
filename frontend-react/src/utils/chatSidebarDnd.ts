/**
 * 채팅 사이드바 정렬·드래그 계산.
 * 순수 계산(테스트 대상)과, 그 결과를 서버에 보내는 동작(moveChannelTo / moveCategoryTo)을 함께 둔다.
 * 카테고리·정렬 API 는 useChatLayout 만 부른다(patchLayout · moveChannelPatch · moveCategoryPatch).
 * 보관된 프로젝트(시스템 구역)로 끌어 놓기 = 채널 보관(PATCH /channels/{id} is_archived), 거기서 꺼내기 = 보관 해제.
 */
import { $fetch } from '~/lib/api'
import { chatStore, fetchChannels, type Channel } from '~/composables/useChat'
import {
  chatLayoutStore, loadCategories, moveCategoryPatch, moveChannelPatch, patchLayout, visibleWhenCollapsed,
  type ChatCategory, type SidebarSection,
} from '~/composables/useChatLayout'

/** 끌 수 있는 구역(분류 없음 · 사용자 카테고리). DM·시스템은 끌기 불가 */
export function isDraggableSection(s: Pick<SidebarSection, 'kind'>): boolean {
  return s.kind === 'uncategorized' || s.kind === 'user'
}
/** 채널을 놓을 수 있는 구역(DM 제외 — 시스템 = 보관) */
export function isDropSection(s: Pick<SidebarSection, 'kind'>): boolean {
  return s.kind !== 'dm'
}

/** 구역에 실제로 그릴 채널 — 접혔으면 안 읽음·멘션·선택(+ 내가 들어간 음성 채널)만 */
export function sectionVisibleChannels(
  s: SidebarSection, selectedId: string | null, isBold: (c: Channel) => boolean, myVoiceId: string | null = null,
): Channel[] {
  if (!s.collapsed) return s.channels
  return s.channels.filter(c => visibleWhenCollapsed(c, selectedId, isBold) || (!!myVoiceId && c.id === myVoiceId))
}

/** 행 위 포인터 y → 그 행 앞(index) / 뒤(index+1) */
export function dropIndexFromPointer(rowIndex: number, y: number, rect: { top: number; height: number }): number {
  return y < rect.top + rect.height / 2 ? rowIndex : rowIndex + 1
}

/**
 * 접힌 구역의 "보이는 일부" 위치 → 구역 전체 목록의 위치.
 * 보이는 i 번째 앞에 넣으면 전체 목록에서 그 채널 바로 앞. 끝이면 맨 아래.
 */
export function fullIndexFromVisible(section: SidebarSection, visible: Channel[], visibleIndex: number, draggedId?: string): number {
  const full = section.channels.filter(c => c.id !== draggedId)
  const vis = visible.filter(c => c.id !== draggedId)
  if (visibleIndex >= vis.length) return full.length
  const anchor = vis[Math.max(0, visibleIndex)]
  const i = full.findIndex(c => c.id === anchor.id)
  return i < 0 ? full.length : i
}

/** 드래그 중 index 는 "끄는 행을 뺀 목록" 기준으로 맞춘다(같은 구역 안에서 아래로 옮길 때 한 칸 밀림 방지) */
export function normalizeSameSectionIndex(section: SidebarSection, channelId: string, index: number): number {
  const from = section.channels.findIndex(c => c.id === channelId)
  return from >= 0 && index > from ? index - 1 : index
}

export interface ChannelMovePlan {
  /** PATCH /layout 본문(시스템 구역으로 갈 때는 null) */
  patch: ReturnType<typeof moveChannelPatch> | null
  /** 보관(true) / 보관 해제(false) / 그대로(undefined) */
  archive?: boolean
  /** 옮긴 뒤 놓인 구역 id · 그 안 위치(0부터) */
  toSectionId: string
  index: number
}

/** 채널을 to 구역 index 자리로 — index 는 "끄는 채널을 뺀" 목록 기준 */
export function planChannelMove(sections: SidebarSection[], channelId: string, toSectionId: string, index: number): ChannelMovePlan | null {
  const to = sections.find(s => s.id === toSectionId)
  const from = sections.find(s => s.channels.some(c => c.id === channelId))
  if (!to || !from || !isDropSection(to) || from.kind === 'dm') return null
  if (to.kind === 'system') {
    if (from.kind === 'system') return null
    return { patch: null, archive: true, toSectionId, index: to.channels.length }
  }
  const catId = to.kind === 'uncategorized' ? null : to.id
  const patch = moveChannelPatch(sections, channelId, catId, index)
  // 그대로면 보내지 않는다
  if (from.id === to.id) {
    const before = from.channels.map(c => c.id)
    const after = patch.channels!.map(c => c.id)
    if (before.join() === after.join()) return null
  }
  return { patch, archive: from.kind === 'system' ? false : undefined, toSectionId, index: patch.channels!.findIndex(c => c.id === channelId) }
}

/**
 * 키보드(Alt+Shift+↑↓)·모바일 ↑↓ 한 칸 이동. 구역 끝에서 넘어가면 옆 구역(끌 수 있는 구역만)의 끝/처음으로.
 * 돌려주는 index 는 planChannelMove 에 그대로 넣는 값.
 */
export function stepChannel(sections: SidebarSection[], channelId: string, delta: -1 | 1): { toSectionId: string; index: number } | null {
  const movable = sections.filter(isDraggableSection)
  const si = movable.findIndex(s => s.channels.some(c => c.id === channelId))
  if (si < 0) return null
  const sec = movable[si]
  const i = sec.channels.findIndex(c => c.id === channelId)
  const j = i + delta
  if (j >= 0 && j < sec.channels.length) return { toSectionId: sec.id, index: j }
  const next = movable[si + delta]
  if (!next) return null
  return { toSectionId: next.id, index: delta < 0 ? next.channels.length : 0 }
}

/** 사용자 카테고리끼리 한 칸 이동 → moveCategoryPatch 에 넣을 index(없으면 null) */
export function stepCategory(categories: ChatCategory[], categoryId: string, delta: -1 | 1): number | null {
  const list = categories.filter(c => !c.system)
  const i = list.findIndex(c => c.id === categoryId)
  const j = i + delta
  if (i < 0 || j < 0 || j >= list.length) return null
  return j
}

/** 카테고리를 놓을 자리: 구역 위 포인터 → 사용자 카테고리 목록의 index("끄는 카테고리를 뺀" 기준) */
export function categoryDropIndex(categories: ChatCategory[], draggedId: string, overCategoryId: string, after: boolean): number | null {
  const list = categories.filter(c => !c.system && c.id !== draggedId)
  const i = list.findIndex(c => c.id === overCategoryId)
  if (i < 0) return null
  return after ? i + 1 : i
}

// ─── 음성 접속자 줄(§2.1(1)) ───
export const VOICE_ROWS_MAX = 4
/** 접속자 줄 최대 4줄, 넘으면 "+N명" 한 줄 */
export function voiceRows<T>(people: T[], max = VOICE_ROWS_MAX): { shown: T[]; more: number } {
  if (people.length <= max) return { shown: people, more: 0 }
  return { shown: people.slice(0, max), more: people.length - max }
}

// ─── 음소거 ───
/** 지금 음소거인가 — muted_until 이 지났으면 서버 지연 판정 전이라도 풀린 것으로 본다 */
export function isMutedNow(c: Pick<Channel, 'muted' | 'muted_until'>, now = Date.now()): boolean {
  if (!c.muted) return false
  if (!c.muted_until) return true
  const t = Date.parse(c.muted_until)
  return Number.isNaN(t) || t > now
}

/** "오후 3:00" (ko) · "3:00 PM" (en) — ICU 없는 환경에서도 같은 글자 */
export function clockText(d: Date, locale: string): string {
  const h = d.getHours()
  const m = String(d.getMinutes()).padStart(2, '0')
  const h12 = h % 12 === 0 ? 12 : h % 12
  if (locale.startsWith('ko')) return `${h < 12 ? '오전' : '오후'} ${h12}:${m}`
  return `${h12}:${m} ${h < 12 ? 'AM' : 'PM'}`
}
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function dateText(d: Date, locale: string): string {
  return locale.startsWith('ko') ? `${d.getMonth() + 1}월 ${d.getDate()}일` : `${EN_MONTHS[d.getMonth()]} ${d.getDate()}`
}

/**
 * 음소거 툴팁 — "오후 3:00까지 알림 끔" · 날이 다르면 "10월 24일 오후 3:00까지 알림 끔" · 기간 없음 "알림 끔".
 * t 키: chat.side.mutedUntil {time} · chat.side.mutedOn
 */
export function muteTooltip(mutedUntil: string | null | undefined, t: (k: string, a?: Record<string, unknown>) => string, locale: string, now = new Date()): string {
  if (!mutedUntil) return t('chat.side.mutedOn')
  const d = new Date(mutedUntil)
  if (Number.isNaN(d.getTime())) return t('chat.side.mutedOn')
  const sameDay = d.toDateString() === now.toDateString()
  const time = sameDay ? clockText(d, locale) : `${dateText(d, locale)} ${clockText(d, locale)}`
  return t('chat.side.mutedUntil', { time })
}

// ─── 안내 문구 도우미 ───
/** 한국어 목적격 조사(을/를) — 받침 있으면 을 */
export function objParticle(word: string): string {
  const ch = word.trim().slice(-1)
  const code = ch.charCodeAt(0)
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 ? '을' : '를'
  return /[0-9lmnLMN]$/.test(ch) ? '을' : '를'
}
/** 순서 글자 — ko "두 번째", 그 밖 "{n}번째" 키로 */
export function ordinalText(n: number, t: (k: string, a?: Record<string, unknown>) => string, locale: string): string {
  const KO = ['첫', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열']
  if (locale.startsWith('ko') && n >= 1 && n <= KO.length) return `${KO[n - 1]} 번째`
  return t('chat.side.ordinalN', { n })
}

/** 채널 표시 이름(사이드바 안내용) — 텍스트 채널은 #, 음성·포럼은 이름 그대로 */
export function channelLabel(c: Pick<Channel, 'name' | 'is_voice' | 'type'>): string {
  return c.is_voice ? c.name : `#${c.name}`
}

type T = (k: string, a?: Record<string, unknown>) => string
/** "#시안-리뷰를 ‘디자인 팀’ 두 번째로 옮겼습니다"(키보드 이동 aria-live) */
export function channelMovedText(t: T, locale: string, c: Pick<Channel, 'name' | 'is_voice' | 'type'>, sectionName: string, index: number): string {
  const name = channelLabel(c)
  return t('chat.side.moved', { name, obj: locale.startsWith('ko') ? objParticle(name) : '', cat: sectionName, nth: ordinalText(index + 1, t, locale) })
}
export function categoryMovedText(t: T, locale: string, name: string, index: number): string {
  return t('chat.side.catMoved', { name, nth: ordinalText(index + 1, t, locale) })
}
export function movingText(t: T, locale: string, name: string): string {
  return t('chat.side.moving', { name, obj: locale.startsWith('ko') ? objParticle(name) : '' })
}

// ─── 동작(서버) ───
export async function setChannelArchived(channelId: string, archived: boolean) {
  await $fetch(`/api/chat/channels/${channelId}`, { method: 'PATCH', body: { is_archived: archived } })
}

/** 낙관적으로 채널 목록을 고친 뒤 서버에 보낸다. 실패하면 다시 읽어 되돌리고 throw */
export async function applyChannelPlan(plan: ChannelMovePlan, channelId: string) {
  const prev = chatStore.getState().channels
  const pos = new Map((plan.patch?.channels || []).map(c => [c.id, c]))
  chatStore.setState({
    channels: prev.map(c => {
      let n = c
      const p = pos.get(c.id)
      if (p) n = { ...n, category_id: p.category_id, position: p.position }
      if (c.id === channelId && plan.archive !== undefined) n = { ...n, is_archived: plan.archive }
      return n
    }),
  })
  try {
    if (plan.archive !== undefined) await setChannelArchived(channelId, plan.archive)
    if (plan.patch) await patchLayout(plan.patch)
  } catch (e) {
    await Promise.all([fetchChannels(), loadCategories()])
    throw e
  }
}

/** 계획 + 적용 한 번에. 바뀐 게 없으면 null, 실패면 throw(이미 되돌림) */
export async function moveChannelTo(sections: SidebarSection[], channelId: string, toSectionId: string, index: number) {
  const plan = planChannelMove(sections, channelId, toSectionId, index)
  if (!plan) return null
  await applyChannelPlan(plan, channelId)
  return plan
}

/** 카테고리를 사용자 카테고리 목록 index 자리로 */
export async function moveCategoryTo(categoryId: string, index: number) {
  const cats = chatLayoutStore.getState().categories
  const patch = moveCategoryPatch(cats, categoryId, index)
  try {
    await patchLayout(patch)
  } catch (e) {
    await Promise.all([fetchChannels(), loadCategories()])
    throw e
  }
}
