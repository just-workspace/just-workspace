/**
 * 고급 설정 — 요약 화면에서만 들어온다. 지금은 내부 네트워크 대역 하나.
 * 대역을 바꾸면 저장한 뒤 사전 점검을 다시 돌려 서버의 다른 네트워크와 겹치는지 본다. 겹치면 돌아갈 수 없다.
 */
import { useState } from 'react'
import { UiButton } from '~/components/ui/Button'
import { UiDisclosure } from '~/components/ui/Disclosure'
import { UiInput } from '~/components/ui/Input'
import { isSubnet24 } from '../format'
import { useT } from '../i18n'
import { navigate } from '../router'
import { Heading, WizardShell } from '../shell/WizardShell'
import { useWizard, useWizardStore } from '../store'

export function AdvancedScreen() {
  const t = useT()
  const store = useWizardStore()
  const saved = useWizard(s => s.answers.advanced.subnet)
  const subnetCheck = useWizard(s => s.preflight?.items.find(i => i.id === 'subnet') ?? null)
  const saving = useWizard(s => s.saving)
  const preflightBusy = useWizard(s => s.preflightBusy)
  const saveFailed = useWizard(s => s.saveFailed)
  const [subnet, setSubnet] = useState(saved)

  const value = subnet.trim()
  const formatBad = !isSubnet24(value)
  // 점검 결과는 저장된 대역에 대한 것 — 입력을 바꾸는 중에는 쓰지 않는다
  const clash = value === saved && subnetCheck?.status === 'fail'
  const known = value === saved && subnetCheck != null && subnetCheck.status !== 'checking'
  const error = formatBad ? t('advanced.subnetErrorFormat') : (clash ? t('advanced.subnetErrorClash') : undefined)
  const busy = saving || preflightBusy
  const blocked = formatBad || clash ? t('advanced.reason') : ''
  const reason = blocked || (busy ? t('nav.saving') : (saveFailed ? t('nav.saveFailed') : ''))

  async function back() {
    if (value !== saved) {
      if (!(await store.getState().save({ advanced: { subnet: value } }, 'summary'))) return
      await store.getState().runPreflight()
      if (store.getState().preflight?.items.find(i => i.id === 'subnet')?.status === 'fail') return
    }
    navigate('summary')
  }

  return (
    <WizardShell step="summary">
      <Heading title={t('advanced.title')} lead={t('advanced.lead')} />
      <UiDisclosure
        title={t('advanced.subnetTitle')}
        defaultOpen
        description={<span className="font-mono">{t(known ? (clash ? 'advanced.subnetClash' : 'advanced.subnetOk') : 'advanced.subnetPlain', { subnet: value || saved })}</span>}
      >
        <div className="px-4 pb-4 pt-1">
          <div className="max-w-[320px]">
            <UiInput label={t('advanced.subnetLabel')} mono modelValue={subnet} onUpdateModelValue={setSubnet} error={error} hint={t('advanced.subnetHint')} />
          </div>
        </div>
      </UiDisclosure>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span id="adv-reason" role="status" className={`min-w-0 flex-1 text-right text-[13px] text-muted-foreground ${reason ? 'basis-[200px]' : 'basis-0'}`}>{reason}</span>
        <UiButton type="button" disabled={!!blocked || busy} aria-describedby={reason ? 'adv-reason' : undefined} onClick={() => { void back() }}>{t('nav.backToSummary')}</UiButton>
      </div>
    </WizardShell>
  )
}
