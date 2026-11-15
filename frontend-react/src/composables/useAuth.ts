/**
 * 인증(세션 쿠키 + 번들 앱 ws_token + 2단계 인증).
 *
 * React: const { user, loading, fetchUser, nativeLogin, verify2fa, logout, ... } = useAuth()
 *   user 는 값(User | null)
 * 컴포넌트 밖: authStore.getState().user, 또는 아래 함수들을 직접 import
 *
 * 앱 시작 때 main.tsx 가 fetchUser() 를 await 한 뒤 라우터를 띄운다.
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
  /** 관리자 정책상 2단계 인증 필수인데 아직 등록 전 — auth 가드가 설정 › 보안으로 보낸다 */
  totp_setup_required?: boolean
}

export const authStore = createStore<{ user: User | null; loading: boolean }>()(() => ({
  user: null,
  loading: true,
}))

/** 로그아웃 직전에 부를 정리 함수들(예: 앱 전체 실시간 소켓 닫기 — useChat 이 등록) */
const beforeLogout = new Set<() => void>()
export function onBeforeLogout(fn: () => void): () => void {
  beforeLogout.add(fn)
  return () => beforeLogout.delete(fn)
}

function httpStatus(e: unknown): number | undefined {
  const x = e as { statusCode?: number; status?: number; response?: { status?: number } } | null
  return x?.statusCode ?? x?.status ?? x?.response?.status
}

// 로그인 여부를 아직 모른다 — /api/auth/me 가 401 이 아닌 오류(429·5xx·네트워크)로 실패했고 알고 있던 사용자도 없다.
// 가드(router/guards)가 이때는 다음 이동에서 다시 확인하고, 여기서도 몇 번 조용히 다시 묻는다.
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
 * 내 정보를 읽어 로그인 상태를 맞춘다. **401 만 "로그인 안 됨"** 이다.
 * 예전엔 어떤 오류든 user 를 비워서, 기본 요청 한도(429)나 서버 재시작(5xx)·네트워크 끊김 한 번에
 * 로그인이 살아 있는데도 로그인 화면으로 튕겼다. 그런 일시 오류는 알고 있던 상태를 그대로 둔다.
 */
/** 진행 중인 확인 — 겹쳐 부르면 같은 결과를 기다린다(가드가 "확인 중"인 순간을 그냥 통과하지 않게) */
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

// ── 쓰는 도중 세션이 끊겼을 때(웹) ──
// lib/api 가 401(또는 2단계 필수 403)을 받으면 AUTH_LOST_EVENT 를 낸다. 이름은 lib/api 의 상수와 같다
// (그 모듈을 통째로 대체하는 테스트가 많아 상수를 import 하지 않는다).
const AUTH_LOST_EVENT = 'jw:auth-lost'
/** 로그인 없이 쓰는 화면 — 여기서는 세션이 끊겨도 로그인으로 보내지 않는다(router/guards 의 공개 경로와 같은 뜻) */
const GUEST_PAGES = ['/setup', '/login', '/register', '/forgot-password', '/reset-password', '/verify-email', '/consent']
export function isGuestPath(path: string, search = ''): boolean {
  return GUEST_PAGES.includes(path)
    || path.startsWith('/s/') || path.startsWith('/meetings/join/') || path.startsWith('/meetings/room/')
    || search.includes('share=')
}

let _confirming = false
/**
 * 로그인해 쓰던 중 어떤 요청이 401 을 받았다. 로그인 전(로그인 시도 자체·부팅 확인)의 401 은 대상이 아니다 —
 * user 가 없으면 아무것도 하지 않으므로 로그인 화면과 서로 튕기지 않는다.
 * 401 을 다른 뜻으로 쓰는 요청이 있으므로 /api/auth/me 로 한 번 확인하고, 그것도 401 일 때만 세션이 끝난 것으로 본다
 * (429·5xx·네트워크 오류면 그대로 둔다).
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
      // 관리자 정책(2단계 인증 필수)이 쓰는 도중 켜졌다 — 등록 화면으로
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
 * 아이디·비밀번호 로그인. 2단계 인증이 켜진 계정이면 세션 대신 `{ requires_2fa, temp_token }` 을 돌려주고
 * 세션은 verify2fa 에서 만든다(백엔드 /api/auth/login → /2fa/verify). 그 외엔 세션을 만들고 사용자 정보를 읽는다.
 */
export async function nativeLogin(username: string, password: string, rememberMe: boolean = false): Promise<LoginResult> {
  const res = await $fetch<LoginResult>('/api/auth/login', {
    method: 'POST',
    body: { username, password, remember_me: rememberMe },
  })
  if (res?.requires_2fa) return res
  // 번들 앱만 토큰 저장 후 Bearer(쿠키가 cross-origin 으로 안 흐름). 웹은 httpOnly 쿠키만 — 남은 값도 지운다
  storeSessionToken(res?.token)
  await fetchUser()
  return res ?? {}
}

/** 2단계 인증 코드 확인 — nativeLogin 이 돌려준 temp_token 과 인증 앱 코드로 세션을 만든다. */
export async function verify2fa(tempToken: string, code: string): Promise<void> {
  const res = await $fetch<{ token?: string }>('/api/auth/2fa/verify', {
    method: 'POST',
    body: { temp_token: tempToken, code },
  })
  storeSessionToken(res?.token)
  await fetchUser()
}

export async function logout() {
  // 앱 전체가 쓰던 실시간 소켓을 닫는다 — 다음 사용자에게 이전 사용자의 이벤트가 가지 않게
  for (const fn of beforeLogout) { try { fn() } catch { /* ignore */ } }
  // 이 브라우저의 푸시 구독을 먼저 푼다(아직 로그인 상태라 서버에서도 지워진다) — 안 풀면 다음 사람에게 내 알림이 뜬다
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
  /** 관리자 초대 링크(/register?invite=…)로 왔으면 그 토큰 — 승인 없이 바로 활성 */
  invite_token?: string
}): Promise<{ message: string; invited?: boolean }> {
  return await $fetch('/api/auth/register', { method: 'POST', body: data })
}

/** 프로필(표시 이름). 복구 이메일은 여기서 못 바꾼다 — 아래 requestRecoveryEmailChange 절차로만(서버가 400). */
export async function updateProfile(data: { display_name?: string; recovery_email?: string }): Promise<void> {
  await $fetch('/api/auth/profile', { method: 'PATCH', body: data })
  await fetchUser()
}

// ── 복구 이메일 변경: 본인 확인 → 새 주소로 확인 링크 → 링크를 눌러야 실제로 바뀐다 ──
/** 본인 확인 수단 — password(현재 비밀번호) · totp(비밀번호를 확인할 수 없는 계정: 인증 앱 코드) · none(직접 못 바꿈) */
export type RecoveryReauth = 'password' | 'totp' | 'none'
export interface RecoveryEmailPending { pending_email: string | null; expires_in: number; reauth: RecoveryReauth }

export async function getRecoveryEmailPending(): Promise<RecoveryEmailPending> {
  return await $fetch<RecoveryEmailPending>('/api/auth/recovery-email/pending')
}

/**
 * 새 주소로 확인 메일을 보낸다. 이 시점에는 아직 바뀌지 않는다.
 * 빈 주소는 "복구 이메일 비우기" — 확인할 새 주소가 없으니 본인 확인만으로 바로 비워지고(cleared) 사용자 정보를 다시 읽는다.
 */
export async function requestRecoveryEmailChange(
  email: string, proof: { current_password?: string; code?: string },
): Promise<{ message: string; pending_email: string | null; expires_in: number; cleared?: boolean }> {
  const res = await $fetch<{ message: string; pending_email: string | null; expires_in: number; cleared?: boolean }>(
    '/api/auth/recovery-email/request', { method: 'POST', body: { recovery_email: email, ...proof } })
  if (res?.cleared) await fetchUser()
  return res
}

/** 확인 링크의 상태(토큰을 쓰지 않고 보기만) — pending(확인 대기) · done(이미 적용) · invalid(만료·폐기) */
export async function checkRecoveryEmailLink(token: string): Promise<{ state: 'pending' | 'done' | 'invalid' }> {
  return await $fetch('/api/auth/recovery-email/check', { method: 'POST', body: { token } })
}

export async function cancelRecoveryEmailChange(): Promise<void> {
  await $fetch('/api/auth/recovery-email/pending', { method: 'DELETE' })
}

/** 확인 화면(/verify-email?change=…)에서 사용자가 확인 버튼을 눌렀을 때 — 로그인 없이도 된다(다른 기기에서 메일을 연 경우). */
export async function confirmRecoveryEmailChange(token: string): Promise<{ message: string }> {
  const res = await $fetch<{ message: string }>('/api/auth/recovery-email/confirm', { method: 'POST', body: { token } })
  // 이 브라우저에 로그인돼 있으면 설정 화면이 새 주소를 바로 보이게
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

/** 사용자 상태를 직접 바꿀 때(예: 테스트, 프로필 응답 반영) */
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
