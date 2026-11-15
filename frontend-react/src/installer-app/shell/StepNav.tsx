/**
 * 화면 아래 줄 — [이전] · 이유 문구 · [다음].
 * - "이전"은 지금 흐름에서 실제 직전 단계로 간다.
 * - "다음"이 꺼져 있으면 바로 옆에 왜 꺼졌는지 보인다(버튼의 aria-describedby 로도 이어 준다).
 * - 요약 화면의 "고치기"로 들어왔으면 "다음" 대신 "요약으로 돌아가기"가 된다.
 * - "다음"은 답변을 저장한 뒤에 넘어간다. 저장에 실패하면 그 자리에 남고 이유를 보인다.
 */
import { useCallback, type ReactNode } from 'react'
import { UiButton } from '~/components/ui/Button'
import { useUid } from '~/components/ui/internal'
import type { AnswersPatch } from '../api/types'
import { nextStep, prevStep, type RouteId, type StepId } from '../flow'
import { useT } from '../i18n'
import { navigate, useRoute } from '../router'
import { applyPatch, flowOf, useWizard, useWizardStore } from '../store'

export interface StepNavProps {
  step: StepId
  /** 왜 다음으로 못 가는가. 빈 글자면 갈 수 있다 */
  blocked?: string
  /** 갈 수 있을 때 옆에 보일 안내(주의는 그대로 두고 갈 수 있다 등) */
  note?: string
  /** "다음"을 눌렀을 때 — 저장할 것이 있으면 goNext(patch) 를 부른다 */
  onNext: () => unknown
  /** "이전" 과 "다음" 사이에 둘 버튼(다시 확인 등) */
  extra?: ReactNode
  /** "이전"을 숨긴다(첫 화면) */
  noPrev?: boolean
}

/** 저장하고 다음 화면으로 — 다음 단계는 저장된 뒤의 답변으로 정한다(고른 것에 따라 끼어드는 단계가 달라진다) */
export function useGoNext(step: StepId): { fix: boolean; goNext: (patch?: AnswersPatch) => Promise<boolean>; goTo: (id: RouteId) => void } {
  const store = useWizardStore()
  const { fix } = useRoute()
  const goNext = useCallback(async (patch?: AnswersPatch) => {
    const now = store.getState()
    const after = patch ? applyPatch(now.answers, patch) : now.answers
    const target: RouteId = fix ? 'summary' : (nextStep(flowOf(after, now.catalog), step) ?? 'summary')
    if (patch && !(await now.save(patch, target))) return false
    navigate(target)
    return true
  }, [store, fix, step])
  return { fix, goNext, goTo: navigate }
}

export function StepNav({ step, blocked = '', note = '', onNext, extra, noPrev = false }: StepNavProps) {
  const t = useT()
  const { fix } = useRoute()
  const answers = useWizard(s => s.answers)
  const catalog = useWizard(s => s.catalog)
  const saving = useWizard(s => s.saving)
  const saveFailed = useWizard(s => s.saveFailed)
  const reasonId = useUid('nav-reason')
  const prev = prevStep(flowOf(answers, catalog), step)
  const reason = blocked || (saving ? t('nav.saving') : (saveFailed ? t('nav.saveFailed') : note))

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      {!noPrev && !fix && prev && (
        <UiButton type="button" variant="secondary" onClick={() => navigate(prev)}>{t('nav.prev')}</UiButton>
      )}
      <span id={reasonId} role="status" className={`min-w-0 flex-1 text-right text-[13px] text-muted-foreground ${reason ? 'basis-[200px]' : 'basis-0'}`}>{reason}</span>
      {extra}
      <UiButton type="button" disabled={!!blocked || saving} aria-describedby={reason ? reasonId : undefined} onClick={() => { void onNext() }}>
        {fix ? t('nav.backToSummary') : t('nav.next')}
      </UiButton>
    </div>
  )
}
