/**
 * 설치 마법사 — 표시할 화면을 결정한다.
 *
 * 진입 시
 *  1. 서버 상태를 조회한다. 주소에 토큰이 포함된 경우 해당 토큰으로 세션을 생성한다(토큰은 주소에서 제거하며 저장하지 않는다).
 *  2. 설치가 이미 완료된 경우 잠김 화면을 표시한다. 세션이 없으면(토큰 없음 · 불일치 · 만료) 토큰 화면을 표시한다.
 *  3. 주소에 단계 없이 진입했을 때 진행 중이던 내용이 있으면 이어 하기 화면을, 없으면 사전 점검부터 표시한다.
 * 화면 전환
 *  - 단계는 주소(#/domain …)로 구분한다. 현재 흐름에 없는 단계의 주소로 진입하면 가장 가까운 이전 단계로 이동시킨다.
 *  - 적용이 실행 중인 동안에는 적용 화면만 표시한다(중단된 경우에는 수정을 위해 다른 화면으로 이동할 수 있다).
 *  - 이 창에서 설치를 완료한 경우 서버가 잠긴 이후에도 적용 화면의 최종 상태와 완료 화면을 표시한다.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { UiButton } from '~/components/ui/Button'
import { UiCallout } from '~/components/ui/Callout'
import type { InstallerApi } from './api/types'
import { isLive, nearestLive, type RouteId, type StepId } from './flow'
import { useT } from './i18n'
import { navigate, useRoute } from './router'
import { AdminScreen } from './screens/AdminScreen'
import { AdvancedScreen } from './screens/AdvancedScreen'
import { AiScreen } from './screens/AiScreen'
import { ApplyScreen } from './screens/ApplyScreen'
import { CertScreen } from './screens/CertScreen'
import { CheckScreen } from './screens/CheckScreen'
import { DomainScreen } from './screens/DomainScreen'
import { DoneScreen } from './screens/DoneScreen'
import { GitScreen } from './screens/GitScreen'
import { LockedScreen } from './screens/LockedScreen'
import { MailScreen } from './screens/MailScreen'
import { MeetScreen } from './screens/MeetScreen'
import { PortsScreen } from './screens/PortsScreen'
import { ProxyScreen } from './screens/ProxyScreen'
import { RestoreFileScreen } from './screens/RestoreFileScreen'
import { RestoreReviewScreen } from './screens/RestoreReviewScreen'
import { ResumeScreen } from './screens/ResumeScreen'
import { StartScreen } from './screens/StartScreen'
import { StorageScreen } from './screens/StorageScreen'
import { SummaryScreen } from './screens/SummaryScreen'
import { TokenScreen } from './screens/TokenScreen'
import { ZonesScreen } from './screens/ZonesScreen'
import { CenterShell } from './shell/WizardShell'
import { Toasts } from './shell/Toasts'
import { createWizardStore, flowOf, resumeStep, useWizard, WizardContext, type WizardStore } from './store'

const SCREENS: Record<StepId | 'advanced', () => ReactElement> = {
  check: CheckScreen, start: StartScreen, domain: DomainScreen, proxy: ProxyScreen, cert: CertScreen, storage: StorageScreen,
  zones: ZonesScreen, ports: PortsScreen, mail: MailScreen, meet: MeetScreen, ai: AiScreen, git: GitScreen, admin: AdminScreen,
  summary: SummaryScreen, apply: ApplyScreen, file: RestoreFileScreen, review: RestoreReviewScreen, advanced: AdvancedScreen,
}

export interface InstallerAppProps {
  api: InstallerApi
  /** 주소에 포함되어 전달된 설치 토큰(1회 사용 후 폐기) */
  token?: string | null
  /** 서버가 주소의 토큰을 이미 확인하여 전달한 결과(불일치 · 만료 · 일시 수신 거부) */
  tokenStatus?: { status: 'wrong' | 'expired' | 'locked'; retry_after?: number } | null
  /** 테스트에서 생성한 저장소를 그대로 사용할 때 지정 */
  store?: WizardStore
}

export function InstallerApp({ api, token = null, tokenStatus = null, store: given }: InstallerAppProps) {
  const [store] = useState(() => given ?? createWizardStore(api))
  useEffect(() => { void store.getState().init(token, tokenStatus) }, [store, token, tokenStatus])
  return (
    <WizardContext.Provider value={store}>
      <Root />
      <Toasts />
    </WizardContext.Provider>
  )
}

function Root() {
  const t = useT()
  const boot = useWizard(s => s.boot)
  const server = useWizard(s => s.server)
  const answers = useWizard(s => s.answers)
  const catalog = useWizard(s => s.catalog)
  const applyStatus = useWizard(s => s.apply?.status ?? null)
  const finishedHere = useWizard(s => s.finishedHere)
  const init = useWizard(s => s.init)
  const route = useRoute()
  const [resumeSeen, setResumeSeen] = useState(false)

  useEffect(() => { document.title = t('docTitle') }, [t])

  const ready = boot === 'ready' && !!server && server.session === 'ok' && !server.locked && !finishedHere
  const steps = flowOf(answers, catalog)
  const applying = ready && server.phase === 'applying'
  const hasProgress = ready && (applying || resumeStep(answers, catalog, server.step) != null)
  const showResume = ready && route.id == null && hasProgress && !resumeSeen

  // 이동 대상 — 화면 렌더링 이후에 주소를 변경한다(렌더링 도중에는 변경하지 않는다)
  let redirect: RouteId | null = null
  if (ready && !showResume) {
    if (route.id == null) redirect = applying ? 'apply' : 'check'
    else if (route.id === 'done') redirect = applying ? 'apply' : 'check'
    else if (applying && applyStatus === 'running' && route.id !== 'apply') redirect = 'apply'
    else if (route.id !== 'advanced' && !isLive(steps, route.id)) redirect = nearestLive(steps, route.id)
  }
  useEffect(() => { if (redirect) navigate(redirect, { replace: true }) }, [redirect])

  if (boot === 'loading') {
    return <CenterShell><UiCallout variant="plain" tone="neutral" icon="loader" spin role="status">{t('common.loading')}</UiCallout></CenterShell>
  }
  if (boot === 'error' || !server) {
    return (
      <CenterShell>
        <UiCallout tone="danger" role="alert" title={t('common.loadFailed')}>{t('common.loadFailedHint')}</UiCallout>
        <UiButton type="button" variant="secondary" icon="refresh" onClick={() => { void init(null) }}>{t('common.retry')}</UiButton>
      </CenterShell>
    )
  }
  // 이 창에서 설치 완료 — 서버는 이미 잠김 상태. 적용 화면의 최종 상태와 완료 화면만 표시
  if (finishedHere) return route.id === 'done' ? <DoneScreen /> : <ApplyScreen />
  if (server.locked) return <LockedScreen />
  if (server.session !== 'ok') return <TokenScreen />
  if (showResume) return <ResumeScreen onRestart={() => { setResumeSeen(true); navigate('start') }} />
  if (redirect || route.id == null || route.id === 'done') return null

  const Screen = SCREENS[route.id]
  return <Screen key={route.id} />
}
