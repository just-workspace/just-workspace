/**
 * 화면이 쓰는 설치 관리자 API 의 형태 — 실제 클라이언트(client.ts)와 가짜 서버(mock.ts)가 같이 쓴다.
 * 문구는 여기에 없다: 서버는 키(id · code · cause · fix.key)와 값만 주고, 화면이 번역 파일에서 문구를 찾는다.
 * 대부분 서버 응답 그대로이고, 다른 곳(상태 · 세션 · 요약의 구역 · 적용 시작)은 client.ts 가 이 꼴로 맞춘다.
 * 서버가 아직 주지 않는 값(이어 할 단계 · 감지한 연결 형태 · 기본 저장 폴더 등)은 비어 있고, 화면은 빈 값이면 그 줄을 숨긴다.
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
  /** zones 가 비어 있을 때 쓰는 묶음 이름 */
  preset?: string | null
  /** 켤 구역 id. null 이면 묶음(preset)을 따른다 */
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

/** 서버가 답변을 검사해 돌려주는 오류 — field 는 'access.cert' 같은 경로 */
export interface FieldError { field: string; code: string; vars?: Record<string, unknown> }

export interface AnswersResponse {
  answers: Answers
  /** 서버가 이미 가지고 있는 비밀('admin.password' · 'mail.password' · 'ai.api_key'). 값은 돌려주지 않는다 */
  secrets: Record<string, boolean>
  errors: FieldError[]
}

// ─── 상태 ───

/** ok = 세션 있음 · none = 토큰 없이 들어옴 · wrong · expired · locked = 여러 번 틀려 잠시 받지 않음 */
export type SessionStatus = 'ok' | 'none' | 'wrong' | 'expired' | 'locked'
export type Phase = 'wizard' | 'applying' | 'installed'

export interface StateResponse {
  session: SessionStatus
  /** session=locked 일 때 다시 받을 때까지 남은 초 */
  retry_after?: number
  phase: Phase
  /** 설치가 끝나 마법사가 잠겼다 */
  locked: boolean
  /** 이어서 할 단계(서버가 기억해 줄 때). 없으면 화면이 답변에서 짐작한다 */
  step: string | null
  /** 감지한 값 — 모르면 null */
  facts: {
    memory_mb?: number | null
    public_ip?: string | null
    lan_ip?: string | null
    detected_network?: Network | null
    disk_free_gb?: number | null
  }
  /** 화면에 보여 줄 값(없으면 그 줄을 숨긴다) */
  info: {
    version?: string | null
    /** 설치가 끝난 워크스페이스 주소(잠긴 뒤 로그인 화면으로 보낼 곳) */
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
    /** 이 제품의 소스가 있는 곳("소스 코드" 링크) */
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
  /** '25/tcp' · '7882-7892/udp' 꼴 */
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
  /** 서버 메모리를 알 때만 */
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
export interface CertProbe { ok: boolean; checks: CertCheck[]; names?: string[]; not_after?: string | null; issuer?: string | null }
export interface SmtpProbe { status: 'ok' | 'unreachable' | 'tls_failed' | 'auth_failed' | 'error'; detail?: string | null }
export interface AiProbe { status: 'ok' | 'auth_failed' | 'unreachable' | 'error'; http_status?: number | null; models?: string[] }
/**
 * export_not_found = 서버에는 닿았는데 그 경로를 붙일 수 없다.
 * marker_missing · other_install = 복원에서만: 다섯 검사는 통과했지만 이 공유가 백업의 그 저장소가 아니다
 */
export type NfsCause = 'unreachable' | 'export_not_found' | 'permission_denied' | 'read_only' | 'no_locking' | 'marker_missing' | 'other_install'
export type NfsStepId = 'reach' | 'mount' | 'write' | 'lock' | 'space'
export interface NfsStep { id: NfsStepId | string; status: 'pass' | 'warn' | 'fail' | 'skipped'; value: unknown }
export interface NfsProbe {
  ok: boolean
  cause: NfsCause | string | null
  steps: NfsStep[]
  /** 복원에서만 — 이 공유에 남아 있는 설치 표식이 백업과 맞는가 */
  marker?: { status: 'match' | 'missing' | 'mismatch' } | null
}
export interface LocalPathProbe { status: 'ok' | 'not_found' | 'not_writable' | 'error'; path?: string; free_gb?: number | null }

export interface SmtpProbeRequest { host: string; port: number; security: MailSecurity; username: string; password: string }
export interface AiProbeRequest { provider: string; api_key: string; base_url?: string | null }

// ─── 요약 ───

export interface Caution { key: string; vars?: Record<string, unknown> }
export interface SummaryResponse {
  /** 설치할 수 있는가 — 답변 오류가 없고 사전 점검을 통과했다. 서버가 주지 않으면 오류 유무로만 본다 */
  ready?: boolean
  /** 서버가 기억하는 마지막 사전 점검 */
  preflight?: { checked: boolean; ok: boolean; checked_at?: string | null }
  /** 켤 구역·애드온 id(선언 순서) */
  zones: string[]
  /** 열리는 포트('80/tcp' 꼴) */
  ports: string[]
  memory?: MemoryVerdict | null
  /** 받을 이미지 용량(바이트). 모르면 없음 */
  download_bytes?: number | null
  /** 앞 단계에서 넘어온 주의 */
  cautions: Caution[]
  /** 이대로는 설치할 수 없는 이유 */
  errors: FieldError[]
  /** 서버가 정한 것(빠른 설치에서 묶음을 낮춘 경우 등) */
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
  /** 실패했을 때 고를 수 있는 다른 길. 예: use_temporary_cert */
  alternatives?: Array<{ key: string }>
  started_at?: string | null
  finished_at?: string | null
  updated_at?: string | null
  /** 복원일 때만 — 완료 화면의 문구를 가른다 */
  restore?: RestoreOutcome | null
}
/** files: restored = 백업의 파일을 되돌렸다 · not_included = 백업에 파일이 없었다 · nfs = 같은 네트워크 저장소를 다시 연결했다 */
export interface RestoreOutcome {
  files: 'restored' | 'not_included' | 'nfs'
  storage_kind: StorageKind
  domain_changed: boolean
  cert: CertMode
}
export interface ApplyLog { step: string; lines: string[] }

// ─── 복원 ───

/**
 * 올려 둔 백업의 상태.
 * status: ok = 복원할 수 있음 · invalid(reason: not_a_backup · format_unsupported · no_config · path_invalid) ·
 *   corrupt = 옮기는 중 손상 · password_required = 설정이 암호로 보호됨 · password_wrong · not_found · none = 올려 둔 백업 없음
 * state: 서버가 지금 하는 일(uploading · checking 이면 아직 결과가 아니다)
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
/** 복원을 막는 사유 — version_newer · memory_insufficient · memory_below_minimum */
export interface RestoreBlocker { code: string; vars?: Record<string, unknown> }
export interface RestoreReview {
  source_url?: string | null
  created_at?: string | null
  backup_version?: string | null
  installer_version?: string | null
  /** ok = 복원할 수 있음 · newer = 설치하는 버전보다 새 백업 */
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
  /** 백업에 파일이 들어 있는가 */
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
  /** 보내지 않으면 서버가 정한다(프록시 → proxy, 접속 주소가 이 서버를 가리키면 auto, 아니면 temporary) */
  cert?: 'auto' | 'temporary' | 'proxy'
  subnet?: string
}

// ─── 클라이언트 ───

export interface InstallerApi {
  getState(): Promise<StateResponse>
  createSession(token: string): Promise<SessionResponse>
  getAnswers(): Promise<AnswersResponse>
  /** 부분 저장. step 은 이어서 할 단계(다음에 열 화면) */
  putAnswers(patch: AnswersPatch, step?: string): Promise<AnswersResponse>
  preflight(): Promise<PreflightResponse>
  getZones(): Promise<ZonesResponse>
  probeDns(domain: string): Promise<DnsProbe>
  probeMailRecords(mailDomain: string): Promise<MailRecordsProbe>
  probePublicIp(): Promise<PublicIpProbe>
  /** domain 은 아직 저장하지 않은 접속 주소로 검사할 때 */
  probeCert(cert: File, key: File, domain?: string): Promise<CertProbe>
  probeSmtp(req: SmtpProbeRequest): Promise<SmtpProbe>
  probeAi(req: AiProbeRequest): Promise<AiProbe>
  probeNfs(server: string, exportPath: string): Promise<NfsProbe>
  probeLocalPath(path: string): Promise<LocalPathProbe>
  getSummary(): Promise<SummaryResponse>
  /** 답변 파일 내려받기 주소 */
  answersExportUrl(): string
  startApply(): Promise<ApplyState>
  getApply(): Promise<ApplyState>
  /** 적용 상태 흐름을 듣는다. 돌려주는 함수로 끊는다. 흐름을 열 수 없으면 주기적으로 다시 읽는다 */
  streamApply(onState: (s: ApplyState) => void): () => void
  retryApply(opts?: { use_temporary_cert?: boolean }): Promise<ApplyState>
  /** tail = 끝에서 몇 줄(서버 기본 500) */
  getApplyLog(step: string, tail?: number): Promise<ApplyLog>
  restoreUpload(file: File, onProgress: (percent: number) => void, signal?: AbortSignal): Promise<RestoreFileInfo>
  restoreCheckPath(path: string): Promise<RestoreFileInfo>
  /** 암호로 보호된 백업 — 암호를 넣고 다시 확인한다 */
  restorePassword(password: string): Promise<RestoreFileInfo>
  /** 지금 올려 둔 백업(없으면 status 'none') */
  restoreFile(): Promise<RestoreFileInfo>
  /** 올려 둔 백업을 버린다 */
  restoreDiscard(): Promise<void>
  restoreReview(): Promise<RestoreReview>
  restoreApply(target: RestoreTarget): Promise<ApplyState>
  restoreGetApply(): Promise<ApplyState>
  restoreStream(onState: (s: ApplyState) => void): () => void
  restoreRetry(opts?: { use_temporary_cert?: boolean }): Promise<ApplyState>
}

/** 서버가 2xx 가 아닌 응답을 줬다 */
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
  /** 서버가 오류와 같이 준 값(`{code, vars}` 의 vars) */
  get vars(): Record<string, unknown> {
    const v = this.body && typeof this.body === 'object' ? (this.body as Record<string, unknown>).vars : null
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  }
  /** 서버가 아직 만들지 않은 기능 */
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
