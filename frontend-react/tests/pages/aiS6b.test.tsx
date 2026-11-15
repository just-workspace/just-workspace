// AI 대화 기본기 2: 답변 버전(◀ n/N ▶·질문 수정), 임시 대화(배너·사이드바·만들기), 프로젝트(카드·구성원 읽기 전용),
// 메모리 저장 알림 [취소] + 설정 화면 비밀 거부, 첨부(단계·실패 코드), 사이드바 서버 검색. $fetch·fetch·업로드는 가짜.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts?: any }[],
  conversations: [] as any[],
  temporary: [] as any[],
  projects: [] as any[],
  project: {} as Record<string, any>,
  messages: {} as Record<string, any[]>,
  versionReply: [] as any[],
  memory: { enabled: true, total: 0, items: [] as any[] },
  search: [] as any[],
  upload: [] as any[],
}))

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: any) => {
    api.calls.push({ url, opts })
    const method = opts?.method || 'GET'
    if (url === '/api/ai/status') {
      return { module_enabled: true, configured: true, provider_kind: 'compatible', model: 'test-model', external: false, is_admin: false, allow_user_keys: false, external_allow_data: false, needs_consent: false, tools: [], vision: false, attachment_max_bytes: 30 * 1024 * 1024 }
    }
    if (url === '/api/ai/conversations' && method === 'GET') return { conversations: api.conversations, temporary: api.temporary }
    if (url === '/api/ai/conversations' && method === 'POST') {
      return { id: 'new1', title: '새 대화', tools_enabled: false, temporary: !!opts.body.temporary, project_id: opts.body.project_id }
    }
    if (url === '/api/ai/projects') return { projects: api.projects }
    const pj = url.match(/^\/api\/ai\/projects\/([^/]+)$/)
    if (pj) return api.project[pj[1]]
    if (url.startsWith('/api/ai/search')) return { results: api.search }
    const m = url.match(/^\/api\/ai\/conversations\/([^/]+)\/messages$/)
    if (m) return { messages: api.messages[m[1]] || [] }
    if (/\/api\/ai\/messages\/[^/]+\/versions\/\d+$/.test(url)) return { messages: api.versionReply }
    if (url === '/api/ai/memory' && method === 'GET') return api.memory
    if (url === '/api/ai/memory' && method === 'POST') {
      if (/hunter|ghp_/.test(opts.body.text)) {
        throw Object.assign(new Error('422'), { data: { detail: { code: 'secret', message: '비밀 정보로 보여 저장하지 않습니다' } } })
      }
      return { id: 'm9', kind: opts.body.kind, text: opts.body.text, source_conversation_id: null, created_at: '2026-11-05T00:00:00Z' }
    }
    return {}
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch, apiRawFetch: vi.fn(async () => new Response(null, { status: 204 })) }
})

vi.mock('~/utils/aiUpload', () => ({
  aiUploadAttachment: vi.fn(async (file: File, _c: string | null, onStage: (s: string) => void) => {
    onStage('uploading')
    onStage('converting')
    return api.upload.shift() ?? { id: 'att1', name: file.name, size: file.size, kind: 'document', status: 'ready', chars: 10 }
  }),
}))

const { default: AiPage } = await import('~/pages/ai')
const { default: MemoryPage } = await import('~/pages/settings/ai-memory')
const { AiAttachments } = await import('~/components/ai/AiAttachments')
const { isMobileStore } = await import('~/composables/useIsMobile')
const { setUser } = await import('~/composables/useAuth')
const { aiAttachErrorKey, aiHighlightParts, aiFormatBytes } = await import('~/utils/aiAssist')

function renderAt(el: React.ReactElement, path = '/ai') {
  const router = createMemoryRouter([{ path: '*', element: el }], { initialEntries: [path] })
  return render(<RouterProvider router={router} />)
}

function sseResponse(chunks: string[]) {
  const enc = new TextEncoder()
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (i < chunks.length) ctl.enqueue(enc.encode(chunks[i++]))
      else ctl.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}
const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
const T0 = '2026-11-05T01:00:00.000Z'

beforeEach(() => {
  api.calls = []
  api.conversations = [{ id: 'c1', title: '첫 대화', tools_enabled: false, updated_at: new Date().toISOString(), project_id: null }]
  api.temporary = []
  api.projects = []
  api.project = {}
  api.messages = { c1: [] }
  api.versionReply = []
  api.memory = { enabled: true, total: 0, items: [] }
  api.search = []
  api.upload = []
  isMobileStore.setState({ isMobile: false })
  setUser({ id: 'u1', username: 'qa', display_name: '검수', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: false, last_login_at: null })
  try { localStorage.removeItem('ai-sidebar-collapsed') } catch { /* */ }
  vi.unstubAllGlobals()
})

async function openC1() {
  renderAt(<AiPage />)
  await waitFor(() => expect(api.calls.some(c => c.url === '/api/ai/conversations/c1/messages')).toBe(true))
}

describe('답변 버전', () => {
  it('◀ 2/2 ▶ — 이전 버전을 누르면 그 가지 메시지로 바뀌고, 다시 다음으로 돌아올 수 있다', async () => {
    api.messages.c1 = [
      { id: 'q1b', role: 'user', content: '고친 질문', created_at: T0, versions: [{ id: 'q1', created_at: T0 }, { id: 'q1b', created_at: T0 }], active_version: 2, attachments: [] },
      { id: 'a2', role: 'assistant', content: '새 답', created_at: T0, status: 'complete', model: 'm' },
    ]
    api.versionReply = [
      { id: 'q1', role: 'user', content: '원래 질문', created_at: T0, versions: [{ id: 'q1' }, { id: 'q1b' }], active_version: 1, attachments: [] },
      { id: 'a1', role: 'assistant', content: '옛 답', created_at: T0, status: 'complete' },
      { id: 'q2', role: 'user', content: '이어진 질문', created_at: T0, versions: [{ id: 'q2' }], active_version: 1, attachments: [] },
      { id: 'a3', role: 'assistant', content: '이어진 답', created_at: T0, status: 'complete' },
    ]
    await openC1()
    expect(await screen.findByText('2/2')).toBeTruthy()
    expect((screen.getByRole('button', { name: '다음 버전' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '이전 버전' }))
    await screen.findByText('이어진 답')
    expect(api.calls.some(c => c.url === '/api/ai/messages/q1b/versions/1' && c.opts?.method === 'POST')).toBe(true)
    expect(screen.getByText('원래 질문')).toBeTruthy()
    expect(screen.queryByText('새 답')).toBeNull()
    expect(screen.getByText('1/2')).toBeTruthy()
  })

  it('질문 수정 → 안내 문구 + 보내기 = POST /messages/{id}/edit 스트림', async () => {
    api.messages.c1 = [
      { id: 'q1', role: 'user', content: '보고서 써 줘', created_at: T0, versions: [{ id: 'q1' }], active_version: 1, attachments: [] },
      { id: 'a1', role: 'assistant', content: '초안', created_at: T0, status: 'complete' },
    ]
    const fetchMock = vi.fn(async () => sseResponse([ev('meta', { message_id: 'a9', model: 'm', parent_id: 'q9' }), ev('token', { text: '새 초안' }), ev('done', { message_id: 'a9', status: 'complete' })]))
    vi.stubGlobal('fetch', fetchMock)
    await openC1()
    fireEvent.click(await screen.findByRole('button', { name: '질문 수정' }))
    const box = screen.getByLabelText('질문 수정') as HTMLTextAreaElement
    expect(box.value).toBe('보고서 써 줘')
    expect(document.body.textContent).toContain('보내면 새 답변이 2/2으로 생깁니다')
    fireEvent.change(box, { target: { value: '보고서 써 줘. 가용률도' } })
    // 수정 칸의 보내기(입력창 보내기와 구분)
    fireEvent.click(within(box.closest('.rounded-xl') as HTMLElement).getByRole('button', { name: '보내기' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/ai/messages/q1/edit')
    expect(JSON.parse(String(init.body))).toEqual({ content: '보고서 써 줘. 가용률도' })
    await waitFor(() => expect(api.calls.filter(c => c.url === '/api/ai/conversations/c1/messages').length).toBeGreaterThan(1))
  })
})

describe('임시 대화', () => {
  it('사이드바 "임시 대화"(창 닫으면 삭제)·스위치를 켜면 배너, 보내면 temporary 대화를 만든다', async () => {
    api.temporary = [{ id: 't1', title: '급여 규정 질문', temporary: true, tools_enabled: false }]
    const fetchMock = vi.fn(async () => sseResponse([ev('done', { message_id: null, status: 'complete' })]))
    vi.stubGlobal('fetch', fetchMock)
    await openC1()
    expect(await screen.findByText('급여 규정 질문')).toBeTruthy()
    expect(screen.getByText('창 닫으면 삭제')).toBeTruthy()
    // 일반 대화 목록엔 임시 대화가 없다
    expect(screen.getAllByText('첫 대화').length).toBeGreaterThan(0)
    // 메시지 없는 대화에서 스위치 켜기
    fireEvent.click(screen.getByRole('switch', { name: '임시 대화' }))
    expect(await screen.findByText(/대화 기록과 메모리에 남지 않고/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('메시지'), { target: { value: '비밀 질문' } })
    fireEvent.click(screen.getByRole('button', { name: '보내기' }))
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/ai/conversations' && c.opts?.method === 'POST')).toBe(true))
    const post = api.calls.find(c => c.url === '/api/ai/conversations' && c.opts?.method === 'POST')!
    expect(post.opts.body.temporary).toBe(true)
    expect(post.opts.body.project_id).toBeNull()
  })

  it('임시 대화를 떠나면 지운다', async () => {
    api.temporary = [{ id: 't1', title: '급여 규정 질문', temporary: true, tools_enabled: false }]
    api.messages.t1 = []
    await openC1()
    fireEvent.click(await screen.findByText('급여 규정 질문'))
    await screen.findByText(/대화 기록과 메모리에 남지 않고/)
    fireEvent.click(screen.getAllByText('첫 대화')[0])
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/ai/conversations/t1' && c.opts?.method === 'DELETE')).toBe(true))
  })
})

describe('프로젝트', () => {
  const owner = { id: 'p1', name: '인프라 운영', instructions: '답은 개조식으로', role: 'owner', editable: true, shared: false, conversation_count: 0, files: [{ id: 'f1', name: '장비 목록.xlsx', path: 'my/장비 목록.xlsx', size: 1024 }], files_size: 1024 }

  it('주인: 카드에 지침·지식 파일·편집 단추, 새 대화는 project_id 로', async () => {
    api.projects = [owner]
    api.project = { p1: owner }
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([ev('done', { status: 'complete' })])))
    await openC1()
    fireEvent.click(await screen.findByRole('button', { name: /인프라 운영/ }))
    expect(await screen.findByText('답은 개조식으로')).toBeTruthy()
    expect(screen.getByText('장비 목록.xlsx')).toBeTruthy()
    expect(screen.getByText('나만 보기')).toBeTruthy()
    expect(screen.getByRole('button', { name: '지침 편집' })).toBeTruthy()
    expect(screen.getByText('인프라 운영에서 무엇을 할까요?')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('메시지'), { target: { value: '질문' } })
    fireEvent.click(screen.getByRole('button', { name: '보내기' }))
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/ai/conversations' && c.opts?.method === 'POST')).toBe(true))
    expect(api.calls.find(c => c.url === '/api/ai/conversations' && c.opts?.method === 'POST')!.opts.body.project_id).toBe('p1')
  })

  it('공유받은 구성원: (공유) 표시·읽기 전용 안내, 고치는 단추 없음', async () => {
    const member = { ...owner, role: 'member', editable: false, shared: true, share_group_name: '인프라팀' }
    api.projects = [member]
    api.project = { p1: member }
    await openC1()
    expect(await screen.findByText('(공유)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /인프라 운영/ }))
    expect(await screen.findByText(/내 대화는 나만 봅니다/)).toBeTruthy()
    expect(screen.getByText('공유받음')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '지침 편집' })).toBeNull()
    expect(screen.queryByRole('button', { name: '파일 추가' })).toBeNull()
  })
})

describe('메모리', () => {
  it('답변 중 저장 알림 → [취소] = DELETE /api/ai/memory/{id}', async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      ev('meta', { message_id: 'a1', model: 'm', parent_id: 'q1' }),
      ev('memory_saved', { id: 'm1', kind: 'preference', text: '보고서는 개조식 선호' }),
      ev('token', { text: '기억해 둘게요' }),
      ev('done', { message_id: 'a1', status: 'complete' }),
    ]))
    vi.stubGlobal('fetch', fetchMock)
    await openC1()
    fireEvent.change(screen.getByLabelText('메시지'), { target: { value: '보고서는 개조식으로 기억해' } })
    fireEvent.click(screen.getByRole('button', { name: '보내기' }))
    expect(await screen.findByText('메모리에 저장함 — “보고서는 개조식 선호”')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '취소' }))
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/ai/memory/m1' && c.opts?.method === 'DELETE')).toBe(true))
    expect(await screen.findByText('저장을 취소했습니다')).toBeTruthy()
    // 방금 보낸 질문에 서버 id 가 달려 수정 단추가 켜진다
    expect(screen.getByRole('button', { name: '질문 수정' })).toBeTruthy()
  })

  it('설정 › 메모리: 목록·종류 거르기·직접 추가 비밀 거부 문구', async () => {
    api.memory = { enabled: true, total: 2, items: [
      { id: 'm1', kind: 'preference', text: '보고서는 개조식', source_conversation_id: 'c1', source_title: 'VPN 보고서', created_at: '2026-11-05T00:00:00Z' },
      { id: 'm2', kind: 'person', text: '이서연 님 — 지사 담당', source_conversation_id: null, created_at: '2026-10-28T00:00:00Z' },
    ] }
    renderAt(<MemoryPage />, '/settings/ai/memory')
    expect(await screen.findByText('보고서는 개조식')).toBeTruthy()
    expect(screen.getByText(/대화 “VPN 보고서”에서/)).toBeTruthy()
    expect(screen.getByText(/직접 추가 ·/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '사람' }))
    expect(screen.queryByText('보고서는 개조식')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /직접 추가/ }))
    fireEvent.change(screen.getByLabelText('기억할 내용 한 문장'), { target: { value: '비번: hunter22' } })
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    expect(await screen.findByText(/비밀 정보\(비밀번호·토큰·주민번호·카드번호\)는 메모리에 저장하지 않습니다/)).toBeTruthy()
    // 스위치 끄면 빈 상태
    fireEvent.click(screen.getByRole('switch', { name: /메모리 사용/ }))
    expect(await screen.findByText('메모리를 쓰지 않습니다')).toBeTruthy()
    expect(api.calls.some(c => c.url === '/api/ai/memory-settings' && c.opts?.body?.enabled === false)).toBe(true)
  })
})

describe('첨부', () => {
  it('단계 칩: 올리는 중·변환 중·완료·실패 코드 문구, 이미지인데 모델이 못 읽으면 경고', () => {
    render(<AiAttachments vision={false} onRemove={() => {}} items={[
      { key: '1', id: null, name: 'a.hwp', size: 2048, status: 'uploading' },
      { key: '2', id: null, name: 'b.hwp', size: 2048, status: 'converting' },
      { key: '3', id: 'x', name: 'c.pdf', size: 2048, status: 'ready', kind: 'document' },
      { key: '4', id: null, name: '보안문서.hwp', size: 2048, status: 'failed', error_code: 'encrypted' },
      { key: '5', id: null, name: '배포.hwp', size: 2048, status: 'failed', error_code: 'distribution' },
      { key: '6', id: 'y', name: '랙.png', size: 2048, status: 'ready', kind: 'image' },
    ]} />)
    expect(screen.getByText(/올리는 중/)).toBeTruthy()
    expect(screen.getByText(/읽을 수 있게 바꾸는 중/)).toBeTruthy()
    expect(screen.getByText(/읽을 수 있게 변환함/)).toBeTruthy()
    expect(screen.getByText('암호가 걸려 있어 읽지 못했습니다')).toBeTruthy()
    expect(screen.getByText('배포용 문서라 읽지 못했습니다')).toBeTruthy()
    expect(screen.getByText(/이 모델은 이미지를 읽지 못합니다/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '보안문서.hwp 빼기' })).toBeTruthy()
    for (const c of ['encrypted', 'distribution', 'corrupt', 'too_large', 'unsupported_version', 'unsupported']) {
      expect(aiAttachErrorKey(c)).toBe(`ai.attach.err.${c}`)
    }
    expect(aiAttachErrorKey('weird')).toBe('ai.attach.err.unsupported')
    expect(aiFormatBytes(212 * 1024)).toBe('212 KB')
  })

  it('파일 고르기 → 올림 → 실패 코드 칩, 30MB 넘으면 올리지 않고 too_large, 성공 첨부는 attachment_ids 로 보낸다', async () => {
    const fetchMock = vi.fn(async () => sseResponse([ev('done', { status: 'complete' })]))
    vi.stubGlobal('fetch', fetchMock)
    api.upload = [
      { id: null, name: '보안문서.hwp', size: 10, status: 'failed', error_code: 'encrypted' },
      { id: 'att1', name: '점검표.md', size: 10, kind: 'document', status: 'ready', chars: 10 },
    ]
    await openC1()
    const input = screen.getByTestId('ai-file-input') as HTMLInputElement
    const big = new File(['x'], '큰파일.pdf')
    Object.defineProperty(big, 'size', { value: 31 * 1024 * 1024 })
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(['a'], '보안문서.hwp'), new File(['b'], '점검표.md'), big] } })
    })
    // 칩은 모바일(카드 위)·데스크톱(카드 안) 두 자리에 그려지고 CSS 로 하나만 보인다
    expect((await screen.findAllByText('암호가 걸려 있어 읽지 못했습니다')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('30MB를 넘어 올리지 못했습니다').length).toBeGreaterThan(0)
    await screen.findAllByText(/읽을 수 있게 변환함/)
    const { aiUploadAttachment } = await import('~/utils/aiUpload')
    expect((aiUploadAttachment as any).mock.calls.length).toBe(2)  // 큰 파일은 올리지 않는다
    fireEvent.change(screen.getByLabelText('메시지'), { target: { value: '비교해 줘' } })
    fireEvent.click(screen.getByRole('button', { name: '보내기' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ content: '비교해 줘', attachment_ids: ['att1'] })
  })

  it('받아쓰기(마이크) 버튼은 없다', async () => {
    await openC1()
    expect(screen.queryByRole('button', { name: /받아쓰기|마이크/ })).toBeNull()
  })
})

describe('대화 검색', () => {
  it('입력하면 서버 검색(제목+본문) 결과에 일치 부분 강조 · 임시 대화 안내', async () => {
    api.search = [{ id: 'c1', title: 'VPN 장애 보고서 초안', snippet: '…본사 게이트웨이의 IKE 재협상 주기와…', match: 'message', message_id: 'm1', updated_at: T0 }]
    await openC1()
    fireEvent.change(screen.getByPlaceholderText('대화 검색'), { target: { value: 'IKE' } })
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/ai/search?q=IKE')).toBe(true), { timeout: 2000 })
    const mark = await screen.findByText('IKE', { selector: 'mark' })
    expect(mark).toBeTruthy()
    expect(screen.getByText('임시 대화는 검색되지 않습니다.')).toBeTruthy()
    expect(aiHighlightParts('abc IKE def', 'ike')).toEqual(['abc ', 'IKE', ' def'])
  })
})
