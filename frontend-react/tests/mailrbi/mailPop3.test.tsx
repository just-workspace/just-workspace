// POP3 계정 — 서버에 폴더가 없어 이동·보관·스팸·폴더 생성 불가. 해당 버튼·메뉴·스와이프·단축키 진입을 숨기고,
// POP3 에서도 가능한 동작(읽음·삭제·별표)은 유지한다. IMAP 계정은 변경 없음.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, act, waitFor } from '@testing-library/react'
import { renderInRouter } from '../ui/helpers'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts: any }[],
  handler: (_url: string, _opts: any): any => ({}),
}))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts: any = {}) => { api.calls.push({ url, opts }); return api.handler(url, opts) }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { mailStore, _resetMailStore, mailIsPop3 } = await import('~/composables/useMail')
const { setUser } = await import('~/composables/useAuth')
const { MailList } = await import('~/components/mail/MailList')
const { MailReader } = await import('~/components/mail/MailReader')
const { MailSidebar } = await import('~/components/mail/MailSidebar')

const INBOX = { id: 'INBOX', name: '받은편지함', role: 'inbox', unread_count: 1, total_count: 2, sort_order: 0 }
const ARCHIVE = { id: 'Archive', name: 'Archive', role: 'archive', unread_count: 0, total_count: 0, sort_order: 5 }
const JUNK = { id: 'Junk', name: 'Junk', role: 'junk', unread_count: 0, total_count: 0, sort_order: 6 }
const row = (id: string, o: Record<string, unknown> = {}) => ({
  id, thread_id: null, mailbox_ids: ['INBOX'], from_: [{ name: '김', email: 'k@x.io' }], to: [], subject: `제목 ${id}`, preview: null,
  received_at: null, is_unread: true, is_flagged: false, has_attachment: false, ...o,
})
const detail = (o: Record<string, unknown> = {}) => ({
  ...row('1'), cc: [], bcc: [], reply_to: [], text_body: '본문', html_body: null, attachments: [],
  disposition_notification_to: null, mdn_sent: false, ...o,
})

function seed(protocol: 'imap' | 'pop3', extra: Record<string, unknown> = {}) {
  mailStore.setState({
    accounts: [{ id: 'a1', email: 'me@ext.io', display_name: '외부', is_default: true, protocol }] as any,
    selectedAccountId: 'a1',
    // POP3 는 받은편지함 하나(pop3_client.list_mailboxes), IMAP 은 보관함·스팸함이 있다
    mailboxes: (protocol === 'pop3' ? [INBOX] : [INBOX, ARCHIVE, JUNK]) as any,
    selectedMailboxId: 'INBOX',
    messages: [row('1'), row('2')] as any,
    totalMessages: 2,
    ...extra,
  })
}

beforeEach(() => {
  _resetMailStore()
  api.calls = []
  api.handler = (url) => {
    if (url === '/api/mail/messages') return { messages: [], total: 0 }
    if (url === '/api/mail/mailboxes') return { mailboxes: mailStore.getState().mailboxes }
    if (url === '/api/mail/labels') return { labels: [], supported: false }
    if (url === '/api/mail/scheduled') return []
    if (url.endsWith('/thread')) return { thread_id: null, messages: [] }
    if (url === '/api/mail/signatures') return []
    if (url === '/api/mail/signatures/default') return null
    if (url === '/api/mail/drafts') return []
    return {}
  }
  setUser({ id: 'u1', username: 'me', display_name: '나', email: 'me@example.com', primary_email: null } as any)
})

const posted = (url: string) => api.calls.filter(c => c.url === url && c.opts?.method === 'POST')

describe('mailIsPop3 — 지금 보는 계정의 수신 방식', () => {
  it('계정 목록의 protocol 로 판단한다(없으면 IMAP 으로 본다)', () => {
    seed('pop3')
    expect(mailIsPop3()).toBe(true)
    seed('imap')
    expect(mailIsPop3()).toBe(false)
    mailStore.setState({ accounts: [{ id: 'a1', email: 'x@x', is_default: true }] as any })
    expect(mailIsPop3()).toBe(false)
    // 복수 계정 — 선택된 계정만 확인
    mailStore.setState({ accounts: [{ id: 'a1', protocol: 'imap' }, { id: 'a2', protocol: 'pop3' }] as any, selectedAccountId: 'a2' })
    expect(mailIsPop3()).toBe(true)
  })
})

describe('MailList 선택 막대', () => {
  it('POP3: 보관·이동 버튼이 없고 읽음·삭제는 남는다', () => {
    seed('pop3', { selectedIds: new Set(['1']) })
    renderInRouter(<MailList />)
    const bar = screen.getByRole('toolbar')
    const names = Array.from(bar.querySelectorAll('button')).map(b => b.getAttribute('aria-label') || b.textContent || '')
    expect(names.some(n => n.startsWith('보관'))).toBe(false)
    expect(names).not.toContain('이동')
    expect(names).toContain('읽음으로 표시')
    expect(names).toContain('삭제 (Del)')
  })

  it('IMAP: 보관·이동 버튼이 그대로 있다', () => {
    seed('imap', { selectedIds: new Set(['1']) })
    renderInRouter(<MailList />)
    const bar = screen.getByRole('toolbar')
    const names = Array.from(bar.querySelectorAll('button')).map(b => b.getAttribute('aria-label') || '')
    expect(names).toContain('보관 (E)')
    expect(names).toContain('이동')
  })

  it('POP3: 단축키(E)가 부르는 bulk("archive")·bulk("spam") 은 서버에 아무것도 보내지 않는다 — 읽음은 보낸다', async () => {
    seed('pop3', { selectedIds: new Set(['1']) })
    let h: any = null
    renderInRouter(<MailList ref={(x: any) => { h = x }} />)
    await act(async () => { await h.bulk('archive'); await h.bulk('spam') })
    expect(posted('/api/mail/bulk')).toHaveLength(0)
    await act(async () => { await h.bulk('read') })
    expect(posted('/api/mail/bulk').map(c => c.opts.body.action)).toEqual(['read'])
  })

  it('IMAP: bulk("archive") 는 보관함으로 이동을 보낸다', async () => {
    seed('imap', { selectedIds: new Set(['1']) })
    let h: any = null
    renderInRouter(<MailList ref={(x: any) => { h = x }} />)
    await act(async () => { await h.bulk('archive') })
    const sent = posted('/api/mail/bulk')
    expect(sent).toHaveLength(1)
    expect(sent[0].opts.body).toMatchObject({ action: 'move', mailbox_id: 'Archive', message_ids: ['1'] })
  })
})

describe('MailList 모바일 스와이프', () => {
  function swipe(el: Element, dx: number) {
    fireEvent.touchStart(el, { touches: [{ clientX: 200, clientY: 100 }] })
    fireEvent.touchMove(el, { touches: [{ clientX: 200 + dx / 2, clientY: 100 }] })
    fireEvent.touchMove(el, { touches: [{ clientX: 200 + dx, clientY: 100 }] })
  }
  const rowEl = (subject: string) => screen.getByText(subject).closest('[role="listitem"]')!.querySelector('.group')!

  it('POP3: 왼쪽으로 밀어도 보관 칸이 드러나지 않고 이동 요청도 없다 — 오른쪽(읽음 전환)은 된다', async () => {
    seed('pop3')
    renderInRouter(<MailList />)
    const el = rowEl('제목 1')
    swipe(el, -140)
    expect((el as HTMLElement).style.transform).toBe('')
    expect(screen.queryByText('보관')).toBeNull()
    await act(async () => { fireEvent.touchEnd(el) })
    expect(posted('/api/mail/bulk')).toHaveLength(0)
    swipe(el, 140)
    expect((el as HTMLElement).style.transform).toContain('translateX(')
    await act(async () => { fireEvent.touchEnd(el) })
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/mail/messages/1' && c.opts?.method === 'PATCH')).toBe(true))
  })

  it('IMAP: 왼쪽으로 밀면 보관 칸이 드러나고 놓으면 보관함으로 이동', async () => {
    seed('imap')
    renderInRouter(<MailList />)
    const el = rowEl('제목 1')
    swipe(el, -140)
    expect(screen.getByText('보관')).toBeTruthy()
    await act(async () => { fireEvent.touchEnd(el) })
    await waitFor(() => expect(posted('/api/mail/bulk')).toHaveLength(1))
    expect(posted('/api/mail/bulk')[0].opts.body).toMatchObject({ action: 'move', mailbox_id: 'Archive' })
  })
})

describe('MailReader 툴바·더보기', () => {
  function open(protocol: 'imap' | 'pop3') {
    seed(protocol, { selectedMessage: detail() as any })
    let h: any = null
    let mobile: any[] = []
    renderInRouter(<MailReader ref={(x: any) => { h = x }} onMobileMoreItems={(m) => { mobile = m }} />)
    return { handle: () => h, mobile: () => mobile }
  }

  it('POP3: 보관 버튼·"스팸으로" 메뉴(데스크톱·모바일)가 없고 삭제·안 읽음은 남는다', async () => {
    const r = open('pop3')
    await waitFor(() => expect(screen.getByRole('button', { name: '삭제 (Del)' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: /^보관/ })).toBeNull()
    expect(screen.getByRole('button', { name: '읽지 않음으로 (U)' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '더보기 — 스팸·원문·인쇄' }))
    expect(screen.queryByText('스팸으로')).toBeNull()
    expect(screen.getByText('별표')).toBeTruthy()
    await waitFor(() => expect(r.mobile().length).toBeGreaterThan(0))
    expect(r.mobile().map((m: any) => m.key)).not.toContain('spam')
    expect(r.mobile().map((m: any) => m.key)).toContain('delete')
  })

  it('POP3: 단축키·모바일 상단 바가 부르는 archive()·spam() 은 서버에 아무것도 보내지 않는다', async () => {
    const r = open('pop3')
    await waitFor(() => expect(r.handle()).toBeTruthy())
    await act(async () => { await r.handle().archive(); await r.handle().spam(); r.handle().onMore('spam') })
    expect(posted('/api/mail/bulk')).toHaveLength(0)
  })

  it('IMAP: 보관 버튼·"스팸으로" 가 그대로 있고 스팸은 bulk spam 을 보낸다', async () => {
    const r = open('imap')
    await waitFor(() => expect(screen.getByRole('button', { name: '보관 (E)' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '더보기 — 스팸·원문·인쇄' }))
    expect(screen.getByText('스팸으로')).toBeTruthy()
    await waitFor(() => expect(r.mobile().map((m: any) => m.key)).toContain('spam'))
    await act(async () => { await r.handle().spam() })
    expect(posted('/api/mail/bulk').map(c => c.opts.body.action)).toEqual(['spam'])
  })
})

describe('MailSidebar 폴더 만들기', () => {
  it('POP3: "편지함 추가" 버튼이 없다', () => {
    seed('pop3')
    renderInRouter(<MailSidebar />)
    expect(screen.getByText('받은편지함')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '편지함 추가' })).toBeNull()
  })
  it('IMAP: "편지함 추가" 버튼이 있다', () => {
    seed('imap')
    renderInRouter(<MailSidebar />)
    expect(screen.getByRole('button', { name: '편지함 추가' })).toBeTruthy()
  })
})
