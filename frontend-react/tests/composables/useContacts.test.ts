// 연락처 store — 범위별 요청 주소·매개변수, 즐겨찾기 낙관 갱신, 범위 이름
import { describe, it, expect, vi, beforeEach } from 'vitest'

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

const c = await import('~/composables/useContacts')
const { contactsStore } = c

const contact = (id: string, o: Record<string, unknown> = {}) => ({
  id, address_book_id: 'b1', name: id, first_name: null, last_name: null, organization: null,
  emails: [], phones: [], addresses: [], notes: null, created: null, updated: null, ...o,
})

beforeEach(() => {
  c._resetContactsStore()
  api.calls = []
  api.handler = () => ({ contacts: [], total: 0 })
})

describe('useContacts', () => {
  it('기본 범위는 /api/contacts/ 에 page·limit(검색어는 trim)', async () => {
    contactsStore.setState({ searchQuery: '  kim ' })
    await c.fetchContacts()
    expect(api.calls[0]).toEqual({ url: '/api/contacts/', opts: { params: { page: 0, limit: 50, q: 'kim' } } })
  })

  it('워크스페이스 범위는 workspace-users(offset) 로 받고 Contact 꼴로 바꾼다', async () => {
    api.handler = () => ({ users: [{ id: 'u1', username: 'kim', display_name: '', email: 'k@x.io', department: '개발', position: '리드' }], total: 7 })
    c.selectScope({ kind: 'workspace' })
    await vi.waitFor(() => expect(contactsStore.getState().loadingContacts).toBe(false))
    expect(api.calls[0]).toMatchObject({ url: '/api/contacts/workspace-users', opts: { params: { limit: 50, offset: 0 } } })
    const s = contactsStore.getState()
    expect(s.totalContacts).toBe(7)
    expect(s.contacts[0]).toMatchObject({ id: 'ws:u1', name: 'kim', organization: '개발', title: '리드', workspace_user_id: 'u1', emails: [{ type: 'work', value: 'k@x.io' }] })
  })

  it('주소록·즐겨찾기·그룹 범위 매개변수와 scope/scopeLabel', async () => {
    contactsStore.setState({ addressBooks: [{ id: 'b1', name: '개인' }] })
    c.selectScope({ kind: 'book', id: 'b1' })
    expect(api.calls.at(-1)!.opts.params).toMatchObject({ book_id: 'b1' })
    expect(c.contactsScope()).toEqual({ kind: 'book', id: 'b1' })
    expect(c.contactsScopeLabel()).toBe('개인')

    c.selectScope({ kind: 'favorite' })
    expect(api.calls.at(-1)!.opts.params).toMatchObject({ favorite: true })
    expect(api.calls.at(-1)!.opts.params.book_id).toBeUndefined()

    c.selectScope({ kind: 'group', name: '파트너' })
    expect(api.calls.at(-1)!.opts.params).toMatchObject({ group: '파트너' })
    expect(c.contactsScopeLabel()).toBe('파트너')
    expect(contactsStore.getState().selectedContact).toBeNull()
  })

  it('목록 실패는 contactsError(빈 목록과 구분)', async () => {
    api.handler = () => { throw Object.assign(new Error('x'), { data: { detail: '서버 오류' } }) }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await c.fetchContacts()
    expect(contactsStore.getState().contactsError).toBe('서버 오류')
    err.mockRestore()
  })

  it('toggleFavorite: PATCH 후 목록·상세·개수를 바로 고친다, 즐겨찾기 범위에서 끄면 다시 받는다', async () => {
    const a = contact('a', { is_favorite: true })
    contactsStore.setState({ contacts: [a], selectedContact: a, counts: { all: 3, favorite: 2, workspace: 1 }, scopeKind: 'favorite' })
    await c.toggleFavorite(a as any)
    expect(api.calls[0]).toEqual({ url: '/api/contacts/a', opts: { method: 'PATCH', body: { is_favorite: false } } })
    expect(api.calls[1].url).toBe('/api/contacts/')
    expect(contactsStore.getState().counts.favorite).toBe(1)
    expect(contactsStore.getState().selectedContact?.is_favorite).toBe(false)
  })

  it('워크스페이스 사용자 행은 즐겨찾기 요청을 보내지 않는다', async () => {
    await c.toggleFavorite(contact('ws:1', { workspace_user_id: '1' }) as any)
    expect(api.calls).toHaveLength(0)
  })

  it('findWorkspaceUserId: 같은 이메일 + user_id 가 있는 항목만', async () => {
    api.handler = () => [{ email: 'A@x.io' }, { email: 'a@x.io', user_id: 'u9' }]
    expect(await c.findWorkspaceUserId(' a@X.io ')).toBe('u9')
    expect(api.calls[0]).toEqual({ url: '/api/contacts/suggest', opts: { params: { q: 'a@x.io', limit: 10 } } })
  })

  it('페이지 넘김은 total 기준', async () => {
    contactsStore.setState({ totalContacts: 120 })
    expect(c.contactsTotalPages()).toBe(3)
    await c.nextPage()
    expect(contactsStore.getState().currentPage).toBe(1)
    expect(api.calls.at(-1)!.opts.params.page).toBe(1)
    await c.prevPage()
    expect(contactsStore.getState().currentPage).toBe(0)
  })
})
