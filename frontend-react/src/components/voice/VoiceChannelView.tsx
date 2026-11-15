/**
 * 음성 채널 본문(handover-20 답 §5.3 · §5.5) — 채널을 열었을 때.
 *  머리 56: 스피커 아이콘 · 이름(16/600) · "{n}명 · 음질은 사람마다 따로"(13 muted) · 오른쪽 [음악 공유](outline sm, 접속 중).
 *  띠(role=alert, VoiceBands) → 본문: 참가자 타일 그리드 `repeat(auto-fill, minmax(220px,1fr))`(모바일 2열).
 *   타일 = 아바타 64 · 이름(+음소거 아이콘) · 음질 배지(tint) · 실제 형식 mono 12 · 상태 한 줄(말하는 중/음소거/듣기만). 말하는 중 = 테두리 success/60 + 아바타 링.
 *   음악 공유 중이면 맨 위 전체 폭 띠(primary 틴트): "○○ 님이 소리를 공유하고 있습니다" · 출처 · 형식 mono · [공유 음량].
 *  들어가기 전: 접속자 아바타 겹침 + "○○ 님이 들어가 있습니다" + [들어가기](lg) + "내 음질: 음성 · 들어가서 바꿀 수 있음".
 *  오른쪽 340 글 채팅(VoiceChatPanel) — 접속 중일 때만. 모바일은 머리 오른쪽 채팅 아이콘으로 전체 화면.
 * 참가자는 서버 presence(voiceStates) 가 바탕, 내가 들어가 있으면 전송(useVoice.peers)의 말하는 중·음소거·공유를 겹친다.
 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { authStore } from '~/composables/useAuth'
import { chatStore, useChat, type VoicePresence } from '~/composables/useChat'
import { useIsMobile } from '~/composables/useIsMobile'
import { useVoice } from '~/composables/useVoice'
import { initialOf } from '~/composables/useChatUi'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiTrans } from '~/components/ui/Trans'
import { openChatPanel } from '~/components/chat/ChatHeader'
import { actualFormat } from '~/lib/voice/ui'
import type { VoicePeer, VoiceTier } from '~/lib/voice/transport'
import { VoiceTierBadge } from './VoiceTierBadge'
import { VoiceBands } from './VoiceBands'
import { VoiceChatPanel } from './VoiceChatPanel'

export interface VoiceChannelViewProps {
  onBack?: () => void
  onOpenChannels?: () => void
  /** 오른쪽 자리를 다른 패널(멤버·스레드·검색…)이 쓰는 중 — 글 채팅(340)을 숨긴다(handover-22 셸: 자리는 하나) */
  chatHidden?: boolean
}

interface Tile {
  p: VicePresenceLike
  speaking: boolean
  muted: boolean
  deafened: boolean
  sharing: boolean
  me: boolean
  tier: VoiceTier
  fmt: string
  say: string
  sayTone: 'success' | 'muted'
}
type VicePresenceLike = Pick<VoicePresence, 'identity' | 'name' | 'avatar_url'>

/** 음악 공유 띠의 [공유 음량] — 그 사람 수신 음량 슬라이더(접속 바와 같은 팝 규칙 없이 띠 안에서 펼침) */
function ShareVolume({ identity, name }: { identity: string; name: string }) {
  const { t } = useI18n()
  const { setPeerVolume } = useVoice()
  const [open, setOpen] = useState(false)
  const [vol, setVol] = useState(100)
  return (
    <span className="flex items-center gap-2">
      {open && (
        <input
          type="range" min={0} max={100} value={vol} aria-label={t('chat.voice.view.share.volumeOf', { name })} className="w-24 accent-primary"
          onChange={(e) => { const n = Number(e.target.value); setVol(n); setPeerVolume(identity, n / 100) }}
        />
      )}
      <UiButton variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(o => !o)}>{t('chat.voice.view.share.volume')}</UiButton>
    </span>
  )
}

export function VoiceChannelView({ onBack, onOpenChannels, chatHidden = false }: VoiceChannelViewProps) {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const chat = useChat()
  const ch = chat.selectedChannel
  const v = useVoice()
  const state = useStore(chatStore, s => (ch ? s.voiceStates[ch.id] : undefined))
  const [chatOpen, setChatOpen] = useState(false)
  const chId = ch?.id
  useEffect(() => { setChatOpen(false) }, [chId])
  const headerRef = useRef<HTMLElement | null>(null)
  if (!ch) return null

  const mine = v.channelId === ch.id
  const live = new Map<string, VoicePeer>(mine ? v.peers.map(p => [p.identity, p]) : [])
  // 서버 presence 가 바탕. 내가 붙어 있는데 아직 presence 에 없으면(웹훅·소켓 전) 나를 덧붙여 그린다
  const parts: VoicePresence[] = [...(state?.participants ?? [])]
  if (mine && v.identity && !parts.some(p => p.identity === v.identity)) {
    const user = authStore.getState().user
    parts.push({ identity: v.identity, user_id: user?.id ?? null, name: user?.display_name || user?.username || t('chat.voice.me'), avatar_url: user?.avatar_url ?? null, muted: v.muted, deafened: v.deafened, tier: v.effectiveTier, joined_at: 0 })
  }
  const words = { mono: t('chat.voice.mono'), stereo: t('chat.voice.stereo') }

  const tiles: Tile[] = parts.map((p) => {
    const lp = live.get(p.identity)
    const me = mine && p.identity === v.identity
    const tier: VoiceTier = me ? v.effectiveTier : p.tier
    const muted = me ? (v.listenOnly || v.muted) : lp ? lp.micMuted : p.muted
    const deafened = me ? v.deafened : p.deafened
    const speaking = !!lp?.isSpeaking && !muted
    const say = me && v.listenOnly
      ? t('chat.voice.view.status.listenOnly')
      : speaking ? t('chat.voice.view.status.speaking') : deafened ? t('chat.voice.view.status.deafened') : muted ? t('chat.voice.view.status.muted') : ''
    return {
      p, me, tier, muted, deafened, speaking, sharing: !!lp?.sharingAudio || (me && v.screenAudio),
      fmt: actualFormat(tier, me ? v.stats : null, me ? v.prefs : null, words),
      say, sayTone: speaking ? 'success' : 'muted',
    }
  })
  const sharer = tiles.find(x => x.sharing)
  const names = parts.map(p => p.name).join(t('chat.voice.view.namesSep'))
  const myTierName = t(`chat.voice.tier.${v.prefs.tier}.name`)
  const musicShareBtn = mine && (
    <UiButton variant={v.screenAudio ? 'secondary' : 'outline'} size="sm" icon="music" onClick={() => { void v.toggleScreenAudio() }}>
      {v.screenAudio ? t('chat.voice.view.share.stop') : t('chat.voice.musicShare')}
    </UiButton>
  )

  // 모바일 전체 화면 채팅
  if (isMobile && mine && chatOpen) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="voice-view">
        <VoiceChatPanel channelName={ch.name} onBack={() => setChatOpen(false)} />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0" data-testid="voice-view">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {/* 머리 */}
        <header ref={headerRef} className={cn('flex h-14 shrink-0 items-center border-b border-border', isMobile ? 'gap-2 px-2' : 'gap-3 px-5')}>
          {isMobile && <UiIconButton icon="chevron-left" label={t('chat.header.backToList')} size="lg" onClick={() => onBack?.()} />}
          {!isMobile && onOpenChannels && <UiIconButton icon="menu" label={t('chat.header.channelList')} className="-ml-2 shrink-0" onClick={onOpenChannels} />}
          {!isMobile && <UiIcon name={ch.type === 'private' ? 'lock' : 'volume-2'} className="h-5 w-5 shrink-0 text-muted-foreground" />}
          {isMobile
            ? (
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-[16px] font-semibold">{ch.name}</p>
                <p className="text-[12px] text-muted-foreground">{t('chat.voice.view.subtitleM', { n: parts.length })}</p>
              </div>
            )
            : (
              <>
                <h1 className="truncate text-[16px] font-semibold">{ch.name}</h1>
                <span className="truncate text-[13px] text-muted-foreground">{t('chat.voice.view.subtitle', { n: parts.length })}</span>
                <span className="flex-1" />
                {musicShareBtn}
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1.5 rounded-[10px] px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  aria-label={`${t('chat.header.members')} ${ch.member_count || chat.members.length}`}
                  onClick={() => openChatPanel('members')}
                >
                  <UiIcon name="users" className="h-[15px] w-[15px]" />
                  <span className="font-mono">{ch.member_count || chat.members.length}</span>
                </button>
              </>
            )}
          {isMobile && mine && <UiIconButton icon="chat" label={t('chat.voice.view.chat.open')} size="lg" onClick={() => setChatOpen(true)} />}
        </header>

        {mine && <VoiceBands mobile={isMobile} />}

        {mine
          ? (
            /* 접속 중 — 타일 그리드 */
            <div className={cn('min-h-0 flex-1 overflow-y-auto', isMobile ? 'p-4' : 'p-5')}>
              {isMobile && sharer && (
                <div className="mb-3 flex items-center gap-3 rounded-lg border border-primary/50 bg-primary/10 px-3 py-2.5" data-testid="voice-share-band">
                  <UiIcon name="music" className="h-5 w-5 text-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold">{t('chat.voice.view.share.titleM', { name: sharer.p.name })}</p>
                    <p className="font-mono text-[12px] text-muted-foreground">{sharer.me ? actualFormat('music', v.stats, v.prefs, words) : actualFormat('music', null, null, words)}</p>
                  </div>
                  {isMobile && musicShareBtn}
                </div>
              )}
              <div className={isMobile ? 'grid grid-cols-2 gap-3' : 'grid gap-4'} style={isMobile ? undefined : { gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
                {!isMobile && sharer && (
                  <div className="col-span-full flex items-center gap-4 rounded-xl border border-primary/50 bg-primary/10 px-5 py-4" data-testid="voice-share-band">
                    <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/20 text-primary"><UiIcon name="music" className="h-5 w-5" /></span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-semibold">{t('chat.voice.view.share.title', { name: sharer.p.name })}</p>
                      <p className="mt-0.5 text-[13px] text-muted-foreground">{t('chat.voice.view.share.source')}</p>
                    </div>
                    <span className="rounded-md border border-muted-foreground/40 px-2.5 py-1 font-mono text-[12px]">{sharer.me ? actualFormat('music', v.stats, v.prefs, words) : actualFormat('music', null, null, words)}</span>
                    {sharer.me
                      ? <UiButton variant="ghost" size="sm" onClick={() => { void v.toggleScreenAudio() }}>{t('chat.voice.view.share.stop')}</UiButton>
                      : <ShareVolume identity={sharer.p.identity} name={sharer.p.name} />}
                  </div>
                )}
                {tiles.map((x) => (
                  <div
                    key={x.p.identity}
                    data-testid="voice-tile"
                    data-speaking={x.speaking || undefined}
                    className={cn(
                      'flex flex-col items-center rounded-xl border bg-card text-center',
                      isMobile ? 'gap-1.5 px-3 py-4' : 'gap-2 px-4 py-5',
                      x.speaking ? 'border-success/60' : 'border-border',
                    )}
                  >
                    <span className={cn('rounded-full', x.speaking ? 'ring-2 ring-success ring-offset-2 ring-offset-card' : '')}>
                      <UiAvatar src={x.p.avatar_url} alt={x.p.name} fallback={initialOf(x.p.name)} className={isMobile ? 'h-12 w-12' : 'h-16 w-16'} textSize={isMobile ? 16 : 20} />
                    </span>
                    <div className={cn('flex items-center text-[14px] font-semibold', isMobile ? 'gap-1' : 'gap-1.5')}>
                      <span className="truncate">{x.p.name}{x.me ? ` (${t('chat.voice.me')})` : ''}</span>
                      {x.deafened
                        ? <span role="img" aria-label={t('chat.voice.deafened')} className="text-danger"><UiIcon name="headphones-off" className="h-4 w-4" /></span>
                        : x.muted && <span role="img" aria-label={t('chat.voice.muted')} className="text-danger"><UiIcon name="mic-off" className="h-4 w-4" /></span>}
                    </div>
                    <VoiceTierBadge tier={x.tier} musicBitrate={x.me ? v.prefs.musicBitrate : undefined} stats={x.me ? v.stats : null} />
                    {!isMobile && (
                      <>
                        <p className="font-mono text-[12px] text-muted-foreground">{x.fmt}</p>
                        <p className={cn('min-h-[18px] text-[12px]', x.sayTone === 'success' ? 'text-success' : 'text-muted-foreground')}>{x.say}</p>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
          : isMobile
            ? (
              /* 모바일 들어가기 전 — 접속자 타일 + [들어가기] */
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {tiles.length > 0 && (
                  <div className="grid grid-cols-2 gap-3">
                    {tiles.map((x) => (
                      <div key={x.p.identity} className="flex flex-col items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-4 text-center">
                        <UiAvatar src={x.p.avatar_url} alt={x.p.name} fallback={initialOf(x.p.name)} className="h-12 w-12" textSize={16} />
                        <div className="flex items-center gap-1 text-[14px] font-semibold">
                          <span className="truncate">{x.p.name}</span>
                          {x.muted && <span role="img" aria-label={t('chat.voice.muted')} className="text-danger"><UiIcon name="mic-off" className="h-4 w-4" /></span>}
                        </div>
                        <VoiceTierBadge tier={x.tier} />
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-6 flex flex-col gap-2">
                  <UiButton size="lg" className="w-full" disabled={v.busy} onClick={() => { void v.join(ch.id) }}>{t('chat.voice.join')}</UiButton>
                  <p className="text-center text-[13px] text-muted-foreground">{t('chat.voice.view.idleDescM')}</p>
                </div>
              </div>
            )
            : (
              /* 데스크톱 들어가기 전 */
              <div className="flex flex-1 flex-col items-center justify-center gap-5 px-8 text-center">
                {tiles.length > 0 && (
                  <div className="flex -space-x-3">
                    {tiles.map((x) => (
                      <span key={x.p.identity} className="rounded-full ring-4 ring-background">
                        <UiAvatar src={x.p.avatar_url} alt={x.p.name} fallback={initialOf(x.p.name)} className="h-14 w-14" textSize={16} />
                      </span>
                    ))}
                  </div>
                )}
                <div>
                  <p className="text-[20px] font-semibold">{parts.length ? t('chat.voice.view.inside', { names }) : t('chat.voice.view.emptyTitle')}</p>
                  <p className="mt-2 text-[14px] text-muted-foreground">{t('chat.voice.view.idleDesc')}</p>
                </div>
                <div className="flex items-center gap-3">
                  <UiButton size="lg" className="px-6" disabled={v.busy} onClick={() => { void v.join(ch.id) }}>{t('chat.voice.join')}</UiButton>
                  <span className="text-[13px] text-muted-foreground">
                    <UiTrans k="chat.voice.view.myQuality" slots={{ tier: <b className="font-semibold text-foreground">{myTierName}</b> }} />
                  </span>
                </div>
              </div>
            )}
      </div>

      {/* 글 채팅 — 접속 중일 때만(데스크톱 오른쪽 340) */}
      {mine && !isMobile && !chatHidden && <VoiceChatPanel channelName={ch.name} />}
    </div>
  )
}

export default VoiceChannelView
