/**
 * 관리자 알림 띠 — 파일 저장소 연결이 끊긴 동안 앱 전 화면의 상단바 아래에 표시된다.
 * 관리자만 감시한다(일반 사용자는 파일 탭에서만 안내를 확인한다).
 */
import { Link } from 'react-router'
import { useI18n } from '~/i18n'
import { useAuth } from '~/composables/useAuth'
import { useStorageStatus, useStorageWatch } from '~/composables/useStorageStatus'
import { UiIcon } from '~/components/ui/Icon'

export function LayoutStorageDownBanner() {
  const { t } = useI18n()
  const { user } = useAuth()
  const admin = !!user?.is_admin
  useStorageWatch(admin)
  const { down } = useStorageStatus()
  if (!admin || !down) return null
  return (
    <div role="alert" className="flex items-center gap-2 border-b border-danger/30 bg-danger/10 px-4 py-2 text-sm text-foreground low:min-h-9 low:py-1" data-testid="storage-down-banner">
      <UiIcon name="alert-circle" className="h-4 w-4 shrink-0 text-danger" />
      <span className="min-w-0 flex-1">{t('shell.storageDown.message')}</span>
      <Link to="/admin/storage" className="shrink-0 whitespace-nowrap font-semibold text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
        {t('shell.storageDown.link')}
      </Link>
    </div>
  )
}

export default LayoutStorageDownBanner
