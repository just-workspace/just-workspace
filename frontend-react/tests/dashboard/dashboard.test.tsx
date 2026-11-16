// 홈 대시보드 — 카드 요청·행·빈 상태 보고, 오늘 브리핑 칩, AI 브리핑 상태, 판 조립(빈 카드 묶음·편집 저장).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
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
    if (!h) return {}
    return h(opts)
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { DashboardTasks } = await import('~/components/dashboard/DashboardTasks')
const { DashboardRecentMail } = await import('~/components/dashboard/DashboardRecentMail')
const { DashboardToday } = await import('~/components/dashboard/DashboardToday')
const { DashboardGitActivity } = await import('~/components/dashboard/DashboardGitActivity')
const { DashboardFocus } = await import('~/components/dashboard/DashboardFocus')
const { DashboardContinue, fileKind } = await import('~/components/dashboard/DashboardContinue')
const { DashboardStart, loadStart, startStore, visibleItems } = await import('~/components/dashboard/DashboardStart')
const { briefChips, issueText } = await import('~/components/dashboard/DashboardBriefing')
const { DashboardHome, dashPadding } = await import('~/components/dashboard/DashboardHome')
const { DashCtx } = await import('~/components/dashboard/DashCard')
const { authStore } = await import('~/composables/useAuth')
const { dashSummaryStore } = await import('~/composables/useDashSummary')
const { siteConfigStore } = await import('~/composables/useSiteConfig')
const { DashboardNetLab } = await import('~/components/dashboard/DashboardNetLab')
const { i18n } = await import('~/i18n')
const t = (k: string, a?: any) => i18n.t(k, a)

function renderIn(node: ReactNode) {
  const router = createMemoryRouter([{ path: '*', element: node }], { initialEntries: ['/'] })
  return render(<RouterProvider router={router} />)
}
/** 카드가 보고하는 상태를 수신하는 컨텍스트 */
function withCtx(node: ReactNode, report = vi.fn()) {
  const ctx = {
    editing: false, maxRows: 5, cols: 3, report, reportHeight: () => {}, spanOf: () => 1 as const, setSpan: () => {}, hide: vi.fn(),
    isLocked: () => false, step: () => {}, dragStart: () => {},
  }
  return { ui: <DashCtx.Provider value={ctx}>{node}</DashCtx.Provider>, report, ctx }
}
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const plus = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d) }

beforeEach(() => {
  api.calls.length = 0
  api.routes = {}
  authStore.setState({ user: { id: 'u1', username: 'qa', display_name: 'QA', is_admin: false } as any, loading: false })
  dashSummaryStore.setState({ summary: null, loading: false, error: false })
  siteConfigStore.setState({ netlabUrl: '' })
})

describe('내 작업', () => {
  it('끝나지 않은 최상위 작업을 마감 순(없는 것은 뒤)으로, 마감 표기는 지남 n일 · 오늘 · M/D', async () => {
    api.routes['/api/tasks/'] = () => ({ tasks: [
      { id: 'a', title: '마감없음', due_date: null, status: 'todo', parent_id: null },
      { id: 'b', title: '어제', due_date: plus(-1), status: 'todo', parent_id: null },
      { id: 'c', title: '완료됨', due_date: plus(0), status: 'done', parent_id: null },
      { id: 'd', title: '하위', due_date: plus(0), status: 'todo', parent_id: 'b' },
      { id: 'e', title: '오늘', due_date: plus(0), status: 'todo', parent_id: null },
    ] })
    const { ui } = withCtx(<DashboardTasks />)
    renderIn(ui)
    await screen.findByText('어제')
    const titles = screen.getAllByRole('listitem').map(li => li.querySelector('a')?.textContent)
    expect(titles).toEqual(['어제', '오늘', '마감없음'])
    expect(screen.getByText('지남 1일')).toBeTruthy()
    expect(api.calls[0]).toMatchObject({ url: '/api/tasks/', opts: { params: { sort_by: 'due_date', sort_dir: 'asc', limit: 50 } } })
    // 머리 개수 = 남은 작업 수
    expect(within(screen.getByRole('region', { name: '내 작업' })).getByText('3')).toBeTruthy()
  })

  it('[완료] 를 누르면 toggle 후 다시 불러오고, 비면 empty 를 보고한다', async () => {
    api.routes['/api/tasks/'] = () => ({ tasks: [{ id: 'x', title: '할 일', due_date: null, status: 'todo', parent_id: null }] })
    api.routes['/api/tasks/x/toggle'] = () => { api.routes['/api/tasks/'] = () => ({ tasks: [] }); return {} }
    const { ui, report } = withCtx(<DashboardTasks />)
    renderIn(ui)
    fireEvent.click(await screen.findByRole('button', { name: '할 일 완료' }))
    await waitFor(() => expect(api.calls.filter(c => c.url === '/api/tasks/').length).toBe(2))
    expect(api.calls.some(c => c.url === '/api/tasks/x/toggle' && c.opts?.method === 'POST')).toBe(true)
    await waitFor(() => expect(report).toHaveBeenLastCalledWith('tasks', 'empty', undefined))
  })
})

describe('최근 메일', () => {
  it('계정이 없으면 메일함을 부르지 않고 "메일 계정 없음" 으로 빈 카드 보고', async () => {
    api.routes['/api/mail/accounts'] = () => []
    const { ui, report } = withCtx(<DashboardRecentMail />)
    renderIn(ui)
    await waitFor(() => expect(report).toHaveBeenLastCalledWith('mail', 'empty', expect.objectContaining({ to: '/mail/accounts?add=1' })))
    expect(api.calls.map(c => c.url)).toEqual(['/api/mail/accounts'])
  })

  it('받은편지함 — 제목 · 보낸 사람, 링크는 /mail/{id}?mailbox={inbox}', async () => {
    api.routes['/api/mail/accounts'] = () => [{ email: 'a@x' }]
    api.routes['/api/mail/mailboxes'] = () => ({ mailboxes: [{ id: 'mb1', role: 'inbox' }] })
    api.routes['/api/mail/messages'] = () => ({ messages: [{ id: 'm 1', from_: [{ name: '홍길동', email: 'h@x' }], subject: '안녕', received_at: null, is_unread: true }] })
    renderIn(withCtx(<DashboardRecentMail />).ui)
    const link = await screen.findByRole('link', { name: /홍길동/ })
    expect(link.getAttribute('href')).toBe('/mail/m%201?mailbox=mb1')
    expect(link.textContent).toContain('안녕')
    expect(api.calls.map(c => c.url)).toEqual(['/api/mail/accounts', '/api/mail/mailboxes', '/api/mail/messages'])
  })
})

describe('시작하기', () => {
  it('닫혔으면 숨김, 끝내지 않은 2단계 인증은 뺀다', async () => {
    api.routes['/api/dashboard/checklist'] = () => ({ items: [{ id: 'upload_file', label: 'x', link: '/files', done: false }], done_count: 0, total: 1, completed: false, dismissed: true })
    await loadStart()
    expect(startStore.getState().hidden).toBe(true)
    const d = { items: [
      { id: 'profile_photo', label: 'p', link: '', done: true },
      { id: 'upload_file', label: 'f', link: '/files', done: false },
      { id: 'enable_2fa', label: '2fa', link: '', done: false },
    ], done_count: 1, total: 3, completed: false, dismissed: false }
    expect(visibleItems(d).map(i => i.id)).toEqual(['profile_photo', 'upload_file'])
    api.routes['/api/dashboard/checklist'] = () => d
    await loadStart()
    expect(startStore.getState().hidden).toBe(false)
  })
})

describe('시작하기 전폭 카드', () => {
  const d = { items: ['profile_photo', 'first_message', 'invite_colleague', 'upload_file', 'install_app', 'enable_push'].map((id, i) => ({ id, label: id, link: '', done: i === 0 })), done_count: 1, total: 6, completed: false, dismissed: false }
  it('항목은 판 열 수에 맞춘 격자(3열 이상 3열), 행 56 — ✕ 는 배치 숨기기', () => {
    startStore.setState({ data: d, hidden: false, loaded: true })
    const { ui, ctx } = withCtx(<DashboardStart />)
    renderIn(ui)
    const card = screen.getByRole('region', { name: '시작하기' })
    const grid = card.querySelector('ul')!
    expect(grid.style.gridTemplateColumns).toBe('repeat(3,minmax(0,1fr))')
    const rows = within(card).getAllByRole('listitem')
    expect(rows).toHaveLength(6)
    expect(rows.every(r => r.className.includes('h-14'))).toBe(true)
    fireEvent.click(within(card).getByRole('button', { name: '시작하기 숨기기' }))
    expect(ctx.hide).toHaveBeenCalledWith('start')
    // 서버 닫음(dismiss)은 호출하지 않음 — 편집 패널에서 다시 볼 수 있도록 유지
    expect(api.calls.some(c => c.url === '/api/dashboard/checklist/dismiss')).toBe(false)
  })
})

describe('오늘', () => {
  it('취소된 일정은 빼고 종일 먼저, 개수를 onCount 로 알린다', async () => {
    const s = new Date(); s.setHours(9, 0, 0, 0)
    const e = new Date(s); e.setHours(10)
    api.routes['/api/calendar/events'] = () => ({ events: [
      { id: '1', title: '회의', start: s.toISOString(), end: e.toISOString(), all_day: false },
      { id: '2', title: '종일', start: s.toISOString(), end: e.toISOString(), all_day: true },
      { id: '3', title: '취소', start: s.toISOString(), end: e.toISOString(), all_day: false, status: 'cancelled' },
    ] })
    const onCount = vi.fn()
    renderIn(<DashboardToday onCount={onCount} />)
    await screen.findByText('회의')
    expect(onCount).toHaveBeenCalledWith(2)
    expect(screen.getAllByRole('listitem').map(li => li.querySelector('a span span')?.textContent)).toEqual(['종일', '회의'])
    expect(screen.queryByText('취소')).toBeNull()
  })
})

describe('Git 활동', () => {
  it('Gitea 계정이 없으면 [전체] 하나로 다시 불러 보여 준다', async () => {
    api.routes['/api/git/activity'] = (opts) => opts?.params.scope === 'all'
      ? ({ connected: false, scope: 'all', items: [
        { kind: 'issue_open', is_pull: false, number: 91, title: '탭바 배지', repo_full_name: 'o/r', repo_name: 'r', author: '서연', at: '2020-01-01T00:00:00Z', count: null, authors: [], branch: '' },
      ] })
      : ({ connected: false, scope: 'mine', items: [] })
    renderIn(withCtx(<DashboardGitActivity />).ui)
    const row = await screen.findByRole('link', { name: /이슈 #91 탭바 배지/ })
    expect(row.getAttribute('href')).toBe('/code/o/r/issues/91')
    expect(row.textContent).toContain('열림 · 서연')
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(x => x.textContent)).toEqual(['전체'])
  })
  it('계정이 있으면 내 것 → 전체 전환', async () => {
    api.routes['/api/git/activity'] = (opts) => opts?.params.scope === 'all'
      ? ({ connected: true, scope: 'all', items: [
        { kind: 'commits', is_pull: false, number: null, title: '', repo_full_name: 'o/r', repo_name: 'r', author: '도윤', at: '2020-01-01T00:00:00Z', count: 3, authors: ['도윤', '준호'], branch: 'main' },
      ] })
      : ({ connected: true, scope: 'mine', items: [
        { kind: 'review', is_pull: true, number: 482, title: '멘션 분리', repo_full_name: 'o/r', repo_name: 'r', author: '서연', at: '2020-01-01T00:00:00Z', count: null, authors: [], branch: '' },
      ] })
    renderIn(withCtx(<DashboardGitActivity />).ui)
    const row = await screen.findByRole('link', { name: /PR #482/ })
    expect(row.getAttribute('href')).toBe('/code/o/r/pulls/482')
    fireEvent.click(screen.getByRole('tab', { name: '전체' }))
    const c = await screen.findByRole('link', { name: /main 에 3커밋/ })
    expect(c.getAttribute('href')).toBe('/code/o/r/commits')
    expect(c.textContent).toContain('r · 도윤 외 1명')
  })
})

describe('이어서 하기', () => {
  it('세 탭을 받고, 행은 종류 · 이유, 탭을 바꾸면 그 목록', async () => {
    api.routes['/api/dashboard/continue'] = (opts) => ({ items: {
      recent: [{ key: 'file:my/a.docx', kind: 'file', name: '로드맵.docx', to: '/files?path=my', reason: 'edited', at: '2020-01-01T00:00:00Z' },
        { key: 'wiki:1', kind: 'wiki', name: '런북', to: '/wiki?space=s&page=1', reason: 'edited_by', actor: '박준호', at: null }],
      favorites: [],
      shared: [{ key: 'shared:9', kind: 'file', name: '지표.jwsheet', to: '/files?view=shared-with-me', reason: 'shared_by', actor: '최수아', at: null }],
    }[opts?.params.tab as string] })
    renderIn(withCtx(<DashboardContinue />).ui)
    expect((await screen.findByRole('link', { name: /로드맵.docx/ })).textContent).toContain('파일 · 1/1 편집')
    expect(screen.getByRole('link', { name: /런북/ }).textContent).toContain('위키 · 박준호님이 수정')
    fireEvent.click(screen.getByRole('tab', { name: '공유받은 것' }))
    expect((await screen.findByRole('link', { name: /지표/ })).textContent).toContain('시트 · 최수아님이 공유')
    expect(api.calls.filter(c => c.url === '/api/dashboard/continue').map(c => c.opts?.params.tab)).toEqual(['recent', 'favorites', 'shared'])
  })
  it('파일 종류', () => {
    expect(fileKind('a.jwdoc')).toMatchObject({ kind: 'doc', label: 'a', icon: 'file-text' })
    expect(fileKind('b.xlsx')).toMatchObject({ kind: 'file', icon: 'file-sheet', cls: 'text-success' })
    expect(fileKind('c', true).kind).toBe('folder')
  })
})

describe('오늘 브리핑 칩', () => {
  const base = { unread_notifications: 0, mail_unread: 0, mentions_unread: 0, tasks_due_today: 0, tasks_overdue: 0, today_events: 0, next_meeting: null, admin: null }
  const now = Date.parse('2026-10-18T04:50:00Z')
  it('0 인 칩은 숨기고, 전부 없으면 빈 목록', () => {
    expect(briefChips(base, now, t, false)).toEqual([])
    expect(briefChips(null, now, t, false)).toEqual([])
  })
  it('메일 · 나를 부른 것 · 오늘 마감(지남) · 다음 회의(30분 전부터 [참여]) · 관리자 서비스 이상', () => {
    const s = {
      ...base, mail_unread: 12, mentions_unread: 9, tasks_due_today: 3, tasks_overdue: 1,
      next_meeting: { id: 'e', title: '디자인 리뷰', start: '2026-10-18T05:00:00Z', end: '2026-10-18T06:00:00Z', join_url: '/meetings/room/x' },
      admin: { services: { ok: 23, total: 24, issues: [{ name: '메일 발송', status: 'slow' as const, response_ms: 1800 }] }, pending_users: 2, storage: null },
    }
    const chips = briefChips(s, now, t, true)
    expect(chips.map(c => c.key)).toEqual(['mail', 'mention', 'due', 'meeting', 'service'])
    expect(chips[2]).toMatchObject({ value: '3', sub: '지남 1' })
    expect(chips[3]).toMatchObject({ label: '디자인 리뷰', tone: 'primary', join: '/meetings/room/x' })
    expect(chips[3].value).toContain('10분 후')
    // 회의까지 1시간 넘게 남았으면 [참여] 없이 일반 칩
    const far = briefChips(s, Date.parse('2026-10-18T03:00:00Z'), t, false)
    expect(far.find(c => c.key === 'meeting')).toMatchObject({ tone: undefined, join: null })
    // 관리자가 아니면 서비스 칩 없음
    expect(far.some(c => c.key === 'service')).toBe(false)
    expect(issueText(s.admin.services.issues[0], t)).toBe('메일 발송 지연 · 1.8s')
  })
  it('오늘 마감 0 · 지난 것만 있으면 "지남 n" 하나(danger), 둘 다면 오늘 마감 n · 지남 n', () => {
    const only = briefChips({ ...base, tasks_overdue: 2 }, now, t, false)
    expect(only).toHaveLength(1)
    expect(only[0]).toMatchObject({ key: 'due', icon: 'check-square', label: '지남', value: '2', danger: true })
    expect(only[0].sub).toBeUndefined()
    const both = briefChips({ ...base, tasks_due_today: 1, tasks_overdue: 2 }, now, t, false)
    expect(both[0]).toMatchObject({ label: '오늘 마감', value: '1', sub: '지남 2' })
    expect(both[0].danger).toBeFalsy()
  })
})

describe('오늘의 포커스(AI 브리핑)', () => {
  const st = (o: Record<string, unknown> = {}) => ({
    available: true, reason: null, external: false, enabled: false, status: 'off', items: [], generated_at: null,
    regen_left: 3, regen_max: 3, feedback: null, error: null, prep: null, ...o,
  })
  it('꺼짐 → [켜기] 는 enable 후 오늘 첫 브리핑을 만든다', async () => {
    api.routes['/api/dashboard/briefing'] = () => st()
    api.routes['/api/dashboard/briefing/enable'] = () => st({ enabled: true, status: 'none' })
    api.routes['/api/dashboard/briefing/generate'] = () => st({
      enabled: true, status: 'ready', generated_at: '2026-10-18T00:00:00Z',
      items: [{ text: 'PR 리뷰가 필요합니다.', sources: [{ label: '#개발', to: '/chat?channel=c1' }] }],
    })
    renderIn(withCtx(<DashboardFocus />).ui)
    fireEvent.click(await screen.findByRole('button', { name: '켜기' }))
    expect(await screen.findByText(/PR 리뷰가 필요합니다/)).toBeTruthy()
    expect(screen.getByRole('link', { name: '#개발' }).getAttribute('href')).toBe('/chat?channel=c1')
    const gen = api.calls.find(c => c.url === '/api/dashboard/briefing/generate')!
    expect(gen.opts).toMatchObject({ method: 'POST', body: { regenerate: false } })
    expect(gen.opts?.params.day_start).toBeTruthy()
  })
  it('꺼짐은 empty 로 보고(주 줄 높이에 맞추지 않는다)', async () => {
    api.routes['/api/dashboard/briefing'] = () => st()
    const { ui, report } = withCtx(<DashboardFocus />)
    renderIn(ui)
    await screen.findByRole('button', { name: '켜기' })
    await waitFor(() => expect(report).toHaveBeenLastCalledWith('ai', 'empty', undefined))
  })
  it('회의 준비: 관련 채팅(근거)이 없으면 요약 줄 없이 "관련 채팅 n · 메일 n" 만', async () => {
    const prep = (chat: number) => ({
      event: { id: 'e', title: '리뷰', start: new Date(Date.now() + 5 * 60_000).toISOString(), end: new Date(Date.now() + 65 * 60_000).toISOString(), join_url: null },
      last_line: '지난번 결정 확인', chat: { count: chat, channel_id: null, channel_name: null }, mail: { count: 1 },
    })
    api.routes['/api/dashboard/briefing'] = () => st({ enabled: true, status: 'ready', generated_at: '2026-10-18T00:00:00Z', prep: prep(0) })
    const r = renderIn(withCtx(<DashboardFocus />).ui)
    expect(await screen.findByText(/관련 채팅/)).toBeTruthy()
    expect(screen.queryByText(/지난번 결정 확인/)).toBeNull()
    r.unmount()
    api.routes['/api/dashboard/briefing'] = () => st({ enabled: true, status: 'ready', generated_at: '2026-10-18T00:00:00Z', prep: prep(2) })
    renderIn(withCtx(<DashboardFocus />).ui)
    expect(await screen.findByText(/지난번 결정 확인/)).toBeTruthy()
  })
  it('[숨기기] 는 카드를 숨긴다(배치)', async () => {
    api.routes['/api/dashboard/briefing'] = () => st()
    const { ui, ctx } = withCtx(<DashboardFocus />)
    renderIn(ui)
    fireEvent.click(await screen.findByRole('button', { name: '숨기기' }))
    expect(ctx.hide).toHaveBeenCalledWith('ai')
  })
  it('공급자가 없으면 안내, 실패면 danger 한 줄 + 다시 시도', async () => {
    api.routes['/api/dashboard/briefing'] = () => st({ available: false, reason: 'not_configured' })
    const r = renderIn(withCtx(<DashboardFocus />).ui)
    expect(await screen.findByText(/AI 공급자가 아직 설정되지 않아/)).toBeTruthy()
    r.unmount()
    api.routes['/api/dashboard/briefing'] = () => st({ enabled: true, status: 'failed', error: 'AI 응답을 읽지 못했습니다' })
    renderIn(withCtx(<DashboardFocus />).ui)
    expect(await screen.findByText('AI 응답을 읽지 못했습니다')).toBeTruthy()
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy()
  })
})

describe('판 조립', () => {
  it('신규 사용자: 시작하기는 판(그리드) 밖 전폭, 빈 "오늘" 은 [일정 만들기] 하나', async () => {
    api.routes['/api/me/prefs'] = () => ({ prefs: {} })
    api.routes['/api/dashboard/summary'] = () => ({ unread_notifications: 0, mail_unread: 0, mentions_unread: 0, tasks_due_today: 0, tasks_overdue: 0, today_events: 0, next_meeting: null, admin: null })
    api.routes['/api/dashboard/checklist'] = () => ({ items: [{ id: 'upload_file', label: 'f', link: '/files', done: false }], done_count: 0, total: 1, completed: false, dismissed: false })
    api.routes['/api/notifications/'] = () => ({ notifications: [] })
    api.routes['/api/calendar/events'] = () => ({ events: [] })
    api.routes['/api/dashboard/briefing'] = () => ({ available: true, reason: null, enabled: false, status: 'off', items: [], regen_left: 3, regen_max: 3, prep: null })
    const { container } = renderIn(<DashboardHome />)
    const start = await screen.findByRole('region', { name: '시작하기' })
    const grid = container.querySelector('[data-cols]')!
    expect(grid.contains(start)).toBe(false)
    const today = await screen.findByRole('region', { name: '오늘' })
    expect(await within(today).findByRole('button', { name: '일정 만들기' })).toBeTruthy()
  })

  it('카드 판 오른쪽 여백이 지워지지 않는다(축약형 padding + paddingRight:undefined 회귀)', async () => {
    api.routes['/api/me/prefs'] = () => ({ prefs: {} })
    api.routes['/api/dashboard/summary'] = () => ({ unread_notifications: 0, mail_unread: 0, mentions_unread: 0, tasks_due_today: 0, tasks_overdue: 0, today_events: 0, next_meeting: null, admin: null })
    api.routes['/api/dashboard/checklist'] = () => ({ items: [], done_count: 0, total: 0, completed: true, dismissed: true })
    api.routes['/api/notifications/'] = () => ({ notifications: [] })
    api.routes['/api/calendar/events'] = () => ({ events: [] })
    api.routes['/api/dashboard/briefing'] = () => ({ available: false, reason: 'module_off', enabled: false, status: 'off', items: [], regen_left: 0, regen_max: 3, prep: null })
    const { container } = renderIn(<DashboardHome />)
    await screen.findByRole('region', { name: '오늘' })
    const scroller = container.querySelector('[data-cols]')!.closest('.overflow-auto') as HTMLElement
    expect(scroller.style.paddingRight).toBe('28px')
    expect(scroller.style.paddingLeft).toBe('28px')
    expect(dashPadding(true, false)).toBe('16px')
    expect(dashPadding(false, true)).toBe('24px 348px 24px 28px')
  })

  it('빈 보조 카드는 "비어 있는 카드" 묶음으로, 주 줄 카드는 제자리 빈 상태', async () => {
    api.routes['/api/me/prefs'] = () => ({ prefs: {} })
    api.routes['/api/dashboard/summary'] = () => ({ unread_notifications: 0, mail_unread: null, mentions_unread: 0, tasks_due_today: 0, tasks_overdue: 0, today_events: 0, next_meeting: null, admin: null })
    api.routes['/api/dashboard/checklist'] = () => ({ items: [], done_count: 0, total: 0, completed: true, dismissed: true })
    api.routes['/api/notifications/'] = () => ({ notifications: [] })
    api.routes['/api/tasks/'] = () => ({ tasks: [] })
    api.routes['/api/calendar/events'] = () => ({ events: [] })
    api.routes['/api/dashboard/briefing'] = () => ({ available: false, reason: 'module_off', enabled: false, status: 'off', items: [], regen_left: 0, regen_max: 3, prep: null })
    renderIn(<DashboardHome />)
    expect(await screen.findByText('오늘은 처리할 것이 없습니다.')).toBeTruthy()
    const box = await screen.findByRole('region', { name: '비어 있는 카드' })
    await waitFor(() => expect(within(box).getByText('내 작업')).toBeTruthy())
    expect(within(box).queryByText('나에게 온 것')).toBeNull()
    expect(screen.getByRole('region', { name: '나에게 온 것' })).toBeTruthy()
    expect(screen.getByText('새로 온 것이 없습니다')).toBeTruthy()
  })

  it('편집 중엔 빈 카드도 판에 그린다(묶음 대신 제자리) — 카드 안 크기·숨기기를 쓸 수 있게', async () => {
    api.routes['/api/me/prefs'] = () => ({ prefs: {} })
    api.routes['/api/dashboard/summary'] = () => ({ unread_notifications: 0, mail_unread: null, mentions_unread: 0, tasks_due_today: 0, tasks_overdue: 0, today_events: 0, next_meeting: null, admin: null })
    api.routes['/api/dashboard/checklist'] = () => ({ items: [], done_count: 0, total: 0, completed: true, dismissed: true })
    api.routes['/api/notifications/'] = () => ({ notifications: [] })
    api.routes['/api/tasks/'] = () => ({ tasks: [] })
    api.routes['/api/calendar/events'] = () => ({ events: [] })
    api.routes['/api/dashboard/briefing'] = () => ({ available: false, reason: 'module_off', enabled: false, status: 'off', items: [], regen_left: 0, regen_max: 3, prep: null })
    const { container } = renderIn(<DashboardHome />)
    await screen.findByRole('region', { name: '비어 있는 카드' })
    fireEvent.click((await screen.findAllByRole('button', { name: '대시보드 편집' }))[0])
    await waitFor(() => expect(screen.queryByRole('region', { name: '비어 있는 카드' })).toBeNull())
    const hidden = Array.from(container.querySelectorAll('[data-cols] > *')).filter(el => (el as HTMLElement).style.display === 'none')
    expect(hidden).toHaveLength(0)
  })

  it('편집: 카드 숨기기는 /api/me/prefs dash.layout 에 바로 저장', async () => {
    api.routes['/api/me/prefs'] = (o) => (o?.method === 'PATCH' ? { prefs: {} } : { prefs: {} })
    api.routes['/api/dashboard/summary'] = () => null
    api.routes['/api/dashboard/checklist'] = () => ({ items: [], done_count: 0, total: 0, completed: true, dismissed: true })
    api.routes['/api/notifications/'] = () => ({ notifications: [] })
    api.routes['/api/dashboard/briefing'] = () => ({ available: true, reason: null, enabled: false, status: 'off', items: [], regen_left: 3, regen_max: 3, prep: null })
    renderIn(<DashboardHome />)
    fireEvent.click((await screen.findAllByRole('button', { name: '대시보드 편집' }))[0])
    const panel = await screen.findByRole('complementary', { name: '카드' })
    fireEvent.click(within(panel).getByRole('button', { name: '오늘의 포커스 숨기기' }))
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/me/prefs' && c.opts?.method === 'PATCH')).toBe(true))
    const patch = api.calls.find(c => c.url === '/api/me/prefs' && c.opts?.method === 'PATCH')!
    expect(patch.opts?.body['dash.layout'].hidden).toContain('ai')
    expect(patch.opts?.body['dash.layout'].order[0]).toBe('inbox')
    // 공지는 기본적으로 관리자 고정 — 패널에서 숨김 불가
    const lockedRow = within(panel).queryByRole('button', { name: '공지 숨기기' })
    if (lockedRow) expect((lockedRow as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('네트워크 랩 카드', () => {
  it('제목 · 호스트(mono) · 설명 · [열기](새 탭) · "새 탭에서 열립니다" — 열기 하나뿐, ready 보고', () => {
    const { ui, report } = withCtx(<DashboardNetLab url="https://lab.example.com" />)
    renderIn(ui)
    const card = screen.getByRole('region', { name: '네트워크 랩' })
    expect(within(card).getByText('lab.example.com').className).toContain('font-mono')
    expect(within(card).getByText('라우터·스위치·방화벽을 캔버스에 놓고 이어서 켜고, 콘솔로 들어갑니다.')).toBeTruthy()
    const open = within(card).getByRole('link', { name: '열기' })
    expect(open.getAttribute('href')).toBe('https://lab.example.com')
    expect(open.getAttribute('target')).toBe('_blank')
    expect(open.getAttribute('rel')).toContain('noopener')
    expect(open.querySelector('[data-slot="icon-right"]')).toBeTruthy()
    expect(within(card).getByText('새 탭에서 열립니다')).toBeTruthy()
    expect(within(card).getAllByRole('link')).toHaveLength(1)
    expect(within(card).queryAllByRole('button')).toHaveLength(0)
    expect(report).toHaveBeenCalledWith('lab', 'ready', undefined)
  })

  function homeRoutes() {
    api.routes['/api/me/prefs'] = () => ({ prefs: {} })
    api.routes['/api/dashboard/summary'] = () => null
    api.routes['/api/dashboard/checklist'] = () => ({ items: [], done_count: 0, total: 0, completed: true, dismissed: true })
    api.routes['/api/notifications/'] = () => ({ notifications: [] })
    api.routes['/api/dashboard/briefing'] = () => ({ available: false, reason: 'module_off', enabled: false, status: 'off', items: [], regen_left: 0, regen_max: 3, prep: null })
  }

  it('NETLAB 주소가 없으면 판·편집 패널 어디에도 없다', async () => {
    homeRoutes()
    renderIn(<DashboardHome />)
    await screen.findByRole('region', { name: '나에게 온 것' })
    expect(screen.queryByRole('region', { name: '네트워크 랩' })).toBeNull()
    fireEvent.click((await screen.findAllByRole('button', { name: '대시보드 편집' }))[0])
    const panel = await screen.findByRole('complementary', { name: '카드' })
    expect(within(panel).queryByText('네트워크 랩')).toBeNull()
  })

  it('주소가 있으면 기본으로 보이고(판 안) 다른 카드처럼 편집 패널에서 숨길 수 있다', async () => {
    homeRoutes()
    siteConfigStore.setState({ netlabUrl: 'https://lab.example.com/' })
    const { container } = renderIn(<DashboardHome />)
    const card = await screen.findByRole('region', { name: '네트워크 랩' })
    expect(container.querySelector('[data-cols]')!.contains(card)).toBe(true)
    expect(within(card).getByRole('link', { name: '열기' }).getAttribute('href')).toBe('https://lab.example.com')
    fireEvent.click((await screen.findAllByRole('button', { name: '대시보드 편집' }))[0])
    const panel = await screen.findByRole('complementary', { name: '카드' })
    fireEvent.click(within(panel).getByRole('button', { name: '네트워크 랩 숨기기' }))
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/me/prefs' && c.opts?.method === 'PATCH')).toBe(true))
    const patch = api.calls.find(c => c.url === '/api/me/prefs' && c.opts?.method === 'PATCH')!
    expect(patch.opts?.body['dash.layout'].hidden).toContain('lab')
  })
})
