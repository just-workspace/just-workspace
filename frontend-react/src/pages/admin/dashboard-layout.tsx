/**
 * 관리 › 설정 › 대시보드 — 전체 사용자의 기본 대시보드 배치.
 * 시안은 추후 제공 예정이다 — 현재는 홈 편집 화면(DashboardHome)을 mode="admin" 으로 그대로 사용한다(최소 구현):
 * 상시 편집 상태, 변경 즉시 appcfg `dash.layout` 에 저장, 패널에서 카드별 잠금(관리자 고정 — 사용자는 숨김·크기 변경 불가).
 * 사용자가 편집 모드에서 "기본값으로 복원"를 선택하면 이 배치로 복원된다.
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
