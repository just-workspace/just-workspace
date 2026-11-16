/**
 * 업데이트 › 적용된 버전의 변경 내용 — 이미 적용된 버전을 다시 조회하는 화면("업데이트 시작" 없음).
 * 적용 시각·적용 방식, 이전 버전, 변경 내용, 적용 과정에서 비활성화한 플러그인.
 */
import { useNavigate } from 'react-router'
import { useI18n } from '~/i18n'
import { updateApi, formatTime, UPDATE_BASE } from '~/composables/useSystemUpdate'
import { useDurationText } from '~/components/layout/UpdateCountdownBanner'
import { Row, Mono, Unavailable, useLoad } from '~/components/admin/update/parts'
import { ChangelogCard } from '~/components/admin/update/NotesView'
import { UiCard } from '~/components/ui/Card'
import { UiButton } from '~/components/ui/Button'
import { UiCallout } from '~/components/ui/Callout'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiTrans } from '~/components/ui/Trans'

export function ChangesView({ version }: { version: string }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const duration = useDurationText()
  const { data, error, unavailable, reload } = useLoad(() => updateApi.release(version), [version])

  if (unavailable) return <Unavailable reason={unavailable} />
  if (!data) {
    return error
      ? <UiErrorTile placement="card" title={t('admin.update.changes.loadError')} onRetry={() => { void reload() }} />
      : <UiCard><UiSkeleton preset="list" rows={4} /></UiCard>
  }
  const at = formatTime(data.applied_at)
  const down = duration(data.downtime_seconds)
  const plugins = data.disabled_plugins ?? []

  return (
    <>
      <UiCard className="overflow-hidden">
        <dl className="flex flex-col text-[13.5px]">
          <Row first label={t('admin.update.notes.version')}>
            <Mono>{data.version}</Mono> <span className="text-muted-foreground">· {t(`admin.update.channel.${data.channel}.short`)}</span>
          </Row>
          <Row label={t('admin.update.changes.applied')}>
            {at ? (
              <span data-testid="update-applied">
                <Mono>{at}</Mono>
                {data.trigger && <span className="text-muted-foreground"> · {t(`admin.update.trigger.${data.trigger}Update`)}</span>}
                {down && <><span className="text-muted-foreground"> · {t('admin.update.changes.down')} </span><Mono>{down}</Mono></>}
              </span>
            ) : null}
          </Row>
          <Row label={t('admin.update.changes.previous')}>{data.previous_version ? <Mono>{data.previous_version}</Mono> : null}</Row>
        </dl>
      </UiCard>

      <ChangelogCard text={data.changelog} />

      {plugins.length > 0 && (
        <UiCallout tone="warning" data-testid="update-disabled-plugins"
          title={<UiTrans k="admin.update.notes.plugins.title" slots={{ n: <Mono>{plugins.length}</Mono> }} />}>
          {plugins.map(p => p.name || p.id).join(', ')} · {t('admin.update.changes.pluginsBody')}
        </UiCallout>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
        <UiButton variant="secondary" onClick={() => navigate(`${UPDATE_BASE}/history`)}>{t('admin.update.auto.history')}</UiButton>
        <UiButton onClick={() => navigate(UPDATE_BASE)}>{t('admin.update.toHome')}</UiButton>
      </div>
    </>
  )
}

export default ChangesView
