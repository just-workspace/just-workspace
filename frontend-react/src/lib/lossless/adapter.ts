/**
 * LosslessVoiceTransport — lib/voice/transport.ts 의 `VoiceTransport` 구현(단계 'lossless').
 *
 * 구성(합성): LiveKit 전송 위에 자체 릴레이 세션을 얹는다.
 *  · LiveKit 방에는 그대로 들어간다 → presence(사이드바·/voice/state 흐름)가 그대로이고, 음성·음악 단계
 *    참가자도 나를 듣는다(Opus 호환 스트림 = 음악 레시피 publish). 그들의 Opus 도 그대로 들린다.
 *  · 릴레이 세션(WebTransport 기본 · WebSocket 폴백)으로 PCM 24/48 을 보내고 받는다. 릴레이 피어로 들어온 사람의
 *    LiveKit 트랙은 꺼서(setParticipantAudioMuted) 같은 소리가 두 번 나지 않게 한다 — 짝은 토큰의 LiveKit identity.
 *  · 릴레이에 못 붙으면(503·네트워크) 음악 단계로 강등(effectiveTier='music'), LiveKit 쪽은 그대로 — 끊기지 않는다.
 *
 * 통계(getStats)는 VoiceStats 에 릴레이 실측(전송·폴백 이유·포맷·버퍼·복구·비트퍼펙트)을 덧붙인다.
 */
import { LiveKitVoiceTransport } from '~/lib/voice/transports/livekit'
import { rmsToDb } from '~/lib/voice/stats'
import type {
  VoiceJoinParams, VoiceLevels, VoicePeer, VoiceSendConfig, VoiceStats, VoiceTier, VoiceTransport, VoiceTransportEvents,
} from '~/lib/voice/transport'
import { requestRelayGrant, RelayUnavailable } from './relayToken'
import { LosslessSession, type LosslessSessionOptions } from './session'
import type { BufferPreset, LosslessEvent, LosslessFormat } from './types'

/** VoiceSendConfig 의 고급값 → 세션 옵션 조각. 값이 없으면 세션 기본(요청 96k·24bit·auto) 그대로 */
export function advancedOf(cfg: VoiceSendConfig | null): { format: Partial<Pick<LosslessFormat, 'sampleRate' | 'bits' | 'codec'>>; bufferPreset?: BufferPreset } {
  const format: Partial<Pick<LosslessFormat, 'sampleRate' | 'bits' | 'codec'>> = {}
  if (cfg?.sampleRate) format.sampleRate = cfg.sampleRate
  if (cfg?.bitDepth) { format.bits = cfg.bitDepth; format.codec = cfg.bitDepth === 16 ? 'pcm_s16' : 'pcm_s24' }
  return { format, bufferPreset: cfg?.bufferTarget }
}

/** LiveKit 토큰(JWT) 의 video.room = 'voice-<채널id>' */
export function channelIdFromLiveKitToken(token: string): string | null {
  try {
    const body = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    const room: string | undefined = body?.video?.room
    return room && room.startsWith('voice-') ? room.slice('voice-'.length) : null
  } catch {
    return null
  }
}

export class LosslessVoiceTransport implements VoiceTransport {
  readonly tiers: readonly VoiceTier[] = ['lossless']
  readonly inner: LiveKitVoiceTransport
  session: LosslessSession | null = null
  private channelId: string | null = null
  private identity: string | null = null
  private cfg: VoiceSendConfig | null = null
  private muted = false
  private deafened = false
  private relayUp = false
  private lastRelayError: string | null = null
  /** 릴레이 피어 번호 → LiveKit identity(그 사람의 Opus 트랙을 꺼 둔다) */
  private relayPeers = new Map<number, string>()
  private offs: (() => void)[] = []
  private listeners = { state: new Set<VoiceTransportEvents['state']>(), peers: new Set<VoiceTransportEvents['peers']>(), ended: new Set<VoiceTransportEvents['ended']>() }

  constructor(private readonly options: LosslessSessionOptions = {}, inner?: LiveKitVoiceTransport) {
    this.inner = inner ?? new LiveKitVoiceTransport()
    this.inner.on('state', (s) => this.emit('state', s))
    this.inner.on('peers', (p) => this.emit('peers', p))
    this.inner.on('ended', (r) => this.emit('ended', r))
  }

  on<K extends keyof VoiceTransportEvents>(ev: K, fn: VoiceTransportEvents[K]): () => void {
    (this.listeners[ev] as Set<VoiceTransportEvents[K]>).add(fn)
    return () => { (this.listeners[ev] as Set<VoiceTransportEvents[K]>).delete(fn) }
  }

  private emit<K extends keyof VoiceTransportEvents>(ev: K, ...args: Parameters<VoiceTransportEvents[K]>): void {
    for (const fn of this.listeners[ev]) { try { (fn as (...a: unknown[]) => void)(...args) } catch { /* 리스너 오류 무시 */ } }
  }

  effectiveTier(): VoiceTier {
    return this.relayUp && this.session?.currentState === 'connected' ? 'lossless' : 'music'
  }

  /** 릴레이에 못 붙은 이유(강등 안내용). 붙어 있으면 null */
  get relayError(): string | null {
    return this.relayUp ? null : this.lastRelayError
  }

  // ─── 접속 ───
  async join(params: VoiceJoinParams): Promise<void> {
    this.cfg = params.send
    this.muted = params.muted
    this.identity = params.identity
    this.channelId = params.channelId ?? channelIdFromLiveKitToken(params.token)
    // Opus 호환 스트림은 음악 레시피(처리 off·스테레오) — 무손실 캡처와 같은 조건
    await this.inner.join({ ...params, send: { ...params.send, tier: 'music' } })
    // 'lossless' 로 들어올 때만 릴레이. 하이레조 어댑터(lib/hires)는 'music' 으로 들어와 presence 만 쓰고, 독점 실패 때 setSend('lossless') 로 릴레이를 켠다
    if (params.send.tier === 'lossless') await this.joinRelay()
  }

  private async joinRelay(): Promise<void> {
    if (!this.channelId) {
      this.lastRelayError = 'channel id unknown'
      return
    }
    // 음질 패널 "고급" — 샘플레이트 요청·비트심도·버퍼 목표는 송신 설정(VoiceSendConfig)에서 온다
    const adv = advancedOf(this.cfg)
    const session = new LosslessSession({
      ...this.options,
      format: { ...this.options.format, ...adv.format },
      bufferPreset: adv.bufferPreset ?? this.options.bufferPreset,
      deviceId: this.cfg?.micDeviceId || this.options.deviceId,
      refreshGrant: this.options.refreshGrant ?? (() => requestRelayGrant(this.channelId!, this.identity ?? undefined)),
    })
    this.offs.forEach(f => f())
    this.offs = [session.on((ev) => this.onRelayEvent(ev))]
    session.setMuted(this.muted)
    session.setDeafened(this.deafened)
    this.session = session
    try {
      const grant = await requestRelayGrant(this.channelId, this.identity ?? undefined)
      // 기다리는 사이 나갔거나(leave) 다른 세션으로 바뀌었으면 이 세션은 올리지 않는다 —
      // 안 그러면 나간 뒤에도 마이크 캡처·중계 연결이 살아 소리가 방으로 나간다
      if (this.session !== session) { try { await session.leave() } catch { /* noop */ } return }
      await session.join(grant)
      if (this.session !== session) { try { await session.leave() } catch { /* noop */ } return }
      this.relayUp = true
      this.lastRelayError = null
    } catch (e) {
      this.relayUp = false
      this.lastRelayError = e instanceof RelayUnavailable ? 'relay unavailable' : ((e as Error)?.message ?? String(e))
      this.offs.forEach(f => f())
      this.offs = []
      this.session = null
      try { await session.leave() } catch { /* noop */ }
      console.warn('[lossless] relay join failed — staying on music tier:', this.lastRelayError)
    }
    this.emit('peers', this.peers())
  }

  private onRelayEvent(ev: LosslessEvent): void {
    switch (ev.type) {
      case 'connected':
        this.relayUp = true
        for (const p of ev.peers) this.pair(p.peer, p.identity)
        this.emit('peers', this.peers())
        break
      case 'peer_joined':
        this.pair(ev.peer.peer, ev.peer.identity)
        break
      case 'peer_left': {
        const id = this.relayPeers.get(ev.peer)
        this.relayPeers.delete(ev.peer)
        if (id && ![...this.relayPeers.values()].includes(id)) this.inner.setParticipantAudioMuted(id, false)
        break
      }
      case 'state':
        if (ev.state === 'failed' || ev.state === 'closed') {
          // 릴레이가 죽었다 — Opus 호환 트랙으로 되돌린다(강등). LiveKit 은 그대로
          this.relayUp = false
          for (const id of new Set(this.relayPeers.values())) this.inner.setParticipantAudioMuted(id, false)
          this.relayPeers.clear()
          // 죽은 세션은 내려놓는다 — 남겨 두면 [무손실 다시 시도](setSend)가 "세션 있음" 분기로 빠져 아무 일도 안 하고, 마이크 캡처도 계속 돈다
          if (ev.state === 'failed' && this.session) {
            const dead = this.session
            this.session = null
            this.offs.forEach(f => f())
            this.offs = []
            this.lastRelayError = this.lastRelayError ?? 'relay connection lost'
            void dead.leave().catch(() => {})
          }
          this.emit('peers', this.peers())
        } else if (ev.state === 'connected') {
          this.relayUp = true
        }
        break
      case 'warning':
        console.info('[lossless]', ev.code, ev.message)
        break
      case 'error':
        console.warn('[lossless]', ev.error)
        break
    }
  }

  /** 릴레이 피어와 LiveKit 참가자를 짝지어 그 사람의 Opus 트랙을 끈다 */
  private pair(peer: number, identity?: string): void {
    if (!identity) return
    this.relayPeers.set(peer, identity)
    this.inner.setParticipantAudioMuted(identity, true)
  }

  async leave(): Promise<void> {
    this.offs.forEach(f => f())
    this.offs = []
    const s = this.session
    this.session = null
    this.relayUp = false
    this.relayPeers.clear()
    if (s) { try { await s.leave() } catch { /* noop */ } }
    await this.inner.leave()
  }

  // ─── 송신 설정 ───
  async setSend(cfg: VoiceSendConfig): Promise<void> {
    const prev = this.cfg
    this.cfg = cfg
    await this.inner.setSend({ ...cfg, tier: 'music' })
    if (cfg.tier !== 'lossless') {
      // 다른 단계로 — 릴레이만 내려놓는다(useVoice 는 tiers 가 다르면 전송을 통째로 갈아탄다)
      const s = this.session
      this.session = null
      this.relayUp = false
      if (s) { try { await s.leave() } catch { /* noop */ } }
      return
    }
    if (prev && (prev.micDeviceId !== cfg.micDeviceId || prev.sampleRate !== cfg.sampleRate) && this.session) {
      // 장치·샘플레이트 요청이 바뀌면 캡처를 다시 올린다(레이트는 AudioContext 생성 때 정해진다)
      const s = this.session
      this.session = null
      try { await s.leave() } catch { /* noop */ }
      await this.joinRelay()
    } else if (!this.session && this.channelId) {
      await this.joinRelay()
    } else if (this.session) {
      // 비트심도·버퍼 목표는 세션을 유지한 채 바꾼다
      const adv = advancedOf(cfg)
      if (prev?.bitDepth !== cfg.bitDepth && adv.format.bits) this.session.setFormat({ codec: adv.format.codec, bits: adv.format.bits })
      if (prev?.bufferTarget !== cfg.bufferTarget && adv.bufferPreset) this.session.setBufferPreset(adv.bufferPreset)
    }
  }

  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted
    this.session?.setMuted(muted)
    await this.inner.setMuted(muted)
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened
    this.session?.setDeafened(deafened)
    this.inner.setDeafened(deafened)
  }

  setScreenAudio(on: boolean): Promise<boolean> {
    return this.inner.setScreenAudio(on)
  }

  /** 마이크 권한 — Opus 호환 트랙(inner)의 상태를 그대로 알린다. 없으면 "듣기만" 띠 대신 "중계 실패"로 잘못 보였다 */
  micState(): 'ok' | 'denied' { return this.inner.micState() }
  /** 사람별 음량·공유 음량 — Opus 로 듣는 상대에게 적용된다(중계로 듣는 상대의 PCM 재생에는 아직 닿지 않는다) */
  setParticipantVolume(identity: string, volume: number): void { this.inner.setParticipantVolume(identity, volume) }
  setParticipantGain(identity: string, gain: number): void { this.inner.setParticipantGain(identity, gain) }

  attachRemoteAudio(container: HTMLElement | null): void {
    this.inner.attachRemoteAudio(container)
  }

  peers(): VoicePeer[] {
    return this.inner.peers()
  }

  getLevels(): VoiceLevels {
    const st = this.session?.getStats()
    const lv = st?.capture?.level
    if (this.relayUp && lv && lv.rms.length && !this.muted) {
      const left = rmsToDb(lv.rms[0])
      const right = rmsToDb(lv.rms[1] ?? lv.rms[0])
      return { left, right }
    }
    return this.inner.getLevels()
  }

  // ─── 통계 ───
  async getStats(): Promise<VoiceStats> {
    const base = await this.inner.getStats()
    const s = this.session?.getStats()
    if (!s || !this.relayUp) {
      return { ...base, transport: null, fallbackReason: this.lastRelayError, format: null, bufferMs: null, recovered: null, bitExact: null }
    }
    let lost = 0
    let recovered = 0
    let plcSamples = 0
    let bufferMs = 0
    let recvBps = 0
    let bitExactRx = true
    for (const p of Object.values(s.peers)) {
      lost += p.lost
      recovered += p.recoveredFec + p.recoveredNack
      plcSamples += Math.round(p.plc * (p.format ? (p.format.sampleRate * p.format.frameMs) / 1000 : 0))
      bufferMs = Math.max(bufferMs, p.targetMs)
      recvBps += p.bitrateBps
      bitExactRx = bitExactRx && p.bitExactPlayback
    }
    const f = s.format
    const codec = f ? (f.codec.startsWith('pcm') ? `PCM ${f.bits}/${Math.round(f.sampleRate / 1000)}` : f.codec.toUpperCase()) : null
    return {
      ...base,
      codec,
      channels: f?.channels ?? base.channels,
      sampleRate: f?.sampleRate ?? base.sampleRate,
      // 송신은 릴레이(PCM) + LiveKit(Opus 호환) 둘 다 나간다 — 패널엔 PCM 쪽을, Opus 는 raw 에서
      sendBitrate: s.bitrateOutBps,
      recvBitrate: recvBps + (base.recvBitrate ?? 0),
      rttMs: s.rttMs || base.rttMs,
      jitterMs: Math.max(...Object.values(s.peers).map(p => p.jitterP95Ms), 0) || base.jitterMs,
      concealedSamples: plcSamples,
      recvPacketsLost: lost,
      jitterBufferMs: bufferMs || null,
      fmtp: null,
      packetsSent: s.framesSent,
      transport: s.transport,
      fallbackReason: s.fallbackReason,
      format: f ? { codec: f.codec, sampleRate: f.sampleRate, bits: f.bits, channels: f.channels, frameMs: f.frameMs, fec: f.fec } : null,
      bufferMs,
      recovered,
      bitExact: !!s.capture?.bitExact && bitExactRx,
      latencyMs: s.estimatedLatencyMs,
    }
  }
}

export function createLosslessVoiceTransport(): VoiceTransport {
  return new LosslessVoiceTransport()
}
