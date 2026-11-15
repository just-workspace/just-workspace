/**
 * 미니 통화 창. Vue 판 components/layout/MiniCall.vue 에서 출발.
 *  데스크톱: 오른쪽 아래 320(여백 24) 떠 있는 창, 네 귀퉁이 스냅(끌어 놓기). z-mini-call — 메일 작성 창이 비켜 선다(오른쪽 아래일 때만).
 *   · 영상 없음 = 높이 56 알약: 점 · 이름 + 경과 / 화자 · 인원 · [마이크][펼치기][나가기 danger]. 알약 아무 데나 눌러도 펼침.
 *   · 영상 있음 = 180 타일 + [마이크][카메라][화면 공유][펼치기] … [나가기]. 화면 공유 중 = 공유 버튼 채움(solid) + aria-pressed,
 *     툴팁 "화면 공유 멈추기", 영상 위 "내 화면을 공유하는 중".
 *   · 재연결 = warning 점·테두리 "다시 연결하는 중…"(role=status). 끊김 = danger "연결이 끊겼습니다" + [다시 참여] + 닫기(role=alert).
 *   · 호스트 대기실 요청 띠(창 위, primary/10): 아바타 · "○○ 님이 들어오려고 합니다" · +n · [들이기][거절] · 대기실 전체.
 *     새 신청마다 소리 1회(활동 패널 기록은 서버 알림). 30초 응답 없으면 띠를 접고 펼치기 버튼에 점 배지만.
 *   · 나가면 토스트 "#개발 통화에서 나왔습니다 · 12분 · 아직 3명" [다시 참여](6초), 마지막 사람이면 "통화가 끝났습니다 · 12분".
 *  모바일:   상태 표시줄 아래 36px 초록 띠 "#개발 통화 중 · 12:43  돌아가기 ›" — 탭하면 회의 화면으로.
 * 회의 화면이 내려가 있으므로 다른 참가자 소리도 여기서 붙인다(안 그러면 미니 창 상태에서 소리가 안 난다).
 * 셸(layouts/default)이 useMeetingCall().visible 일 때만 띄운다.
 */
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { cn } from '~/lib/utils'
import { getUiZoom } from '~/composables/useViewport'
import { useI18n } from '~/i18n'
import { navigateTo } from '~/lib/router'
import { useMeetings, approveRequest, denyRequest, fetchPendingRequests, joinRoom } from '~/composables/useMeetings'
import { meetingCallStore, setCorner, setLastSpeaker, setReturnPath, setRoomPanel, useMeetingCall } from '~/composables/useMeetingCall'
import { setMiniCallWidth } from '~/composables/useShell'
import { useChat } from '~/composables/useChat'
import { addToast, toast } from '~/composables/useToast'
import { useMeetingSessionStats } from '~/composables/useMeetingSessionStats'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiButton } from '~/components/ui/Button'
import { UiStatusDot } from '~/components/ui/StatusDot'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiBadge } from '~/components/ui/Badge'
import { UiTrans } from '~/components/ui/Trans'
import { MeetingsTrackMedia } from '~/components/meetings/MeetingsTrackMedia'
import {
  MINI_CALL_LOBBY_COLLAPSE_MS, MINI_CALL_WIDTH, currentRemoteSpeaker, formatCallElapsed, miniCallCornerStyle, miniCallHasVideo,
  miniCallLeaveSummary, miniCallReservedWidth, miniCallTone, nearestMiniCallCorner, newLobbyIds, pickMiniCallSpotlight,
} from '~/utils/miniCall'

export interface LayoutMiniCallProps {
  /** true 면 모바일 36px 초록 띠, false 면 데스크톱 떠 있는 창 */
  mobile: boolean
}

/** 대기실 신청 알림음 1회(두 음 짧게). 소리를 못 내는 환경이면 조용히 넘어간다 */
function playLobbyChime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const t0 = ctx.currentTime
    ;[880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = f
      g.gain.setValueAtTime(0.0001, t0 + i * 0.16)
      g.gain.exponentialRampToValueAtTime(0.18, t0 + i * 0.16 + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.16 + 0.22)
      o.connect(g).connect(ctx.destination)
      o.start(t0 + i * 0.16)
      o.stop(t0 + i * 0.16 + 0.24)
    })
    setTimeout(() => { void ctx.close() }, 800)
  } catch { /* 소리 없이 */ }
}

/** 미니 통화 창 — 통화 중 다른 화면에 있을 때 셸이 띄운다 */
export function LayoutMiniCall({ mobile }: LayoutMiniCallProps) {
  const { t } = useI18n()
  const {
    participants, currentRoomName, connectionState, isHost, pendingRequests,
    cameraEnabled, micEnabled, screenShareEnabled, callStartedAt,
    toggleMic, toggleCamera, toggleScreenShare, leaveRoom,
  } = useMeetings()
  const { corner, lastSpeaker, expand, returnPath } = useMeetingCall()
  const { channels, getDMDisplayName } = useChat()
  // 회의 화면과 같은 통계(key 공유) — 미니 창에서 나가도 "n분"을 알 수 있게, 그동안 본 최대 참가자 수도 이어서 센다
  const stats = useMeetingSessionStats(() => participants.length, 'meetings-call-stats')

  // 채널 통화(chan-<id>)는 방 이름 대신 "#채널"·DM 상대 이름으로
  const callName = (() => {
    const n = currentRoomName || ''
    if (n.startsWith('chan-')) {
      const c = channels.find(x => x.id === n.slice(5))
      if (c) return c.type === 'dm' ? getDMDisplayName(c) : `#${c.name}`
    }
    return n || t('meetings.mini.fallbackName')
  })()

  // 경과 시간 — 1초마다
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => clearInterval(tick)
  }, [])
  const elapsed = formatCallElapsed(callStartedAt ? now - callStartedAt : 0)

  // 비출 사람 — 말하는 사람이 바뀌면 그 사람으로, 조용해지면 마지막 화자를 붙들고 있는다
  const speaker = currentRemoteSpeaker(participants)
  const speakerId = speaker?.identity ?? null
  useEffect(() => { if (speakerId) setLastSpeaker(speakerId) }, [speakerId])
  const spot = pickMiniCallSpotlight(participants, lastSpeaker)
  const hasVideo = miniCallHasVideo(spot)
  const spotTrack = spot?.screenTrack ?? spot?.videoTrack ?? null
  const remoteAudio = participants.filter(p => !p.isLocal && p.audioTrack)

  const tone = miniCallTone(connectionState)
  const subline = speaker
    ? `${t('meetings.mini.speaking', { name: speaker.name })} · ${t('meetings.mini.people', { n: participants.length })}`
    : t('meetings.mini.people', { n: participants.length })

  async function leave() {
    // 돌아갈 경로를 먼저 지운다 — 셸이 "상대가 끝냈다" 안내와 구분한다(layouts/default)
    const back = meetingCallStore.getState().returnPath
    const name = callName
    const others = participants.filter(p => !p.isLocal).length
    setReturnPath(null)
    const r = stats.stop()
    await leaveRoom()
    const s = miniCallLeaveSummary(others, r?.minutes ?? null)
    if (s.ended) {
      toast({ type: 'info', title: s.minutes ? t('meetings.mini.endedMin', { min: s.minutes }) : t('meetings.mini.ended') })
    } else {
      toast({
        type: 'info',
        title: t('meetings.mini.leftTitle', { name }),
        description: s.minutes ? t('meetings.mini.leftDesc', { min: s.minutes, n: s.others }) : t('meetings.mini.leftDescNoMin', { n: s.others }),
        action: back ? { label: t('meetings.rejoin'), onClick: () => { void navigateTo(back) } } : undefined,
      })
    }
  }

  /** 끊김 → [다시 참여]: 같은 방에 바로 다시 붙는다. 외부 토큰으로 들어온 방은 회의 화면에서 다시 시도 */
  async function rejoin() {
    const name = currentRoomName
    if (!name || (returnPath && /[?&]t=/.test(returnPath))) { void expand(); return }
    try {
      await joinRoom(name, { cameraEnabled, micEnabled })
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('meetings.join.joinFail'))
    }
  }

  /** 끊김 → 닫기: 세션을 끝내고 창을 내린다(토스트 없음) */
  async function dismiss() {
    setReturnPath(null)
    stats.stop()
    await leaveRoom()
  }

  async function safe(fn: () => Promise<void>) {
    try { await fn() } catch (e) { console.warn('[mini-call] 컨트롤 실패', e) }
  }

  // ── 호스트 대기실 — 회의 화면이 내려가 있어도 신청을 받는다 ──
  useEffect(() => {
    if (!isHost) return
    void fetchPendingRequests()
    const id = setInterval(() => { void fetchPendingRequests() }, 1500)
    return () => clearInterval(id)
  }, [isHost])
  const pending = isHost ? pendingRequests : []
  const seenLobby = useRef<Set<string>>(new Set())
  const [lobbyCollapsed, setLobbyCollapsed] = useState(false)
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingKey = pending.map(r => r.id).join(',')
  useEffect(() => {
    const fresh = newLobbyIds(seenLobby.current, pending)
    fresh.forEach(id => seenLobby.current.add(id))
    if (fresh.length) {
      playLobbyChime()
      setLobbyCollapsed(false)
      if (collapseTimer.current) clearTimeout(collapseTimer.current)
      collapseTimer.current = setTimeout(() => { setLobbyCollapsed(true) }, MINI_CALL_LOBBY_COLLAPSE_MS)
    }
    if (!pending.length && collapseTimer.current) { clearTimeout(collapseTimer.current); collapseTimer.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey])
  useEffect(() => () => { if (collapseTimer.current) clearTimeout(collapseTimer.current) }, [])
  const lobbyHead = pending[0] ?? null
  const showLobby = !mobile && !!lobbyHead && !lobbyCollapsed
  const lobbyDot = !mobile && pending.length > 0 && lobbyCollapsed
  const [lobbyBusy, setLobbyBusy] = useState(false)
  async function answerLobby(ok: boolean) {
    if (!lobbyHead) return
    setLobbyBusy(true)
    try { await (ok ? approveRequest(lobbyHead.id) : denyRequest(lobbyHead.id)) } catch (e: any) {
      addToast('error', e?.data?.detail || t('meetings.mini.lobbyFail'))
      void fetchPendingRequests()
    } finally { setLobbyBusy(false) }
  }
  function openLobby() {
    setRoomPanel('participants')
    void expand()
  }

  // ── 데스크톱 창: 끌어 놓으면 가장 가까운 귀퉁이로 붙는다 ──
  const root = useRef<HTMLDivElement | null>(null)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const start = useRef({ x: 0, y: 0 })
  const moved = useRef(false)
  const downOn = useRef<HTMLElement | null>(null)
  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (mobile || e.button !== 0) return
    downOn.current = e.target as HTMLElement
    if ((e.target as HTMLElement).closest('button')) return
    start.current = { x: e.clientX, y: e.clientY }
    moved.current = false
    dragRef.current = { x: 0, y: 0 }
    setDrag(dragRef.current)
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return
    const dx = e.clientX - start.current.x
    const dy = e.clientY - start.current.y
    if (Math.abs(dx) + Math.abs(dy) > 4) moved.current = true
    // 포인터 좌표는 화면 좌표(배율 적용 뒤) — translate 는 CSS px 라 배율로 나눈다
    const z = getUiZoom()
    dragRef.current = { x: dx / z, y: dy / z }
    setDrag(dragRef.current)
  }
  function onPointerUp() {
    if (!dragRef.current) return
    if (moved.current && root.current) {
      const r = root.current.getBoundingClientRect()
      setCorner(nearestMiniCallCorner(r.left + r.width / 2, r.top + r.height / 2, window.innerWidth, window.innerHeight))
    }
    dragRef.current = null
    setDrag(null)
  }
  /** 알약 아무 데나 누르면 펼친다(버튼·대기실 띠·끌기는 빼고).
   *  끌기용 포인터 캡처 때문에 click 은 창 루트로 오므로 누른 자리(pointerdown 대상)로 가린다 */
  function onPillClick(e: ReactMouseEvent<HTMLDivElement>) {
    if (moved.current) { moved.current = false; return }
    const at = downOn.current ?? (e.target as HTMLElement)
    if (at.closest('button') || at.closest('[data-mini-lobby]') || (e.target as HTMLElement).closest('button')) return
    void expand()
  }
  const windowStyle: CSSProperties = {
    ...miniCallCornerStyle(corner),
    width: `${MINI_CALL_WIDTH}px`,
    ...(drag ? { transform: `translate(${drag.x}px, ${drag.y}px)` } : {}),
  }

  // 메일 작성 창이 비켜 설 폭(오른쪽 아래일 때만, 통화 창 폭 + 16) — 떠 있는 동안만
  useEffect(() => {
    setMiniCallWidth(miniCallReservedWidth({ visible: true, mobile, corner }))
  }, [mobile, corner])
  useEffect(() => () => { setMiniCallWidth(0) }, [])

  const micBtn = (
    <UiIconButton
      size="md" variant="muted"
      label={micEnabled ? t('meetings.controls.micOff') : t('meetings.controls.micOn')}
      icon={micEnabled ? 'mic' : 'mic-slash'}
      onClick={() => { void safe(toggleMic) }}
    />
  )
  const expandBtn = (
    <UiIconButton
      size="md" variant="muted"
      label={lobbyDot ? `${t('meetings.mini.expand')} · ${t('meetings.mini.lobbyWaiting', { n: pending.length })}` : t('meetings.mini.expand')}
      onClick={() => { void expand() }}
    >
      <UiIcon name="maximize-2" />
      {lobbyDot && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-muted" aria-hidden="true" />}
    </UiIconButton>
  )
  const leaveIconBtn = (
    <UiIconButton
      size="md" variant="solid" icon="log-out" label={t('meetings.controls.leave')}
      className="bg-danger text-background hover:bg-danger/90"
      onClick={() => { void leave() }}
    />
  )

  // 끊김은 영상이 멈춰 있으므로 늘 알약으로
  const pill = !hasVideo || tone === 'lost'

  return (
    <>
      {/* 다른 참가자 소리 — 회의 화면이 내려가 있는 동안 여기서 낸다 */}
      <div className="hidden" aria-hidden="true">
        {remoteAudio.map(p => <MeetingsTrackMedia key={p.identity} kind="audio" track={p.audioTrack} />)}
      </div>

      {mobile ? (
        /* 모바일: 상태 표시줄 아래 36 초록 띠(시각 36, 누르는 영역은 위아래 2씩 넓혀 40) */
        <button
          type="button"
          aria-label={t('meetings.mini.bandAria')}
          className={cn(
            "relative flex h-9 w-full shrink-0 items-center gap-2 px-4 text-[13px] font-semibold text-background before:absolute before:inset-x-0 before:-inset-y-0.5 before:content-['']",
            tone === 'live' ? 'bg-success' : tone === 'lost' ? 'bg-danger' : 'bg-warning',
          )}
          onClick={() => { void expand() }}
        >
          <UiIcon name="mic" className="h-[15px] w-[15px] shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">
            {tone === 'live'
              ? <>{t('meetings.mini.bandLabel', { name: callName })} · <span className="font-mono">{elapsed}</span></>
              : <>{callName} · {tone === 'lost' ? t('meetings.mini.lost') : t('meetings.mini.reconnecting')}</>}
          </span>
          <span className="flex shrink-0 items-center">{t('meetings.mini.bandBack')}<UiIcon name="chevron-right" className="h-4 w-4" /></span>
        </button>
      ) : (
        /* 데스크톱: 떠 있는 창 */
        <div
          ref={root}
          role="region"
          aria-label={t('meetings.mini.region', { name: callName })}
          className={cn(
            'fixed z-mini-call touch-none select-none overflow-hidden border bg-card shadow-lg',
            pill && !showLobby ? 'rounded-full' : 'rounded-lg',
            tone === 'reconnecting' ? 'border-warning/50' : tone === 'lost' ? 'border-danger/50' : 'border-border',
            drag ? 'cursor-grabbing' : 'cursor-grab',
          )}
          style={windowStyle}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClick={pill && tone !== 'lost' ? onPillClick : undefined}
        >
          {/* 호스트 대기실 요청 띠 */}
          {showLobby && lobbyHead && (
            <div role="alert" data-mini-lobby="" className="flex flex-col gap-2 border-b border-border bg-primary/10 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <UiAvatar fallback={(lobbyHead.nickname || '?').charAt(0)} alt={lobbyHead.nickname} textSize={10} className="h-6 w-6" />
                <UiTrans
                  k="meetings.mini.lobbyAsk"
                  as="span"
                  className="min-w-0 flex-1 text-[13px]"
                  slots={{ name: <b className="font-semibold">{lobbyHead.nickname}</b> }}
                />
                {pending.length > 1 && <UiBadge tone="primary" size={18}>+{pending.length - 1}</UiBadge>}
              </div>
              <div className="flex gap-1.5">
                <UiButton size="xs" className="flex-1" disabled={lobbyBusy} onClick={() => void answerLobby(true)}>{t('meetings.mini.lobbyAdmit')}</UiButton>
                <UiButton variant="outline" size="xs" className="flex-1" disabled={lobbyBusy} onClick={() => void answerLobby(false)}>{t('meetings.mini.lobbyDeny')}</UiButton>
                <UiIconButton icon="users" variant="muted" label={t('meetings.mini.lobbyAll', { n: pending.length })} onClick={openLobby} />
              </div>
            </div>
          )}

          {pill ? (
            /* 영상 없음(또는 끊김): 높이 56 알약 */
            <div className="flex h-14 items-center gap-2 pl-4 pr-2">
              <UiStatusDot status={tone === 'live' ? 'live' : tone === 'lost' ? 'failed' : 'connecting'} size={8} />
              {tone === 'live' ? (
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="truncate text-[13px] font-semibold">{callName} <span className="font-mono font-medium text-muted-foreground">{elapsed}</span></div>
                  <div className="truncate text-[11px] text-muted-foreground">{subline}</div>
                </div>
              ) : (
                <div role={tone === 'lost' ? 'alert' : 'status'} className="min-w-0 flex-1 leading-tight">
                  <div className="truncate text-[13px] font-semibold">{tone === 'lost' ? t('meetings.mini.lost') : t('meetings.mini.reconnecting')}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{callName} · {tone === 'lost' ? t('meetings.mini.lostSub') : t('meetings.mini.reconnectingSub')}</div>
                </div>
              )}
              {tone === 'live' && micBtn}
              {tone === 'lost' ? (
                <>
                  <UiButton size="xs" onClick={() => void rejoin()}>{t('meetings.rejoin')}</UiButton>
                  <UiIconButton size="md" variant="muted" icon="close" label={t('common.close')} onClick={() => void dismiss()} />
                </>
              ) : (
                <>
                  {expandBtn}
                  {leaveIconBtn}
                </>
              )}
            </div>
          ) : (
            /* 영상 있음: 180 타일 + 컨트롤 줄 */
            <>
              <div className="relative h-[180px] bg-stage">
                <MeetingsTrackMedia kind="video" track={spotTrack} contain={!!spot?.screenTrack} />
                {tone === 'reconnecting' ? (
                  <span role="status" className="absolute left-2.5 top-2.5 flex items-center gap-1.5 rounded-sm bg-[hsl(var(--scrim)/0.7)] text-foreground px-2 py-0.5 text-[11px] font-semibold">
                    <UiStatusDot status="connecting" size={8} />{t('meetings.mini.reconnecting')}
                  </span>
                ) : screenShareEnabled && (
                  <span className="absolute left-2.5 top-2.5 flex items-center gap-1.5 rounded-sm bg-[hsl(var(--scrim)/0.7)] text-foreground px-2 py-0.5 text-[11px] font-semibold">
                    <UiIcon name="monitor" className="h-3 w-3 text-primary" />{t('meetings.mini.sharingMine')}
                  </span>
                )}
                <span className="absolute bottom-2.5 left-2.5 max-w-[calc(100%-20px)] truncate rounded-sm bg-[hsl(var(--scrim)/0.7)] text-foreground px-2 py-0.5 text-[11px] font-semibold">
                  {callName} · <span className="font-mono">{elapsed}</span>
                </span>
              </div>
              <div className="flex items-center gap-1.5 p-2">
                {micBtn}
                <UiIconButton
                  size="md" variant="muted"
                  label={cameraEnabled ? t('meetings.controls.cameraOff') : t('meetings.controls.cameraOn')}
                  icon={cameraEnabled ? 'video' : 'video-slash'}
                  onClick={() => { void safe(toggleCamera) }}
                />
                <UiIconButton
                  size="md"
                  variant={screenShareEnabled ? 'solid' : 'muted'}
                  className={screenShareEnabled ? 'text-primary-foreground' : ''}
                  label={screenShareEnabled ? t('meetings.mini.screenStop') : t('meetings.mini.screenShare')}
                  icon="monitor"
                  pressed={screenShareEnabled}
                  onClick={() => { void safe(toggleScreenShare) }}
                />
                {expandBtn}
                <span className="flex-1" />
                <UiButton variant="danger" onClick={() => { void leave() }}>{t('meetings.controls.leave')}</UiButton>
              </div>
            </>
          )}
        </div>
      )}
    </>
  )
}

export default LayoutMiniCall
