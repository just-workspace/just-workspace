// /settings — 데스크톱은 첫 섹션(계정)으로, 모바일은 섹션 목록(아바타 머리 + 그룹 카드 52 행 + ›).
import { Fragment, useEffect } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { navigateTo } from '~/lib/router'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useIsMobile } from '~/composables/useIsMobile'
import { useAuth } from '~/composables/useAuth'
import { useSettingsNav } from '~/composables/useSettingsNav'
import { useUserPrefs } from '~/composables/useUserPrefs'
import { useColorMode } from '~/composables/useColorMode'
import { SettingsNavGroupCard, SettingsProfileHead } from '~/components/settings/SettingsMobileIndex'

export default function SettingsIndexPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: `${t('nav.settings')} | ${appName}` })

  const isMobile = useIsMobile()
  const { user } = useAuth()
  const { groups } = useSettingsNav('settings')
  const { density } = useUserPrefs()
  const colorMode = useColorMode()

  const displayName = user?.display_name || user?.username || ''
  const DENSITY_LABEL: Record<string, string> = { comfortable: t('settings.density.comfortable'), default: t('settings.density.default'), compact: t('settings.density.compact') }
  const THEME_LABEL: Record<string, string> = { light: t('settings.theme.light'), dark: t('settings.theme.dark'), system: t('settings.theme.system') }
  function meta(to: string) {
    if (to === '/settings/display') return `${DENSITY_LABEL[density]} · ${THEME_LABEL[colorMode.preference] ?? ''}`
    return ''
  }

  // watch(isMobile, immediate)
  useEffect(() => { if (!isMobile) void navigateTo('/settings/account', { replace: true }) }, [isMobile])

  return (
    <div className="flex flex-col gap-2 md:hidden">
      <SettingsProfileHead avatarUrl={user?.avatar_url} name={displayName} email={user?.primary_email || user?.email} />
      {groups.map(g => (
        <Fragment key={g.label}>
          <SettingsNavGroupCard label={g.label} items={g.items.map(it => ({ to: it.to, label: it.label, meta: meta(it.to) }))} />
        </Fragment>
      ))}
    </div>
  )
}
