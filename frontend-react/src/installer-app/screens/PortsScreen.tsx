/**
 * 포트 포워딩 안내 — 공유기 뒤를 골랐을 때만 나온다. 고른 구역에 필요한 포트를 표로 보여 준다.
 * 마법사는 포트가 열렸는지 확인하지 않는다 — 직접 확인하는 방법만 안내한다.
 */
import { UiCallout } from '~/components/ui/Callout'
import { openPorts } from '../format'
import { josa, M, useLocalized, useT } from '../i18n'
import { PortTable } from '../parts/PortTable'
import { StepNav, useGoNext } from '../shell/StepNav'
import { Heading, WizardShell } from '../shell/WizardShell'
import { effectiveZones, lanIp, useWizard } from '../store'

export function PortsScreen() {
  const t = useT()
  const localized = useLocalized()
  const answers = useWizard(s => s.answers)
  const catalog = useWizard(s => s.catalog)
  const serverIp = useWizard(s => lanIp(s))
  const { goNext } = useGoNext('ports')

  const selected = [...effectiveZones(answers, catalog), ...answers.addons]
  const rows = catalog ? openPorts(catalog, selected, { turn: answers.meetings.turn, lossless: answers.meetings.lossless_audio }) : []
  const zoneName = (id: string) => {
    if (!catalog) return id
    if (id === catalog.core.id) return localized(catalog.core.name)
    return localized([...catalog.zones, ...catalog.addons].find(z => z.id === id)?.name) || id
  }

  return (
    <WizardShell step="ports">
      <Heading
        title={t('ports.title')}
        lead={serverIp ? <M k="ports.lead" v={{ ip: serverIp, p: josa(serverIp, '으로/로') }} /> : t('ports.leadNoIp')}
      />
      <PortTable title={t('ports.cardTitle')} rows={rows} zoneName={zoneName} />
      <UiCallout tone="info" title={t('ports.howTitle')}>{t('ports.howBody')}</UiCallout>
      <StepNav step="ports" onNext={() => goNext()} />
    </WizardShell>
  )
}
