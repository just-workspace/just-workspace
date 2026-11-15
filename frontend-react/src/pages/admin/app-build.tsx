/**
 * 관리 › 설정 › 앱 빌드 — Vue pages/admin/app-build.vue(시안 AdminPage variant=appbuild · Review11 D2g).
 * 배포 채널 · 빌드 = AdminAppBuild.
 */
import { useEffect } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { navigateTo } from '~/lib/router'
import { useAuth } from '~/composables/useAuth'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { AdminPageShell } from '~/components/admin/AdminPageShell'
import { AdminAppBuild } from '~/components/admin/AdminAppBuild'

export default function AdminAppBuildPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: t('admin.common.headTitle', { page: t('admin.appBuild.title'), app: appName }) })
  const { user } = useAuth()
  useEffect(() => { if (user && !user.is_admin) void navigateTo('/') }, [user])

  if (!user?.is_admin) return null
  return (
    <AdminPageShell title={t('admin.appBuild.pageTitle')} subtitle={t('admin.appBuild.subtitle')} width="form">
      <AdminAppBuild />
    </AdminPageShell>
  )
}
