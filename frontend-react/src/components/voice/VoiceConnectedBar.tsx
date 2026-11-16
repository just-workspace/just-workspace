/**
 * 접속 바(사이드바 하단). 음성 채널 접속 중에는 모든 화면에 표시한다(세션은 useVoice 앱 수준 싱글턴).
 *  · 데스크톱(사이드바 하단, 채팅 목록 사이드바 또는 셸 사이드바 wide): 1줄 = 상태 점 · 상태(13/600) · "채널 · 워크스페이스"(12) ·
 *    오른쪽 음질 버튼(점 + 단계 + 지연 mono → 음질 상태 팝오버, aria-expanded). 2줄 = 마이크 · 듣기 끔(aria-pressed) · 음질 설정(aria-pressed) · 나가기(danger). 버튼 40.
 *  · 모바일(하단 탭 바 바로 위): 1줄 동일 구성(상태 14) · 2줄 버튼 44 네 칸 균등. 팝오버는 바텀시트.
 *  · compact(셸 사이드바가 레일 64 일 때 — 참고): 동일 버튼을 세로로 배치한다. 음질 상태는 점 버튼으로 표시.
 *  · 재연결 = 위 테두리 warning 2px + "다시 연결하는 중… N초". 권한 없음 = "듣기만 하는 중" + 마이크 잠금. 연결 중 = 마이크 잠금 · 지연 "—".
 * 수신 음성은 전송 계층이 숨김 <audio> 로 출력한다(화면과 무관).
 */
import { useEffect, useRef, useState } from 'react'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { useChat } from '~/composables/useChat'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useVoice } from '~/composables/useVoice'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiStatusDot } from '~/components/ui/StatusDot'
import { barStatus, formatRtt, reconnectSeconds, tierDotClass } from '~/lib/voice/ui'
import { VoiceStatsPanel } from './VoiceStatsPanel'
import { VoiceQualityPanel } from './VoiceQualityPanel'

export interface VoiceConnectedBarProps {
  /** 모바일(탭 바 위) — 버튼 44 네 칸 */
  mobile?: boolean
  /** 셸 사이드바 레일(64) 안 — 세로 배치 */
  compact?: boolean
  className?: string
}

export function VoiceConnectedBar({ mobile = false, compact = false, className }: VoiceConnectedBarProps) {
  const { t } = useI18n()
  const v = useVoice()
  const { channels } = useChat()
  const { appName } = useSiteConfig()
  const ch = channels.find(c => c.id === v.channelId)
  const name = ch?.name || t('chat.voice.fallbackName')

  // 재연결 초 계수
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!v.reconnectSince) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [v.reconnectSince])

  const st = barStatus(v.connectionState, v.listenOnly)
  const stText = st.key === 'reconnecting'
    ? t('chat.voice.bar.status.reconnecting', { n: reconnectSeconds(v.reconnectSince, now) })
    : t(`chat.voice.bar.status.${st.key}`)
  const stTone = st.tone === 'success' ? 'text-success' : st.tone === 'warning' ? 'text-warning' : 'text-foreground'
  const reconnecting = st.key === 'reconnecting'
  const rtt = v.connectionState === 'connected' ? formatRtt(v.stats.rttMs) : '—'
  const tier = v.screenAudio && v.effectiveTier === 'voice' ? 'music' : v.effectiveTier
  const micLocked = v.listenOnly || v.connectionState !== 'connected'
  const micLabel = v.listenOnly ? t('chat.voice.bar.micLocked') : v.connectionState !== 'connected' ? t('chat.voice.bar.micConnecting') : v.muted ? t('chat.voice.unmute') : t('chat.voice.mute')
  const micIcon = v.listenOnly || v.muted ? 'mic-off' : 'mic-on'

  // 팝오버는 접속 바(사이드바 하단) 위로 열린다 — 기준은 바 자체(시안: 사이드바 왼쪽 + 12, 바 바로 위)
  const barRef = useRef<HTMLDivElement | null>(null)
  const qualityBtn = useRef<HTMLButtonElement | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  useEffect(() => { setAnchor(barRef.current) }, [v.statsOpen, v.qualityOpen, mobile, compact])

  const size = mobile ? 'lg' : 'md'
  const btnCls = mobile ? 'w-full' : ''
  const deafenBtn = (
    <button
      type="button"
      aria-label={v.deafened ? t('chat.voice.undeafen') : t('chat.voice.deafen')}
      aria-pressed={v.deafened}
      className={cn(
        'flex items-center justify-center rounded-md bg-muted hover:bg-accent transition-colors',
        mobile ? 'h-11 w-full' : 'h-10 w-10',
        v.deafened ? 'text-danger' : '',
      )}
      onClick={() => { void v.toggleDeafen() }}
    >
      <svg className={mobile ? 'h-5 w-5' : 'h-[18px] w-[18px]'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {v.deafened
          ? <><path d="M21 14h-1.343" /><path d="M9.128 3.47A9 9 0 0 1 21 12v3.343" /><path d="m2 2 20 20" /><path d="M20.414 20.414A2 2 0 0 1 19 21h-1a2 2 0 0 1-2-2v-3" /><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 2.636-6.364" /></>
          : <path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />}
      </svg>
    </button>
  )
  const micBtn = <UiIconButton size={size} variant="muted" icon={micIcon} label={micLabel} disabled={micLocked} pressed={v.listenOnly ? undefined : v.muted} className={cn(btnCls, v.muted && !micLocked ? 'text-danger' : '')} onClick={() => { void v.toggleMute() }} />
  const settingsBtnEl = <UiIconButton size={size} variant={v.qualityOpen ? 'solid' : 'muted'} icon="sliders" label={t('chat.voice.quality.settings')} pressed={v.qualityOpen} className={btnCls} onClick={() => v.setQualityOpen(!v.qualityOpen)} />
  const leaveBtn = <UiIconButton size={size} variant="solid" icon="log-out" label={t('chat.voice.bar.leave')} className={cn(btnCls, 'bg-danger text-background hover:bg-danger/90')} disabled={v.busy} onClick={() => { void v.leave() }} />
  const panels = (
    <>
      {v.statsOpen && <VoiceStatsPanel anchor={anchor} onClose={() => v.setStatsOpen(false)} />}
      {v.qualityOpen && <VoiceQualityPanel anchor={anchor} onClose={() => v.setQualityOpen(false)} />}
    </>
  )

  if (compact) {
    return (
      <div
        ref={barRef}
        data-testid="voice-bar"
        className={cn('flex flex-col items-center gap-1.5 border-t bg-card py-2', reconnecting ? 'border-t-2 border-warning/60' : 'border-border', className)}
      >
        <span role="status" className="sr-only">{stText} · {name}</span>
        <button
          ref={qualityBtn}
          type="button"
          aria-label={`${t('chat.voice.bar.qualityBtn')} — ${t(`chat.voice.tier.${tier}.short`)} ${rtt}`}
          aria-expanded={v.statsOpen}
          title={`${stText} · ${name}`}
          className="flex h-10 w-10 flex-col items-center justify-center gap-1 rounded-md border border-muted-foreground/40 hover:bg-accent"
          onClick={() => v.setStatsOpen(!v.statsOpen)}
        >
          <UiStatusDot status={st.dot} size={8} label={stText} />
          <span className={tierDotClass(tier)} aria-hidden="true" />
        </button>
        {micBtn}
        {deafenBtn}
        {settingsBtnEl}
        {leaveBtn}
        {panels}
      </div>
    )
  }

  return (
    <div
      ref={barRef}
      data-testid="voice-bar"
      className={cn(
        'flex shrink-0 flex-col gap-2 border-t bg-card py-2.5',
        mobile ? 'px-4' : 'px-3',
        reconnecting ? 'border-t-2 border-warning/60' : 'border-border',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <UiStatusDot status={st.dot} size={8} label={stText} />
        {mobile
          ? <p role="status" className={cn('min-w-0 flex-1 truncate text-[14px] font-semibold', stTone)}>{stText}</p>
          : (
            <div role="status" className="min-w-0 flex-1 leading-tight">
              <div className={cn('truncate text-[13px] font-semibold', stTone)}>{stText}</div>
              <div className="truncate text-[12px] text-muted-foreground">{t('chat.voice.bar.where', { channel: name, workspace: appName })}</div>
            </div>
          )}
        <button
          ref={qualityBtn}
          type="button"
          aria-expanded={v.statsOpen}
          aria-label={t('chat.voice.bar.qualityBtn')}
          className={cn(
            'flex items-center gap-1.5 rounded-md border border-muted-foreground/40 font-medium hover:bg-accent',
            mobile ? 'h-9 px-2.5 text-[13px]' : 'h-8 px-2 text-[12px]',
          )}
          onClick={() => v.setStatsOpen(!v.statsOpen)}
        >
          <span className={tierDotClass(tier)} aria-hidden="true" />
          {t(`chat.voice.tier.${tier}.short`)}
          <span className="font-mono text-muted-foreground">{rtt}</span>
        </button>
      </div>
      {mobile
        ? (
          <div className="grid grid-cols-4 gap-2">
            {micBtn}{deafenBtn}{settingsBtnEl}{leaveBtn}
          </div>
        )
        : (
          <div className="flex items-center gap-1.5">
            {micBtn}{deafenBtn}{settingsBtnEl}
            <span className="flex-1" />
            {leaveBtn}
          </div>
        )}
      {panels}
    </div>
  )
}

export default VoiceConnectedBar
