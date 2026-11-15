/**
 * 원격 데스크톱 뷰어 — 세션 하나를 화면 전체 위층에 띄운다.
 *
 * 상태: B 상대 승인 대기(30초 카운트다운·요청 취소) → A 연결 중 → 연결됨(+C 품질 저하 · D 보안 화면)
 *       → E 끊김 재연결(최대 5회, 지금 다시 연결) / F 거부·응답 없음 / 종료.
 * 입력: 원격 화면을 누르면 키보드·마우스를 원격으로 잡는다(Ctrl+Alt+Shift 로 빠져나옴). 전체 화면이면 Keyboard Lock API 로
 *       브라우저 단축키(Esc·Alt+Tab 일부·Ctrl+W 등)까지 넘긴다(지원 브라우저만). 이동은 lossy, 나머지는 reliable.
 * 보안: 뷰어 토큰은 송출 금지(구독+데이터), 상대 정체성에서 온 메시지만 받는다. 호스트가 다시 검증·속도 제한한다.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Room, RoomEvent, Track, type Participant, type RemoteTrack, type RemoteVideoTrack } from 'livekit-client'
import { UiButton, UiIcon, UiIconButton, UiMenu, UiStatusDot, UiTooltip, addToast } from '@jw/ui'
import type { RemoteApi, RemoteLivekit } from './api'
import { fmtDuration, hasKey, type T } from './i18n'
import { decodeHost, encode, fmtRate, isLossy, isReleaseCombo, keyMsg, mouseButton, pointerToRatio, QUALITY_MODES, qualityOf, summarizeStats, TOPIC, wheel, type HostMsg, type QualityMode, type SpecialKey, type StreamStats, type ViewerMsg } from './protocol'

/** 고른 화질은 이 브라우저에 기억한다(다음 접속에도) */
const Q_KEY = 'rd.quality'
function savedMode(): QualityMode {
  try { const v = localStorage.getItem(Q_KEY); return v === 'sharp' || v === 'smooth' ? v : 'auto' } catch { return 'auto' }
}

type Phase = 'awaiting' | 'connecting' | 'live' | 'reconnecting' | 'denied' | 'ended' | 'failed'

export interface ViewerRequest { sessionId: string; title: string }

const MAX_RETRY = 5
const RETRY_DELAY_S = [2, 4, 6, 8, 10]
const STAGE_BG = 'hsl(var(--stage))'

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center', maxWidth: 360 }}>{children}</div>
    </div>
  )
}
const title16: React.CSSProperties = { fontSize: 16, lineHeight: '24px', fontWeight: 600 }
const sub13: React.CSSProperties = { fontSize: 13, lineHeight: '20px', color: 'hsl(var(--muted-foreground))' }
const mono: React.CSSProperties = { fontFamily: "'JetBrains Mono', ui-monospace, monospace" }

export function RemoteViewer({ api, t, request, onClose }: { api: RemoteApi; t: T; request: ViewerRequest; onClose: () => void }) {
  const { sessionId, title } = request
  const [phase, setPhase] = useState<Phase>('awaiting')
  const [left, setLeft] = useState(30)
  const [fit, setFit] = useState(true)
  const [stats, setStats] = useState<StreamStats | null>(null)
  const prevStats = useRef<StreamStats | null>(null)
  const [qPanel, setQPanel] = useState(false)
  const [mode, setMode] = useState<QualityMode>(savedMode)
  /** 호스트가 화질 모드를 아는가(info.q 가 왔나). null = 아직 모름, false = 옛 호스트 */
  const [hostQ, setHostQ] = useState<boolean | null>(null)
  const [hostState, setHostState] = useState<'ok' | 'secure_desktop' | 'paused'>('ok')
  const [mons, setMons] = useState<Array<{ i: number; name: string }>>([])
  const [curMon, setCurMon] = useState(0)
  const [hostClip, setHostClip] = useState<string | null>(null)
  const [captured, setCaptured] = useState(false)
  const [retry, setRetry] = useState({ n: 0, s: 0 })
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const roomRef = useRef<Room | null>(null)
  const peerRef = useRef('')
  const trackRef = useRef<RemoteVideoTrack | null>(null)
  const heldKeys = useRef<Set<string>>(new Set())
  const pendingMove = useRef<{ x: number; y: number } | null>(null)
  const rafRef = useRef<number | null>(null)
  const closingRef = useRef(false)
  const retryTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollStop = useRef(false)

  const send = useCallback((msg: ViewerMsg) => {
    const room = roomRef.current
    if (!room || !peerRef.current) return
    void room.localParticipant.publishData(encode(msg), {
      reliable: !isLossy(msg), topic: TOPIC, destinationIdentities: [peerRef.current],
    }).catch(() => { /* 끊기는 중 */ })
  }, [])

  const releaseKeys = useCallback(() => {
    for (const c of heldKeys.current) send({ t: 'ku', c })
    heldKeys.current.clear()
  }, [send])

  const uncapture = useCallback(() => {
    releaseKeys()
    setCaptured(false)
    try { (navigator as unknown as { keyboard?: { unlock(): void } }).keyboard?.unlock() } catch { /* 없음 */ }
  }, [releaseKeys])

  /** 세션 끝내기(서버·방) — 끊기·취소·홈으로 모두 여기로 */
  const finish = useCallback(async (close: boolean) => {
    if (!closingRef.current) {
      closingRef.current = true
      pollStop.current = true
      if (retryTimer.current) clearInterval(retryTimer.current)
      releaseKeys()
      try { await api.end(sessionId) } catch { /* 이미 끝남 */ }
      try { await roomRef.current?.disconnect() } catch { /* 무시 */ }
    }
    if (close) onClose()
  }, [api, onClose, releaseKeys, sessionId])

  // ── 연결 ──
  const connect = useCallback(async (): Promise<boolean> => {
    let info: RemoteLivekit | undefined
    let status = ''
    try {
      const r = await api.session(sessionId, true)
      info = r.livekit
      status = r.session.status
    } catch { /* 아래 */ }
    if (!info) {
      if (status === 'ended' || status === 'expired' || status === 'denied') setPhase('ended')
      return false
    }
    peerRef.current = info.peer_identity
    try { await roomRef.current?.disconnect() } catch { /* 이전 방 */ }
    const room = new Room({ adaptiveStream: false, dynacast: false })
    roomRef.current = room
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: Participant) => {
      if (participant.identity !== peerRef.current || track.kind !== Track.Kind.Video) return
      trackRef.current = track as RemoteVideoTrack
      if (videoRef.current) track.attach(videoRef.current)
      setPhase('live')
    })
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      track.detach()
      if (trackRef.current === track) trackRef.current = null
    })
    room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: Participant, _k?: unknown, topic?: string) => {
      if (topic !== TOPIC || participant?.identity !== peerRef.current) return
      const m: HostMsg | null = decodeHost(payload)
      if (!m) return
      if (m.t === 'info') { setMons(m.mons); setCurMon(m.cur); setHostQ(m.q != null) }
      else if (m.t === 'q') setHostQ(true)
      else if (m.t === 'clip') void navigator.clipboard.writeText(m.text).then(() => addToast('success', t('clip.copied')), () => setHostClip(m.text))
      else if (m.t === 'state') setHostState(m.s)
      else if (m.t === 'err') addToast('warning', hasKey(`err.${m.code}`) ? t(`err.${m.code}`) : t('err.generic'))
    })
    room.on(RoomEvent.ParticipantDisconnected, (p: Participant) => {
      if (p.identity === peerRef.current && !closingRef.current) void lost()
    })
    room.on(RoomEvent.Disconnected, () => {
      if (!closingRef.current && roomRef.current === room) void lost()
    })
    try {
      await room.connect(info.ws_url, info.token, { autoSubscribe: true, peerConnectionTimeout: 30_000, websocketTimeout: 30_000 })
      return true
    } catch {
      return false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, sessionId, t])

  // ── E: 끊김 → 재연결(최대 5회) ──
  const attempt = useRef<(n: number) => void>(() => {})
  const lost = useCallback(async () => {
    uncapture()
    attempt.current(1)
  }, [uncapture])
  attempt.current = (n: number) => {
    if (closingRef.current) return
    if (retryTimer.current) clearInterval(retryTimer.current)
    if (n > MAX_RETRY) { setPhase('failed'); return }
    setPhase('reconnecting')
    let s = RETRY_DELAY_S[n - 1] ?? 10
    setRetry({ n, s })
    retryTimer.current = setInterval(() => {
      s -= 1
      setRetry({ n, s: Math.max(0, s) })
      if (s <= 0) {
        if (retryTimer.current) clearInterval(retryTimer.current)
        void reconnectNow(n)
      }
    }, 1000)
  }
  const reconnectNow = async (n: number) => {
    if (retryTimer.current) clearInterval(retryTimer.current)
    setPhase('connecting')
    const ok = await connect()
    if (!ok && !closingRef.current) {
      const r = await api.session(sessionId).catch(() => null)
      if (r && r.session.status !== 'active') { setPhase(r.session.status === 'ended' ? 'ended' : 'denied'); return }
      attempt.current(n + 1)
    }
  }

  // ── B: 승인 대기 → 활성/거부 ──
  useEffect(() => {
    pollStop.current = false
    let alive = true
    ;(async () => {
      for (;;) {
        if (!alive || pollStop.current) return
        let s
        try { s = (await api.session(sessionId)).session } catch { await new Promise(r => setTimeout(r, 1500)); continue }
        if (s.status === 'pending' || s.status === 'waiting_code') {
          const until = s.expires_at ? new Date(s.expires_at).getTime() : Date.now()
          setLeft(Math.max(0, Math.round((until - Date.now()) / 1000)))
          await new Promise(r => setTimeout(r, 1000))
          continue
        }
        if (s.status === 'active') {
          setPhase('connecting')
          const ok = await connect()
          if (!ok && alive) attempt.current(1)
          return
        }
        setPhase(s.status === 'ended' ? 'ended' : 'denied')
        return
      }
    })()
    return () => {
      alive = false
      void finish(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // ── C: 연결 품질·화면 정보(2초) — 비트레이트·손실은 직전 표본과의 차이 ──
  useEffect(() => {
    if (phase !== 'live') return
    prevStats.current = null
    const id = setInterval(async () => {
      const tr = trackRef.current
      if (!tr) return
      try {
        const rep = await tr.getRTCStatsReport()
        const rows: Array<Record<string, unknown>> = []
        rep?.forEach((v: Record<string, unknown>) => { rows.push(v) })
        const st = summarizeStats(rows, prevStats.current, Date.now())
        prevStats.current = st
        setStats(st)
      } catch { /* 통계 없음 */ }
    }, 2000)
    return () => clearInterval(id)
  }, [phase])

  // ── 입력 ──
  const ratio = (e: { clientX: number; clientY: number }) => {
    const v = videoRef.current
    if (!v || !v.videoWidth) return null
    const r = v.getBoundingClientRect()
    return pointerToRatio(e.clientX, e.clientY, r, { width: v.videoWidth, height: v.videoHeight })
  }
  const flushMove = () => {
    rafRef.current = null
    const p = pendingMove.current
    pendingMove.current = null
    if (p) send({ t: 'mm', ...p })
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (phase !== 'live') return
    const p = ratio(e)
    if (!p) return
    pendingMove.current = p
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(flushMove)
  }
  const onPointer = (down: boolean) => (e: React.PointerEvent) => {
    if (phase !== 'live') return
    const b = mouseButton(e.button)
    const p = ratio(e)
    if (b == null || !p) return
    e.preventDefault()
    if (down) {
      stageRef.current?.focus()
      ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
      if (!captured) {
        setCaptured(true)
        if (document.fullscreenElement) {
          try { void (navigator as unknown as { keyboard?: { lock(): Promise<void> } }).keyboard?.lock() } catch { /* 미지원 */ }
        }
      }
    }
    send({ t: down ? 'md' : 'mu', b, ...p })
  }
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => { if (phase === 'live') { e.preventDefault(); send(wheel(e.deltaX, e.deltaY, e.deltaMode)) } }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [send, phase])
  // 잡힌 동안은 창 전체에서 키를 가로챈다(브라우저 단축키 충돌 최소화). Ctrl+Alt+Shift 로 푼다
  useEffect(() => {
    if (!captured) return
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      if (down && isReleaseCombo(e)) { e.preventDefault(); uncapture(); return }
      const m = keyMsg(down, e.code)
      e.preventDefault()
      e.stopPropagation()
      if (!m) return
      if (down) heldKeys.current.add(e.code)
      else heldKeys.current.delete(e.code)
      send(m)
    }
    const kd = onKey(true), ku = onKey(false)
    const blur = () => releaseKeys()
    window.addEventListener('keydown', kd, true)
    window.addEventListener('keyup', ku, true)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', kd, true)
      window.removeEventListener('keyup', ku, true)
      window.removeEventListener('blur', blur)
    }
  }, [captured, releaseKeys, send, uncapture])

  const sendClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) { send({ t: 'clip', text }); addToast('success', t('clip.sent')) }
    } catch {
      addToast('error', t('clip.readFailed'))
    }
  }
  const takeHostClip = async () => {
    if (hostClip == null) return
    try { await navigator.clipboard.writeText(hostClip); addToast('success', t('clip.copied')) } catch { /* 권한 */ }
    setHostClip(null)
  }
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) void rootRef.current?.requestFullscreen?.()
    else void document.exitFullscreen()
  }
  const special = (k: SpecialKey) => send({ t: 'sk', k })

  // ── 화질 모드 → 호스트(연결을 끊지 않고 인코더만 바뀐다). 보는 창 크기도 보내 작은 창이면 줄여 받는다 ──
  const sendRef = useRef(send)
  sendRef.current = send
  useEffect(() => {
    if (phase !== 'live' || !hostQ) return
    const push = () => {
      const el = stageRef.current
      const dpr = window.devicePixelRatio || 1
      const vw = fit && el ? Math.round(el.clientWidth * dpr) : 0
      const vh = fit && el ? Math.round(el.clientHeight * dpr) : 0
      sendRef.current({ t: 'q', m: mode, vw, vh })
    }
    push()
    const el = stageRef.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => { if (timer) clearTimeout(timer); timer = setTimeout(push, 600) })
    ro.observe(el)
    return () => { ro.disconnect(); if (timer) clearTimeout(timer) }
  }, [phase, hostQ, mode, fit])
  const chooseMode = (m: QualityMode) => {
    setMode(m)
    try { localStorage.setItem(Q_KEY, m) } catch { /* noop */ }
  }

  const quality = qualityOf(stats?.rtt ?? null, stats?.fps ?? null)
  const qualityText = [fmtRate(stats?.kbps ?? null), stats?.fps != null ? `${stats.fps} fps` : null, stats?.rtt != null ? `${stats.rtt} ms` : null].filter(Boolean).join(' · ')
  const pathText = !stats?.path ? '—' : stats.path.startsWith('relay-') ? t('q.path.relay', { p: stats.path.slice(6).toUpperCase() }) : stats.path === 'udp' ? t('q.path.udp') : stats.path === 'tcp' ? t('q.path.tcp') : stats.path
  const infoRows: Array<[string, string]> = [
    [t('q.rate'), fmtRate(stats?.kbps ?? null) ?? '—'],
    [t('q.fps'), stats?.fps != null ? `${stats.fps} fps` : '—'],
    [t('q.res'), stats?.width && stats?.height ? `${stats.width}×${stats.height}` : '—'],
    [t('q.codec'), stats?.codec ?? '—'],
    [t('q.loss'), stats?.lossPct != null ? `${stats.lossPct}%` : '—'],
    [t('q.rtt'), stats?.rtt != null ? `${stats.rtt} ms` : '—'],
    [t('q.path'), pathText],
  ]
  const sep = <span aria-hidden="true" style={{ width: 1, height: 20, background: 'hsl(var(--border))', margin: '0 4px' }} />
  const dotStatus = phase === 'live' ? (quality === 'slow' ? 'slow' : 'live') : phase === 'denied' || phase === 'ended' || phase === 'failed' ? 'off' : 'connecting'

  return (
    <div
      ref={rootRef}
      className="dark"
      style={{ position: 'fixed', inset: 0, zIndex: 300 /* 호스트 사이드바(250)·상단바(100) 위 — 60 이면 툴바가 깔렸다. 메뉴·툴팁(400)·토스트(500)는 그 위 */, display: 'flex', flexDirection: 'column', background: STAGE_BG, color: 'hsl(var(--foreground))' }}
      data-testid="remote-viewer"
    >
      <header style={{ display: 'flex', justifyContent: 'center', padding: '12px 16px 0' }}>
        <div role="toolbar" aria-label={t('viewer.toolbar')} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, padding: '4px 6px', background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 12, boxShadow: '0 12px 32px hsla(218, 30%, 4%, 0.55)', maxWidth: '100%', boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px' }}>
            <UiStatusDot status={dotStatus} size={8} label={phase === 'live' ? t('viewer.connected') : undefined} />
            <span style={{ fontSize: 13, lineHeight: '20px', fontWeight: 600 }}>{title}</span>
            {phase === 'live' && (
              <button
                type="button"
                title={t('q.panel')}
                aria-expanded={qPanel}
                data-testid="remote-quality"
                onClick={() => setQPanel(v => !v)}
                style={{ ...mono, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 8, fontSize: 12, lineHeight: '16px', border: 0, cursor: 'pointer', background: quality === 'slow' ? 'hsl(var(--warning) / 0.1)' : 'hsl(var(--success) / 0.1)', color: quality === 'slow' ? 'hsl(var(--warning))' : 'hsl(var(--success))' }}
              >
                {quality === 'slow' && <UiIcon name="signal-low" style={{ width: 12, height: 12 }} />}{qualityText || t('viewer.quality')}
                <UiIcon name={qPanel ? 'chevron-up' : 'chevron-down'} style={{ width: 12, height: 12 }} />
              </button>
            )}
          </div>
          {sep}
          <UiTooltip text={t('viewer.cadTip')}>
            <span><UiButton variant="ghost" size="xs" disabled>Ctrl+Alt+Del</UiButton></span>
          </UiTooltip>
          <UiButton variant="ghost" size="xs" disabled={phase !== 'live'} onClick={() => special('win')}>Win</UiButton>
          <UiButton variant="ghost" size="xs" disabled={phase !== 'live'} onClick={() => special('alt-tab')}>Alt+Tab</UiButton>
          <UiMenu
            label={t('viewer.moreKeys')}
            triggerIcon="keyboard"
            items={[
              { key: 'ctrl-shift-esc', label: t('keys.ctrlShiftEsc') },
              { key: 'win-d', label: t('keys.winD') },
              { key: 'win-r', label: t('keys.winR') },
              { key: 'printscreen', label: t('keys.printScreen') },
            ]}
            onSelect={(k: string) => special(k as SpecialKey)}
          />
          {sep}
          <UiIconButton icon="upload" label={t('viewer.clipSend')} disabled={phase !== 'live'} onClick={() => void sendClipboard()} />
          <UiIconButton icon="download" label={t('viewer.clipRecv')} disabled={phase !== 'live'} onClick={() => send({ t: 'clipreq' })} />
          {sep}
          <UiIconButton icon="minimize-2" label={t('viewer.fit')} pressed={fit} onClick={() => setFit(true)} />
          <UiIconButton icon="scan" label={t('viewer.actual')} pressed={!fit} onClick={() => setFit(false)} />
          <UiIconButton icon="maximize" label={t('viewer.fullscreen')} keys={['F11']} onClick={toggleFullscreen} />
          {mons.length > 1 && (
            <select
              className="rounded-md border border-input bg-background"
              style={{ height: 28, padding: '0 6px', fontSize: 12 }}
              value={curMon}
              aria-label={t('viewer.monitor')}
              onChange={e => { const i = Number(e.target.value); setCurMon(i); send({ t: 'mon', i }) }}
            >
              {mons.map(m => <option key={m.i} value={m.i}>{m.name || `${t('viewer.monitor')} ${m.i + 1}`}</option>)}
            </select>
          )}
          {sep}
          <UiButton variant="danger" size="xs" icon="log-out" onClick={() => void finish(true)} data-testid="remote-disconnect">{t('viewer.disconnect')}</UiButton>
        </div>
      </header>

      {phase === 'live' && qPanel && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 16px 0' }}>
          <div role="region" aria-label={t('q.panel')} data-testid="remote-quality-panel" style={{ display: 'flex', flexWrap: 'wrap', gap: 20, padding: '12px 14px', borderRadius: 12, background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', fontSize: 12, lineHeight: '18px', maxWidth: '100%', boxSizing: 'border-box' }}>
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto auto', columnGap: 14, rowGap: 2, margin: 0 }}>
              {infoRows.map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt style={{ color: 'hsl(var(--muted-foreground))' }}>{k}</dt>
                  <dd style={{ ...mono, margin: 0 }}>{v}</dd>
                </React.Fragment>
              ))}
            </dl>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220 }}>
              <span style={{ fontWeight: 600 }}>{t('q.mode')}</span>
              <div role="radiogroup" aria-label={t('q.mode')} style={{ display: 'flex', gap: 4 }}>
                {QUALITY_MODES.map(m => (
                  <UiButton
                    key={m}
                    size="xs"
                    variant={mode === m ? 'default' : 'secondary'}
                    role="radio"
                    aria-checked={mode === m}
                    disabled={hostQ === false}
                    onClick={() => chooseMode(m)}
                    data-testid={`remote-quality-${m}`}
                  >{t(`q.${m}`)}</UiButton>
                ))}
              </div>
              <span style={{ color: 'hsl(var(--muted-foreground))', maxWidth: 280 }}>{hostQ === false ? t('q.oldHost') : t(`q.${mode}Desc`)}</span>
            </div>
          </div>
        </div>
      )}

      {hostClip != null && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 16px 0' }}>
          <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 10, background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', fontSize: 13 }}>
            <span>{t('clip.received', { n: hostClip.length })}</span>
            <UiButton size="xs" variant="secondary" onClick={() => void takeHostClip()}>{t('clip.copy')}</UiButton>
            <UiButton size="xs" variant="ghost" onClick={() => setHostClip(null)}>{t('clip.dismiss')}</UiButton>
          </div>
        </div>
      )}

      <main style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px 24px 24px', boxSizing: 'border-box', minHeight: 0 }}>
        <div
          ref={stageRef}
          role="img"
          aria-label={t('viewer.screen')}
          tabIndex={0}
          onPointerMove={onPointerMove}
          onPointerDown={onPointer(true)}
          onPointerUp={onPointer(false)}
          onContextMenu={e => e.preventDefault()}
          style={{
            position: 'relative', width: '100%', height: '100%', borderRadius: 8, overflow: fit ? 'hidden' : 'auto',
            outline: captured ? '2px solid hsl(var(--primary))' : 'none', outlineOffset: 2,
            background: phase === 'live' ? '#000' : 'transparent',
            border: phase === 'live' ? 'none' : hostState === 'secure_desktop' ? '1px solid hsl(var(--warning) / 0.5)' : '1px solid hsl(var(--border))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={fit ? { width: '100%', height: '100%', objectFit: 'contain' } : { maxWidth: 'none' }}
          />

          {phase === 'live' && hostState === 'secure_desktop' && (
            <div style={{ position: 'absolute', inset: 0, background: STAGE_BG }}>
              <Centered>
                <span style={{ display: 'inline-flex', width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 12, background: 'hsl(var(--warning) / 0.1)', color: 'hsl(var(--warning))' }}>
                  <UiIcon name="shield" style={{ width: 24, height: 24 }} />
                </span>
                <span style={title16}>{t('viewer.uacTitle')}</span>
                <span style={sub13}>{t('viewer.uacSub')}</span>
                <span style={{ fontSize: 12, lineHeight: '16px', color: 'hsl(var(--muted-foreground))' }}>{t('viewer.uacNote')}</span>
              </Centered>
            </div>
          )}
          {phase === 'live' && hostState !== 'secure_desktop' && quality === 'slow' && (
            <div role="status" style={{ position: 'absolute', left: 12, right: 12, bottom: 12, display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', borderRadius: 10, background: 'hsl(var(--card))', border: '1px solid hsl(var(--warning) / 0.4)' }}>
              <UiIcon name="alert-triangle" style={{ width: 16, height: 16, flexShrink: 0, marginTop: 2, color: 'hsl(var(--warning))' }} />
              <span style={{ fontSize: 13, lineHeight: '20px' }}>{t('viewer.slow')}</span>
            </div>
          )}

          {phase === 'awaiting' && (
            <Centered>
              <span style={{ ...mono, fontSize: 30, lineHeight: '36px', fontWeight: 500 }}>{fmtDuration(left)}</span>
              <span style={title16}>{t('viewer.awaiting')}</span>
              <span style={{ ...sub13, maxWidth: 300 }}>{t('viewer.awaitingSub')}</span>
              <UiButton variant="ghost" size="sm" onClick={() => void finish(true)}>{t('viewer.cancelRequest')}</UiButton>
            </Centered>
          )}
          {phase === 'connecting' && (
            <Centered>
              <UiIcon name="loader" className="animate-spin" style={{ width: 28, height: 28, color: 'hsl(var(--primary))' }} />
              <span style={title16}>{t('viewer.connecting', { name: title })}</span>
              <span style={sub13}>{t('viewer.connectingSub')}</span>
              <UiButton variant="ghost" size="sm" onClick={() => void finish(true)}>{t('viewer.cancel')}</UiButton>
            </Centered>
          )}
          {phase === 'reconnecting' && (
            <Centered>
              <UiIcon name="wifi-off" style={{ width: 28, height: 28, color: 'hsl(var(--muted-foreground))' }} />
              <span style={title16}>{t('viewer.lostTitle')}</span>
              <span style={sub13}>{t('viewer.lostSub', { n: retry.n, max: MAX_RETRY, s: retry.s })}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <UiButton size="sm" icon="refresh" onClick={() => void reconnectNow(retry.n)}>{t('viewer.reconnectNow')}</UiButton>
                <UiButton variant="ghost" size="sm" onClick={() => void finish(true)}>{t('viewer.home')}</UiButton>
              </div>
            </Centered>
          )}
          {phase === 'failed' && (
            <Centered>
              <UiIcon name="wifi-off" style={{ width: 28, height: 28, color: 'hsl(var(--muted-foreground))' }} />
              <span style={title16}>{t('viewer.failedTitle')}</span>
              <span style={sub13}>{t('viewer.lostGaveUp')}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <UiButton size="sm" icon="refresh" onClick={() => void reconnectNow(1)}>{t('viewer.reconnectNow')}</UiButton>
                <UiButton variant="ghost" size="sm" onClick={() => void finish(true)}>{t('viewer.home')}</UiButton>
              </div>
            </Centered>
          )}
          {phase === 'denied' && (
            <Centered>
              <UiIcon name="ban" style={{ width: 28, height: 28, color: 'hsl(var(--danger))' }} />
              <span style={title16}>{t('viewer.deniedTitle')}</span>
              <span style={{ ...sub13, maxWidth: 300 }}>{t('viewer.deniedSub')}</span>
              <UiButton variant="outline" size="sm" onClick={() => void finish(true)}>{t('viewer.home')}</UiButton>
            </Centered>
          )}
          {phase === 'ended' && (
            <Centered>
              <UiIcon name="check-circle" style={{ width: 28, height: 28, color: 'hsl(var(--muted-foreground))' }} />
              <span style={title16}>{t('viewer.endedTitle')}</span>
              <UiButton variant="outline" size="sm" onClick={() => void finish(true)}>{t('viewer.home')}</UiButton>
            </Centered>
          )}
        </div>
      </main>

      <footer style={{ display: 'flex', justifyContent: 'center', padding: '0 16px 16px' }}>
        <span style={{ fontSize: 12, lineHeight: '16px', color: captured ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))' }}>
          {captured ? `${t('viewer.captured')} · ` : ''}{t('viewer.footer')} <span style={mono}>Ctrl+Alt+Shift</span>
        </span>
      </footer>
    </div>
  )
}
