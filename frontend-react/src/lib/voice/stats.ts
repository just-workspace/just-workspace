/**
 * RTCStatsReport → VoiceStats("증명" 패널). 순수 함수 — 단위 테스트 대상.
 *
 * 송신(outbound-rtp audio): bytesSent 차분으로 비트레이트, codecId → codec(mimeType·clockRate·channels·sdpFmtpLine).
 * remote-inbound-rtp: 상대(SFU)가 본 roundTripTime·jitter·packetsLost.
 * 수신(inbound-rtp audio): bytesReceived 차분, packetsLost, concealedSamples, jitterBufferDelay/EmittedCount.
 * candidate-pair(succeeded/nominated): currentRoundTripTime 폴백.
 */
import type { VoiceStats } from './transport'

export interface StatsSnapshot {
  at: number           // performance.now() ms
  bytesSent: number
  bytesRecv: number
}

export const EMPTY_STATS: VoiceStats = {
  codec: null, channels: null, sampleRate: null, sendBitrate: null, recvBitrate: null, rttMs: null, jitterMs: null,
  packetsLost: null, concealedSamples: null, recvPacketsLost: null, jitterBufferMs: null, fmtp: null, packetsSent: null,
}

type AnyStat = Record<string, any>

function entries(report: Iterable<AnyStat> | { forEach(cb: (v: AnyStat) => void): void }): AnyStat[] {
  const out: AnyStat[] = []
  if (typeof (report as any)[Symbol.iterator] === 'function') {
    for (const v of report as Iterable<any>) out.push(Array.isArray(v) ? v[1] : v)
  } else {
    (report as any).forEach((v: AnyStat) => out.push(v))
  }
  return out
}

/** opus 면 fmtp stereo=1 일 때만 2, 아니면 1. 다른 코덱(L16 등)은 코덱 채널 수 그대로 */
export function opusChannels(codec: string | null, fmtp: string | null, codecChannels: number | null): number | null {
  if ((codec || '').toLowerCase() !== 'opus') return codecChannels
  if (fmtp && /(^|;)\s*stereo=1(;|$)/.test(fmtp)) return 2
  return 1
}

/**
 * 송신 리포트(들)과 수신 리포트(들)을 합쳐 한 장으로. 보고서가 여럿이면(마이크 + 화면 공유 소리) 송신은
 * 비트레이트를 합치고 코덱은 첫 오디오 트랙 것을 쓴다.
 */
export function summarizeStats(
  sendReports: Array<Iterable<AnyStat> | RTCStatsReport>,
  recvReports: Array<Iterable<AnyStat> | RTCStatsReport>,
  prev: StatsSnapshot | null,
  now: number,
): { stats: VoiceStats; snap: StatsSnapshot } {
  const st: VoiceStats = { ...EMPTY_STATS }
  let bytesSent = 0
  let bytesRecv = 0
  let packetsSent = 0
  let rtt: number | null = null
  let jitter: number | null = null
  let lost: number | null = null

  for (const rep of sendReports) {
    const all = entries(rep as any)
    const byId = new Map<string, AnyStat>(all.map(s => [s.id, s]))
    for (const s of all) {
      if (s.type === 'outbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio')) {
        bytesSent += Number(s.bytesSent || 0)
        packetsSent += Number(s.packetsSent || 0)
        const codec = s.codecId ? byId.get(s.codecId) : undefined
        if (codec && !st.codec) {
          st.codec = String(codec.mimeType || '').replace(/^audio\//i, '') || null
          st.sampleRate = codec.clockRate != null ? Number(codec.clockRate) : null
          st.fmtp = codec.sdpFmtpLine ? String(codec.sdpFmtpLine) : null
          // opus 의 RTP 코덱은 늘 48000/2 로 광고된다(RFC 7587) — 실제 인코딩 채널은 fmtp stereo 가 정한다
          st.channels = opusChannels(st.codec, st.fmtp, codec.channels != null ? Number(codec.channels) : null)
        }
      } else if (s.type === 'remote-inbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio')) {
        if (s.roundTripTime != null) rtt = Math.max(rtt ?? 0, Number(s.roundTripTime) * 1000)
        if (s.jitter != null) jitter = Math.max(jitter ?? 0, Number(s.jitter) * 1000)
        if (s.packetsLost != null) lost = (lost ?? 0) + Number(s.packetsLost)
      } else if (s.type === 'candidate-pair' && (s.nominated || s.state === 'succeeded') && s.currentRoundTripTime != null && rtt == null) {
        rtt = Number(s.currentRoundTripTime) * 1000
      }
    }
  }

  let concealed: number | null = null
  let recvLost: number | null = null
  let jbDelay = 0
  let jbCount = 0
  for (const rep of recvReports) {
    for (const s of entries(rep as any)) {
      if (s.type === 'inbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio')) {
        bytesRecv += Number(s.bytesReceived || 0)
        if (s.concealedSamples != null) concealed = (concealed ?? 0) + Number(s.concealedSamples)
        if (s.packetsLost != null) recvLost = (recvLost ?? 0) + Number(s.packetsLost)
        if (s.jitterBufferDelay != null && s.jitterBufferEmittedCount) {
          jbDelay += Number(s.jitterBufferDelay)
          jbCount += Number(s.jitterBufferEmittedCount)
        }
      }
    }
  }

  const snap: StatsSnapshot = { at: now, bytesSent, bytesRecv }
  if (prev && now > prev.at) {
    const dt = (now - prev.at) / 1000
    st.sendBitrate = Math.max(0, (bytesSent - prev.bytesSent) * 8 / dt)
    st.recvBitrate = Math.max(0, (bytesRecv - prev.bytesRecv) * 8 / dt)
  }
  st.packetsSent = packetsSent || null
  st.rttMs = rtt
  st.jitterMs = jitter
  st.packetsLost = lost
  st.concealedSamples = concealed
  st.recvPacketsLost = recvLost
  // jitterBufferDelay 는 누계(초) — 평균 지연 = 합/건수(48k 샘플 기준이라 ms 로)
  st.jitterBufferMs = jbCount > 0 ? (jbDelay / jbCount) * 1000 : null
  return { stats: st, snap }
}

/** RMS → dBFS. 0 이면 -100 */
export function rmsToDb(rms: number): number {
  if (!(rms > 0)) return -100
  return Math.max(-100, 20 * Math.log10(rms))
}

/** 시간 영역 샘플(-1..1)의 RMS */
export function rms(samples: ArrayLike<number>): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return samples.length ? Math.sqrt(sum / samples.length) : 0
}

/** dBFS → 미터 폭(0..1). -60 dB 아래는 0 */
export function dbToMeter(db: number): number {
  return Math.max(0, Math.min(1, (db + 60) / 60))
}
