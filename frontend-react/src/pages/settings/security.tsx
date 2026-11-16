// 설정 › 보안: 비밀번호 카드 · 2단계 인증 행 · 내 세션 표.
// 관리자 정책상 2단계 인증이 필수이나 미등록 상태이면(?enroll=1 로 진입) 등록 모달을 즉시 연다.
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { useRoute } from '~/lib/router'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useAuth } from '~/composables/useAuth'
import { SettingsHeader } from '~/components/settings/SettingsHeader'
import { SettingsPasswordCard } from '~/components/settings/SettingsPasswordCard'
import { SettingsTwoFactor } from '~/components/settings/SettingsTwoFactor'
import { SettingsSessionsTable } from '~/components/settings/SettingsSessionsTable'

export default function SettingsSecurityPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: `${t('profile.navSecurity')} | ${appName}` })

  const route = useRoute()
  const { user } = useAuth()

  return (
    <>
      <SettingsHeader title={t('profile.navSecurity')} subtitle={t('settings.security.subtitle')} />
      <SettingsPasswordCard />
      <SettingsTwoFactor autoEnroll={route.query.enroll === '1' || !!user?.totp_setup_required} />
      <SettingsSessionsTable />
    </>
  )
}
