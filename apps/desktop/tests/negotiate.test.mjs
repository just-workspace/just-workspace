// 포맷 협상(negotiate.ts) — 후보 순서, probe 필터, 실패 분류, 가로막은 앱 고르기, 표기·비트레이트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const N = require('../dist/main/nativeAudio/negotiate.js');

test('candidates: same rate first (bits down), then lower rates in family, then 48k family', () => {
  const c = N.candidateFormats({ rate: 192000, bits: 32, channels: 2 });
  const key = (x) => `${x.bits}/${x.rate}`;
  assert.deepEqual(c.slice(0, 3).map(key), ['32/192000', '24/192000', '16/192000']);
  assert.deepEqual(c.slice(3, 6).map(key), ['32/96000', '24/96000', '16/96000']);
  assert.deepEqual(c.slice(6, 9).map(key), ['32/48000', '24/48000', '16/48000']);
  assert.equal(c.length, 9);
  assert.equal(c[0].format, 's32');
  assert.equal(c[1].format, 's24');
});

test('candidates: 44.1 family ends with 48k; never above request', () => {
  const c = N.candidateFormats({ rate: 88200, bits: 24, channels: 2 });
  const rates = [...new Set(c.map((x) => x.rate))];
  assert.deepEqual(rates, [88200, 44100, 48000]);
  assert.ok(c.every((x) => x.bits <= 24));
});

test('candidates filtered by probe (24-in-32 counts as 24-bit; float excluded)', () => {
  const supported = [
    { rate: 96000, bits: 32, validBits: 24, channels: 2, isFloat: false },
    { rate: 48000, bits: 32, validBits: 32, channels: 2, isFloat: true },
    { rate: 48000, bits: 16, validBits: 16, channels: 2, isFloat: false },
  ];
  const c = N.candidateFormats({ rate: 96000, bits: 32, channels: 2 }, supported);
  assert.deepEqual(c.map((x) => `${x.bits}/${x.rate}`), ['24/96000', '16/48000']);
});

test('candidates: probe rejects everything → still try the first (reason surfaces)', () => {
  const c = N.candidateFormats({ rate: 48000, bits: 24, channels: 2 }, [{ rate: 44100, bits: 16, validBits: 16, channels: 2, isFloat: false }]);
  assert.equal(c.length, 1);
  assert.equal(c[0].rate, 48000);
});

test('classifyOpenError: format problems retry, ownership/policy stop', () => {
  assert.deepEqual(N.classifyOpenError('unsupported_format'), { reason: 'unsupported_format', retryNextFormat: true });
  assert.deepEqual(N.classifyOpenError('exclusive_not_supported'), { reason: 'unsupported_format', retryNextFormat: true });
  assert.deepEqual(N.classifyOpenError('device_in_use'), { reason: 'device_in_use', retryNextFormat: false });
  assert.deepEqual(N.classifyOpenError('exclusive_not_allowed'), { reason: 'exclusive_not_allowed', retryNextFormat: false });
  assert.deepEqual(N.classifyOpenError('access_denied'), { reason: 'access_denied', retryNextFormat: false });
  assert.equal(N.classifyOpenError('hr_8889000f').retryNextFormat, true);
  assert.equal(N.classifyOpenError(undefined).reason, 'unknown');
});

test('pickBlockingApp prefers active non-system sessions, strips .exe', () => {
  assert.equal(N.pickBlockingApp([]), null);
  assert.equal(N.pickBlockingApp([{ pid: 0, process: 'System', state: 'inactive', systemSounds: true }]), null);
  assert.equal(N.pickBlockingApp([
    { pid: 10, process: 'Spotify.exe', state: 'inactive', systemSounds: false },
    { pid: 11, process: 'foobar2000.exe', state: 'active', systemSounds: false },
  ]), 'foobar2000');
  assert.equal(N.pickBlockingApp([{ pid: 10, process: 'Spotify.exe', state: 'inactive', systemSounds: false }]), 'Spotify');
});

test('describeFormat / wireBitrate', () => {
  assert.equal(N.describeFormat({ bits: 32, rate: 192000 }), 'PCM 32/192');
  assert.equal(N.describeFormat({ bits: 24, rate: 44100 }), 'PCM 24/44.1');
  // 192k·32-bit·2ch·10 ms: payload 15,360 + 24 헤더 → ×100 fps ×8 ×1.25(FEC)
  assert.equal(Math.round(N.wireBitrate(192000, 32, 2, 10, true)), Math.round((15360 + 24) * 100 * 8 * 1.25));
  assert.equal(Math.round(N.wireBitrate(48000, 24, 2, 10, false)), (2880 + 24) * 100 * 8);
});
