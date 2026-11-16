// 연락처·작업 구역 전수조사 수정 고정($fetch 는 모의(mock)):
//  - 검색·범위를 빠르게 변경해도 지연 도착한 이전 응답이 목록을 덮어쓰지 않음
//  - 연락처 삭제 실패는 토스트로 알림(기존: console 만)
//  - 편집에서 소속·메모·성·이름을 비우면 "" 로 전송(삭제)
//  - 작업 빠른 입력: 한글 조합 중 Enter 는 제출하지 않음
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderInRouter } from '../ui/helpers'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts: any }[],
  handler: (_u: string, _o: any): any => undefined,
}))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts: any = {}) => {
    api.calls.push({ url, opts })
    const r = await api.handler(url, opts)
    if (r !== undefined) return r
    if (url === '/api/contacts/' && !opts.method) return { contacts: [], total: 0 }
    if (url === '/api/contacts/groups') return { groups: [] }
    return { ok: true, total: 0, users: [] }
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { contactsStore, fetchContacts, deleteContact, _resetContactsStore } = await import('~/composables/useContacts')
const { ContactsEditModal } = await import('~/components/contacts/ContactsEditModal')
const { TasksQuickInput } = await import('~/components/tasks/TasksQuickInput')
const { toastStore } = await import('~/composables/useToast')
const { i18n } = await import('~/i18n')
const t = (k: string, a?: any) => i18n.t(k, a)

const contact = (id: string, o: Record<string, unknown> = {}): any => ({
  id, address_book_id: 'ab', name: id, first_name: '철수', last_name: '김', organization: 'Acme', emails: [], phones: [],
  addresses: [], notes: '메모', created: null, updated: null, photo: null, is_favorite: false, groups: [], title: null, ...o,
})

beforeEach(() => {
  api.calls = []
  api.handler = () => undefined
  _resetContactsStore()
})

describe('연락처', () => {
  it('늦게 온 이전 검색 응답은 버린다', async () => {
    const waits: ((v: any) => void)[] = []
    api.handler = (url, opts) => (url === '/api/contacts/' && !opts.method ? new Promise((res) => { waits.push(res) }) : undefined)
    const first = fetchContacts()
    const second = fetchContacts()
    waits[1]({ contacts: [contact('new')], total: 1 })
    await second
    expect(contactsStore.getState().loadingContacts).toBe(false)
    waits[0]({ contacts: [contact('old'), contact('old2')], total: 2 })
    await first
    expect(contactsStore.getState().contacts.map(c => c.id)).toEqual(['new'])
    expect(contactsStore.getState().totalContacts).toBe(1)
  })

  it('삭제 실패는 토스트로 알리고 목록은 그대로', async () => {
    contactsStore.setState({ contacts: [contact('a')] })
    api.handler = (_u, opts) => { if (opts.method === 'DELETE') throw new Error('x'); return undefined }
    const before = toastStore.getState().toasts.length
    await deleteContact('a')
    expect(contactsStore.getState().contacts.map(c => c.id)).toEqual(['a'])
    const toasts = toastStore.getState().toasts
    expect(toasts.length).toBe(before + 1)
    expect(toasts[toasts.length - 1].type).toBe('error')
  })

  it('편집에서 비운 소속·메모·성·이름은 "" 로 보낸다', async () => {
    contactsStore.setState({ addressBooks: [{ id: 'ab', name: '기본' }], editingContact: contact('김철수'), showEditModal: true })
    renderInRouter(<ContactsEditModal />)
    for (const key of ['contacts.edit.organizationLabel', 'contacts.edit.notesLabel', 'contacts.edit.firstNameLabel', 'contacts.edit.lastNameLabel']) {
      fireEvent.change(screen.getByLabelText(t(key)), { target: { value: '' } })
    }
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('common.save') })) })
    const isPatch = (c: any) => c.url === '/api/contacts/김철수' && c.opts?.method === 'PATCH'
    await waitFor(() => expect(api.calls.some(isPatch)).toBe(true))
    const body = api.calls.find(isPatch)!.opts.body
    expect(body).toMatchObject({ organization: '', notes: '', first_name: '', last_name: '', name: '김철수' })
  })
})

describe('작업 빠른 입력', () => {
  it('한글 조합 중 Enter 는 제출하지 않고, 확정 뒤 Enter 만 제출한다', () => {
    const onSubmit = vi.fn()
    renderInRouter(<TasksQuickInput onSubmit={onSubmit} />)
    const input = screen.getByLabelText(t('tasks.new.inputLabel'))
    fireEvent.change(input, { target: { value: '주간 회의' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0].title).toBe('주간 회의')
  })
})
