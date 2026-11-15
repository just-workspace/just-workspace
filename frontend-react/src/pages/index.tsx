// 판 전체는 components/dashboard/DashboardHome(관리 › 설정 › 대시보드도 같은 판을 mode="admin" 으로 쓴다).
import { useI18n } from '~/i18n'
import { useRoute } from '~/lib/router'
import { useHead } from '~/lib/head'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useBreadcrumb } from '~/composables/useBreadcrumb'
import { DashboardHome } from '~/components/dashboard/DashboardHome'

export default function Page() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  const route = useRoute()
  // SPA 딥링크 하드 리프레시 부팅 중 index가 순간 마운트되면 "대시보드" 제목이 잠깐 새는 현상 방지 —
  // 실제 활성 라우트가 '/'일 때만 대시보드 제목을 건다.
  useHead({ title: route.path === '/' ? `${t('nav.dashboard')} | ${appName}` : appName })
  // 상단바 = "워크스페이스 / 홈"(시안) — 모듈 이름이 곧 위치라 세 번째 단은 비운다
  useBreadcrumb('')
  return <DashboardHome />
}
