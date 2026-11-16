/**
 * 전역 라우트 가드.
 * 순서: 인증(auth) → 모듈 활성화 여부(module-guard) → 초기 설정(setup).
 * 이 순서로 판정하며 첫 리다이렉트에서 중단한다(리다이렉트된 경로에서 처음부터 재판정).
 *
 * 루트 라우트 loader 가 이동마다 호출한다(router/index.tsx).
 */
import { $fetch } from '~/lib/api'
import { authStore, fetchUser, authUncertain } from '~/composables/useAuth'
import { siteConfigStore, fetchAppConfig, isZoneInstalled } from '~/composables/useSiteConfig'
import { platformStore, moduleEnabledIn, fetchModules } from '~/composables/usePlatform'
import { getSharedState, setSharedState } from '~/lib/state'

export interface GuardTarget {
  path: string
  /** 알려진 라우트와의 일치 여부 */
  matched: boolean
}

/** 앱 시작 시 1회 — 사용자 정보를 먼저 조회한 뒤 첫 화면 표시 */
let _booted: Promise<void> | null = null
export function bootAuth(): Promise<void> {
  if (!_booted) _booted = fetchUser()
  return _booted
}
/** 테스트용 */
export function _resetGuards() { _booted = null }

const PUBLIC_PAGES = ['/setup', '/login', '/register', '/forgot-password', '/reset-password', '/verify-email']

/** 로그인 가드 */
export async function authGuard(to: GuardTarget): Promise<string | null> {
  const { user, loading } = authStore.getState()

  // Allow public pages
  if (PUBLIC_PAGES.includes(to.path)) return null
  if (to.path.startsWith('/meetings/join/')) return null
  if (to.path.startsWith('/meetings/room/')) return null
  // 공유 링크로 진입한 게스트. /s/<token> 에서 OnlyOffice 편집기를 직접 연다.
  if (to.path.startsWith('/s/')) return null
  // 존재하지 않는 주소는 로그인으로 리다이렉트하지 않고 인증 틀 안에서 404 표시
  if (!to.matched) return null

  // 로그인 여부 미확정(/api/auth/me 가 429·5xx·네트워크 오류) — 미인증으로 단정하지 않고 재확인한다.
  // 재확인 후에도 미확정이면 로그인 화면으로 리다이렉트하되 복귀 경로를 포함한다(확인되는 즉시 로그인 화면이 복귀시킨다).
  // 백그라운드 재확인이 진행 중인 시점(loading)에 발생한 이동은 그 결과를 대기한 뒤 재판정한다 —
  // 대기하지 않으면 아래 두 블록을 모두 건너뛰어 사용자 정보 없이 보호 화면에 진입한다
  if (loading && !user) {
    await fetchUser()
    return authGuard(to)
  }
  if (!loading && !user && authUncertain()) {
    await fetchUser()
    if (authStore.getState().user) return authGuard(to)
    if (authUncertain()) return `/login?redirect=${encodeURIComponent(to.path)}`
  }

  // If not loading and no user, check demo mode
  if (!loading && !user) {
    await fetchAppConfig()
    if (siteConfigStore.getState().demoMode) {
      // Auto-login via demo endpoint
      try {
        await $fetch('/api/auth/demo-login', { method: 'POST' })
        await fetchUser()
        return null
      } catch {
        // Fallback to login page
      }
    }
    return '/login'
  }

  // 관리자 정책(2단계 인증 필수) 적용 대상이나 인증 앱 미등록 상태 → 설정 › 보안으로 리다이렉트
  if (authStore.getState().user?.totp_setup_required && to.path !== '/settings/security') {
    return '/settings/security?enroll=1'
  }
  return null
}

/**
 * 모듈 소속 화면 — 경로 접두사 → 모듈 id. 라우트 표(router/routes.ts)에 모듈 화면을 추가하면 여기에도 추가한다.
 * 여기에 없는 경로(홈·설정·관리·활동 등 코어 화면)는 모듈 판정 대상이 아니다.
 */
export const MODULE_ROUTES: Record<string, string> = {
  '/mail': 'mail',
  '/chat': 'chat',
  '/meetings': 'meetings',
  '/files': 'files',
  '/calendar': 'calendar',
  '/contacts': 'contacts',
  '/code': 'git',
  '/git': 'git',
  '/board': 'board',
  '/tasks': 'tasks',
  '/wiki': 'wiki',
  '/ai': 'ai',
  '/rbi': 'rbi',
  '/settings/mail': 'mail',
  '/settings/calendar': 'calendar',
  '/settings/chat': 'chat',
}

/**
 * 활성화/비활성화 대상 모듈은 없으나 특정 구역이 설치되어야 사용 가능한 화면 — 경로 접두사 → 구역 id.
 * (AI 설정·운영 화면은 AI 모듈 활성화 전에도 열려야 하므로 모듈이 아닌 구역으로 판정한다.)
 */
export const ZONE_ROUTES: Record<string, string> = {
  '/office': 'docs',
  '/approvals': 'ai',
  '/settings/ai': 'ai',
  '/admin/ai': 'ai',
  '/admin/ai-ops': 'ai',
  '/admin/rbi': 'rbi',
}

const under = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + '/')

/** 모듈 가드 — 비활성화되었거나 설치되지 않은 모듈·구역의 화면이면 대시보드로 리다이렉트 */
export function moduleGuard(to: GuardTarget): string | null {
  const { modules, loaded } = platformStore.getState()
  // Don't guard until modules are loaded
  if (!loaded) return null
  // 목록에 없는 id 는 비활성으로 간주(미설치 구역의 모듈은 서버가 목록에서 제외)
  const enabled = (id: string) => moduleEnabledIn(modules, loaded, id)

  for (const [prefix, moduleId] of Object.entries(MODULE_ROUTES)) {
    if (under(to.path, prefix)) {
      if (!enabled(moduleId)) return '/'
      break
    }
  }
  for (const [prefix, zoneId] of Object.entries(ZONE_ROUTES)) {
    if (under(to.path, prefix) && !isZoneInstalled(zoneId)) return '/'
  }
  // Plugin routes: /p/{pluginId}
  const pluginMatch = to.path.match(/^\/p\/([^/]+)/)
  if (pluginMatch && !enabled(pluginMatch[1])) return '/'
  return null
}

interface SetupStatus { needs_setup?: boolean }

/** 최초 설정 가드 — 최초설정(관리자 0명/미완료) 상태이면 /setup 으로 리다이렉트 */
export async function setupGuard(to: GuardTarget): Promise<string | null> {
  let status = getSharedState<SetupStatus | null>('setup-status', () => null)
  if (status === null) {
    try {
      status = await $fetch<SetupStatus>('/api/setup/status')
      setSharedState('setup-status', status)
    } catch {
      // 일시 오류(429·5xx·네트워크) — 이번 이동만 "설정 끝남"으로 처리하고 저장하지 않는다(다음 이동에서 재조회).
      // 과거에는 실패 응답을 그대로 저장하여, 1회 실패 시 새로 고침 전까지 최초 설정 판정이 고정되었다.
      status = { needs_setup: false }
    }
  }
  if (status?.needs_setup && to.path !== '/setup') return '/setup'
  if (!status?.needs_setup && to.path === '/setup') return '/'
  return null
}

/** 세 가드를 순서대로 실행. 리다이렉트할 주소 또는 null 반환 */
export async function runGuards(to: GuardTarget): Promise<string | null> {
  await bootAuth()
  const a = await authGuard(to)
  if (a && a !== to.path) return a
  // 주소를 직접 입력해 진입한 첫 이동에서도 판정할 수 있도록, 로그인한 사용자이면 모듈 목록(필요 시 구역 목록 포함)을 먼저 조회한다.
  // 조회 실패(일시 오류) 시 판정을 보류하고 이동을 허용한다.
  if (authStore.getState().user && to.matched) {
    if (!platformStore.getState().loaded) await fetchModules()
    if (Object.keys(ZONE_ROUTES).some(prefix => under(to.path, prefix))) await fetchAppConfig()
  }
  const m = moduleGuard(to)
  if (m && m !== to.path) return m
  const s = await setupGuard(to)
  if (s && s !== to.path) return s
  return null
}
