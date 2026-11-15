/**
 * 설치 마법사 — 어느 화면을 그릴지 정하는 곳.
 *
 * 들어올 때
 *  1. 서버 상태를 읽는다. 주소에 토큰이 실려 왔으면 그것으로 세션을 만든다(토큰은 주소에서 지우고 저장하지 않는다).
 *  2. 설치가 이미 끝났으면 잠김 화면. 세션이 없으면(토큰 없음 · 틀림 · 만료) 토큰 화면.
 *  3. 주소에 단계가 없이 들어왔는데 하던 것이 있으면 이어 하기 화면, 없으면 사전 점검부터.
 * 화면 사이
 *  - 단계는 주소(#/domain …)로 구분한다. 지금 흐름에 없는 단계의 주소로 오면 가장 가까운 앞 단계로 보낸다.
 *  - 적용이 돌고 있는 동안에는 적용 화면만 보인다(멈췄을 때는 고치러 다른 화면에 갈 수 있다).
 *  - 이 창에서 설치를 끝냈으면 서버가 잠긴 뒤에도 적용 화면의 끝 모습과 완료 화면을 보인다.
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
  /** 주소에 실려 온 설치 토큰(한 번 쓰고 버린다) */
  token?: string | null
  /** 서버가 주소의 토큰을 이미 확인하고 알려 준 결과(틀림 · 만료 · 잠시 받지 않음) */
  tokenStatus?: { status: 'wrong' | 'expired' | 'locked'; retry_after?: number } | null
  /** 테스트에서 만든 저장소를 그대로 쓸 때 */
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

  // 어디로 보낼지 — 화면을 그린 뒤에 주소를 바꾼다(그리는 도중에 바꾸지 않는다)
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
  // 이 창에서 설치를 끝냈다 — 서버는 이미 잠겼다. 적용 화면의 끝 모습과 완료 화면만 보인다
  if (finishedHere) return route.id === 'done' ? <DoneScreen /> : <ApplyScreen />
  if (server.locked) return <LockedScreen />
  if (server.session !== 'ok') return <TokenScreen />
  if (showResume) return <ResumeScreen onRestart={() => { setResumeSeen(true); navigate('start') }} />
  if (redirect || route.id == null || route.id === 'done') return null

  const Screen = SCREENS[route.id]
  return <Screen key={route.id} />
}
