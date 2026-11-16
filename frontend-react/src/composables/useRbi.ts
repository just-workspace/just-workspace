/**
 * 격리 브라우저(RBI) — 대상 목록·내 세션·시작/종료/핑 + 전용 출처(rbi.<도메인>) 세션.
 * 단독 앱(src/rbi-app — rbi 출처에서만 동작), 워크스페이스 런처(pages/rbi.tsx), 관리(pages/admin/rbi.tsx)가 공용으로 사용한다.
 *
 * GET  /api/rbi/targets            → { targets, sessions, public_origin }   (사용 가능한 대상 + 내 활성 세션 + rbi 출처 주소)
 * GET  /api/rbi/sessions/me?recent=1 → { sessions }          (종료된 세션 포함 최근 10건 — 단독 앱 세션 목록)
 * POST /api/rbi/sessions           {target_id} → session     (컨테이너 기동, 최대 ~50초 — 호출부가 "시작 중" 을 표시한다)
 * GET  /api/rbi/sessions/{id}      · POST …/ping · DELETE …
 * rbi 출처 세션(app/rbi/site.py): GET /api/rbi/site/me → { user, workspace_url } (없으면 401 → /auth/login 홉) · POST /api/rbi/site/logout
 * POST /api/rbi/sessions/{id}/mode {mode} → 새 세션(화면 방식 변경 — 현재 세션은 종료된다)
 * 화면 방식: pixel(KasmVNC 픽셀 스트림, iframe 자체가 KasmVNC 클라이언트) | mirror(DOM 미러 — 본 앱이 스크립트 없는 iframe 을 조립,
 *   lib/rbiMirror 의 MirrorClient · 경로 /rbi/<sid>/view·mirror·asset·font·download·upload)
 */
import { $fetch } from '~/lib/api'

export interface RbiPolicy {
  clipboard_to_browser: boolean
  clipboard_from_browser: boolean
  downloads: boolean
  uploads: boolean
  idle_minutes: number
  max_hours: number
}

export type RbiMode = 'pixel' | 'mirror'

export interface RbiTarget {
  id: string
  key: string
  name: string
  url: string
  host: string
  enabled: boolean
  /** 대상의 기본 화면 방식 */
  mode: RbiMode
  /** 사용자가 선택할 수 있는 방식(mirror 대상은 pixel 도 가능 — 폴백) */
  modes: RbiMode[]
  policy: RbiPolicy
}

export interface RbiEgressEntry { host: string; ip: string; port: number; forced: boolean }

export interface RbiAdminTarget extends RbiTarget {
  allowed_hosts: string[]
  /** 80·443 외에 명시적으로 허용한 포트 */
  extra_ports?: number[]
  /** 저장 시 검증·고정한 출구(netfilter 동적 허용 목록의 입력 자료) */
  egress?: RbiEgressEntry[]
  /** 워크스페이스 자체 주소를 강제로 허용한 대상 */
  egress_forced?: boolean
  cpu: number
  memory_mb: number
  allowed_group_ids: string[]
  allowed_user_ids: string[]
  private_ip: boolean
}

export type RbiSessionStatus = 'starting' | 'running' | 'ended' | 'error'

export interface RbiSession {
  id: string
  status: RbiSessionStatus
  mode: RbiMode
  modes: RbiMode[]
  target_id: string
  target_key: string
  target_name: string
  target_url: string | null
  /** running 일 때만 — ws-nginx 가 세션 컨테이너의 KasmVNC 로 전달하는 경로 */
  stream_url: string | null
  started_at: string | null
  expires_at: string | null
  idle_minutes: number
  max_hours: number
  last_seen_at: string | null
  ended_at: string | null
  end_reason: string | null
  error: string | null
  user_id?: string
  client_ip?: string | null
}

export interface RbiGuard {
  ok: boolean
  reason: string
  age: number | null
  allow: string[] | null
  rules: number | null
  required: boolean
  /** 사이드카가 재검사하여 거부한 동적 줄("IP:포트 이유") */
  rejected?: string[]
  allow_rev?: string | null
}

export interface RbiEgressStatus {
  /** 활성화된 대상들이 요구하는 출구 */
  desired: string[]
  /** 요구되었으나 사이드카가 아직 적용하지 않은 항목 */
  pending: string[]
  /** .env RBI_ALLOW(고정, 항상 허용) */
  static: string[]
  ceiling: string
  protected: string
  file: string
}

export interface RbiStatus {
  image: string
  mirror_image: string
  network: string
  subnet: string
  bridge: string
  publish_ip: string
  max_sessions: number
  active_sessions: number
  guard: RbiGuard
  egress?: RbiEgressStatus
  public_origin?: string
}

export interface RbiAdminOverview {
  targets: RbiAdminTarget[]
  sessions: RbiSession[]
  status: RbiStatus
}

export function fetchRbiTargets() {
  return $fetch<{ targets: RbiTarget[]; sessions: RbiSession[]; public_origin?: string }>('/api/rbi/targets')
}

/** 내 최근 세션(종료된 세션 포함 10건) */
export function fetchRbiRecent() {
  return $fetch<{ sessions: RbiSession[] }>('/api/rbi/sessions/me', { query: { recent: 1 } })
}

export function startRbiSession(targetId: string, mode?: RbiMode) {
  return $fetch<RbiSession>('/api/rbi/sessions', { method: 'POST', body: mode ? { target_id: targetId, mode } : { target_id: targetId } })
}

/** 화면 방식 변경 — 서버가 현재 세션을 종료하고 동일 대상으로 새 세션을 기동한다(격리 브라우저 내부 상태는 유지되지 않는다) */
export function switchRbiMode(id: string, mode: RbiMode) {
  return $fetch<RbiSession>(`/api/rbi/sessions/${id}/mode`, { method: 'POST', body: { mode } })
}

export function fetchRbiSession(id: string) {
  return $fetch<RbiSession>(`/api/rbi/sessions/${id}`)
}

export function pingRbiSession(id: string) {
  return $fetch<{ status: RbiSessionStatus }>(`/api/rbi/sessions/${id}/ping`, { method: 'POST' })
}

export function endRbiSession(id: string) {
  return $fetch<RbiSession>(`/api/rbi/sessions/${id}`, { method: 'DELETE' })
}

// ── rbi 전용 출처 세션(단독 앱) ──

export interface RbiSiteUser { id: string; username: string; display_name: string; is_admin: boolean }
export interface RbiSiteMe { user: RbiSiteUser; workspace_url: string }

/** 현재 rbi 세션(없으면 401 FetchError) */
export function fetchRbiMe() {
  return $fetch<RbiSiteMe>('/api/rbi/site/me')
}

/** rbi 세션만 종료한다(워크스페이스 로그인은 유지) */
export function rbiSiteLogout() {
  return $fetch<{ ok: boolean }>('/api/rbi/site/logout', { method: 'POST' })
}

/** 앱 상태 쿼리(홉 결과·딥 링크)를 제외한 "돌아올 곳" — rbi 출처 내부 경로 */
export function rbiReturnPath(loc: Pick<Location, 'pathname' | 'search'> = window.location): string {
  const q = new URLSearchParams(loc.search)
  q.delete('sso_error')
  const qs = q.toString()
  return `${loc.pathname || '/'}${qs ? `?${qs}` : ''}`
}

/** SSO 홉 시작 주소(rbi 출처의 /auth/login → 워크스페이스 /rbi-login → /auth/callback) */
export function rbiLoginUrl(loc: Pick<Location, 'pathname' | 'search'> = window.location): string {
  return `/auth/login?return=${encodeURIComponent(rbiReturnPath(loc))}`
}

/**
 * 워크스페이스 런처가 새 탭으로 여는 주소 — rbi 출처 루트(+ 대상 딥 링크 ?target=<key>).
 * origin 이 rbi 출처(https?://호스트[:포트]) 형식이 아니면 null(미설정·비정상 값) — 임의의 주소는 열지 않는다.
 */
export function rbiLauncherUrl(origin: string | null | undefined, targetKey?: string): string | null {
  if (!origin) return null
  let u: URL
  try { u = new URL(origin) } catch { return null }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null
  const base = `${u.protocol}//${u.host}/`
  return targetKey ? `${base}?target=${encodeURIComponent(targetKey)}` : base
}

/**
 * KasmVNC 클라이언트 주소 — 즉시 연결·원격 해상도 맞춤.
 * 주의: path= 는 필수이다. 클라이언트는 웹소켓을 페이지 경로가 아니라 출처 루트 기준 `path` 로 연결한다(기본 "websockify" → /websockify 로 연결되어 실패한다).
 *   세션 경로 하위의 websockify 를 명시해야 ws-nginx 의 /rbi/<sid>/ 블록(auth_request)으로 진입한다.
 */
export function rbiStreamSrc(session: RbiSession): string {
  if (!session.stream_url) return ''
  const base = session.stream_url.replace(/^\//, '')
  const q = new URLSearchParams({ autoconnect: '1', resize: 'remote', path: `${base}websockify` })
  return `${session.stream_url}?${q.toString()}`
}

/**
 * 미러 모드 주소 — 동일 출처, 세션 경로 하위. ws 는 페이지 스킴을 따른다(https → wss).
 *   view : 스크립트 없는 미러 문서(iframe src, CSP script-src 'none' — 에이전트가 부착한다)
 *   ws   : 어휘 스트림 · base : asset/·download/·upload/ 접두어
 */
export function rbiMirrorUrls(session: RbiSession, loc: Pick<Location, 'protocol' | 'host'> = window.location): { base: string; view: string; ws: string } | null {
  if (!session.stream_url || session.mode !== 'mirror') return null
  const base = session.stream_url.replace(/\/$/, '')
  const wsProto = loc.protocol === 'https:' ? 'wss' : 'ws'
  return { base, view: `${base}/view`, ws: `${wsProto}://${loc.host}${base}/mirror` }
}

/** 정책 → 사용자 표시용 i18n 키 목록(화면 칩) */
export function rbiPolicyKeys(p: RbiPolicy): string[] {
  const keys: string[] = []
  if (p.clipboard_to_browser && p.clipboard_from_browser) keys.push('rbi.policy.clipboardBoth')
  else if (p.clipboard_to_browser) keys.push('rbi.policy.clipboardIn')
  else if (p.clipboard_from_browser) keys.push('rbi.policy.clipboardOut')
  else keys.push('rbi.policy.clipboardNone')
  keys.push(p.downloads ? 'rbi.policy.downloads' : 'rbi.policy.noDownloads')
  keys.push(p.uploads ? 'rbi.policy.uploads' : 'rbi.policy.noUploads')
  return keys
}

export function fmtRbiTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

// ── 워크스페이스 측 런처(사용자 메뉴 "격리 브라우저 열기"·/rbi 페이지) ──

export interface RbiLauncherInfo { url: string | null; targets: RbiTarget[] }

let _launcher: Promise<RbiLauncherInfo> | null = null
/** 대상 목록 + rbi 출처 주소(1회 조회 후 보관 — 사용자 메뉴가 열릴 때마다 호출하지 않도록). 실패 시 빈 값 */
export function loadRbiLauncher(force = false): Promise<RbiLauncherInfo> {
  if (!_launcher || force) {
    _launcher = fetchRbiTargets()
      .then(r => ({ url: rbiLauncherUrl(r?.public_origin), targets: Array.isArray(r?.targets) ? r.targets : [] }))
      .catch(() => { _launcher = null; return { url: null, targets: [] } })
  }
  return _launcher
}
