/**
 * 라우터 — routes.ts 표의 URL + 레이아웃 + 전역 가드.
 *
 * 구조:
 *   root(App, loader = 전역 가드)
 *     ├─ layout:false 화면들(로그인·회의실·공유 등)
 *     ├─ DefaultLayout(pathless)
 *     │    ├─ layout:'default' 화면들
 *     │    ├─ AdminLayout(pathless) → layout:'admin' 화면들
 *     │    └─ SettingsLayout(pathless) → layout:'settings' 화면들
 *     └─ *  → 404(AuthErrorScreen)
 *
 * 페이지 파일은 src/pages/<file> 에서 지연 로드(import.meta.glob).
 * admin/settings 레이아웃이 기본 셸 안에 중첩돼 있어, 셸 사이를 오갈 때 사이드바가 다시 마운트되지 않는다.
 */
import type { ComponentType } from 'react'
import { isChunkLoadError, isReloading, reloadOnce } from '~/lib/chunkReload'
import { createBrowserRouter, createMemoryRouter, matchRoutes, redirect, useRouteError, isRouteErrorResponse, type RouteObject } from 'react-router'
import App from '~/App'
import { ROUTES, type AppRouteDef } from './routes'
import { runGuards } from './guards'
import { DefaultLayout } from '~/layouts/default'
import { AdminLayout } from '~/layouts/admin'
import { SettingsLayout } from '~/layouts/settings'
import { AuthErrorScreen } from '~/components/auth/AuthErrorScreen'
import type { RouteMeta } from '~/lib/router'

type PageModule = { default: ComponentType }
const pageModules = import.meta.glob<PageModule>('../pages/**/*.tsx')

function pageRoute(def: AppRouteDef): RouteObject {
  const load = pageModules[`../pages/${def.file}`]
  if (!load) throw new Error(`[router] 페이지 파일 없음: src/pages/${def.file}`)
  const handle: RouteMeta = {
    layout: def.layout,
    vuePath: `pages/${def.file.replace(/\.tsx$/, '.vue')}`,
  }
  if (def.ownMobileHeader) handle.ownMobileHeader = true
  if (def.noDesktopTopbar) handle.noDesktopTopbar = true
  if (def.sidebarAccount) handle.sidebarAccount = true
  if (def.catchAll) handle.catchAll = def.catchAll
  const r: RouteObject = {
    id: def.file,
    path: def.path,
    handle,
    lazy: async () => ({ Component: (await load()).default }),
  }
  // redirect 메타: 쿼리 없이 그 주소로
  if (def.redirect) r.loader = () => redirect(def.redirect!)
  return r
}

function NotFound() {
  // 라우트 없음 오류의 url 은 비워 둔다 — 화면이 현재 경로(route.fullPath)를 보여 준다
  return <AuthErrorScreen error={{ statusCode: 404 }} />
}

/** 라우터 오류(로더 실패·렌더 실패) 화면 */
function RouteError() {
  const err = useRouteError()
  // 재배포 뒤 옛 화면 조각을 못 불러온 것 — 오류 화면 대신 새로고침(30초 안 되풀이면 오류 화면)
  if (isReloading() || (isChunkLoadError(err) && reloadOnce())) return null
  let statusCode = 500
  let message: string | undefined
  if (isRouteErrorResponse(err)) { statusCode = err.status; message = err.statusText }
  else if (err instanceof Error) message = err.message
  console.error('[Route Error]', err)
  return <AuthErrorScreen error={{ statusCode, message, data: err }} />
}

export function buildRoutes(defs: AppRouteDef[] = ROUTES): RouteObject[] {
  const by = (l: AppRouteDef['layout']) => defs.filter(d => d.layout === l).map(pageRoute)

  const children: RouteObject[] = [
    ...by(false),
    {
      id: 'layout-default',
      Component: DefaultLayout,
      children: [
        ...by('default'),
        { id: 'layout-admin', Component: AdminLayout, children: by('admin') },
        { id: 'layout-settings', Component: SettingsLayout, children: by('settings') },
      ],
    },
    { id: 'not-found', path: '*', Component: NotFound, handle: { notFound: true } satisfies RouteMeta },
  ]

  const tree: RouteObject[] = [
    {
      id: 'root',
      path: '/',
      Component: App,
      errorElement: <RouteError />,
      HydrateFallback: () => null,
      // 전역 가드(auth → module-guard → setup)는 매 이동마다
      shouldRevalidate: () => true,
      loader: async ({ request }) => {
        const url = new URL(request.url)
        const matches = matchRoutes(tree, url.pathname) ?? []
        const leaf = matches[matches.length - 1]
        const matched = !!leaf && !(leaf.route.handle as RouteMeta | undefined)?.notFound
        const to = await runGuards({ path: url.pathname, matched })
        if (to) throw redirect(to)
        return null
      },
      children,
    },
  ]
  return tree
}

export function createAppRouter() {
  return createBrowserRouter(buildRoutes())
}

/** 테스트용: 메모리 라우터 */
export function createTestRouter(initialEntries: string[]) {
  return createMemoryRouter(buildRoutes(), { initialEntries })
}
