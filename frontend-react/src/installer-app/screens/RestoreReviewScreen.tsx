/**
 * 복원 — 내용 확인. 백업에 든 것(만든 서버 · 버전 · 구역 · 데이터 · 원래 저장 위치 · 파일 포함 여부)을 보여 주고,
 * 이 서버에서 파일을 둘 곳과 접속 주소를 정한 뒤 "복원"을 누른다.
 *  - 원래 서버가 네트워크 저장소를 썼으면 파일은 백업에 없다 — 같은 공유를 다시 연결해야 한다(이 서버의 디스크는 고를 수 없다).
 *  - 접속 주소가 아직 이 서버를 가리키지 않아도 복원은 할 수 있다(경고만 하고, 임시 인증서로 설치한다).
 *  - 백업이 설치하는 버전보다 새 버전이면 복원할 수 없다. 서버가 알려 준 다른 막는 사유(메모리 부족 등)도 같이 보인다.
 *  - 연결 형태(직접 · 공유기 뒤 · 프록시 뒤)와 내부 대역은 백업의 값을 기본으로 채워 접어 둔다 — 새 서버의 자리가 다를 때만 연다.
 *  - 인증서 방식은 서버가 정한다(프록시 뒤 → 프록시, 접속 주소가 이 서버를 가리키면 자동 발급, 아니면 임시 인증서).
 *  - 서버가 시작을 거부하면(422) 사유를 항목별로 보인다. 올려 둔 백업이 사라졌으면(409) 파일 화면으로 돌아간다.
 */
import { useEffect, useState } from 'react'
import { UiButton } from '~/components/ui/Button'
import { UiCallout } from '~/components/ui/Callout'
import { UiCard } from '~/components/ui/Card'
import { UiDisclosure } from '~/components/ui/Disclosure'
import { UiIcon } from '~/components/ui/Icon'
import { UiInput } from '~/components/ui/Input'
import { UiRadioCard } from '~/components/ui/RadioCard'
import { UiSegment } from '~/components/ui/Segment'
import { ApiError, type FieldError, type Network, type RestoreBlocker, type RestoreReview, type StorageKind } from '../api/types'
import { bytesText, isAddressOrCidr, isSubnet24, serverGb, trim1, zoneGb } from '../format'
import { prevStep } from '../flow'
import { M, useHas, useLocale, useLocalized, useT } from '../i18n'
import { DnsStatus, useDnsCheck } from '../parts/DnsStatus'
import { NfsFields, nfsCauseText, nfsFailedIndex, nfsView } from '../parts/NfsCheck'
import { navigate } from '../router'
import { Heading, SubHeading, WizardShell } from '../shell/WizardShell'
import { flowOf, useWizard, useWizardStore } from '../store'
import { splitAddresses } from './ProxyScreen'
import { RestoreUnsupported } from './RestoreFileScreen'

const NETWORKS: Network[] = ['direct', 'router', 'proxy']

/** 막는 사유 · 시작 거부 사유의 문구에 넣을 값 — 메모리는 GB 로 */
function reasonVars(code: string, vars: Record<string, unknown> | undefined): Record<string, unknown> {
  const v = vars ?? {}
  return {
    ...v,
    code,
    need: typeof v.need_mb === 'number' ? trim1(zoneGb(v.need_mb)) : '',
    have: typeof v.have_mb === 'number' ? trim1(serverGb(v.have_mb)) : '',
  }
}

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
  const [network, setNetwork] = useState<Network>('direct')
  const [proxyText, setProxyText] = useState('')
  const [subnet, setSubnet] = useState('')
  const [starting, setStarting] = useState(false)
  const [startFailed, setStartFailed] = useState(false)
  const [startErrors, setStartErrors] = useState<FieldError[]>([])
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
      setNetwork(r.network ?? 'direct')
      setProxyText((r.proxy_addresses ?? []).join(', '))
      setSubnet(r.subnet ?? '')
      setLoad('ready')
    }).catch(e => {
      if (!alive) return
      // 올려 둔 백업이 없다 — 파일부터 다시
      if (e instanceof ApiError && e.code === 'restore_no_backup') { navigate('file', { replace: true }); return }
      setLoad(e instanceof ApiError && e.notImplemented ? 'unsupported' : 'failed')
    })
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
  const allBlockers: RestoreBlocker[] = review.blockers ?? []
  const verBad = review.version_status === 'newer' || allBlockers.some(b => b.code === 'version_newer')
  // 버전은 아래에 따로 자세히 알린다
  const blockers = allBlockers.filter(b => b.code !== 'version_newer')
  // 프록시 뒤에서는 접속 주소가 프록시를 가리키는 것이 정상이고, 인증서도 프록시가 맡는다
  const dnsWarn = network !== 'proxy' && (dns === 'mismatch' || dns === 'unknown')
  // 다섯 검사는 통과했는데 이 공유가 백업의 그 저장소가 아니면 실패한 번호가 없다(0)
  const failedIndex = view === 'failed' ? nfsFailedIndex(nfs.result) : 0
  const proxies = splitAddresses(proxyText)
  const proxyBad = network === 'proxy' && (proxies.length === 0 || !proxies.every(isAddressOrCidr))
  const subnetBad = subnet.trim() !== '' && !isSubnet24(subnet.trim())
  const zoneNames = catalog
    ? [localized(catalog.core.name), ...review.zones.map(id => localized([...catalog.zones, ...catalog.addons].find(z => z.id === id)?.name) || id)]
    : review.zones
  const when = review.created_at && !Number.isNaN(Date.parse(review.created_at))
    ? new Date(review.created_at).toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : ''

  let blocked = ''
  if (verBad) blocked = t('restore.reasonVersion')
  else if (blockers.length > 0) blocked = t('restore.reasonBlocked')
  else if (kind === 'nfs' && view === 'failed') blocked = t(failedIndex > 0 ? 'restore.reasonNfsFailed' : 'restore.reasonNfsMarker')
  else if (kind === 'nfs' && view !== 'ok') blocked = t('restore.reasonNfs')
  else if (dns === 'idle' || dns === 'invalid') blocked = t('restore.reasonAddress')
  else if (dns === 'checking') blocked = t('restore.reasonDnsChecking')
  else if (proxyBad) blocked = t('restore.reasonProxy')
  else if (subnetBad) blocked = t('restore.reasonSubnet')
  const reason = blocked || (startErrors.length > 0 ? t('restore.reasonStartErrors') : (startFailed ? t('restore.startFailed') : ''))

  async function start() {
    setStarting(true)
    setStartFailed(false)
    setStartErrors([])
    const storage = kind === 'nfs' ? { kind: 'nfs' as const, server: server.trim(), export: exportPath.trim() } : { kind: 'local' as const }
    try {
      const state = await api.restoreApply({
        domain: domain.trim(),
        storage,
        network,
        ...(network === 'proxy' ? { proxy_addresses: proxies } : {}),
        ...(subnet.trim() ? { subnet: subnet.trim() } : {}),
      })
      // 화면이 들고 있는 답변도 맞춘다(실패 카드의 저장소 이름 · 완료 화면의 접속 주소에 쓰인다)
      store.setState(s => ({
        answers: {
          ...s.answers,
          access: { ...s.answers.access, domain: domain.trim(), network, proxy_addresses: network === 'proxy' ? proxies : [] },
          storage: { kind: storage.kind, path: null, server: storage.kind === 'nfs' ? storage.server : null, export: storage.kind === 'nfs' ? storage.export : null },
        },
      }))
      store.getState().kickApply(state)
      navigate('apply')
    } catch (e) {
      if (e instanceof ApiError && e.code === 'restore_no_backup') { navigate('file', { replace: true }); return }
      const errors = e instanceof ApiError && e.code === 'restore_invalid' && Array.isArray(e.vars.errors) ? (e.vars.errors as FieldError[]) : []
      setStartErrors(errors)
      setStartFailed(errors.length === 0)
      setStarting(false)
    }
  }
  const reasonText = (group: 'blocker' | 'startError', code: string, vars?: Record<string, unknown>) =>
    t(has(`restore.${group}.${code}`) ? `restore.${group}.${code}` : `restore.${group}.other`, reasonVars(code, vars))

  const row = 'grid grid-cols-1 gap-x-4 gap-y-0.5 border-t border-border px-4 py-2.5 first:border-t-0 sm:grid-cols-[140px_1fr]'
  const choose = (v: string | number | null) => { if (v != null) setPick(v as StorageKind) }
  return (
    <WizardShell step="review">
      <Heading title={t('restore.reviewTitle')} lead={t('restore.reviewLead')} />
      {blockers.length > 0 && (
        <UiCallout tone="danger" role="alert" title={t('restore.blockedTitle')}>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {blockers.map(b => <li key={b.code}>{reasonText('blocker', b.code, b.vars)}</li>)}
          </ul>
        </UiCallout>
      )}
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
              <UiCallout tone="danger" role="alert" title={failedIndex > 0 ? t('restore.nfsFailTitle', { n: failedIndex }) : t('restore.nfsMarkerTitle')}>
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
      <UiDisclosure
        title={t('restore.networkTitle')}
        defaultOpen={proxyBad || subnetBad}
        description={subnet.trim() ? t('restore.networkSummary', { network: t(`domain.${network}Title`), subnet: subnet.trim() }) : t(`domain.${network}Title`)}
      >
        <div className="flex flex-col gap-4 px-4 pb-4 pt-1">
          <div className="flex flex-col gap-2">
            <div className="max-w-full overflow-x-auto">
              <UiSegment
                ariaLabel={t('domain.networkTitle')}
                items={NETWORKS.map(n => ({ value: n, label: t(`domain.${n}Title`) }))}
                modelValue={network}
                onUpdateModelValue={v => { if (v != null) setNetwork(v as Network) }}
              />
            </div>
            <span className="text-xs text-muted-foreground">{t(`restore.networkNote.${network}`)}</span>
          </div>
          {network === 'proxy' && (
            <div className="max-w-[400px]">
              <UiInput
                label={t('proxy.label')}
                required
                mono
                placeholder={t('proxy.placeholder')}
                modelValue={proxyText}
                onUpdateModelValue={setProxyText}
                error={proxies.length > 0 && proxyBad ? t('proxy.errorFormat') : undefined}
                hint={t('proxy.hint')}
              />
            </div>
          )}
          <div className="max-w-[320px]">
            <UiInput label={t('advanced.subnetLabel')} mono modelValue={subnet} onUpdateModelValue={setSubnet} error={subnetBad ? t('advanced.subnetErrorFormat') : undefined} hint={t('advanced.subnetHint')} />
          </div>
        </div>
      </UiDisclosure>
      {verBad && (
        <UiCallout tone="danger" role="alert" title={t('restore.verBadTitle')}>
          <M k="restore.verBadBody" v={{ backup: review.backup_version ?? '', installer: review.installer_version ?? '' }} />
        </UiCallout>
      )}

      {startErrors.length > 0 && (
        <UiCallout tone="danger" role="alert" title={t('restore.startErrorTitle')}>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {startErrors.map(err => <li key={`${err.field}/${err.code}`}>{reasonText('startError', err.code, err.vars)}</li>)}
          </ul>
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
