/**
 * 마법사 골격 — 왼쪽 단계 목록 + 가운데 본문(최대 720). 좁은 화면에서는 단계 목록이 상단 한 줄 진행 표시로 접힌다.
 * 단계 목록은 저장된 답변으로 결정하되, 화면에서 아직 저장하지 않은 선택(preview)이 전달되면 이를 우선 반영한다
 * (선택 즉시 목록이 변경된다).
 * 높이는 dvh — 모바일 주소창이 접히고 펴져도 하단이 가려지지 않는다.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { UiStepList, type UiStep } from '~/components/ui/StepList'
import { flow, stepStates, type FlowInput, type StepId } from '../flow'
import { useT } from '../i18n'
import { SourceLink } from '../parts/SourceLink'
import { effectiveZones, useWizard } from '../store'
import { ShellTools } from './ShellTools'

export interface WizardShellProps {
  /** 현재 화면의 단계 */
  step: StepId
  /** 아직 저장하지 않은 선택 — 단계 목록에 즉시 반영 */
  preview?: Partial<FlowInput>
  children: ReactNode
}

export function useSteps(step: StepId, preview?: Partial<FlowInput>): UiStep[] {
  const t = useT()
  const answers = useWizard(s => s.answers)
  const catalog = useWizard(s => s.catalog)
  const base: FlowInput = {
    mode: answers.mode,
    network: answers.access.network,
    cert: answers.access.cert,
    zones: effectiveZones(preview?.mode ? { ...answers, mode: preview.mode } : answers, catalog),
  }
  const steps = flow({ ...base, ...preview })
  return stepStates(steps, step).map(s => ({ id: s.id, label: t(`steps.${s.id}`), state: s.state }))
}

export function WizardShell({ step, preview, children }: WizardShellProps) {
  const t = useT()
  const steps = useSteps(step, preview)
  const labels = { done: t('stepState.done'), current: t('stepState.current'), todo: t('stepState.todo'), skipped: t('stepState.skipped') }
  const main = useRef<HTMLElement>(null)

  // 화면 전환 시 본문 최상단으로 이동 — 키보드 사용자가 새 화면의 제목부터 읽도록 포커스도 이동
  useEffect(() => {
    window.scrollTo(0, 0)
    main.current?.focus({ preventScroll: true })
  }, [step])

  return (
    <div className="flex min-h-dvh flex-col bg-background text-sm leading-5 text-foreground">
      <div className="flex flex-col gap-2 border-b border-border px-4 py-3 md:hidden">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13.5px] font-semibold">{t('brand')} <span className="font-normal text-muted-foreground">{t('brandSuffix')}</span></span>
          <ShellTools />
        </div>
        <UiStepList variant="compact" label={t('stepsLabel')} labels={labels} steps={steps} />
      </div>
      <div className="flex min-w-0 flex-1">
        <nav aria-label={t('stepsLabel')} className="hidden w-[260px] shrink-0 flex-col border-r border-border px-4 py-6 md:flex">
          <div className="px-2.5 pb-5 text-base font-semibold">{t('brand')} <span className="font-normal text-muted-foreground">{t('brandSuffix')}</span></div>
          <UiStepList label={t('stepsLabel')} labels={labels} steps={steps} />
          <div className="mt-auto flex flex-col gap-3 px-1 pt-6"><ShellTools /><SourceLink /></div>
        </nav>
        <main ref={main} tabIndex={-1} className="flex min-w-0 flex-1 flex-col items-center px-4 py-6 focus:outline-hidden md:px-6 md:py-10">
          <div className="flex w-full max-w-[720px] installer-in flex-col gap-5">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}

/** 화면 제목과 한 줄 설명 */
export function Heading({ title, lead }: { title: ReactNode; lead?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="m-0 text-2xl font-bold leading-8">{title}</h1>
      {lead != null && <p className="m-0 text-muted-foreground">{lead}</p>}
    </div>
  )
}

/** 본문 안 작은 제목 */
export function SubHeading({ id, children }: { id?: string; children: ReactNode }) {
  return <h2 id={id} className="m-0 text-base font-semibold leading-6">{children}</h2>
}

/** 단계 목록 없이 가운데 카드 하나만 있는 화면(완료 · 잠김 · 토큰 · 이어 하기) */
export function CenterShell({ width = 448, children }: { width?: 448 | 520; children: ReactNode }) {
  const t = useT()
  return (
    <div className="flex min-h-dvh flex-col bg-background text-sm leading-5 text-foreground">
      <header className="flex items-center justify-between gap-3 px-4 py-3 md:px-6">
        <span className="text-[13.5px] font-semibold md:text-base">{t('brand')} <span className="font-normal text-muted-foreground">{t('brandSuffix')}</span></span>
        <ShellTools />
      </header>
      <main className="flex flex-1 flex-col items-center justify-center px-4 pb-10 pt-4">
        <div className={`w-full installer-in rounded-lg border border-border bg-card text-card-foreground ${width === 520 ? 'max-w-[520px]' : 'max-w-[448px]'}`}>
          <div className="flex flex-col gap-5 p-5 sm:p-8">{children}</div>
        </div>
        <SourceLink className="pt-4 text-center" />
      </main>
    </div>
  )
}
