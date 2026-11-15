// 무손실 캡처 워클릿 — 한 채널에만 소리가 실리는 2채널 장치를 양쪽으로 복제하는지("한쪽 귀만 들림")
import { describe, it, expect, beforeAll } from 'vitest'

type Proc = { process(inputs: Float32Array[][]): boolean; port: { posted: any[]; postMessage(m: any): void; onmessage: unknown } }
let Ctor: new (o?: unknown) => Proc

beforeAll(async () => {
  const g = globalThis as any
  g.sampleRate = 48000
  g.currentTime = 0
  g.AudioWorkletProcessor = class { port = { posted: [] as any[], postMessage(m: any) { this.posted.push(m) }, onmessage: null } }
  g.registerProcessor = (_name: string, ctor: any) => { Ctor = ctor }
  await import('~/lib/lossless/capture.worklet')
})

const block = (l: number, r: number) => [new Float32Array(128).fill(l), new Float32Array(128).fill(r)]
/** 프레임(480샘플 · 2채널 평면 Float32)의 채널별 첫 샘플 */
function lastFrame(p: Proc): [number, number] | null {
  const f = [...p.port.posted].reverse().find(m => m.type === 'frame')
  if (!f) return null
  const a = new Float32Array(f.buf)
  return [a[0], a[a.length / 2]]
}
const run = (p: Proc, seconds: number, l: number, r: number) => { for (let i = 0; i < Math.ceil((seconds * 48000) / 128); i++) p.process([block(l, r)]) }

describe('무손실 캡처 — 한쪽 채널만 쓰는 장치', () => {
  it('왼쪽에만 소리가 1.5초 넘게 이어지면 양쪽에 싣고, 오른쪽에 소리가 들어오면 원래대로', () => {
    const p = new Ctor({ processorOptions: { frameSamples: 480, channels: 2 } })
    run(p, 1.0, 0.2, 0)
    expect(lastFrame(p)).toEqual([expect.closeTo(0.2, 5), 0])            // 아직 판정 전 — 그대로
    run(p, 1.0, 0.2, 0)
    expect(lastFrame(p)).toEqual([expect.closeTo(0.2, 5), expect.closeTo(0.2, 5)])   // 양쪽으로 복제
    expect(p.port.posted.some(m => m.type === 'monoSource' && m.channel === 0)).toBe(true)
    run(p, 0.1, 0.2, 0.1)                                                 // 진짜 스테레오 신호가 들어왔다
    expect(lastFrame(p)).toEqual([expect.closeTo(0.2, 5), expect.closeTo(0.1, 5)])
  })

  it('양쪽에 소리가 있는 스테레오는 건드리지 않는다 · 조용한 구간은 판정을 초기화하지 않는다', () => {
    const p = new Ctor({ processorOptions: { frameSamples: 480, channels: 2 } })
    run(p, 3, 0.2, 0.05)
    expect(lastFrame(p)).toEqual([expect.closeTo(0.2, 5), expect.closeTo(0.05, 5)])
    expect(p.port.posted.some(m => m.type === 'monoSource')).toBe(false)
    const q = new Ctor({ processorOptions: { frameSamples: 480, channels: 2 } })
    run(q, 1.0, 0, 0.2); run(q, 2.0, 0, 0); run(q, 0.8, 0, 0.2)           // 말 → 쉼 → 말: 합쳐 1.5초를 넘는다
    expect(lastFrame(q)).toEqual([expect.closeTo(0.2, 5), expect.closeTo(0.2, 5)])
  })
})
