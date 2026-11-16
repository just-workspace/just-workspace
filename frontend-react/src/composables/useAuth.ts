/**
 * 인증(세션 쿠키 + 번들 앱 ws_token + 2단계 인증).
 *
 * React: const { user, loading, fetchUser, nativeLogin, verify2fa, logout, ... } = useAuth()
 *   user 는 값(User | null)
 * 컴포넌트 밖: authStore.getState().user, 또는 아래 함수들을 직접 import
 *
 * 앱 시작 시 main.tsx 가 fetchUser() 를 await 한 뒤 라우터를 기동한다.
 */
import { createStore, useStore } from 'zustand'
import { $fetch } from '~/lib/api'
import { navigateTo } from '~/lib/router'
import { storeSessionToken } from '~/lib/runtimeConfig'

export interface User {
  id: string
  username: string
  display_name: string | null
  email: string | null
  primary_email: string | null
  avatar_url: string | null
  recovery_email: string | null
  is_admin: boolean
  last_login_at: string | null
  has_2fa?: boolean
  password_changed_at?: string | null
  /** 관리자 정책상 2단계 인증이 필수이나 아직 미등록 — auth 가드가 설정 › 보안으로 이동시킨다 */
  totp_setup_required?: boolean
}

export const authStore = createStore<{ user: User | null; loading: boolean }>()(() => ({
  user: null,
  loading: true,
}))

/** 로그아웃 직전에 호출할 정리 함수들(예: 앱 전체 실시간 소켓 닫기 — useChat 이 등록) */
const beforeLogout = new Set<() => void>()
export function onBeforeLogout(fn: () => void): () => void {
  beforeLogout.add(fn)
  return () => beforeLogout.delete(fn)
}

function httpStatus(e: unknown): number | undefined {
  const x = e as { statusCode?: number; status?: number; response?: { status?: number } } | null
  return x?.statusCode ?? x?.status ?? x?.response?.status
}

// 로그인 여부 미확정 — /api/auth/me 가 401 이 아닌 오류(429·5xx·네트워크)로 실패했고 기존에 파악된 사용자도 없다.
// 이 경우 가드(router/guards)가 다음 이동에서 재확인하고, 본 모듈에서도 사용자 통지 없이 수 회 재조회한다.
let _uncertain = false
let _retryTimer: ReturnType<typeof setTimeout> | null = null
let _retries = 0
const MAX_RETRIES = 5
export function authUncertain(): boolean { return _uncertain }
function scheduleRetry() {
  if (_retryTimer || _retries >= MAX_RETRIES || typeof window === 'undefined') return
  _retryTimer = setTimeout(() => { _retryTimer = null; _retries++; void fetchUser() }, 2000 * (_retries + 1))
}
function settle() {
  _uncertain = false
  _retries = 0
  if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null }
}
/** 테스트용 */
export function _resetAuthProbe() { settle(); _confirming = false }

/**
 * 내 정보를 조회하여 로그인 상태를 동기화한다. **401 만 "로그인 안 됨"** 이다.
 * 이전에는 모든 오류에서 user 를 비워, 기본 요청 한도(429)나 서버 재시작(5xx)·네트워크 단절 1회만으로
 * 로그인이 유효한데도 로그인 화면으로 이동되었다. 이러한 일시 오류에서는 기존 상태를 유지한다.
 */
/** 진행 중인 확인 — 중복 호출 시 동일 결과를 대기한다(가드가 "확인 중"인 순간을 그대로 통과하지 않도록) */
let _fetching: Promise<void> | null = null
export function fetchUser(): Promise<void> {
  if (_fetching) return _fetching
  _fetching = fetchUserOnce().finally(() => { _fetching = null })
  return _fetching
}
async function fetchUserOnce() {
  try {
    authStore.setState({ loading: true })
    const data = await $fetch<User>('/api/auth/me', { credentials: 'include' })
    settle()
    authStore.setState({ user: data })
  } catch (e) {
    if (httpStatus(e) === 401) {
      settle()
      authStore.setState({ user: null })
    } else if (!authStore.getState().user) {
      _uncertain = true
      scheduleRetry()
    }
  } finally {
    authStore.setState({ loading: false })
  }
}

// ── 사용 도중 세션이 끊겼을 때(웹) ──
// lib/api 가 401(또는 2단계 필수 403)을 수신하면 AUTH_LOST_EVENT 를 발생시킨다. 이름은 lib/api 의 상수와 동일하다
// (해당 모듈을 통째로 대체하는 테스트가 많아 상수를 import 하지 않는다).
const AUTH_LOST_EVENT = 'jw:auth-lost'
/** 로그인 없이 사용하는 화면 — 여기서는 세션이 끊겨도 로그인으로 이동시키지 않는다(router/guards 의 공개 경로와 동일한 의미) */
const GUEST_PAGES = ['/setup', '/login', '/register', '/forgot-password', '/reset-password', '/verify-email', '/consent']
export function isGuestPath(path: string, search = ''): boolean {
  return GUEST_PAGES.includes(path)
    || path.startsWith('/s/') || path.startsWith('/meetings/join/') || path.startsWith('/meetings/room/')
    || search.includes('share=')
}

let _confirming = false
/**
 * 로그인 상태로 사용하던 중 임의의 요청이 401 을 수신한 경우. 로그인 전(로그인 시도 자체·부팅 확인)의 401 은 대상이 아니다 —
 * user 가 없으면 아무 동작도 하지 않으므로 로그인 화면과의 상호 리다이렉트가 발생하지 않는다.
 * 401 을 다른 의미로 사용하는 요청이 있으므로 /api/auth/me 로 1회 확인하고, 그 응답도 401 일 때만 세션 종료로 판정한다
 * (429·5xx·네트워크 오류이면 상태를 유지한다).
 */
export async function handleAuthLost(kind: 'unauthorized' | 'totp'): Promise<void> {
  if (_confirming || !authStore.getState().user) return
  _confirming = true
  try {
    await fetchUser()
    const user = authStore.getState().user
    const { pathname, search } = window.location
    if (!user) {
      for (const fn of beforeLogout) { try { fn() } catch { /* ignore */ } }
      if (!isGuestPath(pathname, search)) {
        void navigateTo(`/login?redirect=${encodeURIComponent(pathname + search)}`)
      }
    } else if (kind === 'totp' && user.totp_setup_required && pathname !== '/settings/security') {
      // 관리자 정책(2단계 인증 필수)이 사용 도중 활성화됨 — 등록 화면으로 이동
      void navigateTo('/settings/security?enroll=1')
    }
  } finally {
    _confirming = false
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener(AUTH_LOST_EVENT, (ev) => {
    const kind = (ev as CustomEvent<{ kind?: string }>).detail?.kind
    void handleAuthLost(kind === 'totp' ? 'totp' : 'unauthorized')
  })
}

export interface LoginResult { token?: string; requires_2fa?: boolean; temp_token?: string }

/**
 * 아이디·비밀번호 로그인. 2단계 인증이 활성화된 계정이면 세션 대신 `{ requires_2fa, temp_token }` 을 반환하고
 * 세션은 verify2fa 에서 생성한다(백엔드 /api/auth/login → /2fa/verify). 그 외에는 세션을 생성하고 사용자 정보를 조회한다.
 */
export async function nativeLogin(username: string, password: string, rememberMe: boolean = false): Promise<LoginResult> {
  const res = await $fetch<LoginResult>('/api/auth/login', {
    method: 'POST',
    body: { username, password, remember_me: rememberMe },
  })
  if (res?.requires_2fa) return res
  // 번들 앱만 토큰 저장 후 Bearer 사용(쿠키가 cross-origin 으로 전달되지 않음). 웹은 httpOnly 쿠키만 사용 — 잔존 값도 삭제한다
  storeSessionToken(res?.token)
  await fetchUser()
  return res ?? {}
}

/** 2단계 인증 코드 확인 — nativeLogin 이 반환한 temp_token 과 인증 앱 코드로 세션을 생성한다. */
export async function verify2fa(tempToken: string, code: string): Promise<void> {
  const res = await $fetch<{ token?: string }>('/api/auth/2fa/verify', {
    method: 'POST',
    body: { temp_token: tempToken, code },
  })
  storeSessionToken(res?.token)
  await fetchUser()
}

export async function logout() {
  // 앱 전체가 사용하던 실시간 소켓을 닫는다 — 다음 사용자에게 이전 사용자의 이벤트가 전달되지 않도록 함
  for (const fn of beforeLogout) { try { fn() } catch { /* ignore */ } }
  // 이 브라우저의 푸시 구독을 먼저 해제한다(아직 로그인 상태이므로 서버에서도 삭제된다) — 해제하지 않으면 다음 사용자에게 이전 사용자의 알림이 표시된다
  await import('~/composables/usePwa').then(m => m.releasePushOnLogout()).catch(() => {})
  await $fetch('/api/auth/logout', { method: 'POST' })
  try { localStorage.removeItem('ws_token') } catch { /* ignore */ }
  authStore.setState({ user: null })
  void navigateTo('/login')
}

export async function register(data: {
  username: string
  password: string
  display_name: string
  recovery_email: string
  /** 관리자 초대 링크(/register?invite=…)로 진입한 경우의 토큰 — 승인 없이 즉시 활성화 */
  invite_token?: string
}): Promise<{ message: string; invited?: boolean }> {
  return await $fetch('/api/auth/register', { method: 'POST', body: data })
}

/** 프로필(표시 이름). 복구 이메일은 여기서 변경 불가 — 아래 requestRecoveryEmailChange 절차로만 가능(서버가 400 반환). */
export async function updateProfile(data: { display_name?: string; recovery_email?: string }): Promise<void> {
  await $fetch('/api/auth/profile', { method: 'PATCH', body: data })
  await fetchUser()
}

// ── 복구 이메일 변경: 본인 확인 → 새 주소로 확인 링크 → 링크를 눌러야 실제로 변경된다 ──
/** 본인 확인 수단 — password(현재 비밀번호) · totp(비밀번호 확인이 불가한 계정: 인증 앱 코드) · none(직접 변경 불가) */
export type RecoveryReauth = 'password' | 'totp' | 'none'
export interface RecoveryEmailPending { pending_email: string | null; expires_in: number; reauth: RecoveryReauth }

export async function getRecoveryEmailPending(): Promise<RecoveryEmailPending> {
  return await $fetch<RecoveryEmailPending>('/api/auth/recovery-email/pending')
}

/**
 * 새 주소로 확인 메일을 송신한다. 이 시점에는 아직 변경되지 않는다.
 * 빈 주소는 "복구 이메일 비우기" — 확인할 새 주소가 없으므로 본인 확인만으로 즉시 비워지고(cleared) 사용자 정보를 재조회한다.
 */
export async function requestRecoveryEmailChange(
  email: string, proof: { current_password?: string; code?: string },
): Promise<{ message: string; pending_email: string | null; expires_in: number; cleared?: boolean }> {
  const res = await $fetch<{ message: string; pending_email: string | null; expires_in: number; cleared?: boolean }>(
    '/api/auth/recovery-email/request', { method: 'POST', body: { recovery_email: email, ...proof } })
  if (res?.cleared) await fetchUser()
  return res
}

/** 확인 링크의 상태(토큰을 소비하지 않고 조회만) — pending(확인 대기) · done(이미 적용) · invalid(만료·폐기) */
export async function checkRecoveryEmailLink(token: string): Promise<{ state: 'pending' | 'done' | 'invalid' }> {
  return await $fetch('/api/auth/recovery-email/check', { method: 'POST', body: { token } })
}

export async function cancelRecoveryEmailChange(): Promise<void> {
  await $fetch('/api/auth/recovery-email/pending', { method: 'DELETE' })
}

/** 확인 화면(/verify-email?change=…)에서 사용자가 확인 버튼을 누른 경우 — 로그인 없이도 가능하다(다른 기기에서 메일을 연 경우). */
export async function confirmRecoveryEmailChange(token: string): Promise<{ message: string }> {
  const res = await $fetch<{ message: string }>('/api/auth/recovery-email/confirm', { method: 'POST', body: { token } })
  // 이 브라우저에 로그인된 상태이면 설정 화면에 새 주소가 즉시 표시되도록 재조회
  if (authStore.getState().user) await fetchUser()
  return res
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await $fetch('/api/auth/change-password', {
    method: 'POST',
    body: { current_password: currentPassword, new_password: newPassword },
  })
}

export async function forgotPassword(username: string): Promise<{ message: string }> {
  return await $fetch('/api/auth/forgot-password', { method: 'POST', body: { username } })
}

export async function uploadAvatar(file: File): Promise<void> {
  const formData = new FormData()
  formData.append('file', file)
  await $fetch('/api/auth/avatar', { method: 'POST', body: formData })
  await fetchUser()
}

/** 사용자 상태를 직접 변경할 때 사용(예: 테스트, 프로필 응답 반영) */
export function setUser(user: User | null) {
  authStore.setState({ user })
}

export function useAuth() {
  const user = useStore(authStore, s => s.user)
  const loading = useStore(authStore, s => s.loading)
  return {
    user,
    loading,
    fetchUser,
    nativeLogin,
    verify2fa,
    logout,
    register,
    updateProfile,
    changePassword,
    forgotPassword,
    uploadAvatar,
  }
}
