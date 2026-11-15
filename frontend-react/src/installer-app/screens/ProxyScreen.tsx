/**
 * 프록시 주소 — 기존 프록시 뒤를 골랐을 때만 나온다. 프록시의 주소(또는 대역)를 받아 그 주소에서 온 접속만 프록시를 거친 것으로 본다.
 * 아래에 프록시 쪽 설정 예시와, 프록시를 거치지 않는 포트 안내를 둔다.
 */
import { useState } from 'react'
import { UiCallout } from '~/components/ui/Callout'
import { UiCard } from '~/components/ui/Card'
import { UiInput } from '~/components/ui/Input'
import { isAddressOrCidr } from '../format'
import { M, useT } from '../i18n'
import { CopyButton } from '../parts/CopyButton'
import { StepNav, useGoNext } from '../shell/StepNav'
import { Heading, SubHeading, WizardShell } from '../shell/WizardShell'
import { lanIp, useWizard } from '../store'

export function proxyExample(serverAddress: string): string {
  return [
    'location / {',
    `  proxy_pass http://${serverAddress}:80;`,
    '  proxy_set_header Host $host;',
    '  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '  proxy_set_header X-Forwarded-Proto $scheme;',
    '  proxy_http_version 1.1;',
    '  proxy_set_header Upgrade $http_upgrade;',
    '  proxy_set_header Connection "upgrade";',
    '}',
  ].join('\n')
}

export function splitAddresses(text: string): string[] {
  return text.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
}

export function ProxyScreen() {
  const t = useT()
  const saved = useWizard(s => s.answers.access.proxy_addresses)
  const serverIp = useWizard(s => lanIp(s))
  const [text, setText] = useState(saved.join(', '))
  const { goNext } = useGoNext('proxy')

  const list = splitAddresses(text)
  const badFormat = list.length > 0 && !list.every(isAddressOrCidr)
  const blocked = list.length === 0 ? t('proxy.reasonEmpty') : (badFormat ? t('proxy.reasonFormat') : '')
  // 이 서버의 내부 주소를 알면 예시에 그대로 넣고, 모르면 예시 주소를 쓴다
  const example = proxyExample(serverIp ?? '192.168.10.10')

  return (
    <WizardShell step="proxy">
      <Heading title={t('proxy.title')} lead={t('proxy.lead')} />
      <div className="max-w-[400px]">
        <UiInput
          label={t('proxy.label')}
          required
          mono
          placeholder={t('proxy.placeholder')}
          modelValue={text}
          onUpdateModelValue={setText}
          error={badFormat ? t('proxy.errorFormat') : undefined}
          hint={t('proxy.hint')}
        />
      </div>
      <UiCard className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
          <SubHeading>{t('proxy.exampleTitle')} <span className="text-muted-foreground">· {t('proxy.exampleKind')}</span></SubHeading>
          <CopyButton text={example} label={t('proxy.copyExample')} />
        </div>
        <pre tabIndex={0} className="m-0 overflow-x-auto border-t border-border px-4 py-3 font-mono text-xs leading-[18px] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">{example}</pre>
      </UiCard>
      <UiCallout tone="info" title={<span className="font-normal"><M k="proxy.infoTitle" /></span>}>{t('proxy.infoBody')}</UiCallout>
      <StepNav step="proxy" blocked={blocked} onNext={() => goNext({ access: { proxy_addresses: list, cert: 'proxy' } })} />
    </WizardShell>
  )
}
