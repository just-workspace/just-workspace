// 채팅 셸(SHELL) — 오른쪽 자리·모바일 단계·멤버 묶음·사람별 음량·PTT 키·현지 시각 + 멤버 열·음량 카드·머리 토글
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import { renderInRouter } from '../ui/helpers'

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async () => { throw Object.assign(new Error('offline'), { data: null }) }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { resolveRightColumn, rightColumnDocked, nextRightState, RIGHT_COLUMN_WIDTH, CHAT_MEMBERS_DOCK_MIN } = await import('~/utils/chatRightColumn')
const { panelOf, stageFromQuery, stageFromState, depthOf } = await import('~/utils/chatStage')
const { groupMembers, visibleMembers, BIG_GROUP } = await import('~/utils/chatMemberGroups')
const { gainFor, volumeBadge, snapVolume, userVolumeOf } = await import('~/lib/voice/userVolume')
const { pttKeyLabel, isCharacterKey, pttGateOpen } = await import('~/lib/voice/ptt')
const { profileClock, utcLabel, tzCity, tzOffsetMinutes } = await import('~/utils/chatProfileTime')
const { chatStore } = await import('~/composables/useChat')
const { chatUiStore } = await import('~/composables/useChatUi')
const { chatRolesStore } = await import('~/composables/useChatRoles')
const { userPrefsStore, setChatUserVolume, setChatUserMuted } = await import('~/composables/useUserPrefs')
const { ChatMemberPanel } = await import('~/components/chat/ChatMemberPanel')
const { ChatUserVolume } = await import('~/components/chat/ChatUserVolume')
const { ChatHeader } = await import('~/components/chat/ChatHeader')
const { viewportStore } = await import('~/composables/useViewport')
const { setUser } = await import('~/composables/useAuth')
const { i18n } = await import('~/i18n')
const t = (k: string, a?: any) => i18n.t(k, a)

const base = { panel: null, width: 1440, membersOpen: true, hasChannel: true, voiceTextAvailable: false, voiceTextOpen: true } as const

describe('chatRightColumn — 자리 하나', () => {
  it('폭 표', () => {
    expect(RIGHT_COLUMN_WIDTH).toMatchObject({ members: 264, thread: 400, threads: 400, search: 400, pins: 400, voiceText: 340 })
  })
  it('바탕 = 멤버(1180 이상) · 패널이 앞선다 · 음성 글 채팅', () => {
    expect(resolveRightColumn(base)).toBe('members')
    expect(resolveRightColumn({ ...base, width: 1179 })).toBeNull()
    expect(resolveRightColumn({ ...base, membersOpen: false })).toBeNull()
    expect(resolveRightColumn({ ...base, panel: 'threads' })).toBe('threads')
    expect(resolveRightColumn({ ...base, voiceTextAvailable: true })).toBe('voiceText')
    expect(resolveRightColumn({ ...base, hasChannel: false })).toBeNull()
  })
  it('1180 미만은 덮개', () => {
    expect(rightColumnDocked('thread', CHAT_MEMBERS_DOCK_MIN)).toBe(true)
    expect(rightColumnDocked('thread', CHAT_MEMBERS_DOCK_MIN - 1)).toBe(false)
    expect(rightColumnDocked(null, 2000)).toBe(false)
  })
  it('열기 = 바꿔 끼우기 · 다시 누르면 닫기', () => {
    // 넓은 화면 멤버 토글은 상시 열(membersOpen)
    expect(nextRightState('members', 'members', true, true)).toMatchObject({ membersOpen: false, showMemberPanel: false })
    expect(nextRightState('members', 'thread', true, false)).toMatchObject({ membersOpen: true, closeThread: true })
    // 좁으면 덮개
    expect(nextRightState('members', null, false, true)).toMatchObject({ showMemberPanel: true, membersOpen: true })
    // 스레드 목록을 열면 다른 잠깐 패널은 끄고, 바탕 멤버 열은 그대로
    expect(nextRightState('threads', 'search', true, true)).toMatchObject({ threadListOpen: true, showSearchPanel: false, membersOpen: true })
    expect(nextRightState('threads', 'threads', true, true)).toMatchObject({ threadListOpen: false })
    expect(nextRightState('pins', 'members', true, true)).toMatchObject({ showPinsPanel: true })
  })
})

describe('chatStage — 스레드 목록 단계', () => {
  beforeEach(() => {
    chatStore.setState({ selectedChannelId: 'c1', activeThreadId: null, showSearchPanel: false, showMemberPanel: false, showPinsPanel: false })
    chatUiStore.setState({ threadListOpen: false, collection: null })
  })
  it('panelOf 순서: 검색 > 스레드 > 스레드 목록 > 멤버 > 고정', () => {
    const s = { showSearchPanel: false, activeThreadId: null, showMemberPanel: true, showPinsPanel: true }
    expect(panelOf(s, true)).toBe('threads')
    expect(panelOf({ ...s, activeThreadId: 't' }, true)).toBe('thread')
    expect(panelOf(s, false)).toBe('members')
  })
  it('주소 panel=threads', () => {
    chatUiStore.setState({ threadListOpen: true })
    expect(stageFromState()).toEqual({ channel: 'c1', panel: 'threads' })
    expect(stageFromQuery({ channel: 'c1', panel: 'threads' })).toEqual({ channel: 'c1', panel: 'threads' })
    expect(depthOf({ channel: 'c1', panel: 'threads' })).toBe(2)
  })
})

const role = (id: string, name: string, position: number) => ({
  id, name, color: null, icon: null, position, permissions: 0, permission_names: [], hoist: true, mentionable: true, managed: false, group_id: null, is_default: false, mention: null,
})
const mem = (id: string, name: string) => ({ user_id: id, username: id, display_name: name, avatar_url: null, role: 'member', is_online: false })

describe('chatMemberGroups — hoist 역할 → 온라인 → 오프라인', () => {
  it('계층순, 오프라인은 역할이 있어도 오프라인 묶음', () => {
    const members = [mem('a', '가'), mem('b', '나'), mem('c', '다'), mem('d', '라'), mem('e', '마')]
    const online = new Set(['a', 'b', 'c', 'e'])
    const byRole = [
      { role: role('r-admin', '관리자', 9), members: [{ ...mem('a', '가'), roles: ['r-admin'], color: 'warning' }] },
      { role: role('r-dev', '백엔드', 5), members: [{ ...mem('b', '나'), roles: ['r-dev'], color: 'primary' }, { ...mem('d', '라'), roles: ['r-dev'], color: 'primary' }] },
      { role: null, members: [{ ...mem('c', '다'), roles: [], color: null }, { ...mem('e', '마'), roles: [], color: null }] },
    ]
    const g = groupMembers(members, id => online.has(id), byRole)
    expect(g.map(x => x.key)).toEqual(['role:r-admin', 'role:r-dev', 'online', 'offline'])
    expect(g[1].members.map(m => m.member.user_id)).toEqual(['b'])
    expect(g[1].members[0].color).toBe('primary')
    expect(g[3].members.map(m => m.member.user_id)).toEqual(['d'])
  })
  it('by-role 없으면 온라인/오프라인만, 이름순', () => {
    const g = groupMembers([mem('x', '하늘'), mem('y', '가람'), mem('z', '나래')], id => id !== 'z', null)
    expect(g.map(x => x.kind)).toEqual(['online', 'offline'])
    expect(g[0].members.map(m => m.member.display_name)).toEqual(['가람', '하늘'])
  })
  it('1,000명 넘으면 처음 3명 + 펼치기 · 접기', () => {
    const many = Array.from({ length: BIG_GROUP + 5 }, (_, i) => mem(`u${i}`, `사람${String(i).padStart(4, '0')}`))
    const [off] = groupMembers(many, () => false, null)
    expect(off.big).toBe(true)
    expect(visibleMembers(off, false, false)).toHaveLength(3)
    expect(visibleMembers(off, false, true)).toHaveLength(BIG_GROUP + 5)
    expect(visibleMembers(off, true, true)).toHaveLength(0)
  })
})

describe('사람별 음량 — 저장·적용 값', () => {
  beforeEach(() => { userPrefsStore.setState(s => ({ prefs: { ...s.prefs, chatUserVolumes: {}, chatUserMuted: {} } })) })
  it('5% 단계 · 0–200 · 100 이면 저장 안 함', () => {
    expect(snapVolume(123)).toBe(125)
    expect(snapVolume(-4)).toBe(0)
    expect(snapVolume(999)).toBe(200)
    setChatUserVolume('u1', 121)
    expect(userPrefsStore.getState().prefs.chatUserVolumes).toEqual({ u1: 120 })
    setChatUserVolume('u1', 100)
    expect(userPrefsStore.getState().prefs.chatUserVolumes).toEqual({})
  })
  it('이득 = 음량/100, 나만 음소거면 0 · 꼬리표', () => {
    setChatUserVolume('u2', 150)
    const p = userPrefsStore.getState().prefs
    expect(gainFor('u2', p)).toBe(1.5)
    expect(volumeBadge('u2', p)).toBe('150%')
    expect(volumeBadge('nobody', p)).toBe('')
    setChatUserMuted('u2', true)
    expect(gainFor('u2', userPrefsStore.getState().prefs)).toBe(0)
    expect(userVolumeOf('nobody', p)).toBe(100)
  })
})

describe('PTT 키', () => {
  it('글자', () => {
    expect(pttKeyLabel('Backquote')).toBe('`')
    expect(pttKeyLabel('KeyV')).toBe('V')
    expect(pttKeyLabel('F8')).toBe('F8')
    expect(isCharacterKey('Backquote')).toBe(true)
    expect(isCharacterKey('F8')).toBe(false)
  })
  it('PTT 가 아니면 문은 늘 열림', () => {
    expect(pttGateOpen({ enabled: false, held: false })).toBe(true)
    expect(pttGateOpen({ enabled: true, held: false })).toBe(false)
    expect(pttGateOpen({ enabled: true, held: true })).toBe(true)
  })
})

describe('프로필 현지 시각', () => {
  it('UTC 차 · 도시 · 나와의 차이', () => {
    const at = new Date(Date.UTC(2026, 0, 15, 6, 12))
    expect(tzOffsetMinutes('Asia/Seoul', at)).toBe(540)
    expect(utcLabel(540)).toBe('UTC+9')
    expect(utcLabel(-210)).toBe('UTC−3:30')
    expect(tzCity('America/Argentina/Buenos_Aires')).toBe('Buenos Aires')
    const c = profileClock('Europe/Berlin', 'Asia/Seoul', 'en-US', at)!
    expect(c.utc).toBe('UTC+1')
    expect(c.diffHours).toBe(-8)
    expect(c.time).toMatch(/7:12/)
  })
})

describe('ChatMemberPanel', () => {
  beforeEach(() => {
    viewportStore.setState({ width: 1440 })
    chatRolesStore.setState({ memberGroups: {}, roles: [], loaded: true })
    chatStore.setState({
      channels: [{ id: 'c1', name: 'dev', type: 'public', member_count: 3 }] as any,
      selectedChannelId: 'c1',
      members: [mem('a', '가'), mem('b', '나'), mem('z', '다')] as any,
      presences: {}, onlineUsers: new Set(['a', 'b']),
    })
  })
  it('온라인 — 2 · 오프라인 — 1, 행 누르면 프로필 팝아웃', () => {
    renderInRouter(<ChatMemberPanel />)
    expect(screen.getByText(`${t('chat.shell.members.online')} — 2`)).toBeTruthy()
    expect(screen.getByText(`${t('chat.shell.members.offline')} — 1`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^다,/ }))
    expect(chatUiStore.getState().profilePopout?.userId).toBe('z')
  })
})

describe('ChatUserVolume', () => {
  beforeEach(() => { userPrefsStore.setState(s => ({ prefs: { ...s.prefs, chatUserVolumes: { p: 120 }, chatUserMuted: {} } })) })
  it('값 표시 · 100% 넘으면 경고 · 나만 음소거 · 기본값', () => {
    renderInRouter(<ChatUserVolume target={{ userId: 'p', name: '박준' }} onClose={() => {}} />)
    const slider = screen.getByRole('slider', { name: t('chat.shell.vol.title', { name: '박준' }) })
    expect(slider.getAttribute('aria-valuetext')).toBe('120%')
    expect(screen.getByText(t('chat.shell.vol.clipWarn'))).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: t('chat.shell.vol.muteForMe') }))
    expect(userPrefsStore.getState().prefs.chatUserMuted).toEqual({ p: true })
    fireEvent.click(screen.getByText(t('chat.shell.vol.reset')))
    expect(userPrefsStore.getState().prefs.chatUserVolumes.p).toBeUndefined()
    expect(screen.queryByText(t('chat.shell.vol.clipWarn'))).toBeNull()
  })
})

describe('ChatHeader 오른쪽 자리 토글', () => {
  beforeEach(() => {
    setUser({ id: 'me', username: 'me', display_name: 'me', email: null } as any)
    viewportStore.setState({ width: 1440 })
    chatUiStore.setState({ membersOpen: true, threadListOpen: false })
    chatStore.setState({
      channels: [{ id: 'c1', name: 'dev', type: 'public', description: '주제', member_count: 2, created_by: 'x' }] as any,
      selectedChannelId: 'c1', members: [] as any, activeThreadId: null, showSearchPanel: false, showMemberPanel: false, showPinsPanel: false,
    })
  })
  it('멤버(aria-pressed) → 스레드 목록으로 바꿔 끼우기', async () => {
    renderInRouter(<ChatHeader />)
    const membersBtn = screen.getByRole('button', { name: t('chat.shell.header.membersClose') })
    expect(membersBtn.getAttribute('aria-pressed')).toBe('true')
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: t('chat.shell.header.threads') }).find(b => b.hasAttribute('aria-pressed'))!) })
    expect(chatUiStore.getState().threadListOpen).toBe(true)
    expect(screen.getByRole('button', { name: t('chat.shell.header.membersOpen') }).getAttribute('aria-pressed')).toBe('false')
    // 멤버를 다시 누르면 스레드 목록이 닫히고 멤버가 돌아온다
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('chat.shell.header.membersOpen') })) })
    expect(chatUiStore.getState().threadListOpen).toBe(false)
    expect(chatUiStore.getState().membersOpen).toBe(true)
  })
})
