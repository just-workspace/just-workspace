/**
 * 재생 AudioWorklet — 피어 1명의 스트림. 지터버퍼(적응형) + PLC 가 렌더 스레드에서 돈다.
 * 프레임은 메인스레드가 디코딩한 planar f32 를 MessagePort 로 넘긴다(SAB 없음).
 *
 * 메인 → 워크릿: {type:'frame', seq, ts, channels, buf, arrivalMs} · {type:'preset', value} · {type:'reset'}
 * 워크릿 → 메인: {type:'stats', ...JitterStats, fifoMs} 500 ms 마다 · {type:'level', peak[], rms[]} 50 ms 마다
 */
import { JitterBuffer } from './jitter'
import { bufferToPlanar, levelOf } from './pcm'
import type { BufferPreset } from './types'

interface Opts {
  frameSamples: number
  sampleRate: number
  channels: number
  preset?: BufferPreset
  startMs?: number
}

class PlaybackProcessor extends AudioWorkletProcessor {
  private readonly jb: JitterBuffer
  private readonly channels: number
  private readonly frameSamples: number
  private fifo: Float32Array[] | null = null
  private fifoPos = 0
  private lastStatsAt = 0
  private lastLevelAt = 0
  private kinds = { ok: 0, plc: 0, silence: 0, priming: 0 }

  constructor(options?: AudioWorkletNodeOptions) {
    super(options)
    const o = options?.processorOptions as Opts
    this.channels = o.channels
    this.frameSamples = o.frameSamples
    this.jb = new JitterBuffer({
      frameSamples: o.frameSamples,
      sampleRate: o.sampleRate,
      channels: o.channels,
      preset: o.preset ?? 'auto',
      startMs: o.startMs ?? 20,
      now: () => currentTime * 1000,
    })
    this.port.onmessage = (ev: MessageEvent) => {
      const m = ev.data
      switch (m?.type) {
        case 'frame':
          this.jb.push(m.seq, bufferToPlanar(m.buf, m.channels ?? this.channels), m.arrivalMs, m.ts)
          break
        case 'preset':
          this.jb.setPreset(m.value)
          break
        case 'reset':
          this.jb.reset()
          this.fifo = null
          this.fifoPos = 0
          break
      }
    }
  }

  override process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    if (!out || out.length === 0) return true
    const n = out[0].length
    let written = 0
    while (written < n) {
      if (!this.fifo || this.fifoPos >= this.frameSamples) {
        const p = this.jb.pull()
        this.kinds[p.kind]++
        this.fifo = p.pcm
        this.fifoPos = 0
      }
      const take = Math.min(n - written, this.frameSamples - this.fifoPos)
      for (let c = 0; c < out.length; c++) {
        const src = this.fifo[Math.min(c, this.fifo.length - 1)]
        out[c].set(src.subarray(this.fifoPos, this.fifoPos + take), written)
      }
      this.fifoPos += take
      written += take
    }
    if (currentTime - this.lastLevelAt >= 0.05) {
      this.lastLevelAt = currentTime
      const lv = levelOf(out)
      this.port.postMessage({ type: 'level', peak: lv.peak, rms: lv.rms })
    }
    if (currentTime - this.lastStatsAt >= 0.5) {
      this.lastStatsAt = currentTime
      this.port.postMessage({ type: 'stats', ...this.jb.stats(), kinds: { ...this.kinds }, frameMs: this.jb.frameMs })
    }
    return true
  }
}

registerProcessor('jw-lossless-playback', PlaybackProcessor)
