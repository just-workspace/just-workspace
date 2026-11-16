/**
 * 관리 › 보안 — 접속 주소의 인증서(/api/admin/system/cert). 실제 인증서 교체는 설치 관리자가 수행한다.
 * 재발급·업로드는 작업으로 실행되며(발급 → 리로드 → 구역 재연결), 진행 상황은 구역 작업과 동일한 경로로 조회한다.
 */
import { $fetch } from '~/lib/api'
import type { ZoneJob } from '~/composables/useSystemZones'

export type CertMode = 'auto' | 'upload' | 'temporary' | 'proxy'
export interface CertState {
  /** 이 서버의 TLS 종단 여부. false = 프런트 프록시가 담당한다 */
  managed: boolean
  mode: CertMode | null
  temporary: boolean
  domain: string | null
  names: string[]
  not_after: string | null
  days_left: number | null
  issuer: string | null
  self_signed: boolean
  /** 이 서버의 컨테이너(코드 저장소 등)가 신뢰하도록 등록한 발급 CA 가 존재한다 — 인증서 파일에 체인이 포함되었거나 CA 인증서를 별도로 업로드한 경우 */
  site_ca?: boolean
  /** 발급 CA 인증서를 별도로 업로드할 수 있는 설치(업로드한 인증서를 사용하며 자체 서명이 아님) */
  ca_uploadable?: boolean
  /** 자동 갱신 상태 — 이 항목을 주지 않는 설치 관리자(이전 버전)도 있다 */
  renewal?: CertRenewal | null
  /** 인증서 문제로 연결이 보류된 구역 */
  pending: string[]
  /** 진행 중인 인증서 작업 */
  job: ZoneJob | null
}
export interface CertRenewal {
  /** 자동 발급 설치(갱신 서비스가 있어야 하는 설치) */
  applicable: boolean
  service: 'running' | 'stopped' | 'missing'
  last_run_at: string | null
  last_result: 'ok' | 'failed' | null
  next_renewal_at: string | null
}
/** 업로드한 인증서의 검증 항목 1건 — 마법사의 인증서 확인과 동일한 형식 */
export interface CertCheck { id: string; status: 'pass' | 'warn' | 'fail'; value?: unknown; fix?: { key: string; vars?: Record<string, unknown> } | null }

const BASE = '/api/admin/system'

export const certApi = {
  get: () => $fetch<CertState>(`${BASE}/cert`),
  reissueAuto: () => $fetch<ZoneJob>(`${BASE}/cert/reissue`, { method: 'POST', body: { mode: 'auto' } }),
  reissueUpload: (cert: string, key: string, ca = '') =>
    $fetch<ZoneJob>(`${BASE}/cert/reissue`, { method: 'POST', body: { mode: 'upload', cert, key, ...(ca.trim() ? { ca } : {}) } }),
  /** 발급 CA 인증서만 추가한다(인증서·개인 키는 유지) — 사설 CA 가 발급한 인증서를 1장만 업로드한 설치 */
  uploadCa: (ca: string) => $fetch<ZoneJob>(`${BASE}/cert/ca`, { method: 'POST', body: { ca } }),
}

/** 업로드 가능한 파일 크기(파일별) — 서버와 동일한 상한 */
export const CERT_FILE_MAX = 1024 * 1024

/** 화면에 문구가 정의된 검증 실패 사유 — 그 외는 `other` */
export const CERT_FIX_KEYS = ['cert_domain_missing', 'key_mismatch', 'cert_expired', 'cert_not_pem', 'key_not_pem', 'key_encrypted', 'cert_not_yet_valid',
  'ca_not_pem', 'ca_is_private_key', 'ca_not_a_ca', 'ca_not_issuer'] as const

/** 422 cert_invalid 의 vars.checks 중 통과하지 못한 항목만 반환 */
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

const DONE_KEEP_MS = 10 * 60_000        // 완료된 작업을 "바꿨습니다"로 유지하는 시간
const FAILED_KEEP_MS = 24 * 3_600_000   // 실패는 하루 동안 재표시한다(화면을 새로 열어도 유지)

/** 최근 인증서 작업 중 현재 표시할 대상 — 진행 중, 방금 완료된 작업, 하루 이내에 실패한 작업 */
export function shownCertJob(job: ZoneJob | null | undefined, now = Date.now()): ZoneJob | null {
  if (!job || job.kind !== 'cert') return null
  if (job.status === 'running' || job.status === 'unknown') return job
  const at = Date.parse(job.finished_at || job.started_at || '')
  if (Number.isNaN(at)) return null
  return now - at <= (job.status === 'failed' ? FAILED_KEEP_MS : DONE_KEEP_MS) ? job : null
}
