/**
 * audiorelay 전송 프로토콜 v1 — 24 B 헤더, 단편화/재조립, NACK·CTRL·PING, 스트림 프레이밍.
 * 정본: audiorelay/PROTOCOL.md · Go audiorelay/internal/proto/proto.go · 브라우저 frontend-react/src/lib/lossless/protocol.ts.
 * 본 파일은 브라우저 구현을 Node(CJS, Electron 메인)용으로 이식한 것이다 — 바이트 레이아웃은 세 구현이 동일해야 한다(tests/protocol.test.mjs 가 벡터로 대조).
 * 데스크톱 하이레조에서 추가한 항목: codec 5 = pcm_s32(32-bit 정수 LE). 미지의 codec 은 기존 클라이언트가 무시한다(PROTOCOL.md §9).
 */

export const VERSION = 1;
export const HEADER_SIZE = 24;
export const MAX_PACKET = 64 * 1024;
export const PARITY_GROUP = 4;

export const Type = { Audio: 0, Parity: 1, Nack: 2, Ping: 3, Pong: 4, Ctrl: 5 } as const;
export type PacketType = (typeof Type)[keyof typeof Type];

export type WireCodec = 'pcm_s16' | 'pcm_s24' | 'pcm_f32' | 'flac' | 'opus' | 'pcm_s32';
export const Codec: Record<WireCodec, number> = { pcm_s16: 0, pcm_s24: 1, pcm_f32: 2, flac: 3, opus: 4, pcm_s32: 5 };
const CODEC_NAMES: WireCodec[] = ['pcm_s16', 'pcm_s24', 'pcm_f32', 'flac', 'opus', 'pcm_s32'];

export const Flag = { FEC: 1 << 0, Retransmit: 1 << 1, Keyframe: 1 << 2, Muted: 1 << 3 } as const;

export interface Header {
  type: number;
  codec: number;
  flags: number;
  channels: number;
  bits: number;
  frame: number;
  rate: number;
  seq: number;
  ts: number;
  src: number;
  fragIdx: number;
  fragCnt: number;
}

export function codecName(c: number): WireCodec | 'unknown' {
  return CODEC_NAMES[c] ?? 'unknown';
}

export function encode(h: Partial<Header> & { type: number }, payload?: Uint8Array): Uint8Array {
  const n = payload ? payload.byteLength : 0;
  const out = new Uint8Array(HEADER_SIZE + n);
  const dv = new DataView(out.buffer);
  out[0] = VERSION;
  out[1] = h.type;
  out[2] = h.codec ?? 0;
  out[3] = h.flags ?? 0;
  out[4] = h.channels ?? 0;
  out[5] = h.bits ?? 0;
  dv.setUint16(6, h.frame ?? 0);
  dv.setUint32(8, h.rate ?? 0);
  dv.setUint32(12, (h.seq ?? 0) >>> 0);
  dv.setUint32(16, (h.ts ?? 0) >>> 0);
  dv.setUint16(20, h.src ?? 0);
  out[22] = h.fragIdx ?? 0;
  out[23] = h.fragCnt ?? 1;
  if (payload) out.set(payload, HEADER_SIZE);
  return out;
}

export function decode(pkt: Uint8Array): Header | null {
  if (pkt.byteLength < HEADER_SIZE || pkt.byteLength > MAX_PACKET) return null;
  if (pkt[0] !== VERSION) return null;
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const h: Header = {
    type: pkt[1], codec: pkt[2], flags: pkt[3], channels: pkt[4], bits: pkt[5],
    frame: dv.getUint16(6), rate: dv.getUint32(8), seq: dv.getUint32(12), ts: dv.getUint32(16), src: dv.getUint16(20),
    fragIdx: pkt[22], fragCnt: pkt[23],
  };
  if (h.fragCnt === 0 || h.fragIdx >= h.fragCnt) return null;
  return h;
}

export function payloadOf(pkt: Uint8Array): Uint8Array {
  return pkt.subarray(HEADER_SIZE);
}

/** 데이터그램 한도에 맞춰 프레임을 단편으로 분할한다(WebSocket 은 maxBytes=Infinity → 1개) */
export function fragment(h: Partial<Header> & { type: number }, payload: Uint8Array, maxBytes: number): Uint8Array[] {
  const room = Math.max(1, Math.floor(maxBytes) - HEADER_SIZE);
  if (!Number.isFinite(maxBytes) || payload.byteLength <= room) return [encode({ ...h, fragIdx: 0, fragCnt: 1 }, payload)];
  const cnt = Math.ceil(payload.byteLength / room);
  if (cnt > 255) throw new Error(`frame of ${payload.byteLength} B needs ${cnt} fragments (max 255)`);
  const per = Math.ceil(payload.byteLength / cnt);
  const out: Uint8Array[] = [];
  for (let i = 0; i < cnt; i++) {
    out.push(encode({ ...h, fragIdx: i, fragCnt: cnt }, payload.subarray(i * per, Math.min(payload.byteLength, (i + 1) * per))));
  }
  return out;
}

export interface Reassembled { header: Header; payload: Uint8Array }

/** (src, type, seq) 별로 단편을 수집하여 프레임을 완성한다. 미완성은 64개까지 유지하며 오래된 것부터 폐기한다 */
export class Reassembler {
  private pending = new Map<string, { header: Header; parts: (Uint8Array | null)[]; got: number }>();
  private order: string[] = [];
  constructor(private readonly maxPending = 64) {}

  push(pkt: Uint8Array, h: Header): Reassembled | null {
    if (h.fragCnt === 1) return { header: h, payload: payloadOf(pkt) };
    const key = `${h.src}:${h.type}:${h.seq}`;
    let e = this.pending.get(key);
    if (!e) {
      e = { header: h, parts: new Array<Uint8Array | null>(h.fragCnt).fill(null), got: 0 };
      this.pending.set(key, e);
      this.order.push(key);
      while (this.order.length > this.maxPending) this.pending.delete(this.order.shift()!);
    }
    if (e.parts[h.fragIdx] === null) {
      e.parts[h.fragIdx] = payloadOf(pkt).slice();
      e.got++;
    }
    e.header = { ...e.header, flags: e.header.flags | h.flags };
    if (e.got < h.fragCnt) return null;
    this.pending.delete(key);
    const i = this.order.indexOf(key);
    if (i >= 0) this.order.splice(i, 1);
    let total = 0;
    for (const p of e.parts) total += p!.byteLength;
    const payload = new Uint8Array(total);
    let off = 0;
    for (const p of e.parts) { payload.set(p!, off); off += p!.byteLength; }
    return { header: { ...e.header, fragIdx: 0, fragCnt: 1 }, payload };
  }

  get pendingCount(): number { return this.pending.size; }
}

export function encodeNack(src: number, seqs: number[]): Uint8Array {
  const list = seqs.slice(0, 64);
  const p = new Uint8Array(list.length * 4);
  const dv = new DataView(p.buffer);
  list.forEach((s, i) => dv.setUint32(i * 4, s >>> 0));
  return encode({ type: Type.Nack, src }, p);
}

export function decodeNack(payload: Uint8Array): number[] {
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const out: number[] = [];
  for (let i = 0; i + 4 <= payload.byteLength && out.length < 64; i += 4) out.push(dv.getUint32(i));
  return out;
}

const te = new TextEncoder();
const td = new TextDecoder();

export function encodeCtrl(msg: unknown, src = 0): Uint8Array {
  return encode({ type: Type.Ctrl, src }, te.encode(JSON.stringify(msg)));
}

export function decodeCtrl<T = any>(payload: Uint8Array): T | null {
  try { return JSON.parse(td.decode(payload)) as T; } catch { return null; }
}

export function encodePing(nowMs: number): Uint8Array {
  const p = new Uint8Array(8);
  new DataView(p.buffer).setFloat64(0, nowMs);
  return encode({ type: Type.Ping }, p);
}

export function decodePingPayload(payload: Uint8Array): number | null {
  if (payload.byteLength < 8) return null;
  return new DataView(payload.buffer, payload.byteOffset, 8).getFloat64(0);
}

/** 스트림 프레이밍: u16 BE 길이 + 패킷 */
export function streamFrame(pkt: Uint8Array): Uint8Array {
  if (pkt.byteLength > 65535) throw new Error('packet too large for stream frame');
  const out = new Uint8Array(2 + pkt.byteLength);
  out[0] = pkt.byteLength >>> 8;
  out[1] = pkt.byteLength & 0xff;
  out.set(pkt, 2);
  return out;
}

export class StreamParser {
  private buf: Uint8Array = new Uint8Array(0);
  push(chunk: Uint8Array): Uint8Array[] {
    if (this.buf.byteLength === 0) this.buf = chunk;
    else {
      const n = new Uint8Array(this.buf.byteLength + chunk.byteLength);
      n.set(this.buf);
      n.set(chunk, this.buf.byteLength);
      this.buf = n;
    }
    const out: Uint8Array[] = [];
    let off = 0;
    while (this.buf.byteLength - off >= 2) {
      const len = (this.buf[off] << 8) | this.buf[off + 1];
      if (this.buf.byteLength - off - 2 < len) break;
      out.push(this.buf.slice(off + 2, off + 2 + len));
      off += 2 + len;
    }
    this.buf = off ? this.buf.slice(off) : this.buf;
    return out;
  }
}

export function groupBase(seq: number): number {
  return (seq >>> 0) & ~(PARITY_GROUP - 1);
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
