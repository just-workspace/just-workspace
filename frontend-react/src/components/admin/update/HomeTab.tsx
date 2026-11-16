/**
 * 업데이트 › 현황 — 현재 버전·채널·적용 방식·마지막 확인, "지금 확인", 수신 가능한 버전.
 * 상태: 최신 / 새 버전 / 확인 중 / 확인 실패 + 대기(안정판 복귀) · 차단(경로 없음).
 * 최상단에는 야간 자동 업데이트의 결과 띠(성공 · 실패 후 중지 → "다시 켜기")와 진행 중인 작업의 안내를 표시한다.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useI18n } from '~/i18n'
import { addToast } from '~/composables/useToast'
import { updateApi, formatBytes, formatTime, isLive, jobPath, UPDATE_BASE, type UpdateStatus } from '~/composables/useSystemUpdate'
import { useDurationText } from '~/components/layout/UpdateCountdownBanner'
import { Row, Mono } from '~/components/admin/update/parts'
import { UiCard } from '~/components/ui/Card'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiCallout } from '~/components/ui/Callout'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiTrans } from '~/components/ui/Trans'

const DISMISS_PREFIX = 'jw.update.autoResult.'
const dismissed = (job: string) => { try { return localStorage.getItem(DISMISS_PREFIX + job) === '1' } catch { return false } }
const dismiss = (job: string) => { try { localStorage.setItem(DISMISS_PREFIX + job, '1') } catch { /* 저장에 실패해도 현재 화면에서는 닫힌다 */ } }

/** 야간 자동 업데이트의 결과 — 성공 / 실패 후 롤백(자동 업데이트 중지) / 재활성화 직후 */
export function AutoResultBand({ status, onChanged }: { status: UpdateStatus; onChanged: () => void }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const duration = useDurationText()
  const last = status.last_auto
  const [closed, setClosed] = useState(() => (last ? dismissed(last.job) : true))
  const [resumed, setResumed] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!last) return null

  const window = `${status.settings.window.start}~${status.settings.window.end}`
  if (resumed) {
    return (
      <UiCallout tone="success" role="status" data-testid="update-auto-resumed" title={t('admin.update.auto.resumed.title')}>
        {t('admin.update.auto.resumed.body', { window })}
      </UiCallout>
    )
  }
  if (closed) return null
  const close = () => { dismiss(last.job); setClosed(true) }
  const at = formatTime(last.finished_at)

  if (last.result === 'success') {
    const down = duration(last.downtime_seconds)
    return (
      <UiCallout tone="success" role="status" data-testid="update-auto-ok"
        title={<UiTrans k="admin.update.auto.ok.title" slots={{ version: <Mono>{last.version}</Mono> }} />}
        actions={<>
          {last.version && <UiButton variant="link" size="xs" onClick={() => navigate(`${UPDATE_BASE}/changes/${encodeURIComponent(last.version!)}`)}>{t('admin.update.auto.ok.changes')}</UiButton>}
          <UiButton variant="link" size="xs" onClick={() => navigate(`${UPDATE_BASE}/history`)}>{t('admin.update.auto.history')}</UiButton>
          <UiButton variant="ghost" size="xs" onClick={close}>{t('common.close')}</UiButton>
        </>}>
        {t('admin.update.auto.ok.kind')}
        {at && <> · <UiTrans k="admin.update.auto.ok.at" slots={{ time: <Mono>{at}</Mono> }} /></>}
        {down && <> · <UiTrans k="admin.update.auto.ok.down" slots={{ time: <Mono>{down}</Mono> }} /></>}
      </UiCallout>
    )
  }
  if (last.result !== 'rolled_back' && last.result !== 'rollback_failed') return null

  async function resume() {
    setBusy(true)
    try {
      await updateApi.resumeAuto()
      dismiss(last!.job)
      setResumed(true)
      onChanged()
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('admin.update.auto.resumeFailed'))
    } finally { setBusy(false) }
  }
  const rolledBack = last.result === 'rolled_back'
  return (
    <UiCallout tone="danger" role="alert" data-testid="update-auto-failed"
      title={t(rolledBack ? 'admin.update.auto.bad.title' : 'admin.update.auto.bad.titleStuck')}
      actions={<>
        {status.auto.paused && <UiButton size="sm" icon="refresh" disabled={busy} onClick={() => { void resume() }}>{t('admin.update.auto.resume')}</UiButton>}
        <UiButton size="sm" variant="outline" onClick={() => navigate(`${UPDATE_BASE}/history`)}>{t('admin.update.auto.bad.history')}</UiButton>
        <UiButton size="sm" variant="ghost" onClick={close}>{t('common.close')}</UiButton>
      </>}>
      {at && last.failed_step && <><UiTrans k="admin.update.auto.bad.where" slots={{ time: <Mono>{at}</Mono> }} values={{ step: t(`admin.update.step.${last.failed_step}`) }} />{' '}</>}
      {rolledBack && last.from_version && <><UiTrans k="admin.update.auto.bad.now" slots={{ version: <Mono>{last.from_version}</Mono> }} />{' '}</>}
      {status.auto.paused ? t('admin.update.auto.bad.paused') : null}
    </UiCallout>
  )
}

export function HomeTab({ status, onReload, onChecked }: { status: UpdateStatus; onReload: () => void; onChecked: (s: UpdateStatus) => void }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const duration = useDurationText()
  const [starting, setStarting] = useState(false)
  const [resuming, setResuming] = useState(false)

  const checking = starting || status.check.state === 'checking'
  const failed = !checking && status.check.ok === false
  const a = status.available
  const s = status.settings
  const auto = s.mode === 'auto'
  const window = `${s.window.start}~${s.window.end}`

  async function check() {
    setStarting(true)
    try {
      onChecked(await updateApi.check())
    } catch (e: any) {
      addToast('error', e?.data?.code === 'busy' ? t('admin.update.busy') : e?.data?.detail || t('admin.update.home.checkFailed'))
    } finally { setStarting(false) }
  }
  async function resume() {
    setResuming(true)
    try { await updateApi.resumeAuto(); onReload() } catch (e: any) { addToast('error', e?.data?.detail || t('admin.update.auto.resumeFailed')) } finally { setResuming(false) }
  }

  const live = isLive(status.job) ? status.job : null
  const checkedAt = formatTime(status.check.last_at)

  return (
    <>
      <AutoResultBand status={status} onChanged={onReload} />

      {live && (
        <UiCallout tone="info" icon="loader" spin role="status" data-testid="update-live-job" title={t(`admin.update.home.live.${live.kind}`)}
          actions={<UiButton size="sm" onClick={() => navigate(jobPath(live))} iconRight="arrow-right">{t('admin.update.home.live.open')}</UiButton>} />
      )}

      <UiCard className="overflow-hidden">
        <dl className="flex flex-col text-[13.5px]">
          <Row first label={t('admin.update.home.current')}
            action={<UiButton variant="link" size="xs" onClick={() => navigate(`${UPDATE_BASE}/changes/${encodeURIComponent(status.current.version)}`)}>{t('admin.update.home.changes')}</UiButton>}>
            <Mono data-testid="update-current">{status.current.version}</Mono>
          </Row>
          <Row label={t('admin.update.home.channel')} action={<UiButton variant="link" size="xs" onClick={() => navigate(`${UPDATE_BASE}/settings`)}>{t('admin.update.home.change')}</UiButton>}>
            <div className="flex flex-wrap items-center gap-2">
              <UiBadge tone={s.channel === 'beta' ? 'warning' : 'neutral'} tint size={18}>{t(`admin.update.channel.${s.channel}.short`)}</UiBadge>
              <span className="text-muted-foreground">{t(`admin.update.channel.${s.channel}.desc`)}</span>
            </div>
          </Row>
          <Row label={t('admin.update.home.mode')} action={<UiButton variant="link" size="xs" onClick={() => navigate(`${UPDATE_BASE}/settings`)}>{t('admin.update.home.change')}</UiButton>}>
            <div className="flex flex-wrap items-center gap-2">
              <span>
                {t(`admin.update.mode.${s.mode}.title`)}{' '}
                <span className="text-muted-foreground">
                  {status.auto.paused && auto ? t('admin.update.home.modePaused')
                    : auto ? <>· <Mono>{window}</Mono>{t('admin.update.home.modeAuto', { days: s.min_age_days })}</>
                      : `· ${t('admin.update.mode.manual.desc')}`}
                </span>
              </span>
              {status.auto.paused && auto && (
                <>
                  <UiBadge tone="danger" tint size={18} data-testid="update-paused"><UiIcon name="alert-circle" />{t('admin.update.home.paused')}</UiBadge>
                  <UiButton variant="link" size="xs" disabled={resuming} onClick={() => { void resume() }}>{t('admin.update.auto.resumeShort')}</UiButton>
                </>
              )}
            </div>
          </Row>
          <Row label={t('admin.update.home.lastCheck')}>
            {checkedAt ? <Mono>{checkedAt}</Mono> : <span className="text-muted-foreground">{t('admin.update.home.neverChecked')}</span>}
          </Row>
        </dl>
      </UiCard>

      <div className="flex flex-wrap items-center gap-3">
        <UiButton variant="secondary" icon="refresh" disabled={checking || !!live} onClick={() => { void check() }}>{t('admin.update.home.check')}</UiButton>
        {checking && (
          <span role="status" className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground" data-testid="update-checking">
            <UiIcon name="loader" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t('admin.update.home.checking')}
          </span>
        )}
        {!checking && !failed && a.state === 'none' && (
          <span role="status" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-success" data-testid="update-latest">
            <UiIcon name="check-circle" className="h-4 w-4" />{t('admin.update.home.latest')}
          </span>
        )}
      </div>

      {!checking && a.state === 'update' && (
        <UiCard data-testid="update-available">
          <div className="flex flex-wrap items-center gap-3 p-4">
            <UiIcon name="download" className="h-[18px] w-[18px] shrink-0 text-primary" />
            <span className="flex min-w-0 flex-1 basis-[240px] flex-col">
              <span className="text-base font-semibold leading-6">{t('admin.update.home.newVersion')} <Mono>{a.version}</Mono></span>
              {(formatBytes(a.download_bytes) || duration(a.downtime_seconds)) && (
                <span className="text-[13px] text-muted-foreground">
                  {formatBytes(a.download_bytes) && <>{t('admin.update.notes.size')} <Mono>{formatBytes(a.download_bytes)}</Mono></>}
                  {formatBytes(a.download_bytes) && duration(a.downtime_seconds) && ' · '}
                  {duration(a.downtime_seconds) && <>{t('admin.update.notes.downtime')} <Mono>{duration(a.downtime_seconds)}</Mono></>}
                </span>
              )}
            </span>
            <UiButton iconRight="arrow-right" onClick={() => navigate(`${UPDATE_BASE}/notes`)}>{t('admin.update.home.view')}</UiButton>
          </div>
        </UiCard>
      )}

      {!checking && a.state === 'wait' && (
        <UiCallout tone="neutral" role="status" data-testid="update-wait" title={t('admin.update.home.wait.title')}>
          {a.resume_from
            ? <UiTrans k="admin.update.home.wait.body" slots={{ version: <Mono>{a.resume_from}</Mono>, current: <Mono>{status.current.version}</Mono> }} />
            : t('admin.update.home.wait.bodyUnknown')}
        </UiCallout>
      )}

      {!checking && a.state === 'blocked' && (
        <UiCallout tone="warning" role="status" data-testid="update-blocked"
          title={<UiTrans k="admin.update.home.blocked.title" slots={{ version: <Mono>{a.version}</Mono> }} />}>
          {a.reason?.vars?.min_upgrade_from
            ? <UiTrans k="admin.update.home.blocked.body" slots={{ version: <Mono>{String(a.reason.vars.min_upgrade_from)}</Mono> }} />
            : t('admin.update.home.blocked.bodyUnknown')}
        </UiCallout>
      )}

      {failed && (
        <>
          <UiCard data-testid="update-check-failed">
            <UiErrorTile className="m-4" title={t(status.check.error?.code === 'unconfigured' ? 'admin.update.home.failed.unconfiguredTitle' : 'admin.update.home.failed.title')}
              detail={[status.check.error?.detail || (status.check.error?.code ? t(`admin.update.home.failed.code.${status.check.error.code}`, status.check.error.code) : ''), checkedAt].filter(Boolean).join(' · ')}
              retryLabel={t('admin.update.home.failed.retry')} onRetry={() => { void check() }} />
          </UiCard>
          <p className="text-[13px] text-muted-foreground">
            <UiTrans k="admin.update.home.failed.offline" slots={{
              link: c => <a href={`${UPDATE_BASE}/offline`} className="text-primary hover:underline" onClick={(e) => { e.preventDefault(); navigate(`${UPDATE_BASE}/offline`) }}>{c}</a>,
            }} />
          </p>
        </>
      )}
    </>
  )
}

export default HomeTab
