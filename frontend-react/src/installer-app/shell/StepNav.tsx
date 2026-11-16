/**
 * 화면 하단 줄 — [이전] · 사유 문구 · [다음].
 * - "이전"은 현재 흐름의 실제 직전 단계로 이동한다.
 * - "다음"이 비활성화된 경우 바로 옆에 비활성화 사유를 표시한다(버튼의 aria-describedby 로도 연결한다).
 * - 요약 화면의 "수정"로 진입한 경우 "다음" 대신 "요약으로 돌아가기"가 된다.
 * - "다음"은 답변 저장 후 이동한다. 저장에 실패하면 현재 화면에 머무르며 사유를 표시한다.
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
  /** 다음으로 진행할 수 없는 사유. 빈 문자열이면 진행 가능 */
  blocked?: string
  /** 진행 가능할 때 옆에 표시할 안내(주의는 그대로 두고 진행 가능 등) */
  note?: string
  /** "다음" 클릭 시 호출 — 저장할 내용이 있으면 goNext(patch) 호출 */
  onNext: () => unknown
  /** "이전" 과 "다음" 사이에 배치할 버튼(다시 확인 등) */
  extra?: ReactNode
  /** "이전" 숨김(첫 화면) */
  noPrev?: boolean
}

/** 저장 후 다음 화면으로 이동 — 다음 단계는 저장된 이후의 답변으로 결정한다(선택에 따라 삽입되는 단계가 달라진다) */
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
