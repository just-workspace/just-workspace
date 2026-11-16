/**
 * 적응형 지터버퍼 — 브라우저 lib/lossless/jitter.ts 와 동일한 정책(SonoBus + JackTrip 혼합)을 "바이트 프레임" 기준으로 이식한 것.
 * 프레임을 Float32 로 변환하지 않고 와이어 바이트 그대로 보유하므로 s32 까지 비트퍼펙트가 보존된다. PLC/크로스페이드만 codec.ts 로 수치 변환.
 *
 * - 시작 20 ms. 1 s 마다 도착간격 지터 p95 + 1프레임으로 자동 목표. 언더런이면 +1프레임 헤드룸(0.5 s 1회), 10 s 무언더런이면 −1프레임.
 * - "안정화" 프리셋(60/120/250 ms)은 목표 고정.
 * - 목표+2프레임 초과 0.5 s → 1프레임 드롭(따라잡기), 목표−2프레임 미만 1 s → 은닉 1개 삽입(선제 확장).
 * - 누락 프레임은 PLC(직전 프레임 반복+페이드), 고갈 시 헤드를 정지하고 은닉, 장기화 시 재프라이밍.
 */
import type { SampleFormat } from '../../../../native';
import { concealBytes, crossfadeBytes, PLC_MAX_REPEAT } from './codec';

export type BufferPreset = 'auto' | 60 | 120 | 250;

export interface JitterOptions {
  frameSamples: number;
  sampleRate: number;
  channels: number;
  format: SampleFormat;
  startMs?: number;
  minMs?: number;
  maxMs?: number;
  preset?: BufferPreset;
  now: () => number;
}

export type PullKind = 'ok' | 'plc' | 'silence' | 'priming';
export interface Pulled { kind: PullKind; bytes: Uint8Array; seq: number | null }

export interface JitterStats {
  targetMs: number; autoTargetMs: number; headroomMs: number; depthMs: number; jitterP95Ms: number; jitterMeanMs: number;
  received: number; played: number; lost: number; plc: number; late: number; underruns: number; dropped: number; expanded: number;
  duplicates: number; primed: number; preset: BufferPreset; playoutSeq: number | null;
}

const JITTER_WINDOW = 256;
const MAX_STORED = 1000;
const UNDERRUN_REPRIME_FRAMES = 100;

export class JitterBuffer {
  readonly frameMs: number;
  readonly frameBytes: number;
  private frames = new Map<number, Uint8Array>();
  private nextSeq: number | null = null;
  private priming = true;
  private preset: BufferPreset;
  private readonly minMs: number;
  private readonly maxMs: number;
  private autoTargetMs: number;
  private headroomMs = 0;
  private jitter: number[] = [];
  private jitterIdx = 0;
  private lastArrival: { seq: number; transit: number } | null = null;
  private lastReal: Uint8Array | null = null;
  private concealRun = 0;
  private lastRetargetAt: number;
  private lastUnderrunAt = -Infinity;
  private lastHeadroomUpAt = -Infinity;
  private cleanSince: number;
  private highSince: number | null = null;
  private lowSince: number | null = null;
  private s = { received: 0, played: 0, lost: 0, plc: 0, late: 0, underruns: 0, dropped: 0, expanded: 0, duplicates: 0, primed: 0 };

  constructor(private readonly o: JitterOptions) {
    this.frameMs = (o.frameSamples / o.sampleRate) * 1000;
    this.frameBytes = o.frameSamples * o.channels * (o.format === 's16' ? 2 : o.format === 's24' ? 3 : o.format === 'u8' ? 1 : 4);
    this.minMs = o.minMs ?? 20;
    this.maxMs = o.maxMs ?? 500;
    this.autoTargetMs = Math.max(this.minMs, o.startMs ?? 20);
    this.preset = o.preset ?? 'auto';
    this.lastRetargetAt = o.now();
    this.cleanSince = o.now();
  }

  get targetMs(): number {
    if (this.preset !== 'auto') return this.preset;
    return Math.min(this.maxMs, this.autoTargetMs + this.headroomMs);
  }
  private get targetFrames(): number { return Math.max(1, Math.ceil(this.targetMs / this.frameMs)); }

  setPreset(p: BufferPreset): void { this.preset = p; this.highSince = null; this.lowSince = null; }

  push(seq: number, bytes: Uint8Array, arrivalMs: number): void {
    this.s.received++;
    const transit = arrivalMs - seq * this.frameMs;
    if (this.lastArrival && Math.abs(seq - this.lastArrival.seq) <= 1024) {
      const j = Math.abs(transit - this.lastArrival.transit);
      if (this.jitter.length < JITTER_WINDOW) this.jitter.push(j);
      else { this.jitter[this.jitterIdx] = j; this.jitterIdx = (this.jitterIdx + 1) % JITTER_WINDOW; }
    }
    this.lastArrival = { seq, transit };
    if (this.nextSeq !== null && !this.priming && seq < this.nextSeq) { this.s.late++; return; }
    if (this.frames.has(seq)) { this.s.duplicates++; return; }
    if (this.frames.size >= MAX_STORED) { this.frames.delete(Math.min(...this.frames.keys())); this.s.dropped++; }
    this.frames.set(seq, bytes);
  }

  pull(): Pulled {
    const now = this.o.now();
    this.maybeRetarget(now);
    if (this.priming) {
      if (this.tryPrime()) this.s.primed++;
      else return { kind: 'priming', bytes: this.silence(), seq: null };
    }
    const seq = this.nextSeq!;
    const depth = this.depthFrames();
    if (depth > 0 && depth < this.targetFrames - 2) {
      if (this.lowSince === null) this.lowSince = now;
      else if (now - this.lowSince > 1000) {
        this.lowSince = null;
        this.s.expanded++;
        return { kind: 'plc', bytes: this.conceal(1), seq: null };
      }
    } else this.lowSince = null;

    if (depth > this.targetFrames + 2) {
      if (this.highSince === null) this.highSince = now;
      else if (now - this.highSince > 500) {
        this.highSince = null;
        const f = this.frames.get(seq);
        if (f) { this.frames.delete(seq); this.lastReal = f; }
        this.nextSeq = seq + 1;
        this.s.dropped++;
        return this.pull();
      }
    } else this.highSince = null;

    const f = this.frames.get(seq);
    if (f) {
      this.frames.delete(seq);
      this.nextSeq = seq + 1;
      const out = this.concealRun > 0 ? crossfadeBytes(f, this.lastReal, this.o.format, this.o.channels, this.concealRun) : f;
      this.concealRun = 0;
      this.lastReal = f;
      this.s.played++;
      return { kind: 'ok', bytes: out, seq };
    }

    if (depth > 0) {
      const maxSeq = Math.max(...this.frames.keys());
      if (maxSeq - seq > 64) {
        const minSeq = Math.min(...this.frames.keys());
        this.s.lost += minSeq - seq;
        this.nextSeq = minSeq;
        return this.pull();
      }
      if (depth + this.concealRun >= this.targetFrames) {
        this.nextSeq = seq + 1;
        this.s.lost++;
        this.s.plc++;
        this.concealRun++;
        return { kind: 'plc', bytes: this.conceal(this.concealRun), seq: null };
      }
      this.s.plc++;
      this.concealRun++;
      return { kind: 'plc', bytes: this.conceal(this.concealRun), seq: null };
    }

    if (this.concealRun === 0 || now - this.lastUnderrunAt > this.frameMs * 2) {
      this.s.underruns++;
      this.cleanSince = now;
      if (this.preset === 'auto' && now - this.lastHeadroomUpAt > 500) {
        this.headroomMs = Math.min(this.maxMs, this.headroomMs + this.frameMs);
        this.lastHeadroomUpAt = now;
      }
    }
    this.lastUnderrunAt = now;
    this.concealRun++;
    this.s.plc++;
    if (this.concealRun > UNDERRUN_REPRIME_FRAMES) {
      this.priming = true;
      this.nextSeq = null;
      this.concealRun = 0;
      this.lastReal = null;
      return { kind: 'silence', bytes: this.silence(), seq: null };
    }
    const kind: PullKind = this.concealRun <= PLC_MAX_REPEAT ? 'plc' : 'silence';
    return { kind, bytes: this.conceal(this.concealRun), seq: null };
  }

  private conceal(k: number): Uint8Array {
    return concealBytes(this.lastReal, this.frameBytes, this.o.format, this.o.channels, k);
  }

  private tryPrime(): boolean {
    if (this.frames.size === 0) return false;
    const keys = [...this.frames.keys()];
    const min = Math.min(...keys);
    const max = Math.max(...keys);
    if ((max - min + 1) * this.frameMs < this.targetMs && this.frames.size < this.targetFrames) return false;
    this.nextSeq = min;
    this.priming = false;
    this.concealRun = 0;
    return true;
  }

  private maybeRetarget(now: number): void {
    if (now - this.lastRetargetAt < 1000) return;
    this.lastRetargetAt = now;
    const p95 = this.percentile(0.95);
    this.autoTargetMs = Math.min(this.maxMs, Math.max(this.minMs, p95 + this.frameMs));
    if (this.preset === 'auto' && this.headroomMs > 0 && now - this.cleanSince > 10_000) {
      this.headroomMs = Math.max(0, this.headroomMs - this.frameMs);
      this.cleanSince = now;
    }
  }

  private percentile(p: number): number {
    if (this.jitter.length === 0) return 0;
    const a = [...this.jitter].sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(p * a.length))];
  }

  private depthFrames(): number {
    if (this.nextSeq === null) return this.frames.size;
    let n = 0;
    for (const k of this.frames.keys()) if (k >= this.nextSeq) n++;
    return n;
  }

  private silence(): Uint8Array { return new Uint8Array(this.frameBytes); }

  stats(): JitterStats {
    const j = this.jitter;
    const mean = j.length ? j.reduce((a, b) => a + b, 0) / j.length : 0;
    return {
      targetMs: this.targetMs, autoTargetMs: this.autoTargetMs, headroomMs: this.headroomMs, depthMs: this.depthFrames() * this.frameMs,
      jitterP95Ms: this.percentile(0.95), jitterMeanMs: mean, ...this.s, preset: this.preset, playoutSeq: this.nextSeq,
    };
  }

  reset(): void {
    this.frames.clear();
    this.nextSeq = null;
    this.priming = true;
    this.concealRun = 0;
    this.lastReal = null;
    this.lastArrival = null;
  }
}
