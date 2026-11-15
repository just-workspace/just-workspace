/**
 * PCM 패킹 — planar Float32 ↔ interleaved little-endian s16 / s24(packed 3 B) / f32.
 *
 * 비트퍼펙트 주의: s16·s24 정수는 2^k 로 나눈 float32 로 정확히 표현된다(정수 ≤ 2^24 는 f32 가수 안).
 * 따라서 s24 → f32(÷2^23) → s24(×2^23) 는 왕복이 정확하다. f32 는 그대로 복사.
 */
import type { LosslessCodec, LosslessFormat } from './types'

export function bytesPerSample(codec: LosslessCodec, bits: number): number {
  switch (codec) {
    case 'pcm_s16':
      return 2
    case 'pcm_s24':
      return 3
    case 'pcm_f32':
    case 'pcm_s32':
      return 4
    default:
      return bits / 8
  }
}

export function frameSamples(sampleRate: number, frameMs: number): number {
  return Math.round((sampleRate * frameMs) / 1000)
}

export function frameBytes(f: Pick<LosslessFormat, 'codec' | 'bits' | 'channels' | 'sampleRate' | 'frameMs'>): number {
  return frameSamples(f.sampleRate, f.frameMs) * f.channels * bytesPerSample(f.codec, f.bits)
}

export function bitsFor(codec: LosslessCodec): 16 | 24 | 32 {
  return codec === 'pcm_s16' ? 16 : codec === 'pcm_s24' ? 24 : 32
}

/** planar → interleaved bytes. 채널 수가 planar 보다 많으면 마지막 채널을 복제(모노 장치 → 스테레오 스트림) */
export function packPcm(planar: Float32Array[], codec: LosslessCodec, channels: number, out?: Uint8Array): Uint8Array {
  const n = planar[0]?.length ?? 0
  const bps = bytesPerSample(codec, bitsFor(codec))
  const buf = out && out.byteLength === n * channels * bps ? out : new Uint8Array(n * channels * bps)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let o = 0
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels; c++) {
      const x = (planar[Math.min(c, planar.length - 1)] ?? planar[0])[i]
      switch (codec) {
        case 'pcm_s16': {
          let v = Math.round(x * 32768)
          if (v > 32767) v = 32767
          else if (v < -32768) v = -32768
          dv.setInt16(o, v, true)
          o += 2
          break
        }
        case 'pcm_s24': {
          let v = Math.round(x * 8388608)
          if (v > 8388607) v = 8388607
          else if (v < -8388608) v = -8388608
          buf[o] = v & 0xff
          buf[o + 1] = (v >> 8) & 0xff
          buf[o + 2] = (v >> 16) & 0xff
          o += 3
          break
        }
        case 'pcm_s32': {
          // float32 가수(24-bit) 한계 — 브라우저 송신은 s32 를 정확히 못 만든다(수신 전용 코덱). 받은 걸 되돌릴 때만 쓴다
          let v = Math.round(x * 2147483648)
          if (v > 2147483647) v = 2147483647
          else if (v < -2147483648) v = -2147483648
          dv.setInt32(o, v, true)
          o += 4
          break
        }
        default:
          dv.setFloat32(o, x, true)
          o += 4
      }
    }
  }
  return buf
}

/** interleaved bytes → planar Float32Array[channels]. 길이가 안 맞으면 null */
export function unpackPcm(bytes: Uint8Array, codec: LosslessCodec, channels: number): Float32Array[] | null {
  const bps = bytesPerSample(codec, bitsFor(codec))
  if (channels < 1 || bytes.byteLength % (bps * channels) !== 0) return null
  const n = bytes.byteLength / (bps * channels)
  const out: Float32Array[] = []
  for (let c = 0; c < channels; c++) out.push(new Float32Array(n))
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let o = 0
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels; c++) {
      switch (codec) {
        case 'pcm_s16':
          out[c][i] = dv.getInt16(o, true) / 32768
          o += 2
          break
        case 'pcm_s24': {
          // sign-extend 24 → 32
          const v = (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) << 8 >> 8
          out[c][i] = v / 8388608
          o += 3
          break
        }
        case 'pcm_s32':
          // 재생용 — Float32 로 내려오며 하위 8비트는 버려진다(Web Audio 는 float32)
          out[c][i] = dv.getInt32(o, true) / 2147483648
          o += 4
          break
        default:
          out[c][i] = dv.getFloat32(o, true)
          o += 4
      }
    }
  }
  return out
}

/** planar 배열을 하나의 ArrayBuffer 로 이어 붙인다(워크릿 ↔ 메인 전송용, transfer 가능) */
export function planarToBuffer(planar: Float32Array[]): ArrayBuffer {
  const n = planar[0]?.length ?? 0
  const out = new Float32Array(n * planar.length)
  planar.forEach((ch, c) => out.set(ch, c * n))
  return out.buffer
}

export function bufferToPlanar(buf: ArrayBuffer, channels: number): Float32Array[] {
  const all = new Float32Array(buf)
  const n = all.length / channels
  const out: Float32Array[] = []
  for (let c = 0; c < channels; c++) out.push(all.subarray(c * n, (c + 1) * n))
  return out
}

/** 레벨 미터: 채널별 peak·rms */
export function levelOf(planar: Float32Array[]): { peak: number[]; rms: number[] } {
  const peak: number[] = []
  const rms: number[] = []
  for (const ch of planar) {
    let p = 0
    let s = 0
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i])
      if (a > p) p = a
      s += ch[i] * ch[i]
    }
    peak.push(p)
    rms.push(ch.length ? Math.sqrt(s / ch.length) : 0)
  }
  return { peak, rms }
}
