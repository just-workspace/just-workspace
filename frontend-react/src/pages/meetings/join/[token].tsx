/**
 * 초대 링크 입장. Vue 판 pages/meetings/join/[token].vue 그대로.
 *  setup   — 참가 전 화면(MeetingsDeviceSetup): 왼쪽 미리보기 + 장치 바, 오른쪽 방 정보 · 표시 이름(기억) · 비밀번호(보기 토글) → [참가 신청]
 *            버튼은 이름이 비었을 때만 잠기고(guestJoinLock) 이유를 버튼 아래에 쓴다.
 *  waiting — [참가 신청] 자리의 primary 띠(스피너 · 경과 · 취소 — 설정 화면이 그린다). 미리보기·장치는 살아 있다(승인 즉시 그대로 입장).
 *  room    — 통화(기존 그대로 — LiveKit 통화 중 기능은 손대지 않는다)
 *  invalid · denied · error · ended · wrongpw — 결과 화면 1틀(MeetingsResultScreen = 모바일 회의 머리 틀 · 데스크톱 왼쪽 패널)
 *    invalid  링크 만료(서버 410 이면 "'회의'는 10월 15일 16:00에 끝났습니다") + [호스트에게 알리기][로그인]
 *    denied   "박민지 님이 이번 입장 요청을 받지 않았습니다" + [다시 요청][닫기]
 *    ended    "'회의' · 58분 · 참가 6명 · 파일·채팅은 #채널에" + [회의 목록으로][다시 참여]
 *             손님(로그인 안 함)은 버튼 대신 "이 창을 닫아도 됩니다". 데스크톱 오른쪽 stage = "이번 회의" 요약
 *             (손님은 참가·시각만 — MeetingsEndSummary guest)
 *    wrongpw  제목 = 회의 이름, 비밀번호 입력 + 아래 오류 "비밀번호가 맞지 않습니다 · 2번 남음" + [다시 시도]
 *  비밀번호 틀림 화면으로 넘어갈 때 장치 선택을 받아 두고 미리보기를 끈다(다시 시도로 맞히면 그 선택으로 입장).
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { useHead } from '~/lib/head'
import { navigateTo, useRoute } from '~/lib/router'
import { scheduleText } from '~/utils/meetingTime'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { authStore, useAuth } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import {
  meetingsStore, useMeetings, reacquireMic, joinRoomWithToken, leaveRoom, cancelPendingJoin, isJoinCancelled,
  runMediaToggle, toggleBackgroundBlur, setVirtualBackground, toggleNoiseCancellation,
  loadLivekit,
} from '~/composables/useMeetings'
import { useMeetingSessionStats } from '~/composables/useMeetingSessionStats'

import { UiButton } from '~/components/ui/Button'
import { UiInput } from '~/components/ui/Input'
import { UiPasswordInput } from '~/components/ui/PasswordInput'
import { UiTrans } from '~/components/ui/Trans'
import {
  MeetingsDeviceSetup, type MeetingDeviceSelection, type MeetingsDeviceSetupHandle,
} from '~/components/meetings/MeetingsDeviceSetup'
import { guestJoinLock } from '~/components/meetings/prejoin'
import { MeetingsVideoGrid } from '~/components/meetings/MeetingsVideoGrid'
import { MeetingsSidebar } from '~/components/meetings/MeetingsSidebar'
import { MeetingsDeviceMenu } from '~/components/meetings/MeetingsDeviceMenu'
import { MeetingsControls, type MeetingsSidebarTab } from '~/components/meetings/MeetingsControls'
import { MeetingsResultScreen } from '~/components/meetings/MeetingsResultScreen'
import { MeetingsEndSummary } from '~/components/meetings/MeetingsEndSummary'
import { hhmmOf } from '~/utils/myStatus'

type Step = 'loading' | 'setup' | 'waiting' | 'room' | 'denied' | 'invalid' | 'error' | 'ended' | 'wrongpw'
interface RoomInfo {
  name: string; host_name: string; num_participants: number; max_participants: number; requires_password: boolean
  scheduled_at?: string | null; duration_minutes?: number | null; channel_name?: string | null
}

// 표시 이름은 이 브라우저에 기억(문서 공유 /s/ 손님 화면과 같게)
const NICK_KEY = 'jw.meetings.nickname'

function remainingFrom(e: any): number | null {
  try {
    const v = e?.response?.headers?.get?.('x-attempts-remaining')
    return v === null || v === undefined || v === '' ? null : Number(v)
  } catch { return null }
}

/** 초대 링크 입장. Nuxt 는 매개변수가 바뀌면 페이지를 새로 만든다(라우트 키) — 같게 토큰으로 key. */
export default function MeetingJoinPage() {
  const route = useRoute()
  // 회의 화면 진입 때 livekit-client 청크를 미리 받아 둔다(메인 번들에서 뺀 것 — 입장 버튼 대기 줄이기)
  useEffect(() => { void loadLivekit().catch(() => { /* 입장 때 다시 시도 */ }) }, [])
  return <MeetingJoin key={String(route.params.token)} />
}

function MeetingJoin() {
  const route = useRoute()
  const [token] = useState(() => route.params.token as string)

  const {
    connected, connectionState, rejoinAttempt, micInterrupted, remoteEnded, currentRoom, currentRoomName, participants,
    cameraEnabled, micEnabled, screenShareEnabled, blurEnabled, vbgEnabled, blurBusy, noiseEnabled, noiseBusy, noiseSupported,
  } = useMeetings()
  const { appName } = useSiteConfig()
  const { user } = useAuth()
  const { t } = useI18n()

  const [step, setStepState] = useState<Step>('loading')
  const stepRef = useRef<Step>('loading')
  const setStep = (s: Step) => { stepRef.current = s; setStepState(s) }
  const [roomInfo, setRoomInfoState] = useState<RoomInfo | null>(null)
  const roomInfoRef = useRef<RoomInfo | null>(null)
  const setRoomInfo = (r: RoomInfo | null) => { roomInfoRef.current = r; setRoomInfoState(r) }
  // 끝난 회의의 링크(서버 410) — 결과 화면 설명에 회의 이름·끝난 시각
  const [endedInfo, setEndedInfo] = useState<{ name: string; host_name?: string; ended_at?: string | null } | null>(null)
  // 비밀번호 틀림 화면으로 넘어가기 전에 받아 둔 장치 선택
  const lastSelection = useRef<MeetingDeviceSelection | null>(null)
  const stats = useMeetingSessionStats(() => participants.length)
  const [nickname, setNickname] = useState('')
  const [password, setPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const requestId = useRef<string | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useHead({ title: `${roomInfo?.name || t('meetings.join.header')} | ${appName}` })

  function rememberNickname() {
    try { localStorage.setItem(NICK_KEY, nickname.trim()) } catch { /* noop */ }
  }

  // 장치 설정 컴포넌트 — 승인 시점에 선택값을 그대로 읽어 간다
  const setupRef = useRef<MeetingsDeviceSetupHandle | null>(null)

  // 사이드바 / 장치 메뉴
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<MeetingsSidebarTab>('participants')

  // Safari 는 사용자 제스처 없이 붙으면 원격 오디오를 막는다 → 탭 한 번으로 풀 수 있게
  const [audioBlocked, setAudioBlocked] = useState(false)

  // 방 정보 한 줄: 호스트 · 시각 · 인원(숫자는 mono)
  const metaParts = roomInfo
    ? [
      roomInfo.host_name ? t('meetings.list.hostName', { name: roomInfo.host_name }) : '',
      scheduleText(roomInfo.scheduled_at, roomInfo.duration_minutes, undefined, t),
    ].filter(Boolean)
    : []
  const metaNode: React.ReactNode = roomInfo
    ? (
      <>
        {metaParts.join(' · ')}
        {roomInfo.num_participants > 0 && (
          <>{metaParts.length ? ' · ' : ''}<UiTrans k="meetings.join.nowInMeeting" slots={{ n: <span className="font-mono">{roomInfo.num_participants}</span> }} /></>
        )}
      </>
    )
    : ''

  // 1. 회의실 정보 조회
  async function loadInfo() {
    setStep('loading')
    try {
      const data = await $fetch<RoomInfo>(`/api/meetings/join/${token}`)
      setRoomInfo(data)
      setStep('setup')
    } catch (e: any) {
      const status = e?.status ?? e?.statusCode
      const detail = e?.data?.detail
      if (status === 410 && detail && typeof detail === 'object') {
        setEndedInfo({ name: detail.name, host_name: detail.host_name, ended_at: detail.ended_at })
        setStep('invalid')
        return
      }
      setErrorMsg((typeof detail === 'string' && detail) || t('meetings.join.invalidLink'))
      setStep(status === 404 ? 'invalid' : 'error')
    }
  }

  /** "10월 15일 16:00" */
  function whenText(iso?: string | null) {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    const p = (n: number) => String(n).padStart(2, '0')
    return t('meetings.join.whenFmt', { m: d.getMonth() + 1, d: d.getDate(), time: `${p(d.getHours())}:${p(d.getMinutes())}` })
  }
  const expiredDesc = (() => {
    const when = whenText(endedInfo?.ended_at)
    return endedInfo?.name && when ? t('meetings.join.expiredDescNamed', { name: endedInfo.name, when }) : t('meetings.join.expiredDesc')
  })()

  // ── 호스트에게 알리기(만료 화면) ──
  const [notifyState, setNotifyState] = useState<'idle' | 'sending' | 'sent'>('idle')
  async function notifyHost() {
    if (notifyState !== 'idle') return
    setNotifyState('sending')
    try {
      await $fetch(`/api/meetings/join/${token}/notify-host`, { method: 'POST', body: { nickname: nickname.trim() || null } })
      setNotifyState('sent')
      addToast('success', t('meetings.join.notifiedHostDone'))
    } catch (e: any) {
      const status = e?.status ?? e?.statusCode
      if (status === 429) { setNotifyState('sent'); addToast('info', t('meetings.join.notifiedHostAlready')) }
      else { setNotifyState('idle'); addToast('error', (typeof e?.data?.detail === 'string' && e.data.detail) || t('meetings.join.notifyHostFail')) }
    }
  }

  // ── 비밀번호 틀림 ──
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null)
  function wrongPasswordText(left: number | null) {
    if (left === null) return t('meetings.join.wrongPassword')
    if (left <= 0) return t('meetings.join.tooManyAttempts')
    return t('meetings.join.wrongPasswordLeft', { n: left })
  }
  function toWrongPassword() {
    if (stepRef.current === 'setup' || stepRef.current === 'waiting') {
      lastSelection.current = setupRef.current?.getSelection() || lastSelection.current
      setupRef.current?.stopPreview()
    }
    setStep('wrongpw')
  }

  // ── 결과 화면 문구 ──
  const deniedDesc = roomInfo?.host_name
    ? t('meetings.join.deniedDescNamed', { name: roomInfo.host_name })
    : t('meetings.join.deniedDescGeneric')
  const overDesc = (() => {
    const r = stats.result
    const name = roomInfo?.name || ''
    const head = r ? t('meetings.join.overDesc', { name, min: r.minutes, n: r.participants }) : t('meetings.join.endedDesc')
    const ch = roomInfo?.channel_name
    return ch ? `${head} ${t('meetings.join.overChannel', { channel: ch })}` : head
  })()
  function closeTab() {
    window.close()
    // 스크립트로 연 창이 아니면 닫히지 않는다 → 홈으로
    setTimeout(() => { if (!window.closed) void navigateTo(authStore.getState().user ? '/meetings' : '/login') }, 150)
  }

  // 2. 장치 확인 + 닉네임 입력 후 참가 신청
  async function handleRequest() {
    if (!nickname.trim() || submitting) return
    setSubmitting(true)
    setPasswordError('')
    rememberNickname()
    try {
      const data = await $fetch<{ request_id: string; status: string; token?: string; livekit_url?: string }>(
        `/api/meetings/join/${token}/request`,
        { method: 'POST', body: { nickname: nickname.trim(), password: password || null } },
      )
      requestId.current = data.request_id
      // 비밀번호가 맞으면 여기서 이미 승인 — 대기를 건너뛴다
      if (data.status === 'approved' && data.token && data.livekit_url) {
        await enterRoom(data.livekit_url, data.token)
        return
      }
      setStep('waiting')
      startPolling()
    } catch (e: any) {
      const status = e?.status ?? e?.statusCode
      if (status === 403 && password) {
        const left = remainingFrom(e)
        setAttemptsLeft(left)
        setPasswordError(wrongPasswordText(left))
        toWrongPassword()
      } else if (status === 403) {
        setPasswordError(t('meetings.join.passwordRequired'))
      } else if (status === 429) {
        setAttemptsLeft(0)
        setPasswordError(wrongPasswordText(0))
        if (password) toWrongPassword()
      } else if (status === 404) {
        setStep('invalid')
      } else {
        setErrorMsg(e?.data?.detail || t('meetings.join.requestFail'))
        setStep('error')
      }
    } finally {
      setSubmitting(false)
    }
  }

  // 3. 승인 상태 폴링 — 1초. 승인되면 사람 손 없이 바로 들어간다.
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  // 경과 시간은 설정 화면(waitingSince)이 그린다
  const [waitingSince, setWaitingSince] = useState(0)

  // 조회가 1초보다 느리면 겹친다 — 겹친 응답 둘이 각각 입장하지 않게 한 번에 하나만
  const polling = useRef(false)
  function startPolling() {
    setWaitingSince(Date.now())
    stopPolling()
    pollTimer.current = setInterval(async () => {
      const rid = requestId.current
      if (!rid || polling.current) return
      polling.current = true
      try {
        const data = await $fetch<{ status: string; token?: string; livekit_url?: string }>(
          `/api/meetings/join/${token}/request/${rid}/status`,
        )
        // 기다리는 사이 취소했거나 다시 신청했으면 이 응답은 버린다(취소했는데 입장되는 일이 없게)
        if (requestId.current !== rid) return
        if (data.status === 'approved' && data.token && data.livekit_url) {
          stopPolling()
          await enterRoom(data.livekit_url, data.token)
        } else if (data.status === 'denied') {
          stopPolling()
          setupRef.current?.stopPreview()
          setStep('denied')
        }
      } catch (e: any) {
        if (requestId.current !== rid) return
        const status = e?.status ?? e?.statusCode
        // 신청·링크가 없어졌다(호스트가 회의를 종료·삭제) — 예전엔 이것도 삼켜 "승인 대기 중"이 끝없이 돌았다.
        // 방 정보를 다시 물어 끝난 회의면 만료 화면으로, 방이 살아 있으면 입장 화면으로 돌려 다시 신청하게 한다.
        if (status === 404 || status === 410) {
          stopPolling()
          requestId.current = null
          setupRef.current?.stopPreview()
          await loadInfo()
          if (alive.current && stepRef.current === 'setup') {
            addToast('info', t('meetings.join.requestLost', '입장 요청이 만료되었습니다. 다시 신청해 주세요'))
          }
        }
        /* 그 밖(네트워크 오류)은 다음 번에 다시 */
      } finally {
        polling.current = false
      }
    }, 1000)
  }

  function stopPolling() {
    if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null }
  }

  /** 승인되면 사람 손 없이 바로 접속. 장치 선택값은 설정 화면에서 그대로 가져온다. */
  // 이 화면이 접속 중·접속한 통화인가 — 떠날 때 "이 화면의 통화"만 정리한다
  const entering = useRef(false)
  const entered = useRef(false)
  const alive = useRef(true)
  async function enterRoom(wsUrl: string, lkToken: string) {
    if (entering.current) return
    entering.current = true
    const opts = setupRef.current?.getSelection() || lastSelection.current || {}
    setupRef.current?.stopPreview()
    try {
      await joinRoomWithToken(wsUrl, lkToken, roomInfoRef.current?.name || '', opts)
      entered.current = true
      if (!alive.current) return
      setStep('room')
      stats.start()
      watchAudioPlayback()
    } catch (e: any) {
      // 취소(화면 이탈)는 실패가 아니다
      if (isJoinCancelled(e) || !alive.current) return
      setErrorMsg(e?.data?.detail || t('meetings.join.joinFail'))
      setStep('error')
    } finally {
      entering.current = false
    }
  }

  /** 제스처 없이 붙었으므로 Safari 가 오디오를 막을 수 있다. */
  function watchAudioPlayback() {
    const room = meetingsStore.getState().currentRoom as any
    if (!room) return
    setAudioBlocked(room.canPlaybackAudio === false)
    room.on?.('audioPlaybackChanged', () => {
      setAudioBlocked(room.canPlaybackAudio === false)
    })
  }

  async function unblockAudio() {
    try {
      await (currentRoom as any)?.startAudio()
      setAudioBlocked(false)
    } catch { /* noop */ }
  }

  // 표시 이름 불러오기 + 회의실 정보 조회(onMounted 순서 그대로) · 떠날 때 정리
  useEffect(() => {
    try { setNickname(localStorage.getItem(NICK_KEY) || '') } catch { /* 사생활 보호 모드 */ }
    void loadInfo()
    return () => {
      alive.current = false
      stopPolling()
      requestId.current = null
      // 아직 접속 중이면 그 입장을 접는다 — 떠난 뒤에 접속이 완료돼 화면 없는 통화가 남지 않게
      if (entering.current) cancelPendingJoin()
      // 손님 화면은 셸·미니 창이 없다 — 떠나면 퇴장. 재입장 대기 중(connected=false)이어도 세션을 끝낸다.
      // 이 화면에서 들어간 통화만 끊는다: 미니 창에 내려 둔 다른 통화가 있는 채로 초대 링크를 열었다가
      // 그냥 돌아가면 그 통화가 말없이 끊겼다.
      const s = meetingsStore.getState()
      if (entered.current && (s.connected || s.inCall)) void leaveRoom()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleCancel() {
    stopPolling()
    const rid = requestId.current
    requestId.current = null
    setStep('setup')
    // 호스트 대기실에 유령 신청이 남지 않게 서버에도 알린다(실패해도 화면은 그대로 — 신청은 24시간 뒤 사라진다)
    if (rid) void $fetch(`/api/meetings/join/${token}/request/${rid}/cancel`, { method: 'POST' }).catch(() => {})
  }

  async function handleLeave() {
    stats.stop()
    await leaveRoom()
    entered.current = false
    stopPolling()
    requestId.current = null
    setStep('ended')
  }
  // 저쪽에서 끝났으면(호스트가 회의 종료·내보냄) 끊김 오버레이가 아니라 종료 화면으로
  const handleLeaveRef = useRef(handleLeave)
  handleLeaveRef.current = handleLeave
  useEffect(() => {
    if (remoteEnded && step === 'room') void handleLeaveRef.current()
  }, [remoteEnded, step])

  /** 거절·실패·종료 → 다시 입장 화면(이름은 그대로) */
  function backToSetup() {
    requestId.current = null
    setPasswordError('')
    setStep('setup')
  }

  function handleSidebarToggle(tab: MeetingsSidebarTab) {
    if (sidebarOpen && sidebarTab === tab) {
      setSidebarOpen(false)
    } else {
      setSidebarTab(tab)
      setSidebarOpen(true)
    }
  }

  const onEnter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') void handleRequest() }

  let body: React.ReactNode
  if (step === 'loading') {
    /* 불러오는 중 */
    body = (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3" role="status">
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">{t('meetings.join.loadingRoom')}</p>
      </div>
    )
  } else if (step === 'setup' || step === 'waiting') {
    /* 입장(장치 + 이름·비밀번호) — 대기 중에도 미리보기를 살려 둔다. 참가 버튼이 잠기는 건 이름이 비었을 때만(이유는 버튼 아래) */
    const lock = guestJoinLock(true, nickname)
    body = (
      <MeetingsDeviceSetup
        ref={setupRef}
        roomName={roomInfo?.name || ''}
        meta={metaNode}
        subtitle={t('meetings.join.invitedSubtitle')}
        joinLabel={t('meetings.prejoin.requestJoin')}
        joinDisabled={!!lock}
        joinDisabledReason={lock ? t(lock) : undefined}
        busy={submitting}
        selfName={nickname.trim()}
        waiting={step === 'waiting'}
        waitingSince={waitingSince}
        onJoin={() => void handleRequest()}
        onCancel={handleCancel}
      >
        <UiInput
          modelValue={nickname}
          onUpdateModelValue={setNickname}
          label={t('meetings.join.displayName')}
          maxLength={30}
          autocomplete="nickname"
          placeholder={t('meetings.join.namePlaceholder')}
          hint={t('meetings.join.rememberHint')}
          disabled={step === 'waiting'}
          onKeyDown={onEnter}
        />
        {roomInfo?.requires_password && (
          <UiPasswordInput
            modelValue={password}
            onUpdateModelValue={setPassword}
            label={t('meetings.join.password')}
            autocomplete="off"
            placeholder={t('meetings.join.passwordPlaceholder')}
            error={passwordError}
            hint={t('meetings.join.passwordHint')}

            onKeyDown={onEnter}
          />
        )}
        <p className="text-[13px] text-muted-foreground">{t('meetings.join.approvalHint')}</p>
      </MeetingsDeviceSetup>
    )
  } else if (step === 'room') {
    /* 회의 참여 중 — 끊겨도 화면을 유지하고 오버레이만 띄운다 */
    body = (
      <div className="flex flex-col h-screen supports-[height:100dvh]:h-dvh relative">
        {/* 연결 상태 오버레이 */}
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
              <button
                onClick={() => void handleLeave()}
                className="px-4 py-1.5 text-sm rounded-md border border-border hover:bg-accent transition-colors"
              >
                {t('meetings.controls.leave')}
              </button>
            </div>
          </div>
        )}
        {/* 룸 헤더 */}
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border bg-background pt-[calc(0.5rem+env(safe-area-inset-top))]">
          <h2 className="font-semibold text-base truncate min-w-0">{currentRoomName}</h2>
          <span className="text-sm text-muted-foreground shrink-0">{participants.length}{t('meetings.room.participantCount')}</span>
        </div>

        {/* 메인 영역 */}
        <div className="relative flex flex-1 min-h-0 overflow-hidden">
          <MeetingsVideoGrid participants={participants} />

          {/* Safari 자동재생 차단 해제 */}
          {audioBlocked && (
            <button
              onClick={() => void unblockAudio()}
              className="absolute left-1/2 top-3 -translate-x-1/2 z-overlay px-4 py-2 text-sm font-medium rounded-full bg-primary text-primary-foreground shadow-lg"
            >
              {t('meetings.room.tapForAudio')}
            </button>
          )}

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
            sidebarOpen={sidebarOpen}
            sidebarTab={sidebarTab}
            onToggleCamera={() => void runMediaToggle('camera')}
            onToggleMic={() => void runMediaToggle('mic')}
            onToggleScreen={() => void runMediaToggle('screen')}
            onToggleBlur={() => void toggleBackgroundBlur()}
            onToggleNoise={() => void toggleNoiseCancellation()}
            onSetBackground={f => void setVirtualBackground(f)}
            onLeave={() => void handleLeave()}
            onToggleSidebar={handleSidebarToggle}
            onToggleDeviceMenu={() => setDeviceMenuOpen(!deviceMenuOpen)}
          />
        </div>
      </div>
    )
  } else if (step === 'invalid') {
    /* 링크 만료·잘못됨(D5a meetEnded) */
    body = (
      <MeetingsResultScreen icon="clock" tone="warning" title={t('meetings.join.expiredTitle')} description={expiredDesc}>
        <UiButton size="lg" className="h-12 w-full rounded-lg text-[15px] font-semibold" disabled={notifyState !== 'idle'} onClick={() => void notifyHost()}>
          {notifyState === 'sent' ? t('meetings.join.notifiedHost') : t('meetings.join.notifyHost')}
        </UiButton>
        {user
          ? <UiButton as="a" href="/meetings" variant="outline" size="lg" className="h-12 w-full rounded-lg bg-card text-[15px]">{t('meetings.listTitle')}</UiButton>
          : <UiButton as="a" href={`/login?redirect=${encodeURIComponent(route.fullPath)}`} variant="outline" size="lg" className="h-12 w-full rounded-lg bg-card text-[15px]">{t('common.login')}</UiButton>}
      </MeetingsResultScreen>
    )
  } else if (step === 'denied') {
    /* 입장 거절(D5b meetRejected) */
    body = (
      <MeetingsResultScreen icon="ban" tone="danger" title={t('meetings.join.deniedTitle')} description={deniedDesc}>
        <UiButton size="lg" className="h-12 w-full rounded-lg text-[15px] font-semibold" onClick={backToSetup}>{t('meetings.join.requestAgain')}</UiButton>
        <UiButton variant="outline" size="lg" className="h-12 w-full rounded-lg bg-card text-[15px]" onClick={closeTab}>{t('common.close')}</UiButton>
      </MeetingsResultScreen>
    )
  } else if (step === 'ended') {
    /* 회의에서 나옴(D5c meetOver) */
    const res = stats.result
    const range = res?.startedAt && res.endedAt ? `${hhmmOf(new Date(res.startedAt))}–${hhmmOf(new Date(res.endedAt))}` : undefined
    body = (
      <MeetingsResultScreen
        icon="video"
        tone="muted"
        title={t('meetings.endedTitle')}
        description={overDesc}
        aside={(
          <MeetingsEndSummary
            guest={!user}
            hostName={roomInfo?.host_name || undefined}
            participants={res?.participants}
            people={res?.people}
            chats={res?.chats}
            timeRange={range}
          />
        )}
      >
        {user
          ? (
            <>
              <UiButton as="a" href="/meetings" size="lg" className="h-12 w-full rounded-lg text-[15px] font-semibold">{t('meetings.join.toList')}</UiButton>
              <UiButton variant="outline" size="lg" className="h-12 w-full rounded-lg bg-card text-[15px]" onClick={backToSetup}>{t('meetings.rejoin')}</UiButton>
            </>
          )
          : <p className="text-sm text-muted-foreground">{t('meetings.room.endedDesc')}</p>}
      </MeetingsResultScreen>
    )
  } else if (step === 'wrongpw') {
    /* 비밀번호 틀림(D5d meetWrongPw) — 입력 + 아래 오류 */
    body = (
      <MeetingsResultScreen
        icon="clock"
        tone="warning"
        header={t('meetings.join.resultHeaderJoin')}
        title={roomInfo?.name || t('meetings.join.header')}
        description={t('meetings.join.needsPassword')}
      >
        <form className="flex flex-col gap-2.5" onSubmit={(e: FormEvent) => { e.preventDefault(); void handleRequest() }}>
          <UiPasswordInput
            modelValue={password}
            onUpdateModelValue={(v) => { setPassword(v); setPasswordError('') }}
            label={t('meetings.join.password')}
            size="lg"
            autocomplete="off"
            error={passwordError}
          />
          <UiButton type="submit" size="lg" className="mt-1 h-12 w-full rounded-lg text-[15px] font-semibold" disabled={!password || submitting || attemptsLeft === 0}>
            {submitting ? t('meetings.join.requesting') : t('common.retry')}
          </UiButton>
        </form>
      </MeetingsResultScreen>
    )
  } else {
    /* 그 밖의 실패(정보 조회·신청·입장) */
    body = (
      <MeetingsResultScreen icon="alert-triangle" tone="danger" title={t('meetings.join.enterFail')} description={errorMsg}>
        <UiButton size="lg" className="h-12 w-full rounded-lg text-[15px] font-semibold" onClick={() => { if (roomInfo) backToSetup(); else void loadInfo() }}>{t('common.retry')}</UiButton>
      </MeetingsResultScreen>
    )
  }

  return <div className="min-h-dvh bg-background text-foreground">{body}</div>
}
