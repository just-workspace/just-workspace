/**
 * 네이티브 엔진 래퍼 — 애드온 로드, 장치 목록(+exclusive 포맷 매트릭스), 협상 열기(exclusive 후보 순회 → 실패 이유 → shared 폴백).
 * 네트워크는 여기 없다(session.ts). 애드온이 없으면(빌드 안 됨·다른 OS) available=false 로 조용히 비활성.
 */
import type { Backend, Device, DeviceKind, ExclusiveFormat, NativeAudioAddon, OpenError, OpenInfo, SampleFormat, TestSignal } from '../../../native';
import { candidateFormats, classifyOpenError, pickBlockingApp, type Candidate, type FailReason, type FormatRequest } from './negotiate';

export interface HiresDevice {
  id: string;
  name: string;
  isDefault: boolean;
  kind: DeviceKind;
  /** 장치 기본 형식(Windows 소리 설정) */
  defaultFormat: { rate: number; bits: number; validBits: number; channels: number; isFloat: boolean } | null;
  /** IsFormatSupported(EXCLUSIVE) 가 S_OK 인 조합 */
  exclusiveFormats: ExclusiveFormat[];
  /** 공유 모드 믹스 포맷(miniaudio 보고) */
  sharedFormat: { format: SampleFormat; channels: number; sampleRate: number } | null;
}

export interface OpenAttempt { candidate: Candidate; exclusive: boolean; ok: boolean; code?: string; hr?: string }

export interface OpenedDevice {
  dev: Device;
  info: OpenInfo;
  exclusive: boolean;
  attempts: OpenAttempt[];
  /** exclusive 가 안 됐을 때 이유 */
  failReason: FailReason | null;
  failCode: string | null;
  /** 장치를 쓰는 다른 앱(Windows 세션 열거로 보이면) */
  blockingApp: string | null;
}

export interface OpenRequest extends FormatRequest {
  frameMs: number;
  backend: Backend;
  testSignal?: TestSignal;
  seed?: number;
  /** exclusive 실패 시 shared 로라도 연다 */
  allowShared: boolean;
  /** 링버퍼 용량(ms) */
  ringMs?: number;
}

let addon: NativeAudioAddon | null | undefined;

export function nativeAudio(): NativeAudioAddon | null {
  if (addon !== undefined) return addon;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loader = require('../../../native') as typeof import('../../../native');
    addon = loader.available() ? loader.load() : null;
  } catch (e) {
    console.warn('[hires] native audio addon unavailable:', (e as Error)?.message ?? e);
    addon = null;
  }
  return addon;
}

export function listHiresDevices(backend: Backend = 'wasapi'): { capture: HiresDevice[]; playback: HiresDevice[] } {
  const n = nativeAudio();
  if (!n) return { capture: [], playback: [] };
  const raw = n.listDevices(backend);
  const build = (kind: DeviceKind) => raw[kind].map((d): HiresDevice => {
    let defaultFormat: HiresDevice['defaultFormat'] = null;
    let exclusiveFormats: ExclusiveFormat[] = [];
    if (backend === 'wasapi') {
      try {
        const f = n.deviceFormat(d.id, kind);
        if (f.ok) defaultFormat = { rate: f.rate, bits: f.bits, validBits: f.validBits, channels: f.channels, isFloat: f.isFloat };
        exclusiveFormats = n.probeExclusive(d.id, kind);
      } catch { /* 장치가 사라졌을 수 있다 */ }
    }
    const shared = d.nativeFormats.find((f) => !f.exclusive && f.format !== 'unknown');
    return {
      id: d.id, name: d.name, isDefault: d.isDefault, kind, defaultFormat, exclusiveFormats,
      sharedFormat: shared ? { format: shared.format as SampleFormat, channels: shared.channels, sampleRate: shared.sampleRate } : null,
    };
  });
  return { capture: build('capture'), playback: build('playback') };
}

function describeErr(e: unknown): { code: string; hr: string } {
  const err = e as Partial<OpenError>;
  return { code: err?.code ?? 'unknown', hr: typeof err?.hr === 'number' ? err.hr.toString(16) : '' };
}

/**
 * exclusive 후보를 순서대로 열어 본다. 포맷 문제면 다음 후보, 장치 점유·정책·권한이면 중단.
 * 전부 실패하고 allowShared 면 장치 믹스 포맷(f32)로 shared 열기. 그것도 실패면 throw(마지막 오류).
 */
export function openNegotiated(kind: DeviceKind, deviceId: string | null, req: OpenRequest, supported?: ExclusiveFormat[] | null): OpenedDevice {
  const n = nativeAudio();
  if (!n) throw Object.assign(new Error('native audio addon unavailable'), { code: 'addon_unavailable' });
  const attempts: OpenAttempt[] = [];
  const ringFrames = (rate: number) => Math.round((rate * (req.ringMs ?? 500)) / 1000);
  let failReason: FailReason | null = null;
  let failCode: string | null = null;
  let lastErr: unknown = null;

  const cands = req.backend === 'null' ? [{ format: (req.bits === 16 ? 's16' : req.bits === 24 ? 's24' : 's32') as SampleFormat, rate: req.rate, bits: req.bits, channels: req.channels }] : candidateFormats(req, supported);
  for (const c of cands) {
    const exclusive = req.backend !== 'null';
    try {
      const dev = new n.Device({
        kind, backend: req.backend, deviceId, format: c.format, channels: c.channels, sampleRate: c.rate,
        periodFrames: Math.round((c.rate * req.frameMs) / 1000), periods: 2, exclusive, ringFrames: ringFrames(c.rate),
        testSignal: req.testSignal ?? 'none', seed: req.seed ?? 1,
      });
      attempts.push({ candidate: c, exclusive, ok: true });
      return { dev, info: dev.info(), exclusive, attempts, failReason: null, failCode: null, blockingApp: null };
    } catch (e) {
      lastErr = e;
      const { code, hr } = describeErr(e);
      attempts.push({ candidate: c, exclusive, ok: false, code, hr });
      const cls = classifyOpenError(code);
      failReason = cls.reason;
      failCode = code;
      if (!cls.retryNextFormat) break;
    }
  }

  let blockingApp: string | null = null;
  if (req.backend === 'wasapi' && (failReason === 'device_in_use' || failReason === 'exclusive_not_allowed' || failReason === 'unsupported_format')) {
    try { blockingApp = pickBlockingApp(n.sessions(deviceId ?? '', kind)); } catch { /* noop */ }
  }

  if (!req.allowShared) {
    const err = Object.assign(new Error(`exclusive open failed: ${failCode ?? 'unknown'}`), { code: failCode ?? 'unknown', reason: failReason ?? 'unknown', attempts, blockingApp, cause: lastErr });
    throw err;
  }

  // shared 폴백 — 장치 믹스 레이트 그대로(리샘플 없이), f32
  let mixRate = req.rate;
  try {
    const list = n.listDevices(req.backend);
    const d = list[kind].find((x) => (deviceId ? x.id === deviceId : x.isDefault)) ?? list[kind][0];
    const f = d?.nativeFormats.find((x) => x.format !== 'unknown');
    if (f) mixRate = f.sampleRate;
  } catch { /* noop */ }
  const c: Candidate = { format: 'f32', rate: mixRate, bits: 32, channels: req.channels };
  try {
    const dev = new n.Device({
      kind, backend: req.backend, deviceId, format: 'f32', channels: req.channels, sampleRate: mixRate,
      periodFrames: Math.round((mixRate * req.frameMs) / 1000), periods: 2, exclusive: false, ringFrames: ringFrames(mixRate),
      testSignal: req.testSignal ?? 'none', seed: req.seed ?? 1,
    });
    attempts.push({ candidate: c, exclusive: false, ok: true });
    return { dev, info: dev.info(), exclusive: false, attempts, failReason, failCode, blockingApp };
  } catch (e) {
    const { code, hr } = describeErr(e);
    attempts.push({ candidate: c, exclusive: false, ok: false, code, hr });
    throw Object.assign(new Error(`shared open failed too: ${code}`), { code, reason: failReason ?? classifyOpenError(code).reason, attempts, blockingApp, cause: e });
  }
}
