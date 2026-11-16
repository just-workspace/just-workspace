// POP3 계정 — 메일 화면의 보관 단축키(E)와 모바일 본문 상단 바의 보관 버튼.
// POP3 는 보관함이 없어 E 를 처리하지 않고(서버 호출 없음) 버튼도 렌더링하지 않는다. IMAP 은 변경 없음.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

const api = vi.hoisted(() => ({ calls: [] as { url: string; opts: any }[], protocol: 'pop3' as 'imap' | 'pop3' }))
const INBOX = { id: 'INBOX', name: '받은편지함', role: 'inbox', unread_count: 1, total_count: 1, sort_order: 0 }
const ARCHIVE = { id: 'Archive', name: 'Archive', role: 'archive', unread_count: 0, total_count: 0, sort_order: 5 }
const ROW = {
  id: '1', thread_id: null, mailbox_ids: ['INBOX'], from_: [{ name: '김', email: 'k@x.io' }], to: [], subject: '견적서', preview: null,
  received_at: null, is_unread: false, is_flagged: false, has_attachment: false,
}
const DETAIL = { ...ROW, cc: [], bcc: [], reply_to: [], text_body: '본문', html_body: null, attachments: [], disposition_notification_to: null, mdn_sent: false }

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts: any = {}) => {
    api.calls.push({ url, opts })
    if (url === '/api/mail/accounts') return [{ id: 'a1', email: 'me@ext.io', display_name: '외부', is_default: true, protocol: api.protocol }]
    if (url === '/api/mail/mailboxes') return { mailboxes: api.protocol === 'pop3' ? [INBOX] : [INBOX, ARCHIVE] }
    if (url === '/api/mail/messages') return { messages: [ROW], total: 1 }
    if (url === '/api/mail/messages/1') return DETAIL
    if (url.endsWith('/thread')) return { thread_id: null, messages: [] }
    if (url === '/api/mail/labels') return { labels: [], supported: false }
    if (url === '/api/mail/scheduled' || url === '/api/mail/signatures' || url === '/api/mail/drafts') return []
    if (url === '/api/mail/signatures/default') return null
    return {}
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { default: MailPage } = await import('~/pages/mail/index')
const { default: MailMessagePage } = await import('~/pages/mail/[id]')
const { mailStore, _resetMailStore } = await import('~/composables/useMail')
const { isMobileStore } = await import('~/composables/useIsMobile')
const { setUser } = await import('~/composables/useAuth')

const bulkPosts = () => api.calls.filter(c => c.url === '/api/mail/bulk')

beforeEach(() => {
  _resetMailStore()
  api.calls = []
  setUser({ id: 'u1', username: 'qa', display_name: 'QA', email: 'me@example.com', primary_email: null } as any)
})

async function openList(protocol: 'imap' | 'pop3') {
  api.protocol = protocol
  isMobileStore.setState({ isMobile: false })
  const router = createMemoryRouter([{ path: '/mail', element: <MailPage /> }], { initialEntries: ['/mail'] })
  render(<RouterProvider router={router} />)
  await waitFor(() => expect(mailStore.getState().messages.length).toBe(1))
  // 1통 선택 — E 는 선택이 있으면 목록의 보관을 호출
  await act(async () => { mailStore.setState({ selectedIds: new Set(['1']) }) })
}

describe('메일 화면 단축키 E(보관)', () => {
  it('POP3: E 를 눌러도 서버에 보내지 않고 키도 먹지 않는다', async () => {
    await openList('pop3')
    const ev = new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true })
    await act(async () => { document.dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(false)
    expect(bulkPosts()).toHaveLength(0)
    expect(mailStore.getState().messages.length).toBe(1)
  })

  it('IMAP: E 는 선택한 메일을 보관함으로 옮긴다', async () => {
    await openList('imap')
    const ev = new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true })
    await act(async () => { document.dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(true)
    await waitFor(() => expect(bulkPosts()).toHaveLength(1))
    expect(bulkPosts()[0].opts.body).toMatchObject({ action: 'move', mailbox_id: 'Archive', message_ids: ['1'] })
  })
})

describe('모바일 본문 상단 바', () => {
  async function openMessage(protocol: 'imap' | 'pop3') {
    api.protocol = protocol
    isMobileStore.setState({ isMobile: true })
    const router = createMemoryRouter([{ path: '/mail/:id', element: <MailMessagePage /> }], { initialEntries: ['/mail/1?mailbox=INBOX&account=a1'] })
    render(<RouterProvider router={router} />)
    await waitFor(() => expect(mailStore.getState().selectedMessage?.id).toBe('1'))
    await waitFor(() => expect(mailStore.getState().accounts.length).toBe(1))
  }

  it('POP3: 보관 버튼이 없고 ⋯ 메뉴에 "스팸으로" 가 없다(삭제는 있다)', async () => {
    await openMessage('pop3')
    await waitFor(() => expect(screen.queryByRole('button', { name: '보관' })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '더보기 — 읽지 않음·스팸·삭제·원문 보기' }))
    expect(screen.queryByText('스팸으로')).toBeNull()
    expect(screen.getByText('삭제')).toBeTruthy()
  })

  it('IMAP: 보관 버튼과 "스팸으로" 가 있다', async () => {
    await openMessage('imap')
    expect(await screen.findByRole('button', { name: '보관' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '더보기 — 읽지 않음·스팸·삭제·원문 보기' }))
    expect(screen.getByText('스팸으로')).toBeTruthy()
  })
})
