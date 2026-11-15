/**
 * 포맷 협상 로직(순수 함수 — tests/negotiate.test.mjs).
 *
 *  · 요청(레이트·비트·채널) → exclusive 로 시도할 후보 순서. 같은 레이트에서 비트를 내리고(32→24→16), 그다음 같은 계열의 낮은 레이트
 *    (192→96→48 · 176.4→88.2→44.1), 마지막에 48k 계열로 건너간다. probe 결과가 있으면 지원 포맷만 남긴다(없으면 전부 시도).
 *  · 열기 실패 코드 → 이유 분류 + "다음 후보를 시도할지"(포맷 문제면 계속, 장치 점유·정책·권한이면 중단).
 *  · 장치를 쓰는 세션 목록 → 가로막은 앱 이름 고르기.
 */
import type { ExclusiveFormat, SampleFormat, SessionInfo } from '../../../native';

export interface FormatRequest { rate: number; bits: 16 | 24 | 32; channels: number }
export interface Candidate { format: SampleFormat; rate: number; bits: 16 | 24 | 32; channels: number }

export const HIRES_RATES = [44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000] as const;

export function formatForBits(bits: 16 | 24 | 32): SampleFormat {
  return bits === 16 ? 's16' : bits === 24 ? 's24' : 's32';
}

function rateFamily(rate: number): number[] {
  const f48 = [384000, 192000, 96000, 48000];
  const f44 = [352800, 176400, 88200, 44100];
  return f44.includes(rate) ? f44 : f48;
}

/** 요청 이하(같거나 낮은)의 후보를 선호 순서대로 */
export function candidateFormats(req: FormatRequest, supported?: ExclusiveFormat[] | null): Candidate[] {
  const bitsOrder = ([32, 24, 16] as const).filter((b) => b <= req.bits);
  const fam = rateFamily(req.rate).filter((r) => r <= req.rate);
  // 44.1 계열이면 마지막에 48k 로 건너간다(48k 계열은 그대로)
  const other = rateFamily(req.rate)[0] === 352800 ? [48000] : [];
  const rates = [...fam, ...other];
  const out: Candidate[] = [];
  for (const rate of rates) for (const bits of bitsOrder) out.push({ format: formatForBits(bits), rate, bits, channels: req.channels });
  if (!supported || supported.length === 0) return out;
  const ok = out.filter((c) => supported.some((s) => s.rate === c.rate && s.channels === c.channels && !s.isFloat && (
    (c.bits === 16 && s.bits === 16) ||
    (c.bits === 24 && (s.bits === 24 || (s.bits === 32 && s.validBits === 24))) ||
    (c.bits === 32 && s.bits === 32 && s.validBits === 32)
  )));
  // probe 가 전부 거부해도 첫 후보는 한 번 시도한다(probe 와 실제 Initialize 가 다를 수 있다 — 이유를 사용자에게 보여 주기 위해)
  return ok.length ? ok : [out[0]];
}

export type FailReason = 'device_in_use' | 'exclusive_not_allowed' | 'unsupported_format' | 'no_device' | 'access_denied' | 'unknown';

/** 애드온 OpenError.code → 이유 + 다음 포맷 후보를 계속 시도할지 */
export function classifyOpenError(code: string | undefined): { reason: FailReason; retryNextFormat: boolean } {
  switch (code) {
    case 'device_in_use': return { reason: 'device_in_use', retryNextFormat: false };
    case 'exclusive_not_allowed': return { reason: 'exclusive_not_allowed', retryNextFormat: false };
    case 'access_denied': return { reason: 'access_denied', retryNextFormat: false };
    case 'no_device': return { reason: 'no_device', retryNextFormat: false };
    case 'unsupported_format':
    case 'exclusive_not_supported':
    case 'invalid_device_period':
    case 'buffer_not_aligned':
      return { reason: 'unsupported_format', retryNextFormat: true };
    default:
      return { reason: 'unknown', retryNextFormat: !!code && code.startsWith('hr_') };
  }
}

/** 장치를 쓰는 다른 프로세스 — 활성 세션 우선, 시스템 소리 세션은 뺀다 */
export function pickBlockingApp(sessions: SessionInfo[]): string | null {
  const cands = sessions.filter((s) => !s.systemSounds && s.process && s.process !== 'System');
  const active = cands.find((s) => s.state === 'active');
  const any = cands[0];
  const pick = active ?? any;
  return pick ? pick.process.replace(/\.exe$/i, '') : null;
}

/** 'PCM 32/192' — UI 와 같은 표기(레이트는 kHz 반올림, 44.1 은 44.1) */
export function describeFormat(f: { bits: number; rate: number }): string {
  const k = f.rate / 1000;
  const khz = Number.isInteger(k) ? String(k) : k.toFixed(1);
  return `PCM ${f.bits}/${khz}`;
}

/** 와이어 비트레이트(bps) — 헤더 24 B + XOR 패리티 25% 포함 */
export function wireBitrate(rate: number, bits: number, channels: number, frameMs: number, fec: boolean): number {
  const frameSamples = Math.round((rate * frameMs) / 1000);
  const payload = frameSamples * channels * (bits / 8);
  const perFrame = payload + 24;
  const fps = 1000 / frameMs;
  return perFrame * fps * 8 * (fec ? 1.25 : 1);
}
