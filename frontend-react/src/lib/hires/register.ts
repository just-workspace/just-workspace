/**
 * 'hires' 단계를 음성채널 전송 레지스트리에 등록한다 — **데스크톱 앱(window.jwNativeAudio)에서만**. 브라우저에서는 no-op 이므로
 * 음질 패널의 하이레조가 "데스크톱 앱에서만"(disabled)으로 유지된다. useVoice 가 `import '~/lib/hires/register'` 로 1회 로드한다.
 */
import { registerVoiceTransport } from '~/lib/voice/transport'
import { createHiresVoiceTransport } from './adapter'
import { nativeAudioBridge } from './types'

if (nativeAudioBridge()) registerVoiceTransport(['hires'], createHiresVoiceTransport)
