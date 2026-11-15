/**
 * 업데이트 › 기록 — 지난 업데이트·복원(버전, 시각, 방식, 결과, 누가, 걸린 시간). 1년 보관.
 * 결과를 누르면 그때의 단계별 기록이 아래에 펼쳐진다 — 거친 버전마다, 되돌림이 있었으면 되돌림도.
 */
import { useState } from 'react'
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { addToast } from '~/composables/useToast'
import { updateApi, downloadJobLog, formatTime, type HistoryItem, type HistoryResult, type HistoryStep } from '~/composables/useSystemUpdate'
import { useDurationText } from '~/components/layout/UpdateCountdownBanner'
import { StepRows, Unavailable, useLoad } from '~/components/admin/update/parts'
import { UiCard } from '~/components/ui/Card'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiTable } from '~/components/ui/Table'
import { UiDisclosure } from '~/components/ui/Disclosure'
import { UiCallout } from '~/components/ui/Callout'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSkeleton } from '~/components/ui/Skeleton'

const RESULT_LOOK: Record<HistoryResult, { icon: string; color: string }> = {
  success: { icon: 'check-circle', color: 'text-success' },
  rolled_back: { icon: 'alert-triangle', color: 'text-warning' },
  rollback_failed: { icon: 'alert-circle', color: 'text-danger' },
  restored: { icon: 'rotate-ccw', color: 'text-muted-foreground' },
  restore_failed: { icon: 'alert-circle', color: 'text-danger' },
  cancelled: { icon: 'minus', color: 'text-muted-foreground' },
}

function Detail({ item }: { item: HistoryItem }) {
  const { t } = useI18n()
  const duration = useDurationText()
  const { data, error, reload } = useLoad(() => updateApi.historyEntry(item.id), [item.id])
  const rows = (steps: HistoryStep[]) => steps.map(s => ({
    id: s.id, label: t(`admin.update.step.${s.id}`, s.id), status: s.status,
    note: s.status === 'failed' ? s.note : s.status === 'done' ? duration(s.duration_seconds) : null,
  }))
  async function download() {
    try { await downloadJobLog(item.id) } catch { addToast('error', t('admin.update.log.downloadFailed')) }
  }
  const single = data?.versions.length === 1 && !data.rollback
  return (
    <UiCard className="overflow-hidden" data-testid="update-history-detail">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
        <h2 className="text-base font-semibold leading-6">
          <span className="font-mono">{item.version}</span> · {t(`admin.update.history.result.${item.result}`)} · {t('admin.update.history.steps')}
        </h2>
        <UiButton size="sm" variant="outline" icon="download" onClick={() => { void download() }}>{t('admin.update.log.download')}</UiButton>
      </div>
      <div className="border-t border-border">
        {!data ? (
          error
            ? <UiCallout variant="plain" tone="danger" className="px-4 py-3" actions={<UiButton size="xs" variant="outline" onClick={() => { void reload() }}>{t('common.retry')}</UiButton>}>{t('admin.update.history.detailError')}</UiCallout>
            : <UiSkeleton preset="list" rows={4} />
        ) : single ? (
          <StepRows label={t('admin.update.history.steps')} steps={rows(data.versions[0].steps)} />
        ) : (
          <>
            {data.versions.map((v, i) => (
              <UiDisclosure key={v.version} variant="row" defaultOpen={v.steps.some(s => s.status === 'failed') || i === data.versions.length - 1}
                title={<span className="font-mono">{v.version}</span>}
                description={t('admin.update.history.versionOf', { i: i + 1, n: data.versions.length })}>
                <StepRows label={`${v.version} ${t('admin.update.history.steps')}`} steps={rows(v.steps)} />
              </UiDisclosure>
            ))}
            {data.rollback && (
              <UiDisclosure variant="row" defaultOpen title={t('admin.update.history.rollback')}>
                <StepRows label={t('admin.update.history.rollback')} steps={rows(data.rollback.steps)} />
              </UiDisclosure>
            )}
          </>
        )}
      </div>
    </UiCard>
  )
}

export function HistoryTab() {
  const { t } = useI18n()
  const duration = useDurationText()
  const { data, error, unavailable, reload } = useLoad(() => updateApi.history())
  const [sel, setSel] = useState<string | null>(null)

  if (unavailable) return <Unavailable reason={unavailable} />
  if (!data) {
    return error
      ? <UiErrorTile placement="card" title={t('admin.update.history.loadError')} onRetry={() => { void reload() }} />
      : <UiCard><UiSkeleton preset="list" rows={5} /></UiCard>
  }
  const picked = data.items.find(i => i.id === sel) ?? null
  const who = (r: HistoryItem) => r.actor?.name || (r.trigger === 'auto' ? t('admin.update.trigger.auto') : '')

  return (
    <>
      <UiCard className="overflow-hidden">
        <UiTable
          label={t('admin.update.history.table')}
          minWidthClass="min-w-[680px]"
          rows={data.items}
          rowKey={r => r.id}
          empty={<p className="px-4 py-6 text-center text-[13px] text-muted-foreground" data-testid="update-history-empty">{t('admin.update.history.empty')}</p>}
          columns={[
            { key: 'ver', header: t('admin.update.notes.version'), mono: true, className: 'whitespace-nowrap', cell: r => r.version },
            { key: 'at', header: t('admin.update.history.col.at'), mono: true, cell: r => formatTime(r.finished_at ?? r.started_at) },
            { key: 'how', header: t('admin.update.history.col.how'), cell: r => t(`admin.update.trigger.${r.trigger}`) },
            {
              key: 'result', header: t('admin.update.history.col.result'), className: 'whitespace-nowrap',
              cell: (r) => {
                const look = RESULT_LOOK[r.result] ?? RESULT_LOOK.cancelled
                const on = r.id === sel
                return (
                  <button type="button" aria-expanded={on} onClick={() => setSel(on ? null : r.id)} data-testid={`history-${r.id}`}
                    className={cn('-my-1.5 inline-flex min-h-8 items-center gap-1.5 rounded-md border bg-transparent px-2 font-medium focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                      on ? 'border-primary' : 'border-border')}>
                    <UiIcon name={look.icon} className={cn('h-4 w-4', look.color)} />
                    {t(`admin.update.history.result.${r.result}`)}
                    <UiIcon name={on ? 'chevron-up' : 'chevron-down'} className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                )
              },
            },
            { key: 'who', header: t('admin.update.history.col.who'), cell: who },
            { key: 'took', header: t('admin.update.history.col.took'), mono: true, cell: r => duration(r.duration_seconds) },
          ]}
        />
      </UiCard>

      {picked && <Detail key={picked.id} item={picked} />}

      <p className="text-xs leading-[18px] text-muted-foreground">
        {data.retention_days === 365 ? t('admin.update.history.footnoteYear') : t('admin.update.history.footnote', { days: data.retention_days })}
      </p>
    </>
  )
}

export default HistoryTab
