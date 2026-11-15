/**
 * 실시간 품질 "증명" — 접속 바 음질 버튼에서 위로 열리는 팝오버 400(모바일 바텀시트).
 * 맨 위 success 상자에 실제 형식(mono 17/600) · 표(왕복 지연 · 버퍼 · 손실·복구 · 중계 · 입력 장치) · L/R 레벨 24칸 ·
 * "받는 중: 사람별 형식" + [안정화]. 값은 useVoice 가 1초마다 폴링한 VoiceStats — 무손실 전송(lib/lossless)이면
 * transport·fallbackReason·format·bufferMs·recovered 가 실측으로 채워진다.
 */
import { useEffect, useState } from 'react'
import { useStore } from 'zustand'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { useIsMobile } from '~/composables/useIsMobile'
import { useMediaDevices } from '~/composables/useMediaDevices'
import { chatStore } from '~/composables/useChat'
import { useVoice } from '~/composables/useVoice'
import { UiModal } from '~/components/ui/Modal'
import { UiButton } from '~/components/ui/Button'
import { actualFormat, formatDb, lossPercent, meterSegments } from '~/lib/voice/ui'
import type { VoiceTier } from '~/lib/voice/transport'
import { VoicePopover } from './VoicePopover'

function num(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

/** 받는 중 — 사람별 짧은 형식 */
function shortFmt(tier: VoiceTier): string {
  switch (tier) {
    case 'music': return 'Opus'
    case 'lossless': return 'PCM 24/48'
    case 'hires': return 'PCM 32/192'
    default: return 'Opus 32'
  }
}

/** L/R 레벨 한 줄 — 24칸, 마지막 4칸 warning */
function Meter({ ch, db, label }: { ch: string; db: number; label: string }) {
  const segs = meterSegments(db)
  return (
    <div className="flex items-center gap-2" role="meter" aria-valuemin={-60} aria-valuemax={0} aria-valuenow={Math.max(-60, Math.round(db))} aria-label={label}>
      <span className="w-3 font-mono text-[12px] text-muted-foreground">{ch}</span>
      <div className="flex flex-1 gap-[3px]">
        {segs.map((s, i) => <span key={i} className={cn('h-2 flex-1 rounded-[1px]', s === 'on' ? 'bg-success' : s === 'warn' ? 'bg-warning' : 'bg-muted-foreground/45')} />)}
      </div>
      <span className="w-16 text-right font-mono text-[12px] text-muted-foreground">{formatDb(db)}</span>
    </div>
  )
}

export function VoiceStatsContent({ mobile }: { mobile: boolean }) {
  const { t } = useI18n()
  const v = useVoice()
  const { stats, levels, effectiveTier, prefs } = v
  const { microphones } = useMediaDevices()
  const parts = useStore(chatStore, s => (v.channelId ? s.voiceStates[v.channelId]?.participants : undefined))
  const words = { mono: t('chat.voice.mono'), stereo: t('chat.voice.stereo') }

  let fmt = actualFormat(effectiveTier, stats, prefs, words)
  if ((effectiveTier === 'lossless' || effectiveTier === 'hires') && stats.channels != null) fmt += ` · ${stats.channels >= 2 ? words.stereo : words.mono}`

  const bufMs = stats.bufferMs ?? stats.jitterBufferMs
  const buffer = bufMs == null ? '—' : t(prefs.bufferTarget === 'auto' ? 'chat.voice.stats.bufferAuto' : 'chat.voice.stats.bufferStabilized', { ms: Math.round(bufMs) })
  const loss = t('chat.voice.stats.lossValue', {
    pct: lossPercent(stats.packetsLost, stats.packetsSent), rec: num(stats.recovered), fail: num(stats.recvPacketsLost),
  })
  const relay = effectiveTier === 'lossless' && stats.transport
    ? `${t('chat.voice.stats.relayLossless', { transport: stats.transport === 'webtransport' ? 'WebTransport' : 'WebSocket' })}${stats.rttMs != null ? ` (${Math.round(stats.rttMs)} ms)` : ''}`
    : prefs.tier === 'lossless' && effectiveTier === 'music'
      ? t('chat.voice.stats.relayFallback', { reason: stats.fallbackReason || '—' })
      : t('chat.voice.stats.relayLivekit')
  const mic = (prefs.micDeviceId && microphones.find(d => d.deviceId === prefs.micDeviceId)) || microphones.find(d => d.isDefault) || microphones[0]
  const sr = stats.format?.sampleRate ?? stats.sampleRate
  const input = `${mic?.label || t('chat.voice.stats.defaultDevice')}${sr ? ` · ${(sr / 1000).toFixed(sr % 1000 ? 1 : 0)} kHz` : ''}`

  const rows: Array<[string, string]> = [
    [t('chat.voice.stats.rtt'), stats.rttMs == null ? '—' : `${Math.round(stats.rttMs)} ms`],
    [t('chat.voice.stats.buffer'), buffer],
    [t('chat.voice.stats.loss'), loss],
    [t('chat.voice.stats.relay'), relay],
    [t('chat.voice.stats.inputDevice'), input],
  ]
  const others = (parts ?? []).filter(p => p.identity !== v.identity)
  const receiving = others.length
    ? t('chat.voice.stats.receiving', { list: others.map(p => `${p.name} ${shortFmt(p.tier)}`).join(' · ') })
    : t('chat.voice.stats.receivingNone')

  return (
    <div className="flex flex-col gap-3.5" data-testid="voice-stats">
      {!mobile && (
        <div className="flex items-center gap-2">
          <p className="flex-1 text-[15px] font-semibold">{t('chat.voice.stats.title')}</p>
          <span className="text-[12px] text-muted-foreground">{t('chat.voice.stats.refresh')}</span>
        </div>
      )}
      <div className="rounded-lg border border-success/50 bg-success/10 px-3 py-2.5">
        <p className="text-[12px] text-muted-foreground">{t('chat.voice.stats.sendingFormat')}</p>
        <p className={cn('mt-0.5 font-mono font-semibold', mobile ? 'text-[15px]' : 'text-[17px]')} data-stat="format">{fmt}</p>
      </div>
      <dl className={cn('grid gap-x-4 gap-y-2', mobile ? 'text-[14px]' : 'text-[13px]')} style={{ gridTemplateColumns: 'auto 1fr' }}>
        {rows.map(([k, val]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="text-right font-mono" data-stat={k}>{val}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-col gap-1.5">
        <Meter ch="L" db={levels.left} label={t('chat.voice.stats.meter', { ch: 'L' })} />
        <Meter ch="R" db={levels.right} label={t('chat.voice.stats.meter', { ch: 'R' })} />
      </div>
      {mobile
        ? (
          <>
            <p className="text-[13px] text-muted-foreground">{receiving}</p>
            <UiButton variant="outline" size="lg" className="w-full" onClick={() => { void v.stabilize() }}>{t('chat.voice.stats.stabilize')}</UiButton>
          </>
        )
        : (
          <div className="flex items-center gap-2 border-t border-border pt-3">
            <p className="flex-1 text-[13px] text-muted-foreground">{receiving}</p>
            <UiButton variant="outline" size="xs" onClick={() => { void v.stabilize() }}>{t('chat.voice.stats.stabilize')}</UiButton>
          </div>
        )}
    </div>
  )
}

export interface VoiceStatsPanelProps {
  /** 접속 바의 음질 버튼(데스크톱 — 이 위로 열린다). 없으면 모달 */
  anchor?: HTMLElement | null
  onClose: () => void
}

export function VoiceStatsPanel({ anchor, onClose }: VoiceStatsPanelProps) {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  // 마운트 뒤 anchor ref 가 채워지는 한 틱을 기다린다
  const [, tick] = useState(0)
  useEffect(() => { if (!anchor) tick(x => x + 1) }, [anchor])
  if (isMobile) {
    return (
      <UiModal size="400" title={t('chat.voice.stats.title')} onClose={onClose}>
        <VoiceStatsContent mobile />
      </UiModal>
    )
  }
  return (
    <VoicePopover anchor={anchor ?? null} width={400} ariaLabel={t('chat.voice.stats.title')} onClose={onClose}>
      <VoiceStatsContent mobile={false} />
    </VoicePopover>
  )
}

export default VoiceStatsPanel
