/**
 * 릴레이 전송 두 가지 — WebTransport(기본, UDP 데이터그램) / WebSocket(폴백, nginx 경유).
 * 둘 다 동일한 인터페이스: 비신뢰(오디오·패리티) / 신뢰(제어·NACK·재전송) 두 경로.
 * WebSocket 은 두 경로 모두 동일 소켓을 사용한다. 선택·폴백 정책은 transportSelector.ts.
 */
import { encodeCtrl, hexToBytes, streamFrame, StreamParser } from './protocol'
import type { RelayGrant, TransportKind } from './types'

export interface RelayTransport {
  readonly kind: TransportKind
  /** 데이터그램 한도(바이트). WebSocket 은 Infinity */
  readonly maxDatagram: number
  onPacket: ((pkt: Uint8Array, reliable: boolean) => void) | null
  onClose: ((reason: string) => void) | null
  /** 연결·인증까지 수행. timeoutMs 내에 완료되지 않으면 reject(TransportTimeout) */
  connect(timeoutMs: number): Promise<void>
  sendUnreliable(pkt: Uint8Array): void
  sendReliable(pkt: Uint8Array): void
  close(reason?: string): void
}

export class TransportTimeout extends Error {
  constructor(kind: TransportKind, ms: number) {
    super(`${kind} handshake timed out after ${ms} ms`)
    this.name = 'TransportTimeout'
  }
}

function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(onTimeout()), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

/* ───────────────────────────── WebSocket ───────────────────────────── */

export class WebSocketTransport implements RelayTransport {
  readonly kind = 'websocket' as const
  readonly maxDatagram = Infinity
  onPacket: RelayTransport['onPacket'] = null
  onClose: RelayTransport['onClose'] = null
  private ws: WebSocket | null = null
  private closed = false

  constructor(private readonly url: string, private readonly token: string) {}

  connect(timeoutMs: number): Promise<void> {
    const open = new Promise<void>((resolve, reject) => {
      // 토큰은 하위 프로토콜로 전달(채팅 WS 와 동일한 관례). 쿼리에 포함하면 nginx error_log 에 평문으로 기록된다.
      const ws = new WebSocket(this.url, ['jw.relay', `jw.token.${b64url(this.token)}`])
      ws.binaryType = 'arraybuffer'
      this.ws = ws
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('websocket error'))
      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) this.onPacket?.(new Uint8Array(ev.data), true)
      }
      ws.onclose = (ev) => {
        if (this.closed) return
        this.closed = true
        this.onClose?.(ev.reason || `websocket closed (${ev.code})`)
      }
    })
    return withTimeout(open, timeoutMs, () => {
      this.close('timeout')
      return new TransportTimeout('websocket', timeoutMs)
    })
  }

  sendUnreliable(pkt: Uint8Array): void {
    this.sendReliable(pkt)
  }

  sendReliable(pkt: Uint8Array): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    // TCP 가 정체되면 bufferedAmount 가 누적된다 — 1 MB 초과 시 오디오 지연이 수 초에 달하므로 연결을 종료하고 재접속하는 편이 유리하다
    if (ws.bufferedAmount > 1_000_000) {
      this.close('send buffer overflow')
      return
    }
    ws.send(pkt as Uint8Array<ArrayBuffer>)
  }

  close(reason = 'closed'): void {
    if (this.closed) return
    this.closed = true
    try { this.ws?.close(1000, reason.slice(0, 120)) } catch { /* ignore */ }
    this.onClose?.(reason)
  }
}

/* ───────────────────────────── WebTransport ───────────────────────────── */

export class WebTransportTransport implements RelayTransport {
  readonly kind = 'webtransport' as const
  private _maxDatagram = 1200
  onPacket: RelayTransport['onPacket'] = null
  onClose: RelayTransport['onClose'] = null
  private wt: WebTransport | null = null
  private streamWriter: WritableStreamDefaultWriter<Uint8Array<ArrayBuffer>> | null = null
  private dgWriter: WritableStreamDefaultWriter<Uint8Array<ArrayBuffer>> | null = null
  private dgQueue: Uint8Array[] = []
  private dgDraining = false
  private reliableQueue: Uint8Array[] = []
  private reliableDraining = false
  private closed = false
  /** 데이터그램 큐 상한 — 초과 시 오래된 항목부터 폐기한다(지연 누적 금지) */
  static readonly MAX_DG_QUEUE = 64

  constructor(private readonly url: string, private readonly token: string, private readonly certHashHex?: string) {}

  get maxDatagram(): number {
    return this._maxDatagram
  }

  static supported(): boolean {
    return typeof WebTransport !== 'undefined'
  }

  async connect(timeoutMs: number): Promise<void> {
    const opts: WebTransportOptions = {
      // 데이터그램이 핵심이므로 저지연 혼잡제어를 힌트로 지정한다(지원 브라우저만 반영)
      congestionControl: 'low-latency',
    }
    if (this.certHashHex) {
      opts.serverCertificateHashes = [{ algorithm: 'sha-256', value: hexToBytes(this.certHashHex) }]
    }
    const wt = new WebTransport(this.url, opts)
    this.wt = wt
    let timedOut = false
    try {
      await withTimeout(wt.ready, timeoutMs, () => {
        timedOut = true
        return new TransportTimeout('webtransport', timeoutMs)
      })
      const ds = wt.datagrams
      if (typeof ds.maxDatagramSize === 'number' && ds.maxDatagramSize > 0) this._maxDatagram = ds.maxDatagramSize
      try {
        // 지연된 데이터그램은 송신하지 않는다(브라우저 큐에서 50 ms 넘게 체류하면 폐기)
        ;(ds as unknown as { outgoingMaxAge: number }).outgoingMaxAge = 50
        ;(ds as unknown as { incomingMaxAge: number }).incomingMaxAge = 100
      } catch { /* 읽기 전용 구현 */ }
      this.dgWriter = ds.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array<ArrayBuffer>>
      const bidi = await withTimeout(wt.createBidirectionalStream(), timeoutMs, () => new TransportTimeout('webtransport', timeoutMs))
      this.streamWriter = bidi.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array<ArrayBuffer>>
      // 첫 스트림 프레임 = 인증(PROTOCOL.md §4.2)
      await this.streamWriter.write(streamFrame(encodeCtrl({ t: 'auth', token: this.token })) as Uint8Array<ArrayBuffer>)
      this.readStream(bidi.readable as ReadableStream<Uint8Array>)
      this.readDatagrams(ds.readable as ReadableStream<Uint8Array>)
      wt.closed.then(
        (info) => this.handleClosed(`webtransport closed (${(info as WebTransportCloseInfo)?.closeCode ?? 0}) ${(info as WebTransportCloseInfo)?.reason ?? ''}`.trim()),
        (err) => this.handleClosed(`webtransport error: ${(err as Error)?.message ?? err}`),
      )
    } catch (e) {
      this.closed = true
      try { wt.close() } catch { /* ignore */ }
      if (timedOut) throw new TransportTimeout('webtransport', timeoutMs)
      throw e
    }
  }

  private handleClosed(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.onClose?.(reason)
  }

  private async readStream(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader()
    const parser = new StreamParser()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) for (const pkt of parser.push(value)) this.onPacket?.(pkt, true)
      }
    } catch { /* 세션 종료 — closed 콜백이 처리 */ }
  }

  private async readDatagrams(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) this.onPacket?.(value, false)
      }
    } catch { /* 세션 종료 */ }
  }

  sendUnreliable(pkt: Uint8Array): void {
    if (this.closed || !this.dgWriter) return
    if (pkt.byteLength > this._maxDatagram) return // 단편화는 호출자 책임
    if (this.dgQueue.length >= WebTransportTransport.MAX_DG_QUEUE) this.dgQueue.shift()
    this.dgQueue.push(pkt)
    if (!this.dgDraining) void this.drainDatagrams()
  }

  private async drainDatagrams(): Promise<void> {
    this.dgDraining = true
    try {
      while (this.dgQueue.length && this.dgWriter && !this.closed) {
        const pkt = this.dgQueue.shift()!
        await this.dgWriter.write(pkt as Uint8Array<ArrayBuffer>)
      }
    } catch { /* 세션 종료 */ } finally {
      this.dgDraining = false
    }
  }

  sendReliable(pkt: Uint8Array): void {
    if (this.closed || !this.streamWriter) return
    this.reliableQueue.push(streamFrame(pkt))
    if (!this.reliableDraining) void this.drainReliable()
  }

  private async drainReliable(): Promise<void> {
    this.reliableDraining = true
    try {
      while (this.reliableQueue.length && this.streamWriter && !this.closed) {
        await this.streamWriter.write(this.reliableQueue.shift()! as Uint8Array<ArrayBuffer>)
      }
    } catch { /* 세션 종료 */ } finally {
      this.reliableDraining = false
    }
  }

  close(reason = 'closed'): void {
    if (this.closed) return
    this.closed = true
    try { this.wt?.close({ closeCode: 0, reason: reason.slice(0, 120) }) } catch { /* ignore */ }
    this.onClose?.(reason)
  }
}

/** grant 와 종류로 전송 인스턴스를 생성한다 */
export function createTransport(kind: TransportKind, grant: RelayGrant, wsUrlOverride?: string): RelayTransport {
  if (kind === 'webtransport') {
    if (!grant.webtransport?.url) throw new Error('relay offers no WebTransport endpoint')
    return new WebTransportTransport(grant.webtransport.url, grant.token, grant.webtransport.self_signed ? grant.webtransport.cert_hash : undefined)
  }
  return new WebSocketTransport(wsUrlOverride ?? grant.ws_url, grant.token)
}
