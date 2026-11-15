/**
 * 마법사 상태 — 서버에서 읽은 것(상태·답변·구역 목록·점검 결과)과 화면에서만 들고 있는 것(비밀번호·키, 확인 결과).
 *
 * - 답변은 단계마다 서버에 저장한다(`save`). 서버가 돌려준 답변이 원본이다.
 * - 비밀번호와 키는 여기(메모리)에만 둔다 — 브라우저 저장소에 쓰지 않는다. 저장이 필요한 순간에만 서버로 보낸다.
 * - 확인(probe) 결과는 "무엇을 확인한 결과인지"(key)와 같이 둔다 — 입력이 바뀌면 그 결과는 쓸 수 없다.
 * 화면마다 새 저장소를 만든다(전역 하나가 아니다) — 테스트가 서로 섞이지 않는다.
 */
import { createContext, useContext } from 'react'
import { createStore, useStore, type StoreApi } from 'zustand'
import {
  ApiError, emptyAnswers,
  type AiProbe, type AiProbeRequest, type Answers, type AnswersPatch, type ApplyState, type CertProbe, type DnsProbe, type FieldError, type InstallerApi,
  type LocalPathProbe, type MailRecordsProbe, type NfsProbe, type PreflightResponse, type SmtpProbe, type SmtpProbeRequest, type StateResponse, type ZonesResponse,
} from './api/types'
import { flow, liveSteps, ROUTES, type FlowStep, type StepId } from './flow'

export const QUICK_PRESET = 'collab'
export const FALLBACK_PRESET = 'minimal'
const PREFLIGHT_POLL_MS = 1500

export interface Probe<T> {
  status: 'idle' | 'checking' | 'done' | 'error'
  /** 무엇을 확인했는가(입력값을 이은 글자) */
  key: string
  result: T | null
}
const idle = <T,>(): Probe<T> => ({ status: 'idle', key: '', result: null })

export interface WizardState {
  api: InstallerApi
  boot: 'loading' | 'ready' | 'error'
  server: StateResponse | null
  answers: Answers
  /** 서버가 이미 가지고 있는 비밀 */
  secretsOnServer: Record<string, boolean>
  fieldErrors: FieldError[]
  catalog: ZonesResponse | null
  preflight: PreflightResponse | null
  preflightBusy: boolean
  preflightFailed: boolean

  adminPassword: string
  mailPassword: string
  aiKey: string

  dns: Probe<DnsProbe>
  records: Probe<MailRecordsProbe>
  smtp: Probe<SmtpProbe>
  ai: Probe<AiProbe>
  nfs: Probe<NfsProbe>
  localPath: Probe<LocalPathProbe>
  cert: Probe<CertProbe>
  certFiles: { cert: string | null; key: string | null }

  apply: ApplyState | null
  /** 적용을 시작하거나 다시 시킨 횟수 — 바뀌면 상태 흐름을 새로 듣는다 */
  applyEpoch: number
  /** 시작을 눌렀지만 서버가 아직 새 상태를 쓰기 전 — 이때 오는 옛 상태(이 시각의 것 · idle)는 버린다 */
  applyStale: string | null
  saving: boolean
  saveFailed: boolean
  /** 이 창에서 설치를 끝냈다 — 잠긴 뒤에도 완료 화면을 보여 준다 */
  finishedHere: boolean

  init(token?: string | null, tokenStatus?: { status: 'wrong' | 'expired' | 'locked'; retry_after?: number } | null): Promise<void>
  refreshState(): Promise<void>
  submitToken(token: string): Promise<StateResponse['session']>
  save(patch: AnswersPatch, step?: string): Promise<boolean>
  setSecret(name: 'adminPassword' | 'mailPassword' | 'aiKey', value: string): void
  runPreflight(): Promise<void>
  reloadZones(): Promise<void>
  checkDns(domain: string): Promise<void>
  checkRecords(mailDomain: string): Promise<void>
  checkSmtp(req: SmtpProbeRequest): Promise<void>
  checkAi(req: AiProbeRequest): Promise<void>
  checkNfs(server: string, exportPath: string): Promise<void>
  checkLocalPath(path: string): Promise<void>
  checkCert(cert: File, key: File): Promise<void>
  clearCert(): void
  setApply(state: ApplyState | null): void
  /** 적용을 시작했거나 다시 시켰다 — 서버가 새 상태를 쓸 때까지 "진행 중"으로 보인다 */
  kickApply(returned: ApplyState): void
  /** 상태 흐름에서 온 상태 */
  receiveApply(state: ApplyState): void
  markFinished(): void
}

export type WizardStore = StoreApi<WizardState>

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = v !== null && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object'
      ? deepMerge(out[k], v)
      : v
  }
  return out as T
}

/** 서버가 준 답변에 빠진 항목을 기본값으로 채운다 */
export function normalizeAnswers(a: Partial<Answers> | null | undefined): Answers {
  return deepMerge(emptyAnswers(), a ?? {})
}

/** 저장하기 전에 "이 조각을 얹으면 답변이 어떻게 되는지" 미리 본다(다음 단계를 정하는 데 쓴다) */
export function applyPatch(answers: Answers, patch: AnswersPatch): Answers {
  return deepMerge(answers, patch)
}

export function smtpKey(r: SmtpProbeRequest): string {
  return [r.host.trim(), r.port, r.security, r.username.trim(), r.password].join('\n')
}
export function aiKeyOf(r: AiProbeRequest): string {
  return [r.provider, (r.base_url ?? '').trim(), r.api_key].join('\n')
}
export function nfsKey(server: string, exportPath: string): string {
  return `${server.trim()}\n${exportPath.trim()}`
}

export function createWizardStore(api: InstallerApi): WizardStore {
  return createStore<WizardState>()((set, get) => {
    /** 확인 하나를 돌린다 — 도는 사이 입력이 바뀌어 다른 확인이 시작됐으면 늦게 온 결과는 버린다 */
    async function probe<K extends 'dns' | 'records' | 'smtp' | 'ai' | 'nfs' | 'localPath' | 'cert', T>(
      name: K, key: string, run: () => Promise<T>,
    ): Promise<void> {
      set({ [name]: { status: 'checking', key, result: null } } as unknown as Partial<WizardState>)
      try {
        const result = await run()
        if ((get()[name] as Probe<T>).key !== key) return
        set({ [name]: { status: 'done', key, result } } as unknown as Partial<WizardState>)
      } catch (e) {
        if ((get()[name] as Probe<T>).key !== key) return
        set({ [name]: { status: 'error', key, result: null } } as unknown as Partial<WizardState>)
        if (e instanceof ApiError && e.unauthorized) void get().refreshState()
      }
    }

    /** 공인 주소 — 처음에는 밖에 물어보느라 몇 초 걸릴 수 있어 화면을 막지 않고 뒤에서 읽는다 */
    async function loadPublicIp() {
      try {
        const got = await api.probePublicIp()
        const server = get().server
        if (!server || !got.ip) return
        // 서버의 네트워크 카드가 공인 주소를 직접 가지고 있으면 직접 연결이다. 그 밖의 형태는 구분하지 못한다
        const detected = got.source === 'interface' ? 'direct' as const : server.facts.detected_network
        set({ server: { ...server, facts: { ...server.facts, public_ip: server.facts.public_ip ?? got.ip, detected_network: detected ?? null } } })
      } catch { /* 모르면 화면이 직접 입력받는다 */ }
    }

    async function loadWizard(server: StateResponse) {
      if (server.session !== 'ok' || server.locked) return
      const [answers, catalog] = await Promise.all([api.getAnswers(), api.getZones()])
      set({
        answers: normalizeAnswers(answers.answers),
        secretsOnServer: answers.secrets ?? {},
        fieldErrors: answers.errors ?? [],
        catalog,
      })
      if (server.phase === 'applying') {
        const mode = normalizeAnswers(answers.answers).mode
        try { set({ apply: mode === 'restore' ? await api.restoreGetApply() : await api.getApply() }) } catch { /* 적용 화면이 다시 읽는다 */ }
      }
    }

    return {
      api,
      boot: 'loading',
      server: null,
      answers: emptyAnswers(),
      secretsOnServer: {},
      fieldErrors: [],
      catalog: null,
      preflight: null,
      preflightBusy: false,
      preflightFailed: false,
      adminPassword: '',
      mailPassword: '',
      aiKey: '',
      dns: idle(),
      records: idle(),
      smtp: idle(),
      ai: idle(),
      nfs: idle(),
      localPath: idle(),
      cert: idle(),
      certFiles: { cert: null, key: null },
      apply: null,
      applyEpoch: 0,
      applyStale: null,
      saving: false,
      saveFailed: false,
      finishedHere: false,

      async init(token, tokenStatus) {
        set({ boot: 'loading' })
        try {
          let server = await api.getState()
          // 주소에 토큰이 실려 왔는데 아직 세션이 없으면 그 토큰으로 세션을 만든다(토큰은 여기서 쓰고 버린다)
          if (token && server.session !== 'ok' && !server.locked) {
            const made = await api.createSession(token)
            server = await api.getState()
            if (server.session !== 'ok') server = { ...server, session: made.status, retry_after: made.retry_after }
          }
          // 서버가 주소의 토큰을 이미 확인했는데 맞지 않았다 — 그 사유를 토큰 화면에 알린다
          if (tokenStatus && server.session !== 'ok' && !server.locked) {
            server = { ...server, session: tokenStatus.status, retry_after: tokenStatus.retry_after }
          }
          await loadWizard(server)
          set({ server, boot: 'ready' })
          if (server.session === 'ok' && !server.locked) void loadPublicIp()
        } catch {
          set({ boot: 'error' })
        }
      },

      async refreshState() {
        try {
          const server = await api.getState()
          set({ server })
        } catch { /* 다음 요청에서 다시 드러난다 */ }
      },

      async submitToken(token) {
        const made = await api.createSession(token)
        if (made.status !== 'ok') {
          const server = get().server
          if (server) set({ server: { ...server, session: made.status, retry_after: made.retry_after } })
          return made.status
        }
        const server = await api.getState()
        await loadWizard(server)
        set({ server })
        if (server.session === 'ok' && !server.locked) void loadPublicIp()
        return server.session
      },

      async save(patch, step) {
        set({ saving: true, saveFailed: false })
        try {
          const res = await api.putAnswers(patch, step)
          const server = get().server
          set({
            answers: normalizeAnswers(res.answers),
            secretsOnServer: res.secrets ?? {},
            fieldErrors: res.errors ?? [],
            saving: false,
            server: server && step ? { ...server, step } : server,
          })
          return true
        } catch (e) {
          set({ saving: false, saveFailed: true })
          if (e instanceof ApiError && e.unauthorized) void get().refreshState()
          return false
        }
      },

      setSecret(name, value) { set({ [name]: value } as Partial<WizardState>) },

      async runPreflight() {
        if (get().preflightBusy) return
        set({ preflightBusy: true, preflightFailed: false })
        try {
          for (;;) {
            const res = await api.preflight()
            set({ preflight: res })
            if (!res.items.some(i => i.status === 'checking')) break
            await new Promise(r => setTimeout(r, PREFLIGHT_POLL_MS))
          }
          set({ preflightBusy: false })
          // 점검이 서버 메모리를 알아냈으면 구역 목록의 판정도 달라진다
          void get().reloadZones()
        } catch (e) {
          set({ preflightBusy: false, preflightFailed: true })
          if (e instanceof ApiError && e.unauthorized) void get().refreshState()
        }
      },

      async reloadZones() {
        try { set({ catalog: await api.getZones() }) } catch { /* 전에 읽은 목록을 그대로 쓴다 */ }
      },

      checkDns: domain => probe('dns', domain.trim(), () => api.probeDns(domain.trim())),
      checkRecords: mailDomain => probe('records', mailDomain.trim(), () => api.probeMailRecords(mailDomain.trim())),
      checkSmtp: req => probe('smtp', smtpKey(req), () => api.probeSmtp(req)),
      checkAi: req => probe('ai', aiKeyOf(req), () => api.probeAi(req)),
      checkNfs: (server, exportPath) => probe('nfs', nfsKey(server, exportPath), () => api.probeNfs(server.trim(), exportPath.trim())),
      checkLocalPath: path => probe('localPath', path.trim(), () => api.probeLocalPath(path.trim())),
      checkCert: (cert, key) => {
        set({ certFiles: { cert: cert.name, key: key.name } })
        return probe('cert', `${cert.name}\n${cert.size}\n${key.name}\n${key.size}`, () => api.probeCert(cert, key, get().answers.access.domain || undefined))
      },
      clearCert() { set({ cert: idle(), certFiles: { cert: null, key: null } }) },

      setApply(state) { set({ apply: state }) },
      kickApply(returned) {
        const before = get().apply
        // 서버는 답변 검증과 사전 점검을 다시 한 뒤에야 새 상태를 쓴다 — 그때까지 읽히는 것은 옛 상태다:
        // 처음 시작이면 idle, 다시 시킨 것이면 방금 그 실패 상태(쓴 시각이 같다)
        const sameAsBefore = !!before && before.status === 'failed' && returned.status === 'failed'
          && (returned.updated_at ?? '') === (before.updated_at ?? '')
        const fresh = returned.status !== 'idle' && !sameAsBefore
        set(s => ({
          applyEpoch: s.applyEpoch + 1,
          applyStale: fresh ? null : (returned.updated_at ?? ''),
          apply: fresh ? returned : {
            ...returned,
            status: 'running',
            error: null,
            alternatives: [],
            finished_at: null,
            started_at: returned.status === 'idle' ? new Date().toISOString() : returned.started_at,
            steps: returned.steps.map(st => (st.status === 'failed' ? { ...st, status: 'running' as const, error: null } : st)),
          },
        }))
      },
      receiveApply(state) {
        const stale = get().applyStale
        if (stale != null && (state.status === 'idle' || (state.updated_at ?? '') === stale)) return
        set({ apply: state, applyStale: null })
      },
      markFinished() { set({ finishedHere: true }) },
    }
  })
}

// ─── 답변에서 끌어내는 값 ───

/** 켤 구역(애드온 제외). 빠른 설치는 서버 메모리에 맞는 묶음 */
export function effectiveZones(answers: Answers, catalog: ZonesResponse | null): string[] {
  if (!catalog) return answers.zones ?? []
  const fits = (name: string) => catalog.preset_fits?.[name] !== false
  const fallback = fits(QUICK_PRESET) ? QUICK_PRESET : FALLBACK_PRESET
  if (answers.mode === 'quick') return catalog.presets[fallback] ?? []
  if (answers.zones != null) return answers.zones
  return catalog.presets[answers.preset ?? fallback] ?? []
}

/** 빠른 설치에서 메모리가 모자라 최소 묶음으로 내려갔는가 */
export function quickLowered(catalog: ZonesResponse | null): boolean {
  return catalog?.preset_fits?.[QUICK_PRESET] === false
}

export function flowOf(answers: Answers, catalog: ZonesResponse | null): FlowStep[] {
  return flow({
    mode: answers.mode,
    network: answers.access.network,
    cert: answers.access.cert,
    zones: effectiveZones(answers, catalog),
  })
}

/** 구역이 켜져 있는가 */
export function zoneOn(answers: Answers, catalog: ZonesResponse | null, id: string): boolean {
  return effectiveZones(answers, catalog).includes(id)
}

/** 이 서버의 내부 주소(공유기·프록시가 넘겨줄 곳). 모르면 null */
export function lanIp(s: Pick<WizardState, 'server' | 'preflight'>): string | null {
  return s.server?.facts.lan_ip ?? s.preflight?.facts?.outbound_address ?? null
}

/**
 * 이어서 할 단계 — 서버가 기억해 준 것이 있으면 그것, 없으면 답변에서 짐작한다:
 * 값이 채워진 마지막 단계의 바로 다음(값이 없는 안내 단계는 건너뛴 것으로 본다). 채워진 것이 없으면 null.
 */
export function resumeStep(answers: Answers, catalog: ZonesResponse | null, serverStep?: string | null): StepId | null {
  const live = liveSteps(flowOf(answers, catalog))
  if (serverStep && (ROUTES as string[]).includes(serverStep) && live.includes(serverStep as StepId) && serverStep !== 'check') return serverStep as StepId
  if (answers.mode === 'restore') return 'file'
  const a = answers
  const filled: Partial<Record<StepId, boolean>> = {
    domain: !!a.access.domain,
    proxy: a.access.proxy_addresses.length > 0,
    storage: a.storage.kind === 'nfs' || !!a.storage.path,
    zones: a.zones != null,
    mail: a.mail.kind === 'builtin' ? !!a.mail.mail_domain : !!a.mail.host,
    meet: !!a.meetings.public_ip || !a.meetings.turn || a.meetings.lossless_audio,
    ai: a.ai.mode === 'provider',
    git: a.git.version !== 'verified',
    admin: !!a.admin.username,
  }
  let last = -1
  live.forEach((id, i) => { if (filled[id]) last = i })
  if (last < 0) return null
  return live[Math.min(last + 1, live.length - 1)] === 'apply' ? 'summary' : live[last + 1]
}

/** 서버의 명목 메모리(MiB). 모르면 null */
export function serverMemoryMb(s: Pick<WizardState, 'catalog' | 'server' | 'preflight'>): number | null {
  return s.catalog?.memory?.nominal_mb ?? s.preflight?.facts?.memory_mb ?? s.server?.facts.memory_mb ?? null
}

// ─── React 연결 ───

export const WizardContext = createContext<WizardStore | null>(null)

export function useWizardStore(): WizardStore {
  const store = useContext(WizardContext)
  if (!store) throw new Error('WizardContext 밖에서 썼습니다')
  return store
}

export function useWizard<T>(selector: (s: WizardState) => T): T {
  return useStore(useWizardStore(), selector)
}
