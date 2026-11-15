/**
 * 관리 › 설정 › 대시보드 — 모든 사람의 기본 대시보드 배치(handover 17 답 1 "관리자 기본 배치는 … 같은 편집 화면으로").
 * 시안은 다음에 온다 — 지금은 홈 편집 화면(DashboardHome)을 mode="admin" 으로 그대로 쓴다(최소 구현):
 * 늘 편집 상태, 바꾸면 바로 appcfg `dash.layout` 에 저장, 패널에서 카드마다 잠금(관리자 고정 — 사용자는 숨김·크기 불가).
 * 사용자가 편집 모드에서 "기본값으로"를 누르면 이 배치로 돌아간다.
 */
import { useEffect } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { navigateTo } from '~/lib/router'
import { useAuth } from '~/composables/useAuth'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { DashboardHome } from '~/components/dashboard/DashboardHome'

export default function AdminDashboardLayoutPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: t('admin.common.headTitle', { page: t('shell.adminNav.label.dashLayout'), app: appName }) })
  const { user } = useAuth()
  useEffect(() => { if (user && !user.is_admin) void navigateTo('/') }, [user])
  if (!user?.is_admin) return null
  return <div className="h-full"><DashboardHome mode="admin" /></div>
}
