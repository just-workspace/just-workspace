/**
 * PLC(패킷 손실 은닉) — 직전 프레임 반복 + 선형 페이드(JackTrip Regulator 의 복귀 크로스페이드를 단순화).
 *
 * k 번째 연속 은닉 프레임: 직전 "실제" 프레임을 g(k-1) → g(k) 로 선형 페이드해 재생, g(k) = 0.5^k.
 * 4프레임 정도 경과하면 사실상 무음. 실제 프레임이 복귀하면 첫 프레임을 은닉 신호와 1프레임 길이로 크로스페이드한다.
 */

export const PLC_MAX_REPEAT = 4

export function gainAfter(k: number): number {
  return k <= 0 ? 1 : k >= PLC_MAX_REPEAT ? 0 : Math.pow(0.5, k)
}

/** 은닉 프레임을 생성한다. prev 가 없으면 무음 */
export function concealFrame(prev: Float32Array[] | null, frameSamples: number, channels: number, k: number): Float32Array[] {
  const out: Float32Array[] = []
  for (let c = 0; c < channels; c++) out.push(new Float32Array(frameSamples))
  if (!prev || k > PLC_MAX_REPEAT) return out
  const g0 = gainAfter(k - 1)
  const g1 = gainAfter(k)
  for (let c = 0; c < channels; c++) {
    const src = prev[Math.min(c, prev.length - 1)]
    const dst = out[c]
    const n = Math.min(frameSamples, src.length)
    for (let i = 0; i < n; i++) {
      const g = g0 + ((g1 - g0) * i) / frameSamples
      dst[i] = src[i] * g
    }
  }
  return out
}

/**
 * 은닉 후 첫 실제 프레임: 은닉 신호(prev 를 g 로 페이드아웃)와 실제 프레임(페이드인)을 혼합한다.
 * in-place 로 변경한다.
 */
export function crossfadeIn(real: Float32Array[], prev: Float32Array[] | null, k: number): void {
  if (!prev || k <= 0) return
  const g0 = gainAfter(k)
  if (g0 <= 0) return
  const n = real[0].length
  for (let c = 0; c < real.length; c++) {
    const src = prev[Math.min(c, prev.length - 1)]
    const dst = real[c]
    for (let i = 0; i < n && i < src.length; i++) {
      const t = i / n
      dst[i] = dst[i] * t + src[i] * g0 * (1 - t)
    }
  }
}
