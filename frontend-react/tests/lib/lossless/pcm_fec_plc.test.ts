import { describe, it, expect } from 'vitest'
import { packPcm, unpackPcm, frameBytes, frameSamples, bytesPerSample, planarToBuffer, bufferToPlanar, levelOf } from '~/lib/lossless/pcm'
import { ParityEncoder, ParityDecoder, xorInto } from '~/lib/lossless/fec'
import { concealFrame, crossfadeIn, gainAfter, PLC_MAX_REPEAT } from '~/lib/lossless/plc'

function sweep(n: number, seed = 1): Float32Array {
  const out = new Float32Array(n)
  let x = seed
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    out[i] = (x / 0x7fffffff) * 2 - 1
  }
  return out
}

describe('lossless/pcm', () => {
  it('sizes', () => {
    expect(frameSamples(48000, 10)).toBe(480)
    expect(frameSamples(48000, 2.5)).toBe(120)
    expect(frameSamples(96000, 10)).toBe(960)
    expect(bytesPerSample('pcm_s24', 24)).toBe(3)
    expect(frameBytes({ codec: 'pcm_s24', bits: 24, channels: 2, sampleRate: 48000, frameMs: 10 })).toBe(2880)
    expect(frameBytes({ codec: 'pcm_f32', bits: 32, channels: 2, sampleRate: 96000, frameMs: 10 })).toBe(7680)
  })

  it('s24 round-trip is bit-exact for 24-bit-quantised input', () => {
    const q = new Float32Array(480).map((_, i) => Math.round((Math.sin(i / 7) * 0.9) * 8388607) / 8388608)
    const bytes = packPcm([q, q], 'pcm_s24', 2)
    expect(bytes.byteLength).toBe(2880)
    const back = unpackPcm(bytes, 'pcm_s24', 2)!
    expect(back[0]).toEqual(q)
    expect(back[1]).toEqual(q)
    // and a second pack yields identical bytes (what the e2e hash compares)
    expect(packPcm(back, 'pcm_s24', 2)).toEqual(bytes)
  })

  it('s16 and f32 round-trip, clamping extremes', () => {
    const x = new Float32Array([1.5, -1.5, 0, 0.5, -0.25])
    const s16 = unpackPcm(packPcm([x], 'pcm_s16', 1), 'pcm_s16', 1)![0]
    expect(Array.from(s16)).toEqual([32767 / 32768, -1, 0, 0.5, -0.25])
    const s24 = unpackPcm(packPcm([x], 'pcm_s24', 1), 'pcm_s24', 1)![0]
    expect(Array.from(s24)).toEqual([8388607 / 8388608, -1, 0, 0.5, -0.25])
    const f32 = unpackPcm(packPcm([x], 'pcm_f32', 1), 'pcm_f32', 1)![0]
    expect(f32).toEqual(x)
  })

  it('interleaves channels LRLR and duplicates mono input to stereo', () => {
    const l = new Float32Array([0.5, -0.5])
    const r = new Float32Array([0.25, -0.25])
    const bytes = packPcm([l, r], 'pcm_s16', 2)
    const dv = new DataView(bytes.buffer)
    expect([dv.getInt16(0, true), dv.getInt16(2, true), dv.getInt16(4, true), dv.getInt16(6, true)]).toEqual([16384, 8192, -16384, -8192])
    const mono = packPcm([l], 'pcm_s16', 2)
    const back = unpackPcm(mono, 'pcm_s16', 2)!
    expect(back[0]).toEqual(back[1])
    expect(unpackPcm(new Uint8Array(5), 'pcm_s16', 2)).toBeNull()
  })

  it('planar <-> buffer and level', () => {
    const a = sweep(100, 3)
    const b = sweep(100, 4)
    const planar = bufferToPlanar(planarToBuffer([a, b]), 2)
    expect(planar[0]).toEqual(a)
    expect(planar[1]).toEqual(b)
    const lv = levelOf([new Float32Array([0.5, -1]), new Float32Array([0, 0])])
    expect(lv.peak).toEqual([1, 0])
    expect(lv.rms[0]).toBeCloseTo(Math.sqrt((0.25 + 1) / 2))
  })
})

describe('lossless/fec XOR parity 4:1', () => {
  const frames = [0, 1, 2, 3].map((s) => packPcm([sweep(120, s + 10), sweep(120, s + 20)], 'pcm_s24', 2))

  it('encoder emits parity on the 4th frame of a group and recovers any single loss', () => {
    const enc = new ParityEncoder()
    expect(enc.push(0, frames[0])).toBeNull()
    expect(enc.push(1, frames[1])).toBeNull()
    expect(enc.push(2, frames[2])).toBeNull()
    const par = enc.push(3, frames[3])!
    expect(par.seq).toBe(3)
    const check = frames[0].slice()
    xorInto(check, frames[1]); xorInto(check, frames[2]); xorInto(check, frames[3])
    expect(par.payload).toEqual(check)

    for (const missing of [0, 1, 2, 3]) {
      const dec = new ParityDecoder()
      for (let s = 0; s < 4; s++) if (s !== missing) dec.addFrame(s, frames[s])
      const rec = dec.addParity(3, par.payload)!
      expect(rec.seq).toBe(missing)
      expect(rec.payload).toEqual(frames[missing])
      expect(dec.has(missing)).toBe(true)
    }
  })

  it('parity arriving first, then frames; two losses cannot be recovered; recovers once only', () => {
    const enc = new ParityEncoder()
    let par: { seq: number; payload: Uint8Array } | null = null
    for (let s = 0; s < 4; s++) par = enc.push(s, frames[s]) ?? par
    const dec = new ParityDecoder()
    expect(dec.addParity(3, par!.payload)).toBeNull()
    dec.addFrame(0, frames[0])
    dec.addFrame(1, frames[1])
    expect(dec.tryRecover(0)).toBeNull() // 2 missing
    dec.addFrame(3, frames[3])
    expect(dec.tryRecover(0)!.seq).toBe(2)
    expect(dec.tryRecover(0)).toBeNull() // already recovered
  })

  it('encoder restarts on a format change (length mismatch) and groups are bounded', () => {
    const enc = new ParityEncoder()
    enc.push(4, frames[0])
    enc.push(5, new Uint8Array(10))
    enc.push(6, new Uint8Array(10))
    expect(enc.push(7, new Uint8Array(10))).toBeNull() // only 3 frames of the new length
    const dec = new ParityDecoder(2)
    dec.addFrame(0, frames[0]); dec.addFrame(4, frames[0]); dec.addFrame(8, frames[0])
    expect(dec.size).toBe(2)
    expect(dec.has(0)).toBe(false)
  })
})

describe('lossless/plc', () => {
  it('repeat + fade then silence; crossfade on return', () => {
    const prev = [new Float32Array(100).fill(1), new Float32Array(100).fill(-1)]
    expect(gainAfter(0)).toBe(1)
    expect(gainAfter(PLC_MAX_REPEAT)).toBe(0)
    const k1 = concealFrame(prev, 100, 2, 1)
    expect(k1[0][0]).toBeCloseTo(1)
    expect(k1[0][99]).toBeCloseTo(0.5, 1)
    expect(k1[1][0]).toBeCloseTo(-1)
    const k2 = concealFrame(prev, 100, 2, 2)
    expect(k2[0][0]).toBeCloseTo(0.5)
    expect(k2[0][99]).toBeCloseTo(0.25, 1)
    const far = concealFrame(prev, 100, 2, PLC_MAX_REPEAT + 1)
    expect(far[0].every((v) => v === 0)).toBe(true)
    expect(concealFrame(null, 100, 2, 1)[0].every((v) => v === 0)).toBe(true)

    const real = [new Float32Array(100).fill(0.2), new Float32Array(100).fill(0.2)]
    crossfadeIn(real, prev, 1)
    expect(real[0][0]).toBeCloseTo(0.5) // starts at prev*g(1)
    expect(real[0][99]).toBeCloseTo(0.2, 1)
    const untouched = [new Float32Array(10).fill(0.3)]
    crossfadeIn(untouched, prev, 0)
    expect(untouched[0][0]).toBeCloseTo(0.3)
  })
})
