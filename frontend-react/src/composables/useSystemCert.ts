/**
 * 관리 › 보안 — 접속 주소의 인증서(/api/admin/system/cert). 인증서를 실제로 바꾸는 일은 설치 관리자가 한다.
 * 다시 발급·올리기는 작업으로 돌고(발급 → 다시 읽히기 → 구역 다시 연결), 진행은 구역 작업과 같은 경로로 읽는다.
 */
import { $fetch } from '~/lib/api'
import type { ZoneJob } from '~/composables/useSystemZones'

export type CertMode = 'auto' | 'upload' | 'temporary' | 'proxy'
export interface CertState {
  /** 이 서버가 TLS 를 끝내는가. false = 앞단 프록시가 맡는다 */
  managed: boolean
  mode: CertMode | null
  temporary: boolean
  domain: string | null
  names: string[]
  not_after: string | null
  days_left: number | null
  issuer: string | null
  self_signed: boolean
  /** 인증서 때문에 연결이 보류된 구역 */
  pending: string[]
  /** 진행 중인 인증서 작업 */
  job: ZoneJob | null
}
/** 올린 인증서 검증 한 줄 — 마법사의 인증서 확인과 같은 꼴 */
export interface CertCheck { id: string; status: 'pass' | 'warn' | 'fail'; value?: unknown; fix?: { key: string; vars?: Record<string, unknown> } | null }

const BASE = '/api/admin/system'

export const certApi = {
  get: () => $fetch<CertState>(`${BASE}/cert`),
  reissueAuto: () => $fetch<ZoneJob>(`${BASE}/cert/reissue`, { method: 'POST', body: { mode: 'auto' } }),
  reissueUpload: (cert: string, key: string) => $fetch<ZoneJob>(`${BASE}/cert/reissue`, { method: 'POST', body: { mode: 'upload', cert, key } }),
}

/** 올릴 수 있는 파일 크기(각각) — 서버와 같은 상한 */
export const CERT_FILE_MAX = 1024 * 1024

/** 화면이 문구를 가진 검증 실패 사유 — 그 밖은 `other` */
export const CERT_FIX_KEYS = ['cert_domain_missing', 'key_mismatch', 'cert_expired', 'cert_not_pem', 'key_not_pem', 'key_encrypted', 'cert_not_yet_valid'] as const

/** 422 cert_invalid 의 vars.checks 에서 통과하지 못한 줄만 */
export function failedChecks(e: unknown): CertCheck[] {
  const checks = (e as { data?: { vars?: { checks?: unknown } } } | null)?.data?.vars?.checks
  if (!Array.isArray(checks)) return []
  return checks.filter((c): c is CertCheck => !!c && typeof c === 'object' && (c as CertCheck).status === 'fail')
}

/** 실패 사유 → 문구 키 묶음(`admin.certCard.msg.<키>`) */
export function fixKey(check: CertCheck): string {
  const key = check.fix?.key ?? ''
  return (CERT_FIX_KEYS as readonly string[]).includes(key) ? key : 'other'
}

const DONE_KEEP_MS = 10 * 60_000        // 끝난 작업을 "바꿨습니다"로 남겨 두는 시간
const FAILED_KEEP_MS = 24 * 3_600_000   // 실패는 하루 동안 다시 보여 준다(화면을 새로 열어도)

/** 최근 인증서 작업 중 지금 보여 줄 것 — 진행 중, 방금 끝난 것, 하루 안에 실패한 것 */
export function shownCertJob(job: ZoneJob | null | undefined, now = Date.now()): ZoneJob | null {
  if (!job || job.kind !== 'cert') return null
  if (job.status === 'running' || job.status === 'unknown') return job
  const at = Date.parse(job.finished_at || job.started_at || '')
  if (Number.isNaN(at)) return null
  return now - at <= (job.status === 'failed' ? FAILED_KEEP_MS : DONE_KEEP_MS) ? job : null
}
