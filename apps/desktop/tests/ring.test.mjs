// 링버퍼(ring_buffer.h) — 애드온 RingTest 로 실제 C++ 구현을 실행한다. 용량 올림·프레임 원자성·랩어라운드·discard·대량 왕복.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// 애드온은 리포에 포함되지 않는다(빌드 산출물) — 빌드하지 않은 환경에서는 사유를 기록하고 건너뛴다.
// 빌드했으나 로드에 실패하는 경우(손상된 바이너리 등)는 건너뛰지 않고 실패 처리한다.
// 애드온이 필수인 환경(릴리스 빌드)에서는 JW_REQUIRE_NATIVE=1 로 건너뛰기를 실패로 전환한다.
let native = null;
let skip = false;
try {
  native = require('../native/index.js').load();
} catch (e) {
  if (e?.code !== 'JW_NATIVE_AUDIO_MISSING' || process.env.JW_REQUIRE_NATIVE === '1') throw e;
  skip = '네이티브 애드온(native/build/Release/jw_native_audio.node)이 빌드되지 않았다 — npm run native:build:node (Windows + MSVC 빌드 도구)';
}

test('capacity rounds up to power of two; empty reads 0', { skip }, () => {
  const r = new native.RingTest(100);
  assert.equal(r.capacity(), 128);
  assert.equal(r.available(), 0);
  assert.equal(r.read(new Uint8Array(10)), 0);
});

test('write is all-or-nothing (frame atomicity) and wraps around', { skip }, () => {
  const r = new native.RingTest(128);
  assert.equal(r.write(new Uint8Array(70).fill(1)), 70);
  assert.equal(r.write(new Uint8Array(70).fill(2)), 0);   // 58 만 남음 → 거부
  assert.equal(r.available(), 70);
  const out = new Uint8Array(50);
  assert.equal(r.read(out), 50);
  assert.ok(out.every((b) => b === 1));
  assert.equal(r.write(new Uint8Array(100).fill(3)), 100); // 랩어라운드
  assert.equal(r.available(), 120);
  const rest = new Uint8Array(120);
  assert.equal(r.read(rest), 120);
  assert.ok(rest.subarray(0, 20).every((b) => b === 1));
  assert.ok(rest.subarray(20).every((b) => b === 3));
  assert.equal(r.available(), 0);
});

test('byte order survives many wraps (sequence check)', { skip }, () => {
  const r = new native.RingTest(1024);
  let w = 0, rd = 0;
  const chunk = new Uint8Array(97);
  const out = new Uint8Array(61);
  for (let step = 0; step < 5000; step++) {
    for (let i = 0; i < chunk.length; i++) chunk[i] = (w + i) & 0xff;
    if (r.write(chunk) === chunk.length) w += chunk.length;
    const n = r.read(out);
    for (let i = 0; i < n; i++) assert.equal(out[i], (rd + i) & 0xff);
    rd += n;
  }
  assert.ok(w > 100000);
  assert.equal(w - rd, r.available());
});

test('discard drops oldest bytes; reset empties', { skip }, () => {
  const r = new native.RingTest(64);
  r.write(new Uint8Array([1, 2, 3, 4, 5, 6]));
  assert.equal(r.discard(4), 4);
  const out = new Uint8Array(2);
  assert.equal(r.read(out), 2);
  assert.deepEqual(Array.from(out), [5, 6]);
  r.write(new Uint8Array(10));
  r.reset();
  assert.equal(r.available(), 0);
});
