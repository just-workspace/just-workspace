/**
 * 적응형 지터버퍼 (VOICE-RESEARCH §5 Tier 3 권고: SonoBus + JackTrip 혼합).
 *
 * - 시작 20 ms. 1 s 마다 도착간격 지터의 p95 + 1프레임으로 자동 목표 재산정.
 * - 언더런이면 즉시 +1프레임 헤드룸(0.5 s 에 1회 상한). 10 s 무언더런이면 헤드룸 −1프레임(하한 = 자동 목표).
 * - "안정화" 프리셋(60/120/250 ms)은 목표 고정.
 * - 깊이가 목표 + 2프레임을 0.5 s 넘게 유지하면 1프레임 드롭(클럭 드리프트·정체 뒤 따라잡기),
 *   목표 − 2프레임 아래로 1 s 넘게 머물면 은닉 프레임 1개 삽입(선제 확장).
 * - 빠진 프레임은 PLC(직전 프레임 반복 + 페이드), 완전 고갈이면 재생 헤드를 멈추고 기다린 뒤 길어지면 재프라이밍.
 *
 * 순수 TS — 재생 AudioWorklet 안에서 돈다. 시계는 주입(now: ms).
 */
import type { BufferPreset } from './types'
import { concealFrame, crossfadeIn, PLC_MAX_REPEAT } from './plc'

export interface JitterOptions {
  frameSamples: number
  sampleRate: number
  channels: number
  startMs?: number
  minMs?: number
  maxMs?: number
  preset?: BufferPreset
  /** ms 시계 — pull 쪽 타이머용 */
  now: () => number
}

export type PullKind = 'ok' | 'plc' | 'silence' | 'priming'

export interface Pulled {
  kind: PullKind
  pcm: Float32Array[]
  seq: number | null
}

export interface JitterStats {
  targetMs: number
  autoTargetMs: number
  headroomMs: number
  depthMs: number
  jitterP95Ms: number
  jitterMeanMs: number
  received: number
  played: number
  lost: number
  plc: number
  late: number
  underruns: number
  dropped: number
  expanded: number
  duplicates: number
  primed: number
  preset: BufferPreset
  playoutSeq: number | null
}

interface Stored {
  pcm: Float32Array[]
  ts: number
}

const JITTER_WINDOW = 256
const MAX_STORED = 1000
/** 연속 언더런이 이만큼(프레임) 이어지면 스트림이 끊긴 것 — 재프라이밍 */
const UNDERRUN_REPRIME_FRAMES = 100

export class JitterBuffer {
  readonly frameMs: number
  private frames = new Map<number, Stored>()
  private nextSeq: number | null = null
  private priming = true
  private preset: BufferPreset
  private readonly minMs: number
  private readonly maxMs: number
  private autoTargetMs: number
  private headroomMs = 0
  private jitter: number[] = []
  private jitterIdx = 0
  private lastArrival: { seq: number; transit: number } | null = null
  private lastReal: Float32Array[] | null = null
  private concealRun = 0
  private lastRetargetAt: number
  private lastUnderrunAt = -Infinity
  private lastHeadroomUpAt = -Infinity
  private cleanSince: number
  private highSince: number | null = null
  private lowSince: number | null = null
  private s = {
    received: 0, played: 0, lost: 0, plc: 0, late: 0, underruns: 0, dropped: 0, expanded: 0, duplicates: 0, primed: 0,
  }

  constructor(private readonly o: JitterOptions) {
    this.frameMs = (o.frameSamples / o.sampleRate) * 1000
    this.minMs = o.minMs ?? 20
    this.maxMs = o.maxMs ?? 500
    this.autoTargetMs = Math.max(this.minMs, o.startMs ?? 20)
    this.preset = o.preset ?? 'auto'
    this.lastRetargetAt = o.now()
    this.cleanSince = o.now()
  }

  get targetMs(): number {
    if (this.preset !== 'auto') return this.preset
    return Math.min(this.maxMs, this.autoTargetMs + this.headroomMs)
  }

  private get targetFrames(): number {
    return Math.max(1, Math.ceil(this.targetMs / this.frameMs))
  }

  setPreset(p: BufferPreset): void {
    this.preset = p
    this.highSince = null
    this.lowSince = null
  }

  /** 프레임 도착. arrivalMs 는 네트워크 스레드의 시계(차이만 쓴다) */
  push(seq: number, pcm: Float32Array[], arrivalMs: number, ts = 0): void {
    this.s.received++
    // 전송시간 변동(RFC 3550 식): d = 도착시각 − seq×프레임, j = |d − d_prev|. 도착 순서 기준이라
    // 늦게 온(순서 바뀐) 프레임도 지터로 잡힌다.
    const transit = arrivalMs - seq * this.frameMs
    if (this.lastArrival && Math.abs(seq - this.lastArrival.seq) <= 1024) {
      const j = Math.abs(transit - this.lastArrival.transit)
      if (this.jitter.length < JITTER_WINDOW) this.jitter.push(j)
      else {
        this.jitter[this.jitterIdx] = j
        this.jitterIdx = (this.jitterIdx + 1) % JITTER_WINDOW
      }
    }
    this.lastArrival = { seq, transit }

    if (this.nextSeq !== null && !this.priming && seq < this.nextSeq) {
      this.s.late++
      return
    }
    if (this.frames.has(seq)) {
      this.s.duplicates++
      return
    }
    if (this.frames.size >= MAX_STORED) {
      // 재생이 멈춘 채 쌓이기만 한다 — 가장 오래된 것부터 버린다
      const oldest = Math.min(...this.frames.keys())
      this.frames.delete(oldest)
      this.s.dropped++
    }
    this.frames.set(seq, { pcm, ts })
  }

  /** 프레임 하나를 꺼낸다(렌더 스레드가 프레임 간격마다 호출) */
  pull(): Pulled {
    const now = this.o.now()
    this.maybeRetarget(now)

    if (this.priming) {
      if (this.tryPrime()) {
        this.s.primed++
      } else {
        return { kind: 'priming', pcm: this.silence(), seq: null }
      }
    }
    const seq = this.nextSeq!

    // 선제 확장: 목표보다 2프레임 이상 얕은 상태가 1 s 지속 → 은닉 프레임 1개 삽입
    const depth = this.depthFrames()
    if (depth > 0 && depth < this.targetFrames - 2) {
      if (this.lowSince === null) this.lowSince = now
      else if (now - this.lowSince > 1000) {
        this.lowSince = null
        this.s.expanded++
        return { kind: 'plc', pcm: concealFrame(this.lastReal, this.o.frameSamples, this.o.channels, 1), seq: null }
      }
    } else this.lowSince = null

    // 따라잡기: 목표 + 2프레임 넘게 깊은 상태가 0.5 s 지속 → 1프레임 드롭
    if (depth > this.targetFrames + 2) {
      if (this.highSince === null) this.highSince = now
      else if (now - this.highSince > 500) {
        this.highSince = null
        const f = this.frames.get(seq)
        if (f) {
          this.frames.delete(seq)
          this.lastReal = f.pcm
        }
        this.nextSeq = seq + 1
        this.s.dropped++
        return this.pull()
      }
    } else this.highSince = null

    const f = this.frames.get(seq)
    if (f) {
      this.frames.delete(seq)
      this.nextSeq = seq + 1
      if (this.concealRun > 0) crossfadeIn(f.pcm, this.lastReal, this.concealRun)
      this.concealRun = 0
      this.lastReal = f.pcm
      this.s.played++
      return { kind: 'ok', pcm: f.pcm, seq }
    }

    // 헤드 프레임이 없다.
    if (depth > 0) {
      const maxSeq = Math.max(...this.frames.keys())
      if (maxSeq - seq > 64) {
        // 너무 멀리 뒤처졌다 — 통째로 건너뛴다
        const minSeq = Math.min(...this.frames.keys())
        this.s.lost += minSeq - seq
        this.nextSeq = minSeq
        return this.pull()
      }
      // 쌓인 뒤 프레임 + 기다린 프레임이 목표 예산에 닿으면(=이 프레임은 예산을 넘겨 늦었다) 손실로 보고 전진.
      // 아니면 자리를 지키고 은닉 — 그 사이 깊이가 목표까지 차오른다(NetEQ expand 와 같은 효과).
      if (depth + this.concealRun >= this.targetFrames) {
        this.nextSeq = seq + 1
        this.s.lost++
        this.s.plc++
        this.concealRun++
        return { kind: 'plc', pcm: concealFrame(this.lastReal, this.o.frameSamples, this.o.channels, this.concealRun), seq: null }
      }
      this.s.plc++
      this.concealRun++
      return { kind: 'plc', pcm: concealFrame(this.lastReal, this.o.frameSamples, this.o.channels, this.concealRun), seq: null }
    }

    // 완전 고갈 — 언더런. 헤드는 멈추고(늦게 온 프레임을 버리지 않기 위해) 은닉 → 길어지면 재프라이밍
    if (this.concealRun === 0 || now - this.lastUnderrunAt > this.frameMs * 2) {
      this.s.underruns++
      this.cleanSince = now
      if (this.preset === 'auto' && now - this.lastHeadroomUpAt > 500) {
        this.headroomMs = Math.min(this.maxMs, this.headroomMs + this.frameMs)
        this.lastHeadroomUpAt = now
      }
    }
    this.lastUnderrunAt = now
    this.concealRun++
    this.s.plc++
    if (this.concealRun > UNDERRUN_REPRIME_FRAMES) {
      this.priming = true
      this.nextSeq = null
      this.concealRun = 0
      this.lastReal = null
      return { kind: 'silence', pcm: this.silence(), seq: null }
    }
    const kind: PullKind = this.concealRun <= PLC_MAX_REPEAT ? 'plc' : 'silence'
    return { kind, pcm: concealFrame(this.lastReal, this.o.frameSamples, this.o.channels, this.concealRun), seq: null }
  }

  private tryPrime(): boolean {
    if (this.frames.size === 0) return false
    const keys = [...this.frames.keys()]
    const min = Math.min(...keys)
    const max = Math.max(...keys)
    if ((max - min + 1) * this.frameMs < this.targetMs && this.frames.size < this.targetFrames) return false
    this.nextSeq = min
    this.priming = false
    this.concealRun = 0
    return true
  }

  private maybeRetarget(now: number): void {
    if (now - this.lastRetargetAt < 1000) return
    this.lastRetargetAt = now
    const p95 = this.percentile(0.95)
    this.autoTargetMs = Math.min(this.maxMs, Math.max(this.minMs, p95 + this.frameMs))
    if (this.preset === 'auto' && this.headroomMs > 0 && now - this.cleanSince > 10_000) {
      this.headroomMs = Math.max(0, this.headroomMs - this.frameMs)
      this.cleanSince = now
    }
  }

  private percentile(p: number): number {
    if (this.jitter.length === 0) return 0
    const a = [...this.jitter].sort((x, y) => x - y)
    return a[Math.min(a.length - 1, Math.floor(p * a.length))]
  }

  private depthFrames(): number {
    if (this.nextSeq === null) return this.frames.size
    let n = 0
    for (const k of this.frames.keys()) if (k >= this.nextSeq) n++
    return n
  }

  private silence(): Float32Array[] {
    const out: Float32Array[] = []
    for (let c = 0; c < this.o.channels; c++) out.push(new Float32Array(this.o.frameSamples))
    return out
  }

  stats(): JitterStats {
    const j = this.jitter
    const mean = j.length ? j.reduce((a, b) => a + b, 0) / j.length : 0
    return {
      targetMs: this.targetMs,
      autoTargetMs: this.autoTargetMs,
      headroomMs: this.headroomMs,
      depthMs: this.depthFrames() * this.frameMs,
      jitterP95Ms: this.percentile(0.95),
      jitterMeanMs: mean,
      ...this.s,
      preset: this.preset,
      playoutSeq: this.nextSeq,
    }
  }

  reset(): void {
    this.frames.clear()
    this.nextSeq = null
    this.priming = true
    this.concealRun = 0
    this.lastReal = null
    this.lastArrival = null
  }
}
