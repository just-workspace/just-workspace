// UI 키트 테스트 공용: 라우터 안에서 그리기(UiTabs·NuxtLink 가 라우터 문맥을 쓴다)
import type { ReactElement } from 'react'
import { render } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

export function renderInRouter(ui: ReactElement, path = '/') {
  const router = createMemoryRouter([{ path: '*', element: ui }], { initialEntries: [path] })
  return render(<RouterProvider router={router} />)
}
