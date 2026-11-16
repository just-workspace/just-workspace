/**
 * 화면이 사용하는 설치 관리자 API 의 형태 — 실제 클라이언트(client.ts)와 가짜 서버(mock.ts)가 공용한다.
 * 문구는 여기에 없다: 서버는 키(id · code · cause · fix.key)와 값만 전달하고, 화면이 번역 파일에서 문구를 조회한다.
 * 대부분 서버 응답과 동일하며, 상이한 부분(상태 · 세션 · 요약의 구역 · 적용 시작)은 client.ts 가 이 형태로 변환한다.
 * 서버가 아직 제공하지 않는 값(이어 할 단계 · 감지한 연결 형태 · 기본 저장 폴더 등)은 비어 있으며, 화면은 빈 값이면 해당 줄을 숨긴다.
 */

// ─── 답변 ───

export type Mode = 'new' | 'quick' | 'restore'
export type Network = 'direct' | 'router' | 'proxy'
export type CertMode = 'auto' | 'upload' | 'temporary' | 'proxy'
export type StorageKind = 'local' | 'nfs'
export type MailKind = 'builtin' | 'external'
export type MailSecurity = 'starttls' | 'ssl' | 'none'

export interface Answers {
  version?: number
  mode: Mode
  access: {
    domain: string
    network: Network
    proxy_addresses: string[]
    cert: CertMode
    acme_email?: string | null
    cert_path?: string | null
    key_path?: string | null
  }
  storage: { kind: StorageKind; path?: string | null; server?: string | null; export?: string | null }
  /** zones 가 비어 있을 때 사용하는 프리셋 이름 */
  preset?: string | null
  /** 활성화할 구역 id. null 이면 프리셋(preset)을 따름 */
  zones?: string[] | null
  addons: string[]
  mail: {
    kind: MailKind
    mail_domain?: string | null
    host?: string | null
    port: number
    security: MailSecurity
    username?: string | null
    password?: string | null
    from_address?: string | null
  }
  meetings: { public_ip?: string | null; turn: boolean; lossless_audio: boolean }
  ai: { mode: 'later' | 'provider'; provider?: string | null; model?: string | null; base_url?: string | null; api_key?: string | null }
  git: { version: string }
  advanced: { subnet: string }
  admin: { name: string; username: string; password?: string | null }
}

export type DeepPartial<T> = T extends Array<infer U> ? Array<U> : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> | null } : T
export type AnswersPatch = DeepPartial<Answers>

/** 서버가 답변을 검증하여 반환하는 오류 — field 는 'access.cert' 형태의 경로 */
export interface FieldError { field: string; code: string; vars?: Record<string, unknown> }

export interface AnswersResponse {
  answers: Answers
  /** 서버가 이미 보유한 비밀('admin.password' · 'mail.password' · 'ai.api_key'). 값은 반환하지 않음 */
  secrets: Record<string, boolean>
  errors: FieldError[]
}

// ─── 상태 ───

/** ok = 세션 있음 · none = 토큰 없이 진입 · wrong · expired · locked = 반복 불일치로 일시 수신 거부 */
export type SessionStatus = 'ok' | 'none' | 'wrong' | 'expired' | 'locked'
export type Phase = 'wizard' | 'applying' | 'installed'

export interface StateResponse {
  session: SessionStatus
  /** session=locked 일 때 재수신 가능 시점까지 남은 초 */
  retry_after?: number
  phase: Phase
  /** 설치 완료로 마법사 잠김 */
  locked: boolean
  /** 이어서 진행할 단계(서버가 기억하는 경우). 없으면 화면이 답변에서 추정 */
  step: string | null
  /** 감지한 값 — 알 수 없으면 null */
  facts: {
    memory_mb?: number | null
    public_ip?: string | null
    lan_ip?: string | null
    detected_network?: Network | null
    /** 클라우드 메타데이터 서비스 감지 여부 — 사설 주소여도 공인 주소가 1:1 로 연결된 서버 */
    cloud?: boolean
    disk_free_gb?: number | null
  }
  /** 화면에 표시할 값(없으면 해당 줄 숨김) */
  info: {
    version?: string | null
    /** 설치 완료된 워크스페이스 주소(잠긴 이후 로그인 화면으로 이동시킬 대상) */
    app_url?: string | null
    default_storage_path?: string | null
    git_verified_version?: string | null
    username_rule?: string | null
    commands?: {
      reissue_token?: string | null
      reinstall?: string | null
      reset_admin?: string | null
      install_from_answers?: string | null
    }
    answers_example?: string | null
    backup_file_format?: string | null
    /** 본 제품의 소스 위치("소스 코드" 링크) */
    source_url?: string | null
  }
}

export interface SessionResponse { status: SessionStatus; retry_after?: number }
export interface PublicIpProbe { status: 'detected' | 'unknown'; ip: string | null; source?: string | null }

// ─── 사전 점검 ───

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'checking'
export interface Fix { key: string; vars?: Record<string, unknown> }
export interface PreflightItem { id: string; status: CheckStatus; value: unknown; fix: Fix | null }
export interface PreflightResponse {
  ok: boolean
  items: PreflightItem[]
  facts?: { memory_mb?: number | null; cpus?: number | null; outbound_address?: string | null }
}

// ─── 구역 ───

export interface LocalizedText { ko: string; en: string; [code: string]: string }
export interface ZoneRow {
  id: string
  kind?: 'zone' | 'addon'
  name: LocalizedText
  summary: LocalizedText
  memory_mb: { idle?: number; limit?: number; recommend: number }
  /** '25/tcp' · '7882-7892/udp' 형태 */
  ports: string[]
  requires: string[]
  wizard_step?: string | null
  selected?: boolean
  fits?: boolean
}
export interface MemoryVerdict { need_mb: number; have_mb: number; nominal_mb: number; ok: boolean; below_minimum: boolean }
export interface ZonesResponse {
  version?: number | string | null
  core: Pick<ZoneRow, 'id' | 'name' | 'summary' | 'memory_mb' | 'ports'>
  presets: Record<string, string[]>
  zones: ZoneRow[]
  addons: ZoneRow[]
  /** 서버 메모리가 확인된 경우에만 존재 */
  memory?: MemoryVerdict
  preset_fits?: Record<string, boolean>
}

// ─── 확인(probe) ───

export interface DnsProbe {
  status: 'match' | 'mismatch' | 'unknown'
  addresses: string[]
  public_ip: string | null
  reason?: string | null
}
export type RecordStatus = 'ok' | 'missing' | 'different' | 'unknown'
export interface MailRecord { id: string; name: string; type: string; expected: string; current: string[]; status: RecordStatus }
export interface MailRecordsProbe { mail_domain: string; records: MailRecord[]; ok: boolean }
export interface CertCheck { id: string; status: 'pass' | 'warn' | 'fail'; value: unknown; fix: Fix | null }
export interface CertProbe {
  ok: boolean; checks: CertCheck[]; names?: string[]; not_after?: string | null; issuer?: string | null
  /** 이 서버의 다른 컨테이너가 이 인증서를 신뢰하는 데 필요한 발급 CA 의 확보 여부 — included(체인이 함께 전달됐거나 CA 를 별도로 업로드함) · none · self_signed */
  trust?: 'included' | 'none' | 'self_signed'
}
export interface SmtpProbe { status: 'ok' | 'unreachable' | 'tls_failed' | 'auth_failed' | 'error'; detail?: string | null }
export interface AiProbe { status: 'ok' | 'auth_failed' | 'unreachable' | 'error'; http_status?: number | null; models?: string[] }
/**
 * export_not_found = 서버에는 도달했으나 해당 경로를 마운트할 수 없음.
 * marker_missing · other_install = 복원 전용: 다섯 검사는 통과했으나 이 공유가 백업의 해당 저장소가 아님
 */
export type NfsCause = 'unreachable' | 'export_not_found' | 'permission_denied' | 'read_only' | 'no_locking' | 'marker_missing' | 'other_install'
export type NfsStepId = 'reach' | 'mount' | 'write' | 'lock' | 'space'
export interface NfsStep { id: NfsStepId | string; status: 'pass' | 'warn' | 'fail' | 'skipped'; value: unknown }
export interface NfsProbe {
  ok: boolean
  cause: NfsCause | string | null
  steps: NfsStep[]
  /** 복원 전용 — 이 공유에 남아 있는 저장소 마커와 백업의 일치 여부 */
  marker?: { status: 'match' | 'missing' | 'mismatch' } | null
}
export interface LocalPathProbe { status: 'ok' | 'not_found' | 'not_writable' | 'error'; path?: string; free_gb?: number | null }

export interface SmtpProbeRequest { host: string; port: number; security: MailSecurity; username: string; password: string }
export interface AiProbeRequest { provider: string; api_key: string; base_url?: string | null }

// ─── 요약 ───

export interface Caution { key: string; vars?: Record<string, unknown> }
export interface SummaryResponse {
  /** 설치 가능 여부 — 답변 오류가 없고 사전 점검을 통과한 상태. 서버가 제공하지 않으면 오류 유무로만 판단 */
  ready?: boolean
  /** 서버가 기억하는 마지막 사전 점검 */
  preflight?: { checked: boolean; ok: boolean; checked_at?: string | null }
  /** 활성화할 구역·애드온 id(선언 순서) */
  zones: string[]
  /** 개방되는 포트('80/tcp' 형태) */
  ports: string[]
  memory?: MemoryVerdict | null
  /** pull 대상 이미지 용량(바이트). 알 수 없으면 없음 */
  download_bytes?: number | null
  /** 이전 단계에서 전달된 주의 */
  cautions: Caution[]
  /** 현재 상태로는 설치할 수 없는 사유 */
  errors: FieldError[]
  /** 서버가 결정한 사항(빠른 설치에서 프리셋을 하향한 경우 등) */
  notes?: Caution[]
}

// ─── 적용 ───

export type ApplyStatus = 'idle' | 'running' | 'failed' | 'done'
export type ApplyStepStatus = 'pending' | 'running' | 'done' | 'failed'
export interface StepFailure { cause: string; fix?: string | null; vars?: Record<string, unknown> }
export interface ImageProgress { image: string; status: 'pending' | 'present' | 'pulling' | 'done' | 'failed'; progress?: string; percent?: number | null }
export interface ZoneProgress { id: string; status: 'pending' | 'installing' | 'installed' | 'connecting' | 'done' | 'failed' }
export interface ApplyStep {
  id: string
  status: ApplyStepStatus
  started_at?: string | null
  finished_at?: string | null
  error?: StepFailure | null
  detail?: { images?: ImageProgress[]; zones?: ZoneProgress[]; percent?: number | null }
}
export interface ApplyState {
  status: ApplyStatus
  steps: ApplyStep[]
  current: string | null
  error: (StepFailure & { step?: string }) | null
  notes?: Caution[]
  warnings?: Caution[]
  /** 실패 시 선택 가능한 대안. 예: use_temporary_cert */
  alternatives?: Array<{ key: string }>
  started_at?: string | null
  finished_at?: string | null
  updated_at?: string | null
  /** 복원 전용 — 완료 화면의 문구를 분기 */
  restore?: RestoreOutcome | null
}
/** files: restored = 백업의 파일을 복원함 · not_included = 백업에 파일이 없었음 · nfs = 동일한 네트워크 저장소를 재연결함 */
export interface RestoreOutcome {
  files: 'restored' | 'not_included' | 'nfs'
  storage_kind: StorageKind
  domain_changed: boolean
  cert: CertMode
}
export interface ApplyLog { step: string; lines: string[] }

// ─── 복원 ───

/**
 * 등록된 백업의 상태.
 * status: ok = 복원 가능 · invalid(reason: not_a_backup · format_unsupported · no_config · path_invalid) ·
 *   corrupt = 전송 중 손상 · password_required = 설정이 암호로 보호됨 · password_wrong · not_found · none = 등록된 백업 없음
 * state: 서버의 현재 작업(uploading · checking 이면 아직 결과가 아님)
 */
export type RestoreFileStatus = 'ok' | 'invalid' | 'corrupt' | 'password_required' | 'password_wrong' | 'not_found' | 'none'
export interface RestoreFileInfo {
  status: RestoreFileStatus
  state?: 'none' | 'uploading' | 'checking' | 'ready' | 'failed'
  name?: string | null
  size_bytes?: number | null
  source?: 'upload' | 'path' | null
  path?: string | null
  reason?: string | null
}
/** 복원 차단 사유 — version_newer · memory_insufficient · memory_below_minimum */
export interface RestoreBlocker { code: string; vars?: Record<string, unknown> }
export interface RestoreReview {
  source_url?: string | null
  created_at?: string | null
  backup_version?: string | null
  installer_version?: string | null
  /** ok = 복원 가능 · newer = 설치 대상 버전보다 최신인 백업 */
  version_status: 'ok' | 'newer'
  version_reason?: 'schema' | 'product' | null
  schema_version?: number | string | null
  installer_schema_version?: number | string | null
  kind?: 'full' | 'pre-update' | null
  size_bytes?: number | null
  zones: string[]
  users?: number | null
  data_bytes?: number | null
  storage: { kind: StorageKind; server?: string | null; export?: string | null }
  /** 백업의 파일 포함 여부 */
  files_included: boolean
  files_bytes?: number | null
  /** 접속 주소 기본값(백업의 접속 주소) */
  domain: string
  mail_domain?: string | null
  install_id?: string | null
  /** 연결 형태 · 프록시 주소 · 내부 대역의 기본값 */
  network?: Network | null
  proxy_addresses?: string[] | null
  subnet?: string | null
  blockers?: RestoreBlocker[] | null
}
export interface RestoreTarget {
  domain: string
  storage: { kind: StorageKind; server?: string | null; export?: string | null }
  network?: Network
  proxy_addresses?: string[]
  /** 미전송 시 서버가 결정(프록시 → proxy, 접속 주소가 이 서버를 가리키면 auto, 그 외 temporary) */
  cert?: 'auto' | 'temporary' | 'proxy'
  subnet?: string
}

// ─── 클라이언트 ───

export interface InstallerApi {
  getState(): Promise<StateResponse>
  createSession(token: string): Promise<SessionResponse>
  getAnswers(): Promise<AnswersResponse>
  /** 부분 저장. step 은 이어서 진행할 단계(다음에 표시할 화면) */
  putAnswers(patch: AnswersPatch, step?: string): Promise<AnswersResponse>
  preflight(): Promise<PreflightResponse>
  getZones(): Promise<ZonesResponse>
  probeDns(domain: string): Promise<DnsProbe>
  probeMailRecords(mailDomain: string): Promise<MailRecordsProbe>
  probePublicIp(): Promise<PublicIpProbe>
  /** domain 은 아직 저장하지 않은 접속 주소로 검사할 때 지정 */
  probeCert(cert: File, key: File, domain?: string, ca?: File | null): Promise<CertProbe>
  probeSmtp(req: SmtpProbeRequest): Promise<SmtpProbe>
  probeAi(req: AiProbeRequest): Promise<AiProbe>
  probeNfs(server: string, exportPath: string): Promise<NfsProbe>
  probeLocalPath(path: string): Promise<LocalPathProbe>
  getSummary(): Promise<SummaryResponse>
  /** 응답 파일 다운로드 주소 */
  answersExportUrl(): string
  startApply(): Promise<ApplyState>
  getApply(): Promise<ApplyState>
  /** 적용 상태 흐름을 구독한다. 반환된 함수로 해제한다. 흐름을 열 수 없으면 주기적으로 재조회한다 */
  streamApply(onState: (s: ApplyState) => void): () => void
  retryApply(opts?: { use_temporary_cert?: boolean }): Promise<ApplyState>
  /** tail = 끝에서부터의 줄 수(서버 기본 500) */
  getApplyLog(step: string, tail?: number): Promise<ApplyLog>
  restoreUpload(file: File, onProgress: (percent: number) => void, signal?: AbortSignal): Promise<RestoreFileInfo>
  restoreCheckPath(path: string): Promise<RestoreFileInfo>
  /** 암호로 보호된 백업 — 암호 입력 후 재확인 */
  restorePassword(password: string): Promise<RestoreFileInfo>
  /** 현재 등록된 백업(없으면 status 'none') */
  restoreFile(): Promise<RestoreFileInfo>
  /** 등록된 백업 폐기 */
  restoreDiscard(): Promise<void>
  restoreReview(): Promise<RestoreReview>
  restoreApply(target: RestoreTarget): Promise<ApplyState>
  restoreGetApply(): Promise<ApplyState>
  restoreStream(onState: (s: ApplyState) => void): () => void
  restoreRetry(opts?: { use_temporary_cert?: boolean }): Promise<ApplyState>
}

/** 서버가 2xx 가 아닌 응답을 반환함 */
export class ApiError extends Error {
  status: number
  code: string | null
  body: unknown
  constructor(status: number, code: string | null, body: unknown) {
    super(`HTTP ${status}${code ? ` ${code}` : ''}`)
    this.status = status
    this.code = code
    this.body = body
  }
  /** 서버가 오류와 함께 전달한 값(`{code, vars}` 의 vars) */
  get vars(): Record<string, unknown> {
    const v = this.body && typeof this.body === 'object' ? (this.body as Record<string, unknown>).vars : null
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  }
  /** 서버에 아직 구현되지 않은 기능 */
  get notImplemented(): boolean { return this.status === 501 }
  get unauthorized(): boolean { return this.status === 401 || this.status === 403 }
}

export function emptyAnswers(): Answers {
  return {
    version: 1,
    mode: 'new',
    access: { domain: '', network: 'direct', proxy_addresses: [], cert: 'auto' },
    storage: { kind: 'local', path: null, server: null, export: null },
    preset: null,
    zones: null,
    addons: [],
    mail: { kind: 'builtin', mail_domain: null, host: null, port: 587, security: 'starttls', username: null },
    meetings: { public_ip: null, turn: true, lossless_audio: false },
    ai: { mode: 'later', provider: null },
    git: { version: 'verified' },
    advanced: { subnet: '172.28.0.0/24' },
    admin: { name: '', username: '' },
  }
}
