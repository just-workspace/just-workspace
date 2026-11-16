// 파일 댓글·4단계 권한
// 내 권한 줄 · 답글/해결 · Ctrl+Enter · @멘션 머리/바닥 · 보기 권한 안내 + 권한 요청 · 상세 탭 순서 · 공동 소유자 이름 바꾸기 · 공유 권한 메뉴
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

const api = vi.hoisted(() => ({
  calls: [] as { url: string; opts: any }[],
  handler: (_url: string, _opts: any): any => ({}),
}))
vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string, opts: any = {}) => { api.calls.push({ url, opts }); return api.handler(url, opts) }
  return { ...real, $fetch: Object.assign(fake, { raw: fake, native: fetch, create: () => fake }) }
})

const files = await import('~/composables/useFiles')
const { FilesFileCommentsPanel } = await import('~/components/files/FileCommentsPanel')
const { FilesFileDetailPanel } = await import('~/components/files/FileDetailPanel')
const { FilesFileShareModal } = await import('~/components/files/FileShareModal')
const { setUser } = await import('~/composables/useAuth')
const { resetSharedState } = await import('~/lib/state')

function inRouter(ui: React.ReactElement) {
  const router = createMemoryRouter([{ path: '*', element: ui }], { initialEntries: ['/files'] })
  return render(<RouterProvider router={router} />)
}
const cm = (o: Record<string, unknown>) => ({
  id: 'c1', content: '합계 확인', author: { id: 'u2', username: 'seoyeon', display_name: '김서연' }, mentions: [],
  is_edited: false, is_mine: false, parent_id: null, anchor: null, resolved: false, created_at: '2026-10-14T09:02:00Z', updated_at: null, ...o,
})

beforeEach(() => {
  files._resetFilesStore()
  resetSharedState()
  api.calls = []
  api.handler = () => ({})
  setUser({ id: 'u1', username: 'haneul', display_name: '정하늘', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: false, last_login_at: null } as any)
})

describe('FilesFileCommentsPanel', () => {
  it('내 권한 줄 · 해결됨 배지 · 위치 조각 · 답글은 parent_id 로, 해결은 resolve 로, Ctrl+Enter 등록', async () => {
    api.handler = (url, opts) => {
      if (url === '/api/files/comments' && !opts.method) {
        return {
          items: [cm({ anchor: '시트 3 · D14' }), cm({ id: 'c2', content: '고마워요', resolved: true })],
          can_comment: true, role: 'owner', owner: { id: 'u3', display_name: '박민지' }, is_original_owner: false,
        }
      }
      if (url === '/api/files/comments' && opts.method === 'POST') return cm({ id: 'c3', content: opts.body.content, parent_id: opts.body.parent_id ?? null })
      if (url === '/api/files/comments/c1/resolve') return cm({ resolved: true })
      return {}
    }
    inRouter(<FilesFileCommentsPanel path="shared-with-me/s1" />)
    await screen.findByText('시트 3 · D14')
    expect(screen.getByText('내 권한')).toBeTruthy()
    expect(screen.getByText('공동 소유')).toBeTruthy()
    expect(screen.getAllByText('해결됨')).toHaveLength(1)
    // 해결된 댓글에는 "해결" 대신 "다시 열기"
    expect(screen.getAllByRole('button', { name: '해결' })).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: '해결' }))
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/files/comments/c1/resolve' && c.opts.body.resolved === true)).toBe(true))

    fireEvent.click(screen.getAllByRole('button', { name: '답글' })[0])
    expect(screen.getByText('김서연 님에게 답글')).toBeTruthy()
    const box = screen.getByRole('combobox', { name: '댓글' })
    fireEvent.change(box, { target: { value: '9월 기준으로 바꿨습니다' } })
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/files/comments' && c.opts.method === 'POST')).toBe(true))
    const post = api.calls.find(c => c.url === '/api/files/comments' && c.opts.method === 'POST')!
    expect(post.opts.body).toEqual({ path: 'shared-with-me/s1', content: '9월 기준으로 바꿨습니다', parent_id: 'c1' })
    expect(screen.getByText('Ctrl + Enter 로 등록')).toBeTruthy()
  })

  it('@ 를 치면 그 파일 권한이 붙은 후보 — 머리 "이 파일을 볼 수 있는 사람", 볼 수 없는 사람은 "보기 권한 없음"', async () => {
    api.handler = (url, opts) => {
      if (url === '/api/files/comments' && !opts.method) return { items: [], can_comment: true, role: 'comment', owner: null, is_original_owner: false }
      if (url === '/api/files/comments/mentionable') return { items: [
        { id: 'u2', username: 'seoyeon', display_name: '김서연', email: 'seoyeon@x', role: 'edit' },
        { id: 'u9', username: 'jihun', display_name: '서지훈', email: 'jihun@x', role: null },
      ] }
      return {}
    }
    inRouter(<FilesFileCommentsPanel path="shared-with-me/s1" />)
    const box = await screen.findByRole('combobox', { name: '댓글' })
    fireEvent.change(box, { target: { value: '@서', selectionStart: 2 } })
    await screen.findByText('이 파일을 볼 수 있는 사람', undefined, { timeout: 2000 })
    expect(screen.getByText('볼 권한이 없는 사람은 언급해도 알림이 가지 않습니다')).toBeTruthy()
    expect(screen.getByText('seoyeon@x · 편집')).toBeTruthy()
    expect(screen.getByText('보기 권한 없음')).toBeTruthy()
    expect(api.calls.find(c => c.url === '/api/files/comments/mentionable')!.opts.params).toEqual({ path: 'shared-with-me/s1', q: '서' })
  })

  it('보기 권한: 입력 대신 안내 띠, 답글·해결 숨김, [권한 요청] → 원 소유자에게 요청', async () => {
    api.handler = (url, opts) => {
      if (url === '/api/files/comments' && !opts.method) return { items: [cm({})], can_comment: false, role: 'view', owner: { id: 'u3', display_name: '박민지' }, is_original_owner: false }
      if (url === '/api/files/access-request') return { ok: true, notified: 1 }
      return {}
    }
    inRouter(<FilesFileCommentsPanel path="shared-with-me/s1" />)
    await screen.findByText('보기 권한은 댓글을 읽기만 합니다.')
    expect(screen.queryByRole('combobox', { name: '댓글' })).toBeNull()
    expect(screen.queryByRole('button', { name: '답글' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '권한 요청' }))
    await waitFor(() => expect(api.calls.some(c => c.url === '/api/files/access-request')).toBe(true))
    expect(api.calls.find(c => c.url === '/api/files/access-request')!.opts.body).toEqual({ path: 'shared-with-me/s1', role: 'comment' })
  })
})

describe('FilesFileDetailPanel', () => {
  it('탭 순서 정보·댓글(n)·버전·활동, 공동 소유자는 정보 맨 위 이름 바꾸기', async () => {
    api.handler = (url, opts) => {
      if (url === '/api/files/comments' && !opts.method) return { items: [cm({}), cm({ id: 'c2' })], can_comment: true, role: 'owner', owner: null, is_original_owner: false }
      if (url === '/api/files/rename') return { ok: true, new_name: opts.body.new_name, path: 'shared-with-me/s1' }
      return {}
    }
    const onRenamed = vi.fn()
    inRouter(<FilesFileDetailPanel item={{ name: '예산안-v3.xlsx', path: 'shared-with-me/s1', is_dir: false, size: 240, modified_at: null, mime_type: null, role: 'owner', owner: { id: 'u3', name: '박민지' } } as any} onRenamed={onRenamed} />)
    await waitFor(() => expect(screen.getAllByRole('tab').map(x => x.textContent)).toEqual(['정보', '댓글2', '버전', '활동']))
    expect(screen.getByText('공동 소유자는 이름을 바꿀 수 있습니다. 위치 이동·삭제는 원 소유자만.')).toBeTruthy()
    expect(screen.getByText('이름 바꾸기·공유·편집 (이동·삭제 제외)')).toBeTruthy()
    const name = screen.getByLabelText('이름')
    fireEvent.change(name, { target: { value: '예산안-v4.xlsx' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    await waitFor(() => expect(onRenamed).toHaveBeenCalled())
    expect(api.calls.find(c => c.url === '/api/files/rename')!.opts.body).toEqual({ path: 'shared-with-me/s1', new_name: '예산안-v4.xlsx' })
  })
})

describe('FilesFileShareModal 권한 메뉴', () => {
  it('공동 소유자 화면: 잠긴 행은 lock + 글자, 바꿀 수 있는 행은 메뉴(공동 소유 지정 = 원 소유자만, 빼기)', async () => {
    api.handler = (url) => {
      if (url === '/api/files/share-user/list') {
        return {
          shares: [
            { id: 'sh1', user_id: 'u2', channel_id: null, role: 'edit', can_write: true, can_manage: false },
            { id: 'sh2', user_id: 'u4', channel_id: null, role: 'comment', can_write: false, can_manage: true },
          ],
          owner: { id: 'u3', username: 'minji', display_name: '박민지', email: 'minji@x' },
          my_role: 'owner',
        }
      }
      if (url === '/api/auth/users') return [
        { id: 'u2', username: 'seoyeon', display_name: '김서연' }, { id: 'u4', username: 'hyunwoo', display_name: '최현우' },
      ]
      if (url === '/api/files/share/list') return []
      return []
    }
    inRouter(<FilesFileShareModal items={[{ name: '예산안-v3.xlsx', path: 'shared-with-me/s1', is_dir: false, size: 1, modified_at: null, mime_type: null, role: 'owner' } as any]} />)
    await screen.findByText(/잠긴 행은 원 소유자/)
    fireEvent.click(await screen.findByRole('button', { name: /권한$/ }))
    const menu = await screen.findByRole('menu')
    const co = within(menu).getByRole('menuitem', { name: /공동 소유 지정/ })
    expect(co.getAttribute('aria-disabled') === 'true' || co.hasAttribute('disabled')).toBe(true)
    expect(within(menu).getByText('원 소유자만')).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: /공유에서 빼기/ })).toBeTruthy()
    expect(screen.getByText('남길 말 (선택)')).toBeTruthy()
  })
})
