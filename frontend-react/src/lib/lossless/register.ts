/**
 * 'lossless' 단계를 음성채널 전송 레지스트리에 등록한다. useVoice 가 `import '~/lib/lossless/register'` 로 1회 로드한다.
 * 등록되면 음질 패널에서 "무손실"이 선택 가능해진다(tierAvailable).
 */
import { registerVoiceTransport } from '~/lib/voice/transport'
import { createLosslessVoiceTransport } from './adapter'

registerVoiceTransport(['lossless'], createLosslessVoiceTransport)
