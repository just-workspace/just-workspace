/**
 * 위키(싱글턴 상태 + API 호출).
 *
 * React: const { spaces, currentPage, fetchPage, ... } = useWiki()
 * 컴포넌트 밖: wikiStore.getState().currentPage, 동작 함수는 모듈 export 를 직접 import.
 * 바깥에서 바꾸는 상태는 setter(setCurrentPage 등)로.
 */
import { createStore, useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { $fetch } from '~/lib/api'

export interface WikiAuthor {
  id?: string
  username: string
  display_name: string | null
  avatar_url?: string | null
}

export interface WikiSpace {
  id: string
  name: string
  slug: string
  description: string | null
  visibility: string
  icon: string | null
  owner: WikiAuthor
  page_count: number
  user_role?: string
  created_at: string
  updated_at: string
}

export interface WikiPageNode {
  id: string
  parent_id: string | null
  title: string
  slug: string
  sort_order: number
  is_pinned: boolean
  version: number
  author: WikiAuthor
  updated_at: string
}

export interface WikiPageDetail {
  id: string
  space_id: string
  parent_id: string | null
  title: string
  slug: string
  content: string
  sort_order: number
  is_pinned: boolean
  version: number
  author: WikiAuthor
  user_role?: string
  created_at: string
  updated_at: string
}

export interface WikiPageVersion {
  id: string
  version_number: number
  title: string
  content: string
  author: WikiAuthor
  created_at: string
}

export interface WikiMember {
  user_id: string
  role: string
  username: string
  display_name: string | null
  avatar_url: string | null
}

export interface WikiState {
  spaces: WikiSpace[]
  currentSpace: WikiSpace | null
  pageTree: WikiPageNode[]
  currentPage: WikiPageDetail | null
  versions: WikiPageVersion[]
  loading: boolean
  saving: boolean
  searchResults: WikiPageNode[]
}

const initial = (): WikiState => ({
  spaces: [],
  currentSpace: null,
  pageTree: [],
  currentPage: null,
  versions: [],
  loading: false,
  saving: false,
  searchResults: [],
})

// Singleton state
export const wikiStore = createStore<WikiState>()(() => initial())

/** 테스트용 */
export function _resetWikiStore() { wikiStore.setState(initial()) }

const set = (p: Partial<WikiState>) => wikiStore.setState(p)
const get = () => wikiStore.getState()

// ─── 바깥에서 바꾸는 상태의 setter ───
export function setCurrentSpace(v: WikiSpace | null) { set({ currentSpace: v }) }
export function setPageTree(v: WikiPageNode[]) { set({ pageTree: v }) }
export function setCurrentPage(v: WikiPageDetail | null) { set({ currentPage: v }) }
export function setVersions(v: WikiPageVersion[]) { set({ versions: v }) }

// ─── Spaces ───

export async function fetchSpaces() {
  set({ loading: true })
  try {
    set({ spaces: await $fetch<WikiSpace[]>('/api/wiki/spaces') })
  } finally {
    set({ loading: false })
  }
}

export async function fetchSpace(spaceId: string) {
  set({ currentSpace: await $fetch<WikiSpace>(`/api/wiki/spaces/${spaceId}`) })
}

export async function createSpace(data: { name: string; slug: string; description?: string; visibility?: string; icon?: string }) {
  const result = await $fetch<{ id: string }>('/api/wiki/spaces', { method: 'POST', body: data })
  await fetchSpaces()
  return result
}

export async function updateSpace(spaceId: string, data: Record<string, any>) {
  await $fetch(`/api/wiki/spaces/${spaceId}`, { method: 'PATCH', body: data })
  await fetchSpaces()
}

export async function deleteSpace(spaceId: string) {
  await $fetch(`/api/wiki/spaces/${spaceId}`, { method: 'DELETE' })
  set({ spaces: get().spaces.filter(s => s.id !== spaceId) })
  if (get().currentSpace?.id === spaceId) set({ currentSpace: null })
}

// ─── Pages ───

export async function fetchPages(spaceId: string) {
  set({ pageTree: await $fetch<WikiPageNode[]>(`/api/wiki/spaces/${spaceId}/pages`) })
}

// 빠르게 옮겨 다닐 때 늦게 온 이전 응답이 지금 문서·버전 목록을 덮지 않게 — 마지막 요청만 반영한다
let _pageSeq = 0
let _versionsSeq = 0
let _searchSeq = 0

export async function fetchPage(pageId: string) {
  const my = ++_pageSeq
  const data = await $fetch<WikiPageDetail>(`/api/wiki/pages/${pageId}`)
  if (my === _pageSeq) set({ currentPage: data })
}

export async function createPage(spaceId: string, data: { title: string; slug: string; content?: string; parent_id?: string }) {
  const page = await $fetch<WikiPageDetail>(`/api/wiki/spaces/${spaceId}/pages`, { method: 'POST', body: data })
  await fetchPages(spaceId)
  return page
}

export async function updatePage(pageId: string, data: Record<string, any>) {
  set({ saving: true })
  try {
    set({ currentPage: await $fetch<WikiPageDetail>(`/api/wiki/pages/${pageId}`, { method: 'PATCH', body: data }) })
    const cur = get().currentPage
    if (cur) await fetchPages(cur.space_id)
  } finally {
    set({ saving: false })
  }
}

export async function deletePage(pageId: string) {
  const spaceId = get().currentPage?.space_id
  await $fetch(`/api/wiki/pages/${pageId}`, { method: 'DELETE' })
  if (spaceId) await fetchPages(spaceId)
  if (get().currentPage?.id === pageId) set({ currentPage: null })
}

// ─── Versions ───

export async function fetchVersions(pageId: string) {
  const my = ++_versionsSeq
  const data = await $fetch<WikiPageVersion[]>(`/api/wiki/pages/${pageId}/versions`)
  if (my === _versionsSeq) set({ versions: data })
}

// ─── Search ───

export async function searchPages(spaceId: string, query: string) {
  const my = ++_searchSeq
  if (!query.trim()) {
    set({ searchResults: [] })
    return
  }
  const data = await $fetch<WikiPageNode[]>(`/api/wiki/spaces/${spaceId}/search`, {
    params: { q: query },
  })
  if (my === _searchSeq) set({ searchResults: data })
}

// ─── Members ───

export async function fetchMembers(spaceId: string) {
  return await $fetch<WikiMember[]>(`/api/wiki/spaces/${spaceId}/members`)
}

export async function addMember(spaceId: string, userId: string, role: string = 'reader') {
  await $fetch(`/api/wiki/spaces/${spaceId}/members`, { method: 'POST', body: { user_id: userId, role } })
}

/** 멤버 역할 바꾸기(reader · writer · admin) */
export async function updateMember(spaceId: string, userId: string, role: string) {
  await $fetch(`/api/wiki/spaces/${spaceId}/members/${userId}`, { method: 'PATCH', body: { role } })
}

export async function removeMember(spaceId: string, userId: string) {
  await $fetch(`/api/wiki/spaces/${spaceId}/members/${userId}`, { method: 'DELETE' })
}

// ─── Tree helpers ───

export function buildTree(nodes: WikiPageNode[], parentId: string | null = null): (WikiPageNode & { children: any[] })[] {
  return nodes
    .filter(n => n.parent_id === parentId)
    .sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title))
    .map(n => ({ ...n, children: buildTree(nodes, n.id) }))
}

const actions = {
  fetchSpaces, fetchSpace, createSpace, updateSpace, deleteSpace,
  fetchPages, fetchPage, createPage, updatePage, deletePage,
  fetchVersions, searchPages,
  fetchMembers, addMember, updateMember, removeMember,
  buildTree,
  setCurrentSpace, setPageTree, setCurrentPage, setVersions,
}

/** 상태 + 동작. 상태는 전부 구독한다(위키 화면 하나가 쓴다). */
export function useWiki() {
  const state = useStore(wikiStore, useShallow((s: WikiState) => s))
  return { ...state, ...actions }
}
