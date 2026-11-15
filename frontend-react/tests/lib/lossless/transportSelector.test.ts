import { describe, it, expect } from 'vitest'
import { TransportSelector, classifyHandshakeError } from '~/lib/lossless/transportSelector'

function sel(env: Partial<{ hasWebTransport: boolean; webtransportUrl: string | null }> = {}, clock = { t: 0 }) {
  return new TransportSelector(
    { hasWebTransport: env.hasWebTransport ?? true, webtransportUrl: env.webtransportUrl === undefined ? 'https://relay:4433/audiorelay/wt' : env.webtransportUrl },
    { now: () => clock.t, retryWebTransportAfterMs: 60_000, lossWindowMs: 60_000, maxLossesInWindow: 3 },
  )
}

describe('lossless/transportSelector', () => {
  it('WebTransport is the default when the API and endpoint exist', () => {
    const s = sel()
    expect(s.next()).toBe('webtransport')
    expect(s.handshakeTimeoutMs).toBe(1800)
    s.recordHandshake('webtransport', 'ok')
    expect(s.active).toBe('webtransport')
    expect(s.fallbackReason).toBeNull()
    expect(s.shouldRetryWebTransport()).toBe(false)
  })

  it('falls back to WebSocket when the browser has no WebTransport or the relay offers none', () => {
    const a = sel({ hasWebTransport: false })
    expect(a.next()).toBe('websocket')
    a.recordHandshake('websocket', 'ok')
    expect(a.fallbackReason).toBe('no_webtransport_api')
    expect(a.shouldRetryWebTransport()).toBe(false)

    const b = sel({ webtransportUrl: null })
    expect(b.next()).toBe('websocket')
    b.recordHandshake('websocket', 'ok')
    expect(b.fallbackReason).toBe('no_webtransport_endpoint')
  })

  it('handshake timeout (UDP blocked) → WebSocket now, WebTransport retried later', () => {
    const clock = { t: 1000 }
    const s = sel({}, clock)
    expect(s.next()).toBe('webtransport')
    s.recordHandshake('webtransport', 'timeout')
    expect(s.next()).toBe('websocket')
    expect(s.fallbackReason).toBe('handshake_timeout')
    s.recordHandshake('websocket', 'ok')
    expect(s.active).toBe('websocket')
    expect(s.shouldRetryWebTransport()).toBe(false)
    expect(s.msUntilRetry()).toBe(60_000)
    clock.t += 59_999
    expect(s.shouldRetryWebTransport()).toBe(false)
    clock.t += 1
    expect(s.shouldRetryWebTransport()).toBe(true)
    expect(s.next()).toBe('webtransport')
    // retry succeeds → back on WebTransport, reason cleared
    s.recordHandshake('webtransport', 'ok')
    expect(s.active).toBe('webtransport')
    expect(s.fallbackReason).toBeNull()
    expect(s.attempts).toBe(3)
  })

  it('handshake failure variants map to reasons', () => {
    for (const [outcome, reason] of [['failed', 'handshake_failed'], ['udp_blocked', 'udp_blocked'], ['datagram_too_small', 'datagram_too_small']] as const) {
      const s = sel()
      s.recordHandshake('webtransport', outcome)
      s.recordHandshake('websocket', 'ok')
      expect(s.fallbackReason).toBe(reason)
      expect(s.next()).toBe('websocket')
    }
  })

  it('a single mid-session loss reconnects with WebTransport; repeated losses fall back', () => {
    const clock = { t: 0 }
    const s = sel({}, clock)
    s.recordHandshake('webtransport', 'ok')
    s.recordDisconnect('webtransport')
    expect(s.next()).toBe('webtransport')
    expect(s.active).toBeNull()
    s.recordHandshake('webtransport', 'ok')
    clock.t += 10_000
    s.recordDisconnect('webtransport')
    expect(s.next()).toBe('webtransport')
    s.recordHandshake('webtransport', 'ok')
    clock.t += 10_000
    s.recordDisconnect('webtransport') // 3rd within 60 s
    expect(s.next()).toBe('websocket')
    s.recordHandshake('websocket', 'ok')
    expect(s.fallbackReason).toBe('connection_lost_repeatedly')
    // old losses age out of the window
    const s2 = sel({}, clock)
    s2.recordHandshake('webtransport', 'ok')
    s2.recordDisconnect('webtransport')
    clock.t += 61_000
    s2.recordDisconnect('webtransport')
    clock.t += 1_000
    s2.recordDisconnect('webtransport')
    expect(s2.next()).toBe('webtransport')
  })

  it('WebSocket disconnects never block anything; snapshot exposes the state for stats', () => {
    const s = sel({ hasWebTransport: false })
    s.recordHandshake('websocket', 'ok')
    s.recordDisconnect('websocket')
    expect(s.next()).toBe('websocket')
    expect(s.snapshot()).toEqual({ active: null, fallbackReason: 'no_webtransport_api', retryInMs: 0, attempts: 1 })
  })

  it('classifies browser errors', () => {
    expect(classifyHandshakeError(new Error('x'), true)).toBe('timeout')
    expect(classifyHandshakeError(new Error('net::ERR_QUIC_PROTOCOL_ERROR'), false)).toBe('udp_blocked')
    expect(classifyHandshakeError(new Error('datagram too large'), false)).toBe('datagram_too_small')
    expect(classifyHandshakeError(new Error('certificate verification failed'), false)).toBe('failed')
  })
})
