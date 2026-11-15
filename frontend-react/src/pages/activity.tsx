/**
 * 활동(시안 X4·PatActivityMobile). Vue 원본: frontend/pages/activity.vue
 * 모바일 탭바 "활동" 탭의 화면. 상단 56(제목 18/600 + 모두 읽음) + 칩 36 + 목록(아바타 40, 글자 14).
 * 데스크톱에서는 같은 목록을 읽기 폭(680)으로 보여 준다(벨 → 패널이 기본 진입).
 * ★ 스와이프 "읽음"(P-15)은 제스처 부품이 없어 이번 단계에서는 탭 = 열기+읽음만.
 * 모바일 머리는 이 페이지 header(시안 X4) — 공용 상단바는 쓰지 않는다(routes.ts ownMobileHeader)
 */
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useBreadcrumb } from '~/composables/useBreadcrumb'
import { useNotifications } from '~/composables/useNotifications'
import { UiButton } from '~/components/ui/Button'
import { LayoutActivityList } from '~/components/layout/ActivityList'

export default function ActivityPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: `${t('shell.activity.title')} | ${appName}` })
  useBreadcrumb('')

  const { unreadCount, markAllAsRead } = useNotifications()

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2 md:hidden">
        <h1 className="flex-1 text-lg font-semibold text-foreground">{t('shell.activity.title')}</h1>
        {unreadCount > 0 && <button type="button" className="px-2.5 text-sm font-semibold text-primary" onClick={() => { void markAllAsRead() }}>{t('notifications.markAllRead')}</button>}
      </header>
      <div className="mx-auto flex min-h-0 w-full max-w-[680px] flex-1 flex-col md:py-6">
        <div className="hidden items-end gap-3 px-4 pb-4 md:flex">
          <div className="flex-1">
            <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">{t('shell.activity.title')}</h1>
            <p className="mt-1 text-[13.5px] text-muted-foreground">{t('shell.activity.pageDesc')}</p>
          </div>
          {unreadCount > 0 && <UiButton variant="outline" size="sm" onClick={() => { void markAllAsRead() }}>{t('notifications.markAllRead')}</UiButton>}
        </div>
        <div className="flex min-h-0 flex-1 flex-col md:rounded-lg md:border md:border-border md:bg-card">
          <LayoutActivityList mobile />
        </div>
      </div>
    </div>
  )
}
