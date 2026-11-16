/**
 * 구역 켜기 창 · 켜진 구역의 설정 창.
 *
 * 켜기(mode="enable"):
 *   1) 설정 — 설정이 있는 구역만 해당(메일·회의·AI 도우미·코드 저장소). 연결 확인이 필요한 폼은 통과 전까지 [다음]이 비활성화되고 사유가 표시된다.
 *   2) 메모리와 포트 확인 — 서버가 판정한다. 메모리를 초과하면 [켜기]가 비활성화되고 사유가 표시된다.
 *      본 구역 활성화로 새로 발생하는 주의 사항(인증서·포트·메일 레코드 등)이 있으면 아래에 함께 표시된다.
 *   → [켜기]를 누르면 창이 닫히고, 다운로드·설정·연결 진행은 목록의 해당 행에서 계속 표시된다.
 * 설정(mode="settings"): 동일한 폼 1장 + [저장]. 변경 내용이 없으면 [저장]이 비활성화된다.
 */
import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import {
  zonesApi, errorCode, localized, recommendGb, gb, formatPorts, initialSettings, toPayload, blockReason, cautionText,
  type ZoneCheck, type ZoneJob, type ZoneMemory, type ZoneRow, type ZoneSettings,
} from '~/composables/useSystemZones'
import { UiModal } from '~/components/ui/Modal'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiCallout } from '~/components/ui/Callout'
import { ZoneSettingsForm, type VerifyState } from './ZoneSettingsForm'

export interface ZoneDialogProps {
  zone: ZoneRow
  mode: 'enable' | 'settings'
  /** 현재 활성 구역 기준의 메모리(활성화 전 합계) */
  memory: ZoneMemory
  /** 코드 저장소의 검증된 버전(목록이 제공한 값 — 설정 조회 시 해당 값이 우선) */
  verifiedVersion?: string | null
  onClose: () => void
  /** 작업 시작됨 — 창은 닫히고 행이 진행 상태를 표시한다 */
  onStarted: (job: ZoneJob, settings: ZoneSettings | null) => void
}

export function ZoneDialog({ zone, mode, memory, verifiedVersion, onClose, onStarted }: ZoneDialogProps) {
  const { t, locale } = useI18n()
  const name = localized(zone.name, locale)
  const hasForm = zone.has_settings
  const [step, setStep] = useState<'form' | 'confirm'>(mode === 'settings' || hasForm ? 'form' : 'confirm')
  const [loading, setLoading] = useState(hasForm)
  const [form, setForm] = useState<ZoneSettings>(() => initialSettings(zone.id, undefined))
  const [saved, setSaved] = useState<string>('')
  const [detectedIp, setDetectedIp] = useState<string | null>(null)
  const [verified, setVerified] = useState<string | null>(verifiedVersion ?? null)
  const [redetecting, setRedetecting] = useState(false)
  const [verify, setVerify] = useState<VerifyState>({ state: 'idle' })
  const [report, setReport] = useState<ZoneCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<{ field: string; code: string }[]>([])

  // 저장된 값과 감지값을 조회한다(비활성 구역에도 이전 값이 남아 있을 수 있다)
  useEffect(() => {
    let alive = true
    if (!hasForm) { void runCheck(null); return }
    zonesApi.settings(zone.id).then((r) => {
      if (!alive) return
      const init = initialSettings(zone.id, r.settings)
      setForm(init)
      setSaved(JSON.stringify(toPayload(zone.id, init)))
      setDetectedIp(r.detected?.public_ip || null)
      if (r.verified_version) setVerified(r.verified_version)
    }).catch(() => {
      if (alive) setSaved(JSON.stringify(toPayload(zone.id, initialSettings(zone.id, undefined))))
    }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zone.id])

  const payload = useMemo(() => (hasForm ? toPayload(zone.id, form) : null), [hasForm, zone.id, form])
  const reasonKey = hasForm ? blockReason(zone.id, form, verify.state === 'ok', detectedIp) : null
  const unchanged = mode === 'settings' && JSON.stringify(payload) === saved

  function change(patch: ZoneSettings, resetVerify = false) {
    setForm(f => ({ ...f, ...patch }))
    if (resetVerify) setVerify({ state: 'idle' })
    setError(''); setFieldErrors([])
  }

  function fail(e: unknown) {
    const code = errorCode(e)
    const errs = (e as any)?.data?.vars?.errors
    if (code === 'settings_invalid' && Array.isArray(errs)) { setFieldErrors(errs); setError(t('admin.zones.dialog.invalid')); return }
    if (code === 'busy') { setError(t('admin.zones.dialog.busy')); return }
    if (code === 'memory_insufficient') { setError(t('admin.zones.dialog.memShort')); return }
    setError((e as any)?.data?.detail || t('admin.zones.dialog.failed'))
  }

  async function runCheck(settings: ZoneSettings | null) {
    setBusy(true); setError(''); setFieldErrors([])
    try {
      const r = await zonesApi.check(zone.id, settings)
      if (r.errors?.length) { setFieldErrors(r.errors); setError(t('admin.zones.dialog.invalid')); setStep(hasForm ? 'form' : 'confirm'); return }
      setReport(r)
      setStep('confirm')
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  async function runVerify() {
    setVerify({ state: 'running' })
    try {
      const r = zone.id === 'mail'
        ? await zonesApi.probeSmtp({ host: String(form.host).trim(), port: Number(form.port), security: form.security, username: String(form.username).trim(), ...(form.password ? { password: form.password } : {}) })
        : await zonesApi.probeAi({ provider: form.provider, ...(form.api_key ? { api_key: form.api_key } : {}) })
      setVerify(r.status === 'ok' ? { state: 'ok' } : { state: 'failed', code: r.status })
    } catch { setVerify({ state: 'failed', code: 'error' }) }
  }

  async function redetect() {
    setRedetecting(true)
    try { setDetectedIp((await zonesApi.probePublicIp(true)).ip || null) } catch { /* 기존 상태 유지 */ } finally { setRedetecting(false) }
  }

  async function submit() {
    setBusy(true); setError('')
    try {
      const job = mode === 'settings' ? await zonesApi.saveSettings(zone.id, payload ?? {}) : await zonesApi.enable(zone.id, payload)
      onStarted(job, payload)
    } catch (e) { fail(e); setBusy(false) }
  }

  const errorBox = error && (
    <UiCallout tone="danger" role="alert" title={error} data-testid="zone-dialog-error">
      {fieldErrors.length > 0 && <span className="font-mono text-xs">{fieldErrors.map(x => `${x.field}: ${x.code}`).join(' · ')}</span>}
    </UiCallout>
  )

  // ── 설정(1단계 또는 설정 창) ──
  if (step === 'form') {
    const blockedText = reasonKey ? t(reasonKey) : unchanged ? t('admin.zones.dialog.unchanged') : ''
    const primaryDisabled = loading || busy || !!reasonKey || unchanged
    return (
      <UiModal
        size="680"
        title={mode === 'settings' ? t('admin.zones.dialog.titleSettings', { name }) : t('admin.zones.dialog.titleForm', { name })}
        onClose={onClose}
        footer={
          <>
            {blockedText && !loading && <span className="mr-auto min-w-0 text-[13px] text-muted-foreground" data-testid="zone-dialog-reason">{blockedText}</span>}
            <UiButton variant="outline" size="sm" onClick={onClose}>{t('common.cancel')}</UiButton>
            {mode === 'settings'
              ? <UiButton size="sm" disabled={primaryDisabled} onClick={() => { void submit() }}>{t('common.save')}</UiButton>
              : <UiButton size="sm" iconRight="arrow-right" disabled={primaryDisabled} onClick={() => { void runCheck(payload) }}>{t('admin.zones.dialog.next')}</UiButton>}
          </>
        }
      >
        <div className="flex flex-col gap-4 text-[13.5px]">
          {loading
            ? <UiSkeleton preset="text" rows={4} />
            : <ZoneSettingsForm zoneId={zone.id} form={form} onChange={change} verify={verify} onVerify={() => { void runVerify() }}
                detectedIp={detectedIp} onRedetectIp={() => { void redetect() }} redetecting={redetecting} reopened={mode === 'settings'} verifiedVersion={verified} />}
          {errorBox}
        </div>
      </UiModal>
    )
  }

  // ── 메모리와 포트 확인 ──
  const mem = report?.memory
  const memOk = !!mem && mem.ok !== false
  const server = gb(mem?.nominal_mb ?? memory.nominal_mb)
  const before = recommendGb(memory.need_mb ?? 0)
  const after = recommendGb(mem?.need_mb ?? (memory.need_mb ?? 0) + zone.recommend_mb)
  const ports = report?.ports ?? []
  const cautions = (report?.cautions ?? []).filter(c => c && typeof c.key === 'string')
  return (
    <UiModal
      size="480"
      title={hasForm ? t('admin.zones.dialog.titleConfirm3', { name }) : t('admin.zones.dialog.titleConfirm2', { name })}
      onClose={onClose}
      footer={
        <>
          {hasForm
            ? <UiButton variant="outline" size="sm" disabled={busy} onClick={() => { setStep('form'); setError('') }}>{t('admin.zones.dialog.prev')}</UiButton>
            : <UiButton variant="outline" size="sm" onClick={onClose}>{t('common.cancel')}</UiButton>}
          <UiButton size="sm" disabled={!report || !memOk || busy} onClick={() => { void submit() }}>{t('admin.zones.dialog.enable')}</UiButton>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13.5px]">
        {!report && !error ? <UiSkeleton preset="text" rows={3} /> : report && (
          <dl className="m-0 flex flex-col gap-2.5">
            <div className="flex gap-3">
              <dt className="w-[72px] shrink-0 text-muted-foreground">{t('admin.zones.dialog.memory')}</dt>
              <dd className="m-0">
                <span className={cn('inline-flex flex-wrap items-center gap-1.5 font-medium', memOk ? 'text-success' : 'text-danger')} data-testid="zone-dialog-memory">
                  <UiIcon name={memOk ? 'check-circle' : 'alert-circle'} className="h-4 w-4" />
                  {memOk ? t('admin.zones.dialog.memOk', { before, after, server }) : t('admin.zones.dialog.memBad', { after, server })}
                </span>
              </dd>
            </div>
            <div className="flex gap-3">
              <dt className="w-[72px] shrink-0 text-muted-foreground">{t('admin.zones.dialog.ports')}</dt>
              <dd className="m-0 flex flex-col">
                <span className="font-mono" data-testid="zone-dialog-ports">{ports.length ? formatPorts(ports) : t('admin.zones.dialog.portsNone')}</span>
                <span className="text-xs leading-4 text-muted-foreground">{ports.length ? t('admin.zones.dialog.portsNote') : t('admin.zones.dialog.portsNoneNote')}</span>
              </dd>
            </div>
            <div className="flex gap-3">
              <dt className="w-[72px] shrink-0 text-muted-foreground">{t('admin.zones.dialog.progress')}</dt>
              <dd className="m-0">{t('admin.zones.dialog.steps')}</dd>
            </div>
          </dl>
        )}
        {report && cautions.length > 0 && (
          <UiCallout tone="warning" role="status" title={t('admin.zones.dialog.cautions')} data-testid="zone-dialog-cautions">
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-muted-foreground">
              {cautions.map((c, i) => {
                const { key, values } = cautionText(c)
                return <li key={`${c.key}-${i}`} className="break-words" data-caution={c.key}>{t(key, values)}</li>
              })}
            </ul>
          </UiCallout>
        )}
        {errorBox}
      </div>
    </UiModal>
  )
}

export default ZoneDialog
