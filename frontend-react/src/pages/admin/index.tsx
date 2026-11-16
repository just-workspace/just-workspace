/**
 * /admin —
 * 데스크톱은 개요(/admin/dashboard)로 이동, 모바일은 관리 메뉴 목록(그룹 카드 52 행 + 보조 글자 + ›) 표시.
 * 모바일 머리는 이 페이지 header(제목 + "관리자 · 이름") — 공용 상단바 미사용(routes.ts ownMobileHeader).
 */
import { Fragment, useEffect } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { navigateTo } from '~/lib/router'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useIsMobile } from '~/composables/useIsMobile'
import { useAuth } from '~/composables/useAuth'
import { useSettingsNav } from '~/composables/useSettingsNav'
import { NuxtLink } from '~/components/NuxtLink'
import { UiIcon } from '~/components/ui/Icon'

export default function AdminIndexPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: t('admin.common.headTitleRoot', { app: appName }) })

  const isMobile = useIsMobile()
  const { user } = useAuth()
  const { groups } = useSettingsNav('admin')

  // watch(isMobile, immediate) — 데스크톱이면 개요로 이동
  useEffect(() => { if (!isMobile) void navigateTo('/admin/dashboard', { replace: true }) }, [isMobile])

  return (
    <>
      <header className="sticky top-0 z-10 flex h-14 shrink-0 flex-col justify-center border-b border-border bg-background px-4 md:hidden">
        <h1 className="truncate text-lg font-semibold leading-6 text-foreground">{t('nav.admin')}</h1>
        <p className="truncate text-xs text-muted-foreground">{t('admin.index.adminBy', { name: user?.display_name || user?.username })}</p>
      </header>
      <div className="flex flex-col gap-2 px-4 py-4 md:hidden">
        {groups.map(g => (
          <Fragment key={g.label}>
            <div className="px-1 pb-1 pt-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{g.label}</div>
            <div className="rounded-lg border border-border bg-card">
              {g.items.map(it => (
                <NuxtLink
                  key={it.to}
                  to={it.to}
                  className="flex min-h-[52px] items-center gap-3 border-b border-border pl-4 pr-3 text-[15px] text-foreground last:border-b-0"
                >
                  <span className="flex-1">{it.label}</span>
                  {it.meta && <span className="text-[13px] text-muted-foreground">{it.to === '/admin/users' ? t('admin.index.pendingMeta', { n: it.meta }) : it.meta}</span>}
                  <UiIcon name="chevron-right" className="h-4 w-4 text-muted-foreground" strokeWidth={2.4} />
                </NuxtLink>
              ))}
            </div>
          </Fragment>
        ))}
      </div>
    </>
  )
}
