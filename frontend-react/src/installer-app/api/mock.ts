/**
 * 가짜 설치 관리자 — 서버 없이 화면의 모든 상태를 띄워 보기 위한 것(개발 서버와 테스트에서만 쓴다).
 * 실제 클라이언트와 같은 `InstallerApi` 를 구현하고, 답변·적용 상태를 메모리에 들고 있다.
 *
 * 시나리오는 이름을 쉼표로 이어 여러 개를 같이 켠다. 예: `?mock=router,nfs-permission`
 *
 * | 묶음 | 이름 |
 * |---|---|
 * | 들어오기 | token-none · token-wrong · token-expired · locked · resume · resume-applying · resume-failed |
 * | 사전 점검 | preflight-ok · preflight-fail · preflight-memory · preflight-checking (기본: 주의 하나) |
 * | 서버 | mem-6(6 GB) · mem-8 · mem-unknown · detect-router · detect-proxy · no-public-ip |
 * | 접속 주소 | dns-mismatch · dns-unknown · dns-checking |
 * | 인증서 올리기 | cert-domain · cert-key · cert-expired · cert-mail |
 * | 파일 저장 위치 | nfs-unreachable · nfs-permission · nfs-readonly · nfs-nolock · nfs-lowspace · nfs-checking · path-missing |
 * | 메일 · AI | records-ok · records-unknown · smtp-fail · ai-fail |
 * | 미리 채운 답변 | router · proxy · upload · full(전체 묶음과 애드온) · quick · quick-ready(빠른 설치 요약 직전) · ready(요약 직전까지 채움) |
 * | 요약 | summary-error |
 * | 적용 | apply-cert-fail · apply-storage-fail · apply-zone-fail · apply-running · apply-done |
 * | 복원 | restore(지원함) · restore-badfile · restore-uploading · restore-version · restore-local · restore-nofiles · restore-fail · restore-done |
 */
import {
  ApiError, emptyAnswers,
  type Answers, type AnswersPatch, type AnswersResponse, type ApplyState, type ApplyStep, type CertProbe, type FieldError,
  type InstallerApi, type MailRecord, type NfsProbe, type NfsStep, type PreflightItem, type PreflightResponse, type RestoreFileInfo,
  type RestoreReview, type StateResponse, type SummaryResponse, type ZoneRow, type ZonesResponse,
} from './types'

export interface MockOptions {
  /** 응답을 늦추는 시간(ms). 테스트는 0 */
  delay?: number
  /** 적용 한 단계에 걸리는 시간(ms). 0 이면 시작하자마자 끝 상태가 된다 */
  stepMs?: number
}

const name = (ko: string, en: string) => ({ ko, en })
const zone = (id: string, n: [string, string], s: [string, string], recommend: number, ports: string[] = [], wizard_step?: string): ZoneRow =>
  ({ id, kind: 'zone', name: name(...n), summary: name(...s), memory_mb: { recommend }, ports, requires: [], wizard_step })

export const MOCK_ZONES: ZoneRow[] = [
  zone('mail', ['메일', 'Mail'], ['내장 메일 서버 또는 외부 발신 서버', 'Built-in mail server or external relay'], 1000, ['25/tcp', '465/tcp', '587/tcp', '993/tcp'], 'mail'),
  zone('chat', ['채팅', 'Chat'], ['채널, 대화, 음성 채널(회의 구역 필요)', 'Channels, DMs, voice channels (needs Meetings)'], 0),
  zone('calendar', ['일정·연락처·할 일', 'Calendar, contacts, tasks'], ['달력 동기화 포함', 'Includes calendar sync'], 0),
  zone('docs', ['문서 편집·위키·게시판', 'Documents, wiki, boards'], ['문서·시트·발표 자료 함께 편집', 'Co-edit documents, sheets and slides'], 2000),
  zone('meetings', ['회의', 'Meetings'], ['화상 회의, 화면 공유, 녹화 · 녹화 중에는 메모리를 더 씁니다', 'Video calls, screen share, recording · uses more memory while recording'], 1000, ['7881/tcp', '7882-7892/udp', '3478/udp', '4433/udp'], 'meetings'),
  zone('git', ['코드 저장소', 'Code hosting'], ['Git 호스팅', 'Git hosting'], 500, ['2222/tcp']),
  zone('ai', ['AI 도우미', 'AI assistant'], ['외부 AI 서비스 연결, 웹 검색, 코드 실행', 'External AI provider, web search, code sandbox'], 1000, [], 'ai'),
]
export const MOCK_ADDONS: ZoneRow[] = [
  { ...zone('sso', ['SSO·LDAP 제공', 'SSO and LDAP provider'], ['다른 프로그램이 이 워크스페이스 계정으로 로그인합니다', 'Let other services sign in with workspace accounts'], 500, ['389/tcp', '636/tcp']), kind: 'addon' },
  { ...zone('rbi', ['격리 브라우저', 'Isolated browser'], ['서버에서 띄운 브라우저를 화면으로만 봅니다 · 세션마다 2 GB 별도', 'A browser that runs on the server and is viewed remotely · 2 GB extra per session'], 100), kind: 'addon' },
]
const PRESETS: Record<string, string[]> = {
  minimal: [],
  collab: ['mail', 'chat', 'calendar', 'docs'],
  full: ['mail', 'chat', 'calendar', 'docs', 'meetings', 'git', 'ai'],
}
const CORE = { id: 'core', name: name('기본', 'Core'), summary: name('로그인, 관리, 대시보드, 파일', 'Sign-in, admin, dashboard, files'), memory_mb: { recommend: 4000 }, ports: ['80/tcp', '443/tcp'] }
const PUBLIC_IP = '203.0.113.24'

function merge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) delete out[k]
    else if (typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') out[k] = merge(out[k], v)
    else out[k] = v
  }
  return out as T
}

export function parseScenario(raw: string | null | undefined): Set<string> {
  return new Set((raw ?? '').split(',').map(s => s.trim()).filter(Boolean))
}

export function createMockApi(scenario: string | Set<string> = '', options: MockOptions = {}): InstallerApi {
  const on = typeof scenario === 'string' ? parseScenario(scenario) : scenario
  const has = (n: string) => on.has(n)
  const delay = options.delay ?? 0
  const stepMs = options.stepMs ?? 0
  const wait = <T,>(value: T, ms = delay): Promise<T> => (ms > 0 ? new Promise(r => setTimeout(() => r(value), ms)) : Promise.resolve(value))
  const never = <T,>(): Promise<T> => new Promise<T>(() => {})

  const memoryMb = has('mem-6') ? 6144 : (has('mem-8') ? 8192 : (has('preflight-memory') ? 2048 : 16384))
  const memoryKnown = !has('mem-unknown')

  // ─── 답변 ───
  let answers: Answers = emptyAnswers()
  const secrets: Record<string, string> = {}

  const filled = has('ready') || has('quick-ready') || has('resume-applying') || has('resume-failed') || [...on].some(s => s.startsWith('apply-'))
  if (has('router')) answers.access.network = 'router'
  if (has('proxy')) { answers.access.network = 'proxy'; answers.access.cert = 'proxy' }
  if (has('upload')) answers.access.cert = 'upload'
  if (has('quick') || has('quick-ready')) answers.mode = 'quick'
  if (has('full')) { answers.zones = [...PRESETS.full]; answers.addons = ['sso']; answers.meetings.lossless_audio = true }
  if ([...on].some(s => s.startsWith('restore'))) answers.mode = 'restore'
  if (has('resume')) answers.access.domain = 'workspace.example.com'
  if (filled) {
    answers.access.domain = 'workspace.example.com'
    if (answers.access.network === 'proxy') answers.access.proxy_addresses = ['192.168.10.5']
    if (answers.mode !== 'quick' && !answers.zones) answers.zones = [...PRESETS.collab]
    answers.mail.mail_domain = 'example.com'
    answers.admin = { name: '관리자', username: 'admin' }
    secrets['admin.password'] = 'correct horse battery'
    if (has('apply-storage-fail')) answers.storage = { kind: 'nfs', server: 'nas.example.com', export: '/volume1/workspace' }
    if (has('apply-zone-fail') && answers.zones && !answers.zones.includes('git')) answers.zones.push('git')
  }

  function selected(): string[] {
    const zones = answers.mode === 'quick'
      ? PRESETS[fits('collab') ? 'collab' : 'minimal']
      : (answers.zones ?? PRESETS[answers.preset ?? 'minimal'] ?? [])
    return [...zones, ...answers.addons]
  }
  function needMb(ids: string[]): number {
    return CORE.memory_mb.recommend + [...MOCK_ZONES, ...MOCK_ADDONS].filter(z => ids.includes(z.id)).reduce((a, z) => a + z.memory_mb.recommend, 0)
  }
  function fits(preset: string): boolean {
    return !memoryKnown || memoryMb >= needMb(PRESETS[preset] ?? [])
  }
  function answersResponse(): AnswersResponse {
    const pub: Answers = JSON.parse(JSON.stringify(answers))
    delete pub.admin.password
    delete pub.mail.password
    delete pub.ai.api_key
    const errors: FieldError[] = []
    if (answers.admin.username && !/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(answers.admin.username)) errors.push({ field: 'admin.username', code: 'username_invalid' })
    return {
      answers: pub,
      secrets: { 'admin.password': !!secrets['admin.password'], 'mail.password': !!secrets['mail.password'], 'ai.api_key': !!secrets['ai.api_key'] },
      errors,
    }
  }

  // ─── 적용 ───
  let phase: StateResponse['phase'] = has('locked') ? 'installed' : 'wizard'
  let apply: ApplyState = { status: 'idle', steps: [], current: null, error: null, notes: [], warnings: [], alternatives: [] }
  let timer: ReturnType<typeof setInterval> | null = null
  let writes = 0
  let startedAt = new Date().toISOString()
  const listeners = new Set<(s: ApplyState) => void>()
  const emit = () => { const snap = JSON.parse(JSON.stringify(apply)) as ApplyState; listeners.forEach(fn => fn(snap)) }
  const restoreMode = () => answers.mode === 'restore'
  let restoreFiles = !has('restore-nofiles') && has('restore-local')

  function stepIds(): string[] {
    if (restoreMode()) return ['unpack', 'storage', 'pull', 'database', ...(restoreFiles ? ['files'] : []), 'cert', 'zones']
    const ids = ['config']
    if (answers.storage.kind === 'nfs' || answers.storage.path) ids.push('storage')
    ids.push('pull', 'database')
    if (answers.access.network !== 'proxy') ids.push('cert')
    ids.push('zones', 'admin', 'lock')
    return ids
  }
  function failAt(): { step: string; cause: string; fix: string; vars: Record<string, unknown>; alt?: string } | null {
    if (restoreMode()) return has('restore-fail') ? { step: 'database', cause: 'restore_database_failed', fix: 'see_log', vars: {} } : null
    if (has('apply-cert-fail') && answers.access.cert !== 'temporary') {
      return { step: 'cert', cause: 'cert_issue_failed', fix: 'cert_retry_or_temporary', vars: { names: [answers.access.domain], alternative: 'use_temporary_cert' }, alt: 'use_temporary_cert' }
    }
    if (has('apply-storage-fail') && answers.storage.kind === 'nfs') return { step: 'storage', cause: 'unreachable', fix: 'storage_check_connection', vars: { detail: 'mount.nfs: Connection timed out' } }
    if (has('apply-zone-fail')) return { step: 'zones', cause: 'git_not_responding', fix: 'see_container_log', vars: { zone: 'git', container: 'ws-git' } }
    return null
  }
  const stuckAt = () => (has('apply-running') ? 'pull' : (has('resume-applying') ? 'zones' : null))

  function detail(id: string, running: boolean): ApplyStep['detail'] {
    if (id === 'pull') {
      const images = ['frontend', 'backend', 'postgres', 'redis', 'nginx', ...(selected().includes('mail') ? ['mailserver'] : []), ...(selected().includes('docs') ? ['docconv'] : [])]
      return { images: images.map((image, i) => ({ image, status: !running ? 'done' : (i < 2 ? 'done' : (i === 2 ? 'pulling' : 'pending')), progress: running && i === 2 ? 'Downloading 62%' : '', percent: !running ? 100 : (i < 2 ? 100 : (i === 2 ? 62 : 0)) })) }
    }
    if (id === 'zones') {
      const zs = selected()
      return { zones: zs.map((z, i) => ({ id: z, status: !running ? 'done' : (i === 0 ? 'done' : (i === 1 ? 'installing' : 'pending')) })) }
    }
    return {}
  }
  function buildApply(doneCount: number): void {
    const ids = stepIds()
    const fail = failAt()
    const steps: ApplyStep[] = ids.map((id, i) => {
      if (i < doneCount) return { id, status: 'done', detail: detail(id, false), error: null }
      if (i === doneCount) {
        if (fail && fail.step === id) return { id, status: 'failed', detail: detail(id, true), error: { cause: fail.cause, fix: fail.fix, vars: fail.vars } }
        return { id, status: 'running', detail: detail(id, true), error: null }
      }
      return { id, status: 'pending', detail: {}, error: null }
    })
    const cur = steps[doneCount]
    const failed = cur?.status === 'failed'
    const done = doneCount >= ids.length
    apply = {
      status: done ? 'done' : (failed ? 'failed' : 'running'),
      steps,
      current: done ? null : cur.id,
      error: failed && fail ? { step: fail.step, cause: fail.cause, fix: fail.fix, vars: fail.vars } : null,
      notes: [], warnings: [],
      alternatives: failed && fail?.alt ? [{ key: fail.alt }] : [],
      started_at: startedAt,
      finished_at: done || failed ? new Date().toISOString() : null,
      // 쓸 때마다 달라지는 표식(실제 서버는 쓴 시각)
      updated_at: `write-${++writes}`,
    }
    if (done) phase = 'installed'
    else phase = 'applying'
  }
  /** 멈출 자리(실패·붙잡아 둔 단계) 또는 끝까지의 단계 수 */
  function terminalIndex(): number {
    const ids = stepIds()
    const fail = failAt()
    const stuck = stuckAt()
    if (fail && ids.includes(fail.step)) return ids.indexOf(fail.step)
    if (stuck && ids.includes(stuck)) return ids.indexOf(stuck)
    return ids.length
  }
  function run(from = 0): ApplyState {
    if (timer) clearInterval(timer)
    if (from === 0) startedAt = new Date().toISOString()
    const end = terminalIndex()
    if (stepMs <= 0) { buildApply(Math.max(from, end)); emit(); return apply }
    let at = Math.min(from, end)
    buildApply(at)
    emit()
    timer = setInterval(() => {
      if (at >= end) { if (timer) clearInterval(timer); timer = null; return }
      at += 1
      buildApply(at)
      emit()
    }, stepMs)
    return apply
  }
  if (has('resume-applying') || has('resume-failed') || has('apply-running')) {
    if (has('resume-failed')) on.add('apply-cert-fail')
    buildApply(terminalIndex())
  }
  if (has('restore-done')) { buildApply(stepIds().length) }

  function stream(onState: (s: ApplyState) => void): () => void {
    listeners.add(onState)
    onState(JSON.parse(JSON.stringify(apply)))
    return () => { listeners.delete(onState) }
  }

  // ─── 점검 · 확인 ───
  let preflightRan = false
  function preflight(): PreflightResponse {
    preflightRan = true
    const it = (id: string, status: PreflightItem['status'], value: unknown, key?: string, vars: Record<string, unknown> = {}): PreflightItem =>
      ({ id, status, value, fix: key ? { key, vars } : null })
    const items: PreflightItem[] = [
      it('docker_engine', 'pass', '29.9.3'),
      it('docker_compose', 'pass', '2.40.0'),
      it('cpu', 'pass', 8),
      has('preflight-memory') ? it('memory', 'fail', 2048, 'memory_below_minimum', { min_mb: 4096 }) : it('memory', 'pass', memoryMb),
      it('arch', 'pass', 'x86_64'),
      has('preflight-fail') ? it('disk', 'fail', { free_gb: 6.2 }, 'disk_too_small', { min_gb: 10 }) : it('disk', 'pass', { free_gb: 212 }),
      it('time_sync', 'pass', 'synchronized'),
      it('port_80', 'pass', 'free'),
      it('port_443', 'pass', 'free'),
      has('preflight-ok') ? it('port_25', 'pass', 'free') : it('port_25', 'warn', 'used', 'port_25_in_use', { port: 25, needed: true }),
      has('subnet-conflict') || answers.advanced.subnet === '192.168.0.0/24' ? it('subnet', 'fail', answers.advanced.subnet, 'subnet_conflict', { conflicts: [{ subnet: '192.168.0.0/24' }] }) : it('subnet', 'pass', answers.advanced.subnet),
      it('internet', 'pass', 'reachable'),
      it('registry', 'pass', 'registry.example.com'),
      it('selinux', 'pass', 'disabled'),
    ]
    if (has('preflight-checking')) for (const item of items.slice(5)) { item.status = 'checking'; item.value = null; item.fix = null }
    return { ok: !items.some(i => i.status === 'fail'), items, facts: { memory_mb: memoryKnown ? memoryMb : null, cpus: 8, outbound_address: '192.168.10.10' } }
  }

  function zones(): ZonesResponse {
    const chosen = selected()
    const verdict = (ids: string[]) => {
      const need = needMb(ids)
      return { need_mb: need, have_mb: memoryMb - 300, nominal_mb: memoryMb, ok: memoryMb >= need, below_minimum: memoryMb < 4096 }
    }
    const row = (z: ZoneRow): ZoneRow => ({ ...z, selected: chosen.includes(z.id), fits: memoryKnown ? verdict([...chosen, z.id]).ok : undefined })
    return {
      version: 1,
      core: CORE,
      presets: PRESETS,
      zones: MOCK_ZONES.map(row),
      addons: MOCK_ADDONS.map(row),
      ...(memoryKnown ? { memory: verdict(chosen), preset_fits: Object.fromEntries(Object.keys(PRESETS).map(p => [p, fits(p)])) } : {}),
    }
  }

  function nfs(server: string, exportPath: string): NfsProbe {
    const order = ['reach', 'mount', 'write', 'lock', 'space']
    const failIndex = has('nfs-unreachable') ? 0 : (has('nfs-permission') ? 1 : (has('nfs-readonly') ? 2 : (has('nfs-nolock') ? 3 : -1)))
    const cause = [null, 'unreachable', 'permission_denied', 'read_only', 'no_locking'][failIndex + 1]
    const values: unknown[] = [server, exportPath, null, null, has('nfs-lowspace') ? 6 : 1840]
    const steps: NfsStep[] = order.map((id, i) => {
      if (failIndex >= 0) return { id, status: i < failIndex ? 'pass' : (i === failIndex ? 'fail' : 'skipped'), value: i <= failIndex ? values[i] : null }
      return { id, status: id === 'space' && has('nfs-lowspace') ? 'warn' : 'pass', value: values[i] }
    })
    return { ok: failIndex < 0, cause, steps }
  }

  function cert(): CertProbe {
    const c = (id: string, status: 'pass' | 'warn' | 'fail', value: unknown, key?: string) => ({ id, status, value, fix: key ? { key } : null })
    const domain = answers.access.domain || 'workspace.example.com'
    const checks = [
      c('cert_readable', 'pass', 2),
      c('key_readable', 'pass', null),
      has('cert-key') ? c('key_matches', 'fail', null, 'key_mismatch') : c('key_matches', 'pass', null),
      has('cert-domain') ? c('domain_covered', 'fail', ['other.example.com'], 'cert_domain_missing') : c('domain_covered', 'pass', domain),
      has('cert-expired') ? c('validity', 'fail', '2025-01-31T00:00:00Z', 'cert_expired') : c('validity', 'pass', '2027-06-30T00:00:00Z'),
      c('issuer', 'pass', 'CN=Example CA'),
      has('cert-mail') || has('cert-domain') ? c('mail_host_covered', 'warn', 'mail.example.com', 'cert_mail_host_missing') : c('mail_host_covered', 'pass', 'mail.example.com'),
    ]
    return { ok: !checks.some(x => x.status === 'fail'), checks, names: [domain], not_after: has('cert-expired') ? '2025-01-31T00:00:00Z' : '2027-06-30T00:00:00Z', issuer: 'CN=Example CA' }
  }

  function records(mailDomain: string): MailRecord[] {
    const d = mailDomain || 'example.com'
    const dkim = 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzExampleKeyOnlyForTheMockServer0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const ok = has('records-ok')
    const unknown = has('records-unknown')
    const st = (s: MailRecord['status']): MailRecord['status'] => (unknown ? 'unknown' : (ok ? 'ok' : s))
    return [
      { id: 'a', type: 'A', name: `mail.${d}`, expected: PUBLIC_IP, current: unknown ? [] : [PUBLIC_IP], status: st('ok') },
      { id: 'mx', type: 'MX', name: d, expected: `10 mail.${d}`, current: unknown ? [] : [`10 mail.${d}`], status: st('ok') },
      { id: 'spf', type: 'TXT', name: d, expected: 'v=spf1 mx ~all', current: unknown ? [] : ['v=spf1 mx ~all'], status: st('ok') },
      { id: 'dkim', type: 'TXT', name: `default._domainkey.${d}`, expected: dkim, current: ok ? [dkim] : [], status: st('missing') },
      { id: 'dmarc', type: 'TXT', name: `_dmarc.${d}`, expected: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${d}`, current: ok ? [`v=DMARC1; p=quarantine; rua=mailto:postmaster@${d}`] : (unknown ? [] : ['v=DMARC1 p=none']), status: st('different') },
    ]
  }

  function summary(): SummaryResponse {
    const chosen = selected()
    const ports = [...CORE.ports]
    for (const z of [...MOCK_ZONES, ...MOCK_ADDONS]) {
      if (!chosen.includes(z.id)) continue
      for (const p of z.ports) {
        if (z.id === 'meetings' && p === '3478/udp' && !answers.meetings.turn) continue
        if (z.id === 'meetings' && p === '4433/udp' && !answers.meetings.lossless_audio) continue
        ports.push(p)
      }
    }
    const mailBuiltin = chosen.includes('mail') && answers.mail.kind === 'builtin'
    const cautions = []
    if (answers.access.cert === 'temporary') cautions.push({ key: 'cert_temporary', vars: { domain: answers.access.domain } })
    if (answers.access.network === 'router') cautions.push({ key: 'router_port_forward', vars: { ports } })
    if (mailBuiltin) cautions.push({ key: 'mail_needs_dns_and_port25', vars: { mail_domain: answers.mail.mail_domain } })
    if (!chosen.includes('mail')) cautions.push({ key: 'no_system_mail', vars: {} })
    if (chosen.includes('meetings') && answers.meetings.lossless_audio) cautions.push({ key: 'lossless_needs_udp_4433', vars: {} })
    if (has('dns-mismatch') && answers.access.cert === 'auto') cautions.push({ key: 'dns_mismatch_cert_will_fail', vars: { domain: answers.access.domain } })
    const errors: FieldError[] = has('summary-error') ? [{ field: 'admin.password', code: 'required' }] : []
    return {
      ready: errors.length === 0 && preflightRan && !has('preflight-fail') && !has('preflight-memory'),
      preflight: { checked: preflightRan, ok: preflightRan && !has('preflight-fail') && !has('preflight-memory') },
      zones: chosen, ports,
      memory: memoryKnown ? { need_mb: needMb(chosen), have_mb: memoryMb - 300, nominal_mb: memoryMb, ok: memoryMb >= needMb(chosen), below_minimum: false } : null,
      cautions, errors,
      notes: answers.mode === 'quick' && !fits('collab') ? [{ key: 'quick_downgraded', vars: { from: 'collab', to: 'minimal', need_mb: needMb(PRESETS.collab), have_mb: memoryMb } }] : [],
    }
  }

  // ─── 복원 ───
  const restoreSupported = [...on].some(s => s.startsWith('restore'))
  const unsupported = <T,>(): Promise<T> => Promise.reject(new ApiError(501, 'restore_not_supported', { detail: 'restore_not_supported' }))
  const fileInfo = (): RestoreFileInfo => (has('restore-badfile')
    ? { status: 'invalid', name: 'notes.zip', size_bytes: 18_400 }
    : { status: 'ok', name: 'workspace-backup-20260101.jwbak', size_bytes: 4_812_000_000 })
  function review(): RestoreReview {
    const local = has('restore-local') || has('restore-nofiles')
    return {
      source_url: 'https://workspace.example.com', created_at: '2026-01-01T03:00:00Z',
      backup_version: has('restore-version') ? '9.9.0' : '1.4.0', installer_version: '1.4.0',
      version_status: has('restore-version') ? 'newer' : 'ok',
      zones: [...PRESETS.collab], users: 42, data_bytes: 9_300_000_000,
      storage: local ? { kind: 'local' } : { kind: 'nfs', server: 'nas.example.com', export: '/volume1/workspace' },
      files_included: restoreFiles, files_bytes: restoreFiles ? 61_000_000_000 : null,
      domain: 'workspace.example.com',
    }
  }

  const session: StateResponse['session'] = has('token-none') ? 'none' : (has('token-wrong') ? 'wrong' : (has('token-expired') ? 'expired' : 'ok'))
  let sessionNow = session

  function state(): StateResponse {
    return {
      session: sessionNow,
      phase,
      locked: phase === 'installed',
      // 실제 서버처럼 이어 할 단계는 기억해 주지 않는다 — 화면이 답변에서 짐작한다
      step: null,
      facts: {
        memory_mb: memoryKnown ? memoryMb : null,
        lan_ip: '192.168.10.10',
        detected_network: has('detect-router') ? 'router' : (has('detect-proxy') ? 'proxy' : null),
        disk_free_gb: 212,
      },
      info: {
        version: '1.4.0',
        app_url: answers.access.domain ? `https://${answers.access.domain}` : (has('locked') ? 'https://workspace.example.com' : null),
        default_storage_path: '/var/lib/just-workspace/files',
        git_verified_version: '1.24.6',
        username_rule: null,
        commands: { reissue_token: 'docker exec jw-installer jw token', reinstall: null, reset_admin: 'docker exec jw-installer jw reset-admin', install_from_answers: 'docker exec jw-installer jw apply --answers /data/answers.json' },
        answers_example: JSON.stringify({ version: 1, mode: 'new', access: { domain: 'workspace.example.com', network: 'direct', cert: 'auto' }, preset: 'collab', mail: { kind: 'builtin', mail_domain: 'example.com' }, admin: { name: 'Admin', username: 'admin' } }, null, 2),
        backup_file_format: '.jwbak',
      },
    }
  }

  return {
    getState: () => wait(state()),
    createSession: token => {
      const clean = token.replace(/[\s-]/g, '').toUpperCase()
      if (clean === 'EXPIRED00000') { sessionNow = 'expired'; return wait({ status: 'expired' as const }) }
      if (clean.length !== 12 || has('token-always-wrong')) { sessionNow = 'wrong'; return wait({ status: 'wrong' as const }) }
      sessionNow = 'ok'
      return wait({ status: 'ok' as const })
    },
    getAnswers: () => wait(answersResponse()),
    putAnswers: (patch: AnswersPatch, next?: string) => {
      const p = JSON.parse(JSON.stringify(patch)) as Record<string, Record<string, unknown>>
      for (const [section, key] of [['admin', 'password'], ['mail', 'password'], ['ai', 'api_key']] as const) {
        const v = p[section]?.[key]
        if (typeof v === 'string' && v) secrets[`${section}.${key}`] = v
        if (p[section]) delete p[section][key]
      }
      answers = merge(answers, p)
      answers = { ...emptyAnswers(), ...answers }
      void next
      return wait(answersResponse())
    },
    preflight: () => wait(preflight(), delay * 2),
    getZones: () => wait(zones()),
    probePublicIp: () => wait(has('no-public-ip') ? { status: 'unknown' as const, ip: null, source: null } : { status: 'detected' as const, ip: PUBLIC_IP, source: has('detect-router') || has('detect-proxy') ? 'services' : 'interface' }),
    probeDns: domain => {
      if (has('dns-checking')) return never()
      if (has('dns-mismatch')) return wait({ status: 'mismatch' as const, addresses: ['198.51.100.7'], public_ip: PUBLIC_IP, reason: 'points_elsewhere' }, delay * 2)
      if (has('dns-unknown')) return wait({ status: 'unknown' as const, addresses: [], public_ip: PUBLIC_IP, reason: 'lookup_failed' }, delay * 2)
      void domain
      return wait({ status: 'match' as const, addresses: [PUBLIC_IP], public_ip: PUBLIC_IP, reason: null }, delay * 2)
    },
    probeMailRecords: mailDomain => {
      const rs = records(mailDomain)
      return wait({ mail_domain: mailDomain, records: rs, ok: rs.every(r => r.status === 'ok') }, delay * 2)
    },
    probeCert: () => wait(cert(), delay * 2),
    probeSmtp: () => wait(has('smtp-fail') ? { status: 'auth_failed' as const } : { status: 'ok' as const }, delay * 2),
    probeAi: () => wait(has('ai-fail') ? { status: 'auth_failed' as const, http_status: 401, models: [] } : { status: 'ok' as const, http_status: 200, models: ['example-model'] }, delay * 2),
    probeNfs: (server, exportPath) => (has('nfs-checking') ? never() : wait(nfs(server, exportPath), delay * 4)),
    probeLocalPath: path => wait(has('path-missing') ? { status: 'not_found' as const, path } : { status: 'ok' as const, path, free_gb: 212 }, delay * 2),
    getSummary: () => wait(summary()),
    answersExportUrl: () => 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(answersResponse().answers, null, 2)),
    startApply: () => wait(run(0)),
    getApply: () => wait(JSON.parse(JSON.stringify(apply)) as ApplyState),
    streamApply: stream,
    retryApply: opts => {
      if (opts?.use_temporary_cert) answers.access.cert = 'temporary'
      else {
        on.delete('apply-storage-fail')
        on.delete('apply-zone-fail')
      }
      const from = Math.max(0, apply.steps.findIndex(s => s.status === 'failed'))
      return wait(run(from))
    },
    getApplyLog: stepId => wait({
      step: stepId,
      lines: stepId === 'cert'
        ? ['[cert] requesting certificate for workspace.example.com', '[cert] waiting for HTTP-01 validation on port 80', '[cert] failed: connection timed out']
        : [`[${stepId}] started`, `[${stepId}] failed`],
    }),

    restoreUpload: (file, onProgress, signal) => {
      if (!restoreSupported) return unsupported()
      if (has('restore-uploading')) { onProgress(62); return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new ApiError(0, 'aborted', null)))) }
      onProgress(100)
      return wait({ ...fileInfo(), name: file.name, size_bytes: file.size || fileInfo().size_bytes }, delay * 2)
    },
    restoreCheckPath: path => {
      if (!restoreSupported) return unsupported()
      return wait(path.includes('missing') ? { status: 'not_found' as const } : { ...fileInfo(), name: path.split('/').pop() }, delay * 2)
    },
    restoreReview: () => (restoreSupported ? wait(review()) : unsupported()),
    restoreApply: target => {
      if (!restoreSupported) return unsupported()
      answers.access.domain = target.domain
      answers.storage = { kind: target.storage.kind, server: target.storage.server ?? null, export: target.storage.export ?? null }
      restoreFiles = review().files_included
      return wait(run(0))
    },
    restoreGetApply: () => (restoreSupported ? wait(JSON.parse(JSON.stringify(apply)) as ApplyState) : unsupported()),
    restoreStream: stream,
    restoreRetry: () => {
      if (!restoreSupported) return unsupported()
      on.delete('restore-fail')
      return wait(run(Math.max(0, apply.steps.findIndex(s => s.status === 'failed'))))
    },
  }
}
