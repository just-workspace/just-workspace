/**
 * 음질 단계 배지 — 단계 이름을 tint 배지로: 음성 neutral · 음악 primary · 무손실/하이레조 success.
 * 실제 형식(Opus 스테레오 509 kbps …)은 배지가 아니라 옆 mono 한 줄(lib/voice/ui.actualFormat)로 보인다.
 * 목표 대비 실측 비트레이트가 70% 아래면(음악) warning 색 — 자동 하향 고지.
 */
import { useI18n } from '~/i18n'
import { UiBadge } from '~/components/ui/Badge'
import { clampMusicBitrate, isDegraded } from '~/lib/voice/opus'
import { TIER_TONE } from '~/lib/voice/ui'
import type { VoiceStats, VoiceTier } from '~/lib/voice/transport'

export interface VoiceTierBadgeProps {
  tier: VoiceTier
  /** 음악 단계 목표 비트레이트(하향 판정용) */
  musicBitrate?: number
  stats?: VoiceStats | null
  size?: 22 | 18
  className?: string
}

export function VoiceTierBadge({ tier, musicBitrate, stats, size = 22, className }: VoiceTierBadgeProps) {
  const { t } = useI18n()
  const degraded = musicBitrate != null && isDegraded(tier, clampMusicBitrate(musicBitrate), stats?.sendBitrate ?? null)
  return (
    <UiBadge tint tone={degraded ? 'warning' : TIER_TONE[tier]} size={size} className={className} title={degraded ? t('chat.voice.degraded') : t(`chat.voice.tier.${tier}.name`)}>
      {t(`chat.voice.tier.${tier}.short`)}
    </UiBadge>
  )
}

export default VoiceTierBadge
