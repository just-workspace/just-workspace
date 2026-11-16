/**
 * 연락처(모듈 싱글턴 상태 + 동작). 요청 주소·순서·본문 동일.
 *
 * React: const { contacts, selectedContact, scope, scopeLabel, selectScope, ... } = useContacts()
 *   외부에서 변경하는 상태는 setter 를 함께 제공한다:
 *     selectedContact → setSelectedContact(v) · selectedBookId → setSelectedBookId(v) · sortBy → setSortBy(v)
 *     mobileMenuOpen → setMobileMenuOpen(v) · showEditModal → setShowEditModal(v)
 * 컴포넌트 외부: contactsStore.getState(), 또는 아래 동작 함수를 직접 import.
 */
import { createStore, useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { $fetch } from '~/lib/api'
import { i18n, useI18n } from '~/i18n'
import { downloadApi } from '~/utils/apiDownload'
import { addToast } from '~/composables/useToast'

export interface TypedValue {
  type: string
  value: string
}

export interface AddressBook {
  id: string
  name: string
}

export interface Contact {
  id: string
  address_book_id: string
  name: string
  first_name: string | null
  last_name: string | null
  organization: string | null
  emails: TypedValue[]
  phones: TypedValue[]
  addresses: TypedValue[]
  notes: string | null
  created: string | null
  updated: string | null
  // ── 추가 필드 ──
  /** data:image/...;base64,… (워크스페이스 사용자 행은 아바타 URL) */
  photo?: string | null
  is_favorite?: boolean
  groups?: string[]
  /** 직함 */
  title?: string | null
  /** "워크스페이스 사용자" 범위의 행 — 주소록 연락처가 아니므로 편집·삭제·즐겨찾기 미지원 */
  workspace_user_id?: string
}

/** 사이드바 범위: 모든 연락처 · 즐겨찾기 · 워크스페이스 사용자 · 주소록 하나 · 그룹 하나 */
export type ContactScope =
  | { kind: 'all' }
  | { kind: 'favorite' }
  | { kind: 'workspace' }
  | { kind: 'book'; id: string }
  | { kind: 'group'; name: string }

export interface ContactGroup { name: string; count: number }

interface WorkspaceUser {
  id: string
  username: string
  display_name: string
  email: string | null
  avatar_url?: string | null
  department?: string | null
  position?: string | null
  job_title?: string | null
  phone?: string | null
}

/** 워크스페이스 사용자 → 목록·상세에서 그대로 표시 가능한 Contact 형태 */
export function workspaceUserToContact(u: WorkspaceUser): Contact {
  return {
    id: `ws:${u.id}`,
    address_book_id: '',
    name: u.display_name || u.username,
    first_name: null,
    last_name: null,
    organization: u.department || null,
    emails: u.email ? [{ type: 'work', value: u.email }] : [],
    phones: u.phone ? [{ type: 'work', value: u.phone }] : [],
    addresses: [],
    notes: null,
    created: null,
    updated: null,
    photo: u.avatar_url || null,
    is_favorite: false,
    groups: [],
    title: u.position || u.job_title || null,
    workspace_user_id: u.id,
  }
}

export interface ExternalAccount { id: string; email: string; provider: string }
/** /api/contacts/suggest 항목 — 워크스페이스 사용자이면 user_id 포함 */
interface SuggestItem { email: string; name?: string; user_id?: string; username?: string; sources?: string[] }

export interface ContactsState {
  addressBooks: AddressBook[]
  contacts: Contact[]
  totalContacts: number
  selectedContact: Contact | null
  selectedBookId: string | null
  searchQuery: string
  currentPage: number
  limit: number
  loadingBooks: boolean
  loadingContacts: boolean
  showEditModal: boolean
  editingContact: Contact | null
  /** 목록 조회 실패(실패가 "비어 있음"으로 표시되지 않도록 구분) */
  contactsError: string
  /** 목록 정렬("이름순 ▾") — 현재 페이지 내에서만 정렬한다(서버는 이름순) */
  sortBy: 'name' | 'org'
  /** 모바일 ⋯ 시트(주소록·가져오기·내보내기) */
  mobileMenuOpen: boolean
  /** 즐겨찾기·워크스페이스 사용자·그룹 범위(주소록 범위는 selectedBookId 가 담당) */
  scopeKind: 'all' | 'favorite' | 'workspace' | 'group'
  selectedGroup: string | null
  groups: ContactGroup[]
  /** 사이드바 개수(모든 연락처 248 · 즐겨찾기 12 · 워크스페이스 사용자 48) */
  counts: { all: number | null; favorite: number | null; workspace: number | null }
}

function initialState(): ContactsState {
  return {
    addressBooks: [],
    contacts: [],
    totalContacts: 0,
    selectedContact: null,
    selectedBookId: null,
    searchQuery: '',
    currentPage: 0,
    limit: 50,
    loadingBooks: false,
    loadingContacts: false,
    showEditModal: false,
    editingContact: null,
    contactsError: '',
    sortBy: 'name',
    mobileMenuOpen: false,
    scopeKind: 'all',
    selectedGroup: null,
    groups: [],
    counts: { all: null, favorite: null, workspace: null },
  }
}

export const contactsStore = createStore<ContactsState>()(() => initialState())

const get = () => contactsStore.getState()
const set = (p: Partial<ContactsState>) => contactsStore.setState(p)

/** 테스트용: 초기 상태로 복원 */
export function _resetContactsStore() {
  contactsStore.setState(initialState(), true)
}

// ─── 외부에서 변경하는 상태의 setter ───

export function setSelectedContact(c: Contact | null) { set({ selectedContact: c }) }
export function setSelectedBookId(id: string | null) { set({ selectedBookId: id }) }
export function setSortBy(v: 'name' | 'org') { set({ sortBy: v }) }
export function setMobileMenuOpen(v: boolean) { set({ mobileMenuOpen: v }) }
export function setShowEditModal(v: boolean) { set({ showEditModal: v }) }

// ─── Computed ───

export function contactsTotalPages(s: ContactsState = get()) { return Math.ceil(s.totalContacts / s.limit) }
export function contactsHasNextPage(s: ContactsState = get()) { return s.currentPage < contactsTotalPages(s) - 1 }
export function contactsHasPrevPage(s: ContactsState = get()) { return s.currentPage > 0 }

/** 현재 범위 — 사이드바 강조·브레드크럼·모바일 범위 이름 */
export function contactsScope(s: ContactsState = get()): ContactScope {
  if (s.selectedBookId) return { kind: 'book', id: s.selectedBookId }
  if (s.scopeKind === 'group' && s.selectedGroup) return { kind: 'group', name: s.selectedGroup }
  if (s.scopeKind === 'favorite') return { kind: 'favorite' }
  if (s.scopeKind === 'workspace') return { kind: 'workspace' }
  return { kind: 'all' }
}

/** 현재 범위 이름(브레드크럼 3단·모바일 범위 줄) */
export function contactsScopeLabel(s: ContactsState = get(), t: (k: string) => string = k => i18n.t(k)): string {
  const sc = contactsScope(s)
  if (sc.kind === 'book') return s.addressBooks.find(b => b.id === sc.id)?.name ?? ''
  if (sc.kind === 'group') return sc.name
  if (sc.kind === 'favorite') return t('contacts.sidebar.favorites')
  if (sc.kind === 'workspace') return t('contacts.sidebar.workspaceUsers')
  return t('contacts.sidebar.allContacts')
}

// ─── Actions ───

export async function fetchAddressBooks() {
  set({ loadingBooks: true })
  try {
    const data = await $fetch<{ address_books: AddressBook[] }>('/api/contacts/address-books')
    set({ addressBooks: data.address_books })
  } catch (e: any) {
    console.error('fetchAddressBooks error:', e)
  } finally {
    set({ loadingBooks: false })
  }
}

// 검색어·범위를 빠르게 변경하면 지연 도착한 이전 응답이 현재 목록을 덮어쓰는 문제가 있었음 — 마지막 요청만 반영
let contactsSeq = 0

export async function fetchContacts() {
  const my = ++contactsSeq
  set({ loadingContacts: true, contactsError: '' })
  try {
    const s = get()
    const params: Record<string, any> = {
      page: s.currentPage,
      limit: s.limit,
    }
    if (s.searchQuery.trim()) params.q = s.searchQuery.trim()

    if (s.scopeKind === 'workspace') {
      // 워크스페이스 사용자(활성 사용자만) — 동일 페이지 단위로 수신
      const data = await $fetch<{ users: WorkspaceUser[]; total: number }>('/api/contacts/workspace-users', {
        params: { q: params.q, limit: s.limit, offset: s.currentPage * s.limit },
      })
      if (my !== contactsSeq) return
      set({ contacts: data.users.map(workspaceUserToContact), totalContacts: data.total })
      return
    }
    if (s.selectedBookId) params.book_id = s.selectedBookId
    if (s.scopeKind === 'favorite') params.favorite = true
    if (s.scopeKind === 'group' && s.selectedGroup) params.group = s.selectedGroup

    const data = await $fetch<{ contacts: Contact[]; total: number }>('/api/contacts/', { params })
    if (my !== contactsSeq) return
    set({ contacts: data.contacts, totalContacts: data.total })
  } catch (e: any) {
    console.error('fetchContacts error:', e)
    if (my !== contactsSeq) return
    set({ contacts: [], contactsError: e?.data?.detail || e?.message || 'error' })
  } finally {
    if (my === contactsSeq) set({ loadingContacts: false })
  }
}

export function selectBook(id: string | null) {
  selectScope(id ? { kind: 'book', id } : { kind: 'all' })
}

/** 사이드바·모바일 시트의 범위 선택 */
export function selectScope(sc: ContactScope) {
  set({
    selectedBookId: sc.kind === 'book' ? sc.id : null,
    selectedGroup: sc.kind === 'group' ? sc.name : null,
    scopeKind: sc.kind === 'book' ? 'all' : sc.kind,
    currentPage: 0,
    selectedContact: null,
  })
  fetchContacts()
}

export async function fetchGroups() {
  try { set({ groups: (await $fetch<{ groups: ContactGroup[] }>('/api/contacts/groups')).groups }) }
  catch { set({ groups: [] }) }
}

/** 사이드바 개수 — 1건만 수신해 total 을 사용 */
export async function fetchCounts() {
  const one = async (url: string, params: Record<string, any>) => {
    try { return (await $fetch<{ total: number }>(url, { params: { ...params, limit: 1 } })).total }
    catch { return null }
  }
  const [all, favorite, workspace] = await Promise.all([
    one('/api/contacts/', {}),
    one('/api/contacts/', { favorite: true }),
    one('/api/contacts/workspace-users', {}),
  ])
  set({ counts: { all, favorite, workspace } })
}

/** 즐겨찾기 전환 — 목록·상세·개수를 즉시 갱신 */
export async function toggleFavorite(contact: Contact) {
  if (contact.workspace_user_id) return
  const next = !contact.is_favorite
  await $fetch(`/api/contacts/${contact.id}`, { method: 'PATCH', body: { is_favorite: next } })
  set({ contacts: get().contacts.map(c => c.id === contact.id ? { ...c, is_favorite: next } : c) })
  const sel = get().selectedContact
  if (sel?.id === contact.id) set({ selectedContact: { ...sel, is_favorite: next } })
  const counts = get().counts
  if (counts.favorite != null) set({ counts: { ...counts, favorite: counts.favorite + (next ? 1 : -1) } })
  // 즐겨찾기 범위에서 해제하면 목록에서 제외됨
  if (get().scopeKind === 'favorite' && !next) await fetchContacts()
}

/** 연락처 1건 vCard 다운로드 */
export async function exportOneVcard(contact: Contact) {
  await downloadApi(`/api/contacts/${contact.id}/vcard`, `${(contact.name || 'contact').replace(/[\\/:*?"<>|]/g, '_')}.vcf`)
}

export function setSearchQuery(q: string) {
  set({ searchQuery: q, currentPage: 0 })
  fetchContacts()
}

export function selectContact(contact: Contact) {
  set({ selectedContact: contact })
}

export async function createAddressBook(name: string) {
  try {
    await $fetch('/api/contacts/address-books', {
      method: 'POST',
      body: { name },
    })
    await fetchAddressBooks()
  } catch (e: any) {
    console.error('createAddressBook error:', e)
    throw e
  }
}

export async function deleteAddressBook(id: string) {
  try {
    await $fetch(`/api/contacts/address-books/${id}`, { method: 'DELETE' })
    if (get().selectedBookId === id) set({ selectedBookId: null })
    await fetchAddressBooks()
    await fetchContacts()
  } catch (e: any) {
    console.error('deleteAddressBook error:', e)
    // 실패를 무시하면 사용자가 삭제된 것으로 오인함
    addToast('error', i18n.t('contacts.error.bookDelete', '주소록을 삭제하지 못했습니다'))
  }
}

export async function createContact(data: {
  address_book_id: string
  name: string
  first_name?: string
  last_name?: string
  organization?: string
  emails?: TypedValue[]
  phones?: TypedValue[]
  addresses?: TypedValue[]
  notes?: string
  photo?: string | null
  is_favorite?: boolean
  groups?: string[]
  title?: string | null
}) {
  try {
    const result = await $fetch<Contact>('/api/contacts/', {
      method: 'POST',
      body: data,
    })
    await fetchContacts()
    fetchGroups()
    fetchCounts()
    return result
  } catch (e: any) {
    console.error('createContact error:', e)
    throw e
  }
}

export async function updateContact(id: string, data: Record<string, any>) {
  try {
    await $fetch(`/api/contacts/${id}`, {
      method: 'PATCH',
      body: data,
    })
    await fetchContacts()
    if (get().selectedContact?.id === id) {
      // 상세 갱신 — 범위에서 제외된 경우(그룹·즐겨찾기 해제) 서버에서 재조회
      const updated = get().contacts.find(c => c.id === id)
      if (updated) set({ selectedContact: updated })
      else {
        try { set({ selectedContact: await $fetch<Contact>(`/api/contacts/${id}`) }) } catch { /* 현재 값 유지 */ }
      }
    }
    if ('groups' in data) fetchGroups()
    if ('is_favorite' in data) fetchCounts()
  } catch (e: any) {
    console.error('updateContact error:', e)
    throw e
  }
}

export async function deleteContact(id: string) {
  try {
    await $fetch(`/api/contacts/${id}`, { method: 'DELETE' })
    set({ contacts: get().contacts.filter(c => c.id !== id) })
    if (get().selectedContact?.id === id) set({ selectedContact: null })
    fetchGroups()
    fetchCounts()
  } catch (e: any) {
    console.error('deleteContact error:', e)
    addToast('error', i18n.t('contacts.error.contactDelete', '연락처를 삭제하지 못했습니다'))
  }
}

export function openCreateModal() {
  set({ editingContact: null, showEditModal: true })
}

export function openEditModal(contact: Contact) {
  set({ editingContact: contact, showEditModal: true })
}

// ─── 가져오기 · 내보내기 (사이드바와 모바일 ⋯ 시트 공용) ───

export async function fetchExternalAccounts(): Promise<ExternalAccount[]> {
  try { return await $fetch<ExternalAccount[]>('/api/contacts/external-accounts') }
  catch { return [] }
}

export async function syncExternalAccount(acc: ExternalAccount) {
  const r = await $fetch<{ created: number; updated: number; address_book: string }>(
    `/api/contacts/external-accounts/${acc.id}/sync`, { method: 'POST' })
  await fetchAddressBooks()
  await fetchContacts()
  return r
}

/** vCard 가져오기 — 선택한 주소록(없으면 첫 주소록)으로 저장. 주소록이 없으면 null */
export async function importVcf(file: File): Promise<{ imported: number } | null> {
  const bookId = get().selectedBookId || get().addressBooks[0]?.id
  if (!bookId) return null
  const fd = new FormData()
  fd.append('file', file)
  const r = await $fetch<{ imported: number }>('/api/contacts/import-vcf', {
    method: 'POST', body: fd, params: { book_id: bookId },
  })
  await fetchAddressBooks()
  await fetchContacts()
  fetchGroups()
  fetchCounts()
  return r
}

/** vCard 내보내기 — 선택한 주소록(없으면 첫 주소록). 브라우저 다운로드로 위임 */
export function exportVcf(): boolean {
  const bookId = get().selectedBookId || get().addressBooks[0]?.id
  if (!bookId) return false
  const a = document.createElement('a')
  a.href = `/api/contacts/export-vcf?book_id=${encodeURIComponent(bookId)}`
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  return true
}

/** 이메일이 워크스페이스 사용자의 것이면 해당 user_id(채팅·통화 동작 줄 활성화 조건) */
export async function findWorkspaceUserId(email: string): Promise<string | null> {
  const e = email.trim().toLowerCase()
  if (!e) return null
  try {
    const list = await $fetch<SuggestItem[]>('/api/contacts/suggest', { params: { q: e, limit: 10 } })
    return list.find(x => x.email?.toLowerCase() === e && x.user_id)?.user_id ?? null
  } catch { return null }
}

export function closeModal() {
  set({ showEditModal: false, editingContact: null })
}

export async function nextPage() {
  if (contactsHasNextPage()) {
    set({ currentPage: get().currentPage + 1 })
    await fetchContacts()
  }
}

export async function prevPage() {
  if (contactsHasPrevPage()) {
    set({ currentPage: get().currentPage - 1 })
    await fetchContacts()
  }
}

/** hook 이 반환하는 동작 — 모듈 함수 그대로(참조 고정) */
const actions = {
  setSelectedContact,
  setSelectedBookId,
  setSortBy,
  setMobileMenuOpen,
  setShowEditModal,
  fetchAddressBooks,
  fetchContacts,
  selectBook,
  selectScope,
  fetchGroups,
  fetchCounts,
  toggleFavorite,
  exportOneVcard,
  setSearchQuery,
  selectContact,
  createAddressBook,
  deleteAddressBook,
  createContact,
  updateContact,
  deleteContact,
  openCreateModal,
  openEditModal,
  closeModal,
  fetchExternalAccounts,
  syncExternalAccount,
  importVcf,
  exportVcf,
  findWorkspaceUserId,
  nextPage,
  prevPage,
}

/**
 * 상태 + 동작. 상태 전체를 얕게 구독한다.
 * 상태 + computed(scope·scopeLabel·totalPages·hasNextPage·hasPrevPage) + 동작.
 */
export function useContacts() {
  const s = useStore(contactsStore, useShallow((st: ContactsState) => st))
  const { t } = useI18n()
  return {
    ...s,
    scope: contactsScope(s),
    scopeLabel: contactsScopeLabel(s, k => t(k)),
    totalPages: contactsTotalPages(s),
    hasNextPage: contactsHasNextPage(s),
    hasPrevPage: contactsHasPrevPage(s),
    ...actions,
  }
}
