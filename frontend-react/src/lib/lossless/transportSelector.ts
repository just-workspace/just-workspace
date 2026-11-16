/**
 * 전송 선택·폴백 정책 (순수 상태기계 — 세션이 네트워크 결과를 보고하고 다음 시도를 조회한다).
 *
 * 결정: **WebTransport 가 기본**, WebSocket 은 WebTransport 가 불가능할 때만 자동 폴백.
 * 폴백 조건
 *  - 브라우저에 WebTransport API 없음 / 릴레이가 WebTransport 주소를 제공하지 않음
 *  - UDP 포트가 차단되었거나 도달 불가(핸드셰이크 타임아웃 ≈ 1.8 s) / 핸드셰이크 실패
 *  - 세션 중 연결이 반복 단절됨(60 s 안에 3회)
 * 폴백 후에도 주기적으로(기본 60 s) WebTransport 를 재시도하여 성공하면 복귀한다.
 */
import type { TransportKind } from './types'

export type FallbackReason =
  | 'no_webtransport_api'
  | 'no_webtransport_endpoint'
  | 'handshake_timeout'
  | 'handshake_failed'
  | 'udp_blocked'
  | 'connection_lost_repeatedly'
  | 'datagram_too_small'

export type HandshakeOutcome = 'ok' | 'timeout' | 'failed' | 'udp_blocked' | 'datagram_too_small'

export interface SelectorEnv {
  hasWebTransport: boolean
  webtransportUrl: string | null
}

export interface SelectorOptions {
  /** WebTransport 핸드셰이크 상한(ms). 결정: 1.5~2 s */
  handshakeTimeoutMs?: number
  /** 이 시간(ms) 내에 maxLossesInWindow 회 단절되면 "반복 단절" */
  lossWindowMs?: number
  maxLossesInWindow?: number
  /** 폴백 뒤 WebTransport 재시도 간격(ms) */
  retryWebTransportAfterMs?: number
  now: () => number
}

export class TransportSelector {
  readonly handshakeTimeoutMs: number
  private readonly lossWindowMs: number
  private readonly maxLosses: number
  private readonly retryAfterMs: number
  private wtBlockedUntil = -Infinity
  private wtLosses: number[] = []
  private _active: TransportKind | null = null
  private _reason: FallbackReason | null = null
  private _attempts = 0

  constructor(private readonly env: SelectorEnv, private readonly o: SelectorOptions) {
    this.handshakeTimeoutMs = o.handshakeTimeoutMs ?? 1800
    this.lossWindowMs = o.lossWindowMs ?? 60_000
    this.maxLosses = o.maxLossesInWindow ?? 3
    this.retryAfterMs = o.retryWebTransportAfterMs ?? 60_000
    if (!env.hasWebTransport) this._reason = 'no_webtransport_api'
    else if (!env.webtransportUrl) this._reason = 'no_webtransport_endpoint'
  }

  /** WebTransport 사용 가능 환경 여부(정적 조건) */
  get webTransportPossible(): boolean {
    return this.env.hasWebTransport && !!this.env.webtransportUrl
  }

  get active(): TransportKind | null {
    return this._active
  }

  /** 현재 WebSocket 을 사용 중이면 그 사유(WebTransport 가 활성이면 null) */
  get fallbackReason(): FallbackReason | null {
    return this._active === 'webtransport' ? null : this._reason
  }

  get attempts(): number {
    return this._attempts
  }

  /** 다음에 시도할 전송 */
  next(): TransportKind {
    if (!this.webTransportPossible) return 'websocket'
    if (this.o.now() < this.wtBlockedUntil) return 'websocket'
    return 'webtransport'
  }

  /** 핸드셰이크 결과 보고. ok 가 아니면 다음 next() 는 폴백을 반환한다 */
  recordHandshake(kind: TransportKind, outcome: HandshakeOutcome): void {
    this._attempts++
    if (outcome === 'ok') {
      this._active = kind
      if (kind === 'webtransport') this._reason = null // 단절 이력은 창 내에서 유지한다(재접속 성공이 "반복 단절"을 초기화해서는 안 된다)
      return
    }
    if (kind === 'webtransport') {
      this._reason =
        outcome === 'timeout' ? 'handshake_timeout'
          : outcome === 'udp_blocked' ? 'udp_blocked'
            : outcome === 'datagram_too_small' ? 'datagram_too_small'
              : 'handshake_failed'
      this.blockWebTransport()
    }
    this._active = null
  }

  /** 연결 중 단절 보고. 반복되면 폴백, 아니면 동일 전송으로 재접속 */
  recordDisconnect(kind: TransportKind): void {
    this._active = null
    if (kind !== 'webtransport') return
    const now = this.o.now()
    this.wtLosses = this.wtLosses.filter((t) => now - t < this.lossWindowMs)
    this.wtLosses.push(now)
    if (this.wtLosses.length >= this.maxLosses) {
      this._reason = 'connection_lost_repeatedly'
      this.blockWebTransport()
      this.wtLosses = []
    }
  }

  /** WebSocket 으로 폴백된 상태이며 WebTransport 재시도 시점에 도달했는지 여부 */
  shouldRetryWebTransport(): boolean {
    return this._active === 'websocket' && this.webTransportPossible && this.o.now() >= this.wtBlockedUntil
  }

  /** 재시도까지 남은 시간(ms, 0 이면 지금) */
  msUntilRetry(): number {
    return Math.max(0, this.wtBlockedUntil - this.o.now())
  }

  private blockWebTransport(): void {
    this.wtBlockedUntil = this.o.now() + this.retryAfterMs
  }

  /** 테스트·진단용 스냅샷 */
  snapshot(): { active: TransportKind | null; fallbackReason: FallbackReason | null; retryInMs: number; attempts: number } {
    return { active: this._active, fallbackReason: this.fallbackReason, retryInMs: this.msUntilRetry(), attempts: this._attempts }
  }
}

/** 브라우저 오류 → 결과 분류(WebTransport 는 UDP 차단과 타임아웃을 구분하지 않는다 — 메시지로 최대한 분류한다) */
export function classifyHandshakeError(err: unknown, timedOut: boolean): HandshakeOutcome {
  if (timedOut) return 'timeout'
  const msg = String((err as any)?.message ?? err ?? '').toLowerCase()
  if (/datagram/.test(msg)) return 'datagram_too_small'
  if (/net::err_quic|connection_refused|unreachable|udp|network/.test(msg)) return 'udp_blocked'
  return 'failed'
}
