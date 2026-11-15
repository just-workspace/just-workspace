// 핸드오프 13(R5) 채팅·셸: 링크 미리보기 카드(B12 · R13 #link) · 상태 이모지 8×2(A4 · R13 #emoji) · 탭바 메일 점(B24)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, act } from '@testing-library/react'
import { renderInRouter } from '../ui/helpers'

const api = vi.hoisted(() => ({
  handler: (_url: string, _opts?: any): any => ({}),
  calls: [] as Array<{ url: string; opts?: any }>,
}))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts?: any) => { api.calls.push({ url, opts }); return api.handler(url, opts) }
  return { ...real, $fetch: Object.assign(fake, { raw: fake, native: fetch, create: () => fake }) }
})

const { i18n } = await import('~/i18n')
const { chatStore, handleWSMessage } = await import('~/composables/useChat')
const { ChatMessage } = await import('~/components/chat/ChatMessage')
const { setUser } = await import('~/composables/useAuth')
const { userPrefsStore, pushStatusEmojiRecent, fromServer, toServer } = await import('~/composables/useUserPrefs')
const { statusEmojiCells, STATUS_EMOJIS } = await import('~/utils/myStatus')
const { LayoutUserMenu } = await import('~/components/layout/UserMenu')
const { inboxUnread, mailUnreadStore } = await import('~/composables/useMailUnread')
const { mailStore } = await import('~/composables/useMail')
const { UiTabbar } = await import('~/components/ui/Tabbar')

const t = (k: string, p?: any) => i18n.t(k, p)

const PREVIEW = {
  url: 'https://blog.example.dev/zero-downtime-postgres',
  site: 'blog.example.dev',
  title: '무중단 Postgres 마이그레이션 체크리스트',
  description: '잠금 없는 인덱스 생성, 컬럼 추가 순서.',
  image: '/api/chat/link-preview/images/' + 'a'.repeat(64),
}
const msg = (p: any = {}) => ({
  id: 'm1', channel_id: 'c1', sender: { id: 'u2', username: 'lee', display_name: '이도윤', avatar_url: null },
  content: '읽어 주세요 https://blog.example.dev/zero-downtime-postgres', message_type: 'text', file_meta: null,
  parent_id: null, reply_count: 0, is_edited: false, is_deleted: false,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), link_preview: PREVIEW, ...p,
})

beforeEach(() => {
  try { localStorage.removeItem('ws.prefs') } catch {}
  api.calls = []
  api.handler = () => ({})
  setUser({ id: 'u1', username: 'kim', display_name: '김서연', email: '', is_admin: false } as any)
  userPrefsStore.setState({ prefs: { ...userPrefsStore.getState().prefs, chatLinkPreview: true, statusEmojiRecent: [] } })
})

describe('링크 미리보기 카드(B12 · R13 #link)', () => {
  it('사이트 → 제목 → 설명 → 서버 프록시 썸네일, 카드는 새 창 링크', () => {
    renderInRouter(<ChatMessage message={msg() as any} grouped={false} isOwn={false} />)
    const card = screen.getByRole('group', { name: t('chat.message.linkPreview') })
    expect(card.style.maxWidth).toBe('520px')
    expect(card.textContent).toContain('blog.example.dev')
    expect(card.textContent).toContain(PREVIEW.title)
    expect(card.textContent).toContain(PREVIEW.description)
    const a = card.querySelector('a')!
    expect(a.getAttribute('href')).toBe(PREVIEW.url)
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toContain('noopener')
    const img = card.querySelector('img')!
    expect(img.getAttribute('src')).toBe(PREVIEW.image)   // 외부 주소가 아니라 서버 경로
    expect(img.parentElement!.className).toContain('w-28')
    // 남의 메시지 — ✕ 없음
    expect(screen.queryByRole('button', { name: t('chat.message.removePreview') })).toBeNull()
  })

  it('썸네일이 없으면 칸째 없음', () => {
    renderInRouter(<ChatMessage message={msg({ link_preview: { ...PREVIEW, image: null, description: null } }) as any} grouped={false} isOwn={false} />)
    const card = screen.getByRole('group', { name: t('chat.message.linkPreview') })
    expect(card.querySelector('img')).toBeNull()
    expect(card.querySelector('.w-28')).toBeNull()
  })

  it('받는 쪽 설정을 끄면 카드 없이 링크만', () => {
    userPrefsStore.setState({ prefs: { ...userPrefsStore.getState().prefs, chatLinkPreview: false } })
    renderInRouter(<ChatMessage message={msg() as any} grouped={false} isOwn={false} />)
    expect(screen.queryByRole('group', { name: t('chat.message.linkPreview') })).toBeNull()
  })

  it('보낸 사람만 ✕ — 누르면 DELETE 하고 카드가 빠진다', async () => {
    chatStore.setState({ messages: [msg({ sender: { id: 'u1', username: 'kim', display_name: '김서연', avatar_url: null } }) as any] })
    api.handler = () => ({ ok: true })
    renderInRouter(<ChatMessage message={chatStore.getState().messages[0]} grouped={false} isOwn />)
    fireEvent.click(screen.getByRole('button', { name: t('chat.message.removePreview') }))
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/chat/messages/m1/link-preview' && c.opts?.method === 'DELETE')).toBe(true))
    expect(chatStore.getState().messages[0].link_preview).toBeNull()
  })

  it('모바일 길게 눌러 시트: 보낸 사람 + 미리보기 있을 때만 "미리보기 지우기"가 "수정" 바로 아래(핸드오프 15-5)', async () => {
    const own = msg({ sender: { id: 'u1', username: 'kim', display_name: '김서연', avatar_url: null } })
    chatStore.setState({ messages: [own as any] })
    api.handler = () => ({ ok: true })
    const longPress = async (el: Element) => {
      vi.useFakeTimers()
      try {
        fireEvent.touchStart(el)
        act(() => { vi.advanceTimersByTime(600) })
      } finally { vi.useRealTimers() }
      return screen.findByRole('dialog', { name: t('chat.message.sheetTitle') })
    }
    const labels = (d: HTMLElement) => [...d.querySelectorAll('button')].map(b => b.textContent)

    // 남의 메시지 — 없음
    const other = renderInRouter(<ChatMessage message={msg() as any} grouped={false} isOwn={false} />)
    let sheet = await longPress(document.querySelector(".chat-body")!)
    expect(labels(sheet)).not.toContain(t('chat.message.removePreview'))
    other.unmount()

    // 내 메시지인데 미리보기 없음 — 없음
    const noPrev = renderInRouter(<ChatMessage message={{ ...own, link_preview: null } as any} grouped={false} isOwn />)
    sheet = await longPress(document.querySelector(".chat-body")!)
    expect(labels(sheet)).not.toContain(t('chat.message.removePreview'))
    noPrev.unmount()

    // 내 메시지 + 미리보기 — "수정" 바로 아래
    renderInRouter(<ChatMessage message={chatStore.getState().messages[0]} grouped={false} isOwn />)
    sheet = await longPress(document.querySelector(".chat-body")!)
    const ls = labels(sheet)
    expect(ls[ls.indexOf(t('common.edit')) + 1]).toBe(t('chat.message.removePreview'))
    fireEvent.click([...sheet.querySelectorAll('button')].find(b => b.textContent === t('chat.message.removePreview'))!)
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/chat/messages/m1/link-preview' && c.opts?.method === 'DELETE')).toBe(true))
    expect(chatStore.getState().messages[0].link_preview).toBeNull()
  })

  it('WS link_preview 이벤트가 그 메시지의 카드만 바꾼다(다른 필드 유지)', () => {
    chatStore.setState({
      messages: [msg({ link_preview: null, reactions: [{ emoji: '👍', count: 1, user_ids: ['u2'], reacted: false }] }) as any],
      threadMessages: [], savedMessages: [], pins: [], threadParent: null,
    })
    act(() => handleWSMessage({ type: 'link_preview', message_id: 'm1', channel_id: 'c1', parent_id: null, link_preview: PREVIEW }))
    const m = chatStore.getState().messages[0]
    expect(m.link_preview).toEqual(PREVIEW)
    expect(m.reactions).toHaveLength(1)
    act(() => handleWSMessage({ type: 'link_preview', message_id: 'm1', channel_id: 'c1', parent_id: null, link_preview: null }))
    expect(chatStore.getState().messages[0].link_preview).toBeNull()
  })
})

describe('상태 메시지 이모지 8×2(A4 · R13 #emoji)', () => {
  it('최근 쓴 것이 앞, 남은 칸은 기본 추천으로 채워 16칸', () => {
    expect(statusEmojiCells([])).toEqual(STATUS_EMOJIS.slice(0, 16))
    const cells = statusEmojiCells(['🧪', '🎧'])
    expect(cells).toHaveLength(16)
    expect(cells.slice(0, 2)).toEqual(['🧪', '🎧'])
    expect(new Set(cells).size).toBe(16)
  })

  it('최근 목록: 맨 앞으로·중복 제거·최대 8, 서버 키 왕복', () => {
    for (const e of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) pushStatusEmojiRecent(e)
    pushStatusEmojiRecent('5')
    expect(userPrefsStore.getState().prefs.statusEmojiRecent).toEqual(['5', '9', '8', '7', '6', '4', '3', '2'])
    expect(fromServer('statusEmojiRecent', ['a', 3, '', 'b'])).toEqual(['a', 'b'])
    expect(fromServer('statusEmojiRecent', 'x')).toBeUndefined()
    expect(toServer('statusEmojiRecent', [])).toBeNull()
  })

  it('이모지 버튼 → 상자 "최근 · 자주 쓰는" + 16칸, 고른 칸 bg-accent ring-primary, 저장하면 최근에 들어간다', async () => {
    chatStore.setState({ myStatus: { mode: 'auto', custom_text: '집중 근무 중', custom_emoji: '🎧', custom_expires_at: null, dnd_until: null, state: 'online' } as any })
    api.handler = (url, opts) => (url === '/api/chat/me/status' && opts?.method === 'PUT' ? { mode: 'auto', state: 'online', ...opts.body } : {})
    renderInRouter(<LayoutUserMenu />)
    fireEvent.click(screen.getByRole('menuitem', { name: /집중 근무 중/ }))
    const panel = await screen.findByRole('menu', { name: t('shell.userMenu.statusTitle') })
    const pick = screen.getByRole('button', { name: t('shell.userMenu.pickEmoji') })
    fireEvent.click(pick)
    expect(pick.getAttribute('aria-pressed')).toBe('true')
    expect(panel.textContent).toContain(t('shell.userMenu.emojiRecent'))
    const grid = screen.getByRole('group', { name: t('shell.userMenu.pickEmoji') })
    expect(grid.className).toContain('grid-cols-8')
    const cells = grid.querySelectorAll('button')
    expect(cells).toHaveLength(16)
    const cur = grid.querySelector('[aria-pressed="true"]')!
    expect(cur.textContent).toBe('🎧')
    expect(cur.className).toContain('bg-accent')
    expect(cur.className).toContain('ring-primary')
    fireEvent.click(screen.getByRole('button', { name: '🚀' }))
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }))
    await waitFor(() => expect(userPrefsStore.getState().prefs.statusEmojiRecent[0]).toBe('🚀'))
  })
})

describe('탭바 메일 안 읽음 점(B24)', () => {
  it('받은편지함 unread_count 합', () => {
    expect(inboxUnread([{ role: 'inbox', unread_count: 3 }, { role: 'sent', unread_count: 9 }, { role: 'inbox', unread_count: 2 }])).toBe(5)
    expect(inboxUnread([])).toBe(0)
  })

  it('메일 화면이 기본 계정 메일함 수를 고치면 셸 수가 따라간다', async () => {
    const { ensureMailUnread } = await import('~/composables/useMailUnread')
    api.handler = (url) => (url === '/api/mail/mailboxes' ? { mailboxes: [{ id: 'INBOX', name: 'x', role: 'inbox', unread_count: 4, total_count: 9, sort_order: 0 }] } : {})
    ensureMailUnread()
    mailStore.setState({ accounts: [], selectedAccountId: null, mailboxes: [{ id: 'INBOX', name: 'x', role: 'inbox', unread_count: 2, total_count: 9 } as any] })
    expect(mailUnreadStore.getState().count).toBe(2)
  })

  it('점 칸: 숫자 없이 7px 점 + 접근성 이름', () => {
    renderInRouter(<UiTabbar tabs={[{ id: 'mail', label: '메일', icon: 'mail', dot: true, dotLabel: t('shell.tab.mailUnread', { n: 3 }) }]} />)
    expect(screen.getByRole('img', { name: t('shell.tab.mailUnread', { n: 3 }) })).toBeTruthy()
  })
})
