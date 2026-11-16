/**
 * 격리 브라우저 단독 앱(rbi 전용 출처) — 화면 전체를 사용하는 격리 브라우저. 워크스페이스 셸·모듈은 이 번들에 포함되지 않는다(vite.rbi.config.ts 가 검사).
 *
 * 흐름
 *  1. GET /api/rbi/site/me — 401 이면 SSO 홉(/auth/login?return=…)으로 즉시 이동한다.
 *     홉이 실패하여 ?sso_error= 로 복귀했거나 직전에 로그아웃한 경우 자동 이동하지 않고 [다시 로그인] 을 표시한다(루프 방지).
 *  2. 대상·내 세션을 조회한다. 진행 중인 세션이 있으면 해당 화면으로(새로고침 후에도 유지), 없으면 대상 고르기 + 최근 세션.
 *  3. 세션 화면 = 신뢰 상단 줄(RbiTrustedBar) + 나머지 전체 격리 화면(RbiStage). 60초마다 핑 — 서버에서 회수되면 화면도 이에 따른다.
 *     관리자가 종료한 경우(강제 종료 · 권한 회수 · 대상 끄기/삭제 — end_reason=admin) 대상 고르기로 복귀하며 해당 사실을 안내한다.
 *     미러는 연결이 끊기는 즉시 상태를 재조회한다(핑 주기를 대기하지 않는다).
 * 키보드: 세션이 열리면 포커스는 격리 화면. Ctrl+Alt+B = 상단 줄로 이동(격리 화면으로는 전달하지 않는다), 상단 줄에서 Esc = 격리 화면으로 이동.
 * 높이는 dvh(모바일 하단 가려짐 — h-screen 금지).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import {
  endRbiSession, fetchRbiMe, fetchRbiRecent, fetchRbiSession, fetchRbiTargets, pingRbiSession, rbiLoginUrl, rbiSiteLogout,
  startRbiSession, switchRbiMode, type RbiMode, type RbiSession, type RbiSiteMe, type RbiTarget,
} from '~/composables/useRbi'
import type { RbiMirrorConn } from '~/components/rbi/RbiMirrorView'
import type { PolicyInfo } from '~/lib/rbiMirror/vocab'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { RbiTrustedBar } from './RbiTrustedBar'
import { RbiPicker } from './RbiPicker'
import { RbiStage, type RbiStageHandle } from './RbiStage'

const PING_MS = 60_000

/** 상단 줄로 가는 단축키 — 자판 배열과 무관하게 물리 키(B) */
export function isBarShortcut(e: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'code'>): boolean {
  return e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && e.code === 'KeyB'
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'

type Phase = 'loading' | 'redirecting' | 'signin' | 'loggedout' | 'error' | 'ready'

function isActive(s: RbiSession | null | undefined): s is RbiSession {
  return !!s && (s.status === 'running' || s.status === 'starting')
}

export function RbiApp() {
  const { t } = useI18n()
  const params = useRef(new URLSearchParams(window.location.search)).current
  const ssoError = params.get('sso_error')
  const deepTarget = params.get('target')

  const [phase, setPhase] = useState<Phase>('loading')
  const [me, setMe] = useState<RbiSiteMe | null>(null)
  const [targets, setTargets] = useState<RbiTarget[]>([])
  const [recent, setRecent] = useState<RbiSession[]>([])
  const [session, setSession] = useState<RbiSession | null>(null)
  const [starting, setStarting] = useState(false)
  const [docUrl, setDocUrl] = useState('')
  const [agentPol, setAgentPol] = useState<PolicyInfo | null>(null)
  const [conn, setConn] = useState<RbiMirrorConn | null>(null)
  const barRef = useRef<HTMLElement>(null)
  const stageRef = useRef<RbiStageHandle>(null)

  useHead({ title: isActive(session) ? `${session.target_name} · ${t('rbi.title')}` : t('rbi.title') })

  // 홉 결과 쿼리는 주소창에서 제거한다(새로고침 시 오류가 재표시되지 않도록 함)
  useEffect(() => {
    if (!ssoError) return
    const u = new URL(window.location.href)
    u.searchParams.delete('sso_error')
    window.history.replaceState(null, '', u.pathname + u.search)
  }, [ssoError])

  const loadData = useCallback(async () => {
    const [tg, rc] = await Promise.all([fetchRbiTargets(), fetchRbiRecent().catch(() => ({ sessions: [] as RbiSession[] }))])
    setTargets(tg.targets)
    setRecent(rc.sessions)
    setSession(tg.sessions.find(isActive) ?? null)
  }, [])

  const boot = useCallback(async () => {
    setPhase('loading')
    try {
      const m = await fetchRbiMe()
      setMe(m)
      await loadData()
      setPhase('ready')
    } catch (e: any) {
      const code = e?.status ?? e?.statusCode ?? e?.response?.status
      if (code === 401) {
        if (ssoError) { setPhase('signin'); return }
        setPhase('redirecting')
        window.location.assign(rbiLoginUrl())
        return
      }
      setPhase('error')
    }
  }, [loadData, ssoError])
  useEffect(() => { void boot() }, [boot])

  // 핑 + 상태 재조회
  useEffect(() => {
    if (!isActive(session)) return
    const id = session.id
    const timer = setInterval(async () => {
      try {
        const st = await pingRbiSession(id)
        if (st.status !== 'running') setSession(await fetchRbiSession(id))
      } catch (e: any) {
        if ((e?.status ?? e?.statusCode) === 401) { setPhase('signin'); return }
        setSession(await fetchRbiSession(id).catch(() => null))
      }
    }, PING_MS)
    return () => clearInterval(timer)
  }, [session])

  // 미러 연결 끊김 — 서버가 세션을 종료한 경우(권한 회수 등)일 수 있으므로 핑 주기(60초)를 대기하지 않고 즉시 상태를 조회한다
  const connLost = conn?.connected === false
  useEffect(() => {
    if (!connLost || !isActive(session)) return
    let alive = true
    void fetchRbiSession(session.id).then((s) => { if (alive && !isActive(s)) setSession(s) }).catch(() => {})
    return () => { alive = false }
  }, [connLost]) // eslint-disable-line react-hooks/exhaustive-deps

  // 세션이 종료되면 대상 고르기로 복귀(최근 목록 재조회)
  const sid = session?.id
  const sStatus = session?.status
  const sReason = session?.end_reason
  useEffect(() => {
    if (sid && sStatus && !isActive(session)) {
      // 본인이 아닌 관리자가 종료한 경우 — 화면이 안내 없이 대상 고르기로 전환되지 않도록 알린다
      if (sReason === 'admin') addToast('warning', t('rbi.app.endedByAdmin', '관리자가 접근을 종료했습니다'))
      setSession(null)
      void fetchRbiRecent().then(r => setRecent(r.sessions)).catch(() => {})
    }
  }, [sid, sStatus]) // eslint-disable-line react-hooks/exhaustive-deps

  // 세션 변경 시 화면 상태 초기화 + 포커스는 격리 화면으로 이동
  useEffect(() => {
    setDocUrl(''); setAgentPol(null); setConn(null)
    if (session?.status === 'running') {
      const h = window.setTimeout(() => stageRef.current?.focus(), 0)
      return () => window.clearTimeout(h)
    }
  }, [sid, sStatus]) // eslint-disable-line react-hooks/exhaustive-deps

  const focusBar = useCallback(() => {
    const el = barRef.current?.querySelector<HTMLElement>(FOCUSABLE)
    el?.focus()
  }, [])
  const focusStage = useCallback(() => stageRef.current?.focus(), [])

  // 단축키 — 앱 문서(미러: 숨은 입력칸이 여기에 위치)와 픽셀 iframe 창(동일 출처) 양쪽에서 캡처 단계(capture)에 선처리
  const onShortcut = useCallback((e: KeyboardEvent) => {
    if (!isBarShortcut(e)) return
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation?.()
    focusBar()
  }, [focusBar])
  useEffect(() => {
    window.addEventListener('keydown', onShortcut, true)
    return () => window.removeEventListener('keydown', onShortcut, true)
  }, [onShortcut])
  const frameWin = useRef<Window | null>(null)
  const onFrameWindow = useCallback((w: Window | null) => {
    try { frameWin.current?.removeEventListener('keydown', onShortcut, true) } catch { /* 닫힘 */ }
    frameWin.current = w
    try { w?.addEventListener('keydown', onShortcut, true) } catch { /* 다른 출처 — 발생하지 않아야 정상 */ }
  }, [onShortcut])
  useEffect(() => () => { try { frameWin.current?.removeEventListener('keydown', onShortcut, true) } catch { /* */ } }, [onShortcut])

  async function start(target: RbiTarget, mode: RbiMode) {
    setStarting(true)
    try {
      setSession(await startRbiSession(target.id, mode === target.mode ? undefined : mode))
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('rbi.startFailed'))
    } finally { setStarting(false) }
  }

  async function switchMode(mode: RbiMode) {
    if (!session) return
    if (!(await confirmBox(t('rbi.mirror.switchConfirm'), { title: t(mode === 'pixel' ? 'rbi.mirror.switchToPixel' : 'rbi.mirror.switchToMirror'), confirmLabel: t(`rbi.mode.${mode}`) }))) return
    setSession({ ...session, status: 'starting', stream_url: null })
    try { setSession(await switchRbiMode(session.id, mode)) } catch (e: any) {
      addToast('error', e?.data?.detail || t('rbi.mirror.switchFailed'))
      setSession(await fetchRbiSession(session.id).catch(() => null))
    }
  }

  async function end() {
    if (!session) return
    if (!(await confirmBox(t('rbi.endConfirm'), { title: t('rbi.end'), confirmLabel: t('rbi.end'), danger: true }))) { focusStage(); return }
    try { setSession(await endRbiSession(session.id)) } catch (e: any) { addToast('error', e?.data?.detail || t('rbi.startFailed')) }
  }

  async function logout() {
    const live = isActive(session)
    if (!(await confirmBox(t(live ? 'rbi.app.logoutConfirmLive' : 'rbi.app.logoutConfirm'), { title: t('rbi.app.logout'), confirmLabel: t('rbi.app.logout'), danger: live }))) return
    // 열린 세션은 먼저 종료한다(로그아웃한 화면 뒤에 컨테이너가 유휴 시간까지 잔류하지 않도록 함)
    if (live && session) { try { await endRbiSession(session.id) } catch { /* 회수 처리가 종료한다 */ } }
    try { await rbiSiteLogout() } catch { /* 쿠키는 서버가 삭제한다 — 실패해도 화면은 로그아웃 처리 */ }
    setSession(null); setMe(null); setTargets([]); setRecent([])
    setPhase('loggedout')
  }

  const live = isActive(session)
  const target = session ? targets.find(x => x.id === session.target_id) : undefined
  const policy = agentPol
    ? { clipboard_to_browser: agentPol.ci, clipboard_from_browser: agentPol.co, downloads: agentPol.dl, uploads: agentPol.ul, idle_minutes: 0, max_hours: 0 }
    : target?.policy ?? null

  return (
    <div className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-background text-foreground">
      <RbiTrustedBar
        ref={barRef}
        me={me}
        session={live ? session : null}
        url={docUrl || session?.target_url || ''}
        policy={policy}
        conn={conn}
        onSwitchMode={m => { void switchMode(m) }}
        onEnd={() => { void end() }}
        onLogout={() => { void logout() }}
        onEscape={focusStage}
      />
      <main className="flex min-h-0 flex-1 flex-col" aria-label={t('rbi.app.stageLabel')}>
        {phase === 'loading' || phase === 'redirecting' ? (
          <div className="p-6" role="status" aria-live="polite">
            {phase === 'redirecting' ? <p className="text-sm text-muted-foreground">{t('rbi.app.redirecting')}</p> : <UiSkeleton preset="text" rows={3} />}
          </div>
        ) : phase === 'signin' || phase === 'loggedout' ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <UiEmptyState
              variant="panel"
              icon="shield"
              title={t(phase === 'loggedout' ? 'rbi.app.loggedOut' : 'rbi.app.signinTitle')}
              description={ssoError && phase === 'signin' ? t(`rbi.app.ssoError.${['state', 'code', 'user', 'store'].includes(ssoError) ? ssoError : 'other'}`) : t('rbi.app.signinDesc')}
              actionLabel={t('rbi.app.signin')}
              onAction={() => window.location.assign(rbiLoginUrl())}
            />
          </div>
        ) : phase === 'error' ? (
          <div className="p-6"><UiErrorTile placement="card" title={t('rbi.loadError')} onRetry={() => { void boot() }} /></div>
        ) : live ? (
          <RbiStage
            ref={stageRef}
            session={session}
            onDoc={d => setDocUrl(d.url)}
            onPolicy={setAgentPol}
            onConn={setConn}
            onSuggestPixel={(session.modes ?? []).includes('pixel') && session.mode === 'mirror' ? () => { void switchMode('pixel') } : undefined}
            onFrameWindow={onFrameWindow}
          />
        ) : (
          <RbiPicker
            targets={targets}
            recent={recent}
            initialKey={deepTarget}
            starting={starting}
            onStart={(tg, m) => { void start(tg, m) }}
            onResume={s => setSession(s)}
          />
        )}
      </main>
    </div>
  )
}
