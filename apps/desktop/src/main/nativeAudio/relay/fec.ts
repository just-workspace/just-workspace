/** XOR 패리티 4:1 (PROTOCOL.md §3.1) — 브라우저 lib/lossless/fec.ts 와 동일한 알고리즘. 고정 길이 PCM 전용 */
import { PARITY_GROUP, groupBase } from './protocol';

export function xorInto(dst: Uint8Array, src: Uint8Array): void {
  const n = Math.min(dst.byteLength, src.byteLength);
  for (let i = 0; i < n; i++) dst[i] ^= src[i];
}

export class ParityEncoder {
  private acc: Uint8Array | null = null;
  private count = 0;
  private base = -1;

  push(seq: number, payload: Uint8Array): { seq: number; payload: Uint8Array } | null {
    const base = groupBase(seq);
    if (base !== this.base || this.acc === null || this.acc.byteLength !== payload.byteLength) {
      this.base = base;
      this.acc = payload.slice();
      this.count = 1;
    } else {
      xorInto(this.acc, payload);
      this.count++;
    }
    if (this.count === PARITY_GROUP && seq === base + PARITY_GROUP - 1) {
      const out = { seq, payload: this.acc };
      this.acc = null;
      this.count = 0;
      this.base = -1;
      return out;
    }
    return null;
  }

  reset(): void {
    this.acc = null;
    this.count = 0;
    this.base = -1;
  }
}

interface Group { frames: (Uint8Array | null)[]; parity: Uint8Array | null; recovered: boolean }

export class ParityDecoder {
  private groups = new Map<number, Group>();
  constructor(private readonly maxGroups = 16) {}

  private group(base: number): Group {
    let g = this.groups.get(base);
    if (!g) {
      g = { frames: new Array<Uint8Array | null>(PARITY_GROUP).fill(null), parity: null, recovered: false };
      this.groups.set(base, g);
      if (this.groups.size > this.maxGroups) this.groups.delete(Math.min(...this.groups.keys()));
    }
    return g;
  }

  addFrame(seq: number, payload: Uint8Array): void {
    const g = this.group(groupBase(seq));
    const i = seq - groupBase(seq);
    if (g.frames[i] === null) g.frames[i] = payload;
  }

  addParity(seq: number, payload: Uint8Array): { seq: number; payload: Uint8Array } | null {
    const base = groupBase(seq);
    this.group(base).parity = payload;
    return this.tryRecover(base);
  }

  tryRecover(base: number): { seq: number; payload: Uint8Array } | null {
    const g = this.groups.get(base);
    if (!g || g.recovered || !g.parity) return null;
    let missing = -1;
    let have = 0;
    for (let i = 0; i < PARITY_GROUP; i++) {
      if (g.frames[i] === null) missing = i;
      else have++;
    }
    if (have !== PARITY_GROUP - 1 || missing < 0) return null;
    const out = g.parity.slice();
    for (let i = 0; i < PARITY_GROUP; i++) {
      if (i !== missing) {
        if (g.frames[i]!.byteLength !== out.byteLength) return null;
        xorInto(out, g.frames[i]!);
      }
    }
    g.frames[missing] = out;
    g.recovered = true;
    return { seq: base + missing, payload: out };
  }

  has(seq: number): boolean {
    const g = this.groups.get(groupBase(seq));
    return !!g && g.frames[seq - groupBase(seq)] !== null;
  }

  get size(): number { return this.groups.size; }
}
