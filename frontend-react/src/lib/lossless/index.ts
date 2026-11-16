/**
 * 무손실 티어(Tier 3) 브라우저 클라이언트 — 공개 진입점.
 *
 *   useVoice 가 `import '~/lib/lossless/register'` 로 'lossless' 단계에 등록한다(lib/voice/transport.ts 의 VoiceTransport).
 *   직접 사용 시 `new LosslessVoiceTransport()` 또는 저수준 `LosslessSession` + `requestRelayGrant`.
 * 프로토콜은 audiorelay/PROTOCOL.md, 전송 정책은 transportSelector.ts(WebTransport 기본, WebSocket 폴백).
 */
export { LosslessSession, type LosslessSessionOptions } from './session'
export { LosslessVoiceTransport, channelIdFromLiveKitToken } from './adapter'
export { requestRelayGrant, RelayUnavailable } from './relayToken'
export { TransportSelector, type FallbackReason } from './transportSelector'
export { JitterBuffer, type JitterStats } from './jitter'
export * from './types'
