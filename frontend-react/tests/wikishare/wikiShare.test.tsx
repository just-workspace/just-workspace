// 위키 스페이스 공유 — 설정 창에서 공개 범위 전환 · 멤버 추가 · 역할 변경 · 내보내기
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, act, waitFor, within } from '@testing-library/react'

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
// 확인 창은 화면 루트의 호스트가 렌더링함 — 여기서는 즉시 응답
const dialog = vi.hoisted(() => ({ answer: true, asked: 0 }))
vi.mock('~/composables/useDialog', async (orig) => {
  const real = await orig<typeof import('~/composables/useDialog')>()
  return { ...real, confirmBox: async () => { dialog.asked++; return dialog.answer } }
})

const { WikiSpaceSettings } = await import('~/components/wiki/WikiSpaceSettings')
const { authStore } = await import('~/composables/useAuth')
const { chatStore } = await import('~/composables/useChat')

const owner = { id: 'alice', username: 'alice', display_name: '앨리스', avatar_url: null }
const space = (o: Record<string, unknown> = {}): any => ({
  id: 's1', name: '개발', slug: 'dev', description: null, visibility: 'private', icon: null,
  owner, page_count: 1, user_role: 'admin', created_at: '', updated_at: '', ...o,
})
let members: any[] = []
const users = [
  { id: 'alice', username: 'alice', display_name: '앨리스', avatar_url: null },
  { id: 'bob', username: 'bob', display_name: '밥', avatar_url: null },
  { id: 'carol', username: 'carol', display_name: '캐럴', avatar_url: null },
]

function setMe(id: string, is_admin = false) {
  authStore.setState({ user: { id, username: id, is_admin } as any })
}
const mutations = () => api.calls.filter(c => c.opts?.method && c.opts.method !== 'GET')

async function open(sp = space()) {
  const view = render(<WikiSpaceSettings space={sp} />)
  await act(async () => { await Promise.resolve() })
  await screen.findByText('밥')
  return view
}

beforeEach(() => {
  api.calls = []
  dialog.answer = true
  dialog.asked = 0
  members = [{ user_id: 'bob', role: 'reader', username: 'bob', display_name: '밥', avatar_url: null }]
  chatStore.setState({ allUsers: [] } as any)
  setMe('alice')
  api.handler = (url, opts) => {
    if (url === '/api/chat/users') return users
    if (url.endsWith('/members') && (!opts.method || opts.method === 'GET')) return members
    if (url === '/api/wiki/spaces') return []
    return {}
  }
})

describe('WikiSpaceSettings — 공유', () => {
  it('소유자 행을 맨 위에 두고, 관리자는 멤버마다 역할 상자를 본다', async () => {
    await open()
    const rows = screen.getAllByRole('listitem')
    expect(rows[0].textContent).toContain('앨리스')
    expect(within(rows[0]).queryByRole('combobox')).toBeNull()   // 소유자 역할은 변경 불가
    expect(within(rows[1]).getByRole('combobox')).toBeTruthy()
  })

  it('공개로 바꾸면 한 번 묻고 visibility 만 PATCH 한다', async () => {
    await open()
    const vis = screen.getAllByRole('combobox')[0]
    fireEvent.click(vis)
    fireEvent.click(screen.getAllByRole('option')[1])
    await waitFor(() => expect(mutations().length).toBe(1))
    expect(dialog.asked).toBe(1)
    expect(mutations()[0]).toMatchObject({ url: '/api/wiki/spaces/s1', opts: { method: 'PATCH', body: { visibility: 'public' } } })
  })

  it('공개 확인을 취소하면 아무것도 보내지 않는다', async () => {
    dialog.answer = false
    await open()
    fireEvent.click(screen.getAllByRole('combobox')[0])
    fireEvent.click(screen.getAllByRole('option')[1])
    await act(async () => { await Promise.resolve() })
    expect(dialog.asked).toBe(1)
    expect(mutations()).toHaveLength(0)
  })

  it('비공개로 되돌릴 때는 묻지 않는다', async () => {
    await open(space({ visibility: 'public' }))
    fireEvent.click(screen.getAllByRole('combobox')[0])
    fireEvent.click(screen.getAllByRole('option')[0])
    await waitFor(() => expect(mutations().length).toBe(1))
    expect(dialog.asked).toBe(0)
    expect(mutations()[0].opts.body).toEqual({ visibility: 'private' })
  })

  it('역할을 바꾸면 그 멤버만 PATCH 하고, 실패하면 되돌린다', async () => {
    await open()
    const role = () => within(screen.getAllByRole('listitem')[1]).getByRole('combobox')
    const before = role().textContent
    fireEvent.click(role())
    fireEvent.click(screen.getAllByRole('option')[1])
    await waitFor(() => expect(mutations().length).toBe(1))
    expect(mutations()[0]).toMatchObject({ url: '/api/wiki/spaces/s1/members/bob', opts: { method: 'PATCH', body: { role: 'writer' } } })
    await waitFor(() => expect(role().textContent).not.toBe(before))

    const changed = role().textContent
    api.handler = () => { throw Object.assign(new Error('x'), { data: { detail: '안 됨' } }) }
    await waitFor(() => expect((role() as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(role())
    fireEvent.click(screen.getAllByRole('option')[2])
    await waitFor(() => expect(mutations().length).toBe(2))
    await waitFor(() => expect(role().textContent).toBe(changed))
  })

  it('멤버 추가: 소유자·이미 멤버인 사람은 빼고 보여 주고, 고르면 읽기로 넣는다', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: /멤버 추가/ }))
    const picker = (await screen.findAllByRole('dialog')).at(-1)!
    const pick = await within(picker).findByText('캐럴')
    expect(within(picker).queryByText('밥')).toBeNull()
    expect(within(picker).queryByText('앨리스')).toBeNull()
    members = [...members, { user_id: 'carol', role: 'reader', username: 'carol', display_name: '캐럴', avatar_url: null }]
    fireEvent.click(pick)
    await waitFor(() => expect(mutations().length).toBe(1))
    expect(mutations()[0]).toMatchObject({ url: '/api/wiki/spaces/s1/members', opts: { method: 'POST', body: { user_id: 'carol', role: 'reader' } } })
    // 목록을 재조회하여 새 멤버가 표시됨
    await waitFor(() => expect(screen.getAllByRole('listitem').some(li => li.textContent?.includes('캐럴') && within(li).queryByRole('combobox'))).toBe(true))
  })

  it('내보내기는 확인 뒤 DELETE', async () => {
    await open()
    const row = screen.getAllByRole('listitem')[1]
    fireEvent.click(within(row).getAllByRole('button').at(-1)!)
    await waitFor(() => expect(mutations().length).toBe(1))
    expect(mutations()[0]).toMatchObject({ url: '/api/wiki/spaces/s1/members/bob', opts: { method: 'DELETE' } })
  })

  it('관리 권한이 없으면 볼 수만 있다', async () => {
    setMe('bob')
    await open(space({ user_role: 'reader' }))
    expect(screen.queryByRole('button', { name: /멤버 추가/ })).toBeNull()
    const boxes = screen.getAllByRole('combobox') as HTMLButtonElement[]
    expect(boxes).toHaveLength(1)            // 공개 범위뿐 — 역할 상자 없음
    expect(boxes[0].disabled).toBe(true)
  })

  it('관리 멤버 본인 행에는 역할 상자·내보내기가 없다(스스로 잠그지 않게)', async () => {
    setMe('bob')
    members = [{ user_id: 'bob', role: 'admin', username: 'bob', display_name: '밥', avatar_url: null }]
    await open(space({ user_role: 'admin' }))
    const row = screen.getAllByRole('listitem')[1]
    expect(within(row).queryByRole('combobox')).toBeNull()
    expect(within(row).queryByRole('button')).toBeNull()
  })
})
