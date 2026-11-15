// 메일 store — 폴더 선택 시 요청 주소·매개변수, 범위(scopeParams), 낙관적 갱신
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

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

const mail = await import('~/composables/useMail')
const { mailStore } = mail

const row = (id: string, o: Record<string, unknown> = {}) => ({
  id, thread_id: null, mailbox_ids: [], from_: [], to: [], subject: id, preview: null, received_at: null,
  is_unread: false, is_flagged: false, has_attachment: false, ...o,
})

beforeEach(() => {
  mail._resetMailStore()
  api.calls = []
  api.handler = () => ({})
})

describe('useMail', () => {
  it('fetchAccounts 는 기본 계정을 고르고, fetchMailboxes 는 받은편지함을 자동 선택', async () => {
    api.handler = (url) => {
      if (url === '/api/mail/accounts') return [{ id: 'a1', is_default: false }, { id: 'a2', is_default: true }]
      if (url === '/api/mail/mailboxes') return { mailboxes: [{ id: 'Sent', role: 'sent', unread_count: 0 }, { id: 'INBOX', role: 'inbox', unread_count: 3 }] }
      return {}
    }
    await mail.fetchAccounts()
    expect(mailStore.getState().selectedAccountId).toBe('a2')
    await mail.fetchMailboxes()
    expect(api.calls[1]).toMatchObject({ url: '/api/mail/mailboxes', opts: { params: { account_id: 'a2' } } })
    expect(mailStore.getState().selectedMailboxId).toBe('INBOX')
    expect(mail.mailTotalUnread()).toBe(3)
  })

  it('폴더를 고르면 거르기를 끄고 첫 페이지를 그 폴더·계정으로 요청한다', async () => {
    mail.setSelectedAccountId('a1')
    mail.setQuickFilters({ unread: true, starred: false, attachment: false })
    mailStore.setState({ currentPage: 3, searchQuery: 'x', labelFilter: 'L' })
    api.handler = () => ({ messages: [row('1'), row('2')], total: 2, page: 0, limit: 50 })
    await mail.selectMailbox('Archive')
    expect(api.calls).toHaveLength(1)
    expect(api.calls[0].url).toBe('/api/mail/messages')
    expect(api.calls[0].opts.params).toEqual({ mailbox_id: 'Archive', page: 0, limit: 50, account_id: 'a1' })
    const s = mailStore.getState()
    expect(s.messages.map(m => m.id)).toEqual(['1', '2'])
    expect(s.quickFilters).toEqual({ unread: false, starred: false, attachment: false })
    expect(s.labelFilter).toBeNull()
    expect(s.totalMessages).toBe(2)
  })

  it('칩을 켜면 서버 필터로 보내고, 같은 조합이면 다시 받지 않는다', async () => {
    mailStore.setState({ selectedMailboxId: 'INBOX' })
    api.handler = () => ({ messages: [], total: 0, page: 0, limit: 50 })
    mail.setQuickFilters({ unread: true, starred: true, attachment: true })
    await mail.applyFilters()
    expect(api.calls[0].opts.params).toMatchObject({ unread: true, flagged: true, has_attachment: true })
    await mail.applyFilters()
    expect(api.calls).toHaveLength(1)
  })

  it('메일을 열면 목록 행·메일함 안 읽음 수를 줄인다(새 객체로)', async () => {
    mailStore.setState({
      selectedMailboxId: 'INBOX',
      mailboxes: [{ id: 'INBOX', name: 'INBOX', role: 'inbox', unread_count: 2, total_count: 5, sort_order: 0 }],
      messages: [row('7', { is_unread: true }) as any],
    })
    const before = mailStore.getState().messages[0]
    api.handler = () => ({ ...row('7'), is_unread: false })
    await mail.openMessage('7')
    expect(api.calls[0]).toMatchObject({ url: '/api/mail/messages/7', opts: { params: { mailbox_id: 'INBOX' } } })
    const s = mailStore.getState()
    expect(s.selectedMessage?.id).toBe('7')
    expect(s.messages[0].is_unread).toBe(false)
    expect(s.messages[0]).not.toBe(before)
    expect(s.mailboxes[0].unread_count).toBe(1)
    expect(mail.mailSelectedIndex()).toBe(1)
  })

  it('bulkAction delete — 목록에서 빼고 선택 해제, 범위 매개변수 포함', async () => {
    mail.setSelectedAccountId('a1')
    mailStore.setState({ selectedMailboxId: 'Work', messages: [row('1'), row('2'), row('3')] as any, totalMessages: 3 })
    mail.setSelectedIds(new Set(['1', '3']))
    // 지운 뒤 목록을 다시 받아 채운다(감사 8번) — 서버가 남은 한 통을 돌려준다
    api.handler = (url) => (url === '/api/mail/mailboxes' ? { mailboxes: [] } : url === '/api/mail/messages' ? { messages: [row('2')], total: 1 } : {})
    const ok = await mail.bulkAction('delete')
    expect(ok).toBe(true)
    expect(api.calls[0]).toMatchObject({
      url: '/api/mail/bulk',
      opts: { method: 'POST', body: { message_ids: ['1', '3'], action: 'delete', mailbox_id: null, account_id: 'a1' }, params: { mailbox_id: 'Work' } },
    })
    const s = mailStore.getState()
    expect(s.messages.map(m => m.id)).toEqual(['2'])
    expect(s.totalMessages).toBe(1)
    expect(s.selectedIds.size).toBe(0)
    expect(api.calls[1].url).toBe('/api/mail/mailboxes')
  })

  it('첨부 주소는 현재 폴더·계정 범위', () => {
    mail.setSelectedAccountId('a 1')
    mailStore.setState({ selectedMailboxId: 'Sent' })
    expect(mail.attachmentUrl('b/1', { inline: true })).toBe('/api/mail/attachments/b%2F1?mailbox_id=Sent&account_id=a%201&inline=1')
  })

  it('useMail() hook — 값·파생 값·setter 를 내고, 바뀌면 다시 그린다', () => {
    const { result } = renderHook(() => mail.useMail())
    expect(result.current.messages).toEqual([])
    expect(result.current.totalPages).toBe(0)
    act(() => { mailStore.setState({ messages: [row('1')] as any, totalMessages: 120 }) })
    expect(result.current.messages.map(m => m.id)).toEqual(['1'])
    expect(result.current.totalPages).toBe(3)
    expect(result.current.hasNextPage).toBe(true)
    act(() => { result.current.setSelectedIds(new Set(['1'])) })
    expect(result.current.selectedIds.has('1')).toBe(true)
  })
})
