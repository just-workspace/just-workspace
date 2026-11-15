/**
 * 채팅 사이드바 카테고리·정렬(백엔드 /api/chat/categories · PATCH /layout).
 * 카테고리 API 는 프런트에서 여기서만 부른다.
 *
 * 구역 순서(위 → 아래):
 *   1. 분류 없음(제목 없는 구역) — category_id 가 없거나 지워진 카테고리의 채널
 *   2. 사용자 카테고리(position 순) — 음성 채널도 섞여 들어갈 수 있다
 *   3. 시스템 "보관된 프로젝트"(layout/meta 의 archive_category_id) — 보관한 채널은 카테고리와 무관하게 여기. 이름만 바꿀 수 있다
 *   4. 다이렉트 메시지 — 고정 구역, 사용자 카테고리 대상 아님
 * 접힘은 사람마다(localStorage), 순서·이름은 공통이고 MANAGE_CHANNELS 가 있어야 바꾼다.
 * 접힌 카테고리도 안 읽음·선택 채널은 계속 보인다.
 */
import { createStore, useStore } from 'zustand'
import { $fetch } from '~/lib/api'
import type { Channel } from '~/composables/useChat'

const B = '/api/chat'

export interface ChatCategory {
  id: string
  name: string
  position: number
  /** 시스템 카테고리(보관된 프로젝트) — 삭제·끌기 불가 */
  system?: boolean
  created_at?: string
}

interface LayoutState {
  categories: ChatCategory[]
  archiveCategoryId: string | null
  loaded: boolean
  /** 접힌 카테고리 id(사람마다) — 'dm' · 'archive' · '' (분류 없음 아님) 도 키로 */
  collapsed: Record<string, boolean>
}

const LS = 'jw-chat-collapsed'
function readCollapsed(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(LS) || '{}') || {} } catch { return {} }
}

export const chatLayoutStore = createStore<LayoutState>()(() => ({
  categories: [],
  archiveCategoryId: null,
  loaded: false,
  collapsed: typeof localStorage !== 'undefined' ? readCollapsed() : {},
}))
const S = () => chatLayoutStore.getState()
const set = (p: Partial<LayoutState>) => chatLayoutStore.setState(p)

export async function loadCategories() {
  try {
    const [r, meta] = await Promise.all([
      $fetch<{ items: ChatCategory[] }>(`${B}/categories`),
      $fetch<{ archive_category_id: string | null }>(`${B}/layout/meta`).catch(() => ({ archive_category_id: null })),
    ])
    const arch = meta.archive_category_id
    set({
      categories: r.items.map(c => ({ ...c, system: c.system || c.id === arch })).sort(byPos),
      archiveCategoryId: arch,
      loaded: true,
    })
  } catch {
    set({ loaded: true })
  }
}
const byPos = (a: { position?: number | null; name?: string }, b: { position?: number | null; name?: string }) =>
  (a.position ?? 1e9) - (b.position ?? 1e9) || (a.name || '').localeCompare(b.name || '', 'ko')

export function setCollapsed(id: string, v: boolean) {
  const c = { ...S().collapsed, [id]: v }
  if (!v) delete c[id]
  set({ collapsed: c })
  try { localStorage.setItem(LS, JSON.stringify(c)) } catch { /* 기억 못 해도 동작은 같다 */ }
}
export const toggleCollapsed = (id: string) => setCollapsed(id, !S().collapsed[id])

export interface SidebarSection {
  /** 카테고리 id · '' = 분류 없음 · 'dm' */
  id: string
  kind: 'uncategorized' | 'user' | 'system' | 'dm'
  name: string
  category: ChatCategory | null
  channels: Channel[]
  collapsed: boolean
}

/** 채널 목록 → 구역. 순수 함수(테스트용으로 export) */
export function buildSections(
  channels: Channel[],
  categories: ChatCategory[],
  archiveCategoryId: string | null,
  collapsed: Record<string, boolean>,
  names: { archive: string; dm: string },
): SidebarSection[] {
  const known = new Set(categories.map(c => c.id))
  const dms = channels.filter(c => c.type === 'dm')
  const rest = channels.filter(c => c.type !== 'dm')
  const archived = rest.filter(c => c.is_archived)
  const live = rest.filter(c => !c.is_archived)
  const sections: SidebarSection[] = []
  const unc = live.filter(c => !c.category_id || !known.has(c.category_id) || c.category_id === archiveCategoryId).sort(byPos)
  if (unc.length) sections.push({ id: '', kind: 'uncategorized', name: '', category: null, channels: unc, collapsed: false })
  for (const cat of categories) {
    if (cat.id === archiveCategoryId || cat.system) continue
    sections.push({
      id: cat.id, kind: 'user', name: cat.name, category: cat,
      channels: live.filter(c => c.category_id === cat.id).sort(byPos),
      collapsed: !!collapsed[cat.id],
    })
  }
  const archCat = categories.find(c => c.id === archiveCategoryId || c.system) || null
  if (archived.length || archCat) {
    sections.push({
      id: archCat?.id || 'archive', kind: 'system', name: archCat?.name || names.archive, category: archCat,
      channels: archived.sort(byPos), collapsed: !!collapsed[archCat?.id || 'archive'],
    })
  }
  sections.push({ id: 'dm', kind: 'dm', name: names.dm, category: null, channels: dms, collapsed: !!collapsed.dm })
  return sections
}

/** 접힌 구역에서도 보이는 채널: 안 읽음·멘션·선택 */
export function visibleWhenCollapsed(c: Channel, selectedId: string | null, isBold: (c: Channel) => boolean): boolean {
  return c.id === selectedId || (c.mention_count || 0) > 0 || isBold(c)
}

// ─── 변경(MANAGE_CHANNELS) ───
export async function createCategory(name: string, position?: number) {
  const c = await $fetch<ChatCategory>(`${B}/categories`, { method: 'POST', body: { name, position } })
  await loadCategories()
  return c
}
export async function renameCategory(id: string, name: string) {
  set({ categories: S().categories.map(c => (c.id === id ? { ...c, name } : c)) })
  try { await $fetch(`${B}/categories/${id}`, { method: 'PATCH', body: { name } }) } finally { await loadCategories() }
}
/** 지운 카테고리 안의 채널은 "분류 없음"으로 간다 — 채널 목록은 호출부가 다시 읽는다 */
export async function deleteCategory(id: string) {
  await $fetch(`${B}/categories/${id}`, { method: 'DELETE' })
  await loadCategories()
}

export interface LayoutPatch {
  categories?: { id: string; position: number }[]
  channels?: { id: string; category_id: string | null; position: number | null }[]
}
/** 드래그 정렬 한 번 = PATCH /layout 한 번. 실패하면 호출부가 채널 목록을 다시 읽어 되돌린다 */
export async function patchLayout(p: LayoutPatch) {
  if (p.categories?.length) {
    const pos = new Map(p.categories.map(c => [c.id, c.position]))
    set({ categories: S().categories.map(c => (pos.has(c.id) ? { ...c, position: pos.get(c.id)! } : c)).sort(byPos) })
  }
  await $fetch(`${B}/layout`, { method: 'PATCH', body: { categories: p.categories || [], channels: p.channels || [] } })
}

/** 채널을 to 카테고리의 index 자리로 옮길 때 그 카테고리 전체의 새 순서(0,1,2…) */
export function moveChannelPatch(
  sections: SidebarSection[], channelId: string, toCategoryId: string | null, index: number,
): LayoutPatch {
  const target = sections.find(s => (toCategoryId ? s.id === toCategoryId : s.kind === 'uncategorized'))
  const list = (target?.channels || []).filter(c => c.id !== channelId).map(c => c.id)
  list.splice(Math.max(0, Math.min(index, list.length)), 0, channelId)
  return { channels: list.map((id, i) => ({ id, category_id: toCategoryId, position: i })) }
}
/** 카테고리를 index 자리로(사용자 카테고리끼리) */
export function moveCategoryPatch(categories: ChatCategory[], categoryId: string, index: number): LayoutPatch {
  const list = categories.filter(c => !c.system && c.id !== categoryId).map(c => c.id)
  list.splice(Math.max(0, Math.min(index, list.length)), 0, categoryId)
  return { categories: list.map((id, i) => ({ id, position: i })) }
}

/** WS chat_layout_changed — 다시 읽는다(채널 목록은 useChat 이 channel_update 로) */
export function handleLayoutEvent(data: { type?: string }) {
  if (data.type === 'chat_layout_changed') void loadCategories()
}

export function useChatLayout<T>(sel: (s: LayoutState) => T): T {
  return useStore(chatLayoutStore, sel)
}
