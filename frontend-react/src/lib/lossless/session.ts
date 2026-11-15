/**
 * LosslessSession — 무손실 티어 세션 하나(방 하나).
 *
 * 송신: getUserMedia(처리 전부 off, 2ch, 장치 레이트 그대로) → AudioContext(트랙 레이트) → 캡처 워크릿(N샘플 프레임)
 *       → PCM 패킹(s16/s24/f32) → XOR 패리티 4:1 → 전송(WebTransport 데이터그램 기본, WebSocket 폴백).
 * 수신: 패킷 → 단편 재조립 → FEC 복원 / NACK → PCM 언패킹 → 피어별 재생 워크릿(스트림 레이트의 AudioContext, 지터버퍼+PLC).
 * 통계: 1 s 마다 'stats' 이벤트(송신 비트레이트·RTT·피어별 버퍼/손실/복구·릴레이 방 통계) + 릴레이에 클라이언트 통계 보고.
 *
 * 비트퍼펙트 판정: 장치 레이트 == 캡처 컨텍스트 레이트 == 스트림 레이트(송신), 스트림 레이트 == 재생 컨텍스트 레이트(수신).
 * 하나라도 다르면 Chrome 이 리샘플한다 → warning 이벤트 + bitExact=false (배지는 "무손실(리샘플)" 로 낮춰야 한다).
 */
import captureWorkletUrl from './capture.worklet.ts?worker&url'
import playbackWorkletUrl from './playback.worklet.ts?worker&url'
import { ParityDecoder, ParityEncoder } from './fec'
import { bitsFor, frameSamples as calcFrameSamples, packPcm, planarToBuffer, unpackPcm, bufferToPlanar } from './pcm'
import {
  Codec, Flag, Reassembler, Type, codecByte, codecName, decode, decodeCtrl, decodePingPayload, encodeCtrl, encodeNack,
  encodePing, fragment, groupBase, payloadOf, type Header,
} from './protocol'
import { createTransport, TransportTimeout, WebTransportTransport, type RelayTransport } from './transport'
import { TransportSelector, classifyHandshakeError, type FallbackReason } from './transportSelector'
import type {
  BufferPreset, LosslessEvent, LosslessFormat, LosslessListener, PeerInfo, PeerReceiveStats, RelayGrant, RelayRoomStats,
  SessionState, SessionStats, TransportKind,
} from './types'

export interface LosslessSessionOptions {
  /** 송신 포맷 기본값. sampleRate 는 장치가 정하므로 여기 값은 "요청"이다(96000 → 안 되면 장치 값) */
  format?: Partial<LosslessFormat>
  bufferPreset?: BufferPreset
  /** 캡처에 쓸 장치 */
  deviceId?: string
  /** 토큰 만료 뒤 재접속·WebTransport 재시도에 쓸 새 grant 를 받아오는 함수(없으면 재시도 생략) */
  refreshGrant?: () => Promise<RelayGrant>
  /** 테스트용: getUserMedia 대신 쓸 스트림 */
  mediaStream?: MediaStream
  /** 테스트용: 폴백 뒤 WebTransport 재시도 간격(ms) */
  retryWebTransportAfterMs?: number
  handshakeTimeoutMs?: number
  /** 테스트용: 환경 판별 덮어쓰기 */
  hasWebTransport?: boolean
  /** 테스트 계측: 보낸 프레임 payload(패킹된 PCM 바이트) — e2e 비트퍼펙트 해시 비교용 */
  onFrameSent?: (seq: number, payload: Uint8Array, ts: number) => void
  /** 테스트 계측: 받은(복원 포함) 프레임 payload */
  onFrameReceived?: (peer: number, seq: number, payload: Uint8Array, recovered: 'none' | 'fec' | 'nack') => void
}

interface PeerPlayback {
  peer: number
  format: LosslessFormat
  ctx: AudioContext
  node: AudioWorkletNode
  gain: GainNode
  reassembler: Reassembler
  fec: ParityDecoder
  fecOn: boolean
  expected: number | null
  /** 빠진 seq → 발견 시각 */
  missing: Map<number, number>
  nacked: Set<number>
  stats: PeerReceiveStats
  bytesWindow: number
  pushed: Set<number>
}

const DEFAULT_FORMAT: LosslessFormat = { codec: 'pcm_s24', sampleRate: 48000, channels: 2, bits: 24, frameMs: 10, fec: true }

export class LosslessSession {
  private listeners = new Set<LosslessListener>()
  private state: SessionState = 'idle'
  private grant: RelayGrant | null = null
  private transport: RelayTransport | null = null
  private selector: TransportSelector | null = null
  private peerId: number | null = null
  private room: string | null = null
  private peers = new Map<number, PeerInfo>()
  private playbacks = new Map<number, PeerPlayback>()
  private contexts = new Map<number, Promise<AudioContext>>()
  private muted = false
  private deafened = false
  private preset: BufferPreset
  private requested: LosslessFormat
  private format: LosslessFormat | null = null
  private capture: NonNullable<SessionStats['capture']> | null = null
  private stream: MediaStream | null = null
  private captureCtx: AudioContext | null = null
  private captureNode: AudioWorkletNode | null = null
  private seq = 0
  private parity = new ParityEncoder()
  private bytesOutWindow = 0
  private bitrateOut = 0
  private framesSent = 0
  private rttMs = 0
  private relayStats: RelayRoomStats | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private closing = false
  private muteFrameBuf: Uint8Array | null = null

  constructor(private readonly opts: LosslessSessionOptions = {}) {
    this.preset = opts.bufferPreset ?? 'auto'
    this.requested = { ...DEFAULT_FORMAT, sampleRate: 96000, ...opts.format }
    if (!opts.format?.bits && opts.format?.codec) this.requested.bits = bitsFor(opts.format.codec)
  }

  /* ───────── 이벤트 ───────── */

  on(listener: LosslessListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(ev: LosslessEvent): void {
    for (const l of this.listeners) {
      try { l(ev) } catch (e) { console.error('[lossless] listener', e) }
    }
  }

  private setState(state: SessionState, reason?: string): void {
    this.state = state
    this.emit({ type: 'state', state, reason })
  }

  get currentState(): SessionState {
    return this.state
  }

  get transportKind(): TransportKind | null {
    return this.transport?.kind ?? null
  }

  get fallbackReason(): FallbackReason | null {
    return this.selector?.fallbackReason ?? null
  }

  /* ───────── 참가 / 떠나기 ───────── */

  /** grant = relay-token 응답(requestRelayGrant). 캡처를 먼저 올리고 전송을 붙인다 */
  async join(grant: RelayGrant): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'closed' && this.state !== 'failed') throw new Error(`cannot join in state ${this.state}`)
    this.closing = false
    this.grant = grant
    this.room = grant.room
    this.setState('connecting')
    this.selector = new TransportSelector(
      { hasWebTransport: this.opts.hasWebTransport ?? WebTransportTransport.supported(), webtransportUrl: grant.webtransport?.url ?? null },
      { now: () => performance.now(), retryWebTransportAfterMs: this.opts.retryWebTransportAfterMs, handshakeTimeoutMs: this.opts.handshakeTimeoutMs },
    )
    try {
      await this.startCapture()
      await this.connectWithFallback()
    } catch (e) {
      this.setState('failed', (e as Error).message)
      await this.teardown()
      throw e
    }
    this.timer = setInterval(() => this.tick(), 1000)
  }

  async leave(): Promise<void> {
    this.closing = true
    await this.teardown()
    this.setState('closed')
  }

  private async teardown(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const tr = this.transport
    this.transport = null
    tr?.close('leave')
    for (const pb of this.playbacks.values()) this.destroyPlayback(pb)
    this.playbacks.clear()
    this.peers.clear()
    this.peerId = null
    this.captureNode?.disconnect()
    this.captureNode = null
    if (this.captureCtx) { try { await this.captureCtx.close() } catch { /* ignore */ } }
    this.captureCtx = null
    if (this.stream && !this.opts.mediaStream) for (const t of this.stream.getTracks()) t.stop()
    this.stream = null
    for (const p of this.contexts.values()) { try { (await p).close() } catch { /* ignore */ } }
    this.contexts.clear()
  }

  /* ───────── 전송 선택·폴백 ───────── */

  private async connectWithFallback(): Promise<void> {
    const sel = this.selector!
    for (let attempt = 0; attempt < 3; attempt++) {
      const kind = sel.next()
      try {
        await this.connectAs(kind)
        sel.recordHandshake(kind, 'ok')
        if (kind === 'websocket' && sel.webTransportPossible) this.scheduleWebTransportRetry()
        return
      } catch (e) {
        const timedOut = e instanceof TransportTimeout
        const outcome = classifyHandshakeError(e, timedOut)
        sel.recordHandshake(kind, outcome)
        if (kind === 'webtransport') {
          this.emit({ type: 'transport_fallback', from: 'webtransport', to: 'websocket', reason: `${sel.fallbackReason}: ${(e as Error).message}` })
          continue
        }
        throw e
      }
    }
    throw new Error('relay unreachable over WebTransport and WebSocket')
  }

  /** 전송 하나를 열고 welcome 까지 기다린다 */
  private async connectAs(kind: TransportKind): Promise<void> {
    const grant = this.grant!
    const tr = createTransport(kind, grant)
    const timeout = this.selector!.handshakeTimeoutMs
    const welcome = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new TransportTimeout(kind, timeout * 2)), timeout * 2)
      tr.onPacket = (pkt, reliable) => {
        const h = decode(pkt)
        if (!h) return
        if (h.type === Type.Ctrl) {
          const m = decodeCtrl<any>(payloadOf(pkt))
          if (m?.t === 'welcome') {
            clearTimeout(t)
            this.onWelcome(tr, m)
            resolve()
            return
          }
        }
        this.onPacket(tr, pkt, h, reliable)
      }
      tr.onClose = (reason) => {
        clearTimeout(t)
        reject(new Error(reason))
        this.onTransportClosed(tr, reason)
      }
    })
    welcome.catch(() => { /* connect 가 먼저 실패하면 welcome 타임아웃은 의미 없다 — 처리된 거부로 둔다 */ })
    await tr.connect(timeout)
    await welcome
  }

  private onWelcome(tr: RelayTransport, m: { peer: number; room: string; peers: PeerInfo[]; transport: string }): void {
    const old = this.transport
    this.transport = tr
    old?.close('replaced')
    this.peerId = m.peer
    this.room = m.room
    this.peers.clear()
    for (const p of m.peers ?? []) this.peers.set(p.peer, p)
    this.setState('connected')
    this.emit({ type: 'connected', transport: tr.kind, peerId: m.peer, room: m.room, peers: [...this.peers.values()] })
  }

  private onTransportClosed(tr: RelayTransport, reason: string): void {
    if (this.transport !== tr || this.closing) return
    this.transport = null
    this.selector?.recordDisconnect(tr.kind)
    this.setState('reconnecting', reason)
    void this.reconnect()
  }

  private async reconnect(): Promise<void> {
    try {
      if (this.opts.refreshGrant) this.grant = await this.opts.refreshGrant()
      await this.connectWithFallback()
    } catch (e) {
      if (this.closing) return
      this.setState('failed', (e as Error).message)
      this.emit({ type: 'error', error: e as Error })
    }
  }

  /** WebSocket 으로 떨어져 있는 동안 주기적으로 WebTransport 를 다시 시도한다(되면 갈아탄다) */
  private scheduleWebTransportRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    const sel = this.selector!
    const wait = Math.max(1000, sel.msUntilRetry())
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null
      if (this.closing || !sel.shouldRetryWebTransport() || this.transport?.kind !== 'websocket') return
      try {
        if (this.opts.refreshGrant) this.grant = await this.opts.refreshGrant()
        else if (this.grant && Date.now() / 1000 > this.grantIssuedAt + this.grant.expires_in - 5) return // 토큰 만료 — 새 grant 없이는 못 붙는다
        const old = this.transport
        await this.connectAs('webtransport') // onWelcome 이 교체·old close
        sel.recordHandshake('webtransport', 'ok')
        this.emit({ type: 'transport_fallback', from: 'websocket', to: 'webtransport', reason: 'webtransport available again' })
        void old
      } catch (e) {
        sel.recordHandshake('webtransport', classifyHandshakeError(e, e instanceof TransportTimeout))
        this.scheduleWebTransportRetry()
      }
    }, wait)
  }

  private get grantIssuedAt(): number {
    try {
      const body = JSON.parse(atob(this.grant!.token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')))
      return Number(body.iat) || 0
    } catch {
      return 0
    }
  }

  /* ───────── 캡처 ───────── */

  private async startCapture(): Promise<void> {
    const want = this.requested
    let stream = this.opts.mediaStream ?? null
    if (!stream) {
      const base: MediaTrackConstraints = {
        channelCount: { ideal: want.channels },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        ...(this.opts.deviceId ? { deviceId: { exact: this.opts.deviceId } } : {}),
        // latency 는 lib.dom 에 없지만 Chrome 이 받는다(Cleanfeed·ipDTL 도 ideal 0)
        ...({ latency: { ideal: 0 } } as Record<string, unknown>),
      }
      // 96 kHz 를 먼저 청한다 — 브라우저가 장치 레이트를 그대로 주는지는 getSettings() 로 확인(미검증 항목)
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...base, sampleRate: { ideal: want.sampleRate } } })
    }
    this.stream = stream
    const track = stream.getAudioTracks()[0]
    const settings = track?.getSettings() ?? {}
    const deviceRate = (settings.sampleRate as number | undefined) || 48000
    const deviceChannels = (settings.channelCount as number | undefined) || 1
    let ctx: AudioContext
    try {
      ctx = new AudioContext({ sampleRate: deviceRate, latencyHint: 'interactive' })
    } catch {
      ctx = new AudioContext({ latencyHint: 'interactive' })
      this.emit({ type: 'warning', code: 'unsupported_rate', message: `AudioContext at ${deviceRate} Hz not supported; using ${ctx.sampleRate}` })
    }
    this.captureCtx = ctx
    await ctx.audioWorklet.addModule(captureWorkletUrl)
    const streamRate = ctx.sampleRate
    const fmt: LosslessFormat = { ...want, sampleRate: streamRate, channels: Math.max(1, Math.min(8, want.channels)) }
    fmt.bits = fmt.codec === 'flac' ? fmt.bits : bitsFor(fmt.codec)
    this.format = fmt
    const fs = calcFrameSamples(streamRate, fmt.frameMs)
    const src = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'jw-lossless-capture', {
      // 모노 마이크(헤드셋 대부분)를 2채널 스트림에 실을 때는 'speakers' — 양쪽에 같은 소리(L=R)로 올린다.
      // 예전엔 늘 'discrete' 라 모자란 채널이 0 으로 채워져, 무손실로 듣는 사람은 왼쪽 귀로만 들었다.
      // 채널 수가 맞는 장치는 'discrete' 그대로(섞지 않는다 — 비트 그대로).
      numberOfInputs: 1, numberOfOutputs: 0, channelCount: fmt.channels, channelCountMode: 'explicit',
      channelInterpretation: deviceChannels < fmt.channels ? 'speakers' : 'discrete',
      processorOptions: { frameSamples: fs, channels: fmt.channels },
    })
    node.port.onmessage = (ev) => this.onCaptureMessage(ev.data)
    src.connect(node)
    this.captureNode = node
    const bitExact = deviceRate === streamRate
    this.capture = {
      requestedSampleRate: want.sampleRate, deviceSampleRate: deviceRate, deviceChannels, contextSampleRate: streamRate, bitExact,
      level: { peak: [], rms: [] },
    }
    if (!bitExact) this.emit({ type: 'warning', code: 'resampled_capture', message: `device ${deviceRate} Hz → context ${streamRate} Hz (resampled, not bit-exact)` })
    if (ctx.state !== 'running') { try { await ctx.resume() } catch { /* 제스처 필요 — 호출자가 다시 resume */ } }
    this.emit({ type: 'format', format: fmt, capture: this.capture })
  }

  private onCaptureMessage(m: any): void {
    if (m?.type === 'level') {
      if (this.capture) this.capture.level = { peak: m.peak, rms: m.rms }
      this.emit({ type: 'level', peer: 'self', peak: m.peak, rms: m.rms })
      return
    }
    if (m?.type !== 'frame' || !this.transport || !this.format || this.state !== 'connected') return
    const f = this.format
    const h: Partial<Header> & { type: number } = {
      type: Type.Audio, codec: codecByte(f.codec), channels: f.channels, bits: f.bits, frame: calcFrameSamples(f.sampleRate, f.frameMs),
      rate: f.sampleRate, seq: this.seq, ts: m.ts, flags: f.fec && f.codec !== 'flac' && f.codec !== 'opus' ? Flag.FEC : 0,
    }
    const seq = this.seq
    this.seq = (this.seq + 1) >>> 0
    this.framesSent++
    if (this.muted) {
      // 무음 프레임: 헤더만(payload 0) + MUTED. seq 가 이어져 수신자가 NACK 을 쏘지 않는다
      const pkt = fragment({ ...h, flags: (h.flags ?? 0) | Flag.Muted }, new Uint8Array(0), this.transport.maxDatagram)[0]
      this.send(pkt)
      this.parity.reset()
      return
    }
    const planar = bufferToPlanar(m.buf, m.channels)
    const payload = packPcm(planar, f.codec, f.channels)
    this.opts.onFrameSent?.(seq, payload, m.ts)
    for (const pkt of fragment(h, payload, this.transport.maxDatagram)) this.send(pkt)
    if (h.flags! & Flag.FEC) {
      const par = this.parity.push(seq, payload)
      if (par) for (const pkt of fragment({ ...h, type: Type.Parity, seq: par.seq }, par.payload, this.transport.maxDatagram)) this.send(pkt)
    }
  }

  private send(pkt: Uint8Array): void {
    this.bytesOutWindow += pkt.byteLength
    this.transport?.sendUnreliable(pkt)
  }

  /* ───────── 수신 ───────── */

  private onPacket(tr: RelayTransport, pkt: Uint8Array, h: Header, reliable: boolean): void {
    if (tr !== this.transport && this.transport !== null) return
    const arrival = performance.now()
    switch (h.type) {
      case Type.Audio:
      case Type.Parity:
        this.onMedia(pkt, h, arrival)
        break
      case Type.Pong: {
        const sent = decodePingPayload(payloadOf(pkt))
        if (sent !== null) {
          const rtt = arrival - sent
          this.rttMs = this.rttMs ? this.rttMs + (rtt - this.rttMs) / 4 : rtt
        }
        break
      }
      case Type.Ping:
        // 릴레이의 RTT 측정 — 같은 경로로 되돌린다
        pkt[1] = Type.Pong
        if (reliable) tr.sendReliable(pkt)
        else tr.sendUnreliable(pkt)
        break
      case Type.Ctrl:
        this.onCtrl(decodeCtrl<any>(payloadOf(pkt)))
        break
    }
  }

  private onCtrl(m: any): void {
    if (!m) return
    switch (m.t) {
      case 'peer_joined':
        this.peers.set(m.peer, { peer: m.peer, uid: m.uid, name: m.name, identity: m.identity, transport: m.transport })
        this.emit({ type: 'peer_joined', peer: this.peers.get(m.peer)! })
        break
      case 'peer_left': {
        this.peers.delete(m.peer)
        const pb = this.playbacks.get(m.peer)
        if (pb) { this.destroyPlayback(pb); this.playbacks.delete(m.peer) }
        this.emit({ type: 'peer_left', peer: m.peer, uid: m.uid })
        break
      }
      case 'stats':
        this.relayStats = m as RelayRoomStats
        break
    }
  }

  private formatFromHeader(h: Header): LosslessFormat {
    const codec = codecName(h.codec)
    return {
      codec: codec === 'unknown' ? 'pcm_s16' : codec, sampleRate: h.rate, channels: h.channels, bits: h.bits as 16 | 24 | 32,
      frameMs: (h.frame / h.rate) * 1000, fec: (h.flags & Flag.FEC) !== 0,
    }
  }

  private sameFormat(a: LosslessFormat, b: LosslessFormat): boolean {
    return a.codec === b.codec && a.sampleRate === b.sampleRate && a.channels === b.channels && a.bits === b.bits && Math.abs(a.frameMs - b.frameMs) < 1e-6
  }

  private onMedia(pkt: Uint8Array, h: Header, arrival: number): void {
    if (h.src === 0 || h.src === this.peerId) return
    if (h.rate === 0 || h.channels === 0 || h.frame === 0) return
    const fmt = this.formatFromHeader(h)
    let pb = this.playbacks.get(h.src)
    if (pb && !this.sameFormat(pb.format, fmt)) {
      this.destroyPlayback(pb)
      this.playbacks.delete(h.src)
      pb = undefined
    }
    if (!pb) {
      pb = this.createPlayback(h.src, fmt)
      this.playbacks.set(h.src, pb)
      this.emit({ type: 'peer_format', peer: h.src, format: fmt })
    }
    pb.stats.packets++
    pb.bytesWindow += pkt.byteLength
    pb.fecOn = fmt.fec
    const r = pb.reassembler.push(pkt, h)
    if (!r) return
    if (h.type === Type.Parity) {
      const rec = pb.fec.addParity(r.header.seq, r.payload)
      if (rec) this.deliverRecovered(pb, rec.seq, rec.payload, arrival)
      this.checkMissing(pb, arrival)
      return
    }
    const seq = r.header.seq
    const retx = (r.header.flags & Flag.Retransmit) !== 0
    let how: 'none' | 'nack' = 'none'
    if (retx && pb.nacked.has(seq)) {
      pb.stats.recoveredNack++
      pb.nacked.delete(seq)
      how = 'nack'
    }
    if (!pb.pushed.has(seq) && !(r.header.flags & Flag.Muted)) this.opts.onFrameReceived?.(pb.peer, seq, r.payload, how)
    pb.missing.delete(seq)
    this.trackGaps(pb, seq, arrival)
    if (pb.fecOn && !pb.pushed.has(seq)) pb.fec.addFrame(seq, r.payload)
    this.deliver(pb, seq, r.header, r.payload, arrival)
    if (pb.fecOn) {
      const rec = pb.fec.tryRecover(groupBase(seq))
      if (rec) this.deliverRecovered(pb, rec.seq, rec.payload, arrival)
      this.checkMissing(pb, arrival)
    }
  }

  private trackGaps(pb: PeerPlayback, seq: number, arrival: number): void {
    if (pb.expected === null) { pb.expected = seq + 1; return }
    if (seq >= pb.expected) {
      const gap = seq - pb.expected
      if (gap > 0 && gap <= 64) for (let s = pb.expected; s < seq; s++) if (!pb.pushed.has(s)) pb.missing.set(s, arrival)
      pb.expected = seq + 1
    }
    // FEC 가 없으면 바로 NACK; 있으면 그룹이 닫힐 때까지 기다린다(checkMissing)
    if (!pb.fecOn) this.flushNacks(pb, [...pb.missing.keys()])
  }

  /** FEC 스트림: 그룹이 지나갔는데(다음 그룹 프레임 도착) 아직 못 채운 seq 는 NACK */
  private checkMissing(pb: PeerPlayback, now: number): void {
    if (pb.missing.size === 0) return
    const due: number[] = []
    for (const [s, at] of pb.missing) {
      if (pb.pushed.has(s)) { pb.missing.delete(s); continue }
      const closed = pb.expected !== null && pb.expected > groupBase(s) + 4
      if (closed || now - at > 2 * pb.format.frameMs * 4) due.push(s)
    }
    this.flushNacks(pb, due)
    // 1 s 넘게 묵은 항목은 포기
    for (const [s, at] of pb.missing) if (now - at > 1000) pb.missing.delete(s)
  }

  private flushNacks(pb: PeerPlayback, seqs: number[]): void {
    const fresh = seqs.filter((s) => !pb.nacked.has(s))
    if (fresh.length === 0 || !this.transport) return
    for (const s of fresh) pb.nacked.add(s)
    pb.stats.nackSent += fresh.length
    this.transport.sendReliable(encodeNack(pb.peer, fresh))
    if (pb.nacked.size > 512) pb.nacked = new Set([...pb.nacked].slice(-256))
  }

  private deliverRecovered(pb: PeerPlayback, seq: number, payload: Uint8Array, arrival: number): void {
    if (pb.pushed.has(seq)) return
    pb.stats.recoveredFec++
    pb.missing.delete(seq)
    this.opts.onFrameReceived?.(pb.peer, seq, payload, 'fec')
    const h: Header = {
      type: Type.Audio, codec: codecByte(pb.format.codec), flags: 0, channels: pb.format.channels, bits: pb.format.bits,
      frame: calcFrameSamples(pb.format.sampleRate, pb.format.frameMs), rate: pb.format.sampleRate, seq, ts: 0, src: pb.peer, fragIdx: 0, fragCnt: 1,
    }
    this.deliver(pb, seq, h, payload, arrival)
  }

  private deliver(pb: PeerPlayback, seq: number, h: Header, payload: Uint8Array, arrival: number): void {
    if (pb.pushed.has(seq)) return
    pb.pushed.add(seq)
    if (pb.pushed.size > 2048) pb.pushed = new Set([...pb.pushed].slice(-1024))
    const fs = calcFrameSamples(pb.format.sampleRate, pb.format.frameMs)
    let planar: Float32Array[] | null
    if (h.flags & Flag.Muted || payload.byteLength === 0) {
      planar = []
      for (let c = 0; c < pb.format.channels; c++) planar.push(new Float32Array(fs))
    } else if (pb.format.codec === 'flac' || pb.format.codec === 'opus') {
      // 압축 코덱은 아직 디코더가 없다 — 무음으로 자리만 지킨다(2단계: wasm FLAC)
      planar = []
      for (let c = 0; c < pb.format.channels; c++) planar.push(new Float32Array(fs))
    } else {
      planar = unpackPcm(payload, pb.format.codec, pb.format.channels)
      if (!planar || planar[0].length !== fs) return
    }
    pb.stats.received++
    const buf = planarToBuffer(planar)
    pb.node.port.postMessage({ type: 'frame', seq, ts: h.ts, channels: pb.format.channels, buf, arrivalMs: arrival }, [buf])
  }

  /* ───────── 재생 파이프라인 ───────── */

  private contextFor(rate: number): Promise<AudioContext> {
    let p = this.contexts.get(rate)
    if (!p) {
      p = (async () => {
        let ctx: AudioContext
        try {
          ctx = new AudioContext({ sampleRate: rate, latencyHint: 'interactive' })
        } catch {
          ctx = new AudioContext({ latencyHint: 'interactive' })
          this.emit({ type: 'warning', code: 'resampled_playback', message: `AudioContext at ${rate} Hz unsupported; playing at ${ctx.sampleRate}` })
        }
        await ctx.audioWorklet.addModule(playbackWorkletUrl)
        if (ctx.state !== 'running') { try { await ctx.resume() } catch { /* 제스처 */ } }
        return ctx
      })()
      this.contexts.set(rate, p)
    }
    return p
  }

  private createPlayback(peer: number, fmt: LosslessFormat): PeerPlayback {
    const fs = calcFrameSamples(fmt.sampleRate, fmt.frameMs)
    // 컨텍스트는 비동기로 뜬다 — 그동안 도착한 프레임은 큐에 쌓아 두고 노드가 생기면 흘려보낸다
    const pending: unknown[] = []
    const port = { postMessage: (m: unknown, _t?: Transferable[]) => { pending.push(m) } } as unknown as MessagePort
    const pb: PeerPlayback = {
      peer, format: fmt, ctx: null as unknown as AudioContext, node: { port } as unknown as AudioWorkletNode, gain: null as unknown as GainNode,
      reassembler: new Reassembler(), fec: new ParityDecoder(), fecOn: fmt.fec, expected: null, missing: new Map(), nacked: new Set(),
      pushed: new Set(), bytesWindow: 0,
      stats: {
        peer, format: fmt, bitrateBps: 0, packets: 0, targetMs: 0, depthMs: 0, jitterP95Ms: 0, jitterMeanMs: 0, received: 0, lost: 0,
        recoveredFec: 0, recoveredNack: 0, nackSent: 0, plc: 0, late: 0, underruns: 0, dropped: 0, duplicates: 0, bitExactPlayback: false,
        level: { peak: [], rms: [] },
      },
    }
    void this.contextFor(fmt.sampleRate).then((ctx) => {
      if (this.playbacks.get(peer) !== pb) return
      const node = new AudioWorkletNode(ctx, 'jw-lossless-playback', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [fmt.channels],
        processorOptions: { frameSamples: fs, sampleRate: fmt.sampleRate, channels: fmt.channels, preset: this.preset },
      })
      const gain = ctx.createGain()
      gain.gain.value = this.deafened ? 0 : 1
      node.connect(gain).connect(ctx.destination)
      node.port.onmessage = (ev) => this.onPlaybackMessage(pb, ev.data)
      pb.ctx = ctx
      pb.node = node
      pb.gain = gain
      pb.stats.bitExactPlayback = ctx.sampleRate === fmt.sampleRate
      if (!pb.stats.bitExactPlayback) this.emit({ type: 'warning', code: 'resampled_playback', message: `peer ${peer}: stream ${fmt.sampleRate} Hz played at ${ctx.sampleRate} Hz` })
      for (const m of pending) node.port.postMessage(m, [(m as { buf: ArrayBuffer }).buf])
      pending.length = 0
    })
    return pb
  }

  private destroyPlayback(pb: PeerPlayback): void {
    try { pb.node?.disconnect?.() } catch { /* ignore */ }
    try { pb.gain?.disconnect?.() } catch { /* ignore */ }
  }

  private onPlaybackMessage(pb: PeerPlayback, m: any): void {
    if (m?.type === 'level') {
      pb.stats.level = { peak: m.peak, rms: m.rms }
      this.emit({ type: 'level', peer: pb.peer, peak: m.peak, rms: m.rms })
    } else if (m?.type === 'stats') {
      const s = pb.stats
      s.targetMs = m.targetMs
      s.depthMs = m.depthMs
      s.jitterP95Ms = m.jitterP95Ms
      s.jitterMeanMs = m.jitterMeanMs
      s.lost = m.lost
      s.plc = m.plc
      s.late = m.late
      s.underruns = m.underruns
      s.dropped = m.dropped
      s.duplicates = m.duplicates
    }
  }

  /* ───────── 제어 ───────── */

  setMuted(muted: boolean): void {
    this.muted = muted
  }

  get isMuted(): boolean {
    return this.muted
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened
    for (const pb of this.playbacks.values()) if (pb.gain) pb.gain.gain.value = deafened ? 0 : 1
  }

  /** 코덱/비트/프레임 길이 변경(샘플레이트는 장치가 정한다). 패리티 그룹은 새로 시작 */
  setFormat(f: Partial<Pick<LosslessFormat, 'codec' | 'bits' | 'frameMs' | 'fec'>>): void {
    this.requested = { ...this.requested, ...f }
    if (f.codec && !f.bits) this.requested.bits = bitsFor(f.codec)
    if (!this.format) return
    const next: LosslessFormat = { ...this.format, ...f }
    if (f.codec && !f.bits) next.bits = bitsFor(f.codec)
    if (next.codec === 'flac') {
      this.emit({ type: 'warning', code: 'flac_unavailable', message: 'FLAC encoder not bundled; staying on PCM' })
      next.codec = this.format.codec
      next.bits = this.format.bits
    }
    this.format = next
    this.parity.reset()
    if (f.frameMs && this.captureNode) this.captureNode.port.postMessage({ type: 'frameSamples', value: calcFrameSamples(next.sampleRate, next.frameMs) })
    if (this.capture) this.emit({ type: 'format', format: next, capture: this.capture })
  }

  setBufferPreset(p: BufferPreset): void {
    this.preset = p
    for (const pb of this.playbacks.values()) pb.node?.port?.postMessage({ type: 'preset', value: p })
  }

  getPeers(): PeerInfo[] {
    return [...this.peers.values()]
  }

  /** 피어(또는 'self')의 0..1 레벨(peak 최대) */
  peerLevel(peer: number | 'self'): number {
    const lv = peer === 'self' ? this.capture?.level : this.playbacks.get(peer)?.stats.level
    return lv && lv.peak.length ? Math.max(...lv.peak) : 0
  }

  /* ───────── 통계 ───────── */

  private tick(): void {
    this.bitrateOut = this.bytesOutWindow * 8
    this.bytesOutWindow = 0
    for (const pb of this.playbacks.values()) {
      pb.stats.bitrateBps = pb.bytesWindow * 8
      pb.bytesWindow = 0
    }
    const tr = this.transport
    if (tr && this.state === 'connected') {
      tr.sendUnreliable(encodePing(performance.now()))
      const report: Record<string, unknown> = {
        t: 'stats', transport: tr.kind, fallback_reason: this.fallbackReason, bitrate_out_bps: this.bitrateOut, rtt_ms: Math.round(this.rttMs * 10) / 10,
        peers: Object.fromEntries([...this.playbacks.values()].map((pb) => [pb.peer, {
          target_ms: Math.round(pb.stats.targetMs), depth_ms: Math.round(pb.stats.depthMs), jitter_p95_ms: Math.round(pb.stats.jitterP95Ms * 10) / 10,
          lost: pb.stats.lost, recovered_fec: pb.stats.recoveredFec, recovered_nack: pb.stats.recoveredNack, plc: pb.stats.plc, underruns: pb.stats.underruns,
        }])),
      }
      tr.sendReliable(encodeCtrl(report))
    }
    this.emit({ type: 'stats', stats: this.getStats() })
  }

  getStats(): SessionStats & { fallbackReason: FallbackReason | null } {
    const peers: Record<number, PeerReceiveStats> = {}
    let bufferMs = 0
    let outLatency = 0
    for (const pb of this.playbacks.values()) {
      peers[pb.peer] = { ...pb.stats, level: { ...pb.stats.level } }
      bufferMs = Math.max(bufferMs, pb.stats.targetMs)
      if (pb.ctx) outLatency = Math.max(outLatency, ((pb.ctx.outputLatency ?? 0) + pb.ctx.baseLatency) * 1000)
    }
    const frameMs = this.format?.frameMs ?? 0
    return {
      state: this.state,
      transport: this.transport?.kind ?? null,
      fallbackReason: this.fallbackReason,
      room: this.room,
      peerId: this.peerId,
      format: this.format,
      capture: this.capture ? { ...this.capture, level: { ...this.capture.level } } : null,
      bitrateOutBps: this.bitrateOut,
      framesSent: this.framesSent,
      rttMs: this.rttMs,
      estimatedLatencyMs: frameMs + this.rttMs / 2 + bufferMs + outLatency,
      latencyBreakdown: { frameMs, networkMs: this.rttMs / 2, bufferMs, outputMs: outLatency },
      bufferPreset: this.preset,
      peers,
      relay: this.relayStats,
    }
  }
}

export { Codec }
