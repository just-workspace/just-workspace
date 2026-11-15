/**
 * HiresVoiceTransport — 'hires' 단계(데스크톱 앱 전용)의 VoiceTransport.
 *
 * 구성(합성): LosslessVoiceTransport(= LiveKit presence + 브라우저 무손실 릴레이) 위에 네이티브 엔진(window.jwNativeAudio)을 얹는다.
 *  · LiveKit 방에는 그대로 들어간다 → presence(사이드바·/voice/state)가 다른 단계와 같고, 음성·음악 참가자도 나를 듣는다(Opus 호환 스트림).
 *  · 하이레조가 켜지면 소리는 네이티브 엔진(메인 프로세스)이 WASAPI exclusive 장치 ↔ 릴레이로 직접 보낸다. 브라우저 무손실 세션은 돌지 않는다.
 *    릴레이 피어(identity)가 보이면 그 사람의 LiveKit 트랙은 꺼서(setParticipantAudioMuted) 두 번 들리지 않게 한다 — 무손실 어댑터와 같은 규칙.
 *  · 처음 켤 때 확인창(alertdialog, "다음부터 묻지 않기") — useVoice.confirmHiresExclusive 로 띄운다.
 *  · 장치 독점 실패(다른 앱 점유·정책·포맷) → useVoice.reportExclusiveError({app, device}) 로 danger 띠, 그동안 **무손실 24/48(브라우저)** 로 보낸다
 *    (answers "장치 독점 실패"). [다시 시도] = useVoice.retryHires → setSend(tier 'hires') 가 다시 들어온다.
 *  · 사용자가 확인창에서 [취소]하면 띠 없이 무손실로 보낸다.
 *
 * UI 훅은 setHiresUiHooks() 로 바꿀 수 있다(테스트·다른 셸). 기본은 ~/composables/useVoice 를 늦게 import 해 confirmHiresExclusive /
 * reportExclusiveError 가 있으면 쓰고, 없으면(아직 안 들어온 빌드) 바로 켠다/콘솔에 남긴다.
 */
import { LosslessVoiceTransport, channelIdFromLiveKitToken, requestRelayGrant } from '~/lib/lossless'
import type { RelayGrant } from '~/lib/lossless/types'
import { i18n } from '~/i18n'
import { formatBitrate } from '~/lib/voice/opus'
import type {
  VoiceJoinParams, VoiceLevels, VoicePeer, VoiceSendConfig, VoiceStats, VoiceTier, VoiceTransport, VoiceTransportEvents,
} from '~/lib/voice/transport'
import { nativeAudioBridge, type HiresDevice, type HiresEvent, type HiresOpenResult, type HiresPeer, type HiresStats, type JwNativeAudio } from './types'

export interface HiresUiHooks {
  /** 장치 독점 확인(처음 한 번). false 면 사용자가 취소 */
  confirmExclusive(deviceName: string, formatLine: string): Promise<boolean>
  /** 독점 실패 띠. null 이면 내린다 */
  reportExclusiveError(err: { app: string; device: string } | null): void
}

let uiHooks: HiresUiHooks | null = null

/** 셸(useVoice)이 아닌 곳에서 쓸 때 훅을 바꾼다. null 이면 기본(useVoice 늦은 import) */
export function setHiresUiHooks(h: HiresUiHooks | null): void {
  uiHooks = h
}

async function defaultHooks(): Promise<HiresUiHooks> {
  try {
    const mod = (await import('~/composables/useVoice')) as unknown as Record<string, unknown>
    const confirm = mod.confirmHiresExclusive as ((d: string, f: string) => Promise<boolean>) | undefined
    const report = mod.reportExclusiveError as ((e: { app: string; device: string } | null) => void) | undefined
    return {
      confirmExclusive: confirm ?? (async () => true),
      reportExclusiveError: report ?? ((e) => { if (e) console.warn('[hires] exclusive failed:', e) }),
    }
  } catch {
    return { confirmExclusive: async () => true, reportExclusiveError: () => {} }
  }
}

/** 확인창·증명 패널에 쓰는 한 줄: 'PCM 32/192 · 비트퍼펙트 · 12.3 Mbps' (비트레이트는 payload 기준 rate × bits × ch) */
export function hiresFormatLine(f: { label: string; rate: number; bits: number; channels: number; bitPerfect: boolean; exclusive: boolean }): string {
  const t = (k: string, a?: Record<string, unknown>) => i18n.t(k, a)
  const quality = f.bitPerfect ? t('chat.voice.hiresEngine.bitPerfect') : f.exclusive ? t('chat.voice.hiresEngine.exclusive') : t('chat.voice.hiresEngine.shared')
  return t('chat.voice.hiresEngine.formatLine', { format: f.label, quality, bitrate: formatBitrate(f.rate * f.bits * f.channels) })
}

/** 장치 probe 로 "요청 이하에서 가장 좋은" exclusive 포맷을 고른다. probe 가 비면 요청 그대로 */
export function pickHiresRequest(dev: HiresDevice | null, want: { rate: number; bits: 16 | 24 | 32; channels: 1 | 2 }): { rate: number; bits: 16 | 24 | 32; channels: 1 | 2; label: string } {
  let rate = want.rate
  let bits = want.bits
  if (dev && dev.exclusiveFormats.length) {
    const ok = dev.exclusiveFormats
      .filter((f) => !f.isFloat && f.channels === want.channels && f.rate <= want.rate && Math.min(f.validBits, 32) <= want.bits)
      .sort((a, b) => (b.rate - a.rate) || (b.validBits - a.validBits))
    if (ok.length) { rate = ok[0].rate; bits = (ok[0].validBits >= 32 ? 32 : ok[0].validBits >= 24 ? 24 : 16) }
  }
  const k = rate / 1000
  return { rate, bits, channels: want.channels, label: `PCM ${bits}/${Number.isInteger(k) ? k : k.toFixed(1)}` }
}

export class HiresVoiceTransport implements VoiceTransport {
  readonly tiers: readonly VoiceTier[] = ['hires']
  readonly inner: LosslessVoiceTransport
  private bridge: JwNativeAudio | null
  private cfg: VoiceSendConfig | null = null
  private channelId: string | null = null
  private identity: string | null = null
  private muted = false
  private deafened = false
  private hiresUp = false
  private opening = false
  private confirmed = false
  private open: HiresOpenResult | null = null
  private lastStats: HiresStats | null = null
  private levels: VoiceLevels = { left: -100, right: -100 }
  private levelTimer: ReturnType<typeof setInterval> | null = null
  private offs: Array<() => void> = []
  /** 릴레이 피어 → LiveKit identity(그 사람의 Opus 트랙을 꺼 둔다) */
  private relayPeers = new Map<number, string>()
  private listeners = { state: new Set<VoiceTransportEvents['state']>(), peers: new Set<VoiceTransportEvents['peers']>(), ended: new Set<VoiceTransportEvents['ended']>() }

  constructor(bridge?: JwNativeAudio | null, inner?: LosslessVoiceTransport) {
    this.bridge = bridge ?? nativeAudioBridge()
    this.inner = inner ?? new LosslessVoiceTransport()
    this.inner.on('state', (s) => this.emit('state', s))
    this.inner.on('peers', (p) => this.emit('peers', p))
    this.inner.on('ended', (r) => this.emit('ended', r))
  }

  on<K extends keyof VoiceTransportEvents>(ev: K, fn: VoiceTransportEvents[K]): () => void {
    (this.listeners[ev] as Set<VoiceTransportEvents[K]>).add(fn)
    return () => { (this.listeners[ev] as Set<VoiceTransportEvents[K]>).delete(fn) }
  }
  private emit<K extends keyof VoiceTransportEvents>(ev: K, ...args: Parameters<VoiceTransportEvents[K]>): void {
    for (const fn of this.listeners[ev]) { try { (fn as (...a: unknown[]) => void)(...args) } catch { /* noop */ } }
  }

  effectiveTier(): VoiceTier {
    return this.hiresUp ? 'hires' : this.inner.effectiveTier()
  }

  /** 마지막 열기 결과(디버그·테스트) */
  get openResult(): HiresOpenResult | null { return this.open }

  // ─── 접속 ───
  async join(params: VoiceJoinParams): Promise<void> {
    this.cfg = params.send
    this.muted = params.muted
    this.identity = params.identity
    this.channelId = params.channelId ?? channelIdFromLiveKitToken(params.token)
    // LiveKit presence + Opus 호환(음악 레시피)만. 브라우저 무손실 릴레이는 하이레조가 실패했을 때만 켠다
    await this.inner.join({ ...params, send: { ...params.send, tier: 'music' } })
    await this.startHires()
  }

  private async fallbackToLossless(reason: string): Promise<void> {
    console.info('[hires] falling back to browser lossless 24/48:', reason)
    if (!this.cfg) return
    await this.inner.setSend({ ...this.cfg, tier: 'lossless', sampleRate: 48000, bitDepth: 24 })
    this.emit('peers', this.peers())
  }

  /** 네이티브 엔진으로 장치 독점 → 릴레이 접속. 실패하면 띠 + 무손실 */
  private async startHires(): Promise<void> {
    if (this.opening || this.hiresUp) return
    this.opening = true
    try {
      const bridge = this.bridge
      const hooks = uiHooks ?? await defaultHooks()
      if (!bridge) { await this.fallbackToLossless('no native bridge'); return }
      if (!this.channelId) { await this.fallbackToLossless('channel id unknown'); return }
      const avail = await bridge.available().catch(() => ({ available: false }))
      if (!avail.available) {
        hooks.reportExclusiveError({ app: i18n.t('chat.voice.hiresEngine.unknownApp'), device: i18n.t('chat.voice.hiresEngine.defaultDevice') })
        await this.fallbackToLossless('addon unavailable')
        return
      }
      const devices = await bridge.listDevices()
      const want = { rate: this.cfg?.sampleRate && this.cfg.sampleRate > 48000 ? this.cfg.sampleRate : 192000, bits: 32 as 16 | 24 | 32, channels: 2 as 1 | 2 }
      const capDev = (this.cfg as { hiresCaptureDevice?: string } | null)?.hiresCaptureDevice
        ? devices.capture.find((d) => d.id === (this.cfg as { hiresCaptureDevice?: string }).hiresCaptureDevice) ?? null
        : devices.capture.find((d) => d.isDefault) ?? devices.capture[0] ?? null
      const pbDev = (this.cfg as { hiresPlaybackDevice?: string } | null)?.hiresPlaybackDevice ?? null
      if (!capDev) {
        hooks.reportExclusiveError({ app: i18n.t('chat.voice.hiresEngine.unknownApp'), device: i18n.t('chat.voice.hiresEngine.defaultDevice') })
        await this.fallbackToLossless('no capture device')
        return
      }
      const req = pickHiresRequest(capDev, want)
      if (!this.confirmed) {
        const ok = await hooks.confirmExclusive(capDev.name, hiresFormatLine({ label: req.label, rate: req.rate, bits: req.bits, channels: req.channels, bitPerfect: true, exclusive: true }))
        if (!ok) { await this.fallbackToLossless('user cancelled'); return }
        this.confirmed = true
      }
      const res = await bridge.openHires({ captureDevice: capDev.id, playbackDevice: pbDev, rate: req.rate, bits: req.bits, channels: req.channels, frameMs: 10, allowShared: false, fec: true, bufferPreset: this.cfg?.bufferTarget ?? 'auto' })
      this.open = res
      if (!res.ok || !res.exclusive) {
        hooks.reportExclusiveError({ app: res.app || i18n.t('chat.voice.hiresEngine.unknownApp'), device: res.device || capDev.name })
        try { await bridge.close() } catch { /* noop */ }
        await this.fallbackToLossless(`exclusive failed: ${res.reason ?? res.code ?? 'unknown'}`)
        return
      }
      hooks.reportExclusiveError(null)
      this.subscribe(bridge)
      await bridge.setMuted(this.muted)
      await bridge.setDeafened(this.deafened)
      const grant = await requestRelayGrant(this.channelId, this.identity ?? undefined)
      const c = await bridge.connect(grant)
      this.hiresUp = true
      for (const p of c.peers ?? []) this.pair(p)
      this.startLevelPoll(bridge)
      this.emit('peers', this.peers())
    } catch (e) {
      console.warn('[hires] start failed:', (e as Error)?.message ?? e)
      try { await this.bridge?.close() } catch { /* noop */ }
      this.unsubscribe()
      this.hiresUp = false
      await this.fallbackToLossless((e as Error)?.message ?? String(e))
    } finally {
      this.opening = false
    }
  }

  private subscribe(bridge: JwNativeAudio): void {
    this.unsubscribe()
    this.offs.push(bridge.on('*', (ev) => this.onNativeEvent(ev)))
  }
  private unsubscribe(): void {
    this.offs.forEach((f) => f())
    this.offs = []
    if (this.levelTimer) clearInterval(this.levelTimer)
    this.levelTimer = null
  }
  private startLevelPoll(bridge: JwNativeAudio): void {
    if (this.levelTimer) clearInterval(this.levelTimer)
    this.levelTimer = setInterval(() => { void bridge.levels().then((l) => { this.levels = l }).catch(() => {}) }, 100)
  }

  private onNativeEvent(ev: HiresEvent): void {
    switch (ev.type) {
      case 'connected':
        for (const p of (ev.peers as HiresPeer[]) ?? []) this.pair(p)
        this.emit('peers', this.peers())
        break
      case 'peer_joined':
        this.pair(ev.peer as HiresPeer)
        break
      case 'peer_left': {
        const peer = ev.peer as number
        const id = this.relayPeers.get(peer)
        this.relayPeers.delete(peer)
        if (id && ![...this.relayPeers.values()].includes(id)) this.inner.inner.setParticipantAudioMuted(id, false)
        break
      }
      case 'needGrant':
        if (this.channelId) void requestRelayGrant(this.channelId, this.identity ?? undefined).then((g: RelayGrant) => this.bridge?.setGrant(g)).catch(() => {})
        break
      case 'stats':
        this.lastStats = ev.stats as HiresStats
        break
      case 'state': {
        const st = ev.state as string
        if (st === 'failed' || st === 'closed') {
          if (this.hiresUp) {
            this.hiresUp = false
            for (const id of new Set(this.relayPeers.values())) this.inner.inner.setParticipantAudioMuted(id, false)
            this.relayPeers.clear()
            this.unsubscribe()
            void this.fallbackToLossless(`native session ${st}: ${String(ev.reason ?? '')}`)
          }
        }
        break
      }
      case 'warning':
        console.info('[hires]', ev.code, ev.message)
        break
      case 'error':
        console.warn('[hires]', ev.message)
        break
    }
  }

  private pair(p: HiresPeer): void {
    if (!p?.identity) return
    this.relayPeers.set(p.peer, p.identity)
    this.inner.inner.setParticipantAudioMuted(p.identity, true)
  }

  private async stopHires(): Promise<void> {
    this.unsubscribe()
    const was = this.hiresUp
    this.hiresUp = false
    for (const id of new Set(this.relayPeers.values())) this.inner.inner.setParticipantAudioMuted(id, false)
    this.relayPeers.clear()
    if (was || this.open) { try { await this.bridge?.close() } catch { /* noop */ } }
    this.open = null
    this.lastStats = null
    this.levels = { left: -100, right: -100 }
  }

  async leave(): Promise<void> {
    await this.stopHires()
    await this.inner.leave()
  }

  // ─── 송신 설정 ───
  async setSend(cfg: VoiceSendConfig): Promise<void> {
    const prev = this.cfg
    this.cfg = cfg
    if (cfg.tier !== 'hires') {
      // 다른 단계로 — 네이티브만 내려놓는다(useVoice 는 tiers 가 다르면 전송을 통째로 갈아탄다)
      await this.stopHires()
      await this.inner.setSend(cfg)
      return
    }
    if (this.hiresUp) {
      if (prev?.bufferTarget !== cfg.bufferTarget && cfg.bufferTarget) await this.bridge?.setBufferPreset(cfg.bufferTarget)
      // LiveKit 쪽(장치 등)은 그대로 전달 — 음악 레시피 유지
      await this.inner.setSend({ ...cfg, tier: 'music' })
      return
    }
    // [다시 시도](retryHires) 또는 아직 안 켜진 상태 → 다시 시도. 브라우저 무손실이 돌고 있으면 내린다
    await this.inner.setSend({ ...cfg, tier: 'music' })
    await this.startHires()
  }

  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted
    if (this.hiresUp) { try { await this.bridge?.setMuted(muted) } catch { /* noop */ } }
    await this.inner.setMuted(muted)
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened
    if (this.hiresUp) void this.bridge?.setDeafened(deafened).catch(() => {})
    this.inner.setDeafened(deafened)
  }

  setScreenAudio(on: boolean): Promise<boolean> { return this.inner.setScreenAudio(on) }
  attachRemoteAudio(container: HTMLElement | null): void { this.inner.attachRemoteAudio(container) }
  peers(): VoicePeer[] { return this.inner.peers() }
  setParticipantVolume(identity: string, volume: number): void { this.inner.setParticipantVolume(identity, volume) }
  setParticipantGain(identity: string, gain: number): void { this.inner.setParticipantGain(identity, gain) }
  micState(): 'ok' | 'denied' { return (this.inner as unknown as { micState?: () => 'ok' | 'denied' }).micState?.() ?? 'ok' }

  getLevels(): VoiceLevels {
    if (this.hiresUp && !this.muted) return this.levels
    return this.inner.getLevels()
  }

  // ─── 통계 ───
  async getStats(): Promise<VoiceStats> {
    const base = await this.inner.getStats()
    if (!this.hiresUp || !this.bridge) return { ...base, exclusive: false, bitPerfect: false }
    let s: HiresStats | null = null
    try { s = await this.bridge.stats() } catch { s = this.lastStats }
    if (!s) return { ...base, exclusive: this.open?.exclusive ?? false, bitPerfect: false }
    return mapHiresStats(base, s)
  }
}

/** HiresStats → VoiceStats(순수 함수 — 테스트) */
export function mapHiresStats(base: VoiceStats, s: HiresStats): VoiceStats {
  let lost = 0
  let recovered = 0
  let plcSamples = 0
  let bufferMs = 0
  let recvBps = 0
  let jitter = 0
  let rxBitExact = true
  for (const p of Object.values(s.peers)) {
    lost += p.lost
    recovered += p.recoveredFec + p.recoveredNack
    plcSamples += Math.round(p.plc * (p.format ? (p.format.rate * p.format.frameMs) / 1000 : 0))
    bufferMs = Math.max(bufferMs, p.targetMs)
    recvBps += p.bitrateBps
    jitter = Math.max(jitter, p.jitterP95Ms)
    rxBitExact = rxBitExact && p.bitExactPlayback
  }
  const w = s.wire
  const bitPerfect = s.exclusive && s.bitPerfect && !s.resampling
  return {
    ...base,
    codec: s.formatLabel ?? (w ? `PCM ${w.bits}/${Math.round(w.rate / 1000)}` : base.codec),
    channels: w?.channels ?? base.channels,
    sampleRate: w?.rate ?? base.sampleRate,
    sendBitrate: s.bitrateOutBps,
    recvBitrate: recvBps + (base.recvBitrate ?? 0),
    rttMs: s.rttMs || base.rttMs,
    jitterMs: jitter || base.jitterMs,
    concealedSamples: plcSamples,
    recvPacketsLost: lost,
    jitterBufferMs: bufferMs || null,
    fmtp: null,
    packetsSent: s.framesSent,
    transport: s.transport,
    fallbackReason: s.fallbackReason,
    format: w ? { codec: w.codec, sampleRate: w.rate, bits: w.bits, channels: w.channels, frameMs: w.frameMs, fec: w.fec } : null,
    bufferMs,
    recovered,
    bitExact: bitPerfect && (Object.keys(s.peers).length === 0 || (rxBitExact && s.playbackBitExact)),
    latencyMs: s.estimatedLatencyMs,
    exclusive: s.exclusive,
    bitPerfect,
    deviceName: s.capture?.name ?? null,
  }
}

export function createHiresVoiceTransport(): VoiceTransport {
  return new HiresVoiceTransport()
}
