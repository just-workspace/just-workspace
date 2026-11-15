/**
 * 관리 › 설정 › AI — Vue pages/admin/ai.vue(시안 AdminPage variant=ai · Review11 D2f).
 * 워크스페이스 모델 · 도구 허용 · 한도 = AiAdminSettings(AI 모듈 담당).
 */
import { useEffect } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { navigateTo } from '~/lib/router'
import { useAuth } from '~/composables/useAuth'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { AdminPageShell } from '~/components/admin/AdminPageShell'
import { AiAdminSettings } from '~/components/ai/AiAdminSettings'

export default function AdminAiPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: t('admin.common.headTitle', { page: 'AI', app: appName }) })
  const { user } = useAuth()
  useEffect(() => { if (user && !user.is_admin) void navigateTo('/') }, [user])

  if (!user?.is_admin) return null
  return (
    <AdminPageShell title={t('aiAdmin.pageTitle')} subtitle={t('admin.ai.subtitle')} width="form">
      <AiAdminSettings />
    </AdminPageShell>
  )
}
