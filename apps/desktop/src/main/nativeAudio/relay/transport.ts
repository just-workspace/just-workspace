/**
 * 릴레이 전송(Node/Electron 메인) — WebTransport 기본, WebSocket 폴백. 브라우저 lib/lossless/transport.ts 와 같은 인터페이스·같은 와이어.
 *
 * WebTransport: @fails-components/webtransport(BSD-3) + http3-quiche 프리빌드(N-API). Node 에 WebTransport API 가 없어 고른 것.
 *   선택 근거(r19 평가): 운영 릴레이(LE 인증서) 핸드셰이크 42 ms, 데이터그램 1215 B, 인증서 불일치 호스트는 거부(검증 동작 확인).
 *   ESM 전용이라 CJS 메인에서 dynamic import() 로 올린다. 바이너리는 asarUnpack.
 * WebSocket: ws(MIT). 토큰은 Sec-WebSocket-Protocol 하위 프로토콜(쿼리 금지 — PROTOCOL.md §4.1).
 *
 * 선택/폴백 정책(브라우저 transportSelector 와 동일): WT 핸드셰이크 1.8 s 안에 안 되면 WS, 60 s 뒤 WT 재시도. 세션이 돈다.
 */
import { WebSocket } from 'ws';
import { encodeCtrl, hexToBytes, streamFrame, StreamParser } from './protocol';

export type TransportKind = 'webtransport' | 'websocket';

export interface RelayGrant {
  token: string;
  expires_in: number;
  room: string;
  identity?: string | null;
  ws_url: string;
  ws_path?: string;
  webtransport: { url: string; self_signed?: boolean; cert_hash?: string; not_after?: string } | null;
}

export interface RelayTransport {
  readonly kind: TransportKind;
  readonly maxDatagram: number;
  onPacket: ((pkt: Uint8Array, reliable: boolean) => void) | null;
  onClose: ((reason: string) => void) | null;
  connect(timeoutMs: number): Promise<void>;
  sendUnreliable(pkt: Uint8Array): void;
  sendReliable(pkt: Uint8Array): void;
  close(reason?: string): void;
}

export class TransportTimeout extends Error {
  constructor(kind: TransportKind, ms: number) {
    super(`${kind} handshake timed out after ${ms} ms`);
    this.name = 'TransportTimeout';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(onTimeout()), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/* ───────────── WebSocket(ws) ───────────── */

export class WebSocketTransport implements RelayTransport {
  readonly kind = 'websocket' as const;
  readonly maxDatagram = Infinity;
  onPacket: RelayTransport['onPacket'] = null;
  onClose: RelayTransport['onClose'] = null;
  private ws: WebSocket | null = null;
  private closed = false;

  constructor(private readonly url: string, private readonly token: string) {}

  connect(timeoutMs: number): Promise<void> {
    const open = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url, ['jw.relay', `jw.token.${Buffer.from(this.token, 'utf8').toString('base64url')}`], { perMessageDeflate: false });
      ws.binaryType = 'nodebuffer';
      this.ws = ws;
      ws.on('open', () => resolve());
      ws.on('error', (e) => reject(new Error(`websocket error: ${(e as Error).message}`)));
      ws.on('message', (data, isBinary) => {
        if (!isBinary) return;
        const b = data as Buffer;
        this.onPacket?.(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), true);
      });
      ws.on('close', (code, reason) => {
        if (this.closed) return;
        this.closed = true;
        this.onClose?.(reason?.toString() || `websocket closed (${code})`);
      });
    });
    return withTimeout(open, timeoutMs, () => { this.close('timeout'); return new TransportTimeout('websocket', timeoutMs); });
  }

  sendUnreliable(pkt: Uint8Array): void { this.sendReliable(pkt); }

  sendReliable(pkt: Uint8Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1_000_000) { this.close('send buffer overflow'); return; }
    ws.send(pkt, { binary: true });
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    try { this.ws?.close(1000, reason.slice(0, 120)); } catch { /* ignore */ }
    this.onClose?.(reason);
  }
}

/* ───────────── WebTransport(@fails-components) ───────────── */

/** ESM 전용 모듈 — CJS 메인에서 dynamic import() 로 올린다. 타입은 느슨하게(패키지 .d.ts 는 ESM 해석 전용) */
type WtModule = { WebTransport: new (url: string, opts?: unknown) => any; quicheLoaded: Promise<unknown> };
let wtModule: Promise<WtModule | null> | null = null;

/** 모듈을 올려 본다(프리빌드 바이너리가 없거나 로드 실패면 null → WebSocket 만 쓴다) */
export function loadWebTransport(): Promise<WtModule | null> {
  wtModule ??= (async () => {
    try {
      const m = (await import('@fails-components/webtransport')) as unknown as WtModule;
      await m.quicheLoaded;
      return m;
    } catch (e) {
      console.warn('[hires] WebTransport module unavailable, WebSocket only:', (e as Error)?.message ?? e);
      return null;
    }
  })();
  return wtModule;
}

export class WebTransportTransport implements RelayTransport {
  readonly kind = 'webtransport' as const;
  private _maxDatagram = 1200;
  onPacket: RelayTransport['onPacket'] = null;
  onClose: RelayTransport['onClose'] = null;
  private wt: any = null;
  private streamWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private dgWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private dgQueue: Uint8Array[] = [];
  private dgDraining = false;
  private reliableQueue: Uint8Array[] = [];
  private reliableDraining = false;
  private closed = false;
  static readonly MAX_DG_QUEUE = 64;

  constructor(private readonly url: string, private readonly token: string, private readonly certHashHex?: string) {}

  get maxDatagram(): number { return this._maxDatagram; }

  async connect(timeoutMs: number): Promise<void> {
    const m = await loadWebTransport();
    if (!m) throw new Error('webtransport module unavailable');
    // quicConnectTimeout: 라이브러리 내부 QUIC 타임아웃(기본 8 s)을 우리 핸드셰이크 한도에 맞춘다 — 포기한 뒤 늦게 거부되는 프로미스를 줄인다
    const opts: Record<string, unknown> = { congestionControl: 'low-latency', quicConnectTimeout: timeoutMs, webTransportConnectTimeout: timeoutMs };
    if (this.certHashHex) opts.serverCertificateHashes = [{ algorithm: 'sha-256', value: hexToBytes(this.certHashHex) }];
    const wt: any = new m.WebTransport(this.url, opts);
    this.wt = wt;
    // 늦은 거부(타임아웃 뒤 내부 타이머)가 unhandledRejection 으로 새지 않게 미리 받아 둔다
    (wt.ready as Promise<unknown>).catch(() => {});
    (wt.closed as Promise<unknown>).catch(() => {});
    let timedOut = false;
    try {
      await withTimeout(wt.ready, timeoutMs, () => { timedOut = true; return new TransportTimeout('webtransport', timeoutMs); });
      const ds = wt.datagrams;
      if (typeof ds.maxDatagramSize === 'number' && ds.maxDatagramSize > 0) this._maxDatagram = ds.maxDatagramSize;
      try { (ds as any).outgoingMaxAge = 50; (ds as any).incomingMaxAge = 100; } catch { /* 읽기 전용 */ }
      // 최신 스펙은 createWritable(); 옛 구현은 writable 속성
      this.dgWriter = typeof ds.createWritable === 'function' ? (await ds.createWritable()).getWriter() : ds.writable.getWriter();
      const bidi: any = await withTimeout(wt.createBidirectionalStream() as Promise<unknown>, timeoutMs, () => new TransportTimeout('webtransport', timeoutMs));
      const sw = bidi.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
      this.streamWriter = sw;
      await sw.write(streamFrame(encodeCtrl({ t: 'auth', token: this.token })));
      void this.readStream(bidi.readable);
      void this.readDatagrams(ds.readable);
      wt.closed.then(
        (info: any) => this.handleClosed(`webtransport closed (${info?.closeCode ?? 0}) ${info?.reason ?? ''}`.trim()),
        (err: any) => this.handleClosed(`webtransport error: ${err?.message ?? err}`),
      );
    } catch (e) {
      this.closed = true;
      try { wt.close(); } catch { /* ignore */ }
      if (timedOut) throw new TransportTimeout('webtransport', timeoutMs);
      throw e;
    }
  }

  private handleClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(reason);
  }

  private async readStream(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader();
    const parser = new StreamParser();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) for (const pkt of parser.push(value)) this.onPacket?.(pkt, true);
      }
    } catch { /* 세션 종료 */ }
  }

  private async readDatagrams(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) this.onPacket?.(value, false);
      }
    } catch { /* 세션 종료 */ }
  }

  sendUnreliable(pkt: Uint8Array): void {
    if (this.closed || !this.dgWriter) return;
    if (pkt.byteLength > this._maxDatagram) return;
    if (this.dgQueue.length >= WebTransportTransport.MAX_DG_QUEUE) this.dgQueue.shift();
    this.dgQueue.push(pkt);
    if (!this.dgDraining) void this.drainDatagrams();
  }

  private async drainDatagrams(): Promise<void> {
    this.dgDraining = true;
    try {
      while (this.dgQueue.length && this.dgWriter && !this.closed) await this.dgWriter.write(this.dgQueue.shift()!);
    } catch { /* 세션 종료 */ } finally { this.dgDraining = false; }
  }

  sendReliable(pkt: Uint8Array): void {
    if (this.closed || !this.streamWriter) return;
    this.reliableQueue.push(streamFrame(pkt));
    if (!this.reliableDraining) void this.drainReliable();
  }

  private async drainReliable(): Promise<void> {
    this.reliableDraining = true;
    try {
      while (this.reliableQueue.length && this.streamWriter && !this.closed) await this.streamWriter.write(this.reliableQueue.shift()!);
    } catch { /* 세션 종료 */ } finally { this.reliableDraining = false; }
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    try { this.wt?.close({ closeCode: 0, reason: reason.slice(0, 120) }); } catch { /* ignore */ }
    this.onClose?.(reason);
  }
}

export function createTransport(kind: TransportKind, grant: RelayGrant): RelayTransport {
  if (kind === 'webtransport') {
    if (!grant.webtransport?.url) throw new Error('relay offers no WebTransport endpoint');
    return new WebTransportTransport(grant.webtransport.url, grant.token, grant.webtransport.self_signed ? grant.webtransport.cert_hash : undefined);
  }
  return new WebSocketTransport(grant.ws_url, grant.token);
}

/* ───────────── 선택·폴백 상태기계(브라우저 transportSelector 와 동일) ───────────── */

export type FallbackReason = 'no_webtransport_api' | 'no_webtransport_endpoint' | 'handshake_timeout' | 'handshake_failed' | 'udp_blocked' | 'connection_lost_repeatedly' | 'datagram_too_small';
export type HandshakeOutcome = 'ok' | 'timeout' | 'failed' | 'udp_blocked' | 'datagram_too_small';

export class TransportSelector {
  readonly handshakeTimeoutMs: number;
  private wtBlockedUntil = -Infinity;
  private wtLosses: number[] = [];
  private _active: TransportKind | null = null;
  private _reason: FallbackReason | null = null;
  private _attempts = 0;

  constructor(private readonly env: { hasWebTransport: boolean; webtransportUrl: string | null },
              private readonly o: { now: () => number; handshakeTimeoutMs?: number; lossWindowMs?: number; maxLossesInWindow?: number; retryWebTransportAfterMs?: number }) {
    this.handshakeTimeoutMs = o.handshakeTimeoutMs ?? 1800;
    if (!env.hasWebTransport) this._reason = 'no_webtransport_api';
    else if (!env.webtransportUrl) this._reason = 'no_webtransport_endpoint';
  }
  get webTransportPossible(): boolean { return this.env.hasWebTransport && !!this.env.webtransportUrl; }
  get active(): TransportKind | null { return this._active; }
  get fallbackReason(): FallbackReason | null { return this._active === 'webtransport' ? null : this._reason; }
  get attempts(): number { return this._attempts; }
  next(): TransportKind {
    if (!this.webTransportPossible) return 'websocket';
    if (this.o.now() < this.wtBlockedUntil) return 'websocket';
    return 'webtransport';
  }
  recordHandshake(kind: TransportKind, outcome: HandshakeOutcome): void {
    this._attempts++;
    if (outcome === 'ok') { this._active = kind; if (kind === 'webtransport') this._reason = null; return; }
    if (kind === 'webtransport') {
      this._reason = outcome === 'timeout' ? 'handshake_timeout' : outcome === 'udp_blocked' ? 'udp_blocked' : outcome === 'datagram_too_small' ? 'datagram_too_small' : 'handshake_failed';
      this.wtBlockedUntil = this.o.now() + (this.o.retryWebTransportAfterMs ?? 60_000);
    }
    this._active = null;
  }
  recordDisconnect(kind: TransportKind): void {
    this._active = null;
    if (kind !== 'webtransport') return;
    const now = this.o.now();
    this.wtLosses = this.wtLosses.filter((t) => now - t < (this.o.lossWindowMs ?? 60_000));
    this.wtLosses.push(now);
    if (this.wtLosses.length >= (this.o.maxLossesInWindow ?? 3)) {
      this._reason = 'connection_lost_repeatedly';
      this.wtBlockedUntil = now + (this.o.retryWebTransportAfterMs ?? 60_000);
      this.wtLosses = [];
    }
  }
  shouldRetryWebTransport(): boolean { return this._active === 'websocket' && this.webTransportPossible && this.o.now() >= this.wtBlockedUntil; }
  msUntilRetry(): number { return Math.max(0, this.wtBlockedUntil - this.o.now()); }
}

export function classifyHandshakeError(err: unknown, timedOut: boolean): HandshakeOutcome {
  if (timedOut) return 'timeout';
  const msg = String((err as any)?.message ?? err ?? '').toLowerCase();
  if (/datagram/.test(msg)) return 'datagram_too_small';
  if (/quic|connection_refused|unreachable|udp|network|econnrefused|handshake failed/.test(msg)) return 'udp_blocked';
  return 'failed';
}
