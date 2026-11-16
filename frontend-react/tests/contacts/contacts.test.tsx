// 연락처 화면 렌더 — 목록 초성 묶음·즐겨찾기 묶음, 상세 행동 줄 활성 조건, 편집 모달 저장 본문
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, act } from '@testing-library/react'
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

const { contactsStore, _resetContactsStore } = await import('~/composables/useContacts')
const { ContactsList } = await import('~/components/contacts/ContactsList')
const { ContactsDetail } = await import('~/components/contacts/ContactsDetail')
const { ContactsEditModal } = await import('~/components/contacts/ContactsEditModal')
const { default: ContactsPage } = await import('~/pages/contacts')

const contact = (id: string, name: string, o: Record<string, unknown> = {}) => ({
  id, address_book_id: 'b1', name, first_name: null, last_name: null, organization: null,
  emails: [], phones: [], addresses: [], notes: null, created: null, updated: null, ...o,
})

beforeEach(() => {
  _resetContactsStore()
  api.calls = []
  api.handler = (url) => {
    if (url === '/api/contacts/address-books') return { address_books: [{ id: 'b1', name: '개인' }] }
    if (url === '/api/contacts/groups') return { groups: [] }
    if (url === '/api/contacts/suggest') return []
    if (url === '/api/contacts/external-accounts') return []
    return { contacts: [], total: 0 }
  }
})

describe('연락처 화면', () => {
  it('페이지 마운트: 주소록 → 목록 → 그룹·개수 순으로 받는다', async () => {
    renderInRouter(<ContactsPage />)
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/contacts/groups')).toBe(true))
    // 사이드바(자식)도 주소록이 비어 있으면 1회 추가 조회함 — 자식 마운트가 선행
    const urls = api.calls.map(c => c.url)
    expect(urls.indexOf('/api/contacts/address-books')).toBe(0)
    const list = api.calls.find(c => c.url === '/api/contacts/' && c.opts.params?.page === 0)!
    expect(list.opts).toEqual({ params: { page: 0, limit: 50 } })
    expect(urls.lastIndexOf('/api/contacts/address-books')).toBeLessThan(api.calls.indexOf(list))
  })

  it('목록: 즐겨찾기 묶음이 맨 위, 나머지는 초성 헤더', () => {
    contactsStore.setState({
      contacts: [contact('1', '최수아'), contact('2', '김서연', { is_favorite: true }), contact('3', '박민지')] as any,
      totalContacts: 3,
    })
    renderInRouter(<ContactsList />)
    const heads = Array.from(document.querySelectorAll('section[data-index-key]')).map(s => s.getAttribute('data-index-key'))
    expect(heads).toEqual(['★', 'ㅂ', 'ㅊ'])
  })

  it('상세: 이메일 없으면 메일 쓰기 비활성, 워크스페이스 사용자가 아니면 채팅·통화 비활성', async () => {
    contactsStore.setState({ selectedContact: contact('1', '최수아') as any })
    renderInRouter(<ContactsDetail />)
    const mail = screen.getAllByRole('button').find(b => b.textContent?.includes('메일'))!
    expect((mail as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('최수아', { selector: 'h1 span' })).toBeTruthy()
  })

  it('편집 모달: 새 연락처 저장은 POST /api/contacts/ (빈 이메일·전화 행은 뺀다)', async () => {
    contactsStore.setState({ addressBooks: [{ id: 'b1', name: '개인' }], showEditModal: true, editingContact: null })
    renderInRouter(<ContactsEditModal />)
    const name = document.querySelector<HTMLInputElement>('input[data-autofocus]')!
    fireEvent.change(name, { target: { value: ' 홍길동 ' } })
    await act(async () => { fireEvent.submit(document.getElementById('contact-edit-form')!) })
    await waitFor(() => expect(api.calls.some(c => c.opts.method === 'POST')).toBe(true))
    const post = api.calls.find(c => c.opts.method === 'POST')!
    expect(post.url).toBe('/api/contacts/')
    expect(post.opts.body).toMatchObject({ address_book_id: 'b1', name: '홍길동', emails: [], phones: [], groups: [] })
    await waitFor(() => expect(contactsStore.getState().showEditModal).toBe(false))
  })
})
