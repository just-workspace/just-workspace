/**
 * 회의 화면(로그인 사용자·호스트) — 장치 확인 → 회의 → 종료. Vue 판 pages/meetings/room/[name].vue 그대로.
 * 미니 통화 창: 접속은 앱 수준 세션(useMeetings)이 쥐고, 이 화면은 "전체 회의 화면"일 뿐이다.
 * 회의 머리 왼쪽 끝 "작게 보기"(minimize-2 · Alt+M), 제목 아래 "경과 · n명".
 * 끝난 뒤 데스크톱 오른쪽 stage 에 "이번 회의" 요약 카드(MeetingsEndSummary).
 */
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { navigateTo, queryString, useRoute } from '~/lib/router'
import { authStore, useAuth } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import {
  meetingsStore, useMeetings, reacquireMic, leaveRoom, joinRoom, cancelPendingJoin, isJoinCancelled,
  runMediaToggle, toggleBackgroundBlur, setVirtualBackground, toggleNoiseCancellation,
  toggleRecording, fetchRecordingStatus, fetchPendingRequests,
  loadLivekit, getMeetingSummary, type MeetingSummaryInfo,
} from '~/composables/useMeetings'
import { meetingCallStore, setReturnPath, setRoomPanel, useMeetingCall, isPopup, leaveRoomPage } from '~/composables/useMeetingCall'
import { MINIMIZE_KEYS, formatCallElapsed, isMinimizeShortcut } from '~/utils/miniCall'
import { hhmmOf } from '~/utils/myStatus'
import { MeetingsEndSummary } from '~/components/meetings/MeetingsEndSummary'
import { useMeetingSessionStats } from '~/composables/useMeetingSessionStats'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiButton } from '~/components/ui/Button'
import { MeetingsDeviceSetup, type MeetingDeviceSelection } from '~/components/meetings/MeetingsDeviceSetup'
import { MeetingsVideoGrid } from '~/components/meetings/MeetingsVideoGrid'
import { MeetingsSidebar } from '~/components/meetings/MeetingsSidebar'
import { MeetingsDeviceMenu } from '~/components/meetings/MeetingsDeviceMenu'
import { MeetingsControls, type MeetingsSidebarTab } from '~/components/meetings/MeetingsControls'
import { MeetingsResultScreen } from '~/components/meetings/MeetingsResultScreen'
import { MeetingAiTodos } from '~/components/meetings/MeetingAiTodos'
import { MeetingsRecordingsModal } from '~/components/meetings/MeetingsRecordingsModal'
import { writeClipboard } from '~/lib/clipboard'

/** 회의 화면. Nuxt 는 매개변수가 바뀌면 페이지를 새로 만든다(라우트 키) — 같게 방 이름으로 key. */
export default function MeetingRoomPage() {
  const route = useRoute()
  // 회의 화면 진입 때 livekit-client 청크를 미리 받아 둔다(메인 번들에서 뺀 것 — 입장 버튼 대기 줄이기)
  useEffect(() => { void loadLivekit().catch(() => { /* 입장 때 다시 시도 */ }) }, [])
  return <MeetingRoom key={String(route.params.name)} />
}

function MeetingRoom() {
  const route = useRoute()
  // 라우트 매개변수는 마운트 때 한 번(Vue setup 과 같음). 라우터가 이미 디코드해서 준다 —
  // 여기서 한 번 더 디코드하면 이름에 % 가 든 회의("매출 50% 회의")에서 URIError 로 화면이 죽는다.
  const [roomName] = useState(() => String(route.params.name ?? ''))
  // 주소의 ?t=·?ws=(토큰·접속 서버)와 ?host=1 은 받지 않는다. 접속 서버를 주소에서 받으면 꾸민 링크 하나로
  // 이 출처(카메라·마이크 권한이 이미 있는)의 영상·음성을 바깥 서버로 보낼 수 있다. 토큰·서버 주소·호스트 여부는 백엔드가 준다.
  const [query] = useState(() => ({
    st: queryString(route.query.st) || '',
  }))

  const {
    connected, connectionState, rejoinAttempt, micInterrupted, remoteEnded, currentRoomName, isHost, participants, callStartedAt,
    cameraEnabled, micEnabled, screenShareEnabled, blurEnabled, vbgEnabled, blurBusy, noiseEnabled, noiseBusy, noiseSupported,
    recording, recordingBusy,
  } = useMeetings()

  const { t } = useI18n()
  const { user } = useAuth()
  // 미니 통화 창: 접속은 앱 수준 세션이 쥐고, 이 화면은 "전체 회의 화면"일 뿐이다.
  const { returnPath } = useMeetingCall()

  // 이미 이 방에 통화 중이면(미니 창에서 펼쳐 돌아옴) 장치 확인 없이 회의 화면으로 이어 간다
  const [resumed] = useState(() => {
    const s = meetingsStore.getState()
    return s.inCall && s.currentRoomName === roomName
  })

  // 3단계: device-setup → meeting → ended
  const [phase, setPhase] = useState<'device-setup' | 'meeting' | 'ended'>(resumed ? 'meeting' : 'device-setup')

  // 사이드바 상태
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<MeetingsSidebarTab>('participants')

  // 공유 링크
  const shareToken = query.st
  const [linkCopied, setLinkCopied] = useState(false)

  function getShareUrl() {
    if (!shareToken) return ''
    return `${window.location.origin}/meetings/join/${shareToken}`
  }

  async function copyShareLink() {
    const url = getShareUrl()
    if (!url) return
    try {
      await writeClipboard(url)
      setLinkCopied(true)
      setTimeout(() => { setLinkCopied(false) }, 2000)
    } catch { /* ignore */ }
  }

  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false)

  // 회의 종료 화면 "'회의' · 58분 · 참가 6명".
  // 앱 수준(key)에 둔다 — 미니 창으로 내렸다 돌아와도, 미니 창에서 나가도 같은 통계를 쓴다.
  const stats = useMeetingSessionStats(() => participants.length, 'meetings-call-stats')
  // 끝난 회의 요약(서버 쪽: 제목·호스트·채널·캘린더) — 볼 수 없으면(404) 이 화면이 본 값만
  const [summary, setSummary] = useState<MeetingSummaryInfo | null>(null)
  const res = stats.result
  const endTitle = summary?.title || currentRoomName || roomName
  const aiRange = res?.startedAt && res?.endedAt ? `${hhmmOf(new Date(res.startedAt))}–${hhmmOf(new Date(res.endedAt))}` : undefined
  const overDesc = res
    ? (res.startedAt && res.endedAt
        ? t('meetings.summary.overLine', { name: endTitle, range: `${hhmmOf(new Date(res.startedAt))}–${hhmmOf(new Date(res.endedAt))}`, min: res.minutes })
        : t('meetings.join.overDesc', { name: endTitle, min: res.minutes, n: res.participants }))
    : t('meetings.room.endedDesc')
  useEffect(() => {
    if (phase !== 'ended' || !user) return
    let alive = true
    getMeetingSummary(roomName).then(s => { if (alive) setSummary(s) }).catch(() => { /* 요약 없이 */ })
    return () => { alive = false }
  }, [phase, roomName, user])
  // 이번 접속에서 녹화가 돌았으면 끝난 화면 요약에 [녹화 파일](목록·내려받기) — 최소 진입점
  const [everRecorded, setEverRecorded] = useState(false)
  useEffect(() => { if (recording) setEverRecorded(true) }, [recording])
  const [showRecordings, setShowRecordings] = useState(false)
  const calendarTarget = summary?.calendar_event_id
    ? `/calendar?event=${encodeURIComponent(summary.calendar_event_id)}`
    : summary?.scheduled_at
      ? (() => { const d = new Date(summary.scheduled_at); const p = (n: number) => String(n).padStart(2, '0'); return `/calendar?date=${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` })()
      : null

  // 회의 머리 "경과 · n명" — 1초마다
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    if (phase !== 'meeting') return
    const id = setInterval(() => { setNowTick(Date.now()) }, 1000)
    return () => clearInterval(id)
  }, [phase])
  const elapsed = formatCallElapsed(callStartedAt ? nowTick - callStartedAt : 0)

  // 호스트 대기실 폴링 — 사이드바 마운트 여부와 무관하게 룸에 있는 동안 돈다
  const pendingTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  function stopPendingPoll() {
    if (pendingTimer.current) { clearInterval(pendingTimer.current); pendingTimer.current = null }
  }
  function startPendingPoll() {
    stopPendingPoll()
    if (!meetingsStore.getState().isHost) return
    void fetchPendingRequests()
    pendingTimer.current = setInterval(fetchPendingRequests, 1500)
  }

  // 접속 중 — [참여하기]를 잠근다(연속 클릭으로 접속이 두 번 시작되지 않게)
  const [joining, setJoining] = useState(false)
  const joiningRef = useRef(false)
  const alive = useRef(true)
  async function handleDeviceReady(opts: MeetingDeviceSelection | { cameraEnabled: boolean; micEnabled: boolean }) {
    if (joiningRef.current) return
    joiningRef.current = true
    setJoining(true)
    try {
      // 인증 사용자 — API로 토큰 발급(호스트·계정으로 초대받은 사람). 호스트 여부도 거기서 온다.
      await joinRoom(roomName, opts)
      if (!alive.current) return
      setPhase('meeting')
      // 로그인 사용자만 미니 창으로 내릴 수 있다(손님은 셸이 없다) — 돌아올 경로를 올려 둔다
      setReturnPath(user ? route.fullPath : null)
      stats.start()
      void fetchRecordingStatus()   // 이미 녹화 중인 방이면 상태 반영
      startPendingPoll()
    } catch (e: any) {
      // 취소(화면 이탈·나가기)는 실패가 아니다
      if (isJoinCancelled(e) || !alive.current) return
      const status = e?.status ?? e?.statusCode
      if (status === 403 && shareToken) {
        // 호스트도 초대 대상도 아니다 — 초대 링크 입장(대기실·비밀번호)으로 보낸다. 예전엔 여기서 막혀 들어갈 길이 없었다.
        void navigateTo(`/meetings/join/${encodeURIComponent(shareToken)}`, { replace: true })
        return
      }
      addToast('error', e?.data?.detail || t('meetings.join.joinFail'))
      console.error('[meetings] join failed:', e)
    } finally {
      joiningRef.current = false
      if (alive.current) setJoining(false)
    }
  }

  function closeWindow() {
    try {
      window.close()
    } catch { /* ignore */ }
    // window.close()가 무시될 경우 안내 표시
  }

  /** 종료 화면 "회의 목록": 팝업이면 창을 닫고, 닫히지 않으면(직접 연 탭) 목록으로 이동.
   *  같은 탭으로 들어온 회의(앱 안 진입)에서 window.close() 를 부르면 스크립트로 연 탭일 때 앱 자체가 닫히므로 팝업일 때만 닫는다. */
  function toList() {
    if (!isPopup()) { void navigateTo('/meetings'); return }
    closeWindow()
    setTimeout(() => { if (!window.closed) void navigateTo('/meetings') }, 300)
  }

  /** 장치 확인 취소: 팝업이면 창을 닫고, 같은 탭이면 직전 화면(없으면 목록)으로 */
  function handleCancel() {
    if (isPopup()) toList()
    else leaveRoomPage()
  }

  /** "작게 보기" — 통화는 그대로 두고 직전 화면으로. 셸이 미니 통화 창(모바일은 상단 띠)을 띄운다. */
  const canMinimize = !!user && !!returnPath
  function minimize() {
    leaveRoomPage()
  }
  // 단축키 Alt+M(입력 중에도 — Alt 조합은 글자 입력과 겹치지 않는다)
  const minimizeRef = useRef<() => void>(() => {})
  minimizeRef.current = () => { if (phase === 'meeting' && canMinimize) minimize() }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isMinimizeShortcut(e)) return
      e.preventDefault()
      minimizeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  async function handleLeave() {
    stats.stop()
    stopPendingPoll()
    await leaveRoom()
    setReturnPath(null)
    setPhase('ended')
  }
  // 저쪽에서 끝났으면(호스트가 회의 종료·내보냄) 끊김 오버레이가 아니라 종료 화면으로 —
  // 예전엔 "연결이 끊겼습니다 [재시도]"로 남아, 재시도는 실패 토스트뿐이었다.
  const handleLeaveRef = useRef(handleLeave)
  handleLeaveRef.current = handleLeave
  useEffect(() => {
    if (remoteEnded && phase === 'meeting') void handleLeaveRef.current()
  }, [remoteEnded, phase])

  /** 재입장을 5회까지 다 쓴 뒤 사용자가 직접 다시 시도 */
  async function handleRetry() {
    try {
      await handleDeviceReady({ cameraEnabled, micEnabled })
    } catch { /* handleDeviceReady 가 토스트를 띄운다 */ }
  }

  function handleSidebarToggle(tab: MeetingsSidebarTab) {
    if (sidebarOpen && sidebarTab === tab) {
      setSidebarOpen(false)
    } else {
      setSidebarTab(tab)
      setSidebarOpen(true)
    }
  }

  // 창 닫기 시 자동 퇴장은 앱 수준 세션이 한다(useMeetings — 미니 창 상태에서도 동작).

  // 미니 창에서 펼쳐 돌아왔으면 대기실 폴링만 다시 건다(접속·통계는 세션에 그대로 있다).
  // 미니 창 대기실 띠의 "대기실 전체"로 왔으면 참가자 사이드바를 열어 둔다.
  useEffect(() => {
    if (resumed) {
      startPendingPoll()
      const panel = meetingCallStore.getState().roomPanel
      if (panel) { setSidebarTab(panel); setSidebarOpen(true); setRoomPanel(null) }
    }
    return () => {
      alive.current = false
      stopPendingPoll()
      // 아직 접속 중이면(토큰 요청·connect 대기) 그 입장을 접는다 — 떠난 뒤에 접속이 완료돼 통화가 붙지 않게
      cancelPendingJoin()
      // 로그인 사용자가 다른 화면으로 가면 통화를 끊지 않는다 — 셸의 미니 통화 창이 이어받는다.
      // 손님(셸 없음)·돌아올 경로가 없는 경우는 예전처럼 떠나면 퇴장. 재입장 대기 중(connected=false)도 세션을 끝낸다.
      const s = meetingsStore.getState()
      const minimizable = !!authStore.getState().user && !!meetingCallStore.getState().returnPath
      if (minimizable && s.inCall) return
      if (s.connected || s.inCall) void leaveRoom()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="min-h-dvh bg-background text-foreground">
      {/* 1. 장치 테스트(참가 전 화면) */}
      {phase === 'device-setup' && (
        <MeetingsDeviceSetup
          roomName={roomName}
          subtitle={t('meetings.device.subtitle')}
          cancelable
          busy={joining}
          busyLabel={t('meetings.device.joining', '참여하는 중…')}
          selfName={user?.display_name || user?.username || ''}
          onJoin={opts => void handleDeviceReady(opts)}
          onCancel={handleCancel}
        />
      )}

      {/* 2. 회의 중 — 일시적 끊김(connected=false)에도 UI 유지, 오버레이만 표시 */}
      {phase === 'meeting' && (
        <div className="flex flex-col h-screen supports-[height:100dvh]:h-dvh relative">
          {/* 연결 상태 오버레이 — 재연결/재입장/종료를 구분해서 보여준다 */}
          {!connected && (
            <div className="absolute inset-0 z-overlay flex items-center justify-center bg-background/80 backdrop-blur-xs">
              <div className="flex flex-col items-center gap-3 text-center px-6">
                {connectionState !== 'disconnected' && (
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                )}
                <p className="text-sm text-muted-foreground">
                  {connectionState === 'reconnecting'
                    ? t('meetings.room.reconnecting')
                    : connectionState === 'rejoining'
                      ? t('meetings.room.rejoining', { n: rejoinAttempt, max: 5 })
                      : t('meetings.room.disconnected')}
                </p>
                <div className="flex gap-2">
                  {connectionState === 'disconnected' && (
                    <button
                      onClick={() => void handleRetry()}
                      className="px-4 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                    >
                      {t('common.retry')}
                    </button>
                  )}
                  <button
                    onClick={() => void handleLeave()}
                    className="px-4 py-1.5 text-sm rounded-md border border-border hover:bg-accent transition-colors"
                  >
                    {t('meetings.controls.leave')}
                  </button>
                </div>
              </div>
            </div>
          )}
          {/* 룸 헤더 — 왼쪽 끝 "작게 보기"(뒤로 자리) · 제목 + 경과·인원 · 오른쪽 초대 링크 */}
          <div className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-2 pt-[calc(0.5rem+env(safe-area-inset-top))]">
            {/* 작게 보기: 통화를 유지한 채 앱의 다른 화면으로. 손님에겐 없다(셸이 없다). */}
            {canMinimize && (
              <UiIconButton
                label={t('meetings.mini.minimizeLong')}
                icon="minimize-2"
                size="md"
                keys={MINIMIZE_KEYS}
                aria-keyshortcuts="Alt+M"
                onClick={minimize}
              />
            )}
            <div className="min-w-0 flex-1 leading-tight">
              <h2 className="truncate text-[13px] font-semibold">{currentRoomName}</h2>
              <div className="text-[11px] text-muted-foreground">
                <span className="font-mono">{elapsed}</span> · {t('meetings.mini.people', { n: participants.length })}
              </div>
            </div>
            {shareToken && (
              <button
                onClick={() => void copyShareLink()}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent"
              >
                <UiIcon name="link" className="h-3.5 w-3.5" />
                {linkCopied ? t('common.copied') : t('meetings.room.inviteLink')}
              </button>
            )}
          </div>

          {/* 메인 영역: 비디오 + 사이드바 */}
          <div className="relative flex flex-1 min-h-0 overflow-hidden">
            <MeetingsVideoGrid participants={participants} />

            {/* 사이드바 */}
            {sidebarOpen && (
              <MeetingsSidebar
                activeTab={sidebarTab}
                onUpdateActiveTab={setSidebarTab}
                onClose={() => setSidebarOpen(false)}
              />
            )}
          </div>

          {/* 마이크 중단 배너 */}
          {micInterrupted && (
            <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-2 bg-warning/15 text-warning text-sm">
              <span className="min-w-0 truncate">{t('meetings.room.micInterrupted')}</span>
              <button
                onClick={() => void reacquireMic()}
                className="shrink-0 px-3 py-1 text-xs font-medium rounded-md border border-warning/40 hover:bg-warning/10 transition-colors"
              >
                {t('meetings.room.micReconnect')}
              </button>
            </div>
          )}

          {/* 컨트롤 바 */}
          <div className="relative shrink-0">
            {deviceMenuOpen && <MeetingsDeviceMenu onClose={() => setDeviceMenuOpen(false)} />}
            <MeetingsControls
              cameraEnabled={cameraEnabled}
              micEnabled={micEnabled}
              screenShareEnabled={screenShareEnabled}
              blurEnabled={blurEnabled}
              vbgEnabled={vbgEnabled}
              blurBusy={blurBusy}
              noiseEnabled={noiseEnabled}
              noiseBusy={noiseBusy}
              noiseSupported={noiseSupported}
              deviceMenuOpen={deviceMenuOpen}
              isHost={isHost}
              recording={recording}
              recordingBusy={recordingBusy}
              sidebarOpen={sidebarOpen}
              sidebarTab={sidebarTab}
              onToggleCamera={() => void runMediaToggle('camera')}
              onToggleMic={() => void runMediaToggle('mic')}
              onToggleScreen={() => void runMediaToggle('screen')}
              onToggleBlur={() => void toggleBackgroundBlur()}
              onToggleNoise={() => void toggleNoiseCancellation()}
              onSetBackground={f => void setVirtualBackground(f)}
              onToggleRecording={() => void toggleRecording()}
              onLeave={() => void handleLeave()}
              onToggleSidebar={handleSidebarToggle}
              onToggleDeviceMenu={() => setDeviceMenuOpen(!deviceMenuOpen)}
            />
          </div>
        </div>
      )}

      {/* 3. 회의 종료(종료 muted 타일 · [회의 목록으로][다시 참여]). 팝업이 닫히지 않을 때의 폴백 포함 */}
      {phase === 'ended' && (
        <MeetingsResultScreen
          icon="video"
          tone="muted"
          title={t('meetings.endedTitle')}
          description={overDesc}
          aside={(
            <div className="flex max-h-full w-full max-w-[440px] flex-col gap-4 overflow-y-auto">
            <MeetingsEndSummary
              hostName={summary?.host_name || (summary?.is_host ? (user?.display_name || user?.username) : undefined)}
              participants={res?.participants}
              people={res?.people}
              chats={res?.chats}
              onOpenChat={summary?.chat_channel_id ? () => { void navigateTo({ path: '/chat', query: { channel: summary.chat_channel_id! } }) } : undefined}
              onOpenCalendar={calendarTarget ? () => { void navigateTo(calendarTarget) } : undefined}
              onOpenRecordings={everRecorded && user ? () => setShowRecordings(true) : undefined}
            />
            {/* 화면 안 AI: 회의 요약 → 할 일 */}
            {user && <MeetingAiTodos room={roomName} title={endTitle} timeRange={aiRange} startedAt={res?.startedAt} />}
            </div>
          )}
        >
          <UiButton size="lg" className="h-12 w-full rounded-lg text-[15px] font-semibold" onClick={toList}>{t('meetings.join.toList')}</UiButton>
          <UiButton variant="outline" size="lg" className="h-12 w-full rounded-lg bg-card text-[15px]" onClick={() => setPhase('device-setup')}>{t('meetings.rejoin')}</UiButton>
          {/* 모바일: 회의 요약 → 할 일 카드(데스크톱은 오른쪽 aside) */}
          {user && <MeetingAiTodos className="lg:hidden" room={roomName} title={endTitle} timeRange={aiRange} startedAt={res?.startedAt} />}
          {/* 모바일은 요약 카드(aside)를 그리지 않는다 — 녹화 파일 진입점을 버튼 줄에 */}
          {everRecorded && user && (
            <UiButton variant="ghost" size="lg" className="h-12 w-full rounded-lg text-[15px] lg:hidden" onClick={() => setShowRecordings(true)}>{t('meetings.recordings.menu')}</UiButton>
          )}
        </MeetingsResultScreen>
      )}
      {showRecordings && <MeetingsRecordingsModal room={roomName} title={endTitle} onClose={() => setShowRecordings(false)} />}
    </div>
  )
}
