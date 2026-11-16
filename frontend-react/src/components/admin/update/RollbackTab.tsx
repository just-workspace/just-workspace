/**
 * 업데이트 › 되돌림 — 수동 복원: 업데이트 직전 백업(복원 지점) 목록에서 선택하여 이전 버전으로 복귀한다.
 * 확인 창의 제목은 선택한 버전이며, 본문은 소실되는 항목과 유지되는 항목을 먼저 제시한다. 시작하면 진행 화면(JobView)으로 이동한다.
 * 업데이트 실패 후의 자동 롤백은 선택 없이 시작된다 — 해당 진행도 동일한 진행 화면에서 표시한다.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useI18n } from '~/i18n'
import { addToast } from '~/composables/useToast'
import { updateApi, errorCode, formatBytes, formatTime, isLive, jobPath, type RestorePoint, type UpdateStatus } from '~/composables/useSystemUpdate'
import { Unavailable, useLoad } from '~/components/admin/update/parts'
import { UiCard } from '~/components/ui/Card'
import { UiButton } from '~/components/ui/Button'
import { UiCallout } from '~/components/ui/Callout'
import { UiModal } from '~/components/ui/Modal'
import { UiTable } from '~/components/ui/Table'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSkeleton } from '~/components/ui/Skeleton'

export function RollbackTab({ status }: { status: UpdateStatus | null }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const points = useLoad(() => updateApi.restorePoints())
  const [ask, setAsk] = useState<RestorePoint | null>(null)
  const [busy, setBusy] = useState(false)

  if (points.unavailable) return <Unavailable reason={points.unavailable} />
  const live = isLive(status?.job) ? status!.job! : null

  async function start(point: RestorePoint) {
    setBusy(true)
    try {
      navigate(jobPath(await updateApi.restore(point.id)))
    } catch (e: any) {
      addToast('error', errorCode(e) === 'busy' ? t('admin.update.busy') : e?.data?.detail || t('admin.update.restore.startFailed'))
      setBusy(false)
      setAsk(null)
    }
  }

  return (
    <>
      {live && (
        <UiCallout tone="info" icon="loader" spin role="status" data-testid="update-live-job" title={t(`admin.update.home.live.${live.kind}`)}
          actions={<UiButton size="sm" iconRight="arrow-right" onClick={() => navigate(jobPath(live))}>{t('admin.update.home.live.open')}</UiButton>} />
      )}

      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold leading-6">{t('admin.update.restore.title')}</h2>
        <p className="text-[13.5px] text-muted-foreground">{t('admin.update.restore.lead')}</p>
      </div>

      {!points.data ? (
        points.error
          ? <UiErrorTile placement="card" title={t('admin.update.restore.loadError')} onRetry={() => { void points.reload() }} />
          : <UiCard><UiSkeleton preset="list" rows={3} /></UiCard>
      ) : (
        <UiCard className="overflow-hidden">
          <UiTable
            label={t('admin.update.restore.table')}
            minWidthClass="min-w-[520px]"
            rows={points.data.points}
            rowKey={r => r.id}
            empty={<p className="px-4 py-6 text-center text-[13px] text-muted-foreground" data-testid="update-restore-empty">{t('admin.update.restore.empty')}</p>}
            columns={[
              { key: 'version', header: t('admin.update.notes.version'), mono: true, cell: r => r.version },
              { key: 'at', header: t('admin.update.restore.at'), mono: true, cell: r => formatTime(r.created_at) },
              { key: 'size', header: t('admin.update.restore.size'), mono: true, cell: r => formatBytes(r.size_bytes) },
              {
                key: 'act', header: '', className: 'text-right',
                cell: r => <UiButton size="sm" variant="outline" disabled={!!live} aria-label={t('admin.update.restore.pickAria', { version: r.version, time: formatTime(r.created_at) })} onClick={() => setAsk(r)}>{t('admin.update.restore.pick')}</UiButton>,
              },
            ]}
          />
        </UiCard>
      )}

      <p className="text-xs leading-[18px] text-muted-foreground">{t('admin.update.restore.footnote')}</p>

      {ask && (
        <UiModal confirm danger size="440" title={t('admin.update.restore.confirmTitle', { version: ask.version })} onClose={() => { if (!busy) setAsk(null) }}
          footer={<>
            <UiButton variant="outline" size="sm" disabled={busy} onClick={() => setAsk(null)}>{t('common.cancel')}</UiButton>
            <UiButton variant="danger" size="sm" disabled={busy} onClick={() => { void start(ask) }}>{t('admin.update.restore.start')}</UiButton>
          </>}>
          <div className="flex flex-col gap-2 text-[13.5px] text-muted-foreground" data-testid="update-restore-body">
            <p>{t('admin.update.restore.loss')}</p>
            <p>{t('admin.update.restore.maint')} {t('admin.update.restore.countdown')}</p>
          </div>
        </UiModal>
      )}
    </>
  )
}

export default RollbackTab
