// 애드온 스모크 — 장치 목록·exclusive 포맷 매트릭스·세션·null 백엔드 캡처/재생·리샘플러. 결과는 JSON 으로 stdout.
// 실행: node scripts/native-smoke.mjs [--exclusive-try]  (실제 장치에 exclusive 열기를 시도한다)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const native = require('../native/index.js').load();
const tryExclusive = process.argv.includes('--exclusive-try');
const out = { version: native.version() };

out.devices = native.listDevices('wasapi');
out.nullDevices = native.listDevices('null');
out.probe = {};
for (const kind of ['capture', 'playback']) {
  for (const d of out.devices[kind]) {
    out.probe[`${kind}:${d.name}`] = {
      deviceFormat: native.deviceFormat(d.id, kind),
      exclusiveFormats: native.probeExclusive(d.id, kind),
      sessions: native.sessions(d.id, kind),
    };
  }
}

// exclusive 열기 시도(실제 장치) — 이유 코드 수집
if (tryExclusive) {
  out.exclusiveTry = {};
  for (const kind of ['capture', 'playback']) {
    for (const d of out.devices[kind]) {
      for (const [format, rate] of [['s24', 48000], ['s24', 96000], ['s32', 192000], ['s16', 48000]]) {
        const key = `${kind}:${d.name}:${format}/${rate}`;
        try {
          const dev = new native.Device({ kind, deviceId: d.id, format, channels: 2, sampleRate: rate, periodFrames: rate / 100, exclusive: true });
          out.exclusiveTry[key] = { ok: true, info: dev.info() };
          dev.close();
        } catch (e) {
          out.exclusiveTry[key] = { ok: false, code: e.code, hr: e.hr?.toString(16), maResult: e.maResult, message: e.message };
        }
      }
      // shared 폴백
      try {
        const dev = new native.Device({ kind, deviceId: d.id, format: 'f32', channels: 2, sampleRate: 48000, exclusive: false });
        out.exclusiveTry[`${kind}:${d.name}:shared`] = { ok: true, info: dev.info() };
        dev.close();
      } catch (e) {
        out.exclusiveTry[`${kind}:${d.name}:shared`] = { ok: false, code: e.code, message: e.message };
      }
    }
  }
}

// null 백엔드 — 결정적 신호 캡처 → 링 → read, 재생 write → 콜백 소비
async function nullRoundTrip() {
  const rate = 192000, ch = 2, format = 's32', periodFrames = 1920; // 10 ms @192k
  const cap = new native.Device({ kind: 'capture', backend: 'null', format, channels: ch, sampleRate: rate, periodFrames, exclusive: false, testSignal: 'sweep', seed: 7 });
  const pb = new native.Device({ kind: 'playback', backend: 'null', format, channels: ch, sampleRate: rate, periodFrames, exclusive: false });
  const frameBytes = periodFrames * ch * 4;
  let wakeups = 0;
  let bytes = 0;
  const buf = new Uint8Array(frameBytes);
  let nonzero = 0;
  cap.setDataCallback(() => {
    wakeups++;
    for (;;) {
      const n = cap.read(buf);
      if (n === 0) break;
      bytes += n;
      for (let i = 0; i < 64; i++) if (buf[i] !== 0) { nonzero++; break; }
      pb.write(buf.subarray(0, n));
    }
  });
  cap.start();
  pb.start();
  await new Promise((r) => setTimeout(r, 1000));
  const res = { capInfo: cap.info(), pbInfo: pb.info(), capStats: cap.stats(), pbStats: pb.stats(), wakeups, bytesRead: bytes, nonzeroReads: nonzero, expectedBytesPerSec: rate * ch * 4 };
  cap.stop(); pb.stop(); cap.close(); pb.close();
  return res;
}
out.nullRoundTrip = await nullRoundTrip();

// 리샘플러 48k→96k 사인파: 출력 길이·주파수 보존(간단 확인)
{
  const rs = new native.Resampler(2, 48000, 96000, 8);
  const inFrames = 4800;
  const inp = new Float32Array(inFrames * 2);
  for (let i = 0; i < inFrames; i++) { const v = Math.sin(2 * Math.PI * 1000 * i / 48000); inp[i * 2] = v; inp[i * 2 + 1] = v * 0.5; }
  const o = rs.process(inp);
  let zc = 0;
  for (let i = 2; i < o.length; i += 2) if ((o[i] >= 0) !== (o[i - 2] >= 0)) zc++;
  out.resampler = { inFrames, outFrames: o.length / 2, latency: rs.latency(), zeroCrossings: zc, expectedZeroCrossingsApprox: 2 * 1000 * (inFrames / 48000) };
  rs.destroy();
}

console.log(JSON.stringify(out, null, 2));
