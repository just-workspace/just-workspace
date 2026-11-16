/**
 * 적용 — 요약에서 "설치"를 누른 이후의 진행 화면. 복원 흐름에서는 동일 화면이 복원 진행을 표시한다.
 * 시작하지 않은 상태로 이 주소에 진입한 경우(상태가 idle) 요약으로 이동시킨다.
 */
import { useEffect } from 'react'
import { ApplyView } from '../parts/ApplyView'
import { navigate } from '../router'
import { WizardShell } from '../shell/WizardShell'
import { useWizard, useWizardStore } from '../store'

export function ApplyScreen() {
  const mode = useWizard(s => s.answers.mode)
  const api = useWizard(s => s.api)
  const store = useWizardStore()
  const restore = mode === 'restore'

  useEffect(() => {
    let alive = true
    const read = restore ? api.restoreGetApply() : api.getApply()
    read.then(s => {
      if (!alive) return
      const now = store.getState()
      // 시작 직후에는 서버가 아직 idle 일 수 있음 — 이 경우 이동시키지 않음
      if (s.status === 'idle' && now.applyStale == null && !now.finishedHere) navigate(restore ? 'review' : 'summary', { replace: true })
      else now.receiveApply(s)
    }).catch(() => { /* 상태 흐름이 이어서 조회 */ })
    return () => { alive = false }
  }, [api, restore, store])

  return (
    <WizardShell step="apply">
      <ApplyView kind={restore ? 'restore' : 'install'} backTo={restore ? 'review' : 'summary'} />
    </WizardShell>
  )
}
