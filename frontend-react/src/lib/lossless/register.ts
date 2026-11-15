/**
 * 'lossless' 단계를 음성채널 전송 레지스트리에 붙인다. useVoice 가 `import '~/lib/lossless/register'` 로 한 번 불러들인다.
 * 등록되면 음질 패널에서 "무손실"이 선택 가능해진다(tierAvailable).
 */
import { registerVoiceTransport } from '~/lib/voice/transport'
import { createLosslessVoiceTransport } from './adapter'

registerVoiceTransport(['lossless'], createLosslessVoiceTransport)
