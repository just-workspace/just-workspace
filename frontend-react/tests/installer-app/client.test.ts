// 설치 관리자 API 클라이언트(src/installer-app/api/client.ts)가 서버 응답을 화면이 쓰는 꼴로 맞추는 부분,
// 그리고 저장소의 "이어 할 단계 짐작" · "적용을 시작한 직후의 옛 상태 버리기".
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHttpApi, normalizeState, normalizeSummary } from '~/installer-app/api/client'
import { createMockApi } from '~/installer-app/api/mock'
import { ApiError, emptyAnswers, type Answers, type ApplyState } from '~/installer-app/api/types'
import { createWizardStore, resumeStep } from '~/installer-app/store'

type Reply = { status?: number; body?: unknown }
const calls: Array<{ method: string; url: string; body: unknown }> = []
let replies: Record<string, Reply | Reply[]> = {}

function stubFetch() {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body })
    const key = `${method} ${url.split('?')[0]}`
    const entry = replies[key]
    const reply = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]) : entry
    if (!reply) return new Response(JSON.stringify({ code: 'not_found' }), { status: 404 })
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), { status: reply.status ?? 200 })
  })
}

beforeEach(() => {
  calls.length = 0
  replies = {}
  stubFetch()
  // 상태 흐름 대신 주기적 읽기를 쓰지 않도록 — 이 파일은 흐름을 열지 않는다
  vi.stubGlobal('EventSource', undefined)
})

describe('상태와 세션', () => {
  it('세션이 없으면(401) 토큰이 필요한 상태로 바꾼다', async () => {
    replies['GET /api/state'] = { status: 401, body: { code: 'auth_required', vars: {} } }
    const s = await createHttpApi().getState()
    expect(s).toMatchObject({ session: 'none', phase: 'wizard', locked: false, step: null })
  })

  it('세션이 있으면 단계와 버전을 읽고, 서버가 주지 않는 값은 비워 둔다', async () => {
    replies['GET /api/state'] = { body: { version: '1.4.0', phase: 'applying', locked: false, has_answers: true, mode: 'new', apply: { status: 'running' } } }
    const s = await createHttpApi().getState()
    expect(s).toMatchObject({ session: 'ok', phase: 'applying', locked: false })
    expect(s.info.version).toBe('1.4.0')
    expect(s.facts).toEqual({})
    expect(s.info.commands).toEqual({})          // 명령은 서버가 준 글자만 쓴다 — 화면에 박아 둔 값이 없다
    expect(s.info.default_storage_path).toBeUndefined()
  })

  it('서버가 준 이어 할 단계 · 감지값 · 명령을 그대로 넘긴다', async () => {
    replies['GET /api/state'] = { body: {
      version: '1.4.0', phase: 'wizard', locked: false, step: 'zones',
      facts: { memory_mb: 7900, public_ip: '203.0.113.10', lan_ip: '192.168.10.20', detected_network: 'router', disk_free_gb: 41.5 },
      info: { git_verified_version: '28.3.0', default_storage_path: '/var/lib/docker/volumes/ws-storage-data/_data',
              commands: { reissue_token: 'docker exec my-installer jw token', reinstall: 'docker exec my-installer jw reinstall --yes' } },
    } }
    const s = await createHttpApi().getState()
    expect(s.step).toBe('zones')
    expect(s.facts).toMatchObject({ lan_ip: '192.168.10.20', detected_network: 'router', disk_free_gb: 41.5 })
    expect(s.info).toMatchObject({ version: '1.4.0', git_verified_version: '28.3.0' })
    expect(s.info.commands?.reissue_token).toBe('docker exec my-installer jw token')
    expect(s.info.commands?.reinstall).toBe('docker exec my-installer jw reinstall --yes')
  })

  it('잠긴 뒤에는 워크스페이스 주소만 온다', () => {
    const s = normalizeState({ phase: 'installed', locked: true, version: '1.4.0', url: 'https://workspace.example.com' }, 'ok')
    expect(s).toMatchObject({ locked: true, phase: 'installed' })
    expect(s.info.app_url).toBe('https://workspace.example.com')
  })

  it('토큰 확인 — 성공 · 틀림 · 만료 · 잠시 받지 않음', async () => {
    const api = createHttpApi()
    replies['POST /api/session'] = [
      { body: { ok: true } },
      { status: 401, body: { code: 'token_wrong', vars: { retry_after: 0 } } },
      { status: 401, body: { code: 'token_expired', vars: {} } },
      { status: 429, body: { code: 'token_locked', vars: { retry_after: 27 } } },
    ]
    expect(await api.createSession('K7QF93MD2XTB')).toEqual({ status: 'ok' })
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/session', body: { token: 'K7QF93MD2XTB' } })
    expect((await api.createSession('x')).status).toBe('wrong')
    expect((await api.createSession('x')).status).toBe('expired')
    expect(await api.createSession('x')).toEqual({ status: 'locked', retry_after: 27 })
  })
})

describe('답변 · 요약 · 확인', () => {
  it('부분 저장은 조각을 그대로 보내고, 서버의 secrets_set 을 secrets 로 읽는다', async () => {
    replies['PUT /api/answers'] = { body: { answers: emptyAnswers(), secrets_set: { 'admin.password': true }, errors: [] } }
    const r = await createHttpApi().putAnswers({ admin: { username: 'admin', password: 'correct horse battery' } }, 'summary')
    expect(calls[0].url).toBe('/api/answers?step=summary')
    expect(calls[0].body).toEqual({ admin: { username: 'admin', password: 'correct horse battery' } })
    expect(r.secrets).toEqual({ 'admin.password': true })
  })

  it('요약의 구역은 id 목록으로 맞춘다', () => {
    const s = normalizeSummary({ ready: false, zones: [{ id: 'mail', name: { ko: '메일', en: 'Mail' } }, { id: 'chat', name: {} }], ports: ['80/tcp'], preflight: { checked: true, ok: false } })
    expect(s.zones).toEqual(['mail', 'chat'])
    expect(s.cautions).toEqual([])
    expect(s.errors).toEqual([])
    expect(s.preflight?.ok).toBe(false)
  })

  it('인증서 확인은 파일의 글자를 보낸다', async () => {
    replies['POST /api/probe/cert'] = { body: { ok: true, checks: [] } }
    await createHttpApi().probeCert(new File(['CERT PEM'], 'fullchain.pem'), new File(['KEY PEM'], 'privkey.pem'), 'workspace.example.com')
    expect(calls[0].body).toEqual({ cert: 'CERT PEM', key: 'KEY PEM', domain: 'workspace.example.com' })
  })

  it('적용 시작 · 다시 하기는 시작만 알리므로 이어서 상태를 읽는다', async () => {
    const api = createHttpApi()
    replies['POST /api/apply'] = { status: 202, body: { started: true } }
    replies['POST /api/apply/retry'] = { status: 409, body: { code: 'apply_running', vars: {} } }
    replies['GET /api/apply'] = { body: { status: 'running', steps: [], current: 'config', error: null } }
    expect((await api.startApply()).status).toBe('running')
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual(['POST /api/apply', 'GET /api/apply'])
    // 이미 돌고 있으면(409) 그 진행을 그대로 보여 준다
    expect((await api.retryApply({ use_temporary_cert: true })).status).toBe('running')
    expect(calls[2].body).toEqual({ use_temporary_cert: true })
  })

  it('복원 — 계약의 경로와 본문으로 부른다', async () => {
    const api = createHttpApi()
    const info = { status: 'ok', state: 'ready', name: 'a.jwbak', size_bytes: 10, source: 'path', path: '/srv/a.jwbak', reason: null }
    replies['POST /api/restore/path'] = { body: info }
    replies['POST /api/restore/password'] = { body: { ...info, status: 'password_wrong' } }
    replies['GET /api/restore/file'] = { body: { ...info, status: 'none', state: 'none' } }
    replies['DELETE /api/restore/file'] = { status: 204 }
    replies['POST /api/restore/apply'] = [{ status: 202, body: { started: true } }, { status: 409, body: { code: 'apply_running', vars: {} } }, { status: 422, body: { code: 'restore_invalid', vars: { errors: [{ field: 'storage.kind', code: 'storage_must_be_nfs', vars: {} }] } } }]
    replies['POST /api/restore/apply/retry'] = { status: 202, body: { started: true } }
    replies['GET /api/restore/apply'] = { body: { status: 'running', steps: [], current: 'unpack', error: null, restore: { files: 'nfs', storage_kind: 'nfs', domain_changed: false, cert: 'auto' } } }
    expect((await api.restoreCheckPath('/srv/a.jwbak')).status).toBe('ok')
    expect((await api.restorePassword('pw')).status).toBe('password_wrong')
    expect((await api.restoreFile()).status).toBe('none')
    await api.restoreDiscard()
    const target = { domain: 'workspace.example.com', storage: { kind: 'nfs' as const, server: 'nas.example.com', export: '/volume1/workspace' }, network: 'proxy' as const, proxy_addresses: ['192.168.10.5'], subnet: '172.28.0.0/24' }
    expect((await api.restoreApply(target)).restore?.files).toBe('nfs')
    // 이미 돌고 있으면(409) 그 진행을 그대로 보여 준다
    expect((await api.restoreApply(target)).status).toBe('running')
    // 거부(422)는 사유를 그대로 올린다
    const refused = await api.restoreApply(target).catch(x => x) as ApiError
    expect(refused.code).toBe('restore_invalid')
    expect(refused.vars.errors).toEqual([{ field: 'storage.kind', code: 'storage_must_be_nfs', vars: {} }])
    await api.restoreRetry({ use_temporary_cert: true })
    const sent = calls.filter(c => c.method !== 'GET').map(c => [`${c.method} ${c.url}`, c.body])
    expect(sent).toEqual([
      ['POST /api/restore/path', { path: '/srv/a.jwbak' }],
      ['POST /api/restore/password', { password: 'pw' }],
      ['DELETE /api/restore/file', undefined],
      ['POST /api/restore/apply', target],
      ['POST /api/restore/apply', target],
      ['POST /api/restore/apply', target],
      ['POST /api/restore/apply/retry', { use_temporary_cert: true }],
    ])
  })

  it('복원이 없는 옛 서버 — 501 · 404 · 405 를 모두 "지원하지 않음"으로 알린다', async () => {
    const api = createHttpApi()
    replies['POST /api/restore/path'] = { status: 501, body: { code: 'restore_not_supported', vars: {} } }
    replies['GET /api/restore/review'] = { status: 405, body: { detail: 'Method Not Allowed' } }
    await expect(api.restoreCheckPath('/srv/a.bak')).rejects.toMatchObject({ notImplemented: true })
    const e = await api.restoreReview().catch(x => x)
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).notImplemented).toBe(true)
  })
})

describe('적용 상태 흐름', () => {
  it('흐름을 열 수 없으면 주기적으로 읽고, 끝 상태를 읽기 전에 잠기면 완료로 마무리한다', async () => {
    replies['GET /api/apply'] = [
      { body: { status: 'running', steps: [{ id: 'config', status: 'done' }, { id: 'lock', status: 'running' }], current: 'lock', error: null } },
      { status: 423, body: { code: 'locked', vars: {} } },
    ]
    vi.useFakeTimers()
    const seen: ApplyState[] = []
    const stop = createHttpApi().streamApply(s => seen.push(s))
    await vi.advanceTimersByTimeAsync(10)
    expect(seen.map(s => s.status)).toEqual(['running'])
    await vi.advanceTimersByTimeAsync(2100)
    expect(seen.map(s => s.status)).toEqual(['running', 'done'])
    expect(seen[1].steps.every(s => s.status === 'done')).toBe(true)
    const count = calls.length
    await vi.advanceTimersByTimeAsync(6000)
    expect(calls.length).toBe(count)
    stop()
  })
})

describe('이어 할 단계 짐작', () => {
  const answers = (patch: (a: Answers) => void): Answers => { const a = emptyAnswers(); patch(a); return a }

  it('채워진 것이 없으면 이어 할 것이 없다', () => {
    expect(resumeStep(emptyAnswers(), null)).toBeNull()
  })

  it('값이 채워진 마지막 단계의 다음', () => {
    expect(resumeStep(answers(a => { a.access.domain = 'workspace.example.com' }), null)).toBe('storage')
    expect(resumeStep(answers(a => { a.access.domain = 'workspace.example.com'; a.access.network = 'proxy'; a.access.cert = 'proxy' }), null)).toBe('proxy')
    expect(resumeStep(answers(a => { a.access.domain = 'workspace.example.com'; a.zones = ['mail'] }), null)).toBe('mail')
    expect(resumeStep(answers(a => { a.access.domain = 'workspace.example.com'; a.zones = [] }), null)).toBe('admin')
    // 공유기 뒤 — 구역 다음의 안내 단계(값이 없다)부터
    expect(resumeStep(answers(a => { a.access.domain = 'workspace.example.com'; a.access.network = 'router'; a.zones = [] }), null)).toBe('ports')
    expect(resumeStep(answers(a => { a.access.domain = 'workspace.example.com'; a.zones = []; a.admin.username = 'admin' }), null)).toBe('summary')
  })

  it('서버가 기억해 준 단계가 있으면 그것을 따른다', () => {
    expect(resumeStep(answers(a => { a.access.domain = 'workspace.example.com' }), null, 'zones')).toBe('zones')
    expect(resumeStep(emptyAnswers(), null, 'nope')).toBeNull()
  })
})

describe('적용을 시작한 직후', () => {
  const state = (status: ApplyState['status'], updated_at: string, steps: ApplyState['steps'] = []): ApplyState => ({ status, steps, current: null, error: null, updated_at })

  it('서버가 아직 idle 이어도 진행 중으로 보이고, 늦게 오는 idle 은 버린다', () => {
    const store = createWizardStore(createMockApi())
    store.getState().kickApply(state('idle', ''))
    expect(store.getState().apply?.status).toBe('running')
    store.getState().receiveApply(state('idle', ''))
    expect(store.getState().apply?.status).toBe('running')
    store.getState().receiveApply(state('running', 'T1', [{ id: 'config', status: 'running' }]))
    expect(store.getState().apply?.steps).toHaveLength(1)
    expect(store.getState().applyStale).toBeNull()
  })

  it('다시 시킨 직후 — 방금 그 실패 상태가 또 읽혀도 실패로 되돌아가지 않는다', () => {
    const store = createWizardStore(createMockApi())
    const failed = state('failed', 'T5', [{ id: 'config', status: 'done' }, { id: 'cert', status: 'failed', error: { cause: 'cert_issue_failed' } }])
    store.getState().receiveApply(failed)
    const epoch = store.getState().applyEpoch
    store.getState().kickApply(failed)
    expect(store.getState().apply?.status).toBe('running')
    expect(store.getState().apply?.steps[1]).toMatchObject({ status: 'running', error: null })
    expect(store.getState().applyEpoch).toBe(epoch + 1)
    store.getState().receiveApply(failed)
    expect(store.getState().apply?.status).toBe('running')
    // 새로 쓴 상태(시각이 다르다)는 실패여도 받아들인다
    store.getState().receiveApply({ ...failed, updated_at: 'T9' })
    expect(store.getState().apply?.status).toBe('failed')
  })
})
