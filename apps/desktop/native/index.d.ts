// jw_native_audio 애드온 타입(src/addon.cpp 정본). 메인 프로세스(src/main/nativeAudio)와 테스트 하네스가 사용한다.

export type SampleFormat = 'u8' | 's16' | 's24' | 's32' | 'f32';
export type DeviceKind = 'capture' | 'playback';
export type Backend = 'wasapi' | 'null';
export type TestSignal = 'none' | 'sweep' | 'noise' | 'ramp';

export interface NativeFormat {
  /** null 백엔드는 'unknown' 을 반환한다 */
  format: SampleFormat | 'unknown';
  channels: number;
  sampleRate: number;
  /** WASAPI exclusive 로 보고된 포맷(miniaudio 가 장치 기본 형식으로 시험) */
  exclusive: boolean;
}

export interface DeviceInfo {
  id: string;
  name: string;
  isDefault: boolean;
  kind: DeviceKind;
  nativeFormats: NativeFormat[];
}

export interface DeviceList {
  backend: string;
  playback: DeviceInfo[];
  capture: DeviceInfo[];
}

export interface ExclusiveFormat {
  rate: number;
  bits: 16 | 24 | 32;
  /** 24-in-32 컨테이너면 24 */
  validBits: number;
  channels: number;
  isFloat: boolean;
}

export interface SessionInfo {
  pid: number;
  process: string;
  state: 'active' | 'inactive' | 'expired';
  systemSounds: boolean;
}

export interface DeviceFormatInfo {
  ok: boolean;
  rate: number;
  bits: number;
  validBits: number;
  channels: number;
  isFloat: boolean;
  defaultPeriodUs: number;
  minimumPeriodUs: number;
}

export interface DeviceOptions {
  kind: DeviceKind;
  backend?: Backend;
  /** 비우면 기본 장치 */
  deviceId?: string | null;
  format: SampleFormat;
  channels: number;
  sampleRate: number;
  /** 콜백 한 번의 프레임 수(기본 10 ms) */
  periodFrames?: number;
  periods?: number;
  exclusive?: boolean;
  /** 링버퍼 용량(프레임, 기본 500 ms) */
  ringFrames?: number;
  /** 테스트: 캡처 데이터를 결정적 신호로 대체한다 */
  testSignal?: TestSignal;
  seed?: number;
  wasapiUsage?: 'pro_audio' | 'games';
}

export interface OpenInfo {
  kind: DeviceKind;
  backend: string;
  open: boolean;
  started: boolean;
  format: SampleFormat;
  bits: number;
  channels: number;
  sampleRate: number;
  periodFrames: number;
  exclusive: boolean;
  frameBytes: number;
  name?: string;
  deviceId?: string;
  shareMode?: 'exclusive' | 'shared';
  internalFormat?: SampleFormat;
  internalBits?: number;
  internalChannels?: number;
  internalSampleRate?: number;
  internalPeriodFrames?: number;
  internalPeriods?: number;
  /** miniaudio 변환기 개입 상태(포맷·채널·레이트 중 하나가 내부와 상이) */
  converterActive?: boolean;
  /** exclusive + 레이트·채널 동일 + 포맷 동일(또는 24-in-32 → s24 무손실) */
  bitPerfect?: boolean;
  testSignal?: TestSignal;
}

export interface DeviceStats {
  callbacks: number;
  framesProcessed: number;
  /** 캡처: 링이 가득 차 폐기된 콜백 수 */
  overruns: number;
  /** 재생: 링이 비어 0 으로 채운 콜백 수 */
  underruns: number;
  underrunFrames: number;
  ringBytes: number;
  ringCapacityBytes: number;
  stoppedByBackend: boolean;
  interrupted: boolean;
  rerouted: number;
  peak: number[];
  rms: number[];
}

export interface OpenError extends Error {
  /** 'device_in_use' | 'exclusive_not_allowed' | 'unsupported_format' | 'access_denied' | 'no_device' | 'exclusive_not_supported' | 'hr_xxxxxxxx' | 'ma_N' */
  code: string;
  maResult: number;
  hr: number;
  exclusive: boolean;
}

export declare class Device {
  constructor(options: DeviceOptions);
  start(): void;
  stop(): void;
  close(): void;
  info(): OpenInfo;
  stats(): DeviceStats;
  /** 캡처: 링에서 최대 buf.byteLength 바이트를 복사. 반환값 = 복사한 바이트 수 */
  read(buf: Uint8Array): number;
  available(): number;
  /** 재생: 링에 전부 기록되면 byteLength, 공간이 없으면 0 */
  write(buf: Uint8Array): number;
  queued(): number;
  clear(): void;
  /** 캡처 데이터 수신 시(콜백 단위로 병합하여) 호출한다 */
  setDataCallback(fn: (() => void) | null): void;
  ringCapacity(): number;
}

export declare class Resampler {
  constructor(channels: number, inRate: number, outRate: number, quality?: number);
  /** interleaved float32 → interleaved float32(새 배열) */
  process(input: Float32Array): Float32Array;
  latency(): { inputFrames: number; outputFrames: number };
  reset(): void;
  destroy(): void;
}

/** 단위 테스트용 — ring_buffer.h 와 동일 */
export declare class RingTest {
  constructor(capacity: number);
  write(buf: Uint8Array): number;
  read(buf: Uint8Array): number;
  discard(n: number): number;
  available(): number;
  capacity(): number;
  reset(): void;
}

export interface NativeAudioAddon {
  Device: typeof Device;
  Resampler: typeof Resampler;
  RingTest: typeof RingTest;
  listDevices(backend?: Backend): DeviceList;
  probeExclusive(deviceId: string, kind: DeviceKind, opts?: { rates?: number[]; channels?: number[] }): ExclusiveFormat[];
  sessions(deviceId: string, kind: DeviceKind): SessionInfo[];
  deviceFormat(deviceId: string, kind: DeviceKind): DeviceFormatInfo;
  lastWasapiHr(): { hr: number; code: string };
  version(): { miniaudio: string; napi: number; addon: string };
}

export function load(): NativeAudioAddon;
export function available(): boolean;
export const candidates: string[];
