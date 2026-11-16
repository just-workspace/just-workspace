// 위키 화면(pages/wiki.tsx) — 전수조사 수정 고정:
//  편집 시작 시 서버 최신본을 재조회(열어 둔 탭의 옛 본문으로 타인의 수정을 덮어쓰지 않도록) · 저장에 base_version 포함
//  409(타인이 먼저 수정): 단독이면 덮어쓰지 않고 확인 요청 / 공동 편집 중이면 해당 버전을 기준으로 재저장
//  저장 실패 상태에서 다른 문서로 이동하려 하면 확인을 요청하고, 머물기를 선택하면 편집 화면·주소 유지
//  읽기 본문의 위치·겹침 스타일(position:fixed 등)은 제거
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts: any }[],
  pages: {} as Record<string, any>,
  patch: (_id: string, _body: any): any => ({}),
}))
const stub = vi.hoisted(() => ({
  content: '',
  mounted: null as null | { initialContent: string; onChange?: () => void; onUpdateState?: (s: any) => void },
}))
const dialog = vi.hoisted(() => ({ answers: [] as boolean[], asked: [] as string[] }))

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts: any = {}) => {
    api.calls.push({ url, opts })
    const m = /^\/api\/wiki\/pages\/(\w+)$/.exec(url)
    if (m && opts.method === 'PATCH') return api.patch(m[1], opts.body)
    if (m) { if (!api.pages[m[1]]) throw Object.assign(new Error('404'), { statusCode: 404 }); return { ...api.pages[m[1]] } }
    if (url === '/api/wiki/spaces') return [{ id: 's1', name: '개발', slug: 'dev', visibility: 'private', owner: {}, page_count: 2 }]
    if (url === '/api/wiki/spaces/s1') return { id: 's1', name: '개발', slug: 'dev', visibility: 'private', user_role: 'admin' }
    if (url === '/api/wiki/spaces/s1/pages') return Object.values(api.pages).map((p: any) => ({ id: p.id, parent_id: null, title: p.title, slug: p.id, sort_order: 0, is_pinned: false, version: p.version, author: p.author, updated_at: p.updated_at }))
    if (/\/backlinks$/.test(url)) return { items: [] }
    return []
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

// 공동 편집기는 모의 구현 사용(웹소켓·Yjs 없이) — 화면이 전달한 initialContent 를 표시하고, 본문은 stub.content
vi.mock('~/components/wiki/WikiCollabEditor', async () => {
  const React = await import('react')
  function WikiCollabEditor(props: any) {
    React.useImperativeHandle(props.ref, () => ({ getContent: () => stub.content, save() {}, scrollToHeading() {}, editor: null, connected: true, peers: [] }), [])
    React.useEffect(() => {
      stub.content = props.initialContent
      stub.mounted = { initialContent: props.initialContent, onChange: props.onChange, onUpdateState: props.onUpdateState }
      props.onUpdateState?.({ editor: null, connected: true, peers: [] })
      return () => { stub.mounted = null }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return React.createElement('div', { 'data-testid': 'collab' }, props.initialContent)
  }
  return { WikiCollabEditor, default: WikiCollabEditor }
})
vi.mock('~/components/wiki/WikiProofread', () => ({ WikiProofreadButtons: () => null, WikiProofreadCard: () => null }))
vi.mock('~/composables/useDialog', async (orig) => {
  const real = await orig<typeof import('~/composables/useDialog')>()
  return { ...real, confirmBox: async (msg: string) => { dialog.asked.push(msg); return dialog.answers.shift() ?? false } }
})

const { default: WikiPage } = await import('~/pages/wiki')
const { setAppRouter } = await import('~/lib/router')
const { setUser } = await import('~/composables/useAuth')
const { _resetWikiStore } = await import('~/composables/useWiki')
const { isMobileStore } = await import('~/composables/useIsMobile')
const { i18n } = await import('~/i18n')

const author = { id: 'u1', username: 'qa', display_name: '검수', avatar_url: null }
const page = (id: string, o: Record<string, unknown> = {}) => ({
  id, space_id: 's1', parent_id: null, title: `문서 ${id}`, slug: id, content: '<p>처음 본문</p>', sort_order: 0, is_pinned: false,
  version: 1, author, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', user_role: 'admin', ...o,
})
const conflict = () => Object.assign(new Error('409'), { statusCode: 409, data: { detail: '다른 사람이 이 문서를 먼저 고쳤습니다' } })
const patches = () => api.calls.filter(c => c.opts.method === 'PATCH').map(c => c.opts.body)

async function open(path = '/wiki?space=s1&page=p1') {
  const router = createMemoryRouter([{ path: '/wiki', element: <WikiPage /> }, { path: '*', element: <div>다른 화면</div> }], { initialEntries: [path] })
  setAppRouter(router as any)
  const view = render(<RouterProvider router={router} />)
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('문서 p1'))
  return { router, ...view }
}
const editButton = () => screen.getAllByRole('button').find(b => b.getAttribute('aria-keyshortcuts') === 'E')!
async function startEditing() {
  fireEvent.click(editButton())
  await waitFor(() => expect(stub.mounted).not.toBeNull())
}
/** 편집기에서 사용자가 입력한 것처럼 처리 */
function type(html: string) {
  act(() => { stub.content = html; stub.mounted!.onChange?.() })
}
const done = () => fireEvent.click(screen.getByRole('button', { name: i18n.t('common.done') }))

beforeEach(() => {
  api.calls = []
  api.pages = { p1: page('p1'), p2: page('p2') }
  api.patch = (id, body) => { api.pages[id] = { ...api.pages[id], ...body, version: api.pages[id].version + 1 }; delete api.pages[id].base_version; return { ...api.pages[id] } }
  stub.content = ''
  stub.mounted = null
  dialog.answers = []
  dialog.asked = []
  _resetWikiStore()
  isMobileStore.setState({ isMobile: false } as any)
  setUser({ id: 'u1', username: 'qa', display_name: '검수', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: false, last_login_at: null } as any)
})

describe('위키 편집 — 남의 수정 덮어쓰기 방지', () => {
  it('편집을 누르면 서버 최신본으로 시작하고, 저장에 그 버전(base_version)을 싣는다', async () => {
    await open()
    // 읽기 화면을 열어 둔 사이 타인이 수정함
    api.pages.p1 = page('p1', { content: '<p>남이 고친 본문</p>', version: 3 })
    await startEditing()
    expect(stub.mounted!.initialContent).toBe('<p>남이 고친 본문</p>')

    type('<p>남이 고친 본문 + 내 수정</p>')
    done()
    await waitFor(() => expect(patches()).toHaveLength(1))
    expect(patches()[0]).toEqual({ content: '<p>남이 고친 본문 + 내 수정</p>', base_version: 3 })
    await waitFor(() => expect(screen.queryByTestId('collab')).toBeNull())   // 저장되면 읽기로 전환

    // 다음 편집은 직전 저장으로 증가한 버전(4)을 기준으로 함
    await startEditing()
    type('<p>두 번째</p>')
    done()
    await waitFor(() => expect(patches()).toHaveLength(2))
    expect(patches()[1].base_version).toBe(4)
  })

  it('409 · 혼자 편집 중: 덮어쓰지 않고 머문다 → 다시 시도에서 묻고, 확인하면 버전 검사 없이 저장', async () => {
    await open()
    await startEditing()
    api.patch = (id, body) => {
      if (body.base_version != null) { api.pages[id] = page(id, { content: '<p>남의 저장</p>', version: 5 }); throw conflict() }
      api.pages[id] = { ...api.pages[id], content: body.content, version: 6 }
      return { ...api.pages[id] }
    }
    type('<p>내 수정</p>')
    done()
    await waitFor(() => expect(dialog.asked).toHaveLength(1))   // 완료 → 충돌 → 덮어쓰기 여부 확인(답: 아니오)
    expect(patches()).toHaveLength(1)
    expect(screen.getByTestId('collab')).toBeTruthy()            // 편집 화면 유지
    expect(api.pages.p1.content).toBe('<p>남의 저장</p>')

    dialog.answers = [true]
    fireEvent.click(screen.getByRole('button', { name: i18n.t('common.retry') }))
    await waitFor(() => expect(patches()).toHaveLength(2))
    expect(patches()[1]).toEqual({ content: '<p>내 수정</p>' })   // base_version 없이
    expect(api.pages.p1.content).toBe('<p>내 수정</p>')
  })

  it('409 · 함께 편집 중(같은 공동 문서): 상대가 먼저 저장한 버전을 기준으로 다시 저장한다(묻지 않는다)', async () => {
    await open()
    await startEditing()
    act(() => { stub.mounted!.onUpdateState?.({ editor: null, connected: true, peers: [{ id: 'u2', name: '박', color: '#3eb17e', initial: '박' }] }) })
    let first = true
    api.patch = (id, body) => {
      if (first) { first = false; api.pages[id] = page(id, { content: '<p>함께 쓴 본문(상대 저장)</p>', version: 2 }); throw conflict() }
      api.pages[id] = { ...api.pages[id], content: body.content, version: 3 }
      return { ...api.pages[id] }
    }
    type('<p>함께 쓴 본문</p>')
    done()
    await waitFor(() => expect(patches()).toHaveLength(2))
    expect(patches()[0].base_version).toBe(1)
    expect(patches()[1]).toEqual({ content: '<p>함께 쓴 본문</p>', base_version: 2 })
    expect(dialog.asked).toHaveLength(0)
    await waitFor(() => expect(screen.queryByTestId('collab')).toBeNull())
  })
})

describe('위키 편집 — 저장 실패 상태에서 이동', () => {
  it('다른 문서를 누르면 묻고, 머물기를 고르면 편집 화면·주소가 그대로다. 버리기를 고르면 이동한다', async () => {
    const { router } = await open()
    await startEditing()
    api.patch = () => { throw Object.assign(new Error('500'), { statusCode: 500 }) }
    type('<p>저장 안 되는 수정</p>')

    const other = () => screen.getAllByRole('treeitem').find(r => r.textContent?.includes('문서 p2'))!
    dialog.answers = [false]   // 현재 화면 유지
    fireEvent.click(other())
    await waitFor(() => expect(dialog.asked).toHaveLength(1))
    await waitFor(() => expect(router.state.location.search).toContain('page=p1'))
    expect(screen.getByTestId('collab')).toBeTruthy()
    expect(stub.content).toBe('<p>저장 안 되는 수정</p>')

    dialog.answers = [true]    // 저장하지 않고 이동
    fireEvent.click(other())
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('문서 p2'))
    expect(screen.queryByTestId('collab')).toBeNull()
    expect(router.state.location.search).toContain('page=p2')
  })
})

describe('위키 읽기 본문 정화', () => {
  // 정렬·색 보존과 제거 대상 속성 목록은 tests/board/boardZoneFixes.test.tsx(stripLayoutStyles)에서 검증한다.
  // 여기서는 읽기 화면이 해당 필터를 실제로 거치는지만 확인한다(테스트 DOM 에서는 DOMPurify 가 태그를 브라우저와 다르게 처리하므로 문단 단위 검사는 수행하지 않는다).
  it('position:fixed 같은 자리·겹침 스타일은 읽기 화면에 남지 않는다', async () => {
    api.pages.p1 = page('p1', {
      content: '<p>글</p><a href="https://x.test" style="position:fixed;inset:0;z-index:9999;font-weight:700">덮기</a>',
    })
    const { container } = await open()
    const a = container.querySelector('.wiki-body a') as HTMLElement
    expect(a.getAttribute('href')).toBe('https://x.test')
    expect(a.getAttribute('style') || '').not.toMatch(/position|inset|z-index/)
    expect(a.style.fontWeight).toBe('700')
  })
})
