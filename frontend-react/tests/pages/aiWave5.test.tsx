// Wave5 chat — 내장 AI 화면 보강: 프로젝트 편집·피커(J1) · 공유 상태(J2) · 첨부(K1) · 길이 초과 안내(C2-10) · 설정 › AI 연동(MCP)(H1·H2).
// $fetch·fetch·업로드·apiRawFetch 는 가짜.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts?: any }[],
  status: {} as any,
  conversations: [] as any[],
  temporary: [] as any[],
  projects: [] as any[],
  project: {} as Record<string, any>,
  projectFail: {} as Record<string, boolean>,
  messages: {} as Record<string, any[]>,
  files: {} as Record<string, any[]>,
  groups: [] as any[],
  shareCheck: null as any,
  choices: [] as any[],
  upload: [] as any[],
  info: {} as any,
  apps: [] as any[],
  appsFail: false,
  tokens: [] as any[],
}))

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: any) => {
    api.calls.push({ url, opts })
    const method = opts?.method || 'GET'
    if (url === '/api/ai/status') return api.status
    if (url === '/api/ai/model-choices') return { choices: api.choices }
    if (url === '/api/ai/my-settings' && method === 'PUT') {
      api.status = { ...api.status, vision: true, model: 'claude-sonnet-4-5' }
      return {}
    }
    if (url === '/api/ai/conversations' && method === 'GET') return { conversations: api.conversations, temporary: api.temporary }
    if (url === '/api/ai/conversations' && method === 'POST') return { id: 'new1', title: '새 대화', tools_enabled: false, temporary: false, project_id: opts.body.project_id }
    if (url === '/api/ai/projects') return { projects: api.projects }
    if (url === '/api/ai/projects/share-targets') return { groups: api.groups }
    if (/\/share-check\?/.test(url)) return api.shareCheck
    const pf = url.match(/^\/api\/ai\/projects\/([^/]+)\/files(\/[^/]+)?$/)
    if (pf) return api.project[pf[1]]
    const pj = url.match(/^\/api\/ai\/projects\/([^/?]+)$/)
    if (pj) {
      if (api.projectFail[pj[1]]) throw Object.assign(new Error('404'), { status: 404, data: { detail: '프로젝트를 찾을 수 없습니다' } })
      if (method === 'PATCH') return { ...api.project[pj[1]], ...opts.body }
      return api.project[pj[1]]
    }
    if (url.startsWith('/api/files/list')) {
      const path = decodeURIComponent(url.split('path=')[1] || '')
      return { items: api.files[path] || [] }
    }
    const m = url.match(/^\/api\/ai\/conversations\/([^/]+)\/messages$/)
    if (m) return { messages: api.messages[m[1]] || [] }
    if (url === '/api/ai-connect/info') return api.info
    if (url === '/api/ai-connect/apps') {
      if (api.appsFail) throw Object.assign(new Error('500'), { status: 500 })
      return { apps: api.apps }
    }
    if (url.startsWith('/api/ai-connect/apps/') && method === 'DELETE') return { ok: true, rejected: 2 }
    if (url === '/api/ai-connect/tokens' && method === 'GET') return { tokens: api.tokens }
    if (url === '/api/ai-connect/tokens' && method === 'POST') return { token: 'wsmcp_secretvalue1234', id: 't9', name: opts.body.name }
    return {}
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  const apiRawFetch = vi.fn(async (url: string) => {
    api.calls.push({ url })
    if (url.endsWith('/text')) return new Response(JSON.stringify({ text: '사양서 본문 FW-01', has_file: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    return new Response(null, { status: 204 })
  })
  return { ...real, $fetch, apiRawFetch }
})

vi.mock('~/utils/aiUpload', () => ({
  aiUploadAttachment: vi.fn(async (file: File, _c: string | null, onStage: (s: string) => void) => {
    onStage('uploading')
    return api.upload.shift() ?? { id: 'att1', name: file.name, size: file.size, kind: 'document', status: 'ready' }
  }),
}))

const { default: AiPage } = await import('~/pages/ai')
const { default: McpPage } = await import('~/pages/settings/ai-mcp')
const { isMobileStore } = await import('~/composables/useIsMobile')
const { setUser } = await import('~/composables/useAuth')

function renderAt(el: React.ReactElement, path = '/ai') {
  const router = createMemoryRouter([{ path: '*', element: el }], { initialEntries: [path] })
  return render(<RouterProvider router={router} />)
}
function sseResponse(chunks: string[]) {
  const enc = new TextEncoder()
  let i = 0
  const body = new ReadableStream<Uint8Array>({ pull(ctl) { if (i < chunks.length) ctl.enqueue(enc.encode(chunks[i++])); else ctl.close() } })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}
const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
const T0 = '2026-11-05T01:00:00.000Z'

const owner = {
  id: 'p1', name: '인프라 운영', instructions: '답은 개조식으로', role: 'owner', editable: true, shared: false,
  share_group_ids: [], share_groups: [], conversation_count: 0, files_size: 1000,
  files: [{ id: 'f1', name: '랩실 장비 목록.xlsx', path: 'my/랩실 장비 목록.xlsx', size: 1000, readable: true }],
}

beforeEach(() => {
  api.calls = []
  api.status = { module_enabled: true, configured: true, provider_kind: 'compatible', model: 'qwen3-27b', external: false, is_admin: false, allow_user_keys: false, external_allow_data: false, needs_consent: false, tools: [], vision: true, attachment_max_bytes: 30 * 1024 * 1024 }
  api.conversations = [{ id: 'c1', title: '첫 대화', tools_enabled: false, updated_at: new Date().toISOString(), project_id: null }]
  api.temporary = []
  api.projects = []
  api.project = {}
  api.projectFail = {}
  api.messages = { c1: [] }
  api.files = {}
  api.groups = []
  api.shareCheck = null
  api.choices = []
  api.upload = []
  api.info = { read_url: 'https://mcp.example.com:8443/api/mcp/read', write_url: 'https://mcp.example.com:8443/api/mcp/write', write_enabled: true, token_prefix: 'wsmcp_', token_expiry_days: [30, 90, 365] }
  api.apps = []
  api.appsFail = false
  api.tokens = []
  isMobileStore.setState({ isMobile: false })
  setUser({ id: 'u1', username: 'qa', display_name: '검수', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: false, last_login_at: null })
  try { localStorage.removeItem('ai-sidebar-collapsed') } catch { /* */ }
  vi.unstubAllGlobals()
})

async function openC1() {
  renderAt(<AiPage />)
  await waitFor(() => expect(api.calls.some(c => c.url === '/api/ai/conversations/c1/messages')).toBe(true))
}

describe('J1 프로젝트 편집·피커', () => {
  it('지침 글자 수(4,000 넘으면 오류·저장 막힘) · 피커(이미 들어 있음·20개 안내) · 저장 = PATCH + 파일 연결', async () => {
    api.projects = [owner]
    api.project = { p1: owner }
    api.files = {
      '': [{ name: '내 파일', path: 'my', is_dir: true }],
      my: [
        { name: '랩실 장비 목록.xlsx', path: 'my/랩실 장비 목록.xlsx', is_dir: false, size: 1000 },
        { name: 'VPN 장비 설정 가이드.pdf', path: 'my/VPN 장비 설정 가이드.pdf', is_dir: false, size: 2048 },
      ],
    }
    await openC1()
    fireEvent.click(await screen.findByRole('button', { name: /인프라 운영/ }))
    fireEvent.click(await screen.findByRole('button', { name: '지침 편집' }))
    const dlg = await screen.findByRole('dialog', { name: '프로젝트 편집' })
    expect(within(dlg).getByTestId('ai-project-count').textContent).toBe('8 / 4,000')
    const ta = within(dlg).getByLabelText('지침') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '가'.repeat(4001) } })
    expect(within(dlg).getByText('4,000자까지 쓸 수 있습니다. 긴 자료는 지식 파일로 올리세요.')).toBeTruthy()
    expect((within(dlg).getByRole('button', { name: '저장' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(ta, { target: { value: '개조식으로, 모델명 그대로' } })
    expect(within(dlg).getByText('파일을 복사하지 않고 연결합니다. 원본을 고치면 다음 답변부터 반영됩니다.')).toBeTruthy()

    fireEvent.click(within(dlg).getByRole('button', { name: '내 파일에서 고르기' }))
    const picker = await screen.findByRole('dialog', { name: '내 파일에서 고르기' })
    fireEvent.click(await within(picker).findByRole('button', { name: '내 파일' }))
    expect(await within(picker).findByText('이미 들어 있음')).toBeTruthy()
    expect((within(picker).getByLabelText('랩실 장비 목록.xlsx') as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(within(picker).getByLabelText('VPN 장비 설정 가이드.pdf'))
    expect(picker.textContent).toContain('1개 고름 · 한 번에 최대 20개 · 프로젝트 전체 2/50개')
    // 검색 결과 없음
    fireEvent.change(within(picker).getByLabelText('이 폴더에서 검색'), { target: { value: '방화벽 로그' } })
    expect(within(picker).getByText('‘방화벽 로그’에 맞는 파일이 없습니다')).toBeTruthy()
    fireEvent.change(within(picker).getByLabelText('이 폴더에서 검색'), { target: { value: '' } })
    fireEvent.click(within(picker).getByRole('button', { name: '1개 추가' }))

    const dlg2 = await screen.findByRole('dialog', { name: '프로젝트 편집' })
    expect(within(dlg2).getByText('VPN 장비 설정 가이드.pdf')).toBeTruthy()
    fireEvent.click(within(dlg2).getByRole('button', { name: '랩실 장비 목록.xlsx 빼기' }))
    fireEvent.click(within(dlg2).getByRole('button', { name: '저장' }))
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/ai/projects/p1/files' && c.opts?.method === 'POST')).toBe(true))
    const patch = api.calls.find(c => c.url === '/api/ai/projects/p1' && c.opts?.method === 'PATCH')!
    expect(patch.opts.body.instructions).toBe('개조식으로, 모델명 그대로')
    expect(api.calls.some(c => c.url === '/api/ai/projects/p1/files/f1' && c.opts?.method === 'DELETE')).toBe(true)
    expect(api.calls.find(c => c.url === '/api/ai/projects/p1/files' && c.opts?.method === 'POST')!.opts.body.paths).toEqual(['my/VPN 장비 설정 가이드.pdf'])
  })
})

describe('J2 공유 상태', () => {
  it('공유 창: 그룹(구성원 수) 여러 개 · 못 읽는 파일 경고 · 공유 = PATCH share_group_ids', async () => {
    api.projects = [owner]
    api.project = { p1: owner }
    api.groups = [{ id: 'g1', name: '인프라팀', members: 14 }, { id: 'g2', name: '3층 랩실 운영', members: 6 }]
    api.shareCheck = { members: 13, blocked_members: 3, files: [{ id: 'f1', name: '방화벽 정책 기준.hwp', blocked: 3 }] }
    await openC1()
    fireEvent.click(await screen.findByRole('button', { name: /인프라 운영/ }))
    fireEvent.click(await screen.findByRole('button', { name: '프로젝트 메뉴' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /공유 설정/ }))
    const dlg = await screen.findByRole('dialog', { name: '‘인프라 운영’ 공유' })
    expect(await within(dlg).findByText('14명')).toBeTruthy()
    fireEvent.click(within(dlg).getByRole('checkbox', { name: /인프라팀/ }))
    fireEvent.click(within(dlg).getByRole('checkbox', { name: /3층 랩실 운영/ }))
    const note = await within(dlg).findByRole('note', {}, { timeout: 2000 })
    expect(note.textContent).toBe('인프라팀·3층 랩실 운영 중 3명은 지식 파일 1개(방화벽 정책 기준.hwp)를 볼 수 없습니다. 그 사람들의 답변에서는 이 파일이 빠집니다.')
    expect(api.calls.some(c => c.url.includes('/share-check?group_ids=g1%2Cg2'))).toBe(true)
    fireEvent.click(within(dlg).getByRole('button', { name: '공유' }))
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/ai/projects/p1' && c.opts?.method === 'PATCH')).toBe(true))
    expect(api.calls.find(c => c.opts?.method === 'PATCH')!.opts.body).toEqual({ share_group_ids: ['g1', 'g2'] })
  })

  it('구성원 머리(공유한 사람·칩 +N) · 답변에서 빠진 지식 파일 줄 [어떤 파일?]', async () => {
    const member = {
      ...owner, role: 'member', editable: false, shared: true, owner_name: '김하나',
      share_groups: [{ id: 'g1', name: '인프라팀' }], unreadable_files: 1,
      files: [
        { id: 'f1', name: '랩실 장비 목록.xlsx', path: 'a', readable: true },
        { id: 'f2', name: '네트워크 구성도.pdf', path: 'b', readable: true },
        { id: 'f3', name: '방화벽 정책 기준.hwp', path: 'c', readable: false },
      ],
    }
    api.projects = [member]
    api.project = { p1: member }
    api.conversations = [{ id: 'c1', title: '점검', tools_enabled: false, updated_at: new Date().toISOString(), project_id: 'p1' }]
    await openC1()
    fireEvent.click(await screen.findByRole('button', { name: /인프라 운영/ }))
    expect(await screen.findByText('김하나 님이 인프라팀에 공유')).toBeTruthy()
    expect(screen.getByText('+1')).toBeTruthy()
    // 프로젝트 대화를 열고 답을 받으면 마지막 답 위에 빠진 파일 줄
    api.messages.c1 = [
      { id: 'q1', role: 'user', content: '빠진 장비?', created_at: T0, versions: [{ id: 'q1' }], active_version: 1, attachments: [] },
      { id: 'a1', role: 'assistant', content: 'L3 스위치 2대', created_at: T0, status: 'complete' },
    ]
    fireEvent.click(screen.getByRole('button', { name: /점검/ }))
    const st = await screen.findByText(/권한이 없어 이번 답변에서 빠졌습니다/)
    expect(st.textContent).toBe('지식 파일 1개는 권한이 없어 이번 답변에서 빠졌습니다.')
    fireEvent.click(screen.getByRole('button', { name: '어떤 파일?' }))
    expect(within(screen.getByRole('list', { name: '빠진 지식 파일' })).getByText('방화벽 정책 기준.hwp')).toBeTruthy()
  })

  it('공유가 끊긴 프로젝트(구성원) — 안내 패널', async () => {
    const member = { ...owner, role: 'member', editable: false, shared: true }
    api.projects = [member]
    api.project = { p1: member }
    api.projectFail = { p1: true }
    await openC1()
    fireEvent.click(await screen.findByRole('button', { name: /인프라 운영/ }))
    expect(await screen.findByText('더 이상 공유되지 않는 프로젝트입니다')).toBeTruthy()
    expect(screen.getByText('지금까지의 내 대화는 ‘최근 대화’로 옮겨 두었습니다. 지식 파일은 더 쓰지 않습니다.')).toBeTruthy()
  })

  it('모바일 390 목록 — 프로젝트(공유받음) · 최근 대화 · 임시 대화', async () => {
    isMobileStore.setState({ isMobile: true })
    api.projects = [owner, { ...owner, id: 'p2', name: '신입 온보딩', role: 'member', editable: false }]
    api.temporary = [{ id: 't1', title: '급여 규정 질문', temporary: true, tools_enabled: false }]
    renderAt(<AiPage />)
    expect(await screen.findByText('신입 온보딩')).toBeTruthy()
    expect(screen.getByText('공유받음')).toBeTruthy()
    expect(screen.getByText('최근 대화')).toBeTruthy()
    expect(screen.getByText('급여 규정 질문')).toBeTruthy()
    expect(screen.getByText('창 닫으면 삭제')).toBeTruthy()
  })
})

describe('K1 첨부', () => {
  it('이미지 썸네일 · 못 읽는 모델이면 오류 줄 + 보내기 막힘 · [이미지 읽는 모델로 바꾸기] = PUT my-settings', async () => {
    api.status.vision = false
    api.choices = [
      { key: 'workspace', available: true, model: 'qwen3-27b', vision: false, current: true },
      { key: 'workspace_advanced', available: true, model: 'claude-sonnet-4-5', vision: true, current: false },
    ]
    api.upload = [{ id: 'img1', name: '랙 사진.png', size: 1900000, kind: 'image', status: 'ready' }]
    ;(URL as any).createObjectURL = vi.fn(() => 'blob:preview')
    ;(URL as any).revokeObjectURL = vi.fn()
    await openC1()
    const input = screen.getByTestId('ai-file-input') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], '랙 사진.png', { type: 'image/png' })] } })
    expect((await screen.findAllByAltText('랙 사진.png 미리보기')).length).toBeGreaterThan(0)
    const alerts = await screen.findAllByRole('alert')
    expect(alerts.some(a => a.textContent?.includes('이 모델(qwen3-27b)은 이미지를 읽지 못합니다. 모델을 바꾸거나 이미지를 빼야 보낼 수 있습니다.'))).toBe(true)
    expect((screen.getByRole('button', { name: '보내기' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('보내기 막힘')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '이미지 읽는 모델로 바꾸기' }))
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/ai/my-settings' && c.opts?.method === 'PUT')).toBe(true))
    expect(api.calls.find(c => c.url === '/api/ai/my-settings')!.opts.body).toEqual({ default_model: 'workspace_advanced' })
    await waitFor(() => expect(screen.queryByText('보내기 막힘')).toBeNull())
  })

  it('vision 모델이 없으면 [이미지 빼기]만 — 누르면 이미지가 빠지고 막힘이 풀린다', async () => {
    api.status.vision = false
    api.choices = [{ key: 'workspace', available: true, model: 'qwen3-27b', vision: false, current: true }]
    api.upload = [{ id: 'img1', name: '랙 사진.png', size: 10, kind: 'image', status: 'ready' }]
    await openC1()
    fireEvent.change(screen.getByTestId('ai-file-input'), { target: { files: [new File(['x'], '랙 사진.png', { type: 'image/png' })] } })
    await screen.findByText('보내기 막힘')
    expect(screen.queryByRole('button', { name: '이미지 읽는 모델로 바꾸기' })).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: '이미지 빼기' })[0])
    await waitFor(() => expect(screen.queryByText('보내기 막힘')).toBeNull())
    expect(api.calls.some(c => c.url === '/api/ai/attachments/img1' && c.opts?.method === 'DELETE')).toBe(true)
  })

  it('보낸 첨부 칩 → 미리보기(뽑은 글자)·내려받기 · 질문 수정 때 첨부 빼기 = keep_attachment_ids', async () => {
    api.messages.c1 = [
      { id: 'q1', role: 'user', content: '사양 비교', created_at: T0, versions: [{ id: 'q1' }], active_version: 1,
        attachments: [{ id: 'a1', name: '장비 사양서.pdf', size: 1400000, kind: 'document', status: 'ready', has_file: true },
          { id: 'a2', name: '점검표.md', size: 100, kind: 'document', status: 'ready', has_file: true }] },
      { id: 'r1', role: 'assistant', content: '비교 결과', created_at: T0, status: 'complete' },
    ]
    const fetchMock = vi.fn(async () => sseResponse([ev('meta', { message_id: 'r9', model: 'm', parent_id: 'q9' }), ev('done', { message_id: 'r9', status: 'complete' })]))
    vi.stubGlobal('fetch', fetchMock)
    await openC1()
    fireEvent.click(await screen.findByRole('button', { name: '점검표.md 열기' }))
    const dlg = await screen.findByRole('dialog', { name: '점검표.md' })
    expect(await within(dlg).findByText('사양서 본문 FW-01')).toBeTruthy()
    expect((within(dlg).getByRole('button', { name: '내려받기' }) as HTMLButtonElement).disabled).toBe(false)
    const closes = within(dlg).getAllByRole('button', { name: '닫기' })
    fireEvent.click(closes[closes.length - 1])

    fireEvent.click(screen.getByRole('button', { name: '질문 수정' }))
    const chip = screen.getByRole('button', { name: /장비 사양서.pdf · 유지/ })
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(chip)
    expect(screen.getByRole('button', { name: /장비 사양서.pdf · 뺌/ }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText('칩을 눌러 이번 버전에 넣을지 고릅니다. 새 파일은 파일 첨부 버튼으로 추가.')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: '보내기' })[0])  // 수정 칸의 보내기(입력창 보내기보다 앞)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/ai/messages/q1/edit')
    expect(JSON.parse(init.body as string)).toEqual({ content: '사양 비교', keep_attachment_ids: ['a2'] })
  })
})

describe('C2-10 길이 초과 안내', () => {
  it('context_trimmed → 대화 맨 위 안내 + 앞 메시지 흐리게 + 새 대화로 이어가기', async () => {
    api.messages.c1 = [
      { id: 'q1', role: 'user', content: '옛 질문', created_at: T0, versions: [{ id: 'q1' }], active_version: 1, attachments: [] },
      { id: 'a1', role: 'assistant', content: '옛 답', created_at: T0, status: 'complete' },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      ev('context_trimmed', { dropped: 2, window: 32000 }),
      ev('meta', { message_id: 'a2', model: 'm', parent_id: 'q2' }),
      ev('token', { text: '새 답' }),
      ev('done', { message_id: 'a2', status: 'complete' }),
    ])))
    await openC1()
    await screen.findByText('옛 답')
    fireEvent.change(screen.getByLabelText('메시지'), { target: { value: '새 질문' } })
    fireEvent.click(screen.getByRole('button', { name: '보내기' }))
    const banner = await screen.findByText(/길이 때문에 이번 답에 쓰지 않았습니다/)
    expect(banner.textContent).toBe('앞부분 2개 메시지는 길이 때문에 이번 답에 쓰지 않았습니다.')
    expect(document.querySelectorAll('[data-trimmed="true"]').length).toBe(2)
    expect(screen.getByRole('button', { name: '빠진 부분 보기' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '새 대화로 이어가기' }))
    await waitFor(() => expect(screen.queryByText(/길이 때문에/)).toBeNull())
  })
})

describe('H 설정 › AI 연동(MCP)', () => {
  it('주소 두 개(:8443) · 연결된 앱 · 연결 해제 확인(대기 n건 거부 안내) · 개인 토큰 만들기 → 한 번 보기', async () => {
    api.apps = [
      { key: 'dcr_claude', kind: 'oauth', name: 'Claude', token_name: null, can_write: true, connected_at: '2026-10-02T01:00:00Z', last_used_at: '2026-11-05T02:48:00Z', pending: 2 },
      { key: 'pat:t1', kind: 'personal_token', name: 'hana-macbook', token_name: 'hana-macbook', can_write: false, connected_at: '2026-10-14T00:00:00Z', last_used_at: '2026-11-05T00:20:00Z', pending: 0 },
    ]
    api.tokens = [{ id: 't1', name: 'hana-macbook', created_at: T0, last_used_at: T0, expires_at: '2027-02-05T00:00:00Z', revoked: false, hint: '7c2e', can_write: false }]
    renderAt(<McpPage />, '/settings/ai/mcp')
    expect(((await screen.findByLabelText('읽기 전용 커넥터 주소')) as HTMLInputElement).value).toBe('https://mcp.example.com:8443/api/mcp/read')
    expect((screen.getByLabelText('쓰기 포함 커넥터 주소') as HTMLInputElement).value).toBe('https://mcp.example.com:8443/api/mcp/write')
    expect(screen.getByText('먼저 이걸 연결하세요')).toBeTruthy()
    expect(await screen.findByText('Claude')).toBeTruthy()
    expect(screen.getAllByText('읽기+쓰기').length).toBeGreaterThan(0)
    expect(screen.getByText('wsmcp_…7c2e')).toBeTruthy()
    expect(screen.getByText('2027-02-05')).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: '연결 해제' })[0])
    const dlg = await screen.findByRole('alertdialog')
    expect(dlg.textContent).toContain('Claude 연결을 끊을까요?')
    expect(dlg.textContent).toContain('승인 대기함에 있는 이 앱의 요청 2건은 ‘연결 해제됨’ 사유로 거부 처리됩니다.')
    fireEvent.click(within(dlg).getByRole('button', { name: '연결 끊기' }))
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/ai-connect/apps/dcr_claude' && c.opts?.method === 'DELETE')).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: '토큰 만들기' }))
    const mk = await screen.findByRole('dialog', { name: '개인 토큰 만들기' })
    expect(within(mk).getByText('무기한 토큰은 만들 수 없습니다.')).toBeTruthy()
    fireEvent.change(within(mk).getByLabelText('이름'), { target: { value: 'lab-runner' } })
    fireEvent.click(within(mk).getByRole('checkbox', { name: /쓰기 권한 포함/ }))
    fireEvent.click(within(mk).getByRole('button', { name: '만들기' }))
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/ai-connect/tokens' && c.opts?.method === 'POST')).toBe(true))
    expect(api.calls.find(c => c.url === '/api/ai-connect/tokens' && c.opts?.method === 'POST')!.opts.body).toEqual({ name: 'lab-runner', expires_days: 90, scope: 'mcp:read mcp:write' })
    const issued = await screen.findByRole('dialog', { name: '토큰을 지금 복사하세요' })
    expect((within(issued).getByLabelText('개인 토큰') as HTMLInputElement).value).toBe('wsmcp_secretvalue1234')
  })

  it('관리자가 쓰기를 막음 · 연결된 앱 없음 · 불러오기 실패', async () => {
    api.info = { ...api.info, write_enabled: false }
    renderAt(<McpPage />, '/settings/ai/mcp')
    expect(await screen.findByText('조직에서 막음')).toBeTruthy()
    expect(screen.queryByLabelText('쓰기 포함 커넥터 주소')).toBeNull()
    expect(await screen.findByText('연결된 앱이 없습니다')).toBeTruthy()
    expect(screen.getByText('claude.ai › 설정 › 커넥터에서 읽기 전용 주소를 추가하면 여기에 나타납니다.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '토큰 만들기' }))
    const mk = await screen.findByRole('dialog', { name: '개인 토큰 만들기' })
    expect(within(mk).queryByRole('checkbox', { name: /쓰기 권한 포함/ })).toBeNull()
  })

  it('연결된 앱 불러오기 실패 — 오류 타일(연결 자체는 그대로)', async () => {
    api.appsFail = true
    renderAt(<McpPage />, '/settings/ai/mcp')
    expect(await screen.findByText('연결된 앱 목록을 불러오지 못했습니다')).toBeTruthy()
    expect(screen.getByText(/서버 응답 500 · .* · 연결 자체는 그대로입니다/)).toBeTruthy()
  })
})
