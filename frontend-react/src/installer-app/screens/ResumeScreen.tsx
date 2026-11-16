/**
 * 이어 하기 — 창을 닫은 뒤 동일 주소로 재진입한 경우. 세 가지 형태:
 *  - 입력 중: 입력 진행 위치와 다음 화면. [이어서 하기] · [처음부터 다시]
 *  - 적용 중: 창을 닫은 동안에도 설치가 계속 진행됨. [진행 상황 보기]
 *  - 적용 실패: 중단된 단계. [중단된 단계 보기]
 */
import { UiButton } from '~/components/ui/Button'
import { UiCallout } from '~/components/ui/Callout'
import { UiProgress } from '~/components/ui/Progress'
import { nearestLive, prevStep, progressOf } from '../flow'
import { useHas, useT } from '../i18n'
import { applyCounts } from '../parts/ApplyView'
import { navigate } from '../router'
import { CenterShell } from '../shell/WizardShell'
import { flowOf, resumeStep, useWizard } from '../store'

export function ResumeScreen({ onRestart }: { onRestart: () => void }) {
  const t = useT()
  const has = useHas()
  const server = useWizard(s => s.server)
  const answers = useWizard(s => s.answers)
  const catalog = useWizard(s => s.catalog)
  const apply = useWizard(s => s.apply)
  const secretsMissing = useWizard(s => !s.secretsOnServer['admin.password'])

  const applying = server?.phase === 'applying'
  const failed = applying && apply?.status === 'failed'
  const steps = flowOf(answers, catalog)
  const next = nearestLive(steps, resumeStep(answers, catalog, server?.step) ?? 'check')
  const before = prevStep(steps, next)
  const { done, total } = applyCounts(apply)
  const stepName = (id: string | null | undefined) => {
    if (!id) return ''
    if (answers.mode === 'restore' && has(`apply.restoreSteps.${id}`)) return t(`apply.restoreSteps.${id}`)
    return has(`apply.steps.${id}`) ? t(`apply.steps.${id}`) : id
  }
  const failedStep = apply?.steps.find(s => s.status === 'failed')?.id ?? apply?.error?.step
  const percent = applying ? (total ? Math.round((done / total) * 100) : 0) : progressOf(steps, next)

  const title = applying ? t(failed ? 'resume.titleFailed' : 'resume.titleApplying') : t('resume.titleTyping')
  const lead = applying ? t(failed ? 'resume.leadFailed' : 'resume.leadApplying') : t('resume.leadTyping')
  const left = applying
    ? t('resume.progressApply', { total, done })
    : (before ? t('resume.progressTyping', { step: t(`steps.${before}`) }) : '')
  const right = applying
    ? (failed ? t('resume.stoppedAt', { step: stepName(failedStep) }) : (apply?.current ? t('resume.nowApply', { step: stepName(apply.current) }) : ''))
    : t('resume.nextTyping', { step: t(`steps.${next}`) })

  return (
    <CenterShell>
      <div className="flex flex-col gap-2">
        <h1 className="m-0 text-xl font-bold leading-7">{title}</h1>
        <p className="m-0 text-muted-foreground">{lead}</p>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[13px]">
          <span>{left}</span>
          <span className="text-muted-foreground">{right}</span>
        </div>
        <UiProgress label={t('resume.progressLabel')} value={percent} tone={failed ? 'danger' : 'primary'} />
      </div>
      {!applying && (
        <>
          {secretsMissing && <p className="m-0 text-[13px] text-muted-foreground">{t('resume.secretsNote')}</p>}
          <div className="flex flex-col gap-2">
            <UiButton type="button" size="lg" className="w-full" onClick={() => navigate(next)}>{t('resume.continue')}</UiButton>
            <UiButton type="button" variant="ghost" className="w-full" onClick={onRestart}>{t('resume.restart')}</UiButton>
          </div>
        </>
      )}
      {applying && !failed && (
        <UiButton type="button" size="lg" className="w-full" onClick={() => navigate('apply')}>{t('resume.watch')}</UiButton>
      )}
      {failed && (
        <>
          <UiCallout tone="danger" title={t('resume.failedTitle', { step: stepName(failedStep) })}>{t('resume.failedBody')}</UiCallout>
          <UiButton type="button" size="lg" className="w-full" onClick={() => navigate('apply')}>{t('resume.seeFailed')}</UiButton>
        </>
      )}
    </CenterShell>
  )
}
