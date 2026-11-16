/**
 * 개인 설정 셸:
 * 기본 셸 내부에 좌 내비 240 + 본문 max-w 720(헤더형 h1 24/700 + 부제 13.5).
 * 모바일(md 미만): /settings 는 섹션 목록, 하위 페이지는 상세 상단 바(‹ 설정 목록으로 · 제목)로 2단 구성. 프로필 흡수.
 *
 * 라우터에서 DefaultLayout 의 자식(pathless)으로 연결된다 → 내부 영역만 렌더링한다.
 * 규약: children 이 있으면 children 을, 없으면 <Outlet/> 을 렌더링한다.
 */
import type { ReactNode } from 'react'
import { Outlet } from 'react-router'
import { useI18n } from '~/i18n'
import { useRoute } from '~/lib/router'
import { useSettingsNav } from '~/composables/useSettingsNav'
import { useBreadcrumb } from '~/composables/useBreadcrumb'
import { LayoutSettingsNav } from '~/components/layout/SettingsNav'
import { LayoutMobileDetailBar } from '~/components/layout/MobileDetailBar'

export function SettingsLayout({ children }: { children?: ReactNode }) {
  const { t } = useI18n()
  const route = useRoute()
  const { labelFor } = useSettingsNav('settings')
  useBreadcrumb(labelFor(route.path))

  const isIndex = route.path === '/settings' || route.path === '/settings/'

  return (
    <div className="flex h-full min-h-0">
      {/* 데스크톱 좌 내비 */}
      <LayoutSettingsNav scope="settings" className="hidden md:flex" />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* 모바일 상세 상단 바(목록 페이지에는 없음) */}
        {!isIndex && (
          <LayoutMobileDetailBar
            title={labelFor(route.path) || t('nav.settings')}
            subtitle={t('nav.settings')}
            backLabel={t('shell.backToSettingsList')}
            backTo="/settings"
            hideTabbar={false}
          />
        )}
        {/* main padding 28/40 안에 본문 최대 720(패딩 제외) */}
        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-10 md:py-7">
          <div className="mx-auto flex max-w-[720px] flex-col gap-[18px] md:mx-0">
            {children ?? <Outlet />}
          </div>
        </main>
      </div>
    </div>
  )
}

export default SettingsLayout
