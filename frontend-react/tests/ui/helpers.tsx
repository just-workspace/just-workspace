// UI 키트 테스트 공용: 라우터 안에서 렌더링(UiTabs·NuxtLink 가 라우터 컨텍스트를 사용)
import type { ReactElement } from 'react'
import { render } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

export function renderInRouter(ui: ReactElement, path = '/') {
  const router = createMemoryRouter([{ path: '*', element: ui }], { initialEntries: [path] })
  return render(<RouterProvider router={router} />)
}
