// 관리 › 업데이트 테스트 공용 준비물 — 모의 $fetch 의 응답 표와 화면 렌더링.
// vi.mock('~/lib/api') 는 각 테스트 파일에서 선언한다(hoist 때문) — 여기의 fakeFetch 를 전달하여 사용한다.
import { render } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

export interface Call { url: string; method: string; body?: any; query?: any }
export const api = {
  calls: [] as Call[],
  routes: {} as Record<string, (call: Call) => any>,
}
export const B = '/api/admin/system/update'

/** `METHOD 주소` 로 응답을 선택한다. 미지정 호출은 빈 객체 반환 */
export async function fakeFetch(url: string, opts: any = {}) {
  const call = { url, method: (opts.method || 'GET').toUpperCase(), body: opts.body, query: opts.query }
  api.calls.push(call)
  const handler = api.routes[`${call.method} ${url}`]
  if (!handler) return {}
  return handler(call)
}

export const on = (method: string, path: string, reply: any) => {
  api.routes[`${method} ${path.startsWith('/api') ? path : B + path}`] = typeof reply === 'function' ? reply : () => reply
}
/** 순차적으로 다른 응답 반환 — 마지막 응답은 계속 반복. 함수는 호출하여(예외 발생 포함) 사용 */
export const seq = (...replies: any[]) => {
  let i = 0
  return () => {
    const r = replies[Math.min(i, replies.length - 1)]
    i += 1
    return typeof r === 'function' ? r() : r
  }
}
export const called = (method: string, path: string) => api.calls.filter(c => c.method === method && c.url === (path.startsWith('/api') ? path : B + path))

export const ADMIN = { id: 'a', username: 'admin', display_name: '관리자', email: null, primary_email: null, avatar_url: null, recovery_email: null, is_admin: true, last_login_at: null }
export const MEMBER = { ...ADMIN, id: 'm', username: 'member', display_name: '구성원', is_admin: false }

// 단언 헬퍼 — 본 리포의 테스트는 DOM 전용 matcher 없이 값으로 비교한다
/** 요소의 텍스트(공백은 한 칸으로 정규화) */
export const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
export const disabled = (el: Element) => (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true'
export const checked = (el: Element) => (el as HTMLInputElement).checked === true || el.getAttribute('aria-checked') === 'true'
export const value = (el: Element) => (el as HTMLInputElement).value

export async function renderUpdate(path = '/admin/update') {
  const { default: Page } = await import('~/pages/admin/update')
  const { setAppRouter } = await import('~/lib/router')
  const router = createMemoryRouter([
    { path: '/admin/update/*', element: <Page /> },
    { path: '*', element: <div data-testid="elsewhere" /> },
  ], { initialEntries: [path] })
  setAppRouter(router as any)
  const view = render(<RouterProvider router={router} />)
  return { router, ...view, path: () => router.state.location.pathname }
}
