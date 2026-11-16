/**
 * AI 도우미 — 지금 연결(제공자 · 키 · 연결 확인) 또는 나중에.
 * 지금 연결을 선택한 경우 연결 확인을 통과해야 다음으로 진행한다. 키는 화면 상태에만 보관하고, 확인 시와 다음 단계 이동 시에만 서버로 송신한다.
 */
import { useState } from 'react'
import { UiButton } from '~/components/ui/Button'
import { UiCallout } from '~/components/ui/Callout'
import { UiCard } from '~/components/ui/Card'
import { UiInput } from '~/components/ui/Input'
import { UiPasswordInput } from '~/components/ui/PasswordInput'
import { UiRadioCard } from '~/components/ui/RadioCard'
import { UiSegment } from '~/components/ui/Segment'
import type { AiProbeRequest } from '../api/types'
import { useHas, useT } from '../i18n'
import { StepNav, useGoNext } from '../shell/StepNav'
import { Heading, SubHeading, WizardShell } from '../shell/WizardShell'
import { aiKeyOf, useWizard } from '../store'

/** 선택 가능한 제공자(표시 순서) */
export const AI_PROVIDERS = ['anthropic', 'openai', 'gemini', 'ollama', 'compatible']
/** 키 없이 사용 가능한 제공자(직접 운영하는 서버) */
const KEYLESS = ['ollama', 'compatible']
/** 서버 주소를 입력받는 제공자 · 서버 주소가 필수인 제공자 */
const TAKES_BASE_URL = ['ollama', 'compatible']
const NEEDS_BASE_URL = ['compatible']

export function AiScreen() {
  const t = useT()
  const has = useHas()
  const saved = useWizard(s => s.answers.ai)
  const probe = useWizard(s => s.ai)
  const checkAi = useWizard(s => s.checkAi)
  const key = useWizard(s => s.aiKey)
  const setSecret = useWizard(s => s.setSecret)
  const [when, setWhen] = useState<'now' | 'later'>(saved.mode === 'provider' ? 'now' : 'later')
  const [provider, setProvider] = useState(saved.provider && AI_PROVIDERS.includes(saved.provider) ? saved.provider : AI_PROVIDERS[0])
  const [baseUrl, setBaseUrl] = useState(saved.base_url ?? '')
  const { goNext } = useGoNext('ai')

  const takesUrl = TAKES_BASE_URL.includes(provider)
  const req: AiProbeRequest = { provider, api_key: key, base_url: takesUrl && baseUrl.trim() ? baseUrl.trim() : null }
  const current = probe.key === aiKeyOf(req)
  const ok = current && probe.status === 'done' && probe.result?.status === 'ok'
  const bad = current && (probe.status === 'error' || (probe.status === 'done' && probe.result?.status !== 'ok'))
  const checking = current && probe.status === 'checking'
  const cause = probe.status === 'error' ? 'error' : (probe.result?.status ?? 'error')
  const canTest = (key !== '' || KEYLESS.includes(provider)) && (!NEEDS_BASE_URL.includes(provider) || /^https?:\/\/\S+$/.test(baseUrl.trim()))
  const blocked = when === 'now' && !ok ? t('ai.reason') : ''
  const pickWhen = (v: string | number | null) => { if (v != null) setWhen(v as 'now' | 'later') }

  return (
    <WizardShell step="ai">
      <Heading title={t('ai.title')} lead={t('ai.lead')} />
      <div role="radiogroup" aria-label={t('ai.groupLabel')} className="flex flex-col gap-2">
        <UiRadioCard className="w-full" layout="row" value="now" title={t('ai.nowTitle')} description={t('ai.nowDesc')} modelValue={when} onUpdateModelValue={pickWhen} />
        <UiRadioCard className="w-full" layout="row" value="later" title={t('ai.laterTitle')} description={t('ai.laterDesc')} modelValue={when} onUpdateModelValue={pickWhen} />
      </div>
      {when === 'now' && (
        <UiCard className="p-4">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <SubHeading>{t('ai.providerTitle')}</SubHeading>
              <div className="max-w-full overflow-x-auto">
                <UiSegment
                  ariaLabel={t('ai.providerTitle')}
                  items={AI_PROVIDERS.map(p => ({ value: p, label: has(`ai.providers.${p}`) ? t(`ai.providers.${p}`) : p }))}
                  modelValue={provider}
                  onUpdateModelValue={v => { if (v != null) setProvider(String(v)) }}
                />
              </div>
            </div>
            {takesUrl && (
              <div className="max-w-[440px]">
                <UiInput label={t('ai.baseUrlLabel')} required={NEEDS_BASE_URL.includes(provider)} mono inputMode="url" placeholder={t('ai.baseUrlPlaceholder')} modelValue={baseUrl} onUpdateModelValue={setBaseUrl} hint={t('ai.baseUrlHint')} />
              </div>
            )}
            <div className="max-w-[440px]">
              <UiPasswordInput
                label={t('ai.keyLabel')}
                autocomplete="off"
                placeholder={t('ai.keyPlaceholder')}
                modelValue={key}
                onUpdateModelValue={v => setSecret('aiKey', v)}
                error={bad && cause === 'auth_failed' ? t('ai.keyError') : undefined}
                hint={KEYLESS.includes(provider) ? `${t('ai.keyOptional')} ${t('ai.keyHint')}` : t('ai.keyHint')}
              />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <UiButton type="button" variant="outline" size="sm" icon="refresh" disabled={!canTest || checking} onClick={() => { void checkAi(req) }}>{t('common.testConnection')}</UiButton>
              {checking && <UiCallout variant="plain" tone="neutral" icon="loader" spin role="status" className="flex-1">{t('status.checking')}</UiCallout>}
              {ok && <UiCallout variant="plain" tone="success" role="status" title={t('ai.ok')} className="flex-1">{t('ai.okBody')}</UiCallout>}
              {bad && cause !== 'auth_failed' && (
                <UiCallout variant="plain" tone="danger" role="alert" className="flex-1">{cause === 'unreachable' ? t('ai.unreachable') : t('ai.error')}</UiCallout>
              )}
            </div>
          </div>
        </UiCard>
      )}
      <StepNav
        step="ai"
        blocked={blocked}
        onNext={() => goNext({
          ai: when === 'later'
            ? { mode: 'later' }
            : { mode: 'provider', provider, base_url: req.base_url ?? null, ...(key ? { api_key: key } : {}) },
        })}
      />
    </WizardShell>
  )
}
