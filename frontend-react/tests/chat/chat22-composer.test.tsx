// 채팅 COMPOSER — 자동완성 후보 · @silent · @everyone 두 번 Enter · 서식줄 · 이모지 검색/피부색 · 첨부 묶음 보내기 · 피커 리액션
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  return { ...real, $fetch: vi.fn(async () => ({ items: [] })) }
})
const postAttachments = vi.fn()
vi.mock('~/composables/chatApi22', async (orig) => {
  const real = await orig<typeof import('~/composables/chatApi22')>()
  return { ...real, postAttachments: (...a: unknown[]) => postAttachments(...a), fetchCustomEmojis: vi.fn(async () => ({ items: [], can_manage: false, limit: 200 })) }
})
const toggleReaction = vi.fn()
vi.mock('~/composables/useChat', async (orig) => {
  const real = await orig<typeof import('~/composables/useChat')>()
  return { ...real, initChat: vi.fn(async () => {}), toggleReaction: (...a: unknown[]) => toggleReaction(...a) }
})

import koData from 'emojibase-data/ko/compact.json'
import github from 'emojibase-data/en/shortcodes/github.json'
import { authStore } from '~/composables/useAuth'
import { chatStore, type Channel, type ChatMessage } from '~/composables/useChat'
import { chatUiStore, setEmojiPicker } from '~/composables/useChatUi'
import { chatRolesStore, type ChatRole } from '~/composables/useChatRoles'
import { addFiles, chatAttachmentsStore, sendAttachments, setAlt, setSpoiler, retryUpload } from '~/composables/useChatAttachments'
import { applySkin, buildEntries, chatEmojiStore, emojiName, searchEmoji, setEmojiEntries } from '~/composables/useChatEmoji'
import { findTrigger, mentionCandidates, emojiCandidates, type MentionContext } from '~/components/chat/ChatAutocomplete'
import { applyFormat } from '~/components/chat/ChatFormatBar'
import { ChatInput, buildSendOptions, detectEveryone, enterAction, splitSilent } from '~/components/chat/ChatInput'
import { ChatEmojiPicker } from '~/components/chat/ChatEmojiPicker'

const me = { id: 'u1', username: 'kim', display_name: '김서연', email: '', is_admin: false } as any
const ch = (p: Partial<Channel> = {}): Channel => ({
  id: 'c1', name: 'general', type: 'public', description: null, created_by: 'u1', is_archived: false,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', member_count: 2, unread_count: 0, ...p,
} as Channel)
const role = (p: Partial<ChatRole>): ChatRole => ({
  id: 'r1', name: '디자인', color: 'accent', icon: null, position: 2, permissions: 0, permission_names: [], hoist: true,
  mentionable: true, managed: false, group_id: null, is_default: false, mention: '디자인', member_count: 6, ...p,
})
const tt = (k: string, p?: Record<string, unknown>) => (p ? `${k}:${JSON.stringify(p)}` : k)

beforeAll(() => {
  setEmojiEntries(buildEntries(koData as any, github as any))
})
beforeEach(() => {
  authStore.setState({ user: me })
  chatStore.setState({
    channels: [ch()], selectedChannelId: 'c1', messages: [], threadMessages: [], drafts: {},
    members: [
      { user_id: 'u1', username: 'kim', display_name: '김서연', avatar_url: null, role: 'owner', is_online: true },
      { user_id: 'u2', username: 'doyun', display_name: '이도윤', avatar_url: null, role: 'member', is_online: true },
      { user_id: 'u3', username: 'suah', display_name: '최수아', avatar_url: null, role: 'member', is_online: false },
    ],
    allUsers: [],
  } as any)
  chatUiStore.setState({ editRequest: null, replyTo: null, emojiPicker: null, editingMessageId: null })
  chatRolesStore.setState({ roles: [], loaded: true, myChannelPerms: {}, catalog: null })
  chatAttachmentsStore.setState({ attachments: [] })
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:x')
  globalThis.URL.revokeObjectURL = vi.fn()
  postAttachments.mockReset()
  toggleReaction.mockReset()
})

describe('자동완성 트리거', () => {
  it(': 는 2글자부터, @ 는 바로', () => {
    expect(findTrigger('배포 :s', 6)).toBeNull()
    expect(findTrigger('배포 :sh', 7)).toEqual({ kind: 'emoji', start: 3, end: 7, query: 'sh' })
    expect(findTrigger('리뷰는 @', 5)).toEqual({ kind: 'mention', start: 4, end: 5, query: '' })
    expect(findTrigger('리뷰는 @디', 6)?.query).toBe('디')
    expect(findTrigger('a@b', 3)).toBeNull()        // 단어 중간
    expect(findTrigger('done :fire: ', 12)).toBeNull()
  })
})

describe('멘션 후보', () => {
  const ctx = (p: Partial<MentionContext> = {}): MentionContext => ({
    members: chatStore.getState().members, users: [], roles: [], canEveryone: false, memberCount: 128, onlineCount: 23, t: tt, ...p,
  })
  it('역할 → 사람 순, 멘션 못 하는 역할은 비활성 + 이유, @everyone 은 권한 없으면 비활성', () => {
    const roles = [role({}), role({ id: 'r2', name: '디자인-리드', mention: '디자인-리드', mentionable: false, position: 3 }), role({ id: 'r0', is_default: true, name: '@everyone', mention: null })]
    const items = mentionCandidates('디', ctx({ roles }))
    expect(items.map(i => i.label)).toEqual(['디자인-리드', '디자인'])
    expect(items[0].disabled).toBe(true)
    expect(items[0].disabledReason).toBe('chat.compose.ac.roleNotMentionable')
    expect(items[1].disabled).toBeFalsy()
    expect(items[1].insert).toBe('@디자인')
    // MENTION_EVERYONE 이 있으면 멘션 못 하는 역할도 고를 수 있다
    expect(mentionCandidates('디', ctx({ roles, canEveryone: true }))[0].disabled).toBe(false)
    const ev = mentionCandidates('every', ctx())
    expect(ev).toHaveLength(1)
    expect(ev[0].disabled).toBe(true)
    expect(mentionCandidates('every', ctx({ canEveryone: true }))[0].secondary).toContain('128')
  })
  it('채널 멤버 먼저, 이름·아이디로 찾고 최대 8개', () => {
    const users = Array.from({ length: 12 }, (_, i) => ({ id: `w${i}`, username: `user${i}`, display_name: `사람${i}`, avatar_url: null }))
    const items = mentionCandidates('', ctx({ users }))
    expect(items).toHaveLength(8)
    expect(items[0].label).toBe('김서연')
    expect(mentionCandidates('suah', ctx())[0].label).toBe('최수아')
  })
})

describe('자동완성 목록 모양(시안 값)', () => {
  it('행 36 · 앞 24 · 이름 14/500 · 설명 13 · 꼬리표 · 선택 overlay-selected · 역할 색 · 비활성 60% + 이유', () => {
    chatRolesStore.setState({ roles: [role({}), role({ id: 'r2', name: '디자인-리드', mention: '디자인-리드', mentionable: false, position: 3 })], myChannelPerms: { c1: 2 } })
    render(<ChatInput />)
    const ta = screen.getByRole('combobox') as HTMLTextAreaElement
    ta.focus()
    fireEvent.change(ta, { target: { value: '@디', selectionStart: 2, selectionEnd: 2 } })
    const opts = screen.getAllByRole('option')
    expect(opts[0].getAttribute('aria-disabled')).toBe('true')
    expect(opts[0].textContent).toContain('멘션 허용 안 됨')
    expect(opts[0].querySelector('.opacity-60')).toBeTruthy()
    const sel = opts.find(o => o.getAttribute('aria-selected') === 'true')!
    // 첫 행이 비활성이어도 선택 표시는 시안대로 /20
    expect(sel.className).toContain('h-9')
    expect(sel.className).toContain('bg-overlay-selected')
    expect(sel.className).toContain('text-[14px]')
    const name = opts[1].querySelector('.font-medium')!
    expect(name.className).toContain('text-role-2')       // accent → role-2
    expect([...opts[1].querySelectorAll('span')].find(e => e.className.includes('text-[13px]'))?.textContent).toBe('역할 · 6명')
    expect(opts[1].querySelector('.h-6.w-6')).toBeTruthy()  // 앞 24
    expect(opts[1].textContent).toContain('역할')            // 꼬리표
    expect(screen.getByText(/개 · ↑↓ 이동/).getAttribute('aria-live')).toBe('polite')
  })
})

describe('@silent · @everyone', () => {
  it('@silent 접두를 떼고 silent', () => {
    expect(splitSilent('@silent 배포 끝')).toEqual({ silent: true, body: '배포 끝' })
    expect(splitSilent('@silentx 아님')).toEqual({ silent: false, body: '@silentx 아님' })
    expect(buildSendOptions({ silent: true, reply: { messageId: 'm9', ping: false } })).toEqual({ silent: true, reply_to_id: 'm9', reply_ping: false })
  })
  it('@everyone 감지(코드 안은 제외) · Enter 판단', () => {
    expect(detectEveryone('@everyone 공지')).toBe('everyone')
    expect(detectEveryone('공지 @here')).toBe('here')
    expect(detectEveryone('`@everyone`')).toBeNull()
    expect(enterAction({ text: '@everyone 공지', silent: false, canEveryone: true, armed: false })).toBe('arm')
    expect(enterAction({ text: '@everyone 공지', silent: false, canEveryone: true, armed: true })).toBe('send')
    expect(enterAction({ text: '@everyone 공지', silent: false, canEveryone: false, armed: false })).toBe('send')
  })
  it('컴포저: 권한 있으면 첫 Enter 는 띠만, 두 번째 Enter 에 보낸다', () => {
    authStore.setState({ user: { ...me, is_admin: true } })
    const onSend = vi.fn()
    render(<ChatInput onSend={onSend} />)
    const ta = screen.getByRole('combobox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '@everyone 내일 공지' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('3명')
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('@everyone 내일 공지', 'text', null, {})
  })
  it('컴포저: 권한 없으면 info 한 줄, 바로 보냄', () => {
    chatRolesStore.setState({ myChannelPerms: { c1: 2 } })   // SEND_MESSAGES 만
    const onSend = vi.fn()
    render(<ChatInput onSend={onSend} />)
    const ta = screen.getByRole('combobox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '@everyone 공지' } })
    expect(screen.getByText(/알림 없이 글자로 보냅니다/)).toBeTruthy()
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
  })
  it('컴포저: @silent 는 칩이 되고 silent 로 보낸다 · 답장은 reply_to_id/reply_ping', () => {
    chatUiStore.setState({ replyTo: { channelId: 'c1', parentId: null, messageId: 'm5', senderId: 'u2', senderName: '이도윤', ping: true } })
    const onSend = vi.fn()
    render(<ChatInput onSend={onSend} />)
    expect(screen.getByText('이도윤 님에게 답장 중')).toBeTruthy()
    const sw = screen.getByRole('switch')
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    expect(chatUiStore.getState().replyTo?.ping).toBe(false)
    const ta = screen.getByRole('combobox') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '@silent 밤이라 조용히' } })
    expect(ta.value).toBe('밤이라 조용히')
    expect(screen.getByText('알림 없이 보냅니다')).toBeTruthy()
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('밤이라 조용히', 'text', null, { reply_to_id: 'm5', reply_ping: false, silent: true })
    expect(chatUiStore.getState().replyTo).toBeNull()
  })
})

describe('서식줄', () => {
  it('감싸기 · 벗기기 · 줄 단위', () => {
    expect(applyFormat('bold', 'a bc d', 2, 4)).toEqual({ text: 'a **bc** d', start: 4, end: 6 })
    expect(applyFormat('bold', 'a **bc** d', 4, 6)).toEqual({ text: 'a bc d', start: 2, end: 4 })
    expect(applyFormat('spoiler', 'x', 0, 1).text).toBe('||x||')
    expect(applyFormat('underline', 'x', 0, 1).text).toBe('__x__')
    expect(applyFormat('codeblock', 'ls', 0, 2).text).toBe('```\nls\n```')
    const link = applyFormat('link', '문서', 0, 2)
    expect(link.text).toBe('[문서](url)')
    expect(link.text.slice(link.start, link.end)).toBe('url')
    expect(applyFormat('heading', '제목', 0, 0).text).toBe('# 제목')
    expect(applyFormat('heading', '### 제목', 0, 0).text).toBe('제목')
    expect(applyFormat('ordered', 'a\nb', 0, 3).text).toBe('1. a\n2. b')
    expect(applyFormat('quote', '> a', 0, 0).text).toBe('a')
  })
})

describe('이모지 데이터', () => {
  it('영어 이름 · 한국어로 찾는다', () => {
    expect((searchEmoji('fire')[0] as any).entry.glyph).toBe('🔥')
    expect(searchEmoji(':fire:').length).toBeGreaterThan(0)
    expect(searchEmoji('불').some(h => h.kind === 'unicode' && h.entry.glyph === '🔥')).toBe(true)
    expect(searchEmoji('zzqzzq')).toEqual([])
    expect(emojiName('👍')).toBe('thumbsup')
  })
  it('피부색', () => {
    expect(applySkin('👍', 3)).toBe('👍🏽')
    expect(applySkin('👍🏽', 0)).toBe('👍')
    expect(applySkin('🔥', 3)).toBe('🔥')
  })
  it('커스텀 포함 자동완성 최대 8', () => {
    chatEmojiStore.setState({ custom: [{ id: 'e1', name: 'ship_it', url: '/e1.png', animated: false, created_by: null, created_at: '' }] })
    const items = emojiCandidates('sh', 0, tt)
    expect(items.length).toBeLessThanOrEqual(8)
    expect(items.some(i => i.insert === ':ship_it:' && i.tag === 'chat.compose.ac.custom')).toBe(true)
    chatEmojiStore.setState({ custom: [] })
  })
})

describe('첨부 묶음 보내기', () => {
  it('트레이 → 메시지 하나(스포일러 · ALT · 본문 · 답장 · silent), 낙관적 줄 → 서버 메시지', async () => {
    let resolve!: (m: ChatMessage) => void
    postAttachments.mockImplementation(() => new Promise(r => { resolve = r }))
    const [a, b] = addFiles('c1', [new File(['a'], 'a.png', { type: 'image/png' }), new File(['bb'], 'b.pdf', { type: 'application/pdf' })])
    expect(a.status).toBe('queued')
    setSpoiler(a.id, true)
    setAlt(b.id, '  체크리스트 ')
    const localId = sendAttachments('c1', [a.id, b.id], { content: '같이 올립니다', reply_to_id: 'm5', reply_ping: true, silent: true })
    expect(localId).toBeTruthy()
    expect(chatAttachmentsStore.getState().attachments).toHaveLength(0)
    const [cid, items, opts] = postAttachments.mock.calls[0]
    expect(cid).toBe('c1')
    expect(items.map((i: any) => [i.file.name, i.spoiler, i.alt])).toEqual([['a.png', true, null], ['b.pdf', false, '체크리스트']])
    expect(opts).toMatchObject({ content: '같이 올립니다', reply_to_id: 'm5', reply_ping: true, silent: true, parent_id: null })
    const local = chatStore.getState().messages.find(m => m.id === localId)!
    expect(local._upload?.state).toBe('uploading')
    expect(local.attachments).toHaveLength(2)
    opts.onProgress(0.5)
    expect(chatStore.getState().messages.find(m => m.id === localId)?._upload?.progress).toBe(0.5)
    await act(async () => { resolve({ id: 'srv1', content: '같이 올립니다' } as ChatMessage) })
    expect(chatStore.getState().messages.map(m => m.id)).toEqual(['srv1'])
  })
  it('실패 = 다시 시도, 413 = 크기 초과(다시 시도 없음)', async () => {
    postAttachments.mockRejectedValueOnce(Object.assign(new Error('x'), { status: 500 }))
    const [a] = addFiles('c1', [new File(['a'], 'a.txt')])
    const id = sendAttachments('c1', [a.id])!
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(chatStore.getState().messages.find(m => m.id === id)?._upload?.state).toBe('failed')
    postAttachments.mockRejectedValueOnce(Object.assign(new Error('x'), { status: 413 }))
    retryUpload(id)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(chatStore.getState().messages.find(m => m.id === id)?._upload?.state).toBe('too_large')
  })
  it('최대 10개 · 50MB 초과 표시', () => {
    const files = Array.from({ length: 12 }, (_, i) => new File(['x'], `f${i}.txt`))
    expect(addFiles('c1', files)).toHaveLength(10)
    const big = new File(['x'], 'big.bin')
    Object.defineProperty(big, 'size', { value: 51 * 1024 * 1024 })
    chatAttachmentsStore.setState({ attachments: [] })
    expect(addFiles('c1', [big])[0].tooLarge).toBe(true)
  })
})

describe('이모지 피커', () => {
  it('리액션 모드: 고르면 toggleReaction', () => {
    chatStore.setState({ messages: [{ id: 'm1', channel_id: 'c1', sender: { id: 'u2', username: 'doyun', display_name: '이도윤', avatar_url: null } } as any] })
    act(() => { setEmojiPicker({ mode: 'react', messageId: 'm1' }) })
    render(<ChatEmojiPicker />)
    expect(screen.getByText('리액션 추가 — 이도윤 님의 메시지')).toBeTruthy()
    const search = screen.getByLabelText('이모지 검색')
    fireEvent.change(search, { target: { value: 'fire' } })
    expect(screen.getByText(/검색 결과 — /)).toBeTruthy()
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(toggleReaction).toHaveBeenCalledWith('m1', '🔥')
    expect(chatUiStore.getState().emojiPicker).toBeNull()
  })
  it('결과 없음 문구', () => {
    act(() => { setEmojiPicker({ mode: 'compose' }) })
    render(<ChatEmojiPicker />)
    fireEvent.change(screen.getByLabelText('이모지 검색'), { target: { value: 'zzq' } })
    expect(screen.getByText('‘zzq’에 맞는 이모지가 없습니다')).toBeTruthy()
  })
})
