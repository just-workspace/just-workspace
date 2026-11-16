/**
 * 접속 주소와 연결 — 주소 · 연결 형태 · 인증서. 빠른 설치에서는 주소만 묻고 나머지는 감지한 값과 기본값을 보여 준다.
 *
 * 인증서 규칙
 *  - 기존 프록시 뒤: 고를 것이 없다(프록시가 처리).
 *  - 자동 발급은 접속 주소가 이 서버를 가리키는 것이 확인됐을 때만 고를 수 있다. 숫자 주소로도 안 된다.
 *  - 임시 인증서는 평소에는 보이지 않고, 자동 발급을 고를 수 없을 때에만 나타난다.
 */
import { useState } from 'react'
import { UiBadge } from '~/components/ui/Badge'
import { UiCallout } from '~/components/ui/Callout'
import { UiCard } from '~/components/ui/Card'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiIcon } from '~/components/ui/Icon'
import { UiInput } from '~/components/ui/Input'
import { UiRadioCard } from '~/components/ui/RadioCard'
import type { AnswersPatch, CertMode, Network } from '../api/types'
import { isIpv4, recommendMb, serverGb, trim1, zoneGb } from '../format'
import { M, useLocalized, useT } from '../i18n'
import { DnsStatus, useDnsCheck, type DnsView } from '../parts/DnsStatus'
import { StepNav, useGoNext } from '../shell/StepNav'
import { Heading, SubHeading, WizardShell } from '../shell/WizardShell'
import { QUICK_PRESET, quickLowered, serverMemoryMb, useWizard } from '../store'

/** 화면에서 고른 인증서 방식 → 지금 조건에서 실제로 쓸 방식 */
export function resolveCert(network: Network, picked: CertMode, autoBlocked: boolean): CertMode {
  if (network === 'proxy') return 'proxy'
  const own = picked === 'proxy' ? 'auto' : picked
  if (autoBlocked) return own === 'auto' ? 'temporary' : own
  return own === 'temporary' ? 'auto' : own
}

function addressReason(view: DnsView, t: (k: string) => string): string {
  if (view === 'idle') return t('domain.reasonEmpty')
  if (view === 'invalid') return t('domain.reasonInvalid')
  if (view === 'checking') return t('domain.reasonChecking')
  return ''
}

export function DomainScreen() {
  const mode = useWizard(s => s.answers.mode)
  return mode === 'quick' ? <QuickDomain /> : <FullDomain />
}

function FullDomain() {
  const t = useT()
  const access = useWizard(s => s.answers.access)
  const detected = useWizard(s => s.server?.facts.detected_network ?? null)
  const cloud = useWizard(s => s.server?.facts.cloud === true)
  const [domain, setDomain] = useState(access.domain)
  // 처음 들어온 화면이면 감지한 연결 형태를 미리 고른다
  const [network, setNetwork] = useState<Network>(access.domain ? access.network : (detected ?? access.network))
  const [picked, setPicked] = useState<CertMode>(access.cert)
  const view = useDnsCheck(domain)
  const checkDns = useWizard(s => s.checkDns)
  const { goNext } = useGoNext('domain')

  const ip = isIpv4(domain.trim())
  const autoBlocked = ip || view === 'mismatch' || view === 'unknown'
  const cert = resolveCert(network, picked, autoBlocked)
  const networkName = (n: Network) => t(`domain.${n}Title`)
  const pickNetwork = (v: string | number | null) => { if (v != null) setNetwork(v as Network) }
  const pickCert = (v: string | number | null) => { if (v != null) setPicked(v as CertMode) }

  return (
    <WizardShell step="domain" preview={{ network, cert }}>
      <Heading title={t('domain.title')} lead={t('domain.lead')} />
      <div className="flex flex-col gap-2">
        <UiInput label={t('domain.addressLabel')} mono icon="globe" inputMode="url" placeholder="workspace.example.com" modelValue={domain} onUpdateModelValue={setDomain} />
        <DnsStatus domain={domain} />
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <SubHeading id="net-h">{t('domain.networkTitle')}</SubHeading>
          {detected && (
            <UiBadge tone="success" tint><UiIcon name="check" aria-hidden="true" />{t('domain.detected', { name: networkName(detected) })}</UiBadge>
          )}
        </div>
        <div role="radiogroup" aria-labelledby="net-h" className="flex flex-col gap-3">
          {(['direct', 'router', 'proxy'] as Network[]).map(n => (
            <UiRadioCard key={n} className="w-full" value={n} title={networkName(n)} description={t(`domain.${n}Desc`)} modelValue={network} onUpdateModelValue={pickNetwork} />
          ))}
        </div>
        {cloud && <UiCallout variant="plain" tone="neutral" icon="info" role="status">{t('domain.cloudNote')}</UiCallout>}
      </div>
      <div className="flex flex-col gap-3">
        <SubHeading id="cert-h">{t('domain.certTitle')}</SubHeading>
        {network !== 'proxy'
          ? (
              <>
                <div role="radiogroup" aria-labelledby="cert-h" className="flex flex-col gap-2">
                  <UiRadioCard className="w-full" layout="row" value="auto" title={t('domain.certAuto')} description={t('domain.certAutoDesc')} modelValue={cert} onUpdateModelValue={pickCert} disabled={autoBlocked} />
                  <UiRadioCard className="w-full" layout="row" value="upload" title={t('domain.certUpload')} description={t('domain.certUploadDesc')} modelValue={cert} onUpdateModelValue={pickCert} />
                  {autoBlocked && (
                    <UiRadioCard className="w-full" layout="row" value="temporary" title={t('domain.certTemp')} description={t('domain.certTempDesc')} modelValue={cert} onUpdateModelValue={pickCert} />
                  )}
                </div>
                {autoBlocked && (
                  <UiCallout variant="plain" tone="neutral" icon="lock" role="status">{ip ? t('domain.certNeedsDomain') : t('domain.certBlocked')}</UiCallout>
                )}
              </>
            )
          : (
              <div className="flex items-center gap-3 rounded-lg border border-border px-3.5 py-2.5">
                <span className="flex text-muted-foreground"><UiIcon name="lock" aria-hidden="true" className="size-[18px]" /></span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-[13px] font-semibold">{t('domain.certProxy')}</span>
                  <span className="text-xs text-muted-foreground">{t('domain.certProxyDesc')}</span>
                </span>
              </div>
            )}
      </div>
      <StepNav
        step="domain"
        blocked={addressReason(view, t)}
        onNext={() => saveAddress(goNext, checkDns, { access: { domain: domain.trim(), network, cert, ...(network === 'proxy' ? {} : { proxy_addresses: [] }) } })}
      />
    </WizardShell>
  )
}

/**
 * 접속 주소를 저장하고 넘어간다. 서버는 "저장된 접속 주소"를 확인한 결과만 기억하므로(임시 인증서를 허락하는 근거),
 * 저장한 뒤에 한 번 더 확인을 돌려 둔다.
 */
async function saveAddress(goNext: (patch: AnswersPatch) => Promise<boolean>, checkDns: (domain: string) => Promise<void>, patch: AnswersPatch) {
  if (await goNext(patch)) void checkDns(String(patch.access?.domain ?? ''))
}

function QuickDomain() {
  const t = useT()
  const localized = useLocalized()
  const access = useWizard(s => s.answers.access)
  const catalog = useWizard(s => s.catalog)
  const detected = useWizard(s => s.server?.facts.detected_network ?? null)
  const memory = useWizard(s => serverMemoryMb(s))
  const [domain, setDomain] = useState(access.domain)
  const [temp, setTemp] = useState(access.cert === 'temporary')
  const view = useDnsCheck(domain)
  const checkDns = useWizard(s => s.checkDns)
  const { goNext } = useGoNext('domain')

  const network: Network = detected ?? 'direct'
  const stuck = network !== 'proxy' && (isIpv4(domain.trim()) || view === 'mismatch' || view === 'unknown')
  const cert: CertMode = network === 'proxy' ? 'proxy' : (stuck && temp ? 'temporary' : 'auto')
  const low = quickLowered(catalog)
  const collab = catalog?.presets[QUICK_PRESET] ?? []
  const names = [catalog?.core, ...(catalog?.zones.filter(z => collab.includes(z.id)) ?? [])].filter(Boolean).map(z => localized(z!.name)).join(', ')
  const blocked = addressReason(view, t) || (stuck && !temp ? t('domain.quickReasonStuck') : '')

  const row = 'grid grid-cols-1 gap-x-4 gap-y-0.5 border-t border-border px-4 py-2.5 first:border-t-0 sm:grid-cols-[140px_1fr]'
  return (
    <WizardShell step="domain" preview={{ network, cert }}>
      <Heading title={t('domain.quickTitle')} lead={t('domain.quickLead')} />
      <div className="flex flex-col gap-2">
        <UiInput label={t('domain.addressLabel')} mono icon="globe" inputMode="url" placeholder="workspace.example.com" modelValue={domain} onUpdateModelValue={setDomain} />
        <DnsStatus domain={domain} />
      </div>
      <div className="flex flex-col gap-3">
        <SubHeading>{t('domain.quickDefaults')}</SubHeading>
        <UiCard className="overflow-hidden">
          <dl className="m-0 text-[13px]">
            <div className={row}>
              <dt className="text-muted-foreground">{t('domain.quickNetwork')}</dt>
              <dd className="m-0 flex flex-wrap items-center gap-2">{t(`domain.${network}Title`)}{detected && <UiBadge tone="success" tint size={18}>{t('domain.detectedBadge')}</UiBadge>}</dd>
            </div>
            <div className={row}>
              <dt className="text-muted-foreground">{t('domain.quickCert')}</dt>
              <dd className="m-0">{cert === 'proxy' ? t('domain.certProxy') : (cert === 'temporary' ? t('domain.quickCertTemp') : t('domain.quickCertAuto'))}</dd>
            </div>
            <div className={row}>
              <dt className="text-muted-foreground">{t('domain.quickStorage')}</dt>
              <dd className="m-0">{t('domain.quickStorageLocal')}</dd>
            </div>
            <div className={row}>
              <dt className="text-muted-foreground">{t('domain.quickZones')}</dt>
              <dd className="m-0">{low ? t('domain.quickZonesMinimal') : t('domain.quickZonesCollab', { names })}</dd>
            </div>
          </dl>
        </UiCard>
      </div>
      {low && catalog && (
        <UiCallout tone="warning" title={<M k="domain.quickLowTitle" v={{ have: memory != null ? trim1(serverGb(memory)) : '', need: trim1(zoneGb(recommendMb(catalog, collab))) }} />}>
          <M k="domain.quickLowBody" v={{ min: trim1(zoneGb(catalog.core.memory_mb.recommend)) }} />
        </UiCallout>
      )}
      {stuck && (
        <UiCallout tone="warning" title={t('domain.quickStuckTitle')}>
          <span>{t('domain.quickStuckBody')}</span>
          <div className="mt-3 text-foreground">
            <UiCheckbox label={t('domain.certTemp')} description={t('domain.quickTempDesc')} modelValue={temp} onUpdateModelValue={setTemp} />
          </div>
        </UiCallout>
      )}
      <StepNav
        step="domain"
        blocked={blocked}
        onNext={() => saveAddress(goNext, checkDns, { access: { domain: domain.trim(), network, cert, ...(network === 'proxy' ? {} : { proxy_addresses: [] }) }, storage: { kind: 'local', path: null, server: null, export: null } })}
      />
    </WizardShell>
  )
}
