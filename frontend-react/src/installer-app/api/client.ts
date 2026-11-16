/**
 * 설치 관리자 API 클라이언트 — 같은 출처의 `/api/*` 를 부른다. 세션은 서버가 준 쿠키로만 간다
 * (토큰을 저장하거나 요청마다 싣지 않는다).
 *
 * 서버 응답을 화면이 쓰는 꼴(types.ts)로 맞추는 일도 여기서 한다 — 경로·본문·응답 모양이 서버와 달라지면 이 파일만 고친다.
 *  - `GET /api/state`: 세션이 없으면 401 → `session: 'none'` 인 상태로 바꾼다. 잠긴 뒤에는 `{phase, locked, url, info.commands}` 만 온다.
 *    서버 터미널에서 치는 명령(`info.commands`)은 서버가 준 글자를 그대로 보여 준다 — 세션이 없을 때는 명령을 모른다(그 줄을 숨긴다).
 *  - `POST /api/session`: 성공은 `{ok}`, 실패는 401(token_wrong · token_expired) · 429(token_locked) → `SessionResponse`.
 *  - `POST /api/apply` · `/retry`: `{started}` 만 온다 → 바로 상태를 읽어 돌려준다.
 *  - `GET /api/summary`: 구역이 `{id, name}` 목록으로 온다 → id 목록으로.
 *  - `POST /api/probe/cert`: 파일이 아니라 파일의 글자(PEM)를 JSON 으로 보낸다.
 *  - 상태 흐름(SSE)은 `status` · `end` 이름의 이벤트로 온다.
 *  - 복원(`/api/restore/*`): 복원이 없는 옛 서버(501, 읽기 요청은 404·405)는 전부 "지원하지 않음"으로 알린다.
 *    올리기는 다 올라간 뒤에도 서버가 파일을 확인하는 동안 응답이 오지 않는다 — 진행률 100 을 알린 뒤 기다린다.
 */
import {
  ApiError,
  type AiProbe, type AiProbeRequest, type AnswersPatch, type AnswersResponse, type ApplyLog, type ApplyState, type CertProbe,
  type DnsProbe, type InstallerApi, type LocalPathProbe, type MailRecordsProbe, type NfsProbe, type PreflightResponse, type PublicIpProbe,
  type RestoreFileInfo, type RestoreReview, type RestoreTarget, type SessionResponse, type SmtpProbe, type SmtpProbeRequest,
  type StateResponse, type SummaryResponse, type ZonesResponse,
} from './types'

const POLL_MS = 2000

async function parse(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try { return JSON.parse(text) } catch { return text }
}

function errorCode(body: unknown): string | null {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    const d = b.detail
    if (typeof b.code === 'string') return b.code
    if (typeof d === 'string') return d
    if (d && typeof d === 'object' && typeof (d as Record<string, unknown>).code === 'string') return (d as Record<string, string>).code
  }
  return null
}

function errorVars(body: unknown): Record<string, unknown> {
  const v = body && typeof body === 'object' ? (body as Record<string, unknown>).vars : null
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/** 서버의 상태 응답 → 화면이 쓰는 상태 */
export function normalizeState(raw: Record<string, unknown> | null, session: StateResponse['session']): StateResponse {
  const r = raw ?? {}
  const phase = (r.phase === 'applying' || r.phase === 'installed' ? r.phase : 'wizard') as StateResponse['phase']
  const facts = (r.facts && typeof r.facts === 'object' ? r.facts : {}) as StateResponse['facts']
  const info = (r.info && typeof r.info === 'object' ? r.info : {}) as StateResponse['info']
  return {
    session,
    phase,
    locked: r.locked === true || phase === 'installed',
    step: typeof r.step === 'string' ? r.step : null,
    facts,
    info: {
      ...info,
      version: typeof r.version === 'string' ? r.version : null,
      app_url: typeof r.url === 'string' ? r.url : null,
      commands: info.commands ?? {},
    },
  }
}

/** 요약 응답의 구역(`{id, name}` 또는 id) → id 목록 */
export function normalizeSummary(raw: Record<string, unknown>): SummaryResponse {
  const zones = Array.isArray(raw.zones) ? raw.zones.map(z => (z && typeof z === 'object' ? String((z as { id: unknown }).id) : String(z))) : []
  return { ...(raw as unknown as SummaryResponse), zones, cautions: (raw.cautions as SummaryResponse['cautions']) ?? [], errors: (raw.errors as SummaryResponse['errors']) ?? [] }
}

export function createHttpApi(base = ''): InstallerApi {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } }
    if (body !== undefined) {
      init.body = JSON.stringify(body)
      init.headers = { ...init.headers, 'Content-Type': 'application/json' }
    }
    const res = await fetch(base + path, init)
    const data = await parse(res)
    if (!res.ok) throw new ApiError(res.status, errorCode(data), data)
    return data as T
  }

  /** 복원 요청 — 서버에 아직 없는 길(404 · 405)도 "지원하지 않음"(501)으로 맞춘다 */
  async function restore<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await call<T>(method, path, body)
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) throw new ApiError(501, 'restore_not_supported', e.body)
      throw e
    }
  }

  /** 상태 흐름(SSE) — 열 수 없거나 끊기면 주기적으로 읽는 것으로 바꾼다. 끝 상태(done · failed)를 받으면 멈춘다 */
  function stream(path: string, read: () => Promise<ApplyState>, onState: (s: ApplyState) => void): () => void {
    let closed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let source: EventSource | null = null
    let last: ApplyState | null = null
    const give = (s: ApplyState) => { last = s; onState(s) }
    const stop = () => {
      closed = true
      source?.close()
      source = null
      if (timer != null) clearTimeout(timer)
    }
    const poll = () => {
      if (closed) return
      read().then(s => {
        if (closed) return
        give(s)
        if (s.status === 'done') stop()
      }).catch(e => {
        if (closed || !(e instanceof ApiError)) return
        // 잠겼다(423) = 마지막 단계까지 끝났다. 끝 상태를 읽기 전에 잠겼으면 마지막으로 본 상태를 "완료"로 마무리한다
        if (e.status === 423 && last && last.status === 'running') {
          onState({ ...last, status: 'done', current: null, steps: last.steps.map(st => ({ ...st, status: 'done' as const })) })
        }
        if (e.status === 423 || e.status === 501) stop()
      }).finally(() => {
        if (!closed) timer = setTimeout(poll, POLL_MS)
      })
    }
    if (typeof EventSource === 'undefined') poll()
    else {
      source = new EventSource(base + path, { withCredentials: true })
      const take = (e: MessageEvent) => {
        try { give(JSON.parse(e.data) as ApplyState) } catch { /* 깨진 조각은 버린다 */ }
      }
      source.addEventListener('status', take as EventListener)
      source.onmessage = take
      source.addEventListener('end', () => stop())
      source.onerror = () => {
        source?.close()
        source = null
        if (!closed && timer == null) poll()
      }
    }
    return stop
  }

  const api: InstallerApi = {
    async getState() {
      try {
        return normalizeState(await call<Record<string, unknown>>('GET', '/api/state'), 'ok')
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return normalizeState(null, 'none')
        throw e
      }
    },
    async createSession(token): Promise<SessionResponse> {
      try {
        await call('POST', '/api/session', { token })
        return { status: 'ok' }
      } catch (e) {
        if (!(e instanceof ApiError)) throw e
        const retry = Number(errorVars(e.body).retry_after) || undefined
        if (e.code === 'token_expired') return { status: 'expired' }
        if (e.code === 'token_locked' || e.status === 429) return { status: 'locked', retry_after: retry }
        if (e.code === 'token_wrong' || e.status === 401) return { status: 'wrong', retry_after: retry }
        throw e
      }
    },
    async getAnswers() {
      const r = await call<{ answers: AnswersResponse['answers']; secrets_set?: Record<string, boolean>; errors?: AnswersResponse['errors'] }>('GET', '/api/answers')
      return { answers: r.answers, secrets: r.secrets_set ?? {}, errors: r.errors ?? [] }
    },
    async putAnswers(patch: AnswersPatch, step?: string) {
      const r = await call<{ answers: AnswersResponse['answers']; secrets_set?: Record<string, boolean>; errors?: AnswersResponse['errors'] }>(
        'PUT', '/api/answers' + (step ? `?step=${encodeURIComponent(step)}` : ''), patch)
      return { answers: r.answers, secrets: r.secrets_set ?? {}, errors: r.errors ?? [] }
    },
    preflight: () => call<PreflightResponse>('POST', '/api/preflight'),
    getZones: () => call<ZonesResponse>('GET', '/api/zones'),
    probePublicIp: () => call<PublicIpProbe>('GET', '/api/probe/public-ip'),
    probeDns: domain => call<DnsProbe>('POST', '/api/probe/dns', { domain }),
    probeMailRecords: mailDomain => call<MailRecordsProbe>('POST', '/api/probe/mail-records', { mail_domain: mailDomain }),
    async probeCert(cert, key, domain, ca) {
      const [certPem, keyPem, caPem] = await Promise.all([cert.text(), key.text(), ca ? ca.text() : Promise.resolve('')])
      return call<CertProbe>('POST', '/api/probe/cert', { cert: certPem, key: keyPem, ...(caPem ? { ca: caPem } : {}), ...(domain ? { domain } : {}) })
    },
    probeSmtp: (req: SmtpProbeRequest) => call<SmtpProbe>('POST', '/api/probe/smtp', req),
    probeAi: (req: AiProbeRequest) => call<AiProbe>('POST', '/api/probe/ai', req),
    probeNfs: (server, exportPath) => call<NfsProbe>('POST', '/api/probe/nfs', { server, export: exportPath }),
    probeLocalPath: path => call<LocalPathProbe>('POST', '/api/probe/local-path', { path }),
    getSummary: async () => normalizeSummary(await call<Record<string, unknown>>('GET', '/api/summary')),
    answersExportUrl: () => base + '/api/answers/export',
    async startApply() {
      try {
        await call('POST', '/api/apply')
      } catch (e) {
        // 이미 돌고 있으면 그 진행을 그대로 보여 준다
        if (!(e instanceof ApiError && e.code === 'apply_running')) throw e
      }
      return api.getApply()
    },
    getApply: () => call<ApplyState>('GET', '/api/apply'),
    streamApply: onState => stream('/api/apply/stream', () => api.getApply(), onState),
    async retryApply(opts) {
      try {
        await call('POST', '/api/apply/retry', opts ?? {})
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'apply_running')) throw e
      }
      return api.getApply()
    },
    getApplyLog: (step, tail) => call<ApplyLog>('GET', `/api/apply/log?step=${encodeURIComponent(step)}${tail ? `&tail=${tail}` : ''}`),

    restoreUpload: (file, onProgress, signal) => new Promise<RestoreFileInfo>((resolve, reject) => {
      // 올리는 진행률은 fetch 로 알 수 없어 XMLHttpRequest 를 쓴다
      const xhr = new XMLHttpRequest()
      xhr.open('POST', base + '/api/restore/upload')
      xhr.withCredentials = true
      xhr.responseType = 'text'
      xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)) }
      // 다 올라갔다 — 이제부터는 서버가 형식과 해시를 확인하는 시간이다
      xhr.upload.onload = () => onProgress(100)
      xhr.onload = () => {
        let data: unknown
        try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null } catch { data = xhr.responseText }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data as RestoreFileInfo)
        else reject(new ApiError(xhr.status === 404 || xhr.status === 405 ? 501 : xhr.status, errorCode(data), data))
      }
      xhr.onerror = () => reject(new ApiError(0, 'network', null))
      xhr.onabort = () => reject(new ApiError(0, 'aborted', null))
      signal?.addEventListener('abort', () => xhr.abort())
      const form = new FormData()
      form.append('file', file)
      xhr.send(form)
    }),
    restoreCheckPath: path => restore<RestoreFileInfo>('POST', '/api/restore/path', { path }),
    restorePassword: password => restore<RestoreFileInfo>('POST', '/api/restore/password', { password }),
    restoreFile: () => restore<RestoreFileInfo>('GET', '/api/restore/file'),
    async restoreDiscard() { await restore('DELETE', '/api/restore/file') },
    restoreReview: () => restore<RestoreReview>('GET', '/api/restore/review'),
    async restoreApply(target: RestoreTarget) {
      try {
        await restore('POST', '/api/restore/apply', target)
      } catch (e) {
        // 이미 돌고 있으면 그 진행을 그대로 보여 준다
        if (!(e instanceof ApiError && e.code === 'apply_running')) throw e
      }
      return api.restoreGetApply()
    },
    restoreGetApply: () => restore<ApplyState>('GET', '/api/restore/apply'),
    restoreStream: onState => stream('/api/restore/apply/stream', () => api.restoreGetApply(), onState),
    async restoreRetry(opts) {
      try {
        await restore('POST', '/api/restore/apply/retry', opts ?? {})
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'apply_running')) throw e
      }
      return api.restoreGetApply()
    },
  }
  return api
}
