/**
 * 관리 › 사용자 화면의 순수 로직(화면 조각과 테스트가 같이 쓴다).
 */
import type { UiMenuItem } from '~/components/ui/Menu'

type T = (key: string, params?: any) => string

export type UserStatus = 'active' | 'pending' | 'suspended'

export interface AdminUser {
  id: string
  username: string
  display_name: string | null
  email: string | null
  recovery_email: string | null
  is_admin: boolean
  is_active: boolean
  email_verified?: boolean
  created_at: string | null
  last_login_at?: string | null
  status?: UserStatus
  groups?: { id: string; name: string }[]
  avatar_url?: string | null
  /** 2단계 인증을 켠 사용자 — "2단계 인증 초기화" 메뉴를 이때만 보인다 */
  has_2fa?: boolean
}

export interface AdminUserGroup { id: string; name: string }

export interface AdminSessionInfo { sid: string; ip: string; hostname: string; ua: string; created: number; last_seen: number }

export type UserSortKey = 'name' | 'last'

export const PAGE_SIZE = 50

/** 상태 → 배지 문구·톤 */
export function statusMeta(t: T): Record<UserStatus, { label: string; tone: 'success' | 'warning' | 'danger' }> {
  return {
    active: { label: t('common.status.active'), tone: 'success' },
    pending: { label: t('admin.users.tabs.pending'), tone: 'warning' },
    suspended: { label: t('admin.users.statusSuspended'), tone: 'danger' },
  }
}

/** 서버 status 가 기준. 예전 서버(필드 없음)면 로그인 이력으로 가른다. */
export function statusOf(u: AdminUser): UserStatus {
  return u.status ?? (u.is_active ? 'active' : u.last_login_at ? 'suspended' : 'pending')
}
export const nameOf = (u: { display_name?: string | null; username: string }) => u.display_name || u.username
export const initialOf = (u: AdminUser) => nameOf(u).charAt(0).toUpperCase()
export const groupNames = (u: AdminUser) => (u.groups || []).map(g => g.name).join(', ')

/** 서버 정렬 값: name → display_name, last → last_login_at, 내림차순이면 앞에 '-' */
export function serverSort(key: UserSortKey, dir: 1 | -1): string {
  return (dir === -1 ? '-' : '') + (key === 'last' ? 'last_login_at' : 'display_name')
}

export interface UserFilters { q: string; pending: boolean; admin: boolean; suspended: boolean; group: string }

/** GET /api/admin/users 쿼리 */
export function userListParams(f: UserFilters, sort: string, page: number): Record<string, string | number> {
  const p: Record<string, string | number> = { sort, page, size: PAGE_SIZE }
  if (f.q) p.q = f.q
  const st = [f.pending && 'pending', f.suspended && 'suspended'].filter(Boolean) as string[]
  if (st.length) p.status = st.join(',')
  if (f.admin) p.role = 'admin'
  if (f.group) p.group = f.group
  return p
}

/** 열 머리를 누르면: 같은 열이면 방향 뒤집기, 다른 열이면 그 열로(마지막 접속은 내림차순부터) */
export function nextSort(cur: { key: UserSortKey; dir: 1 | -1 }, k: UserSortKey): { key: UserSortKey; dir: 1 | -1 } {
  if (cur.key === k) return { key: k, dir: cur.dir === 1 ? -1 : 1 }
  return { key: k, dir: k === 'last' ? -1 : 1 }
}

/** 행 ⋮ 메뉴 — 상태·본인 여부·이메일 확인 여부에 따라 */
export function userMenuItems(u: AdminUser, meId: string | undefined, t: T): UiMenuItem[] {
  const st = statusOf(u)
  const me = u.id === meId
  const items: UiMenuItem[] = []
  if (st === 'pending') {
    items.push({ key: 'approve', label: t('admin.users.approve'), icon: 'check' }, { key: 'reject', label: t('admin.users.menuRejectSignup'), icon: 'close', danger: true })
    if (u.email_verified === false) items.push({ key: 'resend', label: t('admin.users.resendVerification'), icon: 'send' })
    return items
  }
  if (st === 'active') {
    if (!me) items.push({ key: 'role', label: u.is_admin ? t('admin.users.revokeAdmin') : t('admin.users.makeAdmin'), icon: 'shield' })
    items.push({ key: 'sessions', label: t('admin.users.viewSessions'), icon: 'monitor' }, { key: 'logout', label: t('admin.users.logoutEverywhere'), icon: 'log-out' })
  }
  items.push({ key: 'reset', label: t('admin.users.resetLink'), icon: 'link' })
  // 인증 앱도 복구 코드도 잃어버린 사람을 구제하는 길(본인은 코드가 있어야만 끌 수 있다)
  if (u.has_2fa) items.push({ key: 'reset2fa', label: t('admin.users.reset2fa', '2단계 인증 초기화'), icon: 'shield' })
  if (u.email_verified === false) items.push({ key: 'resend', label: t('admin.users.resendVerification'), icon: 'send' })
  if (st === 'active' && !me) items.push({ key: 'suspend', label: t('admin.users.statusSuspended'), icon: 'lock', danger: true })
  if (st === 'suspended') items.push({ key: 'approve', label: t('admin.users.reactivate'), icon: 'check' })
  if (!me) items.push({ key: 'delete', label: t('admin.users.delete.menu'), icon: 'trash', danger: true })
  return items
}

/** UA 문자열 → "Chrome on Windows" */
export function deviceHint(ua: string, t: T): string {
  if (!ua) return t('admin.users.unknownDevice')
  const b = ua.match(/Firefox|Edg|Chrome|Safari|curl/i)
  const os = /Windows/i.test(ua) ? 'Windows' : /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iOS/i.test(ua) ? 'iOS' : /Mac/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : ''
  const name = b ? (b[0] === 'Edg' ? 'Edge' : b[0]) : ua.slice(0, 16)
  return os ? `${name} on ${os}` : name
}

/** 마지막 접속: 2분 안 "방금" · 오늘 HH:mm · 어제 · MM/DD · 없으면 — */
export function fmtLast(iso: string | null | undefined, t: T, now = new Date()): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const mins = Math.floor((now.getTime() - d.getTime()) / 60000)
  if (mins < 2) return t('admin.users.justNow')
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return t('common.yesterday')
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

/** 세션 시각(유닉스 초) → MM. DD. HH:mm */
export function fmtTs(ts: number): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

/** 페이지 범위 글자 "1–50 / 1,234" (0이면 '0') */
export function rangeText(page: number, total: number): string {
  return total
    ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} / ${total.toLocaleString()}`
    : '0'
}
