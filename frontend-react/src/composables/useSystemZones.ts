/**
 * 관리 › 구역 — 서버(/api/admin/system) 호출과 화면이 함께 쓰는 순수 계산.
 * 구역 목록·이름·설명·권장 메모리·포트는 전부 서버가 준다(여기에 적어 두지 않는다).
 */
import { $fetch } from '~/lib/api'

export type ZoneJobStatus = 'running' | 'done' | 'failed' | 'unknown'
export type ZoneJobKind = 'enable' | 'disable' | 'update' | 'reconnect' | 'cert'
/** 주의(구역 확인의 cautions) · 작업이 남긴 주의(warnings) — 문구는 화면이 key 로 고른다 */
export interface ZoneCaution { key: string; vars?: Record<string, unknown> }
export type ZoneStageStatus = 'pending' | 'running' | 'done' | 'failed'
export interface ZoneJob {
  id: string
  kind: ZoneJobKind
  /** 인증서 작업(kind = cert)은 구역이 없다 */
  zone: string | null
  status: ZoneJobStatus
  stages: { id: string; status: ZoneStageStatus }[]
  error: { cause?: string; fix?: string; vars?: Record<string, unknown> } | null
  warnings: ZoneCaution[]
  ports: string[]
  started_at: string | null
  finished_at: string | null
}
export interface ZoneRow {
  id: string
  kind: 'zone' | 'addon'
  name: Record<string, string>
  summary: Record<string, string>
  recommend_mb: number
  ports: string[]
  enabled: boolean
  has_settings: boolean
  fits: boolean | null
  /** 켜져 있지만 로그인 연동이 보류됐다(신뢰되는 인증서가 생기면 다시 연결할 수 있다) */
  pending?: boolean
  pending_reason?: string | null
  /** 켜면 왼쪽 메뉴에 항목이 생기는 구역인가 */
  menu: boolean
  job: ZoneJob | null
}
export interface ZoneMemory { need_mb: number | null; have_mb: number | null; nominal_mb: number | null; ok: boolean | null }
export interface ZoneListing {
  installer: { available: boolean; reason: string | null }
  memory: ZoneMemory
  core: { name: Record<string, string>; recommend_mb: number }
  zones: ZoneRow[]
  addons: ZoneRow[]
  /** 코드 저장소의 "검증된 버전"이 몇 버전인지(설치 관리자가 알려 줄 때만) */
  git_verified_version?: string | null
}
export interface ZoneCheck {
  zone: string
  ok: boolean
  errors: { field: string; code: string; vars?: Record<string, unknown> }[]
  memory: ZoneMemory & { below_minimum?: boolean }
  ports: string[]
  cautions: ZoneCaution[]
}
export type ZoneSettings = Record<string, any>
export interface ZoneSettingsReply { zone: string; enabled: boolean; settings: ZoneSettings; detected?: { public_ip?: string | null }; verified_version?: string | null }
export interface MailRecord { id: string; name: string; type: string; expected: string; current: string[]; status: 'ok' | 'missing' | 'different' | 'unknown' }

const BASE = '/api/admin/system'

export const zonesApi = {
  list: () => $fetch<ZoneListing>(`${BASE}/zones`),
  check: (id: string, settings: ZoneSettings | null) => $fetch<ZoneCheck>(`${BASE}/zones/${id}/check`, { method: 'POST', body: { settings } }),
  enable: (id: string, settings: ZoneSettings | null) => $fetch<ZoneJob>(`${BASE}/zones/${id}/enable`, { method: 'POST', body: { settings } }),
  disable: (id: string) => $fetch<ZoneJob>(`${BASE}/zones/${id}/disable`, { method: 'POST' }),
  dismissJob: (id: string) => $fetch(`${BASE}/zones/${id}/job`, { method: 'DELETE' }),
  reconnect: (id: string) => $fetch<ZoneJob>(`${BASE}/zones/${id}/reconnect`, { method: 'POST' }),
  settings: (id: string) => $fetch<ZoneSettingsReply>(`${BASE}/zones/${id}/settings`),
  saveSettings: (id: string, settings: ZoneSettings) => $fetch<ZoneJob>(`${BASE}/zones/${id}/settings`, { method: 'PUT', body: { settings } }),
  jobs: () => $fetch<{ jobs: ZoneJob[] }>(`${BASE}/jobs`),
  job: (jobId: string) => $fetch<ZoneJob>(`${BASE}/jobs/${jobId}`),
  jobLog: (jobId: string) => $fetch<{ lines: string[] }>(`${BASE}/jobs/${jobId}/log`, { query: { tail: 2000 } }),
  probeSmtp: (body: Record<string, unknown>) => $fetch<{ status: string }>(`${BASE}/probe/smtp`, { method: 'POST', body }),
  probeAi: (body: Record<string, unknown>) => $fetch<{ status: string }>(`${BASE}/probe/ai`, { method: 'POST', body }),
  probeMailRecords: (mailDomain: string) => $fetch<{ mail_domain: string; ok: boolean; records: MailRecord[] }>(`${BASE}/probe/mail-records`, { method: 'POST', body: { mail_domain: mailDomain } }),
  probePublicIp: (refresh = false) => $fetch<{ status: string; ip: string | null }>(`${BASE}/probe/public-ip`, { query: { refresh } }),
}

/** 서버 오류의 code(없으면 '') — 본문은 `{code, vars, detail}` */
export function errorCode(e: unknown): string {
  const code = (e as { data?: { code?: unknown } } | null)?.data?.code
  return typeof code === 'string' ? code : ''
}

/** 화면 언어의 이름(없으면 한국어, 그것도 없으면 빈 글자) */
export function localized(text: Record<string, string> | undefined, locale: string): string {
  return text?.[locale] ?? text?.ko ?? text?.en ?? ''
}

/** 1500 → "1.5", 1000 → "1" (GB, 소수 한 자리) */
export function gb(mb: number | null | undefined): string {
  return String(Math.round(((mb ?? 0) / 1024) * 10) / 10)
}
/** 권장 메모리는 선언이 1000 단위다 — 1000 MB 를 1 GB 로 읽는다 */
export function recommendGb(mb: number): string {
  return String(Math.round((mb / 1000) * 10) / 10)
}

/** ["7881/tcp", "7882-7892/udp"] → "TCP 7881 · UDP 7882-7892" */
export function formatPorts(ports: string[]): string {
  return ports.map((p) => {
    const [range, proto] = p.split('/')
    return proto ? `${proto.toUpperCase()} ${range}` : range
  }).join(' · ')
}

/** 서버가 아는 주의 키 — 문구는 `admin.zones.caution.<키>`. 모르는 키는 `other` 로 보인다 */
export const CAUTION_KEYS = [
  'cert_temporary', 'git_sso_needs_trusted_cert', 'router_port_forward', 'proxy_side_certs_self_signed',
  'hairpin_not_configured', 'turn_tls_alternate_port', 'mail_needs_dns_and_port25', 'account_domain_is_mail_domain',
  'no_system_mail', 'meetings_public_ip_unknown', 'lossless_needs_udp_4433', 'rbi_needs_dns', 'dns_mismatch_cert_will_fail',
] as const

/** 주의 한 건 → 문구 키와 채울 값(포트 목록·이름 목록은 읽기 좋게 잇는다) */
export function cautionText(c: ZoneCaution): { key: string; values: Record<string, string> } {
  const known = (CAUTION_KEYS as readonly string[]).includes(c.key)
  const values: Record<string, string> = { key: c.key }
  for (const [name, v] of Object.entries(c.vars ?? {})) {
    if (Array.isArray(v)) values[name] = name === 'ports' ? formatPorts(v.map(String)) : v.map(String).join(', ')
    else if (v != null) values[name] = String(v)
  }
  return { key: `admin.zones.caution.${known ? c.key : 'other'}`, values }
}

export const isActive = (job: ZoneJob | null | undefined): job is ZoneJob => !!job && (job.status === 'running' || job.status === 'unknown')

/** 설정 폼의 처음 값 — 서버가 준 값 위에 빈 자리를 채운다 */
export function initialSettings(zoneId: string, saved: ZoneSettings | undefined): ZoneSettings {
  const s = saved ?? {}
  if (zoneId === 'mail') {
    return { kind: s.kind ?? 'builtin', mail_domain: s.mail_domain ?? '', host: s.host ?? '', port: String(s.port ?? 587),
      security: s.security ?? 'starttls', username: s.username ?? '', password: '', password_set: !!s.password_set }
  }
  if (zoneId === 'meetings') return { turn: s.turn ?? true, lossless_audio: s.lossless_audio ?? false, public_ip: s.public_ip ?? '' }
  if (zoneId === 'ai') return { mode: s.mode ?? 'now', provider: s.provider ?? 'anthropic', api_key: '', api_key_set: !!s.api_key_set }
  if (zoneId === 'git') return { version: s.version ?? 'tested', custom_version: s.custom_version ?? '' }
  return {}
}

/** 폼 값 → 서버에 보낼 settings(화면 전용 항목은 뺀다, 비운 비밀값은 보내지 않아 넣어 둔 값을 지킨다) */
export function toPayload(zoneId: string, form: ZoneSettings): ZoneSettings | null {
  if (zoneId === 'mail') {
    if (form.kind === 'builtin') return { kind: 'builtin', mail_domain: String(form.mail_domain).trim() }
    const out: ZoneSettings = { kind: 'external', host: String(form.host).trim(), port: Number(form.port), security: form.security, username: String(form.username).trim() }
    if (form.password) out.password = form.password
    return out
  }
  if (zoneId === 'meetings') {
    const out: ZoneSettings = { turn: !!form.turn, lossless_audio: !!form.lossless_audio }
    if (String(form.public_ip ?? '').trim()) out.public_ip = String(form.public_ip).trim()
    return out
  }
  if (zoneId === 'ai') {
    if (form.mode !== 'now') return { mode: 'later' }
    const out: ZoneSettings = { mode: 'now', provider: form.provider }
    if (form.api_key) out.api_key = form.api_key
    return out
  }
  if (zoneId === 'git') return { version: form.version, custom_version: form.version === 'custom' ? String(form.custom_version).trim() : null }
  return null
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
export const isIpv4 = (v: string) => IPV4.test(v.trim())

/**
 * "다음"을 막는 이유(i18n 키). 없으면 null.
 * verified: 연결 확인이 필요한 폼(외부 발신 서버, AI 키)이 지금 값으로 통과했는가.
 */
export function blockReason(zoneId: string, form: ZoneSettings, verified: boolean, detectedIp: string | null): string | null {
  if (zoneId === 'mail') {
    if (form.kind === 'builtin') return String(form.mail_domain).trim() ? null : 'admin.zones.mail.needDomain'
    return verified ? null : 'admin.zones.mail.needVerify'
  }
  if (zoneId === 'meetings') {
    const typed = String(form.public_ip ?? '').trim()
    if (typed) return isIpv4(typed) ? null : 'admin.zones.meet.needIp'
    return detectedIp ? null : 'admin.zones.meet.needIp'
  }
  if (zoneId === 'ai') return form.mode !== 'now' || verified ? null : 'admin.zones.ai.needVerify'
  if (zoneId === 'git') return form.version !== 'custom' || String(form.custom_version).trim() ? null : 'admin.zones.git.needVersion'
  return null
}
