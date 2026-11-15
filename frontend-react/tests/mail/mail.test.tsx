// 메일 모듈 — 작성 글 도우미, 본문 3경로, 작성기 보내기 본문(가짜 API — 실서버 발송 없음), 목록 행·칩, 작성 창 호스트
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
const { mailStore, _resetMailStore } = await import('~/composables/useMail')
const { mailComposeStore, _resetMailComposeStore, openCompose } = await import('~/composables/useMailCompose')
const { mailSignatureStore } = await import('~/composables/useMailSignature')
const { setUser } = await import('~/composables/useAuth')
const { MailBody } = await import('~/components/mail/MailBody')
const { MailComposer } = await import('~/components/mail/MailComposer')
const { MailList } = await import('~/components/mail/MailList')
const { MailComposeHost } = await import('~/components/mail/MailComposeHost')
const { MailRecipientField } = await import('~/components/mail/MailRecipientField')

const detail = (o: Record<string, unknown> = {}) => ({
  id: 'm1', thread_id: null, mailbox_ids: ['INBOX'], from_: [{ name: '김서연', email: 'kim@ext.io' }],
  to: [{ name: null, email: 'me@example.com' }, { name: '박', email: 'park@ext.io' }], cc: [{ name: null, email: 'lee@ext.io' }],
  bcc: [], reply_to: [], subject: '견적', text_body: '안녕하세요\n> 인용', html_body: null, preview: null,
  received_at: '2026-10-01T01:00:00Z', is_unread: false, is_flagged: false, attachments: [],
  disposition_notification_to: null, mdn_sent: false, ...o,
})

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

describe('composeText — 순수 함수', () => {
  it('parseAddresses: 이름<주소>·맨 주소, 틀린 형식은 버림', () => {
    expect(text.parseAddresses('"홍 길동" <hong@a.io>, b@c.io, nope')).toEqual([
      { name: '홍 길동', email: 'hong@a.io' }, { name: null, email: 'b@c.io' },
    ])
    expect(text.joinAddrs([{ name: 'A', email: 'a@x.io' }, { name: null, email: 'b@x.io' }])).toBe('A <a@x.io>, b@x.io')
  })
  it('reSubject: 이미 접두가 있으면 그대로', () => {
    expect(text.reSubject('RE: 견적', 'Re:')).toBe('RE: 견적')
    expect(text.reSubject('견적', 'Fwd:')).toBe('Fwd: 견적')
    expect(text.reSubject(null, 'Re:')).toBe('Re:')
  })
  it('전체 답장: 나·보낸 사람 중복 빼고 to+cc', () => {
    const r = text.replyRecipients(detail() as any, true, 'ME@example.com')
    expect(r.to).toBe('김서연 <kim@ext.io>')
    expect(r.cc).toBe('박 <park@ext.io>, lee@ext.io')
    expect(text.replyRecipients(detail() as any, false, 'me@example.com').cc).toBe('')
  })
  it('인용·전달 본문', () => {
    const q = text.quoteOf(detail() as any)
    expect(q.text).toContain('> 안녕하세요\n> > 인용')
    expect(q.html).toContain('<blockquote><p>안녕하세요</p><p>&gt; 인용</p></blockquote>')
    expect(text.forwardOf(detail() as any).text.split('\n')[0]).toBe('---------- Forwarded message ----------')
  })
})

describe('MailBody 3경로', () => {
  it('A 텍스트: 인용문을 접는다', () => {
    render(<MailBody message={detail()} />)
    expect(screen.getByText('안녕하세요')).toBeTruthy()
    expect(screen.queryByText('> 인용')).toBeNull()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('> 인용')).toBeTruthy()
  })
  it('B 단순 HTML: 속성 제거 후 prose', () => {
    const { container } = render(<MailBody message={detail({ html_body: '<p onclick="x()" class="a">본문<b>굵게</b></p>' })} dark />)
    // (happy-dom 의 DOMPurify 결과는 브라우저와 조금 다르다 — 속성 제거만 본다)
    const html = container.querySelector('.mail-paper--dark .mail-paper-prose')!.innerHTML
    expect(html).toContain('<b>굵게</b>')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('class=')
  })
  it('C 서식 HTML: 샌드박스 iframe(어둡게 보기 = dark-view)', () => {
    const { container } = render(<MailBody message={detail({ html_body: '<table><tr><td>표</td></tr></table>' })} dark />)
    const f = container.querySelector('iframe[data-mail-frame]') as HTMLIFrameElement
    expect(f.getAttribute('sandbox')).toBe('allow-scripts allow-popups allow-popups-to-escape-sandbox')
    expect(f.getAttribute('srcdoc')).toContain('<html class="dark-view">')
  })
})

describe('MailComposer', () => {
  it('새 메일: to 미리 채움 → 보내기는 POST /api/mail/send(가짜) 에 보내는 본문', async () => {
    const onClose = vi.fn()
    renderInRouter(<MailComposer variant="window" mode="new" to="kim@ext.io" onClose={onClose} />)
    await waitFor(() => expect(screen.getByLabelText('제목')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('제목'), { target: { value: '안부' } })
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: '보내기' })[0]) })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const send = api.calls.find(c => c.url === '/api/mail/send')!
    expect(send.opts.method).toBe('POST')
    expect(send.opts.body).toMatchObject({
      account_id: 'a1', from_name: '나', to: [{ name: null, email: 'kim@ext.io' }], cc: [], bcc: [], subject: '안부',
      text_body: '', html_body: null, in_reply_to: null, references: [], request_read_receipt: false, signature_id: null,
      reply_mailbox_id: null, send_at: null,
    })
  })

  it('받는 사람이 없으면 보내지 않고 오류', async () => {
    renderInRouter(<MailComposer variant="window" mode="new" />)
    await waitFor(() => expect(screen.getByLabelText('제목')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: '보내기' })[0]) })
    expect(screen.getByRole('alert').textContent).toBeTruthy()
    expect(api.calls.some(c => c.url === '/api/mail/send')).toBe(false)
  })

  it('인라인 답장: 받는 사람 = 보낸 사람, "전체 답장으로" 누르면 참조까지 · 인용은 보낼 때 붙인다', async () => {
    const onUpdateMode = vi.fn()
    renderInRouter(<MailComposer variant="inline" mode="reply" msgId="m1" original={detail() as any} onUpdateMode={onUpdateMode} />)
    await waitFor(() => expect(screen.getByText('김서연')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '전체 답장으로' }))
    expect(onUpdateMode).toHaveBeenCalledWith('replyAll')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '보내기' })) })
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/mail/send')).toBe(true))
    const body = api.calls.find(c => c.url === '/api/mail/send')!.opts.body
    expect(body).toMatchObject({
      to: [{ name: '김서연', email: 'kim@ext.io' }],
      cc: [{ name: '박', email: 'park@ext.io' }, { name: null, email: 'lee@ext.io' }],
      subject: 'Re: 견적', in_reply_to: 'm1', reply_mailbox_id: 'INBOX',
    })
    expect(body.text_body).toContain('> 안녕하세요')
    expect(body.html_body.startsWith('<br><p>')).toBe(true)
  })
})

describe('MailComposer 계정 없음 · 첨부 임시 저장 안내', () => {
  it('계정이 없으면 쓰기 대신 "메일 연결하기" 안내 — 초안을 만들지 않는다(다시 열 화면이 없음)', async () => {
    const base = api.handler
    api.handler = (url, o) => (url === '/api/mail/accounts' ? [] : base(url, o))
    renderInRouter(<MailComposer variant="window" mode="new" to="kim@ext.io" />)
    expect(await screen.findByText('연결된 메일 계정이 없습니다')).toBeTruthy()
    expect(screen.getByRole('link', { name: '메일 연결하기' }).getAttribute('href')).toBe('/mail/accounts?add=1')
    expect(screen.queryByLabelText('제목')).toBeNull()
    expect(api.calls.some(c => c.url === '/api/mail/drafts')).toBe(false)
  })

  it('첨부가 있는 채 닫으면 "첨부는 임시 저장되지 않음" 경고', async () => {
    const { toastStore } = await import('~/composables/useToast')
    toastStore.setState({ toasts: [] })
    const base = api.handler
    api.handler = (url, o) => {
      if (url === '/api/mail/upload') return { blob_id: 'b1', name: 'a.txt', type: 'text/plain', size: 3 }
      if (url === '/api/mail/drafts') return { id: 'd1' }
      return base(url, o)
    }
    let h: any = null
    renderInRouter(<MailComposer ref={(x: any) => { h = x }} variant="window" mode="new" />)
    await waitFor(() => expect(screen.getByLabelText('제목')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('제목'), { target: { value: '첨부' } })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['abc'], 'a.txt', { type: 'text/plain' })] } }) })
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
    await act(async () => { await h.close() })
    expect(toastStore.getState().toasts.map(x => x.type)).toContain('warning')
  })
})

describe('MailRecipientField', () => {
  it('Enter·쉼표로 칩, 붙여넣기는 여러 개, Backspace 로 마지막 칩 삭제', () => {
    let v = ''
    const { rerender } = render(<MailRecipientField modelValue={v} onUpdateModelValue={x => { v = x }} label="받는이" />)
    const input = screen.getByLabelText('받는이')
    fireEvent.change(input, { target: { value: 'a@x.io' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(v).toBe('a@x.io')
    rerender(<MailRecipientField modelValue={v} onUpdateModelValue={x => { v = x }} label="받는이" />)
    fireEvent.paste(input, { clipboardData: { getData: () => 'b@x.io; c@x.io' } })
    expect(v).toBe('a@x.io, b@x.io, c@x.io')
    rerender(<MailRecipientField modelValue={v} onUpdateModelValue={x => { v = x }} label="받는이" />)
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(v).toBe('a@x.io, b@x.io')
  })
})

describe('MailList', () => {
  it('행: 안 읽음 굵게·대화 수·광고 배지, 빠른 칩은 서버 필터로 다시 받는다', async () => {
    mailStore.setState({
      mailboxes: [{ id: 'INBOX', name: 'INBOX', role: 'inbox', unread_count: 1, total_count: 2, sort_order: 0 }],
      selectedMailboxId: 'INBOX',
      messages: [
        { id: '1', thread_id: null, mailbox_ids: ['INBOX'], from_: [{ name: '김', email: 'k@x.io' }], to: [], subject: '(광고) 할인', preview: null, received_at: null, is_unread: true, is_flagged: false, has_attachment: false, thread_count: 3 },
        { id: '2', thread_id: null, mailbox_ids: ['INBOX'], from_: [{ name: '박', email: 'p@x.io' }], to: [], subject: '회의', preview: null, received_at: null, is_unread: false, is_flagged: true, has_attachment: true },
      ] as any,
      totalMessages: 2,
    })
    renderInRouter(<MailList />)
    expect(screen.getByText('할인')).toBeTruthy()
    expect(screen.getByLabelText(/대화|3/, { selector: 'span' }).textContent).toBe('3')
    const unreadChip = screen.getAllByRole('button').find(b => b.getAttribute('aria-pressed') === 'false' && b.textContent?.startsWith('안 읽음'))!
    await act(async () => { fireEvent.click(unreadChip) })
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/mail/messages' && c.opts.params.unread === true)).toBe(true))
  })
})

describe('MailComposeHost', () => {
  it('데스크톱에서 openCompose 하면 오른쪽 아래 창, 최소화하면 제목 줄만', async () => {
    renderInRouter(<MailComposeHost />)
    act(() => { openCompose('new') })
    const dlg = await screen.findByRole('dialog', { name: '새 메일' })
    expect(dlg.style.right).toBe('24px')
    act(() => { mailComposeStore.setState({ windows: mailComposeStore.getState().windows.map(w => ({ ...w, minimized: true })) }) })
    await waitFor(() => expect((screen.getByRole('dialog') as HTMLElement).style.height).toBe('44px'))
  })
})
