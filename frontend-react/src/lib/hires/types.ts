/**
 * 하이레조(Tier 4) — 데스크톱 앱 프리로드가 내보내는 `window.jwNativeAudio` 의 모양.
 * 정본은 apps/desktop/src/preload/webview.ts(JwNativeAudio) 와 apps/desktop/src/main/nativeAudio/session.ts(결과·통계 타입). 여기는 복제.
 * 브라우저(일반 탭)에는 이 전역이 없다 → lib/hires/register 는 아무것도 등록하지 않는다.
 */
import type { RelayGrant } from '~/lib/lossless/types'

export type HiresFailReason = 'device_in_use' | 'exclusive_not_allowed' | 'unsupported_format' | 'no_device' | 'access_denied' | 'addon_unavailable' | 'no_capture_device' | 'unknown' | string

export interface HiresDevice {
  id: string
  name: string
  isDefault: boolean
  kind: 'capture' | 'playback'
  defaultFormat: { rate: number; bits: number; validBits: number; channels: number; isFloat: boolean } | null
  exclusiveFormats: Array<{ rate: number; bits: 16 | 24 | 32; validBits: number; channels: number; isFloat: boolean }>
  sharedFormat: { format: string; channels: number; sampleRate: number } | null
}

export interface HiresSideInfo {
  name: string
  deviceId: string
  exclusive: boolean
  format: string
  bits: number
  rate: number
  channels: number
  internalFormat: string
  internalRate: number
  bitPerfect: boolean
  periodFrames: number
}

export interface HiresWireFormat { codec: string; rate: number; bits: 16 | 24 | 32; channels: number; frameMs: number; frameSamples: number; fec: boolean }

export interface HiresOpenResult {
  ok: boolean
  exclusive: boolean
  bitPerfect: boolean
  capture: HiresSideInfo | null
  playback: HiresSideInfo | null
  wire: HiresWireFormat | null
  /** 'PCM 32/192' */
  formatLabel: string | null
  nominalBps: number
  reason?: HiresFailReason
  code?: string
  app?: string | null
  device: string
  attempts: unknown[]
}

export interface HiresPeerStats {
  peer: number
  format: { codec: string; rate: number; bits: number; channels: number; frameMs: number; fec: boolean } | null
  bitrateBps: number
  received: number
  lost: number
  recoveredFec: number
  recoveredNack: number
  nackSent: number
  plc: number
  targetMs: number
  depthMs: number
  jitterP95Ms: number
  bitExactPlayback: boolean
  resampled: boolean
}

export interface HiresStats {
  state: 'idle' | 'opening' | 'open' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'failed'
  transport: 'webtransport' | 'websocket' | null
  fallbackReason: string | null
  room: string | null
  peerId: number | null
  capture: (HiresSideInfo & { level: { peak: number[]; rms: number[] }; overruns: number }) | null
  playback: (HiresSideInfo & { underruns: number; queuedMs: number }) | null
  wire: HiresWireFormat | null
  formatLabel: string | null
  exclusive: boolean
  bitPerfect: boolean
  playbackBitExact: boolean
  resampling: boolean
  bitrateOutBps: number
  framesSent: number
  rttMs: number
  estimatedLatencyMs: number
  bufferPreset: 'auto' | 60 | 120 | 250
  peers: Record<number, HiresPeerStats>
  muted: boolean
  deafened: boolean
}

export interface HiresPeer { peer: number; uid: string; name?: string; identity?: string; transport: string }

export type HiresEventType =
  | 'state' | 'started' | 'failed' | 'downgraded' | 'connected' | 'transport_fallback' | 'peer_joined' | 'peer_left' | 'peer_format'
  | 'needGrant' | 'warning' | 'stats' | 'error'

export interface HiresEvent { type: HiresEventType; [k: string]: unknown }

export interface HiresOpenOptions {
  captureDevice?: string | null
  playbackDevice?: string | null
  rate: number
  bits: 16 | 24 | 32
  channels: 1 | 2
  frameMs?: number
  allowShared?: boolean
  fec?: boolean
  bufferPreset?: 'auto' | 60 | 120 | 250
}

/** `window.jwNativeAudio` */
export interface JwNativeAudio {
  apiVersion: number
  available(): Promise<{ available: boolean; version: unknown; platform: string }>
  listDevices(): Promise<{ capture: HiresDevice[]; playback: HiresDevice[] }>
  openHires(opts: HiresOpenOptions): Promise<HiresOpenResult>
  connect(grant: RelayGrant): Promise<{ state: string; peers: HiresPeer[] }>
  setGrant(grant: RelayGrant): Promise<void>
  close(): Promise<void>
  stats(): Promise<HiresStats | null>
  levels(): Promise<{ left: number; right: number }>
  peers(): Promise<HiresPeer[]>
  setMuted(m: boolean): Promise<void>
  setDeafened(d: boolean): Promise<void>
  setBufferPreset(p: 'auto' | 60 | 120 | 250): Promise<void>
  on(type: HiresEventType | '*', fn: (ev: HiresEvent) => void): () => void
}

declare global {
  interface Window { jwNativeAudio?: JwNativeAudio }
}

/** 데스크톱 앱 안(프리로드가 전역을 심었다)인가 */
export function nativeAudioBridge(): JwNativeAudio | null {
  if (typeof window === 'undefined') return null
  const b = window.jwNativeAudio
  return b && typeof b.openHires === 'function' ? b : null
}
