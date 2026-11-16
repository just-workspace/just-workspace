/**
 * 음성채널 본문 상단 띠 — role=alert. 재연결 · 무손실 중계 실패(→ 음악 강등 + [무손실 다시 시도]) ·
 * 하이레조 장치 독점 실패(danger + [다시 시도]) · 이어폰 권장(출력이 스피커로 감지될 때 + [음성으로 바꾸기]) ·
 * 권한 없음(듣기 전용 + 브라우저별 한 줄 + [다시 시도]). 판정은 lib/voice/ui.bandsFor(순수 함수).
 * 데스크톱: mx-5 mt-4 · 버튼 오른쪽. 모바일: mx-4 mt-3 · 짧은 설명 · 버튼은 글 아래.
 */
import { useEffect } from 'react'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { useMediaDevices } from '~/composables/useMediaDevices'
import { useVoice } from '~/composables/useVoice'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { clampMusicBitrate } from '~/lib/voice/opus'
import { bandsFor, browserKind, detectSpeakerOutput, type VoiceBand } from '~/lib/voice/ui'

export function useSpeakerOutput() {
  const { speakers, refresh, startListening, stopListening } = useMediaDevices()
  const { prefs } = useVoice()
  // 라벨은 마이크 권한이 있을 때만 제공된다(enumerateDevices) — 조회 불가 시 unknown → 띠 미표시
  useEffect(() => { void refresh(); startListening(); return () => stopListening() }, [refresh, startListening, stopListening])
  return detectSpeakerOutput(speakers, prefs.speakerDeviceId)
}

export function VoiceBands({ mobile }: { mobile: boolean }) {
  const { t } = useI18n()
  const v = useVoice()
  const speakerOutput = useSpeakerOutput()
  const bands = bandsFor({
    connectionState: v.connectionState, wantTier: v.prefs.tier, effectiveTier: v.effectiveTier,
    listenOnly: v.listenOnly, speakerOutput, exclusiveFailed: !!v.exclusiveError,
  })
  if (!bands.length) return null
  const kbps = Math.round(clampMusicBitrate(v.prefs.musicBitrate) / 1000)
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''

  function textOf(b: VoiceBand): { title: string; desc: string; btn?: string; onBtn?: () => void } {
    switch (b.kind) {
      case 'reconnect':
        return { title: t('chat.voice.band.reconnect.title'), desc: t(mobile ? 'chat.voice.band.reconnect.descM' : 'chat.voice.band.reconnect.desc') }
      case 'relayFail':
        return { title: t('chat.voice.band.relayFail.title'), desc: t(mobile ? 'chat.voice.band.relayFail.descM' : 'chat.voice.band.relayFail.desc', { kbps }), btn: t('chat.voice.band.relayFail.btn'), onBtn: () => { void v.retryLossless() } }
      case 'exclusiveFail':
        return { title: t('chat.voice.band.exclusiveFail.title'), desc: t('chat.voice.band.exclusiveFail.desc', { app: v.exclusiveError?.app ?? '', device: v.exclusiveError?.device ?? '' }), btn: t('chat.voice.band.exclusiveFail.btn'), onBtn: () => { void v.retryHires() } }
      case 'earphone':
        return { title: t('chat.voice.band.earphone.title'), desc: t(mobile ? 'chat.voice.band.earphone.descM' : 'chat.voice.band.earphone.desc'), btn: t('chat.voice.band.earphone.btn'), onBtn: () => { void v.setPrefs({ tier: 'voice' }) } }
      case 'noPermission':
        return { title: t('chat.voice.band.noPermission.title'), desc: t(mobile ? 'chat.voice.band.noPermission.descM' : `chat.voice.band.noPermission.hint.${browserKind(ua)}`), btn: t('chat.voice.band.noPermission.btn'), onBtn: () => { void v.retryMic() } }
    }
  }

  return (
    <>
      {bands.map((b) => {
        const x = textOf(b)
        return (
          <div
            key={b.kind}
            role="alert"
            data-band={b.kind}
            className={cn(
              'flex items-start gap-3 rounded-lg border',
              mobile ? 'mx-4 mt-3 px-3 py-2.5' : 'mx-5 mt-4 px-4 py-3',
              b.tone === 'danger' ? 'border-danger/60 bg-danger/10' : 'border-warning/60 bg-warning/10',
            )}
          >
            <span className={cn('mt-0.5', b.tone === 'danger' ? 'text-danger' : 'text-warning')}><UiIcon name={b.icon} className="h-[18px] w-[18px]" /></span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold">{x.title}</p>
              <p className={cn('mt-0.5 text-[13px] text-muted-foreground', mobile ? 'leading-snug' : 'leading-relaxed')}>{x.desc}</p>
              {mobile && x.btn && <UiButton variant="outline" size="sm" className="mt-2" onClick={x.onBtn}>{x.btn}</UiButton>}
            </div>
            {!mobile && x.btn && <UiButton variant="outline" size="sm" onClick={x.onBtn}>{x.btn}</UiButton>}
          </div>
        )
      })}
    </>
  )
}

export default VoiceBands
