/**
 * 관리 › 보안 — 인증서 카드. 접속 주소에 쓰는 인증서의 상태와 바꾸는 길.
 *
 *  · 상태: 종류(자동 발급 / 올린 인증서 / 임시) · 접속 주소 · 만료일과 남은 일수 · 발급자 · 인증서에 든 이름.
 *    임시(자체 서명) 인증서면 경고와 함께 보류된 구역 연결이 몇 건인지 알린다.
 *  · [다시 발급](Let's Encrypt) · [인증서 올리기](인증서·개인 키 파일 두 개). 둘 다 작업으로 돈다 —
 *    발급 → 다시 읽히기 → 구역 다시 연결. 진행은 1.5초마다 다시 읽고, 실패하면 쓰던 인증서가 그대로 남는다.
 *    올린 인증서가 검증을 통과하지 못하면 통과하지 못한 항목을 창 안에 보여 준다.
 *  · 화면을 새로 열어도 진행 중인 작업과 방금 끝난(또는 하루 안에 실패한) 작업이 보인다.
 *  · 앞단 프록시가 인증서를 맡는 설치는 안내만 보여 준다.
 *  · 설치 관리자 없이 구성한 설치(또는 인증서 경로가 없는 예전 설치 관리자)는 안내 한 줄만 — 이때 `onLegacy(true)` 로
 *    알려 호출한 화면이 예전 방식의 인증서 카드를 대신 보여 주게 한다.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { daysUntil } from '~/composables/useAdminOps'
import { zonesApi, errorCode, isActive, type ZoneJob } from '~/composables/useSystemZones'
import { certApi, failedChecks, fixKey, shownCertJob, CERT_FILE_MAX, type CertCheck, type CertState } from '~/composables/useSystemCert'
import { SettingsCard } from '~/components/settings/SettingsCard'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiCallout } from '~/components/ui/Callout'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiModal } from '~/components/ui/Modal'
import { UiProgress } from '~/components/ui/Progress'
import { UiSkeleton } from '~/components/ui/Skeleton'

/** 진행을 다시 읽는 간격 */
export const certTiming = { pollMs: 1500 }

/** 이 코드로 실패하면 설치 관리자가 인증서를 맡지 않는 설치다 */
const LEGACY_CODES = ['installer_unavailable', 'installer_unsupported']
const REQUEST_ERRORS = ['busy', 'cert_managed_by_proxy', 'not_installed', 'cert_auto_needs_domain', 'file_too_large', 'cert_invalid']
const FAIL_CAUSES = ['cert_issue_failed', 'cert_dir_managed', 'cert_invalid']
const STAGES = ['issue', 'reload', 'reconnect']

export interface AdminCertCardProps {
  /** true = 설치 관리자가 인증서를 맡지 않는 설치(예전 방식 카드를 쓴다) · false = 이 카드가 맡는다 */
  onLegacy?: (legacy: boolean) => void
  className?: string
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-border px-5 py-1.5">
      <dt className="w-[112px] shrink-0 text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 flex-1 basis-[200px]">{children}</dd>
    </div>
  )
}

function FilePick({ label, hint, file, onPick }: { label: string; hint: string; file: File | null; onPick: (f: File | null) => void }) {
  const { t } = useI18n()
  const input = useRef<HTMLInputElement | null>(null)
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label} <span className="text-xs font-normal text-muted-foreground">{hint}</span></span>
      <div className="flex min-h-11 flex-wrap items-center gap-2.5 rounded-md border border-border px-3 py-1.5 text-[13px]">
        <UiIcon name="file" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className={cn('min-w-0 flex-1 basis-[140px] truncate', file ? 'font-mono' : 'text-muted-foreground')}>{file ? file.name : t('admin.certCard.modal.none')}</span>
        <UiButton variant="outline" size="xs" onClick={() => input.current?.click()}>{file ? t('admin.certCard.modal.replace') : t('admin.certCard.modal.choose')}</UiButton>
      </div>
      <input ref={input} type="file" accept=".pem,.crt,.cer,.key,.txt" className="hidden" aria-label={label} onChange={e => onPick(e.target.files?.[0] || null)} />
    </div>
  )
}

export function AdminCertCard({ onLegacy, className }: AdminCertCardProps) {
  const { t, te, locale } = useI18n()
  const [cert, setCert] = useState<CertState | null>(null)
  const [errCode, setErrCode] = useState('')
  const [job, setJob] = useState<ZoneJob | null>(null)
  const [hidden, setHidden] = useState('')            // 닫은 작업 id
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [reconnecting, setReconnecting] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [certFile, setCertFile] = useState<File | null>(null)
  const [keyFile, setKeyFile] = useState<File | null>(null)
  const [uploadError, setUploadError] = useState('')
  const [checks, setChecks] = useState<CertCheck[]>([])
  const alive = useRef(true)
  const legacyCb = useRef(onLegacy)
  legacyCb.current = onLegacy

  const requestError = useCallback((e: unknown) => {
    const code = errorCode(e)
    if (REQUEST_ERRORS.includes(code)) return t(`admin.certCard.error.${code}`)
    return (e as { data?: { detail?: string } } | null)?.data?.detail || t('admin.certCard.error.generic')
  }, [t])

  const load = useCallback(async () => {
    try {
      const [c, recent] = await Promise.all([
        certApi.get(),
        zonesApi.jobs().then(r => (Array.isArray(r?.jobs) ? r.jobs : [])).catch(() => null),
      ])
      if (!alive.current) return
      setCert(c); setErrCode(''); setReconnecting(false)
      legacyCb.current?.(false)
      // 진행 중인 작업이 먼저, 없으면 가장 최근 인증서 작업(방금 끝났거나 하루 안에 실패한 것)
      const last = shownCertJob(c?.job) ?? (recent ? shownCertJob(recent.find(j => j?.kind === 'cert')) : undefined)
      if (last !== undefined) setJob(last)
    } catch (e) {
      if (!alive.current) return
      const code = errorCode(e) || 'error'
      setErrCode(code)
      legacyCb.current?.(LEGACY_CODES.includes(code))
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    return () => { alive.current = false }
  }, [load])

  // 진행 중인 작업을 다시 읽는다. 인증서를 다시 읽히는 동안 연결이 잠깐 끊길 수 있다 — 계속 읽는다
  const activeId = isActive(job) ? job.id : ''
  useEffect(() => {
    if (!activeId) return
    let stopped = false
    let running = false
    const tick = async () => {
      if (running || stopped) return
      running = true
      try {
        const next = await zonesApi.job(activeId)
        if (stopped) return
        setReconnecting(false)
        setJob(next)
        if (!isActive(next)) await load()
      } catch {
        if (!stopped) setReconnecting(true)
      } finally { running = false }
    }
    const id = setInterval(() => { void tick() }, certTiming.pollMs)
    return () => { stopped = true; clearInterval(id) }
  }, [activeId, load])

  async function reissue() {
    setBusy(true); setActionError('')
    try { setJob(await certApi.reissueAuto()); setHidden('') } catch (e) { setActionError(requestError(e)) } finally { setBusy(false) }
  }

  function openUpload() {
    setCertFile(null); setKeyFile(null); setUploadError(''); setChecks([]); setUploadOpen(true)
  }
  function pick(which: 'cert' | 'key', f: File | null) {
    if (which === 'cert') setCertFile(f); else setKeyFile(f)
    setUploadError(''); setChecks([])
  }
  async function upload() {
    if (!certFile || !keyFile) return
    if (certFile.size > CERT_FILE_MAX || keyFile.size > CERT_FILE_MAX) { setUploadError(t('admin.certCard.error.file_too_large')); return }
    setBusy(true); setUploadError(''); setChecks([])
    try {
      let certText = ''
      let keyText = ''
      try { [certText, keyText] = await Promise.all([certFile.text(), keyFile.text()]) } catch { setUploadError(t('admin.certCard.modal.readError')); return }
      setJob(await certApi.reissueUpload(certText, keyText))
      setHidden(''); setActionError(''); setUploadOpen(false)
    } catch (e) {
      const failed = failedChecks(e)
      setChecks(failed)
      setUploadError(failed.length ? t('admin.certCard.modal.checksTitle') : requestError(e))
    } finally { setBusy(false) }
  }

  // ── 설치 관리자가 맡지 않는 설치 · 불러오기 실패 ──
  if (errCode && !cert) {
    if (LEGACY_CODES.includes(errCode)) {
      const ns = errCode === 'installer_unavailable' ? 'noInstaller' : 'unsupported'
      return (
        <UiCallout tone="neutral" role="status" className={className} title={t(`admin.certCard.${ns}.title`)} data-testid="cert-legacy">
          <span className="text-muted-foreground">{t(`admin.certCard.${ns}.body`)}</span>
        </UiCallout>
      )
    }
    return <UiErrorTile placement="card" title={t('admin.certCard.loadError')} onRetry={() => { void load() }} className={className} />
  }
  if (!cert) {
    return <SettingsCard title={t('admin.certCard.title')} flush className={className}><UiSkeleton preset="list" rows={3} /></SettingsCard>
  }

  // ── 앞단 프록시가 맡는 설치 ──
  if (cert.managed !== true) {
    return (
      <SettingsCard title={t('admin.certCard.title')} className={className} data-testid="cert-card" data-state="proxy">
        <UiCallout tone="neutral" role="status" title={t('admin.certCard.proxy.title')}>
          <span className="text-muted-foreground">{t('admin.certCard.proxy.body')}</span>
        </UiCallout>
      </SettingsCard>
    )
  }

  const active = isActive(job)
  const shownJob = job && job.id !== hidden ? job : null
  const days = cert.days_left ?? daysUntil(cert.not_after)
  const parsed = cert.not_after ? new Date(cert.not_after) : null
  const date = parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toLocaleDateString(locale === 'ko' ? 'ko-KR' : 'en-US', { year: 'numeric', month: '2-digit', day: '2-digit' })
    : cert.not_after || ''
  const expiry = !date
    ? { tone: '', text: t('admin.certCard.expiry.unknown') }
    : days == null
      ? { tone: '', text: date }
      : days < 0
        ? { tone: 'text-danger', text: t('admin.certCard.expiry.expired', { date }) }
        : { tone: days <= 30 ? 'text-warning' : '', text: t('admin.certCard.expiry.left', { date, n: days }) }
  const badge = cert.temporary
    ? { tone: 'warning' as const, text: t('admin.certCard.badge.temporary') }
    : days != null && days < 0
      ? { tone: 'danger' as const, text: t('admin.certCard.badge.expired') }
      : days != null && days <= 30
        ? { tone: 'warning' as const, text: t('admin.certCard.badge.renew') }
        : null
  const modeKey = cert.mode && ['auto', 'upload', 'temporary', 'proxy'].includes(cert.mode) ? cert.mode : 'unknown'
  const cause = shownJob?.error?.cause || ''
  const failVars = { domain: cert.domain || '', ...(shownJob?.error?.vars as Record<string, unknown> | undefined) }
  const warnings = (shownJob?.warnings ?? []).filter(w => w && typeof w.key === 'string')

  return (
    <>
      <SettingsCard
        title={t('admin.certCard.title')}
        description={t('admin.certCard.desc')}
        flush
        className={className}
        data-testid="cert-card"
        data-state={active ? 'busy' : cert.temporary ? 'temporary' : 'ok'}
        header={badge && <UiBadge tone={badge.tone} tint>{badge.text}</UiBadge>}
      >
        <dl className="m-0 flex flex-col text-[13px]">
          <Row label={t('admin.certCard.row.kind')}><span data-testid="cert-mode">{t(`admin.certCard.mode.${modeKey}`)}</span></Row>
          {cert.domain && <Row label={t('admin.certCard.row.domain')}><span className="break-all font-mono">{cert.domain}</span></Row>}
          <Row label={t('admin.certCard.row.expiry')}><span className={cn('font-medium', expiry.tone)} data-testid="cert-expiry">{expiry.text}</span></Row>
          {cert.issuer && <Row label={t('admin.certCard.row.issuer')}><span className="break-words">{cert.issuer}{cert.self_signed && !cert.temporary ? ` · ${t('admin.certCard.badge.selfSigned')}` : ''}</span></Row>}
          {cert.names.length > 0 && <Row label={t('admin.certCard.row.names')}><span className="break-all font-mono" data-testid="cert-names">{cert.names.join(', ')}</span></Row>}
        </dl>

        <div className="flex flex-col gap-3 border-t border-border px-5 py-4 text-[13px]">
          {cert.temporary && (
            <UiCallout tone="warning" role="status" title={t('admin.certCard.temporary.title')} data-testid="cert-temporary">
              <span className="text-muted-foreground">
                {t('admin.certCard.temporary.body')}
                {cert.pending.length > 0 && <>{' '}{t('admin.certCard.temporary.pending', { n: cert.pending.length })}</>}
              </span>
            </UiCallout>
          )}

          {/* 진행 중 */}
          {shownJob && active && (
            <div className="flex flex-col gap-2" role="status" data-testid="cert-job">
              <span className="inline-flex items-center gap-1.5 font-medium text-primary">
                <UiIcon name="loader" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                {reconnecting || shownJob.status === 'unknown' ? t('admin.certCard.job.reconnecting') : t('admin.certCard.job.running')}
              </span>
              {shownJob.stages.map(s => {
                const label = STAGES.includes(s.id) ? t(`admin.certCard.stage.${s.id}`) : s.id
                return (
                  <div key={s.id} className="flex items-center gap-3 text-xs leading-4" data-testid={`cert-stage-${s.id}`}>
                    <span className="w-[112px] shrink-0 truncate text-muted-foreground">{label}</span>
                    <UiProgress className="min-w-0 flex-1" size="sm" label={label} value={s.status === 'done' ? 100 : s.status === 'running' ? null : 0} />
                    <span className="w-[52px] shrink-0 text-right text-muted-foreground">{t(`admin.zones.stageStatus.${s.status}`)}</span>
                  </div>
                )
              })}
            </div>
          )}

          {/* 끝난 직후 */}
          {shownJob && shownJob.status === 'done' && (
            <UiCallout tone="success" role="status" title={t('admin.certCard.job.done')} data-testid="cert-done"
              actions={<UiIconButton label={t('common.close')} icon="close" size="sm" onClick={() => setHidden(shownJob.id)} />}>
              <span className="text-muted-foreground">
                {t('admin.certCard.job.doneBody')}
                {warnings.map(w => <span key={w.key} className="block" data-warning={w.key}>{t(te(`admin.certCard.warn.${w.key}`) ? `admin.certCard.warn.${w.key}` : 'admin.certCard.warn.other', { key: w.key })}</span>)}
              </span>
            </UiCallout>
          )}

          {/* 실패 */}
          {shownJob && shownJob.status === 'failed' && (
            <UiCallout tone="danger" role="alert" title={t('admin.certCard.job.failed')} data-testid="cert-failed"
              actions={<UiIconButton label={t('common.close')} icon="close" size="sm" onClick={() => setHidden(shownJob.id)} />}>
              <span className="text-muted-foreground">
                {t(FAIL_CAUSES.includes(cause) ? `admin.certCard.fail.${cause}` : 'admin.certCard.fail.other', { ...failVars, cause: cause || '—' })}{' '}
                {t('admin.certCard.job.kept')}
              </span>
            </UiCallout>
          )}

          {actionError && <UiCallout tone="danger" role="alert" data-testid="cert-error">{actionError}</UiCallout>}

          <div className="flex flex-wrap items-center gap-2">
            <UiButton size="sm" icon="refresh" disabled={busy || active} onClick={() => { void reissue() }}>{t('admin.certCard.reissue')}</UiButton>
            <UiButton size="sm" variant="outline" icon="upload" disabled={busy || active} onClick={openUpload}>{t('admin.certCard.upload')}</UiButton>
          </div>
        </div>
      </SettingsCard>

      {uploadOpen && (
        <UiModal
          size="480"
          title={t('admin.certCard.modal.title')}
          onClose={() => { if (!busy) setUploadOpen(false) }}
          footer={
            <>
              {(!certFile || !keyFile) && <span className="mr-auto min-w-0 text-[13px] text-muted-foreground">{t('admin.certCard.modal.needBoth')}</span>}
              <UiButton variant="outline" size="sm" disabled={busy} onClick={() => setUploadOpen(false)}>{t('common.cancel')}</UiButton>
              <UiButton size="sm" disabled={busy || !certFile || !keyFile} onClick={() => { void upload() }}>{busy ? t('admin.certCard.modal.submitting') : t('admin.certCard.modal.submit')}</UiButton>
            </>
          }
        >
          <div className="flex flex-col gap-4 text-[13.5px]">
            <p className="m-0 text-muted-foreground">{t('admin.certCard.modal.lead')}</p>
            <FilePick label={t('admin.certCard.modal.certSlot')} hint={t('admin.certCard.modal.certHint')} file={certFile} onPick={f => pick('cert', f)} />
            <FilePick label={t('admin.certCard.modal.keySlot')} hint={t('admin.certCard.modal.keyHint')} file={keyFile} onPick={f => pick('key', f)} />
            {uploadError && (
              <UiCallout tone="danger" role="alert" title={uploadError} data-testid="cert-upload-error">
                {checks.length > 0 && (
                  <ul className="m-0 flex list-none flex-col gap-2 p-0">
                    {checks.map((c) => {
                      const k = fixKey(c)
                      return (
                        <li key={c.id} data-check={c.id}>
                          <b className="block font-semibold text-foreground">{t(`admin.certCard.msg.${k}.title`)}</b>
                          <span className="text-muted-foreground">{t(`admin.certCard.msg.${k}.body`, { domain: cert.domain || '', ...(c.fix?.vars ?? {}), code: c.fix?.key || c.id })}</span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </UiCallout>
            )}
            <p className="m-0 text-xs leading-[18px] text-muted-foreground">{t('admin.certCard.modal.footnote')}</p>
          </div>
        </UiModal>
      )}
    </>
  )
}

export default AdminCertCard
