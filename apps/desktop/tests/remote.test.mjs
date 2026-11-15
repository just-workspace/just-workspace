// 원격 데스크톱 호스트 — 데이터 채널 입력 검증·속도 제한·좌표 매핑·주입기(가짜 애드온)·네이티브 애드온 거절 경로
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const P = require('../dist/main/remote/protocol.js');
const { Injector } = require('../dist/main/remote/inject.js');

const enc = (o) => new TextEncoder().encode(typeof o === 'string' ? o : JSON.stringify(o));

test('parseInput accepts well-formed messages', () => {
  assert.deepEqual(P.parseInput(enc({ t: 'mm', x: 0.5, y: 1 })), { t: 'mm', x: 0.5, y: 1 });
  assert.deepEqual(P.parseInput(enc({ t: 'md', b: 2, x: 0, y: 0 })), { t: 'md', b: 2, x: 0, y: 0 });
  assert.deepEqual(P.parseInput(enc({ t: 'wh', dx: 0, dy: 119.6 })), { t: 'wh', dx: 0, dy: 120 });
  assert.deepEqual(P.parseInput(enc({ t: 'kd', c: 'KeyA' })), { t: 'kd', c: 'KeyA' });
  assert.deepEqual(P.parseInput(enc({ t: 'sk', k: 'cad' })), { t: 'sk', k: 'cad' });
  assert.deepEqual(P.parseInput(enc({ t: 'mon', i: 1 })), { t: 'mon', i: 1 });
});

test('parseInput rejects malformed, out-of-range and unknown input', () => {
  for (const bad of [
    'not json', '[]', 'null', '{}', { t: 'mm', x: 1.01, y: 0 }, { t: 'mm', x: -0.1, y: 0 }, { t: 'mm', x: 'a', y: 0 },
    { t: 'mm', x: Infinity, y: 0 }, { t: 'md', b: 3, x: 0, y: 0 }, { t: 'wh', dx: 0, dy: 5000 },
    { t: 'kd', c: 'Unidentified' }, { t: 'kd', c: 'toString' }, { t: 'kd', c: '__proto__' }, { t: 'kd', c: 'Pause' },
    { t: 'sk', k: 'reboot' }, { t: 'mon', i: -1 }, { t: 'mon', i: 1.5 }, { t: 'exec', cmd: 'calc' },
    { t: 'clip', text: 'x'.repeat(P.MAX_CLIP + 1) },
  ]) assert.equal(P.parseInput(enc(bad)), null, JSON.stringify(bad).slice(0, 60));
  assert.equal(P.parseInput(new Uint8Array(P.MAX_PAYLOAD + 1)), null);
  assert.equal(P.parseInput(new Uint8Array(0)), null);
});

test('scancode table: Set 1 codes in range, extended keys flagged', () => {
  for (const [c, [sc, ext]] of Object.entries(P.SCANCODES)) {
    assert.ok(sc > 0 && sc <= 0xff, c);
    assert.equal(typeof ext, 'boolean', c);
  }
  assert.deepEqual(P.SCANCODES.KeyA, [0x1e, false]);
  assert.deepEqual(P.SCANCODES.Enter, [0x1c, false]);
  assert.deepEqual(P.SCANCODES.NumpadEnter, [0x1c, true]);
  assert.deepEqual(P.SCANCODES.ArrowLeft, [0x4b, true]);
  assert.deepEqual(P.SCANCODES.Numpad4, [0x4b, false]);
  assert.deepEqual(P.SCANCODES.F12, [0x58, false]);
  assert.deepEqual(P.SCANCODES.MetaLeft, [0x5b, true]);
  // 확장 여부까지 같은 (스캔코드, ext) 쌍은 한/영(=AltRight)·한자(=ControlRight) 말고는 없어야 한다
  const seen = new Map();
  for (const [c, v] of Object.entries(P.SCANCODES)) {
    const k = v.join(':');
    if (seen.has(k)) assert.ok(['Lang1', 'Lang2'].includes(c) || ['Lang1', 'Lang2'].includes(seen.get(k)), `${c} vs ${seen.get(k)}`);
    else seen.set(k, c);
  }
});

test('rate limiter: bucket drains and refills', () => {
  let t = 0;
  const rl = new P.RateLimiter({ default: { rate: 10, burst: 3 } }, () => t);
  assert.ok(rl.allow('x') && rl.allow('x') && rl.allow('x'));
  assert.equal(rl.allow('x'), false);
  t += 100; // 0.1초 → 1개
  assert.ok(rl.allow('x'));
  assert.equal(rl.allow('x'), false);
});

test('ratioToPoint stays inside the monitor rect (multi-monitor offset)', () => {
  const r = { x: -1920, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(P.ratioToPoint(0, 0, r), { x: -1920, y: 0 });
  assert.deepEqual(P.ratioToPoint(1, 1, r), { x: -1, y: 1079 });
  assert.deepEqual(P.ratioToPoint(5, -5, r), { x: -1, y: 0 });
});

function fakeAddon() {
  const calls = [];
  return {
    calls,
    mouseMove: (x, y) => { calls.push(['move', x, y]); return true; },
    mouseButton: (b, d) => { calls.push(['btn', b, d]); return true; },
    wheel: (dx, dy) => { calls.push(['wheel', dx, dy]); return true; },
    key: (sc, ext, d) => { calls.push(['key', sc, ext, d]); return true; },
    secureDesktop: () => false,
  };
}

test('injector maps, tracks held keys, releases on end', () => {
  const a = fakeAddon();
  const inj = new Injector(a, () => ({ x: 100, y: 0, width: 1001, height: 501 }));
  assert.equal(inj.apply({ t: 'md', b: 0, x: 0.5, y: 0.5 }, false), 'ok');
  assert.deepEqual(a.calls.slice(0, 2), [['move', 600, 250], ['btn', 0, true]]);
  inj.apply({ t: 'kd', c: 'ShiftLeft' }, false);
  inj.apply({ t: 'kd', c: 'KeyA' }, false);
  inj.apply({ t: 'ku', c: 'KeyA' }, false);
  assert.deepEqual(inj.held(), { keys: ['ShiftLeft'], buttons: [0] });
  a.calls.length = 0;
  inj.releaseAll();
  assert.deepEqual(a.calls, [['key', 0x2a, false, false], ['btn', 0, false]]);
  assert.deepEqual(inj.held(), { keys: [], buttons: [] });
});

test('injector: Ctrl+Alt+Del refused, combos sent press→release, secure desktop blocks', () => {
  const a = fakeAddon();
  const inj = new Injector(a, () => ({ x: 0, y: 0, width: 100, height: 100 }));
  assert.equal(inj.apply({ t: 'sk', k: 'cad' }, false), 'cad_unsupported');
  assert.equal(a.calls.length, 0);
  assert.equal(inj.apply({ t: 'sk', k: 'alt-tab' }, false), 'ok');
  assert.deepEqual(a.calls, [['key', 0x38, false, true], ['key', 0x0f, false, true], ['key', 0x0f, false, false], ['key', 0x38, false, false]]);
  a.calls.length = 0;
  assert.equal(inj.apply({ t: 'kd', c: 'KeyA' }, true), 'secure');
  assert.equal(a.calls.length, 0);
});

test('injector: rate limit and no addon', () => {
  let t = 0;
  const rl = new P.RateLimiter({ mm: { rate: 1, burst: 1 }, default: { rate: 1, burst: 1 } }, () => t);
  const inj = new Injector(fakeAddon(), () => ({ x: 0, y: 0, width: 10, height: 10 }), rl);
  assert.equal(inj.apply({ t: 'mm', x: 0, y: 0 }, false), 'ok');
  assert.equal(inj.apply({ t: 'mm', x: 0, y: 0 }, false), 'rate');
  assert.equal(new Injector(null, () => ({ x: 0, y: 0, width: 1, height: 1 })).apply({ t: 'kd', c: 'KeyA' }, false), 'noaddon');
});

test('native addon (if built): rejects bad args without injecting', { skip: process.platform !== 'win32' }, () => {
  const a = require('../native/remote-input.js').load();
  if (!a) return;
  assert.equal(a.supported(), true);
  const vs = a.virtualScreen();
  assert.ok(vs.w > 0 && vs.h > 0);
  assert.equal(typeof a.secureDesktop(), 'boolean');
  assert.equal(a.key(0, false, true), false);
  assert.equal(a.key(0x1ff, false, true), false);
  assert.equal(a.mouseButton(9, true), false);
  assert.equal(a.mouseMove('x', 1), false);
});

test('special keys: new combos parsed and pressed in order, clipreq accepted', () => {
  for (const k of ['ctrl-shift-esc', 'win-d', 'win-r', 'printscreen']) assert.deepEqual(P.parseInput(enc({ t: 'sk', k })), { t: 'sk', k });
  assert.equal(P.parseInput(enc({ t: 'sk', k: 'shutdown' })), null);
  assert.deepEqual(P.parseInput(enc({ t: 'clipreq' })), { t: 'clipreq' });
  assert.deepEqual(P.comboKeys('ctrl-shift-esc'), ['ControlLeft', 'ShiftLeft', 'Escape']);
  assert.deepEqual(P.comboKeys('win-d'), ['MetaLeft', 'KeyD']);
  assert.deepEqual(P.comboKeys('win-r'), ['MetaLeft', 'KeyR']);
  assert.deepEqual(P.comboKeys('printscreen'), ['PrintScreen']);
  assert.equal(P.comboKeys('cad'), null);
  const log = [];
  const addon = { mouseMove() {}, mouseButton() {}, wheel() {}, key: (sc, ext, down) => log.push([sc, ext, down]), secureDesktop: () => false };
  const inj = new Injector(addon, () => ({ x: 0, y: 0, width: 100, height: 100 }));
  assert.equal(inj.apply({ t: 'sk', k: 'ctrl-shift-esc' }, false), 'ok');
  assert.deepEqual(log, [[0x1d, false, true], [0x2a, false, true], [0x01, false, true], [0x01, false, false], [0x2a, false, false], [0x1d, false, false]]);
  assert.equal(inj.apply({ t: 'clipreq' }, false), 'ignored');
});

test('osName: Windows 10/11/Server, other platforms', () => {
  const { osName } = require('../dist/main/remote/os-name.js');
  assert.equal(osName('win32', '10.0.22631', 'Windows 11 Pro'), 'Windows 11');
  assert.equal(osName('win32', '10.0.19045', 'Windows 10 Pro'), 'Windows 10');
  assert.equal(osName('win32', '10.0.26100', 'Windows Server 2025 Datacenter'), 'Windows Server 2025');
  assert.equal(osName('darwin', '24.0.0', ''), 'macOS');
  assert.equal(osName('linux', '6.8.0', ''), 'Linux');
});

// ── 화질 모드(quality.ts) ──
const Q = require('../dist/main/remote/quality.js');

test('parseInput: 화질 요청 {t:q}', () => {
  assert.deepEqual(P.parseInput(enc({ t: 'q', m: 'sharp', vw: 1920.4, vh: 1080 })), { t: 'q', m: 'sharp', vw: 1920, vh: 1080 });
  assert.deepEqual(P.parseInput(enc({ t: 'q', m: 'auto' })), { t: 'q', m: 'auto', vw: 0, vh: 0 });
  assert.equal(P.parseInput(enc({ t: 'q', m: 'ultra', vw: 0, vh: 0 })), null);
  assert.equal(P.parseInput(enc({ t: 'q', m: 'auto', vw: -1, vh: 0 })), null);
  assert.equal(P.parseInput(enc({ t: 'q', m: 'auto', vw: 99999, vh: 0 })), null);
});

test('quality: 보는 창이 작을 때만 줄이고, 선명 모드는 줄이지 않는다', () => {
  const cap = { w: 2560, h: 1440 };
  assert.equal(Q.downscale(cap, null), 1);
  assert.equal(Q.downscale(cap, { w: 2560, h: 1440 }), 1);
  assert.equal(Q.downscale(cap, { w: 1280, h: 720 }), 2);
  assert.equal(Q.downscale(cap, { w: 100, h: 100 }), 4); // 4배 넘게는 안 줄인다
  assert.equal(Q.qualityParams('sharp', cap, { w: 1280, h: 720 }).scale, 1);
  const s = Q.qualityParams('smooth', cap, { w: 1280, h: 720 });
  assert.equal(s.fps, 60);
  assert.equal(s.degradation, 'maintain-framerate');
  assert.equal(s.scale, 2);
  assert.equal(Q.qualityParams('auto', cap, null).maxBitrate, 12_000_000);
});
