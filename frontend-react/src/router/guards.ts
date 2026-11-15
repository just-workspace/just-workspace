/**
 * 전역 라우트 가드 — Vue 판 middleware/*.global.ts + plugins/auth.ts 대응.
 * Nuxt 는 전역 미들웨어를 파일 이름 순으로 돌린다: auth.global → module-guard.global → setup.global.
 * 여기서도 같은 순서로 판정하고, 첫 리다이렉트에서 멈춘다(리다이렉트된 곳에서 다시 처음부터).
 *
 * 루트 라우트 loader 가 매 이동마다 부른다(router/index.tsx).
 */
import { $fetch } from '~/lib/api'
import { authStore, fetchUser, authUncertain } from '~/composables/useAuth'
import { siteConfigStore, fetchAppConfig, isZoneInstalled } from '~/composables/useSiteConfig'
import { platformStore, moduleEnabledIn, fetchModules } from '~/composables/usePlatform'
import { getSharedState, setSharedState } from '~/lib/state'

export interface GuardTarget {
  path: string
  /** 알려진 라우트에 맞았는가(Vue to.matched.length > 0) */
  matched: boolean
}

/** 앱 시작 시 한 번 — Vue plugins/auth.ts(사용자 정보를 먼저 읽고 첫 화면) */
let _booted: Promise<void> | null = null
export function bootAuth(): Promise<void> {
  if (!_booted) _booted = fetchUser()
  return _booted
}
/** 테스트용 */
export function _resetGuards() { _booted = null }

const PUBLIC_PAGES = ['/setup', '/login', '/register', '/forgot-password', '/reset-password', '/verify-email']

/** middleware/auth.global.ts */
export async function authGuard(to: GuardTarget): Promise<string | null> {
  const { user, loading } = authStore.getState()

  // Allow public pages
  if (PUBLIC_PAGES.includes(to.path)) return null
  if (to.path.startsWith('/meetings/join/')) return null
  if (to.path.startsWith('/meetings/room/')) return null
  // 공유 링크로 들어온 손님. /s/<token> 에서 바로 OnlyOffice 편집기를 연다.
  if (to.path.startsWith('/s/')) return null
  // 없는 주소는 로그인으로 보내지 않고 인증 틀 안 404
  if (!to.matched) return null

  // 로그인 여부를 아직 모른다(/api/auth/me 가 429·5xx·네트워크 오류) — 미인증으로 단정하지 않고 다시 확인한다.
  // 그래도 모르면 로그인 화면으로 보내되 돌아올 곳을 실어 둔다(확인되는 대로 로그인 화면이 되돌려 보낸다).
  // 백그라운드 재확인이 날아가 있는 순간(loading)에 들어온 이동은 그 결과를 기다렸다가 다시 판정한다 —
  // 안 기다리면 아래 두 블록을 모두 건너뛰어 사용자 없이 보호 화면에 들어간다
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

  // 관리자 정책(2단계 인증 필수)에 걸렸는데 아직 인증 앱을 등록하지 않았다 → 설정 › 보안으로
  if (authStore.getState().user?.totp_setup_required && to.path !== '/settings/security') {
    return '/settings/security?enroll=1'
  }
  return null
}

/**
 * 모듈에 속한 화면 — 경로 접두사 → 모듈 id. 라우트 표(router/routes.ts)에 모듈 화면을 더하면 여기도 더한다.
 * 여기 없는 경로(홈·설정·관리·활동 등 코어 화면)는 모듈 판정을 받지 않는다.
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
 * 켜고 끄는 모듈은 없지만 특정 구역이 설치돼야 쓸 수 있는 화면 — 경로 접두사 → 구역 id.
 * (AI 설정·운영 화면은 AI 모듈을 켜기 전에도 열려야 하므로 모듈이 아니라 구역으로 판정한다.)
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

/** middleware/module-guard.global.ts — 꺼졌거나 설치되지 않은 모듈·구역의 화면이면 대시보드로 */
export function moduleGuard(to: GuardTarget): string | null {
  const { modules, loaded } = platformStore.getState()
  // Don't guard until modules are loaded
  if (!loaded) return null
  // 목록에 없는 id 는 꺼진 것(설치하지 않은 구역의 모듈은 서버가 목록에서 뺀다)
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

/** middleware/setup.global.ts — 최초설정(관리자 0명/미완료)이면 /setup 으로 */
export async function setupGuard(to: GuardTarget): Promise<string | null> {
  let status = getSharedState<SetupStatus | null>('setup-status', () => null)
  if (status === null) {
    try {
      status = await $fetch<SetupStatus>('/api/setup/status')
      setSharedState('setup-status', status)
    } catch {
      // 일시 오류(429·5xx·네트워크)다 — 이번 이동만 "설정 끝남"으로 넘기고 기억하지 않는다(다음 이동에서 다시 묻는다).
      // 예전엔 실패한 답을 그대로 기억해, 한 번 실패하면 새로 고칠 때까지 최초 설정 판정이 굳었다.
      status = { needs_setup: false }
    }
  }
  if (status?.needs_setup && to.path !== '/setup') return '/setup'
  if (!status?.needs_setup && to.path === '/setup') return '/'
  return null
}

/** 세 가드를 Nuxt 순서대로. 리다이렉트할 주소 또는 null */
export async function runGuards(to: GuardTarget): Promise<string | null> {
  await bootAuth()
  const a = await authGuard(to)
  if (a && a !== to.path) return a
  // 주소를 직접 치고 들어온 첫 이동에서도 판정할 수 있게, 로그인한 사용자면 모듈 목록(과 필요하면 구역 목록)을 먼저 받는다.
  // 받지 못하면(일시 오류) 판정을 미루고 그대로 보낸다.
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
