/**
 * XOR 패리티 4:1 (PROTOCOL.md §3.1). 고정 길이 PCM 프레임 전용.
 * 송신: 프레임 4개(seq 4g..4g+3)마다 XOR 1개. 수신: 그룹에서 정확히 1개가 빠졌을 때 복원.
 */
import { PARITY_GROUP, groupBase } from './protocol'

export function xorInto(dst: Uint8Array, src: Uint8Array): void {
  const n = Math.min(dst.byteLength, src.byteLength)
  for (let i = 0; i < n; i++) dst[i] ^= src[i]
}

/** 송신 측: 프레임을 넣다가 그룹이 차면 패리티 payload 를 돌려준다 */
export class ParityEncoder {
  private acc: Uint8Array | null = null
  private count = 0
  private base = -1

  /** @returns 그룹 마지막 프레임이면 `{ seq: 4g+3, payload }`, 아니면 null */
  push(seq: number, payload: Uint8Array): { seq: number; payload: Uint8Array } | null {
    const base = groupBase(seq)
    if (base !== this.base || this.acc === null || this.acc.byteLength !== payload.byteLength) {
      // 새 그룹(또는 포맷이 바뀌어 길이가 달라짐) — 앞 그룹이 덜 찼으면 버린다
      this.base = base
      this.acc = payload.slice()
      this.count = 1
    } else {
      xorInto(this.acc, payload)
      this.count++
    }
    if (this.count === PARITY_GROUP && seq === base + PARITY_GROUP - 1) {
      const out = { seq, payload: this.acc }
      this.acc = null
      this.count = 0
      this.base = -1
      return out
    }
    return null
  }

  reset(): void {
    this.acc = null
    this.count = 0
    this.base = -1
  }
}

interface Group {
  frames: (Uint8Array | null)[]
  parity: Uint8Array | null
  recovered: boolean
}

/** 수신 측: 그룹별로 프레임·패리티를 모아 빠진 1개를 복원 */
export class ParityDecoder {
  private groups = new Map<number, Group>()
  constructor(private readonly maxGroups = 16) {}

  private group(base: number): Group {
    let g = this.groups.get(base)
    if (!g) {
      g = { frames: new Array(PARITY_GROUP).fill(null), parity: null, recovered: false }
      this.groups.set(base, g)
      if (this.groups.size > this.maxGroups) {
        const oldest = Math.min(...this.groups.keys())
        this.groups.delete(oldest)
      }
    }
    return g
  }

  /** 프레임 도착 — 이미 복원됐거나 다른 경로로 받은 건 그대로 둔다 */
  addFrame(seq: number, payload: Uint8Array): void {
    const g = this.group(groupBase(seq))
    const i = seq - groupBase(seq)
    if (g.frames[i] === null) g.frames[i] = payload
  }

  /** 패리티 도착. @returns 이 그룹에서 지금 복원 가능한 프레임 */
  addParity(seq: number, payload: Uint8Array): { seq: number; payload: Uint8Array } | null {
    const base = groupBase(seq)
    const g = this.group(base)
    g.parity = payload
    return this.tryRecover(base)
  }

  /** 프레임이 하나 더 들어온 뒤 호출해도 된다(패리티가 먼저 왔을 때) */
  tryRecover(base: number): { seq: number; payload: Uint8Array } | null {
    const g = this.groups.get(base)
    if (!g || g.recovered || !g.parity) return null
    let missing = -1
    let have = 0
    for (let i = 0; i < PARITY_GROUP; i++) {
      if (g.frames[i] === null) missing = i
      else have++
    }
    if (have !== PARITY_GROUP - 1 || missing < 0) return null
    const out = g.parity.slice()
    for (let i = 0; i < PARITY_GROUP; i++) {
      if (i !== missing) {
        if (g.frames[i]!.byteLength !== out.byteLength) return null // 길이 불일치 — 복원 불가
        xorInto(out, g.frames[i]!)
      }
    }
    g.frames[missing] = out
    g.recovered = true
    return { seq: base + missing, payload: out }
  }

  has(seq: number): boolean {
    const g = this.groups.get(groupBase(seq))
    return !!g && g.frames[seq - groupBase(seq)] !== null
  }

  forget(base: number): void {
    this.groups.delete(base)
  }

  get size(): number {
    return this.groups.size
  }
}
