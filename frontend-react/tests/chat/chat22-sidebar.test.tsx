// 채팅22 사이드바(SIDEBAR 담당) — 구역 계산 · 끌기 patch 계산 · 접힘 보임 규칙 · 음성 접속자 4줄 접기 · 음소거 툴팁 문구 · 채널/카테고리 메뉴
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { renderInRouter } from '../ui/helpers'

const api = vi.hoisted(() => ({ calls: [] as Array<{ url: string; opts?: any }>, handler: (_u: string, _o?: any): any => ({}) }))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: any) => { api.calls.push({ url, opts }); return api.handler(url, opts) }
  return { ...real, $fetch: Object.assign(fake, { raw: fake, native: fetch, create: () => fake }) }
})

const { i18n } = await import('~/i18n')
const { authStore } = await import('~/composables/useAuth')
const { chatStore } = await import('~/composables/useChat')
const { chatLayoutStore, buildSections } = await import('~/composables/useChatLayout')
const { chatRolesStore, PERM } = await import('~/composables/useChatRoles')
const { isMobileStore } = await import('~/composables/useIsMobile')
const { voiceStore } = await import('~/composables/useVoice')
const { userPrefsStore } = await import('~/composables/useUserPrefs')
const dnd = await import('~/utils/chatSidebarDnd')
const { ChatSidebar } = await import('~/components/chat/ChatSidebar')
type Channel = import('~/composables/useChat').Channel
type ChatCategory = import('~/composables/useChatLayout').ChatCategory

const t = (k: string, a?: Record<string, unknown>) => i18n.t(k, a)
const me = { id: 'u1', username: 'kim', display_name: '김서연', email: '', is_admin: false } as any
const ch = (p: Partial<Channel>): Channel => ({
  id: 'c1', name: 'general', type: 'public', description: null, created_by: 'u1', is_archived: false,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', member_count: 2, unread_count: 0, ...p,
})
const cats: ChatCategory[] = [
  { id: 'k1', name: '디자인 팀', position: 0 },
  { id: 'k2', name: '음성', position: 1 },
  { id: 'arch', name: '보관된 프로젝트', position: 2, system: true },
]
const channels = (): Channel[] => [
  ch({ id: 'a', name: '공지', position: 0 }),
  ch({ id: 'b', name: '일반', position: 1, unread_count: 3 }),
  ch({ id: 'd1', name: '디자인', category_id: 'k1', position: 0, mention_count: 3, unread_count: 3 }),
  ch({ id: 'd2', name: '시안-리뷰', category_id: 'k1', position: 1 }),
  ch({ id: 'd3', name: '디자인 회의실', category_id: 'k1', position: 2, is_voice: true }),
  ch({ id: 'v1', name: '음악 감상실', category_id: 'k2', position: 0, is_voice: true }),
  ch({ id: 'q3', name: 'q3-회고', is_archived: true }),
  ch({ id: 'dm1', name: 'kim,lee', type: 'dm', unread_count: 2 }),
]
const names = { archive: '보관된 프로젝트', dm: '다이렉트 메시지' }
const presence = (identity: string, name: string, extra: Record<string, unknown> = {}) => ({
  identity, user_id: identity, name, avatar_url: null, muted: false, deafened: false, tier: 'voice' as const, joined_at: 1, ...extra,
})

beforeEach(() => {
  api.calls = []
  api.handler = (url: string) => (url.endsWith('/categories') ? { items: cats } : url.endsWith('/layout/meta') ? { archive_category_id: 'arch' } : url.includes('/permissions/effective') ? { permissions: PERM.MANAGE_CHANNELS } : {})
  localStorage.clear()
  isMobileStore.setState({ isMobile: false })
  authStore.setState({ user: me })
  chatLayoutStore.setState({ categories: cats, archiveCategoryId: 'arch', loaded: true, collapsed: {} })
  chatRolesStore.setState({ myWorkspacePerms: PERM.MANAGE_CHANNELS })
  chatStore.setState({
    channels: channels(), selectedChannelId: 'a', messages: [], members: [], outbox: [], drafts: {}, loadingChannels: false, channelsError: null,
    allUsers: [{ id: 'u1', username: 'kim', display_name: '김서연', avatar_url: null }, { id: 'u2', username: 'lee', display_name: '이도윤', avatar_url: null }],
    voiceStates: {},
  })
  voiceStore.setState({ channelId: null, identity: null, peers: [], connectionState: 'disconnected' })
})

describe('구역 계산', () => {
  it('분류 없음(제목 없음, 맨 위) → 사용자 카테고리 → 보관된 프로젝트(DM 바로 위) → DM(맨 아래)', () => {
    const s = buildSections(channels(), cats, 'arch', {}, names)
    expect(s.map(x => x.kind)).toEqual(['uncategorized', 'user', 'user', 'system', 'dm'])
    expect(s[0].channels.map(c => c.id)).toEqual(['a', 'b'])
    expect(s[1].channels.map(c => c.id)).toEqual(['d1', 'd2', 'd3'])
    expect(s[3].channels.map(c => c.id)).toEqual(['q3'])
  })
  it('사이드바: 제목은 button + aria-expanded, 분류 없음은 제목 없음, 접으면 aria-expanded=false', () => {
    renderInRouter(<ChatSidebar />)
    const head = screen.getByRole('button', { name: '디자인 팀' })
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByRole('button', { name: t('chat.side.uncategorized') })).toBeNull()
    const order = screen.getAllByRole('region').map(r => r.getAttribute('aria-label'))
    expect(order).toEqual([t('chat.side.uncategorized'), '디자인 팀', '음성', '보관된 프로젝트', '다이렉트 메시지'])
    fireEvent.click(head)
    expect(screen.getByRole('button', { name: '디자인 팀' }).getAttribute('aria-expanded')).toBe('false')
  })
  it('빈 카테고리는 점선 칸 안내', () => {
    chatLayoutStore.setState({ categories: [...cats, { id: 'k9', name: '릴리스', position: 3 }] })
    renderInRouter(<ChatSidebar />)
    expect(screen.getByText(t('chat.side.empty'))).toBeTruthy()
  })
})

describe('접힘 보임 규칙', () => {
  it('접혀도 안 읽음·멘션·선택(+ 내 음성 채널)은 보인다', () => {
    const s = buildSections(channels(), cats, 'arch', { k1: true }, names).find(x => x.id === 'k1')!
    expect(dnd.sectionVisibleChannels(s, null, c => (c.unread_count || 0) > 0).map(c => c.id)).toEqual(['d1'])
    // d1 은 멘션이 있어 늘 보인다
    expect(dnd.sectionVisibleChannels(s, 'd2', () => false).map(c => c.id)).toEqual(['d1', 'd2'])
    expect(dnd.sectionVisibleChannels(s, null, () => false, 'd3').map(c => c.id)).toEqual(['d1', 'd3'])
  })
  it('사이드바: 접힌 카테고리는 일부만 그린다', () => {
    chatLayoutStore.setState({ collapsed: { k1: true } })
    renderInRouter(<ChatSidebar />)
    const sec = screen.getByRole('region', { name: '디자인 팀' })
    expect(within(sec).queryByText('시안-리뷰')).toBeNull()
    expect(within(sec).getByText('디자인')).toBeTruthy()
  })
})

describe('끌기 patch 계산', () => {
  const S = () => buildSections(channels(), cats, 'arch', {}, names)
  it('같은 카테고리 안 순서 바꾸기 = 그 카테고리 전체 새 순서', () => {
    const p = dnd.planChannelMove(S(), 'd3', 'k1', 0)!
    expect(p.patch!.channels).toEqual([
      { id: 'd3', category_id: 'k1', position: 0 }, { id: 'd1', category_id: 'k1', position: 1 }, { id: 'd2', category_id: 'k1', position: 2 },
    ])
    expect(p.archive).toBeUndefined()
  })
  it('그대로면 null', () => { expect(dnd.planChannelMove(S(), 'd1', 'k1', 0)).toBeNull() })
  it('다른 카테고리 / 분류 없음(null)으로', () => {
    expect(dnd.planChannelMove(S(), 'a', 'k2', 1)!.patch!.channels).toEqual([
      { id: 'v1', category_id: 'k2', position: 0 }, { id: 'a', category_id: 'k2', position: 1 },
    ])
    expect(dnd.planChannelMove(S(), 'd2', '', 0)!.patch!.channels![0]).toEqual({ id: 'd2', category_id: null, position: 0 })
  })
  it('보관된 프로젝트로 = 보관, 거기서 꺼내기 = 보관 해제, DM 은 불가', () => {
    expect(dnd.planChannelMove(S(), 'a', 'arch', 0)).toMatchObject({ patch: null, archive: true })
    expect(dnd.planChannelMove(S(), 'q3', 'k1', 3)).toMatchObject({ archive: false })
    expect(dnd.planChannelMove(S(), 'dm1', 'k1', 0)).toBeNull()
    expect(dnd.planChannelMove(S(), 'a', 'dm', 0)).toBeNull()
  })
  it('키보드 한 칸: 구역 끝에서 옆 구역으로(DM·보관 제외)', () => {
    expect(dnd.stepChannel(S(), 'd2', -1)).toEqual({ toSectionId: 'k1', index: 0 })
    expect(dnd.stepChannel(S(), 'd1', -1)).toEqual({ toSectionId: '', index: 2 })
    expect(dnd.stepChannel(S(), 'v1', 1)).toBeNull()
  })
  it('접힌 구역의 보이는 위치 → 전체 위치 · 같은 구역 아래로 옮길 때 한 칸 보정', () => {
    const s = S().find(x => x.id === 'k1')!
    expect(dnd.fullIndexFromVisible(s, [s.channels[0], s.channels[2]], 1)).toBe(2)
    expect(dnd.fullIndexFromVisible(s, [s.channels[0]], 1)).toBe(3)
    expect(dnd.normalizeSameSectionIndex(s, 'd1', 2)).toBe(1)
  })
  it('카테고리 자리(시스템 제외) · 한 칸 이동', () => {
    expect(dnd.categoryDropIndex(cats, 'k2', 'k1', false)).toBe(0)
    expect(dnd.categoryDropIndex(cats, 'k1', 'k2', true)).toBe(1)
    expect(dnd.stepCategory(cats, 'k2', -1)).toBe(0)
    expect(dnd.stepCategory(cats, 'k2', 1)).toBeNull()
  })
  it('키보드 Alt+Shift+↓ → PATCH /layout 한 번 + aria-live 안내', async () => {
    renderInRouter(<ChatSidebar />)
    fireEvent.keyDown(screen.getByText('시안-리뷰').closest('button')!, { key: 'ArrowUp', altKey: true, shiftKey: true })
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/chat/layout' && c.opts?.method === 'PATCH')).toBe(true))
    const body = api.calls.find(c => c.url === '/api/chat/layout')!.opts.body
    expect(body.channels.map((c: any) => c.id)).toEqual(['d2', 'd1', 'd3'])
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('#시안-리뷰를 ‘디자인 팀’ 첫 번째로 옮겼습니다'))
  })
  it('실패하면 다시 읽어 되돌리고 토스트', async () => {
    api.handler = (url: string, o?: any) => {
      if (url === '/api/chat/layout') throw new Error('x')
      if (url === '/api/chat/channels' && !o?.method) return channels()
      return url.endsWith('/categories') ? { items: cats } : {}
    }
    renderInRouter(<ChatSidebar />)
    fireEvent.keyDown(screen.getByText('시안-리뷰').closest('button')!, { key: 'ArrowUp', altKey: true, shiftKey: true })
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/chat/channels' && !c.opts?.method)).toBe(true))
    expect(chatStore.getState().channels.find(c => c.id === 'd2')!.position).toBe(1)
  })
})

describe('권한', () => {
  it('MANAGE_CHANNELS 없으면 끌기·카테고리 + 없음, 머리 메뉴에 카테고리 만들기 없음', async () => {
    chatRolesStore.setState({ myWorkspacePerms: 0 })
    api.handler = (url: string) => (url.includes('/permissions/effective') ? { permissions: 0 } : url.endsWith('/categories') ? { items: cats } : {})
    renderInRouter(<ChatSidebar />)
    expect(screen.getByText('시안-리뷰').closest('button')!.getAttribute('draggable')).toBeNull()
    const sec = screen.getByRole('region', { name: '디자인 팀' })
    expect(within(sec).queryByRole('button', { name: t('chat.side.addChannel') })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Workspace|워크스페이스/ }))
    expect(await screen.findByRole('menuitem', { name: t('chat.side.menuSettings') })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: t('chat.side.menuNewCategory') })).toBeNull()
  })
  it('있으면 행 draggable, 카테고리 제목 draggable(시스템·DM 제외)', () => {
    renderInRouter(<ChatSidebar />)
    expect(screen.getByText('시안-리뷰').closest('button')!.getAttribute('draggable')).toBe('true')
    expect(screen.getByRole('button', { name: '디자인 팀' }).parentElement!.getAttribute('draggable')).toBe('true')
    expect(screen.getByRole('button', { name: '보관된 프로젝트' }).parentElement!.getAttribute('draggable')).toBeNull()
    expect(screen.getByRole('button', { name: '다이렉트 메시지' }).parentElement!.getAttribute('draggable')).toBeNull()
  })
})

describe('음성 접속자 줄', () => {
  it('최대 4줄 + "+N명"', () => {
    expect(dnd.voiceRows([1, 2, 3])).toEqual({ shown: [1, 2, 3], more: 0 })
    expect(dnd.voiceRows([1, 2, 3, 4, 5, 6])).toEqual({ shown: [1, 2, 3, 4], more: 2 })
  })
  it('사이드바: 6명 → 4줄 + "+2명", 사람별 음량 100 아니면 표시, 접힌 카테고리는 인원 수만', () => {
    chatStore.setState({ voiceStates: { v1: { participants: ['a', 'b', 'c', 'd', 'e', 'f'].map(x => presence(x, `사람${x}`)), since: 1 } } })
    userPrefsStore.setState({ prefs: { ...userPrefsStore.getState().prefs, chatUserVolumes: { b: 120 } } })
    const { unmount } = renderInRouter(<ChatSidebar />)
    const list = screen.getByRole('list', { name: t('chat.voice.sidebar.occupantList', { name: '음악 감상실' }) })
    expect(within(list).getAllByRole('listitem')).toHaveLength(5)
    expect(list.textContent).toContain('+2명')
    expect(list.textContent).toContain('120%')
    unmount()
    chatLayoutStore.setState({ collapsed: { k2: true } })
    voiceStore.setState({ channelId: 'v1', identity: 'a' })
    renderInRouter(<ChatSidebar />)
    expect(screen.queryByRole('list', { name: t('chat.voice.sidebar.occupantList', { name: '음악 감상실' }) })).toBeNull()
    expect(screen.getByRole('button', { name: new RegExp(t('chat.voice.sidebar.occupants', { name: '음악 감상실', n: 6 })) })).toBeTruthy()
  })
})

describe('음소거', () => {
  it('툴팁 문구: 같은 날 "오후 3:00까지 알림 끔", 다른 날 날짜 포함, 기간 없음 "알림 끔"', () => {
    const now = new Date(2026, 9, 23, 10, 0)
    expect(dnd.muteTooltip(new Date(2026, 9, 23, 15, 0).toISOString(), t, 'ko', now)).toBe('오후 3:00까지 알림 끔')
    expect(dnd.muteTooltip(new Date(2026, 9, 24, 9, 5).toISOString(), t, 'ko', now)).toBe('10월 24일 오전 9:05까지 알림 끔')
    expect(dnd.muteTooltip(null, t, 'ko', now)).toBe('알림 끔')
    expect(dnd.clockText(new Date(2026, 0, 1, 0, 30), 'en')).toBe('12:30 AM')
  })
  it('기간이 지났으면 음소거 아님', () => {
    expect(dnd.isMutedNow({ muted: true, muted_until: '2020-01-01T00:00:00Z' })).toBe(false)
    expect(dnd.isMutedNow({ muted: true, muted_until: null })).toBe(true)
  })
  it('행에 bell-off + 툴팁', () => {
    const until = new Date(); until.setHours(15, 0, 0, 0); until.setDate(until.getDate() + (until.getTime() < Date.now() ? 1 : 0))
    chatStore.setState({ channels: channels().map(c => (c.id === 'a' ? { ...c, muted: true, muted_until: until.toISOString() } : c)) })
    renderInRouter(<ChatSidebar />)
    expect(screen.getByRole('img', { name: /알림 끔$/ }).getAttribute('title')).toMatch(/오후 3:00까지 알림 끔$/)
  })
  it('우클릭 → 알림 끄기 › 6개 → 1시간 = PATCH prefs muted_minutes 60, 목록 muted_until 반영', async () => {
    api.handler = (url: string, o?: any) => (url.endsWith('/prefs') && o?.method === 'PATCH' ? { muted: true, muted_until: '2099-01-01T06:00:00Z' } : url.endsWith('/categories') ? { items: cats } : {})
    renderInRouter(<ChatSidebar />)
    fireEvent.contextMenu(screen.getByText('일반').closest('button')!, { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: new RegExp(t('chat.side.ch.mute')) }))
    for (const k of ['15', '60', '180', '480', '1440', 'forever']) expect(await screen.findByRole('menuitem', { name: t(`chat.side.muteFor.${k}`) })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: t('chat.side.muteFor.60') }))
    await waitFor(() => expect(api.calls.find(c => c.url === '/api/chat/channels/b/prefs')?.opts.body).toEqual({ muted: true, muted_minutes: 60 }))
    await waitFor(() => expect(chatStore.getState().channels.find(c => c.id === 'b')!.muted_until).toBe('2099-01-01T06:00:00Z'))
  })
})

describe('카테고리 메뉴·대화 상자', () => {
  it('⋯ → 시안 항목 순서, 삭제 확인은 채널 이름 목록 + 분류 없음 안내', async () => {
    renderInRouter(<ChatSidebar />)
    const sec = screen.getByRole('region', { name: '디자인 팀' })
    fireEvent.click(within(sec).getByRole('button', { name: t('chat.side.catMenu') }))
    const items = (await screen.findAllByRole('menuitem')).map(m => m.textContent)
    expect(items.map(x => x?.replace(/(F2|Alt [↑↓])$/, ''))).toEqual([
      '채널 만들기', '이름 바꾸기', '카테고리 권한', '알림 설정', '위로 옮기기', '아래로 옮기기', '모두 접기', '카테고리 삭제',
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: /카테고리 삭제/ }))
    const dlg = await screen.findByRole('alertdialog')
    expect(dlg.textContent).toContain('#디자인 · #시안-리뷰 · 디자인 회의실')
    expect(dlg.textContent).toContain('분류 없음')
  })
  it('보관된 프로젝트 ⋯ 에는 삭제·옮기기 없음', async () => {
    renderInRouter(<ChatSidebar />)
    const sec = screen.getByRole('region', { name: '보관된 프로젝트' })
    fireEvent.click(within(sec).getByRole('button', { name: t('chat.side.catMenu') }))
    const items = (await screen.findAllByRole('menuitem')).map(m => m.textContent || '')
    expect(items.some(x => x.includes('삭제') || x.includes('옮기기'))).toBe(false)
    expect(items.some(x => x.includes('이름 바꾸기'))).toBe(true)
  })
  it('F2 → 인라인 이름 바꾸기, Esc 취소 · Enter 저장', async () => {
    renderInRouter(<ChatSidebar />)
    fireEvent.keyDown(screen.getByRole('button', { name: '디자인 팀' }), { key: 'F2' })
    let input = screen.getByRole('textbox', { name: t('chat.side.dlg.name') })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.getByRole('button', { name: '디자인 팀' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('button', { name: '디자인 팀' }), { key: 'F2' })
    input = screen.getByRole('textbox', { name: t('chat.side.dlg.name') })
    fireEvent.change(input, { target: { value: '디자인' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.calls.find(c => c.url === '/api/chat/categories/k1' && c.opts?.method === 'PATCH')?.opts.body).toEqual({ name: '디자인' }))
  })
})

describe('도우미', () => {
  it('을/를', () => {
    expect(dnd.objParticle('#시안-리뷰')).toBe('를')
    expect(dnd.objParticle('#공지')).toBe('를')
    expect(dnd.objParticle('#일반')).toBe('을')
  })
})

describe('모바일 #m-list · #m-order', () => {
  it('목록 위 3칸 버튼 44 · ⋯ → 순서 편집 → ↑ 누르면 PATCH + 아래 status 줄', async () => {
    isMobileStore.setState({ isMobile: true })
    renderInRouter(<ChatSidebar />)
    const nav = screen.getByRole('navigation', { name: t('chat.sidebar.pinnedNav') })
    expect(within(nav).getAllByRole('button').map(b => b.className.includes('h-11'))).toEqual([true, true, true])
    fireEvent.click(screen.getByRole('button', { name: t('chat.side.workspaceMenuMobile') }))
    fireEvent.click(await screen.findByRole('menuitem', { name: t('chat.side.menuOrder') }))
    expect(screen.getByRole('heading', { name: t('chat.side.order.title') })).toBeTruthy()
    fireEvent.click(screen.getByText('시안-리뷰'))
    fireEvent.click(screen.getByRole('button', { name: t('chat.side.order.up', { name: '#시안-리뷰' }) }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('#시안-리뷰를 ‘디자인 팀’ 첫 번째로 옮겼습니다'))
    fireEvent.click(screen.getByRole('button', { name: t('chat.side.order.done') }))
    expect(screen.queryByRole('heading', { name: t('chat.side.order.title') })).toBeNull()
  })
})
