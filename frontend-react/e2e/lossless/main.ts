/**
 * e2e 하네스 — Playwright(헤드리스 크롬)가 두 컨텍스트에서 로드하여 LosslessSession 을 직접 구동한다(백엔드 없이 grant 를 직접 생성).
 * 비트퍼펙트: 송신 프레임 payload 해시(FNV-1a) ↔ 수신 프레임 해시를 seq 기준으로 대조. 지연: 동일 머신이므로 wall clock 차이.
 */
import { LosslessSession, type LosslessSessionOptions } from '~/lib/lossless/session'
import type { BufferPreset, LosslessEvent, LosslessFormat, RelayGrant } from '~/lib/lossless/types'

function fnv1a(b: Uint8Array): number {
  let h = 0x811c9dc5
  for (let i = 0; i < b.byteLength; i++) {
    h ^= b[i]
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

const wall = () => performance.timeOrigin + performance.now()

interface Dump {
  sent: Array<[number, number, number]>                 // seq, hash, wall
  recv: Record<string, Array<[number, number, number, string]>> // peer → seq, hash, wall, how
  events: Array<{ at: number; ev: unknown }>
  capture: unknown
  format: LosslessFormat | null
}

let session: LosslessSession | null = null
const dump: Dump = { sent: [], recv: {}, events: [], capture: null, format: null }
const log = (s: string) => { const el = document.getElementById('log'); if (el) el.textContent += '\n' + s }

const api = {
  async join(grant: RelayGrant, opts: Partial<LosslessSessionOptions> & { format?: Partial<LosslessFormat>; bufferPreset?: BufferPreset; record?: boolean } = {}) {
    const record = opts.record !== false
    session = new LosslessSession({
      format: opts.format,
      bufferPreset: opts.bufferPreset,
      handshakeTimeoutMs: opts.handshakeTimeoutMs,
      retryWebTransportAfterMs: opts.retryWebTransportAfterMs,
      hasWebTransport: opts.hasWebTransport,
      onFrameSent: record ? (seq, payload, _ts) => { dump.sent.push([seq, fnv1a(payload), wall()]) } : undefined,
      onFrameReceived: record ? (peer, seq, payload, how) => { (dump.recv[peer] ??= []).push([seq, fnv1a(payload), wall(), how]) } : undefined,
    })
    session.on((ev: LosslessEvent) => {
      if (ev.type === 'level' || ev.type === 'stats') return
      dump.events.push({ at: wall(), ev: JSON.parse(JSON.stringify(ev, (_k, v) => (v instanceof Error ? String(v) : v))) })
      if (ev.type === 'format') { dump.capture = ev.capture; dump.format = ev.format }
      log(`${ev.type} ${JSON.stringify(ev).slice(0, 200)}`)
    })
    await session.join(grant)
    return { state: session.currentState, transport: session.transportKind, fallbackReason: session.fallbackReason, capture: dump.capture, format: dump.format }
  },
  stats() {
    return session ? JSON.parse(JSON.stringify(session.getStats())) : null
  },
  dump() {
    return dump
  },
  counts() {
    return { sent: dump.sent.length, recv: Object.fromEntries(Object.entries(dump.recv).map(([k, v]) => [k, v.length])) }
  },
  setMuted(m: boolean) { session?.setMuted(m) },
  setPreset(p: BufferPreset) { session?.setBufferPreset(p) },
  setFormat(f: Partial<LosslessFormat>) { session?.setFormat(f) },
  async leave() { await session?.leave(); session = null },
  async probeCapture() {
    // 96 kHz 요청 시 장치가 실제로 반환하는 값(미검증 항목)
    const out: Record<string, unknown> = {}
    for (const rate of [96000, 48000]) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: { ideal: 2 }, sampleRate: { ideal: rate }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
        const t = s.getAudioTracks()[0]
        out[rate] = { settings: t.getSettings(), capabilities: typeof t.getCapabilities === 'function' ? t.getCapabilities() : null }
        t.stop()
      } catch (e) { out[rate] = { error: String(e) } }
    }
    out.ctx96 = (() => { try { const c = new AudioContext({ sampleRate: 96000 }); const r = c.sampleRate; void c.close(); return r } catch (e) { return String(e) } })()
    return out
  },
}

;(window as unknown as { jwHarness: typeof api }).jwHarness = api
log('ready')
