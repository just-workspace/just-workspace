/**
 * 격리 브라우저(RBI) — 대상 목록·내 세션·시작/종료/핑 + 전용 출처(rbi.<도메인>) 세션.
 * 단독 앱(src/rbi-app — rbi 출처에서만 돈다), 워크스페이스 런처(pages/rbi.tsx), 관리(pages/admin/rbi.tsx)가 같이 쓴다.
 *
 * GET  /api/rbi/targets            → { targets, sessions, public_origin }   (쓸 수 있는 대상 + 내 활성 세션 + rbi 출처 주소)
 * GET  /api/rbi/sessions/me?recent=1 → { sessions }          (끝난 것까지 최근 10건 — 단독 앱 세션 목록)
 * POST /api/rbi/sessions           {target_id} → session     (컨테이너 기동, 최대 ~50초 — 호출부가 "시작 중" 을 보인다)
 * GET  /api/rbi/sessions/{id}      · POST …/ping · DELETE …
 * rbi 출처 세션(app/rbi/site.py): GET /api/rbi/site/me → { user, workspace_url } (없으면 401 → /auth/login 홉) · POST /api/rbi/site/logout
 * POST /api/rbi/sessions/{id}/mode {mode} → 새 세션(화면 방식 바꾸기 — 지금 세션은 끝난다)
 * 화면 방식: pixel(KasmVNC 픽셀 스트림, iframe 이 곧 KasmVNC 클라이언트) | mirror(DOM 미러 — 우리 앱이 스크립트 없는 iframe 을 조립,
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
  /** 사용자가 고를 수 있는 방식(mirror 대상은 pixel 로도 — 폴백) */
  modes: RbiMode[]
  policy: RbiPolicy
}

export interface RbiEgressEntry { host: string; ip: string; port: number; forced: boolean }

export interface RbiAdminTarget extends RbiTarget {
  allowed_hosts: string[]
  /** 80·443 말고 명시해 연 포트 */
  extra_ports?: number[]
  /** 저장할 때 검증·고정한 출구(netfilter 동적 허용 목록의 재료) */
  egress?: RbiEgressEntry[]
  /** 워크스페이스 자신의 주소를 강제로 연 대상 */
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
  /** running 일 때만 — ws-nginx 가 세션 컨테이너의 KasmVNC 로 넘기는 경로 */
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
  /** 사이드카가 다시 검사해 거부한 동적 줄("IP:포트 이유") */
  rejected?: string[]
  allow_rev?: string | null
}

export interface RbiEgressStatus {
  /** 켜진 대상들이 원하는 출구 */
  desired: string[]
  /** 원하지만 사이드카가 아직 안 건 것 */
  pending: string[]
  /** .env RBI_ALLOW(고정, 늘 허용) */
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

/** 내 최근 세션(끝난 것 포함 10건) */
export function fetchRbiRecent() {
  return $fetch<{ sessions: RbiSession[] }>('/api/rbi/sessions/me', { query: { recent: 1 } })
}

export function startRbiSession(targetId: string, mode?: RbiMode) {
  return $fetch<RbiSession>('/api/rbi/sessions', { method: 'POST', body: mode ? { target_id: targetId, mode } : { target_id: targetId } })
}

/** 화면 방식 바꾸기 — 서버가 지금 세션을 끝내고 같은 대상으로 새 세션을 띄운다(격리 브라우저 안 상태는 이어지지 않는다) */
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

/** 지금 rbi 세션(없으면 401 FetchError) */
export function fetchRbiMe() {
  return $fetch<RbiSiteMe>('/api/rbi/site/me')
}

/** rbi 세션만 끝낸다(워크스페이스 로그인은 그대로) */
export function rbiSiteLogout() {
  return $fetch<{ ok: boolean }>('/api/rbi/site/logout', { method: 'POST' })
}

/** 앱 상태 쿼리(홉 결과·딥 링크)를 뺀 "돌아올 곳" — rbi 출처 안 경로 */
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
 * origin 이 rbi 출처(https?://호스트[:포트])가 아니면 null(설정 안 됨·이상한 값) — 아무 데나 열지 않는다.
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
 * KasmVNC 클라이언트 주소 — 바로 연결·원격 해상도 맞춤.
 * ★ path= 는 필수: 클라이언트는 웹소켓을 페이지 경로가 아니라 출처 루트 기준 `path` 로 연다(기본 "websockify" → /websockify 로 가서 실패한다).
 *   세션 경로 밑의 websockify 를 명시해야 ws-nginx 의 /rbi/<sid>/ 블록(auth_request)으로 들어간다.
 */
export function rbiStreamSrc(session: RbiSession): string {
  if (!session.stream_url) return ''
  const base = session.stream_url.replace(/^\//, '')
  const q = new URLSearchParams({ autoconnect: '1', resize: 'remote', path: `${base}websockify` })
  return `${session.stream_url}?${q.toString()}`
}

/**
 * 미러 모드 주소 — 같은 출처, 세션 경로 아래. ws 는 페이지 스킴을 따른다(https → wss).
 *   view : 스크립트 없는 미러 문서(iframe src, CSP script-src 'none' — 에이전트가 붙인다)
 *   ws   : 어휘 스트림 · base : asset/·download/·upload/ 접두어
 */
export function rbiMirrorUrls(session: RbiSession, loc: Pick<Location, 'protocol' | 'host'> = window.location): { base: string; view: string; ws: string } | null {
  if (!session.stream_url || session.mode !== 'mirror') return null
  const base = session.stream_url.replace(/\/$/, '')
  const wsProto = loc.protocol === 'https:' ? 'wss' : 'ws'
  return { base, view: `${base}/view`, ws: `${wsProto}://${loc.host}${base}/mirror` }
}

/** 정책 → 사람이 읽는 i18n 키 목록(화면 칩) */
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

// ── 워크스페이스 쪽 런처(사용자 메뉴 "격리 브라우저 열기"·/rbi 페이지) ──

export interface RbiLauncherInfo { url: string | null; targets: RbiTarget[] }

let _launcher: Promise<RbiLauncherInfo> | null = null
/** 대상 목록 + rbi 출처 주소(한 번 읽어 둔다 — 사용자 메뉴가 열릴 때마다 부르지 않게). 실패면 빈 값 */
export function loadRbiLauncher(force = false): Promise<RbiLauncherInfo> {
  if (!_launcher || force) {
    _launcher = fetchRbiTargets()
      .then(r => ({ url: rbiLauncherUrl(r?.public_origin), targets: Array.isArray(r?.targets) ? r.targets : [] }))
      .catch(() => { _launcher = null; return { url: null, targets: [] } })
  }
  return _launcher
}
