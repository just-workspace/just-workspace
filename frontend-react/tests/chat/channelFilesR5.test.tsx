// 채널 탭 연결·위키 새 페이지·모바일 파일 상세
// 탭 관리 하위 화면(‹ 제목 · 스페이스 고르기 · 폴더 고르기/들어가기) · 위키 탭 [+] pressed·안내·Esc · 모바일 파일 상세 활동 묶음·전체 목록
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { ReactNode } from 'react'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts?: Record<string, any> }[],
  handler: (_url: string, _opts: Record<string, any>): any => ({}),
}))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts: Record<string, any> = {}) => { api.calls.push({ url, opts }); return api.handler(url, opts) }
  return { ...real, $fetch: Object.assign(fake, { raw: fake, native: fetch, create: () => fake }) }
})

const { ChatChannelTabsManage } = await import('~/components/chat/ChannelTabsManage')
const { ChatChannelWikiTab } = await import('~/components/chat/ChannelWikiTab')
const { FilesFileDetailPanel } = await import('~/components/files/FileDetailPanel')
const { platformStore } = await import('~/composables/usePlatform')
const { isMobileStore } = await import('~/composables/useIsMobile')
const { setUser } = await import('~/composables/useAuth')
const { resetSharedState } = await import('~/lib/state')
const { UiDialogHost } = await import('~/components/ui/DialogHost')

function renderIn(node: ReactNode) {
  const router = createMemoryRouter([{ path: '*', element: node }], { initialEntries: ['/chat'] })
  return render(<RouterProvider router={router} />)
}
const summary = (p: Record<string, any> = {}) => ({
  files_count: 24, folder: null, wiki: null, wiki_space: { id: 'sp1', name: '개발 팀 스페이스', pages: 6 },
  meetings_upcoming: 1, tasks_open: 9, can_manage: true,
  layout: [{ key: 'files', visible: true }, { key: 'wiki', visible: true }, { key: 'meetings', visible: true }, { key: 'tasks', visible: true }],
  ...p,
}) as any

beforeEach(() => {
  api.calls.length = 0
  api.handler = () => ({})
  resetSharedState()
  isMobileStore.setState({ isMobile: false })
  // 탭이 기대는 모듈이 모두 켜진 설치(목록에 없는 모듈은 꺼진 것)
  platformStore.setState({ modules: [{ id: 'files', enabled: true }, { id: 'wiki', enabled: true }, { id: 'meetings', enabled: true }, { id: 'tasks', enabled: true }] as any, loaded: true })
  setUser({ id: 'u1', username: 'haneul', display_name: '정하늘', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: false, last_login_at: null } as any)
})

describe('탭 관리 — 위키 스페이스 바꾸기(#tabWiki)', () => {
  it('‹ 제목 · 검색 · 지금 것 ✓ · 고르고 [이 스페이스로] = wiki_space_id 저장', async () => {
    api.handler = (url, opts) => {
      if (url === '/api/wiki/spaces') {
        return [
          { id: 'sp1', name: '개발 팀 스페이스', visibility: 'private', page_count: 42, owner: { display_name: '개발팀' } },
          { id: 'sp2', name: '제품 기획', visibility: 'public', page_count: 27, owner: { display_name: '박민지' } },
        ]
      }
      if (url === '/api/chat/channels/c1/tabs' && opts.method === 'PUT') return summary({ wiki_space: { id: 'sp2', name: '제품 기획', pages: 27 } })
      return {}
    }
    renderIn(<ChatChannelTabsManage channelId="c1" channelName="개발" summary={summary()} />)
    fireEvent.click(screen.getByRole('button', { name: '바꾸기' }))
    expect(await screen.findByRole('dialog', { name: '위키 스페이스 바꾸기' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '탭 관리로 돌아가기' })).toBeTruthy()
    const now = await screen.findByRole('option', { name: /개발 팀 스페이스/ })
    expect(now.getAttribute('aria-selected')).toBe('true')
    expect(now.textContent).toContain('페이지 42 · 개발팀')
    expect(screen.getByRole('option', { name: /제품 기획/ }).textContent).toContain('페이지 27 · 전체 공개')
    expect(screen.getByText(/지금: 개발 팀 스페이스\./)).toBeTruthy()
    // 지금 것 그대로면 비활성
    const go = screen.getByRole('button', { name: '이 스페이스로' }) as HTMLButtonElement
    expect(go.disabled).toBe(true)
    // 검색으로 거르기
    fireEvent.change(screen.getByRole('textbox', { name: '스페이스 찾기' }), { target: { value: '기획' } })
    expect(screen.queryByRole('option', { name: /개발 팀 스페이스/ })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: /제품 기획/ }))
    expect(go.disabled).toBe(false)
    fireEvent.click(go)
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/chat/channels/c1/tabs' && c.opts?.body?.wiki_space_id === 'sp2')).toBe(true))
  })

  it('‹ 와 [뒤로] 는 탭 목록으로', async () => {
    api.handler = (url) => (url === '/api/wiki/spaces' ? [] : {})
    renderIn(<ChatChannelTabsManage channelId="c1" channelName="개발" summary={summary()} />)
    fireEvent.click(screen.getByRole('button', { name: '바꾸기' }))
    fireEvent.click(await screen.findByRole('button', { name: '탭 관리로 돌아가기' }))
    expect(screen.getByRole('dialog', { name: '#개발 탭 관리' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '바꾸기' }))
    fireEvent.click(await screen.findByRole('button', { name: '뒤로' }))
    expect(screen.getByRole('dialog', { name: '#개발 탭 관리' })).toBeTruthy()
  })
})

describe('탭 관리 — 연결 해제(핸드오프 15-7)', () => {
  it('푸터 왼쪽 danger 글자 버튼 → 확인형 모달(sm) → [연결 해제] 해야 저장, [취소]면 그대로', async () => {
    api.handler = (url) => (url === '/api/wiki/spaces' ? [] : url === '/api/chat/channels/c1/tabs' ? summary({ wiki_space: null }) : {})
    renderIn(<><ChatChannelTabsManage channelId="c1" channelName="개발" summary={summary()} /><UiDialogHost /></>)
    fireEvent.click(screen.getByRole('button', { name: '바꾸기' }))
    const unlink = await screen.findByRole('button', { name: '연결 해제' })
    expect(unlink.className).toContain('text-danger')
    expect(unlink.className).toContain('mr-auto')
    const puts = () => api.calls.filter(c => c.url === '/api/chat/channels/c1/tabs' && c.opts?.method === 'PUT')
    // 취소 — 아무것도 안 함
    fireEvent.click(unlink)
    let dlg = await screen.findByRole('alertdialog', { name: '연결을 해제할까요?' })
    fireEvent.click(within(dlg).getByRole('button', { name: '취소' }))
    await waitFor(() => expect(screen.queryByText('연결을 해제할까요?')).toBeNull())
    expect(puts()).toHaveLength(0)
    // 확인 — wiki_space_id: null 저장
    fireEvent.click(screen.getByRole('button', { name: '연결 해제' }))
    dlg = await screen.findByRole('alertdialog', { name: '연결을 해제할까요?' })
    expect(dlg.textContent).toContain('스페이스와 페이지는 지워지지 않습니다')
    fireEvent.click(within(dlg).getByRole('button', { name: '연결 해제' }))
    await waitFor(() => expect(puts().some(c => c.opts?.body?.wiki_space_id === null)).toBe(true))
  })
})

describe('탭 관리 — 파일 폴더 연결(#tabFolder)', () => {
  it('행 = 고르기("이름" 연결), › = 들어가기(경로 줄 갱신), 연결 = folder_path 저장', async () => {
    const dirs: Record<string, any[]> = {
      my: [{ name: '개발팀', path: 'my/개발팀', is_dir: true, size: 0, modified_at: null, mime_type: null }],
      'my/개발팀': [
        { name: '공유', path: 'my/개발팀/공유', is_dir: true, size: 0, modified_at: null, mime_type: null },
        { name: '배포 산출물', path: 'my/개발팀/배포 산출물', is_dir: true, size: 0, modified_at: null, mime_type: null },
        { name: 'a.txt', path: 'my/개발팀/a.txt', is_dir: false, size: 1, modified_at: null, mime_type: 'text/plain' },
      ],
    }
    api.handler = (url, opts) => {
      if (url === '/api/files/list') { const p = opts.params.path; return { path: p, items: dirs[p] ?? [] } }
      if (url === '/api/chat/channels/c1/tabs' && opts.method === 'PUT') return summary()
      return {}
    }
    renderIn(<ChatChannelTabsManage channelId="c1" channelName="개발" summary={summary()} />)
    fireEvent.click(screen.getByRole('button', { name: '폴더 연결' }))
    expect(await screen.findByRole('dialog', { name: '파일 폴더 연결' })).toBeTruthy()
    // 내 파일 맨 위 = 연결할 대상 없음
    await screen.findByRole('option', { name: '개발팀' })
    expect((screen.getByRole('button', { name: '이 폴더 연결' }) as HTMLButtonElement).disabled).toBe(true)
    // › = 들어가기
    fireEvent.click(screen.getByRole('button', { name: '개발팀 열기' }))
    await screen.findByRole('option', { name: '공유' })
    const path = screen.getByRole('navigation', { name: '폴더 경로' })
    expect(within(path).getByText('개발팀').getAttribute('aria-current')).toBe('location')
    expect(within(path).getByRole('button', { name: '내 파일' })).toBeTruthy()
    // 파일은 행으로 안 나온다
    expect(screen.queryByRole('option', { name: 'a.txt' })).toBeNull()
    // 고른 게 없으면 지금 들어와 있는 폴더
    expect(screen.getByRole('button', { name: '"개발팀" 연결' })).toBeTruthy()
    // 행 = 고르기
    fireEvent.click(screen.getByRole('option', { name: '공유' }))
    expect(screen.getByRole('option', { name: '공유' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '"공유" 연결' }))
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/chat/channels/c1/tabs' && c.opts?.body?.folder_path === 'my/개발팀/공유')).toBe(true))
  })
})

describe('위키 탭 [+](#wikiNew)', () => {
  it('[+] = pressed + 제목 입력 + 안내(어디에 생기는지), Esc = 취소', async () => {
    api.handler = (url) => (url === '/api/wiki/spaces/sp1/pages' ? [] : {})
    renderIn(<ChatChannelWikiTab space={{ id: 'sp1', name: '개발 팀 스페이스' }} canManage />)
    const plus = screen.getByRole('button', { name: '이 채널에 새 페이지' })
    expect(plus.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(plus)
    expect(plus.getAttribute('aria-pressed')).toBe('true')
    const box = screen.getByRole('textbox', { name: '새 페이지 제목' })
    expect(screen.getByText(/개발 팀 스페이스 맨 아래에 생깁니다/)).toBeTruthy()
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: '새 페이지 제목' })).toBeNull()
    expect(plus.getAttribute('aria-pressed')).toBe('false')
  })

  it('Enter = 스페이스 최상위 맨 아래(sort_order 최대+1)에 만든다', async () => {
    api.handler = (url, opts) => {
      if (url === '/api/wiki/spaces/sp1/pages' && opts.method === 'POST') return { id: 'np' }
      if (url === '/api/wiki/spaces/sp1/pages') {
        return [
          { id: 'p1', title: '배포 체크리스트', parent_id: null, sort_order: 3, version: 1, updated_at: '2026-10-14T08:00:00Z' },
          { id: 'p2', title: '하위', parent_id: 'p1', sort_order: 9, version: 1, updated_at: '2026-10-13T08:00:00Z' },
        ]
      }
      return { id: 'p1', title: '배포 체크리스트', content: '' }
    }
    renderIn(<ChatChannelWikiTab space={{ id: 'sp1', name: '개발 팀 스페이스' }} canManage />)
    await screen.findAllByText('배포 체크리스트')
    fireEvent.click(screen.getByRole('button', { name: '이 채널에 새 페이지' }))
    const box = screen.getByRole('textbox', { name: '새 페이지 제목' })
    fireEvent.change(box, { target: { value: '릴리스 노트 10월' } })
    fireEvent.submit(box.closest('form')!)
    await waitFor(() => {
      const post = api.calls.find(c => c.url === '/api/wiki/spaces/sp1/pages' && c.opts?.method === 'POST')
      expect(post?.opts?.body).toMatchObject({ title: '릴리스 노트 10월', sort_order: 4 })
    })
  })
})

describe('모바일 파일 상세 — 정보 탭 활동 묶음(B3)', () => {
  const item = { name: '보고서.docx', path: 'my/보고서.docx', is_dir: false, size: 10, modified_at: '2026-10-14T09:00:00Z', mime_type: null } as any
  const acts = Array.from({ length: 7 }, (_, i) => ({
    id: `a${i}`, action: 'edit', user: { id: 'u2', name: `사람${i}` }, sub_path: null, detail: null, created_at: '2026-10-14T09:00:00Z',
  }))

  it('탭은 늘리지 않고 정보 탭 맨 아래 최근 5개 + 모두 보기 → 전체 화면 목록, 뒤로 = 정보', async () => {
    isMobileStore.setState({ isMobile: true })
    api.handler = (url) => {
      if (url === '/api/files/activity') return { items: acts }
      if (url === '/api/files/comments') return { items: [], can_comment: true, role: 'owner' }
      if (url === '/api/files/versions') return { versions: [] }
      return {}
    }
    renderIn(<FilesFileDetailPanel item={item} />)
    expect(screen.queryByRole('tab', { name: /활동/ })).toBeNull()
    const sec = await screen.findByRole('region', { name: '활동' })
    await waitFor(() => expect(within(sec).getAllByRole('listitem')).toHaveLength(5))
    fireEvent.click(within(sec).getByRole('button', { name: '모두 보기' }))
    const all = await screen.findByRole('complementary', { name: '활동' })
    expect(within(all).getAllByRole('listitem')).toHaveLength(7)
    expect(within(all).getByText('보고서.docx')).toBeTruthy()
    fireEvent.click(within(all).getAllByRole('button')[0])
    expect(await screen.findByRole('region', { name: '활동' })).toBeTruthy()
  })

  it('데스크톱은 정보 탭에 묶음이 없고 활동은 탭에서만 받는다', async () => {
    api.handler = (url) => (url === '/api/files/comments' ? { items: [], can_comment: true, role: 'owner' } : url === '/api/files/versions' ? { versions: [] } : {})
    renderIn(<FilesFileDetailPanel item={item} />)
    expect(screen.getByRole('tab', { name: /활동/ })).toBeTruthy()
    expect(screen.queryByRole('region', { name: '활동' })).toBeNull()
    expect(api.calls.some(c => c.url === '/api/files/activity')).toBe(false)
  })
})
