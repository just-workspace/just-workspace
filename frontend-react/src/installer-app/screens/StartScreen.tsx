/**
 * 시작 방식 — 새로 설치 · 빠른 설치 · 백업에서 복원. 고르는 즉시 단계 목록이 바뀐다.
 * 아래에 답변 파일로 설치하는 방법을 접어 둔다(예시와 명령은 서버가 알려 준 것만 보인다).
 */
import { useState } from 'react'
import { UiButton } from '~/components/ui/Button'
import { UiDisclosure } from '~/components/ui/Disclosure'
import { UiRadioCard } from '~/components/ui/RadioCard'
import type { Mode } from '../api/types'
import { M, useT } from '../i18n'
import { StepNav, useGoNext } from '../shell/StepNav'
import { Heading, WizardShell } from '../shell/WizardShell'
import { useWizard } from '../store'

export function StartScreen() {
  const t = useT()
  const saved = useWizard(s => s.answers.mode)
  const info = useWizard(s => s.server?.info)
  const [pick, setPick] = useState<Mode>(saved)
  const { goNext } = useGoNext('start')
  const choose = (v: string | number | null) => { if (v != null) setPick(v as Mode) }
  const example = info?.answers_example
  const command = info?.commands?.install_from_answers

  return (
    <WizardShell step="start" preview={{ mode: pick }}>
      <Heading title={t('start.title')} lead={t('start.lead')} />
      <div role="radiogroup" aria-label={t('start.groupLabel')} className="flex flex-col gap-3">
        <UiRadioCard className="w-full" value="new" title={t('start.newTitle')} description={t('start.newDesc')} modelValue={pick} onUpdateModelValue={choose} />
        <UiRadioCard className="w-full" value="quick" title={t('start.quickTitle')} description={t('start.quickDesc')} modelValue={pick} onUpdateModelValue={choose} />
        <UiRadioCard className="w-full" value="restore" title={t('start.restoreTitle')} description={t('start.restoreDesc')} modelValue={pick} onUpdateModelValue={choose} />
      </div>
      <StepNav
        step="start"
        // 빠른 설치는 구역을 묻지 않는다 — 전에 직접 고른 구역이 남아 있으면 지운다
        onNext={() => goNext(pick === 'quick' ? { mode: pick, zones: null, preset: null, addons: [] } : { mode: pick })}
      />
      <UiDisclosure title={t('start.answersTitle')} description={t('start.answersDesc')}>
        <div className="flex flex-col gap-4 px-4 pb-4 pt-1">
          {example && (
            <pre tabIndex={0} className="m-0 overflow-x-auto rounded-lg border border-border bg-background p-3 font-mono text-xs leading-[18px] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring">{example}</pre>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {example && (
              <UiButton as="a" variant="outline" size="sm" icon="download" download="answers.example.json" href={`data:application/json;charset=utf-8,${encodeURIComponent(example)}`}>
                {t('start.answersDownload')}
              </UiButton>
            )}
            <span className="min-w-0 flex-1 basis-[200px] text-xs leading-4 text-muted-foreground">
              {command ? <M k="start.answersHow" v={{ command }} /> : t('start.answersHowNoCommand')}
            </span>
          </div>
        </div>
      </UiDisclosure>
    </WizardShell>
  )
}
