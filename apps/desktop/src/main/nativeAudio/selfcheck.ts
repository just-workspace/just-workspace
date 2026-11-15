/**
 * 자가점검: 애드온 로드 → 버전 → 장치 목록(WASAPI) → null 백엔드로 192k/s32 캡처 1 회 열기·읽기. 패키징 검증·설치 스모크용.
 */
import { listHiresDevices, nativeAudio } from './engine';

export interface SelfCheckResult {
  ok: boolean;
  addonPath: string | null;
  version: unknown;
  electron: string | undefined;
  node: string;
  devices: { capture: Array<{ name: string; isDefault: boolean; exclusiveFormats: number }>; playback: Array<{ name: string; isDefault: boolean; exclusiveFormats: number }> } | null;
  nullRoundTrip: { bytes: number; callbacks: number } | null;
  webtransportModule: boolean;
  error?: string;
}

export function nativeAudioSelfCheck(): SelfCheckResult {
  const r: SelfCheckResult = { ok: false, addonPath: null, version: null, electron: process.versions.electron, node: process.versions.node, devices: null, nullRoundTrip: null, webtransportModule: false };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loader = require('../../../native') as typeof import('../../../native');
    r.addonPath = loader.candidates.find((p) => require('node:fs').existsSync(p)) ?? null;
    const n = nativeAudio();
    if (!n) throw new Error('addon not loadable');
    r.version = n.version();
    const d = listHiresDevices('wasapi');
    r.devices = {
      capture: d.capture.map((x) => ({ name: x.name, isDefault: x.isDefault, exclusiveFormats: x.exclusiveFormats.length })),
      playback: d.playback.map((x) => ({ name: x.name, isDefault: x.isDefault, exclusiveFormats: x.exclusiveFormats.length })),
    };
    const dev = new n.Device({ kind: 'capture', backend: 'null', format: 's32', channels: 2, sampleRate: 192000, periodFrames: 1920, exclusive: false, testSignal: 'sweep' });
    dev.start();
    const t0 = Date.now();
    while (Date.now() - t0 < 120) { /* 콜백 몇 번 돌 때까지 바쁘게 기다린다(동기 점검) */ }
    const buf = new Uint8Array(1920 * 2 * 4);
    let bytes = 0;
    for (;;) { const k = dev.read(buf); if (!k) break; bytes += k; }
    r.nullRoundTrip = { bytes, callbacks: dev.stats().callbacks };
    dev.stop();
    dev.close();
    // ESM 전용 패키지라 require.resolve 가 안 된다 — 프리빌드 바이너리 파일 존재로 본다(asar 안 경로도 fs 패치로 보인다)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    r.webtransportModule = fs.existsSync(path.join(__dirname, '..', '..', '..', 'node_modules', '@fails-components', 'webtransport-transport-http3-quiche', 'build', 'Release', 'webtransport.node'));
    r.ok = !!r.version && (r.nullRoundTrip.bytes > 0 || r.nullRoundTrip.callbacks > 0);
  } catch (e) {
    r.error = (e as Error)?.message ?? String(e);
  }
  return r;
}
