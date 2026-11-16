// 계정 없는 사용자 — /mail?compose=… 가 무시되지 않고 작성 창이 표시됨(창은 "메일 연결" 안내를 렌더링)
import { describe, it, expect, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

vi.mock('~/lib/api', async (orig) => {
  const real = await orig<typeof import('~/lib/api')>()
  const fake = async (url: string) => (url === '/api/mail/accounts' ? [] : {})
  const $fetch = Object.assign(fake, { raw: fake, native: fetch, create: () => fake })
  return { ...real, $fetch }
})

const { default: MailPage } = await import('~/pages/mail/index')
const { mailComposeStore } = await import('~/composables/useMailCompose')
const { isMobileStore } = await import('~/composables/useIsMobile')
const { setUser } = await import('~/composables/useAuth')

describe('메일 화면 · 계정 없음', () => {
  it('?compose=mode=new 를 처리해 작성 창을 연다', async () => {
    isMobileStore.setState({ isMobile: false })
    setUser({ id: 'u1', username: 'qa', display_name: 'QA', email: null } as any)
    const router = createMemoryRouter([{ path: '/mail', element: <MailPage /> }], { initialEntries: ['/mail?compose=mode%3Dnew%26to%3Da%40x.io'] })
    render(<RouterProvider router={router} />)
    await waitFor(() => expect(mailComposeStore.getState().windows.length).toBe(1))
    expect(mailComposeStore.getState().windows[0].to).toBe('a@x.io')
  })
})
