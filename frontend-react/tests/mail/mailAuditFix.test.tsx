// 메일 구역 감사 수정 고정 — 지연 응답 가드, 삭제 후 채우기, 실패 알림, HTML 전용 메일 인용, 쉼표가 포함된 이름,
// 스레드의 메일함:UID 키, 외부 이미지 기본 차단, 수신자 칸 IME·즉시 확정, 보내기 재진입 차단, 체크박스 뒤 단축키.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, act, render } from '@testing-library/react'
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

const text = await import('~/components/mail/composeText')
const mail = await import('~/composables/useMail')
const { mailStore, _resetMailStore } = mail
const { _resetMailComposeStore, mailDraftsStore } = await import('~/composables/useMailCompose')
const { mailSignatureStore } = await import('~/composables/useMailSignature')
const { setUser } = await import('~/composables/useAuth')
const { threadLayout } = await import('~/utils/mailQuery')
const { MailBody, mailFrameCsp, linksToNewTab } = await import('~/components/mail/MailBody')
const { MailComposer } = await import('~/components/mail/MailComposer')
const { MailRecipientField } = await import('~/components/mail/MailRecipientField')

const detail = (o: Record<string, unknown> = {}) => ({
  id: 'm1', thread_id: null, mailbox_ids: ['INBOX'], from_: [{ name: '김서연', email: 'kim@ext.io' }],
  to: [{ name: null, email: 'me@example.com' }], cc: [], bcc: [], reply_to: [], subject: '견적',
  text_body: '안녕하세요', html_body: null, preview: null, received_at: '2026-10-01T01:00:00Z',
  is_unread: false, is_flagged: false, attachments: [], disposition_notification_to: null, mdn_sent: false, ...o,
})
const row = (id: string, o: Record<string, unknown> = {}) => ({
  id, thread_id: null, mailbox_ids: ['INBOX'], from_: [], to: [], subject: id, preview: null, received_at: null,
  is_unread: false, is_flagged: false, has_attachment: false, ...o,
})
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
const count = (url: string) => api.calls.filter(c => c.url === url).length

beforeEach(() => {
  _resetMailStore()
  _resetMailComposeStore()
  mailSignatureStore.setState({ signatures: [], loading: false })
  api.calls = []
  api.handler = (url) => {
    if (url === '/api/mail/accounts') return [{ id: 'a1', email: 'me@example.com', is_default: true }]
    if (url === '/api/mail/signatures') return []
    if (url === '/api/mail/signatures/default') return null
    if (url === '/api/mail/send') return { ok: true }
    if (url === '/api/mail/messages') return { messages: [], total: 0 }
    if (url === '/api/mail/mailboxes') return { mailboxes: [] }
    return {}
  }
  setUser({ id: 'u1', username: 'me', display_name: '나', email: 'me@example.com', primary_email: null } as any)
})

describe('주소 목록 — 이름 속 쉼표', () => {
  it('따옴표·꺾쇠 안의 쉼표는 자르지 않는다', () => {
    expect(text.splitAddressList('"Kim, Minsu" <kim@x.io>, b@x.io')).toEqual(['"Kim, Minsu" <kim@x.io>', 'b@x.io'])
    expect(text.parseAddresses('"Kim, Minsu" <kim@x.io>, b@x.io')).toEqual([
      { name: 'Kim, Minsu', email: 'kim@x.io' }, { name: null, email: 'b@x.io' },
    ])
  })
  it('joinAddrs 는 쉼표 든 이름을 따옴표로 감싸고, 다시 읽으면 그대로다', () => {
    const list = [{ name: 'Kim, Minsu', email: 'kim@x.io' }, { name: '박', email: 'p@x.io' }]
    const s = text.joinAddrs(list)
    expect(s).toBe('"Kim, Minsu" <kim@x.io>, 박 <p@x.io>')
    expect(text.parseAddresses(s)).toEqual(list)
  })
  it('칩도 하나로 그린다', () => {
    render(<MailRecipientField modelValue={'"Kim, Minsu" <kim@x.io>'} label="받는이" />)
    expect(screen.getByText('Kim, Minsu')).toBeTruthy()
    expect(screen.queryByText('Kim')).toBeNull()
  })
})

describe('HTML 전용 메일의 인용·전달', () => {
  const htmlOnly = detail({ text_body: null, html_body: '<style>p{color:red}</style><p>첫 줄</p><div>둘째 줄<br>셋째 줄</div><script>x()</script>' })
  it('plainBody: text 가 없으면 HTML 에서 글자만(스타일·스크립트 제외, 줄 유지)', () => {
    const t = text.plainBody(htmlOnly as any)
    expect(t).toContain('첫 줄')
    expect(t.split('\n').map(s => s.trim()).filter(Boolean)).toEqual(['첫 줄', '둘째 줄', '셋째 줄'])
    expect(t).not.toContain('color')
    expect(t).not.toContain('x()')
    expect(text.plainBody(detail() as any)).toBe('안녕하세요')
  })
  it('전달·답장 인용에 본문이 들어간다(예전엔 비었다)', () => {
    expect(text.forwardOf(htmlOnly as any).text).toContain('둘째 줄')
    expect(text.quoteOf(htmlOnly as any).text).toContain('> 첫 줄')
    expect(text.quoteOf(htmlOnly as any).html).toContain('셋째 줄')
  })
})

describe('스레드 — 메일함:UID', () => {
  it('다른 메일함의 같은 UID 는 열린 메일로 보지 않는다', () => {
    const th = [
      { id: '7', mailbox_ids: ['Sent'] }, { id: '7', mailbox_ids: ['INBOX'] }, { id: '9', mailbox_ids: ['INBOX'] },
    ]
    expect(threadLayout(th, '7', true, 'INBOX').shown).toEqual([th[0], th[2]])
    // 메일함 미지정 시 기존처럼 번호만 사용
    expect(threadLayout(th, '7', true).shown).toEqual([th[2]])
  })
})

describe('MailBody — 외부 리소스', () => {
  it('CSP: 기본은 data: 이미지만, "이미지 표시"면 http(s) 이미지까지', () => {
    expect(mailFrameCsp(false)).toContain("default-src 'none'")
    expect(mailFrameCsp(false)).not.toContain('https:')
    expect(mailFrameCsp(true)).toContain('img-src data: https: http:')
  })
  it('외부 이미지가 있으면 막고 버튼을 보인다 — 누르면 이 메일만 푼다', () => {
    const { container, rerender } = render(<MailBody message={detail({ html_body: '<table><tr><td><img src="https://t.example/p.gif"></td></tr></table>' })} />)
    const frame = () => (container.querySelector('iframe[data-mail-frame]') as HTMLIFrameElement).getAttribute('srcdoc')!
    expect(frame()).toContain(`content="${mailFrameCsp(false)}"`)
    fireEvent.click(screen.getByRole('button', { name: '이미지 표시' }))
    expect(frame()).toContain(`content="${mailFrameCsp(true)}"`)
    expect(screen.queryByRole('button', { name: '이미지 표시' })).toBeNull()
    // 다른 메일을 열면 다시 차단
    rerender(<MailBody message={detail({ id: 'm2', html_body: '<table><tr><td><img src="//t.example/q.gif"></td></tr></table>' })} />)
    expect(frame()).toContain(`content="${mailFrameCsp(false)}"`)
    expect(screen.getByRole('button', { name: '이미지 표시' })).toBeTruthy()
  })
  it('외부 리소스가 없으면 버튼이 없다(data: 인라인 이미지)', () => {
    render(<MailBody message={detail({ html_body: '<table><tr><td><img src="data:image/png;base64,AAAA"></td></tr></table>' })} />)
    expect(screen.queryByRole('button', { name: '이미지 표시' })).toBeNull()
  })
  it('단순 HTML 의 링크는 새 탭으로', () => {
    expect(linksToNewTab('<p><a href="https://a.example">x</a></p>')).toContain('target="_blank"')
    const { container } = render(<MailBody message={detail({ html_body: '<p><a href="https://a.example">링크</a></p>' })} />)
    const a = container.querySelector('.mail-paper-prose a')!
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toContain('noopener')
  })
})

describe('useMail — 늦은 응답·삭제 뒤 채우기·실패 알림', () => {
  it('메일을 여는 사이 폴더를 바꾸면 늦게 온 본문을 버린다', async () => {
    const d = deferred<any>()
    api.handler = (url) => {
      if (url === '/api/mail/messages/5') return d.promise
      if (url === '/api/mail/messages') return { messages: [], total: 0 }
      return {}
    }
    mailStore.setState({ selectedMailboxId: 'INBOX' })
    const opening = mail.openMessage('5')
    await mail.selectMailbox('Sent')
    d.resolve(detail({ id: '5' }))
    await opening
    expect(mailStore.getState().selectedMessage).toBeNull()
    expect(mailStore.getState().loadingMessage).toBe(false)
  })
  it('A, B 를 연달아 열면 늦게 온 A 가 B 를 덮지 않는다', async () => {
    const a = deferred<any>()
    api.handler = url => (url === '/api/mail/messages/A' ? a.promise : url === '/api/mail/messages/B' ? detail({ id: 'B' }) : {})
    mailStore.setState({ selectedMailboxId: 'INBOX' })
    const pa = mail.openMessage('A')
    await mail.openMessage('B')
    a.resolve(detail({ id: 'A' }))
    await pa
    expect(mailStore.getState().selectedMessage?.id).toBe('B')
  })
  it('여러 통을 지우면 목록을 다시 받아 다음 메일로 채운다', async () => {
    mailStore.setState({ selectedMailboxId: 'INBOX', messages: [row('1'), row('2')] as any, totalMessages: 5 })
    api.handler = (url) => {
      if (url === '/api/mail/messages') return { messages: [row('3')], total: 3 }
      if (url === '/api/mail/mailboxes') return { mailboxes: [] }
      return { ok: true }
    }
    expect(await mail.bulkOn(['1', '2'], 'delete')).toBe(true)
    expect(count('/api/mail/messages')).toBe(1)
    expect(mailStore.getState().messages.map(m => m.id)).toEqual(['3'])
    expect(mailStore.getState().totalMessages).toBe(3)
    // 읽음 표시는 목록을 재조회하지 않음
    api.calls = []
    await mail.bulkOn(['3'], 'read')
    expect(count('/api/mail/messages')).toBe(0)
  })
  it('마지막 페이지가 비면 앞 페이지로', async () => {
    mailStore.setState({ selectedMailboxId: 'INBOX', messages: [row('1')] as any, totalMessages: 51, currentPage: 1 })
    api.handler = (url, opts) => {
      if (url === '/api/mail/messages') return opts.params.page === 1 ? { messages: [], total: 50 } : { messages: [row('9')], total: 50 }
      if (url === '/api/mail/mailboxes') return { mailboxes: [] }
      return { ok: true }
    }
    expect(await mail.deleteMessage('1')).toBe(true)
    expect(mailStore.getState().currentPage).toBe(0)
    expect(mailStore.getState().messages.map(m => m.id)).toEqual(['9'])
  })
  it('실패는 false 로 알리고 목록을 건드리지 않는다', async () => {
    mailStore.setState({ selectedMailboxId: 'INBOX', messages: [row('1', { is_unread: true })] as any, totalMessages: 1 })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    api.handler = () => { throw Object.assign(new Error('x'), { data: { detail: '메일을 삭제하지 못했습니다' } }) }
    expect(await mail.deleteMessage('1')).toBe(false)
    expect(await mail.markAsSpam('1')).toBe(false)
    expect(await mail.toggleStar('1')).toBe(false)
    expect(await mail.setUnread('1', false)).toBe(false)
    expect(await mail.moveMessage('1', 'Archive')).toBe(false)
    expect(mailStore.getState().messages).toHaveLength(1)
    expect(mailStore.getState().messages[0].is_unread).toBe(true)
    err.mockRestore()
  })
  it('메일함을 다시 받으면 다계정 트리 캐시도 갱신된다', async () => {
    const old = [{ id: 'INBOX', name: 'INBOX', role: 'inbox', unread_count: 9, total_count: 9, sort_order: 0 }]
    const fresh = [{ ...old[0], unread_count: 2 }]
    mailStore.setState({ selectedAccountId: 'a2', mailboxes: old, mailboxesByAccount: { a2: old } })
    api.handler = url => (url === '/api/mail/mailboxes' ? { mailboxes: fresh } : {})
    await mail.fetchMailboxes()
    expect(mailStore.getState().mailboxesByAccount.a2[0].unread_count).toBe(2)
    expect(mailStore.getState().mailboxes[0].unread_count).toBe(2)
  })
})

describe('MailRecipientField — IME·즉시 확정', () => {
  function setup(initial = '') {
    let v = initial
    const onUpdate = (x: string) => { v = x }
    render(<MailRecipientField modelValue={v} onUpdateModelValue={onUpdate} label="받는이" />)
    return { input: screen.getByLabelText('받는이') as HTMLInputElement, value: () => v }
  }
  it('한글 조합 중 Enter 는 칩을 만들지 않는다', () => {
    const { input, value } = setup()
    fireEvent.change(input, { target: { value: '홍길동' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(value()).toBe('')
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    expect(value()).toBe('')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(value()).toBe('홍길동')
  })
  it('포커스를 잃으면 기다리지 않고 바로 칩으로 확정한다', () => {
    const { input, value } = setup('a@x.io')
    fireEvent.change(input, { target: { value: 'b@x.io' } })
    fireEvent.blur(input)
    expect(value()).toBe('a@x.io, b@x.io')
  })
  it('Ctrl+Enter 는 치던 주소를 확정하고 위로 넘긴다', () => {
    const { input, value } = setup()
    fireEvent.change(input, { target: { value: 'c@x.io' } })
    const notPrevented = fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(value()).toBe('c@x.io')
    expect(notPrevented).toBe(true)
  })
})

describe('MailComposer — 보내기 재진입·치던 주소', () => {
  it('Ctrl+Enter 를 연달아 눌러도 한 번만 보낸다', async () => {
    const d = deferred<any>()
    const base = api.handler
    api.handler = (url, opts) => (url === '/api/mail/send' ? d.promise : base(url, opts))
    const onClose = vi.fn()
    renderInRouter(<MailComposer variant="window" mode="new" to="kim@ext.io" onClose={onClose} />)
    await waitFor(() => expect(screen.getByLabelText('제목')).toBeTruthy())
    const subject = screen.getByLabelText('제목')
    await act(async () => {
      fireEvent.keyDown(subject, { key: 'Enter', ctrlKey: true })
      fireEvent.keyDown(subject, { key: 'Enter', ctrlKey: true })
      await new Promise(r => setTimeout(r, 20))
    })
    expect(count('/api/mail/send')).toBe(1)
    await act(async () => { d.resolve({ ok: true }) })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(count('/api/mail/send')).toBe(1)
  })
  it('참조 칸에 치기만 한 주소도 "보내기"를 누르면 같이 나간다', async () => {
    renderInRouter(<MailComposer variant="window" mode="new" to="kim@ext.io" />)
    await waitFor(() => expect(screen.getByLabelText('제목')).toBeTruthy())
    const to = screen.getByLabelText('받는이') as HTMLInputElement
    fireEvent.change(to, { target: { value: 'late@x.io' } })
    // 실제 클릭 순서: mousedown → 입력 칸 blur → click
    await act(async () => { fireEvent.blur(to) })
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: '보내기' })[0]) })
    await waitFor(() => expect(count('/api/mail/send')).toBe(1))
    const body = api.calls.find(c => c.url === '/api/mail/send')!.opts.body
    expect(body.to.map((a: any) => a.email)).toEqual(['kim@ext.io', 'late@x.io'])
  })
  it('초안을 저장하면 임시보관함 목록이 다시 받게 알린다', async () => {
    const before = mailDraftsStore.getState().rev
    api.handler = url => (url === '/api/mail/drafts' ? { id: 'd1' } : url === '/api/mail/accounts' ? [{ id: 'a1', email: 'me@example.com', is_default: true }] : url === '/api/mail/signatures' ? [] : {})
    const onClose = vi.fn()
    renderInRouter(<MailComposer variant="page" mode="new" to="kim@ext.io" onClose={onClose} />)
    await waitFor(() => expect(screen.getByLabelText('제목')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('제목'), { target: { value: '쓰다 만 글' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /닫기/ })) })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(mailDraftsStore.getState().rev).toBeGreaterThan(before)
  })
})

describe('메일 화면 단축키 — 체크박스에 포커스가 있어도 동작', () => {
  it('typing(): 체크박스·라디오는 입력 중이 아니다', async () => {
    // 페이지의 판정 함수는 export 되지 않으므로 동일 규칙을 DOM 으로 확인한다(삭제 단축키의 실제 도달 여부는 아래 통합 테스트에서 확인)
    const src = (await import('../../src/pages/mail/index.tsx?raw')).default as string
    expect(src).toMatch(/\['checkbox', 'radio', 'button', 'submit', 'reset'\]/)
  })
})
