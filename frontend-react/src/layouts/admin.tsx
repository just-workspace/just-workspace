/**
 * 관리 셸: 기본 셸 안에 좌 세로 메뉴 240(운영·설정·시스템) + "설정 찾기".
 * 표·분석 페이지는 전체 폭 사용, 설정 폼은 720 — 폭은 각 페이지가 결정한다. 구 AdminTabs(가로 탭)는 폐지.
 * 모바일: /admin 은 메뉴 목록, 하위는 상세 상단 바(‹ 관리 메뉴로).
 *
 * 라우터에서 DefaultLayout 의 자식(pathless)으로 연결된다 → 내부만 렌더링한다.
 * 규약: children 이 있으면 children 을, 없으면 <Outlet/> 을 렌더링한다.
 */
import type { ReactNode } from 'react'
import { Outlet } from 'react-router'
import { useI18n } from '~/i18n'
import { useRoute } from '~/lib/router'
import { useAuth } from '~/composables/useAuth'
import { useSettingsNav } from '~/composables/useSettingsNav'
import { useBreadcrumb } from '~/composables/useBreadcrumb'
import { LayoutSettingsNav } from '~/components/layout/SettingsNav'
import { LayoutMobileDetailBar } from '~/components/layout/MobileDetailBar'
import { UiErrorTile } from '~/components/ui/ErrorTile'

export function AdminLayout({ children }: { children?: ReactNode }) {
  const { t } = useI18n()
  const route = useRoute()
  const { user } = useAuth()
  const { labelFor } = useSettingsNav('admin')
  useBreadcrumb(labelFor(route.path))

  const isIndex = route.path === '/admin' || route.path === '/admin/'

  if (!user?.is_admin) {
    return <UiErrorTile placement="page" title={t('error.adminRequired')} noRetry secondaryLabel={t('shell.toHome')} secondaryTo="/" />
  }

  return (
    <div className="flex h-full min-h-0">
      <LayoutSettingsNav scope="admin" className="hidden md:flex" />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!isIndex && (
          <LayoutMobileDetailBar
            title={labelFor(route.path) || t('nav.admin')}
            subtitle={t('nav.admin')}
            backLabel={t('shell.backToAdminMenu')}
            backTo="/admin"
            hideTabbar={false}
          />
        )}
        <main className="min-h-0 flex-1 overflow-y-auto">
          {children ?? <Outlet />}
        </main>
      </div>
    </div>
  )
}

export default AdminLayout
