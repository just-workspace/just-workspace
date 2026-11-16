/**
 * PCM 바이트 ↔ 수치 변환, 포맷 간 무손실 판정, 믹싱, 바이트 단위 PLC.
 *
 * 하이레조 경로는 "바이트 그대로" 가 원칙이다 — 장치 네이티브 포맷(s16/s24/s32/f32)의 프레임을 와이어(pcm_s16/s24/s32/f32)에
 * 그대로 적재하고, 수신 측도 스트림 포맷 == 장치 포맷이면 바이트를 그대로 재생 링에 기록한다(비트퍼펙트).
 * 변환이 개입하는 경우(레이트·비트·채널 상이, 피어 둘 이상 믹싱)에만 본 파일의 함수를 거친다. float32 는 24-bit 가수이므로 s32 를 정확히 표현할 수 없어
 * 변환은 전부 Float64 로 수행한다(s16/s24/s32 정수 ≤ 2^53 — 정확).
 */
import type { SampleFormat } from '../../../../native';
import type { WireCodec } from './protocol';

export type PcmCodec = 'pcm_s16' | 'pcm_s24' | 'pcm_s32' | 'pcm_f32';

export function codecForFormat(f: SampleFormat): PcmCodec {
  switch (f) {
    case 's16': return 'pcm_s16';
    case 's24': return 'pcm_s24';
    case 's32': return 'pcm_s32';
    case 'f32': return 'pcm_f32';
    default: throw new Error(`unsupported device format ${f}`);
  }
}

export function formatForCodec(c: WireCodec | PcmCodec): SampleFormat | null {
  switch (c) {
    case 'pcm_s16': return 's16';
    case 'pcm_s24': return 's24';
    case 'pcm_s32': return 's32';
    case 'pcm_f32': return 'f32';
    default: return null;
  }
}

export function bytesPerSample(f: SampleFormat | PcmCodec): number {
  switch (f) {
    case 's16': case 'pcm_s16': return 2;
    case 's24': case 'pcm_s24': return 3;
    case 's32': case 'pcm_s32': case 'f32': case 'pcm_f32': return 4;
    case 'u8': return 1;
  }
}

export function bitsOf(c: PcmCodec): 16 | 24 | 32 {
  return c === 'pcm_s16' ? 16 : c === 'pcm_s24' ? 24 : 32;
}

export function frameSamples(sampleRate: number, frameMs: number): number {
  return Math.round((sampleRate * frameMs) / 1000);
}

/** 포맷 A 의 샘플을 포맷 B 로 변환할 때 정보가 보존되는지 여부(정수 상향·동일 포맷만 true) */
export function losslessConversion(from: SampleFormat, to: SampleFormat): boolean {
  if (from === to) return true;
  const rank: Record<string, number> = { s16: 16, s24: 24, s32: 32 };
  if (from in rank && to in rank) return rank[to] >= rank[from];
  // 정수 → f32 는 24-bit 까지만 정확, f32 → 정수는 손실
  if (to === 'f32') return from === 's16' || from === 's24';
  return false;
}

/** interleaved 바이트 → Float64Array(interleaved, -1..1 스케일). 길이가 맞지 않으면 null */
export function toFloat64(bytes: Uint8Array, f: SampleFormat): Float64Array | null {
  const bps = bytesPerSample(f);
  if (bytes.byteLength % bps !== 0) return null;
  const n = bytes.byteLength / bps;
  const out = new Float64Array(n);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (f) {
    case 's16': for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true) / 32768; break;
    case 's24': for (let i = 0, o = 0; i < n; i++, o += 3) out[i] = (((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) << 8) >> 8) / 8388608; break;
    case 's32': for (let i = 0; i < n; i++) out[i] = dv.getInt32(i * 4, true) / 2147483648; break;
    case 'f32': for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true); break;
    case 'u8': for (let i = 0; i < n; i++) out[i] = (bytes[i] - 128) / 128; break;
  }
  return out;
}

/** Float64Array(interleaved) → 포맷 바이트. 클리핑 */
export function fromFloat64(samples: ArrayLike<number>, f: SampleFormat, out?: Uint8Array): Uint8Array {
  const bps = bytesPerSample(f);
  const n = samples.length;
  const buf = out && out.byteLength === n * bps ? out : new Uint8Array(n * bps);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < n; i++) {
    let x = samples[i];
    if (x > 1) x = 1; else if (x < -1) x = -1;
    switch (f) {
      case 's16': { let v = Math.round(x * 32768); if (v > 32767) v = 32767; dv.setInt16(i * 2, v, true); break; }
      case 's24': { let v = Math.round(x * 8388608); if (v > 8388607) v = 8388607; const o = i * 3; buf[o] = v & 0xff; buf[o + 1] = (v >> 8) & 0xff; buf[o + 2] = (v >> 16) & 0xff; break; }
      case 's32': { let v = Math.round(x * 2147483648); if (v > 2147483647) v = 2147483647; dv.setInt32(i * 4, v, true); break; }
      case 'f32': dv.setFloat32(i * 4, x, true); break;
      case 'u8': buf[i] = Math.max(0, Math.min(255, Math.round(x * 128) + 128)); break;
    }
  }
  return buf;
}

/**
 * 정수 포맷 간 직접 변환(시프트) — 상향은 무손실, 하향은 하위 비트 절단. Float64 를 거치지 않으므로 비트퍼펙트가 보존된다.
 * 채널 수는 동일하다고 가정한다.
 */
export function convertInt(bytes: Uint8Array, from: SampleFormat, to: SampleFormat): Uint8Array {
  if (from === to) return bytes;
  const n = bytes.byteLength / bytesPerSample(from);
  const out = new Uint8Array(n * bytesPerSample(to));
  const inDv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const outDv = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    // 32-bit 정수 중간값으로 상향한 뒤 하향한다(시프트)
    let v32: number;
    switch (from) {
      case 's16': v32 = inDv.getInt16(i * 2, true) << 16; break;
      case 's24': { const o = i * 3; v32 = ((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) << 8); break; }
      case 's32': v32 = inDv.getInt32(i * 4, true); break;
      default: { const f = toFloat64(bytes, from)!; return fromFloat64(f, to); }
    }
    switch (to) {
      case 's16': outDv.setInt16(i * 2, v32 >> 16, true); break;
      case 's24': { const v = v32 >> 8; const o = i * 3; out[o] = v & 0xff; out[o + 1] = (v >> 8) & 0xff; out[o + 2] = (v >> 16) & 0xff; break; }
      case 's32': outDv.setInt32(i * 4, v32, true); break;
      default: outDv.setFloat32(i * 4, v32 / 2147483648, true); break;
    }
  }
  return out;
}

/** 채널 수 정합(interleaved Float64): 모노→스테레오 복제, 초과 시 앞 채널만 사용 */
export function remapChannels(x: Float64Array, from: number, to: number): Float64Array {
  if (from === to) return x;
  const frames = x.length / from;
  const out = new Float64Array(frames * to);
  for (let i = 0; i < frames; i++) for (let c = 0; c < to; c++) out[i * to + c] = x[i * from + Math.min(c, from - 1)];
  return out;
}

/** 여러 피어의 Float64(interleaved, 같은 길이) 합 — 클리핑은 fromFloat64 에서 */
export function mix(inputs: Float64Array[], length: number): Float64Array {
  const out = new Float64Array(length);
  for (const x of inputs) {
    const n = Math.min(length, x.length);
    for (let i = 0; i < n; i++) out[i] += x[i];
  }
  return out;
}

// ─── PLC(바이트 단위) — 브라우저 lib/lossless/plc.ts 와 동일한 규칙 ───
export const PLC_MAX_REPEAT = 4;
export function gainAfter(k: number): number {
  return k <= 0 ? 1 : k >= PLC_MAX_REPEAT ? 0 : Math.pow(0.5, k);
}

/** k 번째 연속 은닉 프레임: 직전 실제 프레임을 g(k-1)→g(k) 로 페이드. prev 가 없으면 무음 */
export function concealBytes(prev: Uint8Array | null, frameBytes: number, f: SampleFormat, channels: number, k: number): Uint8Array {
  const out = new Uint8Array(frameBytes);
  if (!prev || k > PLC_MAX_REPEAT || prev.byteLength !== frameBytes) return out;
  const x = toFloat64(prev, f);
  if (!x) return out;
  const frames = x.length / channels;
  const g0 = gainAfter(k - 1);
  const g1 = gainAfter(k);
  for (let i = 0; i < frames; i++) {
    const g = g0 + ((g1 - g0) * i) / frames;
    for (let c = 0; c < channels; c++) x[i * channels + c] *= g;
  }
  return fromFloat64(x, f, out);
}

/** 은닉 뒤 첫 실제 프레임을 은닉 신호와 1프레임 길이로 크로스페이드(새 배열 반환) */
export function crossfadeBytes(real: Uint8Array, prev: Uint8Array | null, f: SampleFormat, channels: number, k: number): Uint8Array {
  if (!prev || k <= 0 || prev.byteLength !== real.byteLength) return real;
  const g0 = gainAfter(k);
  if (g0 <= 0) return real;
  const a = toFloat64(real, f);
  const b = toFloat64(prev, f);
  if (!a || !b) return real;
  const frames = a.length / channels;
  for (let i = 0; i < frames; i++) {
    const t = i / frames;
    for (let c = 0; c < channels; c++) { const j = i * channels + c; a[j] = a[j] * t + b[j] * g0 * (1 - t); }
  }
  return fromFloat64(a, f);
}

/** 채널별 peak/rms(0..1) */
export function levelOf(bytes: Uint8Array, f: SampleFormat, channels: number): { peak: number[]; rms: number[] } {
  const x = toFloat64(bytes, f);
  const peak = new Array<number>(channels).fill(0);
  const sum = new Array<number>(channels).fill(0);
  if (!x) return { peak, rms: peak.slice() };
  const frames = x.length / channels;
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) { const v = x[i * channels + c]; const a = Math.abs(v); if (a > peak[c]) peak[c] = a; sum[c] += v * v; }
  return { peak, rms: sum.map((s) => (frames ? Math.sqrt(s / frames) : 0)) };
}

export function rmsToDb(rms: number): number {
  if (!(rms > 0)) return -100;
  return Math.max(-100, 20 * Math.log10(rms));
}
