import { describe, it, expect } from 'vitest'
import { JitterBuffer } from '~/lib/lossless/jitter'

const FRAME = 480
const RATE = 48000
const FRAME_MS = 10

function frame(seq: number): Float32Array[] {
  return [new Float32Array(FRAME).fill(seq + 1), new Float32Array(FRAME).fill(-(seq + 1))]
}

/** 시뮬레이터: 송신 시각 seq*FRAME_MS + 네트워크 지연(jitterFn), 수신 pull 은 FRAME_MS 간격 */
function simulate(opts: {
  frames: number
  delay: (seq: number) => number | null // null = lost
  preset?: 'auto' | 60 | 120 | 250
  startMs?: number
}) {
  let clock = 0
  const jb = new JitterBuffer({ frameSamples: FRAME, sampleRate: RATE, channels: 2, preset: opts.preset, startMs: opts.startMs, now: () => clock })
  const arrivals: { at: number; seq: number }[] = []
  for (let s = 0; s < opts.frames; s++) {
    const d = opts.delay(s)
    if (d !== null) arrivals.push({ at: s * FRAME_MS + d, seq: s })
  }
  arrivals.sort((a, b) => a.at - b.at)
  const pulled: { kind: string; seq: number | null; t: number }[] = []
  // 마지막 프레임까지 재생되면 멈춘다(그 뒤는 스트림 종료라 언더런으로 세지 않는다)
  const end = opts.frames * FRAME_MS + 2000
  let ai = 0
  for (clock = 0; clock < end && !(ai >= arrivals.length && jb.stats().depthMs === 0 && clock > 30); clock += FRAME_MS) {
    while (ai < arrivals.length && arrivals[ai].at <= clock) {
      jb.push(arrivals[ai].seq, frame(arrivals[ai].seq), arrivals[ai].at)
      ai++
    }
    const p = jb.pull()
    pulled.push({ kind: p.kind, seq: p.seq, t: clock })
  }
  return { jb, pulled, stats: jb.stats() }
}

describe('lossless/jitter buffer', () => {
  it('primes at the start target and then plays every frame in order with a steady network', () => {
    const { pulled, stats } = simulate({ frames: 300, delay: () => 5 })
    const ok = pulled.filter((p) => p.kind === 'ok')
    expect(ok.length).toBe(300)
    expect(ok.map((p) => p.seq)).toEqual([...Array(300).keys()])
    expect(stats.lost).toBe(0)
    expect(stats.underruns).toBe(0)
    expect(stats.plc).toBe(0)
    // priming lasted about the start target (20 ms = 2 frames)
    const firstOk = pulled.findIndex((p) => p.kind === 'ok')
    expect(firstOk).toBeGreaterThanOrEqual(1)
    expect(firstOk).toBeLessThanOrEqual(4)
    expect(stats.targetMs).toBeGreaterThanOrEqual(20)
  })

  it('conceals isolated losses with PLC and keeps sequence continuity', () => {
    const { pulled, stats } = simulate({ frames: 400, delay: (s) => (s % 50 === 25 ? null : 5) })
    const kinds = pulled.map((p) => p.kind)
    // 손실 1개당 PLC 1~2개(작은 버퍼에선 1프레임 기다려 본 뒤 손실 확정 — 그만큼 깊이가 늘어 다음부턴 즉시)
    expect(stats.lost).toBe(8)
    expect(stats.plc).toBeGreaterThanOrEqual(8)
    expect(stats.plc).toBeLessThanOrEqual(16)
    expect(kinds.filter((k) => k === 'plc').length).toBe(stats.plc)
    expect(stats.underruns).toBe(0)
    // PLC 뒤에는 실제 프레임이 이어진다(재프라이밍 없음)
    const i = kinds.lastIndexOf('plc')
    expect(kinds[i + 1]).toBe('ok')
    const seqs = pulled.filter((p) => p.kind === 'ok').map((p) => p.seq!)
    for (let k = 1; k < seqs.length; k++) expect(seqs[k]).toBeGreaterThan(seqs[k - 1])
  })

  it('grows its target under jitter (p95 + 1 frame) and does not underrun once adapted', () => {
    // 지터: 매 10번째 프레임이 35 ms 늦게 온다(p95 ≈ 30 ms 수준)
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    const { pulled, stats } = simulate({ frames: 1500, delay: (s) => 5 + (s % 10 === 0 ? 35 : rnd() * 4) })
    expect(stats.targetMs).toBeGreaterThan(20)
    expect(stats.autoTargetMs).toBeGreaterThanOrEqual(30)
    expect(stats.jitterP95Ms).toBeGreaterThanOrEqual(20)
    // 뒤쪽 5초는 안정: 언더런·PLC 없음
    const tail = pulled.slice(-500)
    expect(tail.filter((p) => p.kind !== 'ok').length).toBe(0)
    expect(stats.played).toBeGreaterThan(1400)
    // 처음엔 2프레임(20 ms)으로 시작했으니 적응 전 언더런이 몇 번 있을 수 있다 — 상한만 본다
    expect(stats.underruns).toBeLessThan(8)
  })

  it('adds headroom on underrun (once per 500 ms) and decays it after 10 s clean', () => {
    // 2 s 동안 조용히 오다가 한 번 120 ms 정체, 그 뒤 15 s 깨끗
    const { jb, pulled } = simulate({ frames: 1800, delay: (s) => (s >= 200 && s < 212 ? 120 : 5) })
    const s = jb.stats()
    expect(s.underruns).toBeGreaterThanOrEqual(1)
    expect(s.underruns).toBeLessThanOrEqual(2)
    // 정체 뒤 쌓인 깊이는 "따라잡기" 드롭으로 목표 근처까지 내려온다
    expect(s.depthMs).toBeLessThanOrEqual(s.targetMs + 3 * FRAME_MS)
    expect(s.dropped).toBeGreaterThan(0)
    // 헤드룸은 10 s 깨끗하면 1프레임씩 줄어 결국 0
    expect(s.headroomMs).toBe(0)
    expect(pulled.filter((p) => p.kind === 'ok').length).toBeGreaterThan(1750)
  })

  it('stabilize presets fix the target and ignore adaptation', () => {
    const { jb, pulled } = simulate({ frames: 600, delay: () => 5, preset: 120 })
    expect(jb.targetMs).toBe(120)
    const firstOk = pulled.findIndex((p) => p.kind === 'ok')
    expect(firstOk).toBeGreaterThanOrEqual(11) // ~120 ms of priming
    jb.setPreset('auto')
    expect(jb.targetMs).toBeLessThan(120)
    jb.setPreset(250)
    expect(jb.stats().preset).toBe(250)
  })

  it('drops late frames, counts duplicates, and re-primes after a long outage', () => {
    let clock = 0
    const jb = new JitterBuffer({ frameSamples: FRAME, sampleRate: RATE, channels: 2, now: () => clock })
    for (let s = 0; s < 5; s++) jb.push(s, frame(s), s * 10)
    jb.push(2, frame(2), 45)
    expect(jb.stats().duplicates).toBe(1)
    const kinds: string[] = []
    for (let i = 0; i < 5; i++) {
      clock += 10
      kinds.push(jb.pull().kind)
    }
    expect(kinds.filter((k) => k === 'ok').length).toBe(5)
    jb.push(1, frame(1), 60) // already played
    expect(jb.stats().late).toBe(1)
    // 고갈: 처음 4프레임은 PLC(페이드), 그 뒤 무음, 100프레임 넘으면 재프라이밍
    const outage: string[] = []
    for (let i = 0; i < 110; i++) {
      clock += 10
      outage.push(jb.pull().kind)
    }
    expect(outage.slice(0, 4)).toEqual(['plc', 'plc', 'plc', 'plc'])
    expect(outage[10]).toBe('silence')
    expect(outage[outage.length - 1]).toBe('priming')
    expect(jb.stats().underruns).toBe(1)
    expect(jb.stats().headroomMs).toBe(FRAME_MS)
    // 다시 데이터가 오면 새 seq 부터 프라이밍해 재생
    for (let s = 500; s < 505; s++) jb.push(s, frame(s), clock + s)
    clock += 10
    expect(jb.pull().seq).toBe(500)
    expect(jb.stats().primed).toBe(2)
  })

  it('skips far ahead instead of concealing dozens of frames when badly behind', () => {
    let clock = 0
    const jb = new JitterBuffer({ frameSamples: FRAME, sampleRate: RATE, channels: 2, now: () => clock })
    jb.push(0, frame(0), 0)
    jb.push(1, frame(1), 10)
    jb.push(2, frame(2), 20)
    clock = 30
    expect(jb.pull().seq).toBe(0)
    for (let s = 200; s < 204; s++) jb.push(s, frame(s), 40)
    clock = 40
    expect(jb.pull().seq).toBe(1)
    clock = 50
    expect(jb.pull().seq).toBe(2)
    clock = 60
    const p = jb.pull()
    expect(p.seq).toBe(200)
    expect(jb.stats().lost).toBe(197)
  })

  it('PLC output fades the previous frame and crossfades back', () => {
    let clock = 0
    const jb = new JitterBuffer({ frameSamples: FRAME, sampleRate: RATE, channels: 2, now: () => clock })
    jb.push(0, frame(0), 0)
    jb.push(1, frame(1), 10)
    jb.push(3, frame(3), 30)
    for (const t of [20, 30]) {
      clock = t
      expect(jb.pull().kind).toBe('ok')
    }
    clock = 40
    const plc = jb.pull() // 목표 2프레임, 깊이 1 → 한 프레임 기다려 본다
    expect(plc.kind).toBe('plc')
    expect(plc.pcm[0][0]).toBeCloseTo(2) // repeats frame(1) = 2 at the start
    expect(plc.pcm[0][FRAME - 1]).toBeLessThan(1.1) // faded toward 0.5×
    clock = 50
    const plc2 = jb.pull() // 깊이 1 + 기다림 1 = 목표 → 손실 확정, 전진
    expect(plc2.kind).toBe('plc')
    expect(plc2.pcm[0][0]).toBeCloseTo(1)
    clock = 60
    const back = jb.pull()
    expect(back.kind).toBe('ok')
    expect(back.seq).toBe(3)
    expect(back.pcm[0][0]).toBeCloseTo(0.5) // crossfade starts from the concealed level (2 × 0.25)
    expect(back.pcm[0][FRAME - 1]).toBeCloseTo(4, 1)
    expect(jb.stats().lost).toBe(1)
    expect(jb.stats().plc).toBe(2)
  })
})
