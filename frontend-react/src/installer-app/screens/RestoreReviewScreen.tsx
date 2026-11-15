/**
 * 복원 — 내용 확인. 백업에 든 것(만든 서버 · 버전 · 구역 · 데이터 · 원래 저장 위치 · 파일 포함 여부)을 보여 주고,
 * 이 서버에서 파일을 둘 곳과 접속 주소를 정한 뒤 "복원"을 누른다.
 *  - 원래 서버가 네트워크 저장소를 썼으면 파일은 백업에 없다 — 같은 공유를 다시 연결해야 한다(이 서버의 디스크는 고를 수 없다).
 *  - 접속 주소가 아직 이 서버를 가리키지 않아도 복원은 할 수 있다(경고만 하고, 임시 인증서로 설치한다).
 *  - 백업이 설치하는 버전보다 새 버전이면 복원할 수 없다.
 */
import { useEffect, useState } from 'react'
import { UiButton } from '~/components/ui/Button'
import { UiCallout } from '~/components/ui/Callout'
import { UiCard } from '~/components/ui/Card'
import { UiIcon } from '~/components/ui/Icon'
import { UiInput } from '~/components/ui/Input'
import { UiRadioCard } from '~/components/ui/RadioCard'
import { ApiError, type RestoreReview, type StorageKind } from '../api/types'
import { bytesText, trim1 } from '../format'
import { prevStep } from '../flow'
import { M, useHas, useLocale, useLocalized, useT } from '../i18n'
import { DnsStatus, useDnsCheck } from '../parts/DnsStatus'
import { NfsFields, nfsCauseText, nfsFailedIndex, nfsView } from '../parts/NfsCheck'
import { navigate } from '../router'
import { Heading, SubHeading, WizardShell } from '../shell/WizardShell'
import { flowOf, useWizard, useWizardStore } from '../store'
import { RestoreUnsupported } from './RestoreFileScreen'

export function RestoreReviewScreen() {
  const t = useT()
  const has = useHas()
  const localized = useLocalized()
  const { locale } = useLocale()
  const store = useWizardStore()
  const api = useWizard(s => s.api)
  const answers = useWizard(s => s.answers)
  const catalog = useWizard(s => s.catalog)
  const freeGb = useWizard(s => s.server?.facts.disk_free_gb ?? null)
  const nfs = useWizard(s => s.nfs)
  const [review, setReview] = useState<RestoreReview | null>(null)
  const [load, setLoad] = useState<'loading' | 'ready' | 'failed' | 'unsupported'>('loading')
  const [pick, setPick] = useState<StorageKind>('local')
  const [server, setServer] = useState('')
  const [exportPath, setExportPath] = useState('')
  const [domain, setDomain] = useState('')
  const [starting, setStarting] = useState(false)
  const [startFailed, setStartFailed] = useState(false)
  const dns = useDnsCheck(domain)

  useEffect(() => {
    let alive = true
    api.restoreReview().then(r => {
      if (!alive) return
      setReview(r)
      setPick(r.storage.kind)
      setServer(r.storage.server ?? '')
      setExportPath(r.storage.export ?? '')
      setDomain(r.domain)
      setLoad('ready')
    }).catch(e => { if (alive) setLoad(e instanceof ApiError && e.notImplemented ? 'unsupported' : 'failed') })
    return () => { alive = false }
  }, [api])

  const prev = prevStep(flowOf(answers, catalog), 'review')
  if (!review) {
    return (
      <WizardShell step="review">
        <Heading title={t('restore.reviewTitle')} lead={t('restore.reviewLead')} />
        {load === 'unsupported' && <RestoreUnsupported />}
        {load === 'failed' && <UiCallout tone="danger" role="alert">{t('restore.reviewFailed')}</UiCallout>}
        {load === 'loading' && <UiCallout variant="plain" tone="neutral" icon="loader" spin role="status">{t('common.loading')}</UiCallout>}
        {prev && <div><UiButton type="button" variant="secondary" onClick={() => navigate(prev)}>{t('nav.prev')}</UiButton></div>}
      </WizardShell>
    )
  }

  const fromNfs = review.storage.kind === 'nfs'
  const noFiles = !fromNfs && !review.files_included
  const kind: StorageKind = fromNfs ? 'nfs' : pick
  const view = nfsView(nfs, server, exportPath)
  const verBad = review.version_status === 'newer'
  const dnsWarn = dns === 'mismatch' || dns === 'unknown'
  const failedIndex = view === 'failed' ? nfsFailedIndex(nfs.result) : 0
  const zoneNames = catalog
    ? [localized(catalog.core.name), ...review.zones.map(id => localized([...catalog.zones, ...catalog.addons].find(z => z.id === id)?.name) || id)]
    : review.zones
  const when = review.created_at && !Number.isNaN(Date.parse(review.created_at))
    ? new Date(review.created_at).toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : ''

  let blocked = ''
  if (verBad) blocked = t('restore.reasonVersion')
  else if (kind === 'nfs' && view === 'failed') blocked = t('restore.reasonNfsFailed')
  else if (kind === 'nfs' && view !== 'ok') blocked = t('restore.reasonNfs')
  else if (dns === 'idle' || dns === 'invalid') blocked = t('restore.reasonAddress')
  else if (dns === 'checking') blocked = t('restore.reasonDnsChecking')
  const reason = blocked || (startFailed ? t('restore.startFailed') : '')

  async function start() {
    setStarting(true)
    setStartFailed(false)
    try {
      const state = await api.restoreApply({
        domain: domain.trim(),
        storage: kind === 'nfs' ? { kind: 'nfs', server: server.trim(), export: exportPath.trim() } : { kind: 'local' },
      })
      store.getState().kickApply(state)
      navigate('apply')
    } catch {
      setStartFailed(true)
      setStarting(false)
    }
  }

  const row = 'grid grid-cols-1 gap-x-4 gap-y-0.5 border-t border-border px-4 py-2.5 first:border-t-0 sm:grid-cols-[140px_1fr]'
  const choose = (v: string | number | null) => { if (v != null) setPick(v as StorageKind) }
  return (
    <WizardShell step="review">
      <Heading title={t('restore.reviewTitle')} lead={t('restore.reviewLead')} />
      <UiCard className="overflow-hidden">
        <dl className="m-0 text-[13px]">
          {review.source_url && (
            <div className={row}>
              <dt className="text-muted-foreground">{t('restore.rowSource')}</dt>
              <dd className="m-0"><span className="break-all font-mono">{review.source_url}</span>{when && <span className="text-muted-foreground"> · {when}</span>}</dd>
            </div>
          )}
          {review.backup_version && (
            <div className={row}>
              <dt className="text-muted-foreground">{t('restore.rowVersion')}</dt>
              <dd className="m-0">
                <span className="inline-flex items-start gap-1.5">
                  <span className={`mt-0.5 flex shrink-0 ${verBad ? 'text-danger' : 'text-success'}`}><UiIcon name={verBad ? 'alert-circle' : 'check-circle'} aria-hidden="true" className="size-4" /></span>
                  <span>{t(verBad ? 'restore.versionNewer' : 'restore.versionOk', { version: review.backup_version })}</span>
                </span>
              </dd>
            </div>
          )}
          <div className={row}>
            <dt className="text-muted-foreground">{t('restore.rowZones')}</dt>
            <dd className="m-0">{zoneNames.join(', ')}</dd>
          </div>
          {(review.users != null || review.data_bytes != null) && (
            <div className={row}>
              <dt className="text-muted-foreground">{t('restore.rowData')}</dt>
              <dd className="m-0 font-mono text-xs">
                {[review.users != null ? t('restore.users', { n: review.users }) : '', review.data_bytes != null ? bytesText(review.data_bytes) : ''].filter(Boolean).join(' · ')}
              </dd>
            </div>
          )}
          <div className={row}>
            <dt className="text-muted-foreground">{t('restore.rowOrigin')}</dt>
            <dd className="m-0 break-all">{fromNfs ? t('restore.originNfs', { target: `${review.storage.server}:${review.storage.export}` }) : t('restore.originLocal')}</dd>
          </div>
          <div className={row}>
            <dt className="text-muted-foreground">{t('restore.rowFiles')}</dt>
            <dd className="m-0">
              {fromNfs
                ? t('restore.filesNfs')
                : (noFiles ? t('restore.filesNone') : (review.files_bytes != null ? t('restore.filesIncluded', { size: bytesText(review.files_bytes) }) : t('restore.filesIncludedNoSize')))}
            </dd>
          </div>
        </dl>
      </UiCard>

      <div className="flex flex-col gap-3">
        <SubHeading id="st-h">{t('restore.targetTitle')}</SubHeading>
        <div role="radiogroup" aria-labelledby="st-h" className="flex flex-col gap-2">
          <UiRadioCard className="w-full" layout="row" value="local" title={t('restore.localTitle')} description={freeGb != null ? t('restore.localDesc', { gb: trim1(freeGb) }) : t('restore.localDescNoFree')} modelValue={kind} onUpdateModelValue={choose} disabled={fromNfs} />
          <UiRadioCard className="w-full" layout="row" value="nfs" title={t('restore.nfsTitle')} description={t(fromNfs ? 'restore.nfsDescReconnect' : 'restore.nfsDescMove')} modelValue={kind} onUpdateModelValue={choose} />
        </div>
        {fromNfs && <UiCallout variant="plain" tone="neutral" icon="lock" role="status">{t('restore.localOff')}</UiCallout>}
        {noFiles && <UiCallout tone="warning" title={t('restore.noFilesTitle')}>{t('restore.noFilesBody')}</UiCallout>}
        {kind === 'nfs' && (
          <>
            <NfsFields server={server} exportPath={exportPath} onServer={setServer} onExport={setExportPath} hint={view === 'input' ? t('restore.nfsIdle') : undefined} />
            {view === 'checking' && <UiCallout variant="plain" tone="neutral" icon="loader" spin role="status">{t('restore.nfsChecking')}</UiCallout>}
            {view === 'ok' && <UiCallout variant="plain" tone="success" role="status" title={t('restore.nfsOk')}>{t('restore.nfsOkBody')}</UiCallout>}
            {view === 'error' && <UiCallout tone="danger" role="alert">{t('common.probeFailed')}</UiCallout>}
            {view === 'failed' && (
              <UiCallout tone="danger" role="alert" title={t('restore.nfsFailTitle', { n: failedIndex })}>
                {nfsCauseText(nfs.result?.cause, t, has)}{nfs.result?.cause === 'permission_denied' ? ` ${t('restore.nfsPermissionExtra')}` : ''}
              </UiCallout>
            )}
          </>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <UiInput label={t('domain.addressLabel')} mono icon="globe" inputMode="url" modelValue={domain} onUpdateModelValue={setDomain} hint={t('restore.addressHint')} />
        <DnsStatus domain={domain} />
      </div>
      {dnsWarn && <UiCallout tone="warning" title={t('restore.dnsWarnTitle')}>{t('restore.dnsWarnBody')}</UiCallout>}
      {verBad && (
        <UiCallout tone="danger" role="alert" title={t('restore.verBadTitle')}>
          <M k="restore.verBadBody" v={{ backup: review.backup_version ?? '', installer: review.installer_version ?? '' }} />
        </UiCallout>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        {prev && <UiButton type="button" variant="secondary" onClick={() => navigate(prev)}>{t('nav.prev')}</UiButton>}
        <span id="rv-reason" role="status" className={`min-w-0 flex-1 text-right text-[13px] text-muted-foreground ${reason ? 'basis-[200px]' : 'basis-0'}`}>{reason}</span>
        <UiButton type="button" size="lg" iconRight="arrow-right" disabled={!!blocked || starting} aria-describedby={reason ? 'rv-reason' : undefined} onClick={() => { void start() }}>{t('restore.restore')}</UiButton>
      </div>
    </WizardShell>
  )
}
