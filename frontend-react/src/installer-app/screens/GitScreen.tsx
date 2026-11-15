/**
 * 코드 저장소 — 받을 버전만 정한다(검증된 버전 · 최신 · 직접 지정). 받기 · 설정 · 연결은 적용할 때 자동으로 한다.
 * 검증된 버전이 아니면 "연동을 확인하지 않은 버전"임을 알린다.
 */
import { useState } from 'react'
import { UiBadge } from '~/components/ui/Badge'
import { UiCallout } from '~/components/ui/Callout'
import { UiInput } from '~/components/ui/Input'
import { UiRadioCard } from '~/components/ui/RadioCard'
import { isImageTag, portsLine } from '../format'
import { M, useT } from '../i18n'
import { StepNav, useGoNext } from '../shell/StepNav'
import { Heading, SubHeading, WizardShell } from '../shell/WizardShell'
import { useWizard } from '../store'

type Pick = 'verified' | 'latest' | 'custom'

export function GitScreen() {
  const t = useT()
  const saved = useWizard(s => s.answers.git.version)
  const verified = useWizard(s => s.server?.info.git_verified_version ?? null)
  const ports = useWizard(s => s.catalog?.zones.find(z => z.id === 'git')?.ports)
  const [pick, setPick] = useState<Pick>(saved === 'verified' || saved === 'latest' ? saved : 'custom')
  const [version, setVersion] = useState(saved === 'verified' || saved === 'latest' ? '' : saved)
  const { goNext } = useGoNext('git')

  const v = version.trim()
  const badVersion = v !== '' && !isImageTag(v)
  const blocked = pick === 'custom' && (v === '' || badVersion) ? t('git.reasonVersion') : ''
  const choose = (x: string | number | null) => { if (x != null) setPick(x as Pick) }
  const order = [t('git.order1'), t('git.order2'), t('git.order3')]

  return (
    <WizardShell step="git">
      <Heading title={t('git.title')} lead={t('git.lead')} />
      <div role="radiogroup" aria-label={t('git.groupLabel')} className="flex flex-col gap-3">
        <UiRadioCard className="w-full" value="verified" title={t('git.verified')} description={verified ? t('git.verifiedDescVersion', { version: verified }) : t('git.verifiedDesc')} modelValue={pick} onUpdateModelValue={choose} />
        <UiRadioCard className="w-full" value="latest" title={t('git.latest')} description={t('git.latestDesc')} modelValue={pick} onUpdateModelValue={choose} />
        <UiRadioCard className="w-full" value="custom" title={t('git.custom')} description={t('git.customDesc')} modelValue={pick} onUpdateModelValue={choose} />
      </div>
      {pick === 'custom' && (
        <div className="max-w-[320px]">
          <UiInput label={t('git.versionLabel')} required mono placeholder={verified ?? t('git.versionPlaceholder')} modelValue={version} onUpdateModelValue={setVersion} error={badVersion ? t('git.versionError') : undefined} />
        </div>
      )}
      {pick !== 'verified' && (
        <UiCallout tone="warning" title={<UiBadge tone="warning" tint>{t('git.untested')}</UiBadge>}>{t('git.untestedBody')}</UiCallout>
      )}
      <div className="flex flex-col gap-3">
        <SubHeading>{t('git.orderTitle')}</SubHeading>
        <ol className="m-0 flex list-none flex-col gap-2 p-0 text-[13px]">
          {order.map((label, i) => (
            <li key={label} className="flex items-center gap-2.5">
              <span aria-hidden="true" className="flex size-[22px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-muted-foreground/50 font-mono text-[11px] text-muted-foreground">{i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        <p className="m-0 text-[13px] text-muted-foreground">
          {ports?.length ? <M k="git.orderNote" v={{ ports: portsLine(ports) }} /> : t('git.orderNoteNoPort')}
        </p>
      </div>
      <StepNav step="git" blocked={blocked} onNext={() => goNext({ git: { version: pick === 'custom' ? v : pick } })} />
    </WizardShell>
  )
}
