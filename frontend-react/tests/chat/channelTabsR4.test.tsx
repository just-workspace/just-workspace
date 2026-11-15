// 채널 탭 R4(12 답 A6 · 시안 R12Channel) — 탭 줄 순서·끄기·모듈, 탭 관리 저장 본문, 작업 칩·빠른 입력, 회의 지난 묶음
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { ReactNode } from 'react'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts?: Record<string, any> }[],
  routes: {} as Record<string, (opts?: Record<string, any>) => unknown>,
}))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: Record<string, any>) => {
    api.calls.push({ url, opts })
    const h = api.routes[url]
    return h ? h(opts) : {}
  }
  return { ...real, $fetch: Object.assign(fake, { raw: fake, native: fetch, create: () => fake }) }
})

const { ChatChannelTabs, visibleChannelTabs } = await import('~/components/chat/ChannelTabs')
const { ChatChannelTabsManage } = await import('~/components/chat/ChannelTabsManage')
const { ChatChannelTasksTab } = await import('~/components/chat/ChannelTasksTab')
const { ChatChannelMeetingsTab } = await import('~/components/chat/ChannelMeetingsTab')
const { platformStore } = await import('~/composables/usePlatform')
const { chatStore } = await import('~/composables/useChat')
const { authStore } = await import('~/composables/useAuth')

function renderIn(node: ReactNode) {
  const router = createMemoryRouter([{ path: '*', element: node }], { initialEntries: ['/chat'] })
  return render(<RouterProvider router={router} />)
}
const summary = (p: Record<string, any> = {}) => ({
  files_count: 24, folder: null, wiki: null, wiki_space: { id: 'sp', name: '개발 팀 스페이스', pages: 6 },
  meetings_upcoming: 1, tasks_open: 9, can_manage: true,
  layout: [{ key: 'files', visible: true }, { key: 'wiki', visible: true }, { key: 'meetings', visible: true }, { key: 'tasks', visible: true }],
  ...p,
}) as any

beforeEach(() => {
  api.calls.length = 0
  api.routes = {}
  // 탭이 기대는 모듈이 모두 켜진 설치(목록에 없는 모듈은 꺼진 것)
  platformStore.setState({ modules: [{ id: 'files', enabled: true }, { id: 'wiki', enabled: true }, { id: 'meetings', enabled: true }, { id: 'tasks', enabled: true }] as any, loaded: true })
  authStore.setState({ user: { id: 'u1', username: 'kim', display_name: '김서연', is_admin: false } as any, loading: false })
  chatStore.setState({
    callStates: {},
    members: [
      { user_id: 'u1', username: 'kim', display_name: '김서연', avatar_url: null, role: 'owner', is_online: true },
      { user_id: 'u2', username: 'doyun', display_name: '이도윤', avatar_url: null, role: 'member', is_online: true },
    ],
  } as any)
})

describe('visibleChannelTabs', () => {
  it('저장 순서를 따르고, 끈 탭 · 꺼진 모듈 · 스페이스 없는 위키는 뺀다', () => {
    const s = summary({ layout: [{ key: 'tasks', visible: true }, { key: 'files', visible: false }, { key: 'wiki', visible: true }, { key: 'meetings', visible: true }] })
    expect(visibleChannelTabs(s, () => true)).toEqual(['tasks', 'wiki', 'meetings'])
    expect(visibleChannelTabs(s, (id) => id !== 'meetings')).toEqual(['tasks', 'wiki'])
    expect(visibleChannelTabs({ ...s, wiki_space: null }, () => true)).toEqual(['tasks', 'meetings'])
    // 예전 서버(layout 없음)는 기본 순서
    expect(visibleChannelTabs(summary({ layout: undefined }), () => true)).toEqual(['files', 'wiki', 'meetings', 'tasks'])
  })
})

describe('ChatChannelTabs', () => {
  it('UiTabs + 숫자, 톱니는 관리 권한이 있을 때만', () => {
    const onManage = vi.fn()
    const { unmount } = renderIn(<ChatChannelTabs summary={summary()} modelValue="messages" onManage={onManage} />)
    const tabs = screen.getAllByRole('tab').map(x => x.textContent)
    expect(tabs).toEqual(['메시지', '파일24', '위키6', '회의1', '작업9'])
    fireEvent.click(screen.getByRole('button', { name: '탭 관리' }))
    expect(onManage).toHaveBeenCalled()
    unmount()
    renderIn(<ChatChannelTabs summary={summary({ can_manage: false })} modelValue="messages" />)
    expect(screen.queryByRole('button', { name: '탭 관리' })).toBeNull()
  })
})

describe('ChatChannelTabsManage', () => {
  it('끄고 저장하면 layout(order·hidden)을 보내고, 꺼진 모듈 행은 스위치가 잠긴다', async () => {
    platformStore.setState({ modules: [{ id: 'files', enabled: true }, { id: 'wiki', enabled: true }, { id: 'tasks', enabled: true }, { id: 'meetings', name: '회의', enabled: false }] as any, loaded: true })
    api.routes['/api/chat/channels/c1/tabs'] = (opts) => ({ ...summary(), layout: [] , _body: opts?.body })
    const onSaved = vi.fn()
    renderIn(<ChatChannelTabsManage channelId="c1" channelName="개발" summary={summary()} onSaved={onSaved} />)
    expect(screen.getByText('#개발 탭 관리')).toBeTruthy()
    expect(screen.getByText('회의 모듈 꺼짐 — 관리자에게 요청')).toBeTruthy()
    const meetSwitch = screen.getByRole('switch', { name: '회의 탭 보이기' })
    expect(meetSwitch.hasAttribute('disabled') || meetSwitch.getAttribute('aria-disabled') === 'true').toBe(true)
    fireEvent.click(screen.getByRole('switch', { name: '작업 탭 보이기' }))
    // 손잡이 ↑ 로 위키를 파일 위로
    fireEvent.keyDown(screen.getByRole('button', { name: '위키 탭 옮기기' }), { key: 'ArrowUp' })
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const put = api.calls.find(c => c.opts?.method === 'PUT')!
    expect(put.opts!.body).toEqual({ layout: { order: ['wiki', 'files', 'meetings', 'tasks'], hidden: ['tasks'] } })
  })
})

describe('ChatChannelTasksTab', () => {
  it('칩을 바꾸면 filter 로 다시 부르고, 빠른 입력 @담당은 채널 멤버에서 찾는다', async () => {
    api.routes['/api/chat/channels/c1/tasks'] = (opts) => ({
      items: opts?.params.filter === 'done' ? [] : [{ id: 't1', title: 'CI 캐시 키 정리', status: 'todo', priority: 'high', due_date: null, assignee_name: '이도윤', owner_name: '김서연', can_open: true }],
      counts: { open: 9, mine: 1, done: 31 },
    })
    api.routes['/api/tasks/'] = () => ({ id: 'new' })
    renderIn(<ChatChannelTasksTab channelId="c1" />)
    await screen.findByText('CI 캐시 키 정리')
    expect(screen.getByText('31')).toBeTruthy()
    fireEvent.click(screen.getByText('완료'))
    await waitFor(() => expect(api.calls.some(c => c.opts?.params?.filter === 'done')).toBe(true))

    const input = screen.getByRole('textbox', { name: '새 작업' })
    fireEvent.change(input, { target: { value: '배포 공지 !높음 @doyun' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/tasks/')).toBe(true))
    const post = api.calls.find(c => c.url === '/api/tasks/')!
    expect(post.opts!.body).toMatchObject({ title: '배포 공지', channel_id: 'c1', priority: 'high', assignee_id: 'u2' })
  })
})

describe('ChatChannelMeetingsTab', () => {
  it('예정·지난 회의 묶음, 진행 중 채널 통화 띠', async () => {
    chatStore.setState({ callStates: { c1: { count: 3, names: ['김서연', '이도윤', '박준호'], since: Math.floor(Date.now() / 1000) - 60 } } } as any)
    api.routes['/api/chat/channels/c1/meetings'] = () => ({
      items: [{ id: 'm1', title: '스프린트 회고', status: 'scheduled', scheduled_at: '2026-10-16T05:00:00Z', duration_minutes: 60, host_name: '이도윤', is_host: false, join_path: '/meetings/join/x' }],
      past: [{ id: 'm2', title: 'CI 캐시 장애 회고', status: 'ended', scheduled_at: null, started_at: '2026-10-13T02:00:00Z', duration_minutes: null, actual_minutes: 42, host_name: '박준호', join_path: '/meetings/join/y' }],
    })
    renderIn(<ChatChannelMeetingsTab channelId="c1" />)
    await screen.findByText('스프린트 회고')
    expect(screen.getByText('예정')).toBeTruthy()
    expect(screen.getByText('지난 회의')).toBeTruthy()
    expect(screen.getByText('42분')).toBeTruthy()
    expect(screen.getByText('김서연·이도윤·박준호 참여 중')).toBeTruthy()
    expect(screen.getByText(/채널 통화 진행 중/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '이 채널로 회의 예약' })).toBeTruthy()
  })
})
