/**
 * LiveKit(WebRTC Opus) 전송 — 음성·음악 단계. VoiceTransport 구현.
 *
 *  · 캡처·publish 옵션은 lib/voice/opus.ts 레시피, answer 의 cbr/useinbandfec 는 lib/voice/sdp.ts 로 강제.
 *  · 단계를 바꾸면 마이크 트랙을 새로 만들어 다시 publish 한다(제약·stereo 는 트랙 생성 때 정해진다).
 *  · 화면 공유 소리(음악 공유)는 createScreenTracks 로 받은 소리 트랙만 publish(영상은 바로 멈춤), 늘 음악 레시피.
 *    BUNDLE 안에서 opus payload type 의 fmtp 는 구간마다 같아야 하므로, 음악 공유 중엔 answer fmtp 전체가 음악 값이다
 *    (마이크가 음성 단계라도 그동안 DTX·FEC 가 꺼진다 — encodings.maxBitrate 32k 는 그대로).
 *  · 받은 소리는 자체 숨은 <div> 안 <audio> 로 낸다(회의 화면이 없어도 소리가 나야 한다). 듣기 끔 = 요소 muted.
 *  · 통계는 송신 트랙 getRTCStatsReport(sender.getStats) + 수신 트랙 것 → lib/voice/stats.summarizeStats.
 *  · 레벨 미터는 publish 중인 MediaStreamTrack(Krisp 가 붙었으면 처리 뒤 트랙)을 AudioContext 로 갈라 L/R RMS.
 */
import type {
  LocalAudioTrack, LocalTrack, Participant, RemoteTrack, RemoteTrackPublication, Room as RoomT, Track as TrackT,
} from 'livekit-client'
import { captureFor, fmtpFor, isOpusTier, musicStereo, processingOf, publishFor, screenAudioConfig } from '../opus'
import { installSdpMunger, setActiveOpusFmtp } from '../sdp'
import { EMPTY_STATS, rms, rmsToDb, summarizeStats, type StatsSnapshot } from '../stats'
import type {
  VoiceConnectionState, VoiceJoinParams, VoiceLevels, VoicePeer, VoiceSendConfig, VoiceStats, VoiceTier,
  VoiceTransport, VoiceTransportEvents,
} from '../transport'

type LK = typeof import('livekit-client')
let _lk: LK | null = null
let _lkLoading: Promise<LK> | null = null
function loadLk(): Promise<LK> {
  if (_lk) return Promise.resolve(_lk)
  _lkLoading ??= import('livekit-client').then((m) => { _lk = m; return m }, (e) => { _lkLoading = null; throw e })
  return _lkLoading
}

/** useMeetings 와 같은 키 — 이 탭에서 Krisp 가 이미 실패했으면 다시 시도하지 않는다 */
const KRISP_OFF_KEY = 'meet.krisp.unavailable'
function krispKnownUnavailable(): boolean {
  try { return sessionStorage.getItem(KRISP_OFF_KEY) === '1' } catch { return false }
}
function markKrispUnavailable() {
  try { sessionStorage.setItem(KRISP_OFF_KEY, '1') } catch { /* noop */ }
}

type Listeners = { [K in keyof VoiceTransportEvents]: Set<VoiceTransportEvents[K]> }

/** getUserMedia 가 "권한 없음·장치 없음" 으로 실패했나(그 밖은 진짜 오류) */
export function isMicUnavailable(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? ''
  return /^(NotAllowedError|PermissionDeniedError|SecurityError|NotFoundError|DevicesNotFoundError|NotReadableError|TrackStartError)$/.test(name)
}

export class LiveKitVoiceTransport implements VoiceTransport {
  readonly tiers: readonly VoiceTier[] = ['voice', 'music']

  private room: RoomT | null = null
  private lk: LK | null = null
  private cfg: VoiceSendConfig | null = null
  private micTrack: LocalAudioTrack | null = null
  private screenAudio: LocalAudioTrack | null = null
  private muted = false
  private deafened = false
  private krispActive = false
  private sink: HTMLDivElement | null = null
  private attached = new Map<string, HTMLMediaElement[]>()
  private listeners: Listeners = { state: new Set(), peers: new Set(), ended: new Set() }
  private snap: StatsSnapshot | null = null
  // 레벨 미터
  private ctx: AudioContext | null = null
  private analysers: [AnalyserNode, AnalyserNode] | null = null
  private meterSrc: MediaStreamAudioSourceNode | null = null
  private meterBuf = new Float32Array(1024)
  private meterTrackId: string | null = null
  /** 마이크 권한이 없어(또는 장치가 없어) 듣기만 — join 은 그래도 성공한다 */
  private micDenied = false

  micState(): 'ok' | 'denied' { return this.micDenied ? 'denied' : 'ok' }

  /** 한 참가자의 수신 음량(음악 공유 띠 [공유 음량], 0..1) — 그 사람에게 붙인 <audio> 전부. 사람별 음량(setParticipantGain)과 곱한다 */
  setParticipantVolume(identity: string, volume: number): void {
    this.shareVol.set(identity, Math.max(0, Math.min(1, volume)))
    this.applyVolume(identity)
  }

  /**
   * 사람별 음량(0..2 = 0–200%) — 나만 듣는 음량. 1 이하는 <audio>.volume, 1 을 넘으면
   * 그 트랙을 WebAudio GainNode 로 돌려 키운다(요소는 음소거한 채 붙여 둔다 — 크롬은 원격 WebRTC 소리가 요소에 붙어 있어야 흐른다).
   */
  setParticipantGain(identity: string, gain: number): void {
    const g = Math.max(0, Math.min(2, Number.isFinite(gain) ? gain : 1))
    if (g === 1) this.userGain.delete(identity); else this.userGain.set(identity, g)
    this.applyVolume(identity)
  }

  private shareVol = new Map<string, number>()
  private userGain = new Map<string, number>()
  private tracks = new Map<string, RemoteTrack>()
  private boostCtx: AudioContext | null = null
  private boost = new Map<string, { src: MediaStreamAudioSourceNode; gain: GainNode }>()

  private applyVolume(identity: string) {
    for (const key of this.attached.keys()) if (key.startsWith(`${identity}:`)) this.applyKey(key)
  }
  /** 한 트랙(identity:sid)에 듣기 끔 · 개별 끔 · 음량을 적용 */
  private applyKey(key: string) {
    const identity = key.slice(0, key.indexOf(':'))
    const els = this.attached.get(key) ?? []
    const silenced = this.deafened || this.silenced.has(identity)
    const v = (this.shareVol.get(identity) ?? 1) * (this.userGain.get(identity) ?? 1)
    if (v > 1 && !silenced && this.ensureBoost(key)) {
      this.boost.get(key)!.gain.gain.value = v
      els.forEach(el => { el.muted = true; el.volume = 1 })
      return
    }
    this.dropBoost(key)
    els.forEach(el => { el.muted = silenced; el.volume = Math.min(1, v) })
  }
  private ensureBoost(key: string): boolean {
    if (this.boost.has(key)) return true
    const mst = this.tracks.get(key)?.mediaStreamTrack
    if (!mst || typeof AudioContext === 'undefined') return false
    try {
      if (!this.boostCtx) {
        this.boostCtx = new AudioContext()
        const sink = this.speakerId()
        const ctxSink = this.boostCtx as AudioContext & { setSinkId?: (id: string) => Promise<void> }
        if (sink && ctxSink.setSinkId) void ctxSink.setSinkId(sink).catch(() => {})
      }
      const ctx = this.boostCtx
      const src = ctx.createMediaStreamSource(new MediaStream([mst]))
      const gain = ctx.createGain()
      src.connect(gain).connect(ctx.destination)
      void ctx.resume().catch(() => {})
      this.boost.set(key, { src, gain })
      return true
    } catch { return false }
  }
  private dropBoost(key: string) {
    const b = this.boost.get(key)
    if (!b) return
    try { b.src.disconnect(); b.gain.disconnect() } catch { /* noop */ }
    this.boost.delete(key)
  }

  // ─── 이벤트 ───
  on<K extends keyof VoiceTransportEvents>(ev: K, fn: VoiceTransportEvents[K]): () => void {
    (this.listeners[ev] as Set<VoiceTransportEvents[K]>).add(fn)
    return () => { (this.listeners[ev] as Set<VoiceTransportEvents[K]>).delete(fn) }
  }
  private emit<K extends keyof VoiceTransportEvents>(ev: K, ...args: Parameters<VoiceTransportEvents[K]>) {
    for (const fn of this.listeners[ev]) { try { (fn as (...a: unknown[]) => void)(...args) } catch { /* 리스너 오류는 전송을 막지 않는다 */ } }
  }

  effectiveTier(): VoiceTier {
    const t = this.cfg?.tier ?? 'voice'
    return isOpusTier(t) ? t : 'music'   // 무손실·하이레조는 아직 없다 → 음악으로 강등
  }

  // ─── 접속 ───
  async join(params: VoiceJoinParams): Promise<void> {
    const lk = await loadLk()
    this.lk = lk
    installSdpMunger()
    this.cfg = this.normalize(params.send)
    this.muted = params.muted
    this.applyFmtp()
    const { Room, RoomEvent } = lk
    const room = new Room({
      adaptiveStream: false,
      dynacast: false,
      // 캡처·publish 기본값은 트랙을 직접 만들어 넘기므로 여기선 보조(화면 공유 등)
      publishDefaults: { ...publishFor(this.cfg), videoCodec: 'vp9' },
      audioCaptureDefaults: captureFor(this.cfg, false),
      ...(this.speakerId() ? { audioOutput: { deviceId: this.speakerId()! } } : {}),
    })
    this.room = room
    const refresh = () => this.emit('peers', this.peers())
    room.on(RoomEvent.ParticipantConnected, refresh)
    room.on(RoomEvent.ParticipantDisconnected, refresh)
    room.on(RoomEvent.ActiveSpeakersChanged, refresh)
    room.on(RoomEvent.TrackMuted, refresh)
    room.on(RoomEvent.TrackUnmuted, refresh)
    room.on(RoomEvent.TrackPublished, refresh)
    room.on(RoomEvent.TrackUnpublished, refresh)
    room.on(RoomEvent.LocalTrackPublished, refresh)
    room.on(RoomEvent.LocalTrackUnpublished, refresh)
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: Participant) => { this.onSubscribed(track, p); refresh() })
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: Participant) => { this.onUnsubscribed(track, p); refresh() })
    room.on(RoomEvent.Reconnecting, () => this.emit('state', 'reconnecting'))
    room.on(RoomEvent.Reconnected, () => { this.emit('state', 'connected'); refresh() })
    room.on(RoomEvent.Disconnected, (reason?: unknown) => {
      this.emit('state', 'disconnected')
      this.emit('ended', String(reason ?? 'disconnected'))
    })
    this.ensureSink()
    this.emit('state', 'connecting')
    await room.connect(params.url, params.token, { autoSubscribe: true, peerConnectionTimeout: 30_000, websocketTimeout: 30_000 })
    this.emit('state', 'connected')
    await this.publishMic()
    refresh()
  }

  async leave(): Promise<void> {
    setActiveOpusFmtp(null)
    const room = this.room
    this.room = null
    this.stopMeter()
    try { if (this.screenAudio) { this.screenAudio.stop() } } catch { /* noop */ }
    this.screenAudio = null
    try { if (this.micTrack) { this.micTrack.stop() } } catch { /* noop */ }
    this.micTrack = null
    if (room) { try { await room.disconnect(true) } catch { /* noop */ } }
    for (const els of this.attached.values()) els.forEach(el => el.remove())
    for (const key of [...this.boost.keys()]) this.dropBoost(key)
    if (this.boostCtx) { void this.boostCtx.close().catch(() => {}); this.boostCtx = null }
    this.attached.clear()
    this.tracks.clear()
    this.sink?.remove()
    this.sink = null
    this.snap = null
    this.emit('state', 'disconnected')
  }

  // ─── 송신 설정 ───
  private normalize(cfg: VoiceSendConfig): VoiceSendConfig {
    return isOpusTier(cfg.tier) ? { ...cfg } : { ...cfg, tier: 'music' }
  }
  private speakerId(): string | undefined {
    return (this.cfg as unknown as { speakerDeviceId?: string } | null)?.speakerDeviceId
  }
  /** answer fmtp — 음악 공유 중이거나 음악 단계면 음악 값, 아니면 음성 값 */
  private applyFmtp() {
    if (!this.cfg) { setActiveOpusFmtp(null); return }
    const music = this.cfg.tier === 'music' || !!this.screenAudio
    setActiveOpusFmtp(fmtpFor(music ? screenAudioConfig(this.cfg) : this.cfg))
  }

  /**
   * 송신 설정 적용은 한 줄로 세운다. 슬라이더를 끌면 setSend 가 겹쳐 들어오는데, 예전엔 publishMic 이 동시에 돌아
   * 마이크 트랙이 둘 올라가고(하나는 음소거·나가기가 닿지 않는다) 상대가 이중으로 들었다.
   * 기다리는 동안 더 새 설정이 들어오면 중간 것은 건너뛴다 — 비교 기준은 "실제로 올라가 있는 트랙의 설정"(micCfg).
   */
  private sendChain: Promise<void> = Promise.resolve()
  private sendGen = 0
  private micCfg: VoiceSendConfig | null = null

  setSend(cfg: VoiceSendConfig): Promise<void> {
    const next = this.normalize(cfg)
    // 마이크를 바꾸면 한쪽 채널 판정을 다시 한다
    if (this.monoFallback && next.micDeviceId !== this.monoFallbackDevice) { this.monoFallback = false; this.oneSidedTicks = 0 }
    const prevSpk = this.speakerId()
    this.cfg = next
    this.applyFmtp()
    if (!this.room) return Promise.resolve()
    const gen = ++this.sendGen
    const run = this.sendChain.then(async () => {
      const room = this.room
      if (!room) return
      if (gen === this.sendGen) {
        const prev = this.micCfg
        const now = this.cfg ?? next
        const changed = !prev || prev.tier !== now.tier || prev.musicBitrate !== now.musicBitrate
          || prev.micDeviceId !== now.micDeviceId || prev.krisp !== now.krisp
          || prev.echoCancellation !== now.echoCancellation || prev.noiseSuppression !== now.noiseSuppression || prev.autoGainControl !== now.autoGainControl
        // 마이크 권한이 없어 듣기만이면 [다시 시도] = setSend — 바뀐 게 없어도 다시 만든다
        if (changed || this.micDenied) await this.publishMic()
      }
      // 스피커: 특정 장치 → "기본 장치"로 되돌릴 때도 바꾼다(예전엔 값이 있을 때만 바꿔 옛 장치로 계속 났다)
      const spk = this.speakerId()
      if (spk !== prevSpk && this.room === room) {
        try { await room.switchActiveDevice('audiooutput', spk || 'default') } catch { /* 미지원 브라우저 */ }
        const ctxSink = this.boostCtx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null
        if (ctxSink?.setSinkId) void ctxSink.setSinkId(spk || '').catch(() => {})   // 100% 넘게 키운 사람 소리도 같은 장치로
      }
    })
    this.sendChain = run.catch(() => {})
    return run
  }

  /** 마이크 트랙을 (다시) 만들어 publish. 기존 트랙은 unpublish + stop */
  private async publishMic() {
    const room = this.room
    const lk = this.lk
    if (!room || !lk || !this.cfg) return
    const cfg = this.cfg
    const old = this.micTrack
    this.micTrack = null
    this.micCfg = null
    // 만드는 도중 나갔으면(권한 창이 떠 있는 채 퇴장 등) 트랙을 멈춘다 — 안 그러면 브라우저 마이크 표시가 탭을 닫을 때까지 켜져 있다
    const gone = () => this.room !== room
    if (old) {
      try { await room.localParticipant.unpublishTrack(old, true) } catch { /* noop */ }
    }
    this.krispActive = false
    // 스테레오로 보낼 때는 Krisp 를 붙이지 않는다 — 모노 처리기라 한 채널만 채울 수 있다(브라우저 잡음 제거는 그대로)
    const stereo = musicStereo(cfg) && !this.monoFallback
    const wantKrisp = isOpusTier(cfg.tier) && cfg.krisp && processingOf(cfg).ns && !stereo && !krispKnownUnavailable()
    let track: LocalAudioTrack
    try {
      // 한 채널만 쓰는 2채널 장치로 판정됐으면(monoFallback) 모노로 잡는다 — 브라우저가 두 채널을 합쳐 양쪽 귀에 난다
      track = await lk.createLocalAudioTrack({ ...captureFor(cfg, false), ...(this.monoFallback ? { channelCount: 1 } : {}) })
      this.micDenied = false
    } catch (e) {
      // 권한 없음·장치 없음 — 들어가는 건 막지 않는다("권한 없음": 듣기만으로 접속). 그 밖의 오류는 그대로 던진다
      if (isMicUnavailable(e)) { this.micDenied = true; this.emit('peers', this.peers()); return }
      throw e
    }
    if (wantKrisp) {
      try {
        const { KrispNoiseFilter, isKrispNoiseFilterSupported } = await import('@livekit/krisp-noise-filter')
        if (isKrispNoiseFilterSupported()) {
          await track.setProcessor(KrispNoiseFilter())
          this.krispActive = true
          // Krisp 가 붙었으니 브라우저 NS 는 끈다(이중 처리)
          try { await track.mediaStreamTrack.applyConstraints({ noiseSuppression: false }) } catch { /* noop */ }
        } else markKrispUnavailable()
      } catch { markKrispUnavailable() }
    }
    try {
      if (gone()) { track.stop(); return }
      if (this.muted) await track.mute()
      const pub = { ...publishFor(cfg), ...(this.monoFallback ? { forceStereo: false } : {}) }
      await room.localParticipant.publishTrack(track, { ...pub, source: lk.Track.Source.Microphone, name: 'microphone' })
    } catch (e) {
      try { track.stop() } catch { /* noop */ }
      if (gone()) return   // 나가는 중에 끊긴 것 — 오류가 아니다
      throw e
    }
    if (gone()) { try { track.stop() } catch { /* noop */ } return }
    this.micTrack = track
    this.micCfg = cfg
    // publish 를 기다리는 사이 누른 음소거를 놓치지 않는다
    if (track.isMuted !== this.muted) { try { if (this.muted) await track.mute(); else await track.unmute() } catch { /* noop */ } }
    this.snap = null
    this.startMeter(track)
  }

  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted
    if (!this.micTrack) return
    if (muted) await this.micTrack.mute()
    else await this.micTrack.unmute()
    this.emit('peers', this.peers())
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened
    for (const key of this.attached.keys()) this.applyKey(key)
  }

  async setScreenAudio(on: boolean): Promise<boolean> {
    const room = this.room
    const lk = this.lk
    if (!room || !lk || !this.cfg) return false
    if (!on) {
      const t = this.screenAudio
      this.screenAudio = null
      if (t) { try { await room.localParticipant.unpublishTrack(t, true) } catch { /* noop */ } }
      this.applyFmtp()
      this.emit('peers', this.peers())
      return true
    }
    if (this.screenAudio) return true
    const music = screenAudioConfig(this.cfg)
    let tracks: LocalTrack[]
    try {
      tracks = await room.localParticipant.createScreenTracks({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48_000 },
        video: true,
        systemAudio: 'include',
        selfBrowserSurface: 'include',
        suppressLocalAudioPlayback: false,
      })
    } catch {
      return false   // 사용자가 취소했다
    }
    const audio = tracks.find(t => t.kind === lk.Track.Kind.Audio) as LocalAudioTrack | undefined
    for (const t of tracks) if (t !== audio) { try { t.stop() } catch { /* noop */ } }
    if (!audio) return false
    this.screenAudio = audio
    this.applyFmtp()
    await room.localParticipant.publishTrack(audio, { ...publishFor(music), source: lk.Track.Source.ScreenShareAudio, name: 'music' })
    // 사용자가 브라우저 UI 의 "공유 중지" 를 누르면 트랙이 끝난다
    audio.on(lk.TrackEvent.Ended, () => { void this.setScreenAudio(false) })
    this.snap = null
    this.emit('peers', this.peers())
    return true
  }

  // ─── 수신 재생 ───
  /**
   * 한 참가자의 수신 소리를 끈다/켠다(듣기 끔과 별개). 무손실 전송이 같은 사람의 PCM 스트림을 받는 동안
   * 그 사람의 Opus 호환 트랙을 겹쳐 내지 않기 위해 쓴다. 나중에 구독되는 트랙에도 적용된다.
   */
  setParticipantAudioMuted(identity: string, muted: boolean): void {
    if (muted) this.silenced.add(identity)
    else this.silenced.delete(identity)
    this.applyVolume(identity)
  }
  private silenced = new Set<string>()

  attachRemoteAudio(container: HTMLElement | null): void {
    if (!container || !this.sink) return
    container.appendChild(this.sink)
  }
  private ensureSink() {
    if (this.sink || typeof document === 'undefined') return
    const d = document.createElement('div')
    d.hidden = true
    d.setAttribute('data-voice-sink', '')
    document.body.appendChild(d)
    this.sink = d
  }
  private onSubscribed(track: RemoteTrack, p: Participant) {
    if (!this.lk || track.kind !== this.lk.Track.Kind.Audio) return
    this.ensureSink()
    const el = track.attach()
    el.muted = this.deafened || this.silenced.has(p.identity)
    if (this.speakerId() && 'setSinkId' in el) { void (el as HTMLMediaElement & { setSinkId(id: string): Promise<void> }).setSinkId(this.speakerId()!).catch(() => {}) }
    this.sink?.appendChild(el)
    const key = `${p.identity}:${track.sid}`
    const list = this.attached.get(key) ?? []
    list.push(el)
    this.attached.set(key, list)
    this.tracks.set(key, track)
    this.applyKey(key)
  }
  private onUnsubscribed(track: RemoteTrack, p: Participant) {
    const key = `${p.identity}:${track.sid}`
    const els = this.attached.get(key)
    this.dropBoost(key)
    this.tracks.delete(key)
    if (els) { track.detach().forEach(el => el.remove()); els.forEach(el => el.remove()); this.attached.delete(key) }
  }

  // ─── 참가자 ───
  peers(): VoicePeer[] {
    const room = this.room
    const lk = this.lk
    if (!room || !lk) return []
    const build = (p: Participant, isLocal: boolean): VoicePeer => {
      let micMuted = true
      let sharingAudio = false
      p.trackPublications.forEach((pub) => {
        if (pub.source === lk.Track.Source.Microphone) micMuted = pub.isMuted
        else if (pub.source === lk.Track.Source.ScreenShareAudio) sharingAudio = true
      })
      return { identity: p.identity, name: p.name || p.identity, isLocal, isSpeaking: !!p.isSpeaking && !micMuted, micMuted, sharingAudio }
    }
    const out: VoicePeer[] = [build(room.localParticipant, true)]
    room.remoteParticipants.forEach((p) => {
      if (p.kind === lk.ParticipantKind.EGRESS || p.kind === lk.ParticipantKind.AGENT) return
      if ((p.identity || '').startsWith('EG_')) return
      out.push(build(p, false))
    })
    return out
  }

  // ─── 통계 ───
  async getStats(): Promise<VoiceStats> {
    const room = this.room
    if (!room) return { ...EMPTY_STATS }
    const send: RTCStatsReport[] = []
    const recv: RTCStatsReport[] = []
    const grab = async (t: TrackT | null | undefined, into: RTCStatsReport[]) => {
      if (!t) return
      try { const r = await (t as unknown as { getRTCStatsReport(): Promise<RTCStatsReport | undefined> }).getRTCStatsReport(); if (r) into.push(r) } catch { /* noop */ }
    }
    await grab(this.micTrack, send)
    await grab(this.screenAudio, send)
    const remotes: Promise<void>[] = []
    room.remoteParticipants.forEach((p) => {
      p.trackPublications.forEach((pub) => {
        if (pub.track && pub.kind === this.lk!.Track.Kind.Audio) remotes.push(grab(pub.track, recv))
      })
    })
    await Promise.all(remotes)
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const { stats, snap } = summarizeStats(send, recv, this.snap, now)
    this.snap = snap
    return stats
  }

  // ─── 레벨 미터 ───
  private startMeter(track: LocalAudioTrack) {
    const mst = track.mediaStreamTrack
    if (!mst || typeof AudioContext === 'undefined') return
    if (this.meterTrackId === mst.id && this.analysers) return
    this.stopMeter(false)
    try {
      this.ctx ??= new AudioContext({ sampleRate: 48_000 })
      const src = this.ctx.createMediaStreamSource(new MediaStream([mst]))
      const split = this.ctx.createChannelSplitter(2)
      const l = this.ctx.createAnalyser()
      const r = this.ctx.createAnalyser()
      l.fftSize = 1024; r.fftSize = 1024
      src.connect(split)
      split.connect(l, 0)
      split.connect(r, 1)
      this.meterSrc = src
      this.analysers = [l, r]
      this.meterTrackId = mst.id
      void this.ctx.resume().catch(() => {})
    } catch { this.analysers = null }
  }
  private stopMeter(close = true) {
    try { this.meterSrc?.disconnect() } catch { /* noop */ }
    this.meterSrc = null
    this.analysers = null
    this.meterTrackId = null
    if (close && this.ctx) { void this.ctx.close().catch(() => {}); this.ctx = null }
  }
  getLevels(): VoiceLevels {
    if (!this.analysers || this.muted) return { left: -100, right: -100 }
    const [l, r] = this.analysers
    l.getFloatTimeDomainData(this.meterBuf)
    const left = rmsToDb(rms(this.meterBuf))
    r.getFloatTimeDomainData(this.meterBuf)
    let right = rmsToDb(rms(this.meterBuf))
    // 모노 트랙은 두 번째 채널이 비어 있다 — 왼쪽을 그대로
    const mono = (this.micTrack?.mediaStreamTrack.getSettings().channelCount ?? 1) < 2
    if (mono) right = left
    else this.watchOneSided(left, right)
    return { left, right }
  }

  /**
   * 스테레오로 보내는 중인데 한 채널에만 소리가 있다(오디오 인터페이스의 입력 1, 2채널로 보고하는 일부 헤드셋·동글) —
   * 그대로면 듣는 사람 전원이 한쪽 귀로만 듣는다. 2초쯤 이어지면 모노로 다시 올린다. 장치를 바꾸면 다시 판정한다.
   * getLevels 는 접속 중 120ms 마다 불린다(useVoice 의 레벨 폴링).
   */
  private monoFallback = false
  private oneSidedTicks = 0
  private monoFallbackDevice: string | undefined
  private watchOneSided(left: number, right: number): void {
    if (this.monoFallback || !this.cfg || !musicStereo(this.cfg)) { this.oneSidedTicks = 0; return }
    const hi = Math.max(left, right)
    const lo = Math.min(left, right)
    if (hi > -50 && lo < -70) this.oneSidedTicks++
    else if (lo > -50) this.oneSidedTicks = 0   // 양쪽 다 소리 — 진짜 스테레오
    if (this.oneSidedTicks < 17) return
    this.oneSidedTicks = 0
    this.monoFallback = true
    this.monoFallbackDevice = this.cfg.micDeviceId
    this.micCfg = null   // 같은 설정이어도 다시 올리게
    if (this.cfg) void this.setSend({ ...this.cfg, ...(this.speakerId() ? { speakerDeviceId: this.speakerId() } : {}) } as VoiceSendConfig).catch(() => {})
  }

  /** 테스트·디버그용 */
  get connectionState(): VoiceConnectionState {
    const s = this.room?.state
    if (!s || s === 'disconnected') return 'disconnected'
    if (s === 'connecting') return 'connecting'
    if (s === 'reconnecting' || s === 'signalReconnecting') return 'reconnecting'
    return 'connected'
  }
}

export function createLiveKitVoiceTransport(): VoiceTransport {
  return new LiveKitVoiceTransport()
}
