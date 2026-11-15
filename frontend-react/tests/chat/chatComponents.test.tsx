// 채팅 화면 렌더·동작 — 컴포저(보내기·↑ 수정·멘션), 목록(날짜·전송 대기), 사이드바(배지·DM 이름), 페이지 골격
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { renderInRouter } from '../ui/helpers'

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  // 알림 목록은 객체, 나머지(채팅 탭 등)는 빈 배열
  return { ...real, $fetch: vi.fn(async (url: string) => (String(url).includes('/notifications') ? { notifications: [], total: 0, count: 0 } : [])) }
})
vi.mock('~/composables/useChat', async (orig) => {
  const real = await orig<typeof import('~/composables/useChat')>()
  return { ...real, initChat: vi.fn(async () => {}) }
})

import { authStore } from '~/composables/useAuth'
import { chatStore, type Channel, type ChatMessage } from '~/composables/useChat'
import { chatUiStore } from '~/composables/useChatUi'
import { UiTrans } from '~/components/ui/Trans'
import { ChatInput } from '~/components/chat/ChatInput'
import { ChatMessageList } from '~/components/chat/ChatMessageList'
import { ChatSidebar } from '~/components/chat/ChatSidebar'
import ChatPage from '~/pages/chat'
import ActivityPage from '~/pages/activity'

const me = { id: 'u1', username: 'kim', display_name: '김서연', email: '', is_admin: false } as any
const ch = (p: Partial<Channel>): Channel => ({
  id: 'c1', name: 'general', type: 'public', description: null, created_by: 'u1', is_archived: false,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', member_count: 2, unread_count: 0, ...p,
})
const msg = (p: Partial<ChatMessage>): ChatMessage => ({
  id: 'm1', channel_id: 'c1', sender: { id: 'u2', username: 'lee', display_name: '이도윤', avatar_url: null },
  content: '안녕하세요', message_type: 'text', file_meta: null, parent_id: null, reply_count: 0,
  is_edited: false, is_deleted: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...p,
})

beforeEach(() => {
  authStore.setState({ user: me })
  chatStore.setState({
    channels: [ch({}), ch({ id: 'd1', name: 'kim,lee', type: 'dm', unread_count: 2 })],
    selectedChannelId: 'c1',
    messages: [],
    members: [
      { user_id: 'u1', username: 'kim', display_name: '김서연', avatar_url: null, role: 'owner', is_online: true },
      { user_id: 'u2', username: 'lee', display_name: '이도윤', avatar_url: null, role: 'member', is_online: true },
    ],
    allUsers: [
      { id: 'u1', username: 'kim', display_name: '김서연', avatar_url: null },
      { id: 'u2', username: 'lee', display_name: '이도윤', avatar_url: null },
    ],
    outbox: [],
    drafts: {},
    loadingChannels: false,
    channelsError: null,
    activeThreadId: null,
    showSearchPanel: false,
    showMemberPanel: false,
    showPinsPanel: false,
  })
  chatUiStore.setState({ collection: null, editRequest: null, notifySheetChannelId: null, inviteOpen: false })
})

describe('UiTrans (채팅 문구)', () => {
  it('{slot} 자리에 요소를 끼운다', () => {
    render(<UiTrans k="chat.message.repliesN" as="span" slots={{ n: <b data-testid="n">3</b> }} />)
    expect(screen.getByTestId('n').textContent).toBe('3')
    expect(screen.getByTestId('n').parentElement!.textContent).toMatch(/3/)
  })
})

describe('ChatInput', () => {
  it('Enter 로 보내고 Shift+Enter 는 보내지 않는다', () => {
    const onSend = vi.fn()
    render(<ChatInput onSend={onSend} />)
    const ta = screen.getByRole('combobox') as HTMLTextAreaElement
    expect(ta.placeholder).toContain('#general')
    fireEvent.change(ta, { target: { value: '  안녕  ' } })
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('안녕', 'text', null, {})
    expect(ta.value).toBe('')
  })
  it('빈 입력창에서 ↑ = 마지막 내 메시지 수정 요청', () => {
    chatStore.setState({ messages: [msg({ id: 'a', sender: { id: 'u1', username: 'kim', display_name: null, avatar_url: null } }), msg({ id: 'b' })] })
    render(<ChatInput />)
    const ta = screen.getByRole('combobox') as HTMLTextAreaElement
    fireEvent.keyDown(ta, { key: 'ArrowUp' })
    // handover-22 #c-edit: 컴포저가 요청을 받아 띠 + 본문으로 수정 모드가 된다
    expect(chatUiStore.getState().editRequest).toBeNull()
    expect(chatUiStore.getState().editingMessageId).toBe('a')
    expect(screen.getByText('메시지 수정 중')).toBeTruthy()
    expect(ta.value).toBe('안녕하세요')
  })
  it('@ 입력 → 멤버 후보, Enter 로 끼운다', () => {
    render(<ChatInput />)
    const ta = screen.getByRole('combobox') as HTMLTextAreaElement
    ta.focus()
    fireEvent.change(ta, { target: { value: '@le', selectionStart: 3, selectionEnd: 3 } })
    const list = screen.getByRole('listbox')
    expect(list.textContent).toContain('이도윤')
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(ta.value).toBe('@lee ')
  })
})

describe('ChatMessageList', () => {
  it('날짜 구분 · 메시지 · 전송 대기', () => {
    chatStore.setState({ outbox: [{ localId: 'l1', channelId: 'c1', content: '대기 중 글', createdAt: new Date().toISOString() }] })
    render(<ChatMessageList messages={[msg({})]} loading={false} hasMore={false} loadingMore={false} />)
    expect(screen.getByText('오늘')).toBeTruthy()
    expect(screen.getByText('안녕하세요')).toBeTruthy()
    expect(screen.getByText('대기 중 글')).toBeTruthy()
  })
})

describe('ChatSidebar', () => {
  it('채널·DM 목록(DM 은 상대 표시 이름, 안 읽음 배지)', () => {
    chatStore.setState({ channels: [ch({}), ch({ id: 'd1', name: 'kim,lee', type: 'dm', unread_count: 2, mention_count: 2 })] })
    renderInRouter(<ChatSidebar />)
    expect(screen.getAllByText('general').length).toBeGreaterThan(0)
    expect(screen.getAllByText('이도윤').length).toBeGreaterThan(0)
  })
})

describe('pages', () => {
  it('/chat — 사이드바 + 대화 머리', async () => {
    await act(async () => { renderInRouter(<ChatPage />, '/chat') })
    expect(screen.getAllByText('general').length).toBeGreaterThan(0)
    expect(screen.getAllByRole('combobox').length).toBeGreaterThan(0)
  })
  it('/activity — 제목', async () => {
    await act(async () => { renderInRouter(<ActivityPage />, '/activity') })
    expect(screen.getAllByRole('heading', { name: '활동' }).length).toBeGreaterThan(0)
  })
})
