// 프로토콜 — 브라우저 tests/lib/lossless/protocol.test.ts 와 동일한 벡터(Go 레이아웃). `npm run build` 후 실행(dist 를 참조한다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const P = require('../dist/main/nativeAudio/relay/protocol.js');
const { encode, decode, payloadOf, fragment, Reassembler, encodeNack, decodeNack, encodeCtrl, decodeCtrl, encodePing, decodePingPayload, streamFrame, StreamParser, Type, Codec, Flag, HEADER_SIZE, groupBase, codecName } = P;

test('header round-trips every field (Go layout, big-endian)', () => {
  const payload = new Uint8Array(300).map((_, i) => (i * 7) & 0xff);
  const pkt = encode({ type: Type.Audio, codec: Codec.pcm_s24, flags: Flag.FEC, channels: 2, bits: 24, frame: 480, rate: 48000, seq: 0xdeadbeef, ts: 0x01020304, src: 7, fragIdx: 1, fragCnt: 3 }, payload);
  assert.equal(pkt.byteLength, HEADER_SIZE + 300);
  assert.deepEqual(Array.from(pkt.subarray(0, 8)), [1, 0, 1, 1, 2, 24, 0x01, 0xe0]);
  assert.deepEqual(Array.from(pkt.subarray(8, 12)), [0, 0, 0xbb, 0x80]);
  assert.deepEqual(Array.from(pkt.subarray(12, 16)), [0xde, 0xad, 0xbe, 0xef]);
  assert.deepEqual(Array.from(pkt.subarray(20, 24)), [0, 7, 1, 3]);
  const h = decode(pkt);
  assert.deepEqual(h, { type: 0, codec: 1, flags: 1, channels: 2, bits: 24, frame: 480, rate: 48000, seq: 0xdeadbeef, ts: 0x01020304, src: 7, fragIdx: 1, fragCnt: 3 });
  assert.deepEqual(payloadOf(pkt), payload);
  assert.equal(codecName(h.codec), 'pcm_s24');
});

test('pcm_s32 is codec 5 and 192k/32-bit header fits', () => {
  const pkt = encode({ type: Type.Audio, codec: Codec.pcm_s32, channels: 2, bits: 32, frame: 1920, rate: 192000, seq: 1 });
  const h = decode(pkt);
  assert.equal(h.codec, 5);
  assert.equal(codecName(5), 'pcm_s32');
  assert.equal(h.rate, 192000);
  assert.equal(h.frame, 1920);
  assert.equal(codecName(9), 'unknown');
});

test('rejects bad version, short packets, bad fragment counters', () => {
  const pkt = encode({ type: Type.Audio });
  pkt[0] = 2;
  assert.equal(decode(pkt), null);
  assert.equal(decode(new Uint8Array(HEADER_SIZE - 1)), null);
  assert.equal(decode(encode({ type: Type.Audio, fragIdx: 2, fragCnt: 2 })), null);
  assert.equal(decode(encode({ type: Type.Ping })).fragCnt, 1);
});

test('fragmentation + reassembly (192k s32 10 ms frame = 15,360 B over 1215 B datagrams)', () => {
  const payload = new Uint8Array(1920 * 2 * 4).map((_, i) => (i * 31 + 7) & 0xff);
  const frags = fragment({ type: Type.Audio, codec: Codec.pcm_s32, channels: 2, bits: 32, frame: 1920, rate: 192000, seq: 42, src: 3 }, payload, 1215);
  assert.ok(frags.length >= 13 && frags.length <= 14, `got ${frags.length}`);
  for (const f of frags) assert.ok(f.byteLength <= 1215);
  const ra = new Reassembler();
  // 순서를 무작위로 섞어 입력한다
  const order = frags.map((_, i) => i).sort(() => Math.random() - 0.5);
  let done = null;
  for (const i of order) {
    const h = decode(frags[i]);
    const r = ra.push(frags[i], h);
    if (r) done = r;
  }
  assert.ok(done);
  assert.deepEqual(done.payload, payload);
  assert.equal(done.header.seq, 42);
  assert.equal(ra.pendingCount, 0);
  // WebSocket(무한)이면 단편 없음
  assert.equal(fragment({ type: Type.Audio }, payload, Infinity).length, 1);
});

test('nack / ctrl / ping payloads and stream framing', () => {
  const n = encodeNack(3, [10, 11, 4000000000]);
  assert.equal(decode(n).type, Type.Nack);
  assert.equal(decode(n).src, 3);
  assert.deepEqual(decodeNack(payloadOf(n)), [10, 11, 4000000000]);
  const c = encodeCtrl({ t: 'auth', token: 'x.y' });
  assert.deepEqual(decodeCtrl(payloadOf(c)), { t: 'auth', token: 'x.y' });
  const p = encodePing(1234.5);
  assert.equal(decodePingPayload(payloadOf(p)), 1234.5);
  const sp = new StreamParser();
  const framed = new Uint8Array([...streamFrame(c), ...streamFrame(p)]);
  const a = sp.push(framed.subarray(0, 10));
  const b = sp.push(framed.subarray(10));
  const all = [...a, ...b];
  assert.equal(all.length, 2);
  assert.deepEqual(all[0], c);
  assert.deepEqual(all[1], p);
  assert.equal(groupBase(7), 4);
  assert.equal(groupBase(8), 8);
});
