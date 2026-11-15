import { describe, it, expect } from 'vitest'
import {
  encode, decode, payloadOf, fragment, Reassembler, encodeNack, decodeNack, encodeCtrl, decodeCtrl,
  encodePing, decodePingPayload, streamFrame, StreamParser, Type, Codec, Flag, HEADER_SIZE, groupBase, hexToBytes, codecName,
} from '~/lib/lossless/protocol'

describe('lossless/protocol header', () => {
  it('round-trips every field (matches Go layout)', () => {
    const payload = new Uint8Array(300).map((_, i) => (i * 7) & 0xff)
    const pkt = encode({
      type: Type.Audio, codec: Codec.pcm_s24, flags: Flag.FEC, channels: 2, bits: 24, frame: 480, rate: 48000,
      seq: 0xdeadbeef, ts: 0x01020304, src: 7, fragIdx: 1, fragCnt: 3,
    }, payload)
    expect(pkt.byteLength).toBe(HEADER_SIZE + 300)
    // byte layout spot check (big-endian)
    expect(Array.from(pkt.subarray(0, 8))).toEqual([1, 0, 1, 1, 2, 24, 0x01, 0xe0])
    expect(Array.from(pkt.subarray(8, 12))).toEqual([0, 0, 0xbb, 0x80])
    expect(Array.from(pkt.subarray(12, 16))).toEqual([0xde, 0xad, 0xbe, 0xef])
    expect(Array.from(pkt.subarray(20, 24))).toEqual([0, 7, 1, 3])
    const h = decode(pkt)!
    expect(h).toEqual({ type: 0, codec: 1, flags: 1, channels: 2, bits: 24, frame: 480, rate: 48000, seq: 0xdeadbeef, ts: 0x01020304, src: 7, fragIdx: 1, fragCnt: 3 })
    expect(payloadOf(pkt)).toEqual(payload)
    expect(codecName(h.codec)).toBe('pcm_s24')
  })

  it('rejects bad version, short packets and bad fragment counters', () => {
    const pkt = encode({ type: Type.Audio })
    pkt[0] = 2
    expect(decode(pkt)).toBeNull()
    expect(decode(new Uint8Array(HEADER_SIZE - 1))).toBeNull()
    expect(decode(encode({ type: Type.Audio, fragIdx: 2, fragCnt: 2 }))).toBeNull()
    expect(decode(encode({ type: Type.Ping }))!.fragCnt).toBe(1)
  })

  it('nack / ctrl / ping payloads', () => {
    const n = encodeNack(3, [10, 11, 4000000000])
    const h = decode(n)!
    expect(h.type).toBe(Type.Nack)
    expect(h.src).toBe(3)
    expect(decodeNack(payloadOf(n))).toEqual([10, 11, 4000000000])
    const c = encodeCtrl({ t: 'auth', token: 'x' })
    expect(decodeCtrl(payloadOf(c))).toEqual({ t: 'auth', token: 'x' })
    expect(decodeCtrl(new Uint8Array([1, 2]))).toBeNull()
    const p = encodePing(1234.5)
    expect(decodePingPayload(payloadOf(p))).toBe(1234.5)
    expect(groupBase(7)).toBe(4)
    expect(groupBase(8)).toBe(8)
    expect(hexToBytes('00ff10')).toEqual(new Uint8Array([0, 255, 16]))
  })
})

describe('lossless/protocol fragmentation', () => {
  const payload = new Uint8Array(2880).map((_, i) => i & 0xff)
  const hdr = { type: Type.Audio, codec: Codec.pcm_s24, channels: 2, bits: 24, frame: 480, rate: 48000, seq: 42 }

  it('does not fragment when it fits (or on WebSocket)', () => {
    expect(fragment(hdr, payload, Infinity)).toHaveLength(1)
    expect(fragment(hdr, payload, 2880 + HEADER_SIZE)).toHaveLength(1)
  })

  it('splits to the datagram limit and reassembles in any order', () => {
    const parts = fragment(hdr, payload, 1200)
    expect(parts.length).toBe(3)
    for (const p of parts) expect(p.byteLength).toBeLessThanOrEqual(1200)
    const r = new Reassembler()
    const shuffled = [parts[2], parts[0], parts[1]]
    let out = null
    for (const p of shuffled) out = r.push(p, decode(p)!) ?? out
    expect(out).not.toBeNull()
    expect(out!.payload).toEqual(payload)
    expect(out!.header.seq).toBe(42)
    expect(out!.header.fragCnt).toBe(1)
    expect(r.pendingCount).toBe(0)
  })

  it('a retransmitted fragment marks the reassembled frame as retransmitted (flags OR)', () => {
    const parts = fragment(hdr, payload, 1200)
    const r = new Reassembler()
    r.push(parts[0], decode(parts[0])!)
    r.push(parts[1], decode(parts[1])!)
    const retx = parts[2].slice()
    retx[3] |= Flag.Retransmit
    const out = r.push(retx, decode(retx)!)!
    expect(out.header.flags & Flag.Retransmit).toBeTruthy()
    expect(out.payload).toEqual(payload)
  })

  it('ignores duplicate fragments and bounds pending groups', () => {
    const r = new Reassembler(2)
    const parts = fragment(hdr, payload, 1200)
    expect(r.push(parts[0], decode(parts[0])!)).toBeNull()
    expect(r.push(parts[0], decode(parts[0])!)).toBeNull()
    // two more incomplete groups push the first out
    for (const seq of [43, 44]) {
      const p = fragment({ ...hdr, seq }, payload, 1200)[0]
      r.push(p, decode(p)!)
    }
    expect(r.pendingCount).toBe(2)
    expect(r.push(parts[1], decode(parts[1])!)).toBeNull()
    expect(r.push(parts[2], decode(parts[2])!)).toBeNull() // group 42 was evicted → restarted, incomplete
  })
})

describe('lossless/protocol stream framing', () => {
  it('parses length-prefixed frames across chunk boundaries', () => {
    const a = encodeCtrl({ t: 'a' })
    const b = encodeNack(1, [1, 2])
    const bytes = new Uint8Array([...streamFrame(a), ...streamFrame(b)])
    const p = new StreamParser()
    const got: Uint8Array[] = []
    for (let i = 0; i < bytes.length; i += 5) got.push(...p.push(bytes.subarray(i, Math.min(bytes.length, i + 5))))
    expect(got).toHaveLength(2)
    expect(got[0]).toEqual(a)
    expect(got[1]).toEqual(b)
  })
})
