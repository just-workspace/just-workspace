/**
 * 적용 진행 화면 — 설치와 복원이 공용한다. 단계 목록(완료 · 진행 중 · 실패 · 대기)과 전체 진행 막대,
 * 진행 중인 단계의 세부(이미지별 · 구역별), 실패한 단계의 실패 카드를 렌더링한다. 설정 단계의 이미지 진행은 비밀 키 생성에
 * 사용하는 backend 이미지의 선행 다운로드이며, 해당 용도를 함께 표시한다.
 * 단계 목록과 상태는 서버가 전달한 그대로이다(저장소 연결 같은 단계는 필요한 경우에만 목록에 포함된다).
 * 진행 상황은 서버의 상태 흐름으로 수신한다. 숫자 변경 시마다 낭독되지 않도록 진행 부분에는 aria-live 를 두지 않는다.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { UiBadge, type UiBadgeTone } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiCallout } from '~/components/ui/Callout'
import { UiCard } from '~/components/ui/Card'
import { UiIcon } from '~/components/ui/Icon'
import { UiProgress } from '~/components/ui/Progress'
import { cn } from '~/lib/utils'
import type { ApplyLog, ApplyState, ApplyStep, ApplyStepStatus } from '../api/types'
import { josa, M, useHas, useLocalized, useT } from '../i18n'
import { hashFor, navigate } from '../router'
import { Heading } from '../shell/WizardShell'
import { useWizard, useWizardStore } from '../store'

const DONE_REDIRECT_MS = 3000

const LOOK: Record<ApplyStepStatus, { icon: string; color: string; tone: UiBadgeTone }> = {
  done: { icon: 'check', color: 'text-success', tone: 'success' },
  running: { icon: 'loader', color: 'text-primary', tone: 'primary' },
  failed: { icon: 'alert-circle', color: 'text-danger', tone: 'danger' },
  pending: { icon: 'clock', color: 'text-muted-foreground', tone: 'neutral' },
}

export interface ApplyViewProps {
  kind: 'install' | 'restore'
  /** 실패 카드에서 복귀할 화면(요약 · 내용 확인) */
  backTo: 'summary' | 'review'
}

export function applyCounts(state: ApplyState | null): { done: number; total: number } {
  const steps = state?.steps ?? []
  return { done: steps.filter(s => s.status === 'done').length, total: steps.length }
}

function elapsedSeconds(state: ApplyState | null, now: number): number | null {
  if (!state?.started_at) return null
  const start = Date.parse(state.started_at)
  const end = state.finished_at ? Date.parse(state.finished_at) : now
  if (Number.isNaN(start) || Number.isNaN(end)) return null
  return Math.max(0, Math.round((end - start) / 1000))
}

function SubRow({ name, value, text, tone }: { name: string; value: number | null; text: string; tone?: 'primary' | 'success' | 'danger' }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,180px)_1fr_auto]">
      <span className="min-w-0 truncate font-mono text-xs">{name}</span>
      <span className="order-last col-span-2 sm:order-none sm:col-span-1"><UiProgress size="sm" label={name} value={value} tone={tone} /></span>
      <span className="text-right text-xs text-muted-foreground">{text}</span>
    </div>
  )
}

export function ApplyView({ kind, backTo }: ApplyViewProps) {
  const t = useT()
  const has = useHas()
  const localized = useLocalized()
  const store = useWizardStore()
  const api = useWizard(s => s.api)
  const state = useWizard(s => s.apply)
  const epoch = useWizard(s => s.applyEpoch)
  const answers = useWizard(s => s.answers)
  const catalog = useWizard(s => s.catalog)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [actionFailed, setActionFailed] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const [log, setLog] = useState<{ step: string; data: ApplyLog | null; failed: boolean } | null>(null)
  const redirect = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 상태 흐름을 구독한다(화면 이탈 시 해제). 흐름은 최종 상태에서 닫히므로, 재실행(epoch) 시 새로 구독한다
  useEffect(() => {
    const onState = (s: ApplyState) => store.getState().receiveApply(s)
    return kind === 'restore' ? api.restoreStream(onState) : api.streamApply(onState)
  }, [api, kind, store, epoch])

  const status = state?.status ?? 'idle'
  useEffect(() => {
    if (status !== 'running') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [status])

  // 전체 완료 시 잠시 후 완료 화면으로 이동한다 — 서버는 이 시점에 마법사를 잠그므로, 이 창에서 완료했음을 먼저 기록한다
  useEffect(() => {
    if (status !== 'done') return
    store.getState().markFinished()
    redirect.current = setTimeout(() => navigate('done', { replace: true }), DONE_REDIRECT_MS)
    return () => { if (redirect.current) clearTimeout(redirect.current) }
  }, [status, store])

  const { done, total } = applyCounts(state)
  const failed = status === 'failed'
  const finished = status === 'done'
  const secs = elapsedSeconds(state, now)
  const title = kind === 'restore'
    ? t(finished ? 'restore.applyTitleDone' : (failed ? 'restore.applyTitleFailed' : 'restore.applyTitleRunning'))
    : t(finished ? 'apply.titleDone' : (failed ? 'apply.titleFailed' : 'apply.titleRunning'))
  const lead = finished
    ? t('apply.leadDone')
    : (failed
        ? t(kind === 'restore' ? 'restore.applyLeadFailed' : 'apply.leadFailed')
        : (status === 'idle' ? t('apply.leadIdle') : t(kind === 'restore' ? 'restore.applyLeadRunning' : 'apply.leadRunning')))

  const stepLabel = (id: string) => {
    if (kind === 'restore' && has(`apply.restoreSteps.${id}`)) return t(`apply.restoreSteps.${id}`)
    return has(`apply.steps.${id}`) ? t(`apply.steps.${id}`) : id
  }
  const zoneName = (id: string) => localized([...(catalog?.zones ?? []), ...(catalog?.addons ?? [])].find(z => z.id === id)?.name) || id

  async function act(run: () => Promise<ApplyState>) {
    setBusy(true)
    setActionFailed(false)
    try {
      store.getState().kickApply(await run())
      setLogOpen(false)
      setLog(null)
    } catch {
      setActionFailed(true)
    } finally {
      setBusy(false)
    }
  }
  const retry = () => act(() => {
    if (kind === 'restore') return api.restoreRetry()
    // 실패한 단계 없이 중단된 경우(시작 전 검사) 처음부터 재시작
    return (state?.steps ?? []).some(s => s.status === 'failed') ? api.retryApply() : api.startApply()
  })
  /** 임시 인증서로 전환하여 계속 — 서버가 답변의 인증서 방식을 변경하므로 화면이 보유한 답변도 일치시킨다(완료 화면의 할 일에 사용) */
  const continueWithTemporaryCert = () => act(async () => {
    const next = kind === 'restore' ? await api.restoreRetry({ use_temporary_cert: true }) : await api.retryApply({ use_temporary_cert: true })
    store.setState(s => ({ answers: { ...s.answers, access: { ...s.answers.access, cert: 'temporary' } } }))
    return next
  })

  async function toggleLog(step: string) {
    const open = !logOpen
    setLogOpen(open)
    if (!open || (log?.step === step && log.data)) return
    setLog({ step, data: null, failed: false })
    try {
      setLog({ step, data: await api.getApplyLog(step), failed: false })
    } catch {
      setLog({ step, data: null, failed: true })
    }
  }

  /** 기록을 파일로 다운로드(서버가 전달한 줄을 그대로 텍스트 파일로 저장) */
  async function downloadLog(step: string) {
    try {
      const data = await api.getApplyLog(step, 5000)
      const url = URL.createObjectURL(new Blob([data.lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `install-${step}.log`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      setActionFailed(true)
    }
  }

  function failure(stepId: string, error: ApplyStep['error']): { title: ReactNode; body: ReactNode; code: string } {
    const step = { id: stepId, error }
    const cause = step.error?.cause ?? ''
    const vars = { ...(step.error?.vars ?? {}) } as Record<string, unknown>
    let key = 'other'
    // 원인에 정확히 대응하는 문구가 있으면 해당 문구를 우선한다(복원의 "다른 저장소" 같은 원인은 저장소 단계에서도 별도로 통지한다)
    const known = has(`apply.fail.${cause}.title`)
    if (step.id === 'storage' && !known) {
      // 복원을 이어서 확인하는 창은 저장소 이름을 알 수 없는 경우가 있음 — 이 경우 이름 없는 문구 사용
      const named = answers.storage.kind === 'nfs' && !!answers.storage.server
      key = kind === 'restore' && !named ? 'restore_storage' : (answers.storage.kind === 'nfs' ? 'storage' : 'storage_local')
      vars.target = `${answers.storage.server ?? ''}:${answers.storage.export ?? ''}`
      vars.p = josa(String(answers.storage.export ?? ''), '을/를')
    } else if (known) {
      key = cause
      if (cause.startsWith('cert_')) {
        vars.domain = Array.isArray(vars.names) && vars.names.length ? String(vars.names[0]) : answers.access.domain
        if (Array.isArray(vars.names)) vars.names = vars.names.join(', ')
      }
      if (cause === 'image_pull_failed') vars.p = josa(String(vars.image ?? ''), '을/를')
      if (cause === 'service_not_ready') vars.p = josa(String(vars.container ?? ''), '이/가')
      if (cause === 'admin_username_taken') vars.p = josa(String(vars.username ?? ''), '이/가')
    } else if (step.id === 'zones' && typeof vars.zone === 'string') {
      key = 'zone'
      vars.zone = zoneName(vars.zone)
    }
    return { title: <M k={`apply.fail.${key}.title`} v={vars} />, body: <M k={`apply.fail.${key}.body`} v={vars} />, code: cause }
  }
  /** 내부 원인 코드는 본문에 노출하지 않고 접힌 영역에만 표시한다 */
  const failCode = (code: string) => code
    ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">{t('apply.failDetails')}</summary>
          <span className="font-mono">{t('apply.failCode', { code })}</span>
        </details>
      )
    : null

  // 단계 진입 전에 중단된 경우(답변 검증 · 사전 점검) — 실패한 단계 없음
  const gateFailure = failed && !(state?.steps ?? []).some(s => s.status === 'failed') ? failure(state?.error?.step ?? '', state?.error ?? null) : null
  const btn = 'h-auto min-h-9 whitespace-normal py-1.5 text-left'
  return (
    <>
      <Heading title={title} lead={lead} />
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[13px]">
          <span><M k="apply.count" v={{ total, done }} /></span>
          {secs != null && <span className="font-mono text-xs text-muted-foreground">{t('apply.elapsed', { min: Math.floor(secs / 60), sec: secs % 60 })}</span>}
        </div>
        <UiProgress
          label={t(kind === 'restore' ? 'restore.applyProgressLabel' : 'apply.progressLabel')}
          value={done}
          max={Math.max(total, 1)}
          tone={failed ? 'danger' : (finished ? 'success' : 'primary')}
        />
      </div>

      <UiCard className="overflow-hidden">
        <ol className="m-0 list-none p-0">
          {(state?.steps ?? []).map(step => {
            const look = LOOK[step.status]
            const emphasize = step.status === 'running' || step.status === 'failed'
            const images = step.detail?.images ?? []
            const zones = step.detail?.zones ?? []
            const fail = step.status === 'failed' ? failure(step.id, step.error) : null
            const alternatives = state?.alternatives ?? []
            return (
              <li key={step.id} data-step={step.id} data-status={step.status} className={cn('border-t border-border first:border-t-0', step.status === 'failed' && 'bg-danger/10')}>
                <div className="flex min-h-12 items-center gap-3 px-4 py-1.5">
                  <span className={cn('flex shrink-0', look.color)}>
                    <UiIcon name={look.icon} aria-hidden="true" strokeWidth={2.4} className={cn('size-[18px]', step.status === 'running' && 'animate-spin motion-reduce:animate-none')} />
                  </span>
                  <span className={cn('min-w-0 flex-1 text-[13.5px]', emphasize && 'font-semibold', step.status === 'pending' && 'text-muted-foreground')}>{stepLabel(step.id)}</span>
                  <UiBadge tone={look.tone} tint size={18}>{t(`apply.status.${step.status}`)}</UiBadge>
                </div>

                {step.status === 'running' && (images.length > 0 || zones.length > 0) && (
                  <div className="flex flex-col gap-2 pb-3.5 pl-[46px] pr-4">
                    {/* 설정 단계는 비밀 키 생성에 사용하는 backend 이미지 1개를 먼저 받는다 — 이미지 단계의 진행과 구별되도록 용도를 표시한다 */}
                    {step.id === 'config' && images.length > 0 && (
                      <span className="text-xs text-muted-foreground" data-testid="apply-config-image-note">{t('apply.configImageNote')}</span>
                    )}
                    {images.map(im => (
                      <SubRow
                        key={im.image}
                        name={im.image}
                        value={im.status === 'done' || im.status === 'present' ? 100 : (im.status === 'pending' ? 0 : (im.percent ?? null))}
                        text={im.status === 'pulling' && im.percent != null ? `${im.percent}%` : t(`apply.image.${im.status}`)}
                        tone={im.status === 'failed' ? 'danger' : 'primary'}
                      />
                    ))}
                    {zones.map(z => (
                      <SubRow
                        key={z.id}
                        name={zoneName(z.id)}
                        value={z.status === 'done' ? 100 : (z.status === 'pending' ? 0 : (z.status === 'installing' ? 33 : 66))}
                        text={t(`apply.zone.${z.status}`)}
                        tone={z.status === 'failed' ? 'danger' : 'primary'}
                      />
                    ))}
                  </div>
                )}

                {fail && (
                  <div role="alert" className="flex flex-col gap-3 pb-4 pl-[46px] pr-4">
                    <div className="flex flex-col gap-1 text-[13px]">
                      <span className="font-semibold">{fail.title}</span>
                      <span className="text-muted-foreground">{fail.body}</span>
                      {failCode(fail.code)}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <UiButton type="button" size="sm" icon="refresh" className={btn} disabled={busy} onClick={() => { void retry() }}>{t('apply.retry')}</UiButton>
                      {alternatives.some(x => x.key === 'use_temporary_cert') && (
                        <UiButton type="button" size="sm" variant="secondary" className={btn} disabled={busy} onClick={() => { void continueWithTemporaryCert() }}>{t('apply.useTemporaryCert')}</UiButton>
                      )}
                      {kind === 'install' && step.id === 'storage' && (
                        <UiButton as="a" size="sm" variant="secondary" className={btn} href={hashFor('storage', { fix: true })}>{t('apply.fixStorage')}</UiButton>
                      )}
                      <UiButton type="button" size="sm" variant="outline" icon="terminal" iconRight={logOpen ? 'chevron-up' : 'chevron-down'} className={btn} aria-expanded={logOpen} aria-controls={`log-${step.id}`} onClick={() => { void toggleLog(step.id) }}>{t('apply.showLog')}</UiButton>
                      <UiButton type="button" size="sm" variant="outline" icon="download" className={btn} onClick={() => { void downloadLog(step.id) }}>{t('apply.downloadLog')}</UiButton>
                      <UiButton as="a" size="sm" variant="ghost" className={btn} href={hashFor(backTo)}>{t(backTo === 'review' ? 'restore.backToReview' : 'apply.backToSummary')}</UiButton>
                    </div>
                    {actionFailed && <span className="text-[13px] text-danger">{t('apply.retryFailed')}</span>}
                    <div id={`log-${step.id}`} hidden={!logOpen}>
                      {logOpen && (
                        log?.data
                          ? (log.data.lines.length
                              ? <pre tabIndex={0} aria-label={t('apply.logLabel', { step: stepLabel(step.id) })} className="m-0 max-h-64 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-xs leading-[18px] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring">{log.data.lines.join('\n')}</pre>
                              : <span className="text-[13px] text-muted-foreground">{t('apply.logEmpty')}</span>)
                          : <span className="text-[13px] text-muted-foreground">{log?.failed ? t('apply.logFailed') : t('apply.logLoading')}</span>
                      )}
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      </UiCard>

      {gateFailure && (
        <UiCallout
          tone="danger"
          role="alert"
          title={gateFailure.title}
          actions={(
            <>
              <UiButton type="button" size="sm" icon="refresh" disabled={busy} onClick={() => { void retry() }}>{t('common.retry')}</UiButton>
              <UiButton as="a" size="sm" variant="secondary" href={hashFor(state?.error?.cause === 'preflight_failed' ? 'check' : backTo, { fix: state?.error?.cause === 'preflight_failed' })}>
                {state?.error?.cause === 'preflight_failed' ? t('summary.seeCheck') : t(backTo === 'review' ? 'restore.backToReview' : 'apply.backToSummary')}
              </UiButton>
            </>
          )}
        >
          {gateFailure.body}
          {failCode(gateFailure.code)}
        </UiCallout>
      )}

      {finished
        ? (
            <UiCallout
              tone="success"
              role="status"
              actions={<UiButton type="button" size="sm" iconRight="arrow-right" onClick={() => navigate('done', { replace: true })}>{t('apply.openDone')}</UiButton>}
            >
              <span className="text-foreground">{t('apply.doneNote')}</span>
            </UiCallout>
          )
        : <p className="m-0 text-[13px] text-muted-foreground">{t(kind === 'restore' ? 'restore.applyFootnote' : 'apply.footnote')}</p>}
    </>
  )
}
