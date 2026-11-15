/**
 * HiresSession — 데스크톱 하이레조 세션 하나(장치 두 개 + 릴레이 연결). Electron 메인(또는 Node 하네스)에서 돈다. 렌더러는 IPC 로만 본다.
 *
 * 송신: 캡처 장치(exclusive, 요청 포맷) → 링 → 프레임(frameMs) → 와이어 코덱(장치 포맷 그대로: s16/s24/s32/f32) → XOR 패리티 4:1
 *       → 릴레이(WebTransport 데이터그램 기본, WebSocket 폴백). 브라우저 무손실 피어와 같은 프로토콜이라 서로 들린다.
 * 수신: 패킷 → 재조립 → FEC/NACK → 피어별 지터버퍼(바이트 프레임) → (단일 피어·포맷 일치면 바이트 그대로 / 아니면 Float64 믹스·리샘플)
 *       → 재생 링 → 재생 장치(exclusive). 재생 레이트 ≠ 스트림 레이트이면 speex 리샘플 + bitPerfect=false.
 * 비트퍼펙트 = 캡처 exclusive·변환 없음(24-in-32 >>8 허용) && 재생 exclusive·단일 피어·무손실 변환만.
 */
import { EventEmitter } from 'node:events';
import type { Device, NativeAudioAddon, Resampler, SampleFormat, TestSignal } from '../../../native';
import { listHiresDevices, nativeAudio, openNegotiated, type HiresDevice, type OpenedDevice } from './engine';
import { describeFormat, wireBitrate, type FailReason } from './negotiate';
import {
  bytesPerSample, codecForFormat, convertInt, formatForCodec, frameSamples as calcFrameSamples, fromFloat64, losslessConversion, mix,
  remapChannels, rmsToDb, toFloat64, type PcmCodec,
} from './relay/codec';
import { ParityDecoder, ParityEncoder } from './relay/fec';
import { JitterBuffer, type BufferPreset, type JitterStats } from './relay/jitter';
import {
  Codec, Flag, Reassembler, Type, codecName, decode, decodeCtrl, decodePingPayload, encodeCtrl, encodeNack, encodePing, fragment, groupBase,
  payloadOf, type Header,
} from './relay/protocol';
import {
  TransportSelector, TransportTimeout, classifyHandshakeError, createTransport, loadWebTransport, type FallbackReason, type RelayGrant,
  type RelayTransport, type TransportKind,
} from './relay/transport';

export type SessionState = 'idle' | 'opening' | 'open' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'failed';

export interface HiresOpenOptions {
  captureDevice?: string | null;
  playbackDevice?: string | null;
  rate: number;
  bits: 16 | 24 | 32;
  channels: 1 | 2;
  frameMs?: number;
  /** exclusive 가 안 되면 shared 로라도 연다(기본 false — 호출자가 무손실 24/48 로 내려간다) */
  allowShared?: boolean;
  fec?: boolean;
  bufferPreset?: BufferPreset;
  /** 테스트: 'null' 백엔드 + 신호 생성 */
  backend?: 'wasapi' | 'null';
  testSignal?: TestSignal;
  seed?: number;
  /** 테스트: 재생 장치를 열지 않는다 */
  noPlayback?: boolean;
}

export interface SideInfo {
  name: string;
  deviceId: string;
  exclusive: boolean;
  format: SampleFormat;
  bits: number;
  rate: number;
  channels: number;
  internalFormat: string;
  internalRate: number;
  bitPerfect: boolean;
  periodFrames: number;
}

export interface WireFormat { codec: PcmCodec; rate: number; bits: 16 | 24 | 32; channels: number; frameMs: number; frameSamples: number; fec: boolean }

export interface HiresOpenResult {
  ok: boolean;
  exclusive: boolean;
  bitPerfect: boolean;
  capture: SideInfo | null;
  playback: SideInfo | null;
  wire: WireFormat | null;
  /** 'PCM 32/192' */
  formatLabel: string | null;
  nominalBps: number;
  reason?: FailReason | 'addon_unavailable' | 'no_capture_device' | string;
  code?: string;
  app?: string | null;
  device: string;
  attempts: unknown[];
}

export interface PeerInfo { peer: number; uid: string; name?: string; identity?: string; transport: string }

export interface PeerRxStats {
  peer: number;
  format: { codec: string; rate: number; bits: number; channels: number; frameMs: number; fec: boolean } | null;
  bitrateBps: number;
  packets: number;
  received: number;
  lost: number;
  recoveredFec: number;
  recoveredNack: number;
  nackSent: number;
  plc: number;
  late: number;
  underruns: number;
  targetMs: number;
  depthMs: number;
  jitterP95Ms: number;
  /** 스트림 포맷 == 장치 포맷(또는 무손실 정수 상향) 이고 리샘플 없음 */
  bitExactPlayback: boolean;
  resampled: boolean;
  level: { peak: number[]; rms: number[] };
}

export interface HiresStats {
  state: SessionState;
  transport: TransportKind | null;
  fallbackReason: FallbackReason | null;
  room: string | null;
  peerId: number | null;
  capture: (SideInfo & { level: { peak: number[]; rms: number[] }; overruns: number; callbacks: number }) | null;
  playback: (SideInfo & { underruns: number; underrunFrames: number; queuedMs: number; callbacks: number }) | null;
  wire: WireFormat | null;
  formatLabel: string | null;
  exclusive: boolean;
  /** 송신(캡처) 비트퍼펙트 */
  bitPerfect: boolean;
  /** 수신 재생까지 비트퍼펙트(피어 전부) */
  playbackBitExact: boolean;
  resampling: boolean;
  bitrateOutBps: number;
  framesSent: number;
  rttMs: number;
  estimatedLatencyMs: number;
  bufferPreset: BufferPreset;
  peers: Record<number, PeerRxStats>;
  relay: unknown | null;
  muted: boolean;
  deafened: boolean;
}

export type HiresEvent =
  | { type: 'state'; state: SessionState; reason?: string }
  | { type: 'started'; result: HiresOpenResult }
  | { type: 'failed'; reason: string; code?: string; app?: string | null; device: string; attempts?: unknown[] }
  | { type: 'downgraded'; from: string; to: string; reason: string }
  | { type: 'connected'; transport: TransportKind; peerId: number; room: string; peers: PeerInfo[] }
  | { type: 'transport_fallback'; from: TransportKind; to: TransportKind; reason: string }
  | { type: 'peer_joined'; peer: PeerInfo }
  | { type: 'peer_left'; peer: number; uid: string }
  | { type: 'peer_format'; peer: number; format: PeerRxStats['format'] }
  | { type: 'needGrant' }
  | { type: 'warning'; code: string; message: string }
  | { type: 'stats'; stats: HiresStats }
  | { type: 'error'; message: string };

interface PeerRx {
  peer: number;
  codec: PcmCodec;
  streamFormat: SampleFormat;
  rate: number;
  bits: number;
  channels: number;
  frameSamples: number;
  frameBytes: number;
  fec: boolean;
  reassembler: Reassembler;
  parity: ParityDecoder;
  jitter: JitterBuffer;
  expected: number | null;
  missing: Map<number, number>;
  nacked: Set<number>;
  pushed: Set<number>;
  resampler: Resampler | null;
  /** 리샘플 뒤 남는 샘플(interleaved Float64) */
  fifo: number[];
  bytesWindow: number;
  stats: PeerRxStats;
}

const DEFAULT_FRAME_MS = 10;

export interface HiresSessionHooks {
  /** 토큰 만료·재접속 때 새 grant. 없으면 'needGrant' 이벤트 뒤 setGrant() 를 기다린다 */
  refreshGrant?: () => Promise<RelayGrant>;
  /** 테스트 계측 */
  onFrameSent?: (seq: number, payload: Uint8Array) => void;
  onFrameReceived?: (peer: number, seq: number, payload: Uint8Array, how: 'none' | 'fec' | 'nack') => void;
  /** 테스트: 재생 링에 쓴 장치 프레임 */
  onPlayoutFrame?: (bytes: Uint8Array, bitExact: boolean) => void;
  now?: () => number;
  handshakeTimeoutMs?: number;
  retryWebTransportAfterMs?: number;
}

export class HiresSession extends EventEmitter {
  private state: SessionState = 'idle';
  private opts: HiresOpenOptions | null = null;
  private cap: OpenedDevice | null = null;
  private pb: OpenedDevice | null = null;
  private wire: WireFormat | null = null;
  private openResult: HiresOpenResult | null = null;
  private capFrameBuf: Uint8Array | null = null;
  private seq = 0;
  private ts = 0;
  private framesSent = 0;
  private parity = new ParityEncoder();
  private bytesOutWindow = 0;
  private bitrateOut = 0;
  private muted = false;
  private deafened = false;
  private preset: BufferPreset = 'auto';
  // 릴레이
  private grant: RelayGrant | null = null;
  private transport: RelayTransport | null = null;
  private selector: TransportSelector | null = null;
  private peerId: number | null = null;
  private room: string | null = null;
  private peers = new Map<number, PeerInfo>();
  private rx = new Map<number, PeerRx>();
  private rttMs = 0;
  private relayStats: unknown | null = null;
  private closing = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private playTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private grantWaiters: Array<(g: RelayGrant) => void> = [];
  private playbackBitExact = true;
  private resampling = false;
  private readonly now: () => number;

  constructor(private readonly hooks: HiresSessionHooks = {}) {
    super();
    this.now = hooks.now ?? (() => performance.now());
  }

  get currentState(): SessionState { return this.state; }
  get isMuted(): boolean { return this.muted; }

  private setState(state: SessionState, reason?: string): void {
    this.state = state;
    this.emitEv({ type: 'state', state, reason });
  }
  private emitEv(ev: HiresEvent): void { this.emit('event', ev); }

  // ───────────────────────── 장치 ─────────────────────────

  listDevices(): { capture: HiresDevice[]; playback: HiresDevice[] } {
    return listHiresDevices(this.opts?.backend ?? 'wasapi');
  }

  /**
   * 장치를 연다(릴레이는 connect 에서). exclusive 가 안 되고 allowShared 가 아니면 ok=false 로 돌려주고 장치를 닫는다 —
   * 호출자(렌더러 어댑터)가 danger 띠 + 무손실 24/48 로 내려간다.
   */
  open(o: HiresOpenOptions): HiresOpenResult {
    if (this.cap || this.pb) this.closeDevices();
    this.opts = { ...o, frameMs: o.frameMs ?? DEFAULT_FRAME_MS, backend: o.backend ?? 'wasapi', fec: o.fec !== false };
    this.preset = o.bufferPreset ?? 'auto';
    this.setState('opening');
    const n = nativeAudio();
    const deviceLabel = o.captureDevice ?? '';
    if (!n) return this.fail({ ok: false, exclusive: false, bitPerfect: false, capture: null, playback: null, wire: null, formatLabel: null, nominalBps: 0, reason: 'addon_unavailable', device: deviceLabel, attempts: [] });

    const backend = this.opts.backend!;
    const devices = listHiresDevices(backend);
    const capDev = o.captureDevice ? devices.capture.find((d) => d.id === o.captureDevice) : devices.capture.find((d) => d.isDefault) ?? devices.capture[0];
    const pbDev = o.playbackDevice ? devices.playback.find((d) => d.id === o.playbackDevice) : devices.playback.find((d) => d.isDefault) ?? devices.playback[0];
    if (!capDev) return this.fail({ ok: false, exclusive: false, bitPerfect: false, capture: null, playback: null, wire: null, formatLabel: null, nominalBps: 0, reason: 'no_capture_device', device: deviceLabel, attempts: [] });

    const req = { rate: o.rate, bits: o.bits, channels: o.channels, frameMs: this.opts.frameMs!, backend, testSignal: o.testSignal, seed: o.seed, allowShared: !!o.allowShared };
    let cap: OpenedDevice;
    try {
      cap = openNegotiated('capture', capDev.id, req, capDev.exclusiveFormats);
    } catch (e) {
      const err = e as { code?: string; reason?: string; attempts?: unknown[]; blockingApp?: string | null; message: string };
      return this.fail({ ok: false, exclusive: false, bitPerfect: false, capture: null, playback: null, wire: null, formatLabel: null, nominalBps: 0, reason: err.reason ?? 'unknown', code: err.code, app: err.blockingApp ?? null, device: capDev.name, attempts: err.attempts ?? [] });
    }
    this.cap = cap;
    // null 백엔드(테스트)엔 exclusive 개념이 없다 — 변환 없이 열렸으면 exclusive·비트퍼펙트로 친다
    const exclusiveOk = cap.exclusive || backend === 'null';
    if (!exclusiveOk && !o.allowShared) {
      const r = this.fail({ ok: false, exclusive: false, bitPerfect: false, capture: this.sideInfo(cap), playback: null, wire: null, formatLabel: null, nominalBps: 0, reason: cap.failReason ?? 'unknown', code: cap.failCode ?? undefined, app: cap.blockingApp, device: capDev.name, attempts: cap.attempts });
      this.closeDevices();
      return r;
    }

    // 와이어 포맷 = 캡처 장치 포맷 그대로
    const ci = cap.info;
    const codec = codecForFormat(ci.format);
    const fs = calcFrameSamples(ci.sampleRate, this.opts.frameMs!);
    this.wire = { codec, rate: ci.sampleRate, bits: ci.bits as 16 | 24 | 32, channels: ci.channels, frameMs: this.opts.frameMs!, frameSamples: fs, fec: this.opts.fec! && codec !== 'pcm_f32' ? true : this.opts.fec! };
    this.capFrameBuf = new Uint8Array(fs * ci.channels * bytesPerSample(ci.format));

    // 재생: 캡처와 같은 포맷으로 시도(수신 스트림이 보통 같은 레이트) — 안 되면 후보 하향, 그래도 안 되면 shared
    let pb: OpenedDevice | null = null;
    if (!o.noPlayback && pbDev) {
      try {
        pb = openNegotiated('playback', pbDev.id, { ...req, rate: ci.sampleRate, bits: ci.bits as 16 | 24 | 32, allowShared: true, testSignal: 'none' }, pbDev.exclusiveFormats);
      } catch (e) {
        this.emitEv({ type: 'warning', code: 'playback_open_failed', message: (e as Error).message });
      }
    }
    this.pb = pb;

    const capBitPerfect = exclusiveOk && (!!ci.bitPerfect || (backend === 'null' && !ci.converterActive));
    const result: HiresOpenResult = {
      ok: true,
      exclusive: exclusiveOk,
      bitPerfect: capBitPerfect,
      capture: this.sideInfo(cap),
      playback: pb ? this.sideInfo(pb) : null,
      wire: this.wire,
      formatLabel: describeFormat({ bits: this.wire.bits, rate: this.wire.rate }),
      nominalBps: wireBitrate(this.wire.rate, this.wire.bits, this.wire.channels, this.wire.frameMs, this.wire.fec),
      reason: exclusiveOk ? undefined : cap.failReason ?? undefined,
      code: cap.failCode ?? undefined,
      app: cap.blockingApp,
      device: capDev.name,
      attempts: cap.attempts,
    };
    this.openResult = result;
    if (!exclusiveOk) this.emitEv({ type: 'downgraded', from: 'exclusive', to: 'shared', reason: cap.failReason ?? 'unknown' });
    else if (ci.sampleRate !== o.rate || ci.bits !== o.bits) this.emitEv({ type: 'downgraded', from: describeFormat({ bits: o.bits, rate: o.rate }), to: result.formatLabel!, reason: 'unsupported_format' });

    // 캡처 펌프
    cap.dev.setDataCallback(() => this.drainCapture());
    cap.dev.start();
    if (pb) { pb.dev.start(); this.startPlayout(); }
    this.setState('open');
    this.emitEv({ type: 'started', result });
    return result;
  }

  private fail(r: HiresOpenResult): HiresOpenResult {
    this.openResult = r;
    this.setState('failed', r.reason);
    this.emitEv({ type: 'failed', reason: String(r.reason ?? 'unknown'), code: r.code, app: r.app ?? null, device: r.device, attempts: r.attempts });
    return r;
  }

  private sideInfo(d: OpenedDevice): SideInfo {
    const i = d.info;
    return {
      name: i.name ?? '', deviceId: i.deviceId ?? '', exclusive: i.shareMode === 'exclusive', format: i.format, bits: i.bits, rate: i.sampleRate, channels: i.channels,
      internalFormat: i.internalFormat ?? i.format, internalRate: i.internalSampleRate ?? i.sampleRate, bitPerfect: !!i.bitPerfect, periodFrames: i.internalPeriodFrames ?? i.periodFrames,
    };
  }

  private closeDevices(): void {
    if (this.playTimer) clearInterval(this.playTimer);
    this.playTimer = null;
    for (const d of [this.cap, this.pb]) {
      if (!d) continue;
      try { d.dev.setDataCallback(null); } catch { /* noop */ }
      try { d.dev.stop(); } catch { /* noop */ }
      try { d.dev.close(); } catch { /* noop */ }
    }
    this.cap = null;
    this.pb = null;
    for (const r of this.rx.values()) r.resampler?.destroy();
    this.rx.clear();
  }

  // ───────────────────────── 송신 ─────────────────────────

  private drainCapture(): void {
    const cap = this.cap;
    const buf = this.capFrameBuf;
    const w = this.wire;
    if (!cap || !buf || !w) return;
    for (;;) {
      if (cap.dev.available() < buf.byteLength) break;
      const n = cap.dev.read(buf);
      if (n < buf.byteLength) break;
      this.sendFrame(buf, w);
    }
  }

  private sendFrame(payload: Uint8Array, w: WireFormat): void {
    const tr = this.transport;
    const seq = this.seq;
    const ts = this.ts;
    this.ts = (this.ts + w.frameSamples) >>> 0;
    if (!tr || this.state !== 'connected') return;  // 접속 전엔 버린다(seq 도 안 올린다)
    this.seq = (this.seq + 1) >>> 0;
    this.framesSent++;
    const h: Partial<Header> & { type: number } = {
      type: Type.Audio, codec: Codec[w.codec], channels: w.channels, bits: w.bits, frame: w.frameSamples, rate: w.rate, seq, ts,
      flags: w.fec ? Flag.FEC : 0,
    };
    if (this.muted) {
      this.send(fragment({ ...h, flags: (h.flags ?? 0) | Flag.Muted }, new Uint8Array(0), tr.maxDatagram)[0]);
      this.parity.reset();
      return;
    }
    const copy = payload.slice();
    this.hooks.onFrameSent?.(seq, copy);
    for (const pkt of fragment(h, copy, tr.maxDatagram)) this.send(pkt);
    if (w.fec) {
      const par = this.parity.push(seq, copy);
      if (par) for (const pkt of fragment({ ...h, type: Type.Parity, seq: par.seq }, par.payload, tr.maxDatagram)) this.send(pkt);
    }
  }

  private send(pkt: Uint8Array): void {
    this.bytesOutWindow += pkt.byteLength;
    this.transport?.sendUnreliable(pkt);
  }

  // ───────────────────────── 릴레이 접속 ─────────────────────────

  async connect(grant: RelayGrant): Promise<void> {
    if (!this.cap) throw new Error('open() first');
    if (this.state === 'connected' || this.state === 'connecting') return;
    this.closing = false;
    this.grant = grant;
    this.room = grant.room;
    this.setState('connecting');
    const wtMod = await loadWebTransport();  // 모듈 유무(hasWebTransport)와 릴레이 WT 주소 유무(endpoint)를 따로 보고한다
    this.selector = new TransportSelector(
      { hasWebTransport: !!wtMod, webtransportUrl: grant.webtransport?.url ?? null },
      { now: () => this.now(), handshakeTimeoutMs: this.hooks.handshakeTimeoutMs, retryWebTransportAfterMs: this.hooks.retryWebTransportAfterMs },
    );
    try {
      await this.connectWithFallback();
    } catch (e) {
      this.setState('failed', (e as Error).message);
      throw e;
    }
    if (!this.tickTimer) this.tickTimer = setInterval(() => this.tick(), 1000);
  }

  setGrant(grant: RelayGrant): void {
    this.grant = grant;
    const ws = this.grantWaiters;
    this.grantWaiters = [];
    for (const w of ws) w(grant);
  }

  private async freshGrant(): Promise<RelayGrant> {
    if (this.hooks.refreshGrant) return this.hooks.refreshGrant();
    // 렌더러에 부탁하고 10 s 기다린다
    return new Promise<RelayGrant>((resolve, reject) => {
      const t = setTimeout(() => { this.grantWaiters = this.grantWaiters.filter((w) => w !== resolve); reject(new Error('grant refresh timed out')); }, 10_000);
      this.grantWaiters.push((g) => { clearTimeout(t); resolve(g); });
      this.emitEv({ type: 'needGrant' });
    });
  }

  private async connectWithFallback(): Promise<void> {
    const sel = this.selector!;
    for (let attempt = 0; attempt < 3; attempt++) {
      const kind = sel.next();
      try {
        await this.connectAs(kind);
        sel.recordHandshake(kind, 'ok');
        if (kind === 'websocket' && sel.webTransportPossible) this.scheduleWebTransportRetry();
        return;
      } catch (e) {
        const timedOut = e instanceof TransportTimeout;
        sel.recordHandshake(kind, classifyHandshakeError(e, timedOut));
        if (kind === 'webtransport') {
          this.emitEv({ type: 'transport_fallback', from: 'webtransport', to: 'websocket', reason: `${sel.fallbackReason}: ${(e as Error).message}` });
          continue;
        }
        throw e;
      }
    }
    throw new Error('relay unreachable over WebTransport and WebSocket');
  }

  private async connectAs(kind: TransportKind): Promise<void> {
    const grant = this.grant!;
    const tr = createTransport(kind, grant);
    const timeout = this.selector!.handshakeTimeoutMs;
    const welcome = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new TransportTimeout(kind, timeout * 2)), timeout * 2);
      tr.onPacket = (pkt, reliable) => {
        const h = decode(pkt);
        if (!h) return;
        if (h.type === Type.Ctrl) {
          const m = decodeCtrl<any>(payloadOf(pkt));
          if (m?.t === 'welcome') { clearTimeout(t); this.onWelcome(tr, m); resolve(); return; }
        }
        this.onPacket(tr, pkt, h, reliable);
      };
      tr.onClose = (reason) => { clearTimeout(t); reject(new Error(reason)); this.onTransportClosed(tr, reason); };
    });
    welcome.catch(() => { /* connect 실패가 먼저면 의미 없음 */ });
    await tr.connect(timeout);
    await welcome;
  }

  private onWelcome(tr: RelayTransport, m: { peer: number; room: string; peers: PeerInfo[] }): void {
    const old = this.transport;
    this.transport = tr;
    old?.close('replaced');
    this.peerId = m.peer;
    this.room = m.room;
    this.peers.clear();
    for (const p of m.peers ?? []) this.peers.set(p.peer, p);
    this.setState('connected');
    this.emitEv({ type: 'connected', transport: tr.kind, peerId: m.peer, room: m.room, peers: [...this.peers.values()] });
  }

  private onTransportClosed(tr: RelayTransport, reason: string): void {
    if (this.transport !== tr || this.closing) return;
    this.transport = null;
    this.selector?.recordDisconnect(tr.kind);
    this.setState('reconnecting', reason);
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    try {
      this.grant = await this.freshGrant();
      await this.connectWithFallback();
    } catch (e) {
      if (this.closing) return;
      this.setState('failed', (e as Error).message);
      this.emitEv({ type: 'error', message: (e as Error).message });
    }
  }

  private scheduleWebTransportRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const sel = this.selector!;
    const wait = Math.max(1000, sel.msUntilRetry());
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      if (this.closing || !sel.shouldRetryWebTransport() || this.transport?.kind !== 'websocket') return;
      try {
        this.grant = await this.freshGrant();
        await this.connectAs('webtransport');
        sel.recordHandshake('webtransport', 'ok');
        this.emitEv({ type: 'transport_fallback', from: 'websocket', to: 'webtransport', reason: 'webtransport available again' });
      } catch (e) {
        sel.recordHandshake('webtransport', classifyHandshakeError(e, e instanceof TransportTimeout));
        this.scheduleWebTransportRetry();
      }
    }, wait);
  }

  // ───────────────────────── 수신 ─────────────────────────

  private onPacket(tr: RelayTransport, pkt: Uint8Array, h: Header, reliable: boolean): void {
    if (tr !== this.transport && this.transport !== null) return;
    const arrival = this.now();
    switch (h.type) {
      case Type.Audio:
      case Type.Parity:
        this.onMedia(pkt, h, arrival);
        break;
      case Type.Pong: {
        const sent = decodePingPayload(payloadOf(pkt));
        if (sent !== null) { const rtt = arrival - sent; this.rttMs = this.rttMs ? this.rttMs + (rtt - this.rttMs) / 4 : rtt; }
        break;
      }
      case Type.Ping:
        pkt[1] = Type.Pong;
        if (reliable) tr.sendReliable(pkt); else tr.sendUnreliable(pkt);
        break;
      case Type.Ctrl:
        this.onCtrl(decodeCtrl<any>(payloadOf(pkt)));
        break;
    }
  }

  private onCtrl(m: any): void {
    if (!m) return;
    switch (m.t) {
      case 'peer_joined':
        this.peers.set(m.peer, { peer: m.peer, uid: m.uid, name: m.name, identity: m.identity, transport: m.transport });
        this.emitEv({ type: 'peer_joined', peer: this.peers.get(m.peer)! });
        break;
      case 'peer_left': {
        this.peers.delete(m.peer);
        const r = this.rx.get(m.peer);
        if (r) { r.resampler?.destroy(); this.rx.delete(m.peer); }
        this.emitEv({ type: 'peer_left', peer: m.peer, uid: m.uid });
        break;
      }
      case 'stats':
        this.relayStats = m;
        break;
    }
  }

  private onMedia(pkt: Uint8Array, h: Header, arrival: number): void {
    if (h.src === 0 || h.src === this.peerId) return;
    if (h.rate === 0 || h.channels === 0 || h.frame === 0) return;
    const name = codecName(h.codec);
    const sf = name === 'unknown' ? null : formatForCodec(name);
    if (!sf) return;  // flac/opus 는 아직 디코더 없음 — 버린다
    let r = this.rx.get(h.src);
    if (r && (r.rate !== h.rate || r.channels !== h.channels || r.bits !== h.bits || r.frameSamples !== h.frame || r.streamFormat !== sf)) {
      r.resampler?.destroy();
      this.rx.delete(h.src);
      r = undefined;
    }
    if (!r) {
      r = this.createRx(h.src, sf, h);
      this.rx.set(h.src, r);
      this.emitEv({ type: 'peer_format', peer: h.src, format: r.stats.format });
    }
    r.stats.packets++;
    r.bytesWindow += pkt.byteLength;
    r.fec = (h.flags & Flag.FEC) !== 0;
    const re = r.reassembler.push(pkt, h);
    if (!re) return;
    if (h.type === Type.Parity) {
      const rec = r.parity.addParity(re.header.seq, re.payload);
      if (rec) this.deliverRecovered(r, rec.seq, rec.payload, arrival);
      this.checkMissing(r, arrival);
      return;
    }
    const seq = re.header.seq;
    const retx = (re.header.flags & Flag.Retransmit) !== 0;
    let how: 'none' | 'nack' = 'none';
    if (retx && r.nacked.has(seq)) { r.stats.recoveredNack++; r.nacked.delete(seq); how = 'nack'; }
    const muted = (re.header.flags & Flag.Muted) !== 0 || re.payload.byteLength === 0;
    if (!r.pushed.has(seq) && !muted) this.hooks.onFrameReceived?.(r.peer, seq, re.payload, how);
    r.missing.delete(seq);
    this.trackGaps(r, seq, arrival);
    if (r.fec && !r.pushed.has(seq) && !muted) r.parity.addFrame(seq, re.payload.slice());
    this.deliver(r, seq, muted ? new Uint8Array(r.frameBytes) : re.payload, arrival);
    if (r.fec) {
      const rec = r.parity.tryRecover(groupBase(seq));
      if (rec) this.deliverRecovered(r, rec.seq, rec.payload, arrival);
      this.checkMissing(r, arrival);
    }
  }

  private createRx(peer: number, sf: SampleFormat, h: Header): PeerRx {
    const codec = codecForFormat(sf);
    const fs = h.frame;
    const frameMs = (fs / h.rate) * 1000;
    const pbi = this.pb?.info;
    const needResample = !!pbi && pbi.sampleRate !== h.rate;
    const n = nativeAudio();
    const resampler = needResample && n && pbi ? new n.Resampler(pbi.channels, h.rate, pbi.sampleRate, 8) : null;
    const lossless = !!pbi && !needResample && pbi.channels === h.channels && losslessConversion(sf, pbi.format);
    const r: PeerRx = {
      peer, codec, streamFormat: sf, rate: h.rate, bits: h.bits, channels: h.channels, frameSamples: fs, frameBytes: fs * h.channels * bytesPerSample(sf),
      fec: (h.flags & Flag.FEC) !== 0, reassembler: new Reassembler(), parity: new ParityDecoder(),
      jitter: new JitterBuffer({ frameSamples: fs, sampleRate: h.rate, channels: h.channels, format: sf, preset: this.preset, now: () => this.now() }),
      expected: null, missing: new Map(), nacked: new Set(), pushed: new Set(), resampler, fifo: [], bytesWindow: 0,
      stats: {
        peer, format: { codec, rate: h.rate, bits: h.bits, channels: h.channels, frameMs, fec: (h.flags & Flag.FEC) !== 0 }, bitrateBps: 0, packets: 0, received: 0, lost: 0,
        recoveredFec: 0, recoveredNack: 0, nackSent: 0, plc: 0, late: 0, underruns: 0, targetMs: 0, depthMs: 0, jitterP95Ms: 0,
        bitExactPlayback: lossless && (!!pbi?.bitPerfect || (this.opts?.backend === 'null' && !pbi?.converterActive)), resampled: needResample, level: { peak: [], rms: [] },
      },
    };
    if (needResample) this.emitEv({ type: 'warning', code: 'resampled_playback', message: `peer ${peer}: stream ${h.rate} Hz → device ${pbi!.sampleRate} Hz (speex, not bit-exact)` });
    return r;
  }

  private trackGaps(r: PeerRx, seq: number, arrival: number): void {
    if (r.expected === null) { r.expected = seq + 1; return; }
    if (seq >= r.expected) {
      const gap = seq - r.expected;
      if (gap > 0 && gap <= 64) for (let s = r.expected; s < seq; s++) if (!r.pushed.has(s)) r.missing.set(s, arrival);
      r.expected = seq + 1;
    }
    if (!r.fec) this.flushNacks(r, [...r.missing.keys()]);
  }

  private checkMissing(r: PeerRx, now: number): void {
    if (r.missing.size === 0) return;
    const due: number[] = [];
    const frameMs = (r.frameSamples / r.rate) * 1000;
    for (const [s, at] of r.missing) {
      if (r.pushed.has(s)) { r.missing.delete(s); continue; }
      const closed = r.expected !== null && r.expected > groupBase(s) + 4;
      if (closed || now - at > 2 * frameMs * 4) due.push(s);
    }
    this.flushNacks(r, due);
    for (const [s, at] of r.missing) if (now - at > 1000) r.missing.delete(s);
  }

  private flushNacks(r: PeerRx, seqs: number[]): void {
    const fresh = seqs.filter((s) => !r.nacked.has(s));
    if (fresh.length === 0 || !this.transport) return;
    for (const s of fresh) r.nacked.add(s);
    r.stats.nackSent += fresh.length;
    this.transport.sendReliable(encodeNack(r.peer, fresh));
    if (r.nacked.size > 512) r.nacked = new Set([...r.nacked].slice(-256));
  }

  private deliverRecovered(r: PeerRx, seq: number, payload: Uint8Array, arrival: number): void {
    if (r.pushed.has(seq)) return;
    r.stats.recoveredFec++;
    r.missing.delete(seq);
    this.hooks.onFrameReceived?.(r.peer, seq, payload, 'fec');
    this.deliver(r, seq, payload, arrival);
  }

  private deliver(r: PeerRx, seq: number, payload: Uint8Array, arrival: number): void {
    if (r.pushed.has(seq)) return;
    r.pushed.add(seq);
    if (r.pushed.size > 2048) r.pushed = new Set([...r.pushed].slice(-1024));
    if (payload.byteLength !== r.frameBytes) return;
    r.stats.received++;
    r.jitter.push(seq, payload.slice(), arrival);
  }

  // ───────────────────────── 재생(플레이아웃) ─────────────────────────

  private startPlayout(): void {
    const pb = this.pb;
    const w = this.wire;
    if (!pb || !w) return;
    const i = pb.info;
    const devFrameSamples = calcFrameSamples(i.sampleRate, w.frameMs);
    const devFrameBytes = devFrameSamples * i.channels * bytesPerSample(i.format);
    const targetQueued = devFrameBytes * 3;  // 장치 콜백 2주기 + 여유
    const silence = new Uint8Array(devFrameBytes);
    const period = Math.max(2, Math.floor(w.frameMs / 2));
    this.playTimer = setInterval(() => {
      let guard = 0;
      while (pb.dev.queued() < targetQueued && guard++ < 16) {
        const frame = this.deafened ? silence : this.mixOnce(devFrameSamples, devFrameBytes, i.format, i.channels, i.sampleRate);
        if (pb.dev.write(frame) === 0) break;
      }
    }, period);
  }

  /** 모든 피어에서 프레임 하나씩 꺼내 장치 프레임 하나를 만든다. 단일 피어·포맷 일치면 바이트 그대로 */
  private mixOnce(devFrames: number, devBytes: number, devFormat: SampleFormat, devCh: number, devRate: number): Uint8Array {
    const active: PeerRx[] = [];
    for (const r of this.rx.values()) active.push(r);
    if (active.length === 0) { this.hooks.onPlayoutFrame?.(new Uint8Array(devBytes), false); return new Uint8Array(devBytes); }

    const pulls: Array<{ r: PeerRx; bytes: Uint8Array; real: boolean }> = [];
    for (const r of active) {
      const p = r.jitter.pull();
      pulls.push({ r, bytes: p.bytes, real: p.kind === 'ok' });
    }
    // 빠른 길: 피어 하나, 레이트·채널 같음, 무손실 변환
    if (pulls.length === 1) {
      const { r, bytes, real } = pulls[0];
      if (r.rate === devRate && r.channels === devCh && losslessConversion(r.streamFormat, devFormat)) {
        const out = r.streamFormat === devFormat ? bytes : convertInt(bytes, r.streamFormat, devFormat);
        this.playbackBitExact = !!this.pb?.info.bitPerfect || (this.opts?.backend === 'null' && !this.pb?.info.converterActive);
        this.resampling = false;
        this.hooks.onPlayoutFrame?.(out, real);
        return out;
      }
    }
    // 일반 길: Float64 로 풀어 (리샘플) 믹스
    this.playbackBitExact = false;
    const inputs: Float64Array[] = [];
    let anyResample = false;
    for (const { r, bytes } of pulls) {
      let x = toFloat64(bytes, r.streamFormat);
      if (!x) continue;
      x = remapChannels(x, r.channels, devCh);
      if (r.resampler) {
        anyResample = true;
        const f32 = Float32Array.from(x);
        const y = r.resampler.process(f32);
        for (let k = 0; k < y.length; k++) r.fifo.push(y[k]);
        const need = devFrames * devCh;
        const take = new Float64Array(need);
        const have = Math.min(need, r.fifo.length);
        for (let k = 0; k < have; k++) take[k] = r.fifo[k];
        r.fifo.splice(0, have);
        if (r.fifo.length > need * 8) r.fifo.splice(0, r.fifo.length - need * 4);  // 드리프트로 쌓이면 자른다
        x = take;
      }
      inputs.push(x);
    }
    this.resampling = anyResample;
    const mixed = mix(inputs, devFrames * devCh);
    const out = fromFloat64(mixed, devFormat);
    this.hooks.onPlayoutFrame?.(out, false);
    return out;
  }

  // ───────────────────────── 제어 ─────────────────────────

  setMuted(m: boolean): void { this.muted = m; }
  setDeafened(d: boolean): void { this.deafened = d; }
  setBufferPreset(p: BufferPreset): void {
    this.preset = p;
    for (const r of this.rx.values()) r.jitter.setPreset(p);
  }
  getPeers(): PeerInfo[] { return [...this.peers.values()]; }

  /** 캡처 레벨 L/R(dBFS) */
  levels(): { left: number; right: number } {
    const s = this.cap?.dev.stats();
    if (!s || this.muted || !s.rms.length) return { left: -100, right: -100 };
    const l = rmsToDb(s.rms[0]);
    const r = rmsToDb(s.rms[1] ?? s.rms[0]);
    return { left: l, right: r };
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const tr = this.transport;
    this.transport = null;
    tr?.close('leave');
    this.closeDevices();
    this.peers.clear();
    this.peerId = null;
    this.wire = null;
    this.capFrameBuf = null;
    this.seq = 0;
    this.ts = 0;
    this.parity.reset();
    this.setState('closed');
  }

  // ───────────────────────── 통계 ─────────────────────────

  private tick(): void {
    this.bitrateOut = this.bytesOutWindow * 8;
    this.bytesOutWindow = 0;
    for (const r of this.rx.values()) { r.stats.bitrateBps = r.bytesWindow * 8; r.bytesWindow = 0; }
    const tr = this.transport;
    if (tr && this.state === 'connected') {
      tr.sendUnreliable(encodePing(this.now()));
      const report: Record<string, unknown> = {
        t: 'stats', client: 'desktop-hires', transport: tr.kind, fallback_reason: this.selector?.fallbackReason ?? null, bitrate_out_bps: this.bitrateOut,
        rtt_ms: Math.round(this.rttMs * 10) / 10, exclusive: this.openResult?.exclusive ?? false, bit_perfect: this.openResult?.bitPerfect ?? false,
        peers: Object.fromEntries([...this.rx.values()].map((r) => { const j = r.jitter.stats(); return [r.peer, { target_ms: Math.round(j.targetMs), depth_ms: Math.round(j.depthMs), lost: j.lost, recovered_fec: r.stats.recoveredFec, recovered_nack: r.stats.recoveredNack, plc: j.plc, underruns: j.underruns, resampled: r.stats.resampled }]; })),
      };
      tr.sendReliable(encodeCtrl(report));
    }
    this.emitEv({ type: 'stats', stats: this.getStats() });
  }

  getStats(): HiresStats {
    const peers: Record<number, PeerRxStats> = {};
    let bufferMs = 0;
    let allBitExact = this.rx.size > 0;
    for (const r of this.rx.values()) {
      const j: JitterStats = r.jitter.stats();
      r.stats.targetMs = j.targetMs; r.stats.depthMs = j.depthMs; r.stats.jitterP95Ms = j.jitterP95Ms; r.stats.lost = j.lost; r.stats.plc = j.plc; r.stats.late = j.late; r.stats.underruns = j.underruns;
      peers[r.peer] = { ...r.stats };
      bufferMs = Math.max(bufferMs, j.targetMs);
      allBitExact = allBitExact && r.stats.bitExactPlayback;
    }
    const capS = this.cap?.dev.stats();
    const pbS = this.pb?.dev.stats();
    const w = this.wire;
    const pbi = this.pb?.info;
    const queuedMs = pbS && pbi ? (pbS.ringBytes / (pbi.channels * bytesPerSample(pbi.format))) / pbi.sampleRate * 1000 : 0;
    const outputMs = pbi ? ((pbi.internalPeriodFrames ?? pbi.periodFrames) * (pbi.internalPeriods ?? 2)) / pbi.sampleRate * 1000 : 0;
    return {
      state: this.state,
      transport: this.transport?.kind ?? null,
      fallbackReason: this.selector?.fallbackReason ?? null,
      room: this.room,
      peerId: this.peerId,
      capture: this.cap ? { ...this.sideInfo(this.cap), level: { peak: capS?.peak ?? [], rms: capS?.rms ?? [] }, overruns: capS?.overruns ?? 0, callbacks: capS?.callbacks ?? 0 } : null,
      playback: this.pb ? { ...this.sideInfo(this.pb), underruns: pbS?.underruns ?? 0, underrunFrames: pbS?.underrunFrames ?? 0, queuedMs, callbacks: pbS?.callbacks ?? 0 } : null,
      wire: w,
      formatLabel: this.openResult?.formatLabel ?? null,
      exclusive: this.openResult?.exclusive ?? false,
      bitPerfect: this.openResult?.bitPerfect ?? false,
      playbackBitExact: this.rx.size ? allBitExact && this.playbackBitExact : (!!pbi?.bitPerfect || (this.opts?.backend === 'null' && !!pbi && !pbi.converterActive)),
      resampling: this.resampling,
      bitrateOutBps: this.bitrateOut,
      framesSent: this.framesSent,
      rttMs: this.rttMs,
      estimatedLatencyMs: (w?.frameMs ?? 0) + this.rttMs / 2 + bufferMs + queuedMs + outputMs,
      bufferPreset: this.preset,
      peers,
      relay: this.relayStats,
      muted: this.muted,
      deafened: this.deafened,
    };
  }
}
