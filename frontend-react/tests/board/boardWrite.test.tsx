// 게시판 글쓰기 화면 — 본문 편집기가 실제로 렌더링되어야 한다("편집기 미해석" 재현 스위치가 남아 글 등록이 불가하던 회귀)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string) => {
    if (url === '/api/board/boards') return [{ id: 'b1', name: '자유', slug: 'free', categories: [] }]
    return []
  }
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { default: WritePage } = await import('~/pages/board/[boardId]/write')
const { setUser } = await import('~/composables/useAuth')

beforeEach(() => {
  setUser({ id: 'u1', username: 'qa', display_name: '검수', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: false, last_login_at: null } as any)
})

describe('게시판 글쓰기', () => {
  it('본문 편집기(contenteditable)가 그려지고 빈 자리표시가 없다', async () => {
    const router = createMemoryRouter([{ path: '/board/:boardId/write', element: <WritePage /> }], { initialEntries: ['/board/b1/write'] })
    const { container } = render(<RouterProvider router={router} />)
    await waitFor(() => expect(container.querySelector('[contenteditable="true"]')).not.toBeNull())
    expect(container.querySelector('[data-vue-unresolved]')).toBeNull()
  })
})
