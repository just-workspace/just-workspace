/**
 * 업데이트 › 진행 — 업데이트(여섯 단계)와 되돌림·복원(다섯 단계)의 진행·실패·완료.
 *
 *  · 1.5초마다 작업을 다시 읽는다. 서버가 바뀌는 동안 읽기가 실패하면 마지막으로 본 상태를 둔 채
 *    "다시 연결 중"으로 견디고, 돌아오면 같은 작업 id 로 이어 읽는다(docs/update-api.md 7절).
 *  · 실패했을 때 무엇을 할 수 있는지는 서버가 준 `choices` 가 정한다 — 단계 이름으로 짐작하지 않는다.
 *    둘 다 있으면 "이 단계부터 다시" / "되돌리기", 없고 되돌림 작업이 붙어 있으면 자동 되돌림 안내.
 *  · 이 화면이 떠 있는 동안에는 점검 화면이 덮지 않는다(관리자는 진행을 봐야 한다).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useI18n } from '~/i18n'
import { addToast } from '~/composables/useToast'
import { useNowTick } from '~/composables/useNowTick'
import { useMaintenanceExempt } from '~/composables/useUpdateNotice'
import {
  updateApi, clock, errorCode, jobPath, unavailableReason, UPDATE_BASE, UPDATE_DOCS_URL,
  type JobAction, type UpdateJob,
} from '~/composables/useSystemUpdate'
import { LogButtons, Mono, StepRows, Unavailable, usePoll, type StepRowData } from '~/components/admin/update/parts'
import { UiCard } from '~/components/ui/Card'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiCallout } from '~/components/ui/Callout'
import { UiProgress } from '~/components/ui/Progress'
import { UiStepList } from '~/components/ui/StepList'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiTrans } from '~/components/ui/Trans'

/** 되돌림·복원 작업의 문구 묶음: 자동 되돌림 / 관리자가 고른 복원 / 시험판 이전 상태로 */
function flavor(job: UpdateJob): 'auto' | 'manual' | 'beta' {
  if (job.kind === 'rollback') return 'auto'
  return job.restore?.reason === 'beta' ? 'beta' : 'manual'
}

export function JobView({ jobId, onFinished }: { jobId: string; onFinished?: () => void }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  useMaintenanceExempt()
  const [job, setJob] = useState<UpdateJob | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const finished = useRef(false)
  const seen = useRef(false)

  const read = useCallback(async () => {
    try {
      const j = await updateApi.job(jobId)
      if (!alive.current) return
      seen.current = true
      setJob(j); setError(null); setReconnecting(false)
    } catch (e) {
      if (!alive.current) return
      // 처음부터 못 읽었으면 오류로, 읽던 중이면 서버가 다시 뜨는 중일 수 있다 — 계속 읽는다
      if (seen.current) setReconnecting(true)
      else setError(e)
    }
  }, [jobId])

  useEffect(() => {
    alive.current = true
    finished.current = false
    seen.current = false
    setJob(null); setError(null); setReconnecting(false)
    void read()
    return () => { alive.current = false }
  }, [read])

  const active = !!job && (job.status === 'countdown' || job.status === 'running')
  usePoll(active || (!job && !!error && !unavailableReason(error)), read)
  useEffect(() => {
    if (job && !active && !finished.current) { finished.current = true; onFinished?.() }
  }, [job, active, onFinished])

  const counting = job?.status === 'countdown' && !!job.countdown
  const now = useNowTick(counting || job?.status === 'running')

  if (!job) {
    const reason = error ? unavailableReason(error) : null
    if (reason) return <Unavailable reason={reason} />
    if (error && errorCode(error) === 'job_unknown') {
      return <UiErrorTile placement="card" title={t('admin.update.job.unknown')} noRetry secondaryLabel={t('admin.update.toHome')} onSecondary={() => navigate(UPDATE_BASE)} />
    }
    return error
      ? <UiCallout tone="info" icon="loader" spin role="status" data-testid="update-reconnecting">{t('admin.update.job.reconnecting')}</UiCallout>
      : <UiCard><UiSkeleton preset="list" rows={6} /></UiCard>
  }

  const isUpdate = job.kind === 'update'
  const fl = flavor(job)
  const ns = isUpdate ? 'admin.update.apply' : `admin.update.rollback.${fl}`
  const target = job.target_version ?? ''
  const hop = isUpdate && job.path.length > 1
  const current = hop ? job.path[job.version_index] ?? target : target
  const failed = job.status === 'failed'
  const done = job.status === 'done'
  const doneN = done ? job.steps.length : job.steps.filter(s => s.status === 'done').length
  const failedStep = job.steps.find(s => s.status === 'failed')?.id ?? job.error?.step ?? null
  const since = job.maintenance_started_at ?? job.started_at
  const elapsed = job.status === 'running' && since && !Number.isNaN(Date.parse(since)) ? clock((now - Date.parse(since)) / 1000) : ''
  const left = counting ? Math.max(0, Math.ceil((Date.parse(job.countdown!.ends_at) - now) / 1000)) : 0

  const title = job.status === 'cancelled' ? t(`${ns}.cancelled`)
    : done ? t(`${ns}.doneTitle`, { version: target })
      : failed ? t(`${ns}.failedTitle`)
        : job.status === 'countdown' ? t(`${ns}.soonTitle`)
          : t(`${ns}.runningTitle`, { version: isUpdate ? current : target })
  const lead = done ? t(`${ns}.doneLead`) : failed ? t(`${ns}.failedLead`) : job.status === 'cancelled' ? '' : t(`${ns}.lead`)

  async function act(action: JobAction) {
    setBusy(true)
    try {
      const next = await updateApi.jobAction(job!.id, action)
      if (!alive.current) return
      if (action === 'rollback' && next.rollback_job) { navigate(`${UPDATE_BASE}/rollback/${next.rollback_job}`); return }
      setJob(next)
      finished.current = false
    } catch (e: any) {
      addToast('error', errorCode(e) === 'action_not_allowed' ? t('admin.update.job.notAllowed') : e?.data?.detail || t('admin.update.job.actionFailed'))
      void read()
    } finally { if (alive.current) setBusy(false) }
  }

  const canRetry = job.choices.includes('retry')
  const canRollback = job.choices.includes('rollback')
  const autoRollback = isUpdate && failed && !job.choices.length && !!job.rollback_job
  const backup = typeof job.error?.vars?.backup_location === 'string' ? job.error.vars.backup_location : ''

  const failure = failed ? (
    <div data-testid="update-failure" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 text-[13px]">
        <span className="font-medium text-foreground">{t(`admin.update.fail.${isUpdate ? 'update' : 'rollback'}.${failedStep}`, t('admin.update.fail.generic'))}</span>
        <span className="text-muted-foreground">
          {isUpdate && canRetry && canRollback && <UiTrans k="admin.update.fail.choice" slots={{ version: <Mono>{job.from_version}</Mono> }} />}
          {autoRollback && <UiTrans k={job.trigger === 'auto' ? 'admin.update.fail.autoTrigger' : 'admin.update.fail.autoRollback'} slots={{ version: <Mono>{job.from_version}</Mono> }} />}
          {!isUpdate && (
            <>
              {t('admin.update.fail.stopped')}{' '}
              {backup && <><UiTrans k="admin.update.fail.backupAt" slots={{ path: <Mono className="break-all">{backup}</Mono> }} />{' '}</>}
              <UiTrans k="admin.update.fail.docs" slots={{ link: c => <a href={UPDATE_DOCS_URL} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{c}</a> }} />
            </>
          )}
        </span>
        {job.error?.detail && <span className="break-all font-mono text-xs text-muted-foreground" data-testid="update-error-detail">{job.error.detail}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canRetry && <UiButton size="sm" icon="refresh" disabled={busy} onClick={() => { void act('retry') }}>{t('admin.update.fail.doRetry')}</UiButton>}
        {canRollback && <UiButton size="sm" variant="secondary" disabled={busy} onClick={() => { void act('rollback') }}>{t('admin.update.fail.doRollback')}</UiButton>}
        {autoRollback && <UiButton size="sm" onClick={() => navigate(`${UPDATE_BASE}/rollback/${job.rollback_job}`)}>{t('admin.update.fail.watchRollback')}</UiButton>}
        <LogButtons jobId={job.id} />
      </div>
    </div>
  ) : null

  const steps: StepRowData[] = job.steps.map(s => ({
    id: s.id,
    label: t(`admin.update.step.${s.id}`, s.id),
    status: done ? 'done' : s.status,
    images: s.detail?.images,
    percent: s.detail?.percent ?? null,
  }))

  return (
    <>
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 basis-[240px] flex-col gap-1">
          <h2 className="text-base font-semibold leading-6" data-testid="update-job-title">{title}</h2>
          {lead && <p className="text-[13.5px] text-muted-foreground">{lead}</p>}
        </div>
        {hop && (
          <UiBadge tone="primary" tint data-testid="update-version-index">
            <UiTrans k="admin.update.apply.hop" slots={{ pos: <Mono>{job.version_index + 1}/{job.path.length}</Mono>, version: <Mono>{current}</Mono> }} />
          </UiBadge>
        )}
      </div>

      {hop && (
        <UiStepList variant="compact" label={t('admin.update.apply.versions')}
          labels={{ done: t('admin.update.step.status.done'), current: t('admin.update.step.status.running'), todo: t('admin.update.step.status.pending'), skipped: '' }}
          steps={job.path.map((v, i) => ({ id: v, label: v, state: done || i < job.version_index ? 'done' : i === job.version_index ? 'current' : 'todo' }))} />
      )}

      {reconnecting && <UiCallout tone="info" icon="loader" spin role="status" data-testid="update-reconnecting">{t('admin.update.job.reconnecting')}</UiCallout>}

      {counting && (
        <UiCallout tone="warning" icon="clock" data-testid="update-job-countdown"
          title={<>{t(`${ns}.countdown`)} <span aria-hidden="true" className="font-mono">{clock(left)}</span></>}
          actions={<>
            <UiButton size="sm" disabled={busy} onClick={() => { void act('start_now') }}>{t('shell.update.countdown.startNow')}</UiButton>
            <UiButton size="sm" variant="outline" disabled={busy} onClick={() => { void act('cancel') }}>{t('common.cancel')}</UiButton>
          </>}>
          {t('admin.update.apply.countdownBody')}
        </UiCallout>
      )}

      {job.status === 'cancelled' ? (
        <div className="flex justify-end"><UiButton onClick={() => navigate(UPDATE_BASE)}>{t('admin.update.toHome')}</UiButton></div>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-3 text-[13px] text-muted-foreground">
              <span data-testid="update-progress-text"><UiTrans k="admin.update.job.progress" slots={{ total: <Mono>{job.steps.length}</Mono>, done: <Mono>{doneN}</Mono> }} /></span>
              {elapsed && <span className="font-mono" aria-hidden="true">{elapsed}</span>}
            </div>
            <UiProgress label={t(isUpdate ? 'admin.update.apply.progress' : 'admin.update.rollback.progress')} value={doneN} max={job.steps.length || 1} tone={failed ? 'danger' : done ? 'success' : 'primary'} />
          </div>

          <UiCard className="overflow-hidden">
            <StepRows steps={steps} label={t(isUpdate ? 'admin.update.apply.steps' : 'admin.update.rollback.steps')} failure={failure} />
          </UiCard>

          {done && (
            <UiCallout tone="success" role="status" data-testid="update-job-done"
              actions={<UiButton size="sm" iconRight="arrow-right" onClick={() => navigate(UPDATE_BASE)}>{t('admin.update.toHome')}</UiButton>}>
              <UiTrans k={`${ns}.doneText`} slots={{ version: <Mono>{target}</Mono> }} />
            </UiCallout>
          )}
          {!done && !failed && <p className="text-xs leading-[18px] text-muted-foreground">{t(isUpdate ? 'admin.update.apply.footnote' : 'admin.update.rollback.footnote')}</p>}
        </>
      )}
    </>
  )
}

/** 작업 id 없이 들어왔을 때 — 진행 중인 것이 있으면 그리로 보낸다 */
export function JobRedirect({ job, fallback }: { job: UpdateJob | null; fallback: string }) {
  const navigate = useNavigate()
  useEffect(() => { navigate(job ? jobPath(job) : fallback, { replace: true }) }, [job, fallback, navigate])
  return null
}

export default JobView
