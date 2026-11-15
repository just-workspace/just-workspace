/**
 * 채팅 역할·권한 어댑터(r24 백엔드 app/chat/roles.py · permissions.py — 계약 docs/chat-permissions.md).
 * 역할·권한 API 는 프런트에서 **여기서만** 부른다. 화면(멤버 열·자동완성·프로필·설정)은 이 store 를 읽는다.
 *
 * - 역할 색: 서버는 팔레트 토큰 키 8개(permissions.ROLE_COLOR_TOKENS, 순서 고정)로 저장한다.
 *   순서 i → --role-(i+1)(= cat-(i+1)) 로 그린다(handover-22 §5.3 "기존 cat-1…8 재사용"). roleColorIndex 한 곳.
 * - 실패(엔진 legacy·네트워크)면 "역할 없음"으로 떨어진다: 목록 비움, 관리 권한 = 전역 관리자만.
 * - 실시간 갱신: 서버가 chat_roles_changed 이벤트를 보내면 handleRolesEvent 가 다시 읽는다.
 *
 * React: const roles = useStore(chatRolesStore, s => s.roles); await loadRoles()
 */
import { createStore, useStore } from 'zustand'
import { $fetch } from '~/lib/api'
import { authStore } from '~/composables/useAuth'

const B = '/api/chat'

/** 서버 ROLE_COLOR_TOKENS 와 같은 순서 — 바꾸면 색이 섞인다 */
export const ROLE_COLOR_KEYS = [
  'primary', 'accent', 'success', 'warning', 'danger', 'destructive', 'muted-foreground', 'foreground',
] as const
export type RoleColorKey = typeof ROLE_COLOR_KEYS[number]

/** 토큰 키 → 1…8 (모르는 값·null = 0 = 색 없음). 'cat-N'·'role-N' 도 받는다 */
export function roleColorIndex(key: string | null | undefined): number {
  if (!key) return 0
  const m = /^(?:cat|role)-([1-8])$/.exec(key)
  if (m) return Number(m[1])
  const i = (ROLE_COLOR_KEYS as readonly string[]).indexOf(key)
  return i >= 0 ? i + 1 : 0
}
/** 이름 글자 클래스(text-role-N) — 색 없음이면 '' */
export function roleTextClass(key: string | null | undefined): string {
  const n = roleColorIndex(key)
  return n ? `text-role-${n}` : ''
}
/** 칩 바탕(bg-role-N/15) — 색 없음이면 muted */
export function roleChipClass(key: string | null | undefined): string {
  const n = roleColorIndex(key)
  return n ? `bg-role-${n}/15 text-role-${n}` : 'bg-muted text-foreground'
}
/** Tailwind 가 동적 클래스를 못 찾으니 전체 목록을 소스에 둔다(글롭 수집용) */
export const ROLE_CLASS_SAFELIST = [
  'text-role-1', 'text-role-2', 'text-role-3', 'text-role-4', 'text-role-5', 'text-role-6', 'text-role-7', 'text-role-8',
  'bg-role-1/15', 'bg-role-2/15', 'bg-role-3/15', 'bg-role-4/15', 'bg-role-5/15', 'bg-role-6/15', 'bg-role-7/15', 'bg-role-8/15',
  'bg-role-1/30', 'bg-role-2/30', 'bg-role-3/30', 'bg-role-4/30', 'bg-role-5/30', 'bg-role-6/30', 'bg-role-7/30', 'bg-role-8/30',
  'bg-role-1', 'bg-role-2', 'bg-role-3', 'bg-role-4', 'bg-role-5', 'bg-role-6', 'bg-role-7', 'bg-role-8',
]

export interface ChatRole {
  id: string
  name: string
  color: string | null
  icon: string | null
  /** 높을수록 위. @everyone = 0 */
  position: number
  permissions: number
  permission_names: string[]
  hoist: boolean
  mentionable: boolean
  /** 그룹과 연결된 역할 — 멤버는 그룹에서 계산, 멤버 탭 잠김 */
  managed: boolean
  group_id: string | null
  is_default: boolean
  /** @멘션 키(공백 → '-', 소문자). @everyone 은 null */
  mention: string | null
  member_count?: number
}

export interface PermissionDef { name: string; value: number; dangerous: boolean }
export interface PermissionCatalog {
  permissions: PermissionDef[]
  groups: Record<'general' | 'members' | 'text' | 'voice', string[]>
  default_everyone: number
  color_tokens: string[]
  mode: 'legacy' | 'shadow' | 'enforce'
}

export interface RoleMemberGroup {
  role: ChatRole | null
  members: Array<{ user_id: string; username: string; display_name: string | null; avatar_url: string | null; role: string; is_online?: boolean; roles: string[]; color: string | null }>
}

/** 권한 비트 — 서버 permissions.py 와 같은 값(BigInt 아님: 1<<40 까지라 Number 로 안전) */
export const PERM = {
  VIEW_CHANNEL: 2 ** 0, SEND_MESSAGES: 2 ** 1, SEND_IN_THREADS: 2 ** 2, CREATE_THREADS: 2 ** 3, READ_HISTORY: 2 ** 4,
  EMBED_LINKS: 2 ** 5, ATTACH_FILES: 2 ** 6, ADD_REACTIONS: 2 ** 7, USE_EXTERNAL_EMOJI: 2 ** 8, MENTION_EVERYONE: 2 ** 9,
  MANAGE_MESSAGES: 2 ** 10, PIN_MESSAGES: 2 ** 11, MANAGE_THREADS: 2 ** 12, MANAGE_CHANNELS: 2 ** 13, MANAGE_ROLES: 2 ** 14,
  MANAGE_EXPRESSIONS: 2 ** 15, MANAGE_WEBHOOKS: 2 ** 16, CREATE_INVITE: 2 ** 17, KICK_MEMBERS: 2 ** 18,
  MODERATE_MEMBERS: 2 ** 19, VIEW_AUDIT_LOG: 2 ** 20, BYPASS_SLOWMODE: 2 ** 21, SEND_POLLS: 2 ** 22, USE_COMMANDS: 2 ** 23,
  CONNECT: 2 ** 24, SPEAK: 2 ** 25, STREAM: 2 ** 26, USE_VAD: 2 ** 27, PRIORITY_SPEAKER: 2 ** 28, MUTE_MEMBERS: 2 ** 29,
  DEAFEN_MEMBERS: 2 ** 30, MOVE_MEMBERS: 2 ** 31, USE_SOUNDBOARD: 2 ** 32, REQUEST_TO_SPEAK: 2 ** 33, ADMINISTRATOR: 2 ** 40,
} as const
export type PermName = keyof typeof PERM
/** 비트 검사(32비트 넘는 값이라 & 연산자 대신 산술) */
export function hasBit(bits: number, bit: number): boolean {
  return Math.floor(bits / bit) % 2 === 1
}
export function withBit(bits: number, bit: number, on: boolean): number {
  const has = hasBit(bits, bit)
  return on ? (has ? bits : bits + bit) : (has ? bits - bit : bits)
}

interface ChatRolesState {
  roles: ChatRole[]
  loaded: boolean
  catalog: PermissionCatalog | null
  /** 워크스페이스 범위 내 권한(@everyone ∪ 내 역할) */
  myWorkspacePerms: number
  /** 채널 id → 내 실효 권한 */
  myChannelPerms: Record<string, number>
  /** 사용자 id → 역할 id 목록(높은 순) — 프로필·이름 색 */
  userRoles: Record<string, string[]>
  /** 채널 id → 멤버 역할 묶음 */
  memberGroups: Record<string, RoleMemberGroup[]>
  error: string | null
}

export const chatRolesStore = createStore<ChatRolesState>()(() => ({
  roles: [], loaded: false, catalog: null, myWorkspacePerms: 0, myChannelPerms: {}, userRoles: {}, memberGroups: {}, error: null,
}))
const S = () => chatRolesStore.getState()
const set = (p: Partial<ChatRolesState>) => chatRolesStore.setState(p)

const isAdmin = () => !!authStore.getState().user?.is_admin

export async function loadRoles(force = false) {
  if (S().loaded && !force) return S().roles
  try {
    const r = await $fetch<{ items: ChatRole[] }>(`${B}/roles`)
    set({ roles: Array.isArray(r?.items) ? r.items : [], loaded: true, error: null })
  } catch (e) {
    set({ roles: [], loaded: true, error: String((e as Error)?.message || e) })
  }
  return S().roles
}

export async function loadCatalog() {
  if (S().catalog) return S().catalog
  try { set({ catalog: await $fetch<PermissionCatalog>(`${B}/permissions/catalog`) }) } catch { /* 엔진 없음 */ }
  return S().catalog
}

export async function loadMyWorkspacePerms() {
  const me = authStore.getState().user?.id
  if (!me) return 0
  try {
    const r = await $fetch<{ permissions: number }>(`${B}/permissions/effective`, { query: { user_id: me } })
    set({ myWorkspacePerms: r.permissions })
  } catch { set({ myWorkspacePerms: 0 }) }
  return S().myWorkspacePerms
}

export async function loadMyChannelPerms(channelId: string) {
  try {
    const r = await $fetch<{ permissions: number }>(`${B}/channels/${channelId}/permissions/me`)
    set({ myChannelPerms: { ...S().myChannelPerms, [channelId]: r.permissions } })
  } catch { /* 모르면 지금 동작(멤버는 거의 다 됨) — canInChannel 이 기본값으로 판단 */ }
  return S().myChannelPerms[channelId]
}

/** 워크스페이스 범위 관리 권한(역할·채널·이모지 관리). 전역 관리자·ADMINISTRATOR 는 늘 됨 */
export function canWorkspace(bit: number, s: ChatRolesState = S()): boolean {
  if (isAdmin()) return true
  return hasBit(s.myWorkspacePerms, PERM.ADMINISTRATOR) || hasBit(s.myWorkspacePerms, bit)
}
/** 채널 안 권한. 아직 못 읽었으면 fallback(기본: @everyone 기본값 기준 — 멘션·첨부·리액션 됨, 관리 안 됨) */
export function canInChannel(channelId: string | null | undefined, bit: number, s: ChatRolesState = S()): boolean {
  if (isAdmin()) return true
  const bits = channelId ? s.myChannelPerms[channelId] : undefined
  if (bits == null) return canWorkspace(bit, s) || hasBit(s.catalog?.default_everyone ?? DEFAULT_EVERYONE_FALLBACK, bit)
  return hasBit(bits, PERM.ADMINISTRATOR) || hasBit(bits, bit)
}
// 서버 DEFAULT_EVERYONE 과 같다(catalog 를 못 읽었을 때)
const DEFAULT_EVERYONE_FALLBACK = [
  'VIEW_CHANNEL', 'SEND_MESSAGES', 'SEND_IN_THREADS', 'CREATE_THREADS', 'READ_HISTORY', 'EMBED_LINKS', 'ATTACH_FILES',
  'ADD_REACTIONS', 'USE_EXTERNAL_EMOJI', 'MENTION_EVERYONE', 'PIN_MESSAGES', 'CREATE_INVITE', 'SEND_POLLS', 'USE_COMMANDS',
  'CONNECT', 'SPEAK', 'STREAM', 'USE_VAD', 'USE_SOUNDBOARD', 'REQUEST_TO_SPEAK',
].reduce((a, n) => a + PERM[n as PermName], 0)

/** 계층: 내 최고 역할 위치(전역 관리자·ADMINISTRATOR = 무한) — 이보다 위 역할은 잠금 */
export function myTopPosition(s: ChatRolesState = S()): number {
  if (isAdmin() || hasBit(s.myWorkspacePerms, PERM.ADMINISTRATOR)) return Infinity
  const me = authStore.getState().user?.id
  const mine = (me && s.userRoles[me]) || []
  return Math.max(0, ...s.roles.filter(r => mine.includes(r.id)).map(r => r.position))
}

export async function loadUserRoles(userId: string) {
  try {
    const r = await $fetch<{ items: ChatRole[] }>(`${B}/users/${userId}/roles`)
    set({ userRoles: { ...S().userRoles, [userId]: r.items.map(x => x.id) } })
  } catch { /* 역할 없음 */ }
  return S().userRoles[userId] || []
}
export async function setUserRoles(userId: string, roleIds: string[]) {
  const r = await $fetch<{ items: ChatRole[] }>(`${B}/users/${userId}/roles`, { method: 'PUT', body: { role_ids: roleIds } })
  set({ userRoles: { ...S().userRoles, [userId]: r.items.map(x => x.id) } })
  void loadRoles(true)
}

export async function loadMemberGroups(channelId: string) {
  try {
    const r = await $fetch<{ groups: RoleMemberGroup[] }>(`${B}/channels/${channelId}/members/by-role`)
    const userRoles = { ...S().userRoles }
    for (const g of r.groups) for (const m of g.members) userRoles[m.user_id] = m.roles
    set({ memberGroups: { ...S().memberGroups, [channelId]: r.groups }, userRoles })
  } catch { /* 없으면 멤버 열은 온라인/오프라인만 */ }
  return S().memberGroups[channelId]
}

/** 사람의 이름 색 = 색이 있는 최고 역할 */
export function userRoleColor(userId: string, s: ChatRolesState = S()): string | null {
  const ids = s.userRoles[userId]
  if (!ids?.length) return null
  const roles = s.roles.filter(r => ids.includes(r.id) && r.color).sort((a, b) => b.position - a.position)
  return roles[0]?.color ?? null
}
export function rolesOfUser(userId: string, s: ChatRolesState = S()): ChatRole[] {
  const ids = s.userRoles[userId] || []
  return s.roles.filter(r => ids.includes(r.id)).sort((a, b) => b.position - a.position)
}

// ─── 관리(Settings22) ───
export type RoleInput = Partial<Pick<ChatRole, 'name' | 'color' | 'icon' | 'hoist' | 'mentionable' | 'group_id'>> & { permissions?: number }
export async function createRole(body: RoleInput & { name: string }) {
  const r = await $fetch<ChatRole>(`${B}/roles`, { method: 'POST', body })
  await loadRoles(true)
  return r
}
export async function updateRole(id: string, patch: RoleInput) {
  const r = await $fetch<ChatRole>(`${B}/roles/${id}`, { method: 'PATCH', body: patch })
  await loadRoles(true)
  return r
}
export async function deleteRole(id: string) {
  await $fetch(`${B}/roles/${id}`, { method: 'DELETE' })
  await loadRoles(true)
}
/** 위(높음) → 아래. @everyone 은 넣지 않는다 */
export async function reorderRoles(roleIds: string[]) {
  // 낙관적: 위치를 바로 바꿔 그린다
  const n = roleIds.length
  set({ roles: S().roles.map(r => { const i = roleIds.indexOf(r.id); return i >= 0 ? { ...r, position: n - i } : r }).sort((a, b) => b.position - a.position) })
  try { await $fetch(`${B}/roles/order`, { method: 'PUT', body: { role_ids: roleIds } }) } finally { await loadRoles(true) }
}
export interface RoleMember { user_id: string; username: string; display_name: string | null; avatar_url?: string | null }
export async function fetchRoleMembers(roleId: string) {
  return $fetch<{ items: RoleMember[]; managed: boolean }>(`${B}/roles/${roleId}/members`)
}
export async function addRoleMember(roleId: string, userId: string) {
  await $fetch(`${B}/roles/${roleId}/members/${userId}`, { method: 'PUT' })
}
export async function removeRoleMember(roleId: string, userId: string) {
  await $fetch(`${B}/roles/${roleId}/members/${userId}`, { method: 'DELETE' })
}
export async function syncGroupRoles(groupIds?: string[]) {
  await $fetch(`${B}/roles/sync-groups`, { method: 'POST', body: { group_ids: groupIds ?? null } })
  await loadRoles(true)
}

// ─── 덮어쓰기(채널·카테고리 권한 3단) ───
export type OverwriteTarget = 'channels' | 'categories'
export interface PermOverwrite { id?: string; subject_kind: 'role' | 'user'; subject_id: string; allow: number; deny: number }
export interface OverwriteList {
  overwrites: PermOverwrite[]
  /** 채널일 때 — 속한 카테고리의 덮어쓰기(동기화 banner 판단) */
  category_overwrites: PermOverwrite[]
  category_id: string | null
}
export async function fetchOverwrites(target: OverwriteTarget, id: string): Promise<OverwriteList> {
  const r = await $fetch<{ overwrites: PermOverwrite[]; category_overwrites?: PermOverwrite[]; category_id?: string | null }>(`${B}/${target}/${id}/permissions`)
  return { overwrites: r.overwrites || [], category_overwrites: r.category_overwrites || [], category_id: r.category_id ?? null }
}
/** 채널 덮어쓰기가 카테고리와 같은가(디스코드 "카테고리와 동기화됨") */
export function overwritesInSync(a: PermOverwrite[], b: PermOverwrite[]): boolean {
  const key = (o: PermOverwrite) => `${o.subject_kind}:${o.subject_id}:${o.allow}:${o.deny}`
  const A = a.filter(o => o.allow || o.deny).map(key).sort()
  const Bk = b.filter(o => o.allow || o.deny).map(key).sort()
  return A.length === Bk.length && A.every((k, i) => k === Bk[i])
}
export function putOverwrite(target: OverwriteTarget, id: string, kind: 'role' | 'user', subjectId: string, allow: number, deny: number) {
  return $fetch(`${B}/${target}/${id}/permissions/${kind}/${subjectId}`, { method: 'PUT', body: { allow, deny } })
}
export function deleteOverwrite(target: OverwriteTarget, id: string, kind: 'role' | 'user', subjectId: string) {
  return $fetch(`${B}/${target}/${id}/permissions/${kind}/${subjectId}`, { method: 'DELETE' })
}
/** 3단 값 ← (allow, deny) */
export function triOf(o: Pick<PermOverwrite, 'allow' | 'deny'> | undefined, bit: number): 'allow' | 'deny' | 'inherit' {
  if (!o) return 'inherit'
  if (hasBit(o.deny, bit)) return 'deny'
  if (hasBit(o.allow, bit)) return 'allow'
  return 'inherit'
}
export function applyTri(o: Pick<PermOverwrite, 'allow' | 'deny'>, bit: number, v: 'allow' | 'deny' | 'inherit') {
  return { allow: withBit(o.allow, bit, v === 'allow'), deny: withBit(o.deny, bit, v === 'deny') }
}

// ─── 채팅 정책(전역 관리자만 바꾼다) ───
export interface ChatPolicy {
  /** 전역 관리자의 채널 안 특권(DM·비공개 채널 열람 포함). 기본 off */
  admin_channel_privileges: boolean
  /** 채널 owner 에게 남의 글 삭제(MANAGE_MESSAGES). 기본 off */
  owner_manage_messages: boolean
  can_edit: boolean
}
export function fetchChatPolicy() { return $fetch<ChatPolicy>(`${B}/policy`) }
export function updateChatPolicy(patch: Partial<Omit<ChatPolicy, 'can_edit'>>) {
  return $fetch<ChatPolicy>(`${B}/policy`, { method: 'PUT', body: patch })
}

/** WS 이벤트(chat_roles_changed · chat_member_roles_changed) — useChat.handleWSMessage 가 넘긴다 */
export function handleRolesEvent(data: { type?: string; channel_id?: string }) {
  if (data.type === 'chat_roles_changed' || data.type === 'chat_member_roles_changed') {
    void loadRoles(true)
    void loadMyWorkspacePerms()
    set({ myChannelPerms: {}, memberGroups: {} })
  }
}

export function useChatRoles<T>(sel: (s: ChatRolesState) => T): T {
  return useStore(chatRolesStore, sel)
}
