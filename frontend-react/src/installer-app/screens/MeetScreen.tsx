/**
 * 회의 — 참가자가 영상을 송신할 공인 주소, 중계 서버 사용 여부, 무손실 오디오 활성화 여부. 선택에 따라 개방 포트 표가 달라진다.
 * 공인 주소는 감지한 값을 사용하며, 감지하지 못한 경우에만 직접 입력받는다.
 */
import { useState } from 'react'
import { UiCallout } from '~/components/ui/Callout'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiInput } from '~/components/ui/Input'
import { UiRadioCard } from '~/components/ui/RadioCard'
import { isIpv4, parsePort, type PortRow } from '../format'
import { josa, M, useLocalized, useT } from '../i18n'
import { PortTable } from '../parts/PortTable'
import { StepNav, useGoNext } from '../shell/StepNav'
import { Heading, SubHeading, WizardShell } from '../shell/WizardShell'
import { effectiveZones, useWizard } from '../store'

export function MeetScreen() {
  const t = useT()
  const localized = useLocalized()
  const answers = useWizard(s => s.answers)
  const catalog = useWizard(s => s.catalog)
  const detected = useWizard(s => s.server?.facts.public_ip ?? s.dns.result?.public_ip ?? null)
  const [address, setAddress] = useState(answers.meetings.public_ip ?? '')
  const domainIsIp = isIpv4(answers.access.domain)
  const [turn, setTurn] = useState(answers.meetings.turn && !domainIsIp)
  const hasChat = effectiveZones(answers, catalog).includes('chat')
  const [lossless, setLossless] = useState(answers.meetings.lossless_audio && hasChat)
  const { goNext } = useGoNext('meet')

  const zone = catalog?.zones.find(z => z.id === 'meetings')
  const rows: PortRow[] = (zone?.ports ?? [])
    .filter(spec => (spec !== '3478/udp' || turn) && (spec !== '4433/udp' || lossless))
    .map(spec => ({ spec, ...parsePort(spec), zone: 'meetings' }))
  const addr = address.trim()
  const addrBad = addr !== '' && !isIpv4(addr)
  const blocked = detected ? '' : (addr === '' || addrBad ? t('meet.reasonAddress') : '')

  return (
    <WizardShell step="meet">
      <Heading title={t('meet.title')} lead={t('meet.lead')} />
      <div className="flex flex-col gap-3">
        <SubHeading>{t('meet.addressTitle')}</SubHeading>
        {detected
          ? <UiCallout variant="plain" tone="success" role="status" title={t('meet.addressOk')}><M k="meet.addressOkBody" v={{ ip: detected, p: josa(detected, '으로/로') }} /></UiCallout>
          : (
              <>
                <UiCallout variant="plain" tone="danger" role="status" title={t('meet.addressBad')}>{t('meet.addressBadBody')}</UiCallout>
                <div className="max-w-[320px]">
                  <UiInput label={t('meet.addressLabel')} required mono inputMode="decimal" placeholder="203.0.113.24" modelValue={address} onUpdateModelValue={setAddress} error={addrBad ? t('meet.addressError') : undefined} />
                </div>
              </>
            )}
      </div>
      <div className="flex flex-col gap-3">
        <SubHeading id="relay-h">{t('meet.relayTitle')}</SubHeading>
        <div role="radiogroup" aria-labelledby="relay-h" className="flex flex-col gap-2">
          <UiRadioCard className="w-full" layout="row" value="on" title={t('meet.relayOn')} description={t('meet.relayOnDesc')} modelValue={turn ? 'on' : 'off'} onUpdateModelValue={() => setTurn(true)} disabled={domainIsIp} />
          <UiRadioCard className="w-full" layout="row" value="off" title={t('meet.relayOff')} description={t('meet.relayOffDesc')} modelValue={turn ? 'on' : 'off'} onUpdateModelValue={() => setTurn(false)} />
        </div>
        {domainIsIp && <UiCallout variant="plain" tone="neutral" icon="lock">{t('meet.relayNeedsDomain')}</UiCallout>}
        <UiCheckbox label={t('meet.lossless')} description={t('meet.losslessDesc')} modelValue={lossless} onUpdateModelValue={setLossless} disabled={!hasChat} />
        {!hasChat && <UiCallout variant="plain" tone="neutral" icon="lock">{t('meet.losslessNeedsChat')}</UiCallout>}
      </div>
      <PortTable title={t('meet.portsTitle')} rows={rows} showZone={false} zoneName={() => localized(zone?.name)} />
      <p className="m-0 text-[13px] text-muted-foreground">{t('meet.how')}</p>
      <StepNav
        step="meet"
        blocked={blocked}
        onNext={() => goNext({ meetings: { public_ip: detected ? null : addr, turn, lossless_audio: lossless } })}
      />
    </WizardShell>
  )
}
