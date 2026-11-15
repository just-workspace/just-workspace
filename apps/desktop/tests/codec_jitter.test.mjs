// codec.ts(바이트 ↔ 수치, 무손실 변환, PLC) · fec.ts(XOR 4:1) · jitter.ts(바이트 프레임 지터버퍼)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../dist/main/nativeAudio/relay/codec.js');
const F = require('../dist/main/nativeAudio/relay/fec.js');
const J = require('../dist/main/nativeAudio/relay/jitter.js');

test('s16/s24/s32 → Float64 → same format is exact (bit-perfect round trip)', () => {
  for (const [f, bps] of [['s16', 2], ['s24', 3], ['s32', 4]]) {
    const n = 1000;
    const bytes = new Uint8Array(n * bps);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 2654435761 >>> 0) & 0xff;
    const x = C.toFloat64(bytes, f);
    const back = C.fromFloat64(x, f);
    assert.deepEqual(back, bytes, f);
  }
});

test('int→int upward conversion is lossless and reversible; losslessConversion table', () => {
  const s16 = new Uint8Array([0x34, 0x12, 0x00, 0x80, 0xff, 0x7f]);
  const s32 = C.convertInt(s16, 's16', 's32');
  assert.deepEqual(C.convertInt(s32, 's32', 's16'), s16);
  const s24 = C.convertInt(s16, 's16', 's24');
  assert.deepEqual(C.convertInt(s24, 's24', 's16'), s16);
  assert.equal(C.losslessConversion('s24', 's32'), true);
  assert.equal(C.losslessConversion('s32', 's24'), false);
  assert.equal(C.losslessConversion('s24', 'f32'), true);
  assert.equal(C.losslessConversion('s32', 'f32'), false);
  assert.equal(C.losslessConversion('f32', 's24'), false);
  assert.equal(C.codecForFormat('s32'), 'pcm_s32');
  assert.equal(C.formatForCodec('pcm_s24'), 's24');
});

test('mix + remapChannels + level', () => {
  const a = new Float64Array([0.5, -0.5, 0.25, 0.25]);
  const b = new Float64Array([0.5, 0.5, 0.25, -0.25]);
  assert.deepEqual(Array.from(C.mix([a, b], 4)), [1, 0, 0.5, 0]);
  assert.deepEqual(Array.from(C.remapChannels(new Float64Array([1, 2]), 1, 2)), [1, 1, 2, 2]);
  const lv = C.levelOf(C.fromFloat64(new Float64Array([0.5, -0.25, 0.5, -0.25]), 's24'), 's24', 2);
  assert.ok(Math.abs(lv.peak[0] - 0.5) < 1e-6 && Math.abs(lv.peak[1] - 0.25) < 1e-6);
  assert.equal(C.rmsToDb(0), -100);
  assert.ok(Math.abs(C.rmsToDb(1)) < 1e-9);
});

test('PLC: conceal fades previous frame, silence after 4, crossfade back', () => {
  const prev = C.fromFloat64(new Float64Array(96).fill(0.8), 's24');
  const k1 = C.toFloat64(C.concealBytes(prev, prev.byteLength, 's24', 2, 1), 's24');
  assert.ok(Math.abs(k1[0] - 0.8) < 1e-5 && k1[94] < 0.45 && k1[94] > 0.35);
  const k5 = C.concealBytes(prev, prev.byteLength, 's24', 2, 5);
  assert.ok(k5.every((b) => b === 0));
  assert.ok(C.concealBytes(null, 96, 's24', 2, 1).every((b) => b === 0));
  const real = C.fromFloat64(new Float64Array(96).fill(-0.2), 's24');
  const xf = C.toFloat64(C.crossfadeBytes(real, prev, 's24', 2, 1), 's24');
  assert.ok(xf[0] > 0.3 && Math.abs(xf[94] + 0.2) < 0.03);
});

test('XOR parity 4:1 recovers one missing frame of a group', () => {
  const enc = new F.ParityEncoder();
  const frames = [0, 1, 2, 3].map((i) => new Uint8Array(64).map((_, j) => (i * 17 + j) & 0xff));
  let par = null;
  frames.forEach((f, i) => { const p = enc.push(i, f); if (p) par = p; });
  assert.ok(par && par.seq === 3);
  const dec = new F.ParityDecoder();
  dec.addFrame(0, frames[0]); dec.addFrame(1, frames[1]); dec.addFrame(3, frames[3]);
  const rec = dec.addParity(3, par.payload);
  assert.equal(rec.seq, 2);
  assert.deepEqual(rec.payload, frames[2]);
});

test('jitter buffer: primes, plays in order, conceals a gap, late frames counted (raw s32 bytes preserved)', () => {
  let t = 0;
  const now = () => t;
  const fs = 480, ch = 2;
  const jb = new J.JitterBuffer({ frameSamples: fs, sampleRate: 48000, channels: ch, format: 's32', preset: 60, now });
  const frame = (seq) => new Uint8Array(fs * ch * 4).map((_, i) => (seq * 131 + i * 7) & 0xff);
  for (let s = 0; s < 8; s++) { if (s === 5) continue; jb.push(s, frame(s), s * 10); }
  const kinds = [];
  const outs = [];
  for (let i = 0; i < 16; i++) { t += 10; const p = jb.pull(); kinds.push(p.kind); outs.push(p); }
  assert.equal(kinds[0], 'ok');
  const okIdx = outs.findIndex((p) => p.kind === 'ok' && p.seq === 4);
  assert.ok(okIdx >= 0);
  assert.deepEqual(outs[okIdx].bytes, frame(4));          // 바이트 그대로(비트퍼펙트)
  assert.ok(kinds.includes('plc'));                         // seq 5 자리
  const after = outs.find((p) => p.kind === 'ok' && p.seq === 6);
  assert.ok(after);
  jb.push(1, frame(1), 200);
  assert.equal(jb.stats().late, 1);
  assert.equal(jb.stats().preset, 60);
  assert.equal(jb.targetMs, 60);
});
