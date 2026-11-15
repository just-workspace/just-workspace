/**
 * 업데이트 › 새 버전 안내 — 버전(거칠 버전 포함), 받을 용량, 예상 중단 시간, 영향받는 구역, 변경 내용,
 * 호환이 확인되지 않은 플러그인 경고, 중간 버전 안내. "업데이트 시작"이 한 번의 확인이다(5분 예고부터).
 * 값이 없는 줄은 그리지 않는다.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useI18n } from '~/i18n'
import { addToast } from '~/composables/useToast'
import { updateApi, changelogLines, errorCode, formatBytes, jobPath, localized, UPDATE_BASE, type UpdateStatus } from '~/composables/useSystemUpdate'
import { useDurationText } from '~/components/layout/UpdateCountdownBanner'
import { Row, Mono } from '~/components/admin/update/parts'
import { UiCard } from '~/components/ui/Card'
import { UiButton } from '~/components/ui/Button'
import { UiCallout } from '~/components/ui/Callout'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiTrans } from '~/components/ui/Trans'

/** 변경 내용 카드 — 적힌 것이 없으면 그리지 않는다 */
export function ChangelogCard({ text }: { text: string | null | undefined }) {
  const { t } = useI18n()
  const lines = changelogLines(text)
  if (!lines.length) return null
  return (
    <UiCard className="overflow-hidden" data-testid="update-changelog">
      <h2 className="px-4 py-2.5 text-base font-semibold leading-6">{t('admin.update.notes.changes')}</h2>
      <ul className="flex list-disc flex-col gap-1 border-t border-border py-3 pl-9 pr-4 text-[13.5px]">
        {lines.map((l, i) => <li key={i}>{l}</li>)}
      </ul>
    </UiCard>
  )
}

export function NotesView({ status, onReload }: { status: UpdateStatus; onReload: () => void }) {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const duration = useDurationText()
  const [busy, setBusy] = useState(false)
  const a = status.available

  if (a.state !== 'update') {
    return <UiEmptyState variant="panel" icon="check-circle" title={t('admin.update.notes.none')} actionLabel={t('admin.update.toHome')} onAction={() => navigate(UPDATE_BASE)} />
  }

  const target = a.version
  const versions = [status.current.version, ...a.path]
  const mids = a.path.slice(0, -1)
  const zones = a.zones.map(z => localized(z.name, locale) || z.id).filter(Boolean)
  const down = duration(a.downtime_seconds)

  async function start() {
    setBusy(true)
    try {
      navigate(jobPath(await updateApi.apply(target)))
    } catch (e: any) {
      const code = errorCode(e)
      const stale = code === 'target_stale' || code === 'not_available'
      addToast('error', code === 'busy' ? t('admin.update.busy') : stale ? t('admin.update.notes.stale') : e?.data?.detail || t('admin.update.notes.startFailed'))
      if (stale) onReload()
      setBusy(false)
    }
  }

  return (
    <>
      <UiCard className="overflow-hidden">
        <dl className="flex flex-col text-[13.5px]">
          <Row first label={t('admin.update.notes.version')}>
            <span className="font-mono" data-testid="update-path">{versions.join(' → ')}</span>{' '}
            <span className="text-muted-foreground">· {t(`admin.update.channel.${a.channel}.short`)}</span>
          </Row>
          <Row label={t('admin.update.notes.size')}>{formatBytes(a.download_bytes) ? <Mono>{formatBytes(a.download_bytes)}</Mono> : null}</Row>
          <Row label={t('admin.update.notes.downtime')}>
            {down ? <><Mono>{down}</Mono> <span className="text-muted-foreground">· {t('admin.update.notes.downtimeNote')}</span></> : null}
          </Row>
          <Row label={t('admin.update.notes.zones')}>{zones.length ? <span data-testid="update-zones">{zones.join(', ')}</span> : null}</Row>
        </dl>
      </UiCard>

      <ChangelogCard text={a.changelog} />

      {a.plugin_warnings.length > 0 && (
        <UiCallout tone="warning" data-testid="update-plugin-warning"
          title={<UiTrans k="admin.update.notes.plugins.title" slots={{ n: <Mono>{a.plugin_warnings.length}</Mono> }} />}>
          {a.plugin_warnings.map(p => p.name || p.id).join(', ')} · {t('admin.update.notes.plugins.body')}
        </UiCallout>
      )}

      {mids.length > 0 && (
        <UiCallout tone="neutral" icon="info" data-testid="update-hop"
          title={<UiTrans k="admin.update.notes.hop.title" slots={{ versions: <Mono>{mids.join(', ')}</Mono> }} values={{ n: a.path.length }} />}>
          {t('admin.update.notes.hop.body', { n: a.path.length })}
        </UiCallout>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
        <span className="min-w-0 flex-1 basis-[240px] text-[13px] text-muted-foreground">{t('admin.update.notes.footnote')}</span>
        <UiButton variant="secondary" disabled={busy} onClick={() => navigate(UPDATE_BASE)}>{t('admin.update.notes.later')}</UiButton>
        <UiButton size="lg" icon="arrow-right" disabled={busy || !!status.job} onClick={() => { void start() }}>{t('admin.update.notes.start')}</UiButton>
      </div>
    </>
  )
}

export default NotesView
