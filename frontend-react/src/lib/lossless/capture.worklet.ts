/**
 * 캡처 AudioWorklet — 128샘플 렌더 퀀텀을 N샘플 프레임(기본 10 ms)으로 재배치해 메인스레드로 넘긴다.
 * SharedArrayBuffer 없이 MessagePort transfer(Audiomovers 방식). 레벨(peak/rms)은 50 ms 마다.
 *
 * 메시지(워크릿 → 메인): {type:'frame', ts, channels, buf}  ts = 프레임 첫 샘플의 누적 샘플 인덱스
 *                        {type:'level', peak[], rms[]}
 * 메시지(메인 → 워크릿): {type:'frameSamples', value}
 */
import { levelOf, planarToBuffer } from './pcm'

interface Opts {
  frameSamples: number
  channels: number
}

class CaptureProcessor extends AudioWorkletProcessor {
  private frameSamples: number
  private readonly channels: number
  private acc: Float32Array[]
  private fill = 0
  private ts = 0
  private lastLevelAt = 0
  private levelAcc: Float32Array[] | null = null
  /**
   * 한 채널만 쓰는 2채널 장치(오디오 인터페이스의 입력 1, 2채널로 보고하는 일부 헤드셋·동글) — 그대로 보내면 듣는 사람이 한쪽 귀로만 듣는다.
   * 한쪽에만 소리가 1.5초 넘게 이어지면 그 채널을 양쪽에 싣는다(dupFrom). 조용하던 채널에 소리가 들어오면 바로 원래대로.
   */
  private dupFrom = -1
  private oneSidedSec = 0
  private oneSidedCh = -1

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    const o = (options?.processorOptions ?? {}) as Partial<Opts>
    this.frameSamples = o.frameSamples ?? 480
    this.channels = o.channels ?? 2
    this.acc = this.alloc()
    this.port.onmessage = (ev: MessageEvent) => {
      const m = ev.data
      if (m?.type === 'frameSamples' && m.value > 0 && m.value !== this.frameSamples) {
        this.frameSamples = m.value
        this.acc = this.alloc()
        this.fill = 0
      }
    }
  }

  private alloc(): Float32Array[] {
    const a: Float32Array[] = []
    for (let c = 0; c < this.channels; c++) a.push(new Float32Array(this.frameSamples))
    return a
  }

  private watchOneSided(input: Float32Array[], n: number): void {
    let p0 = 0
    let p1 = 0
    const a = input[0]
    const b = input[1]
    for (let i = 0; i < n; i++) { const x = Math.abs(a[i]); if (x > p0) p0 = x; const y = Math.abs(b[i]); if (y > p1) p1 = y }
    const LOUD = 0.003    // 약 -50 dBFS — 말소리가 있다
    const QUIET = 0.0003  // 약 -70 dBFS — 신호가 없다
    if (this.dupFrom >= 0) {
      // 조용하던 쪽에 소리가 들어왔다 — 진짜 스테레오다. 복제를 푼다
      const other = this.dupFrom === 0 ? p1 : p0
      if (other > 0.001) { this.dupFrom = -1; this.oneSidedSec = 0; this.port.postMessage({ type: 'monoSource', channel: -1 }) }
      return
    }
    const ch = p0 > LOUD && p1 < QUIET ? 0 : p1 > LOUD && p0 < QUIET ? 1 : -1
    if (ch < 0) { if (p0 > LOUD && p1 > LOUD) { this.oneSidedSec = 0; this.oneSidedCh = -1 } return }   // 양쪽 다 소리 → 초기화, 양쪽 다 조용 → 유지
    if (ch !== this.oneSidedCh) { this.oneSidedCh = ch; this.oneSidedSec = 0 }
    this.oneSidedSec += n / sampleRate
    if (this.oneSidedSec >= 1.5) { this.dupFrom = ch; this.port.postMessage({ type: 'monoSource', channel: ch }) }
  }

  override process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const n = input[0].length
    if (this.channels === 2 && input.length === 2) this.watchOneSided(input, n)
    const dup = this.dupFrom
    let off = 0
    while (off < n) {
      const take = Math.min(n - off, this.frameSamples - this.fill)
      for (let c = 0; c < this.channels; c++) {
        // 입력 채널이 모자라면 마지막 채널 복제(모노 장치 → 스테레오 스트림)
        const src = input[dup >= 0 ? dup : Math.min(c, input.length - 1)]
        this.acc[c].set(src.subarray(off, off + take), this.fill)
      }
      this.fill += take
      off += take
      if (this.fill === this.frameSamples) {
        const buf = planarToBuffer(this.acc)
        this.port.postMessage({ type: 'frame', ts: this.ts, channels: this.channels, inputChannels: input.length, buf }, [buf])
        this.ts = (this.ts + this.frameSamples) >>> 0
        this.fill = 0
      }
    }
    if (currentTime - this.lastLevelAt >= 0.05) {
      this.lastLevelAt = currentTime
      const lv = levelOf(dup >= 0 ? [input[dup], input[dup]] : input)
      this.port.postMessage({ type: 'level', peak: lv.peak, rms: lv.rms })
    }
    return true
  }
}

registerProcessor('jw-lossless-capture', CaptureProcessor)

