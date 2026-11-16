/**
 * 점검 중 화면 — 업데이트(또는 복원) 진행 중 일반 사용자에게 표시되는 전체 화면.
 * 서버가 중지되어 API 가 실패하는 동안에도 유지되며(공개 점검 상태만 조회), 종료 후 자동으로 재연결한다.
 * 관리 메뉴·사용자 이름은 렌더링하지 않는다. 관리자 연락처는 설정된 경우에만 표시한다.
 */
import { useState } from 'react'
import { useI18n } from '~/i18n'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useNowTick } from '~/composables/useNowTick'
import { useAuth } from '~/composables/useAuth'
import { useUpdateNotice, useUpdateNoticeWatch, useMaintenanceExempted, reconnectNow } from '~/composables/useUpdateNotice'
import { formatTime } from '~/composables/useSystemUpdate'
import { useDurationText } from '~/components/layout/UpdateCountdownBanner'
import { UiCard } from '~/components/ui/Card'
import { UiIcon } from '~/components/ui/Icon'
import { UiButton } from '~/components/ui/Button'
import { UiCallout } from '~/components/ui/Callout'

export function LayoutMaintenanceScreen() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  const notice = useUpdateNotice()
  const now = useNowTick(notice.state === 'maintenance', 5000)
  const duration = useDurationText()
  const [busy, setBusy] = useState(false)
  if (notice.state !== 'maintenance') return null

  const restore = notice.kind === 'restore' || notice.kind === 'rollback'
  const started = formatTime(notice.startedAt ? new Date(notice.startedAt).toISOString() : null)
  const expected = duration(notice.expectedSeconds)
  const late = notice.startedAt != null && notice.expectedSeconds != null && now > notice.startedAt + notice.expectedSeconds * 1000

  async function reconnect() {
    setBusy(true)
    try { await reconnectNow() } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-[200] flex min-h-dvh flex-col items-center justify-center gap-6 overflow-y-auto bg-background px-4 py-8 text-sm text-foreground" data-testid="maintenance-screen">
      <div className="text-base font-semibold">{appName}</div>
      <main className="w-full max-w-[448px]">
        <UiCard>
          <div className="flex flex-col gap-5 p-6">
            <div className="flex flex-col gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
                <UiIcon name="loader" className="h-6 w-6 animate-spin motion-reduce:animate-none" />
              </span>
              <div className="flex flex-col gap-2">
                <h1 className="text-2xl font-bold leading-8" role="status">
                  {notice.reconnecting ? t('shell.update.maint.reconnecting') : t(restore ? 'shell.update.maint.titleRestore' : 'shell.update.maint.title')}
                </h1>
                <p className="text-muted-foreground">{t(restore ? 'shell.update.maint.bodyRestore' : 'shell.update.maint.body')}</p>
              </div>
            </div>
            {(started || expected) && (
              <dl className="flex flex-col gap-2 text-[13.5px]">
                {started && <div className="flex gap-3"><dt className="w-24 shrink-0 text-muted-foreground">{t('shell.update.maint.started')}</dt><dd className="font-mono">{started}</dd></div>}
                {expected && <div className="flex gap-3"><dt className="w-24 shrink-0 text-muted-foreground">{t('shell.update.maint.expected')}</dt><dd className="font-mono">{expected}</dd></div>}
              </dl>
            )}
            {late && (
              <UiCallout tone="warning" title={t('shell.update.maint.late')} data-testid="maintenance-late">
                {t('shell.update.maint.lateBody')}{notice.contact ? <>{' '}<span data-testid="maintenance-contact">{notice.contact}</span></> : null}
              </UiCallout>
            )}
            <UiButton variant="outline" className="w-full" icon="refresh" disabled={busy} onClick={() => { void reconnect() }}>
              {t('shell.update.maint.reconnect')}
            </UiButton>
          </div>
        </UiCard>
      </main>
    </div>
  )
}

/** 앱 루트에 1회 마운트 — 로그인 상태에서 사전 공지·점검을 감시하고, 점검 중이면 화면을 덮는다(관리자의 진행 화면은 예외) */
export function UpdateNoticeHost() {
  const { user } = useAuth()
  useUpdateNoticeWatch(!!user)
  const exempted = useMaintenanceExempted()
  if (!user || exempted) return null
  return <LayoutMaintenanceScreen />
}

export default LayoutMaintenanceScreen
