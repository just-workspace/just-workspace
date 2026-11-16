/**
 * 음질 패널 — 접속 바 [음질 설정]에서 위쪽으로 열리는 팝오버 460(모바일 바텀시트).
 * 제목 "내가 보내는 음질" + 부제 · 단계 4개(UiRadioCard row, meta = 예상 지연) · 음악 이상이면 warning 한 줄 ·
 * 고급(항상 펼침): 비트레이트 슬라이더(음악 256–510, 무손실은 흐림 + "2.3 Mbps (고정)") · 샘플레이트 44.1/48/96(96 은 웹에서 흐림) ·
 * 비트심도 16/24(무손실부터) · 버퍼 목표 [자동 · 60 · 120 · 250 ms]. 모바일 시트: 단계 3개(하이레조 없음) + 버퍼 목표 + 한 줄 안내.
 * 웹에서 하이레조는 disabled + 사유 표시. 무손실은 전송이 등록된 경우에만(tierAvailable) 선택 가능("준비 중").
 * 장치(마이크·스피커) 선택은 고급 최하단(참고).
 */
import { useEffect, useState } from 'react'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { useIsMobile } from '~/composables/useIsMobile'
import { useDesktopShell } from '~/composables/useDesktopShell'
import { useMediaDevices } from '~/composables/useMediaDevices'
import { useVoice } from '~/composables/useVoice'
import { UiModal } from '~/components/ui/Modal'
import { UiRadioCard } from '~/components/ui/RadioCard'
import { UiSegment } from '~/components/ui/Segment'
import { UiSelect } from '~/components/ui/Select'
import { UiBadge } from '~/components/ui/Badge'
import { UiIcon } from '~/components/ui/Icon'
import { UiSwitch } from '~/components/ui/Switch'
import { clampMusicBitrate, formatBitrate, MUSIC_BITRATE_MAX, MUSIC_BITRATE_STEP, VOICE_BITRATE } from '~/lib/voice/opus'
import { isEarphoneTier, losslessBitrate, TIER_LATENCY } from '~/lib/voice/ui'
import {
  VOICE_TIERS, VOICE_TIERS_MOBILE_HIDDEN,
  type VoiceBitDepth, type VoiceBufferTarget, type VoiceSampleRate, type VoiceTier,
} from '~/lib/voice/transport'
import { VoicePopover } from './VoicePopover'

/** 음악 슬라이더 범위(답: 256–510) */
const SLIDER_MIN = 256_000
// 네이티브 <select>(모바일)는 value '' 를 자리표시자로 간주하므로 "기본 장치"는 문자열 값으로 지정
const DEFAULT_DEV = '__default'

export function VoiceQualityContent({ mobile }: { mobile: boolean }) {
  const { t } = useI18n()
  const { isDesktopShell } = useDesktopShell()
  const { prefs, setPrefs, tierAvailable } = useVoice()
  const { microphones, speakers, audioOutputSupported, refresh, startListening, stopListening } = useMediaDevices()
  useEffect(() => { if (!mobile) { void refresh(); startListening(); return () => stopListening() } }, [mobile, refresh, startListening, stopListening])

  const tiers = VOICE_TIERS.filter(x => !(mobile && VOICE_TIERS_MOBILE_HIDDEN.includes(x)))
  const lossless = prefs.tier === 'lossless' || prefs.tier === 'hires'
  const music = prefs.tier === 'music'

  function pickTier(v: string | number | null) {
    const tier = String(v) as VoiceTier
    if (!tierAvailable(tier)) return
    void setPrefs({ tier })
  }

  const kb = Math.round(Math.max(SLIDER_MIN, clampMusicBitrate(prefs.musicBitrate)) / 1000)
  const brValue = music
    ? `${kb} kbps`
    : lossless
      ? t('chat.voice.quality.bitrateFixed', { v: formatBitrate(losslessBitrate(prefs.sampleRate, prefs.bitDepth)) })
      : t('chat.voice.quality.bitrateFixed', { v: formatBitrate(VOICE_BITRATE) })
  const brNote = music ? t('chat.voice.quality.bitrateNoteMusic') : lossless ? t('chat.voice.quality.bitrateNoteLossless') : t('chat.voice.quality.bitrateNoteVoice')

  const srItems = [
    { value: '44100', label: '44.1', disabled: !lossless, tooltip: !lossless ? t('chat.voice.quality.losslessOnly') : undefined },
    { value: '48000', label: '48 kHz' },
    { value: '96000', label: '96', disabled: !isDesktopShell || !lossless, tooltip: !isDesktopShell ? t('chat.voice.quality.sr96Why') : !lossless ? t('chat.voice.quality.losslessOnly') : undefined },
  ]
  const bdItems = [
    { value: '16', label: '16', disabled: !lossless, tooltip: !lossless ? t('chat.voice.quality.losslessOnly') : undefined },
    { value: '24', label: '24 bit', disabled: !lossless, tooltip: !lossless ? t('chat.voice.quality.losslessOnly') : undefined },
  ]
  const bufItems = [
    { value: 'auto', label: t('chat.voice.quality.bufferAuto') }, { value: '60', label: '60' }, { value: '120', label: '120' }, { value: '250', label: '250 ms' },
  ]
  const onBuffer = (v: string | number | null) => { void setPrefs({ bufferTarget: (v === 'auto' ? 'auto' : Number(v)) as VoiceBufferTarget }) }

  const tierCards = tiers.map((tier) => {
    const ok = tierAvailable(tier)
    const hiresWeb = tier === 'hires' && !isDesktopShell
    const desc = hiresWeb
      ? t('chat.voice.tier.hires.webWhy')
      : ok
        ? t(mobile ? `chat.voice.tier.${tier}.descM` : `chat.voice.tier.${tier}.desc`)
        : `${t(`chat.voice.tier.${tier}.desc`)} — ${t('chat.voice.quality.comingSoonWhy')}`
    return (
      <UiRadioCard
        key={tier}
        layout="row"
        value={tier}
        modelValue={prefs.tier}
        onUpdateModelValue={pickTier}
        title={t(`chat.voice.tier.${tier}.name`)}
        description={desc}
        disabled={!ok}
        meta={TIER_LATENCY[tier]}
        metaSlot={ok || hiresWeb ? undefined : <UiBadge tint tone="neutral" size={18}>{t('chat.voice.quality.comingSoon')}</UiBadge>}
      />
    )
  })

  // 음성 처리 — 단계와 별개(디스코드와 동일). 무손실·하이레조는 비트를 그대로 유지하므로 항상 비활성(잠금)
  const procLocked = lossless
  const aecOn = !procLocked && prefs.echoCancellation !== false
  const procItems = [
    { key: 'echoCancellation', label: t('chat.voice.quality.proc.aec'), desc: t('chat.voice.quality.proc.aecDesc') },
    { key: 'noiseSuppression', label: t('chat.voice.quality.proc.ns'), desc: t('chat.voice.quality.proc.nsDesc') },
    { key: 'autoGainControl', label: t('chat.voice.quality.proc.agc'), desc: t('chat.voice.quality.proc.agcDesc') },
  ] as const
  const procBlock = (
    <div className="flex flex-col gap-1" data-testid="voice-processing">
      <span className="text-[13px] font-medium">{t('chat.voice.quality.proc.title')}</span>
      {procItems.map(it => (
        <UiSwitch
          key={it.key}
          className="w-full"
          label={it.label}
          description={it.desc}
          disabled={procLocked}
          modelValue={!procLocked && prefs[it.key] !== false}
          onUpdateModelValue={(v) => { void setPrefs({ [it.key]: v }) }}
        />
      ))}
      <p className="text-[12px] text-muted-foreground">
        {procLocked ? t('chat.voice.quality.proc.lockedNote') : music && aecOn ? t('chat.voice.quality.proc.musicMonoNote') : t('chat.voice.quality.proc.note')}
      </p>
    </div>
  )

  const earNote = isEarphoneTier(prefs.tier) && !aecOn && (
    <p className="flex items-center gap-2 text-[13px] text-warning" data-testid="voice-earnote">
      <UiIcon name="alert-triangle" className="h-4 w-4" />{t('chat.voice.quality.earNote')}
    </p>
  )

  if (mobile) {
    return (
      <div className="flex flex-col gap-3" data-testid="voice-quality">
        <div role="radiogroup" aria-label={t('chat.voice.quality.title')} className="flex flex-col gap-2">{tierCards}</div>
        {earNote}
        {procBlock}
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">{t('chat.voice.quality.buffer')}</span>
          <UiSegment ariaLabel={t('chat.voice.quality.buffer')} size="lg" grow modelValue={String(prefs.bufferTarget)} items={bufItems} onUpdateModelValue={onBuffer} />
        </div>
        <p className="text-[12px] text-muted-foreground">{t('chat.voice.quality.hiresMobileNote')}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4" data-testid="voice-quality">
      <div>
        <p className="text-[15px] font-semibold">{t('chat.voice.quality.title')}</p>
        <p className="mt-0.5 text-[13px] text-muted-foreground">{t('chat.voice.quality.subtitle')}</p>
      </div>
      <div role="radiogroup" aria-label={t('chat.voice.quality.title')} className="flex flex-col gap-2">{tierCards}</div>
      {earNote}
      {procBlock}
      <div className="flex flex-col gap-3.5 border-t border-border pt-3.5">
        <p className="text-[12px] font-semibold text-muted-foreground">{t('chat.voice.quality.advanced')}</p>

        {/* 비트레이트 */}
        <div className={cn('flex flex-col gap-2', music ? '' : 'opacity-50')}>
          <div className="flex items-center text-[13px]">
            <label htmlFor="voice-bitrate" className="flex-1 font-medium">{t('chat.voice.quality.bitrate')}</label>
            <span className="font-mono">{brValue}</span>
          </div>
          <input
            id="voice-bitrate"
            type="range"
            min={SLIDER_MIN}
            max={MUSIC_BITRATE_MAX}
            step={MUSIC_BITRATE_STEP}
            value={music ? Math.max(SLIDER_MIN, clampMusicBitrate(prefs.musicBitrate)) : MUSIC_BITRATE_MAX}
            disabled={!music}
            aria-disabled={!music || undefined}
            onChange={(e) => { void setPrefs({ musicBitrate: Number(e.target.value) }) }}
            className="h-1.5 w-full accent-primary"
            aria-valuetext={brValue}
          />
          <p className="text-[12px] text-muted-foreground">{brNote}</p>
        </div>

        {/* 샘플레이트 · 비트심도 */}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">{t('chat.voice.quality.sampleRate')}</span>
            <UiSegment ariaLabel={t('chat.voice.quality.sampleRate')} size="sm" grow modelValue={String(prefs.sampleRate)} items={srItems}
              onUpdateModelValue={(v) => { void setPrefs({ sampleRate: Number(v) as VoiceSampleRate }) }} />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">{t('chat.voice.quality.bitDepth')}</span>
            <UiSegment ariaLabel={t('chat.voice.quality.bitDepth')} size="sm" grow modelValue={String(prefs.bitDepth)} items={bdItems}
              onUpdateModelValue={(v) => { void setPrefs({ bitDepth: Number(v) as VoiceBitDepth }) }} />
          </div>
        </div>
        <p className="text-[12px] text-muted-foreground">{t(lossless ? 'chat.voice.quality.srNoteLossless' : 'chat.voice.quality.srNoteOpus')}</p>

        {/* 버퍼 목표 */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">{t('chat.voice.quality.buffer')}</span>
          <UiSegment ariaLabel={t('chat.voice.quality.buffer')} size="sm" grow modelValue={String(prefs.bufferTarget)} items={bufItems} onUpdateModelValue={onBuffer} />
          <p className="text-[12px] text-muted-foreground">{t('chat.voice.quality.bufferNote')}</p>
        </div>

        {/* 장치 */}
        <div className="grid grid-cols-2 gap-3">
          <UiSelect
            label={t('chat.voice.quality.mic')}
            options={[{ value: DEFAULT_DEV, label: t('chat.voice.quality.defaultDevice') }, ...microphones.map(d => ({ value: d.deviceId, label: d.label }))]}
            modelValue={prefs.micDeviceId ?? DEFAULT_DEV}
            onUpdateModelValue={(v) => { void setPrefs({ micDeviceId: v && v !== DEFAULT_DEV ? String(v) : undefined }) }}
          />
          <UiSelect
            label={t('chat.voice.quality.speaker')}
            options={[{ value: DEFAULT_DEV, label: t('chat.voice.quality.defaultDevice') }, ...speakers.map(d => ({ value: d.deviceId, label: d.label }))]}
            modelValue={prefs.speakerDeviceId ?? DEFAULT_DEV}
            onUpdateModelValue={(v) => { void setPrefs({ speakerDeviceId: v && v !== DEFAULT_DEV ? String(v) : undefined }) }}
            disabled={!audioOutputSupported}
          />
        </div>
      </div>
    </div>
  )
}

export interface VoiceQualityPanelProps {
  /** 접속 바의 [음질 설정] 버튼(데스크톱 — 이 위로 열린다) */
  anchor?: HTMLElement | null
  onClose: () => void
}

export function VoiceQualityPanel({ anchor, onClose }: VoiceQualityPanelProps) {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const [, tick] = useState(0)
  useEffect(() => { if (!anchor) tick(x => x + 1) }, [anchor])
  if (isMobile) {
    return (
      <UiModal size="480" title={t('chat.voice.quality.title')} onClose={onClose}>
        <VoiceQualityContent mobile />
      </UiModal>
    )
  }
  return (
    <VoicePopover anchor={anchor ?? null} width={460} ariaLabel={t('chat.voice.quality.title')} onClose={onClose}>
      <VoiceQualityContent mobile={false} />
    </VoicePopover>
  )
}

export default VoiceQualityPanel
