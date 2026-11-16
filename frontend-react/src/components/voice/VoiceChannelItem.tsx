/**
 * 사이드바 "음성" 구역의 채널 한 줄 + 접속자 줄.
 *  · 항목(높이 32): 스피커 아이콘(volume-2) · 이름 · 인원(mono 12). 본인이 입장한 채널 = bg-accent + 굵게, 본문에 열어 둔 채널 = bg-accent/60.
 *  · 접속자 줄(높이 32, 들여쓰기 pl-8): 아바타 24 · 이름 · 음소거 아이콘(danger) · 음질 단계 짧은 글자(mono 11).
 *    발화 중 = 아바타 success 링 + 이름 success. 본인 줄은 굵게.
 * 클릭 시 즉시 입장한다(벨 없음) — 본문도 해당 채널로 전환. 접속자는 서버 presence(chatStore.voiceStates), 발화 중 여부는 본인이 해당 방에 있을 때만 확인 가능(useVoice.peers).
 */
import { memo } from 'react'
import { useStore } from 'zustand'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { chatStore, type Channel, type VoicePresence } from '~/composables/useChat'
import { voiceStore } from '~/composables/useVoice'
import { initialOf } from '~/composables/useChatUi'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiIcon } from '~/components/ui/Icon'

export interface VoiceChannelItemProps {
  channel: Channel
  /** 본문에 열어 둔 채널 */
  selected: boolean
  /** 클릭 → 입장 + 본문 열기 */
  onClick: () => void
  /** 모바일 목록(행 44 · 글자 15) */
  mobile?: boolean
}

const MAX_SHOWN = 8

/** 접속자 한 줄 */
export function VoiceOccupantRow({ p, speaking, me, mobile, className }: { p: VoicePresence; speaking: boolean; me: boolean; mobile?: boolean; className?: string }) {
  const { t } = useI18n()
  return (
    <li className={cn('flex items-center gap-2 pl-8 pr-2', mobile ? 'h-10 text-[14px]' : 'h-8 text-[13px]', className)} data-speaking={speaking || undefined}>
      <span className={cn('rounded-full', speaking ? 'ring-2 ring-success ring-offset-2 ring-offset-card' : '')}>
        <UiAvatar src={p.avatar_url} alt={p.name} fallback={initialOf(p.name)} className="h-6 w-6" textSize={10} />
      </span>
      <span className={cn('min-w-0 flex-1 truncate', me ? 'font-semibold' : '', speaking ? 'text-success' : '')}>{p.name}</span>
      {p.deafened
        ? <span role="img" aria-label={t('chat.voice.sidebar.deafened')} className="inline-flex shrink-0 text-danger"><UiIcon name="headphones-off" className="h-3.5 w-3.5" /></span>
        : p.muted
          ? <span role="img" aria-label={t('chat.voice.muted')} className="inline-flex shrink-0 text-danger"><UiIcon name="mic-off" className="h-3.5 w-3.5" /></span>
          : null}
      <span className="font-mono text-[11px] text-muted-foreground" title={t(`chat.voice.tier.${p.tier}.name`)}>{t(`chat.voice.tier.${p.tier}.short`)}</span>
    </li>
  )
}

export const VoiceChannelItem = memo(function VoiceChannelItem({ channel, selected, onClick, mobile }: VoiceChannelItemProps) {
  const { t } = useI18n()
  const state = useStore(chatStore, s => s.voiceStates[channel.id])
  const myChannel = useStore(voiceStore, s => s.channelId === channel.id)
  const myIdentity = useStore(voiceStore, s => s.identity)
  const conn = useStore(voiceStore, s => (s.channelId === channel.id ? s.connectionState : 'disconnected'))
  // 발화 중 여부는 본인이 해당 방에 있을 때만 확인 가능
  const speakingIds = useStore(voiceStore, s => (s.channelId === channel.id ? s.peers.filter(p => p.isSpeaking).map(p => p.identity).join(',') : ''))
  const speaking = new Set(speakingIds ? speakingIds.split(',') : [])
  const parts = state?.participants ?? []
  const shown = parts.slice(0, MAX_SHOWN)
  const label = parts.length
    ? t('chat.voice.sidebar.occupants', { name: channel.name, n: parts.length })
    : t('chat.voice.sidebar.empty', { name: channel.name })

  return (
    <div className="mx-2 flex flex-col">
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 text-left transition-colors',
          mobile ? 'h-11 text-[15px]' : 'h-8 text-[14px]',
          myChannel ? 'bg-accent font-semibold text-foreground' : selected ? 'bg-accent/60 text-foreground' : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
        )}
        aria-current={selected ? 'true' : undefined}
        aria-label={myChannel ? `${label} — ${t('chat.voice.sidebar.connected')}` : label}
        onClick={onClick}
      >
        <UiIcon name={channel.type === 'private' ? 'lock' : 'volume-2'} className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{channel.name}</span>
        {myChannel && conn !== 'connected'
          ? <span role="img" aria-label={t(`chat.voice.state.${conn}`)} className="inline-flex shrink-0"><UiIcon name="loader" className="h-3.5 w-3.5 animate-spin text-warning" /></span>
          : parts.length > 0 && <span className="font-mono text-[12px] font-normal text-muted-foreground" aria-hidden="true">{parts.length}</span>}
      </button>
      {shown.length > 0 && (
        <ul aria-label={t('chat.voice.sidebar.occupantList', { name: channel.name })}>
          {shown.map(p => (
            <VoiceOccupantRow key={p.identity} p={p} speaking={speaking.has(p.identity)} me={p.identity === myIdentity} mobile={mobile} />
          ))}
          {parts.length > MAX_SHOWN && (
            <li className="flex h-8 items-center pl-8 pr-2 font-mono text-[11px] text-muted-foreground">+{parts.length - MAX_SHOWN}</li>
          )}
        </ul>
      )}
    </div>
  )
})

export default VoiceChannelItem
