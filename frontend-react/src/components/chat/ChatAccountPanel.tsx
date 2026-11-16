/**
 * 계정 패널 — 채널 목록 하단의 플로팅 카드.
 *  카드: 인셋 8(m-2 mt-0) · radius 8 · 1px border · bg-card.
 *  ① 음성 접속 중이면 상단 접속 줄(아래 선): 상태 점 · 상태 13/600(연결됨 success · PTT 말하는 중 · 재연결 warning) ·
 *     음질 버튼(점 + 단계 + 지연 mono → 음질 상태 팝오버, aria-expanded) · 음질 설정(sliders, aria-pressed) · 나가기(danger) /
 *     아래 "채널 · 워크스페이스" 12 muted. 재연결 시 위 테두리 warning 2px. (접속 바의 마이크·듣기 끔은 아래 계정 줄로 이동)
 *  ② 계정 줄 56: 아바타 32 + 상태 점 10 · 이름 14/600 + 상태 한 줄 12(클릭 시 사용자 메뉴 — 상태·프로필·설정) ·
 *     마이크 · 듣기 끔 · 사용자 설정(각 32, 아이콘 20).
 *  PTT(chatVoiceMode='ptt', lib/voice/ptt): 키를 누르고 있는 동안 마이크 success ring + success/15, 상태 줄 "` 키를 누르고 있음",
 *     접속 줄 "눌러서 말하는 중".
 *  단축키(이 화면이 표시된 동안): Ctrl+Shift+M 마이크 · Ctrl+Shift+D 듣기 끔.
 * 접속 중에는 이 카드가 접속 바를 렌더링하므로 셸 사이드바는 렌더링하지 않는다(registerVoiceBarHost).
 *
 * SIDEBAR 연결: ChatSidebar 최하단에 <ChatAccountPanel /> 한 줄(데스크톱). 모바일은 셸이 탭 바 위에 접속 바를 렌더링한다.
 */
import { useEffect, useRef, useState } from 'react'
import { createStore, useStore } from 'zustand'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { useAuth } from '~/composables/useAuth'
import { useChat } from '~/composables/useChat'
import { useMyStatus } from '~/composables/useMyStatus'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { registerVoiceBarHost, useVoice } from '~/composables/useVoice'
import { usePushToTalk } from '~/lib/voice/ptt'
import { barStatus, formatRtt, reconnectSeconds, tierDotClass } from '~/lib/voice/ui'
import { initialOf, openChatSettings } from '~/composables/useChatUi'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiStatusDot } from '~/components/ui/StatusDot'
import { UiIcon } from '~/components/ui/Icon'
import { LayoutUserMenu } from '~/components/layout/UserMenu'
import { VoiceStatsPanel } from '~/components/voice/VoiceStatsPanel'
import { VoiceQualityPanel } from '~/components/voice/VoiceQualityPanel'

const menuStore = createStore<{ open: boolean }>()(() => ({ open: false }))
/** 사용자 메뉴(상태 바꾸기) 열기 — 프로필 팝아웃 "상태 변경" */
export function openAccountMenu() { menuStore.setState({ open: true }) }
const closeAccountMenu = () => menuStore.setState({ open: false })

const BTN = 'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50'
const BTN_IDLE = 'text-muted-foreground hover:bg-overlay-hover hover:text-foreground'

export interface ChatAccountPanelProps { className?: string }

export function ChatAccountPanel({ className }: ChatAccountPanelProps) {
  const { t, locale } = useI18n()
  const { user } = useAuth()
  const my = useMyStatus()
  const v = useVoice()
  const ptt = usePushToTalk()
  const { channels } = useChat()
  const { appName } = useSiteConfig()
  const menuOpen = useStore(menuStore, s => s.open)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  useEffect(() => { setAnchor(cardRef.current) }, [v.statsOpen, v.qualityOpen])

  // 접속 중에는 이 카드가 접속 바 역할 수행 — 셸 사이드바 하단 바 비활성화
  const inVoice = v.inVoice
  useEffect(() => (inVoice ? registerVoiceBarHost() : undefined), [inVoice])

  // 재연결 초
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!v.reconnectSince) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [v.reconnectSince])

  // 사용자 메뉴 외부 클릭
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: PointerEvent) => {
      const tg = e.target as HTMLElement | null
      if (!tg || menuRef.current?.contains(tg) || tg.closest('[role="menu"],[role="dialog"]')) return
      closeAccountMenu()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [menuOpen])

  // Ctrl+Shift+M · Ctrl+Shift+D
  const vRef = useRef(v)
  vRef.current = v
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 'm') { e.preventDefault(); void vRef.current.toggleMute() }
      else if (k === 'd') { e.preventDefault(); void vRef.current.toggleDeafen() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!user) return null
  const displayName = user.display_name || user.username

  // 상태 한 줄: PTT 누르는 중 > 상태 메시지 > 상태(+ 방해 금지 기한)
  const statusLine = (() => {
    if (ptt.talking) return t('chat.shell.account.pttHolding', { key: ptt.keyLabel })
    if (my.message.text) return `${my.message.emoji ? my.message.emoji + ' ' : ''}${my.message.text}`
    const st = t(`ui.status.${my.dot}`)
    if (my.dndUntil) {
      const time = my.dndUntil.toLocaleTimeString(locale === 'en' ? 'en-US' : 'ko-KR', { hour: 'numeric', minute: '2-digit' })
      return `${st} · ${t('chat.shell.account.until', { time })}`
    }
    return st
  })()

  // 접속 줄
  const ch = channels.find(c => c.id === v.channelId)
  const chName = ch?.name || t('chat.voice.fallbackName')
  const st = barStatus(v.connectionState, v.listenOnly)
  const stText = ptt.talking && st.key === 'connected'
    ? t('chat.shell.account.pttTalking')
    : st.key === 'reconnecting'
      ? t('chat.voice.bar.status.reconnecting', { n: reconnectSeconds(v.reconnectSince, now) })
      : t(`chat.voice.bar.status.${st.key}`)
  const stTone = st.tone === 'success' ? 'text-success' : st.tone === 'warning' ? 'text-warning' : 'text-foreground'
  const reconnecting = st.key === 'reconnecting'
  const rtt = v.connectionState === 'connected' ? formatRtt(v.stats.rttMs) : '—'
  const tier = v.screenAudio && v.effectiveTier === 'voice' ? 'music' : v.effectiveTier

  // 마이크
  const micLocked = v.listenOnly
  const micLabel = ptt.talking
    ? t('chat.shell.account.pttMic', { key: ptt.keyLabel })
    : v.listenOnly ? t('chat.voice.bar.micLocked')
      : v.muted ? t('chat.shell.account.unmute') : t('chat.shell.account.mute')
  const micCls = ptt.talking ? 'bg-success/15 text-success ring-1 ring-success' : v.muted || v.listenOnly ? 'text-danger hover:bg-overlay-hover' : BTN_IDLE

  return (
    <div
      ref={cardRef}
      data-testid="chat-account-panel"
      className={cn('relative m-2 mt-0 shrink-0 rounded-lg border bg-card', reconnecting ? 'border-warning/60 border-t-2' : 'border-border', className)}
    >
      {inVoice && (
        <div className="flex flex-col gap-1 border-b border-border px-3 py-2" data-testid="voice-bar">
          <div className="flex items-center gap-2">
            <UiStatusDot status={st.dot} size={8} label={stText} />
            <p role="status" className={cn('min-w-0 flex-1 truncate text-[13px] font-semibold', stTone)}>{stText}</p>
            <button
              type="button"
              aria-expanded={v.statsOpen}
              aria-label={t('chat.voice.bar.qualityBtn')}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-muted-foreground/40 px-2 text-[12px] font-medium text-foreground hover:bg-overlay-hover focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => v.setStatsOpen(!v.statsOpen)}
            >
              <span className={tierDotClass(tier)} aria-hidden="true" />
              {t(`chat.voice.tier.${tier}.short`)}
              <span className="font-mono text-muted-foreground">{rtt}</span>
            </button>
            <button
              type="button"
              aria-label={t('chat.voice.quality.settings')}
              aria-pressed={v.qualityOpen}
              className={cn(BTN, v.qualityOpen ? 'bg-overlay-selected text-foreground' : BTN_IDLE)}
              onClick={() => v.setQualityOpen(!v.qualityOpen)}
            ><UiIcon name="sliders" className="h-4 w-4" /></button>
            <button
              type="button"
              aria-label={t('chat.voice.bar.leave')}
              title={t('chat.voice.bar.leave')}
              disabled={v.busy}
              className={cn(BTN, 'bg-danger text-background hover:bg-danger/90')}
              onClick={() => { void v.leave() }}
            ><UiIcon name="log-out" className="h-4 w-4" /></button>
          </div>
          <p className="truncate pl-4 text-[12px] text-muted-foreground">{t('chat.voice.bar.where', { channel: chName, workspace: appName })}</p>
        </div>
      )}

      <div className="flex items-center gap-1 px-2" style={{ height: 56 }}>
        <span className="relative shrink-0">
          <UiAvatar src={user.avatar_url} alt={displayName} fallback={initialOf(displayName)} className="h-8 w-8" textSize={12} />
          <UiStatusDot status={my.dot} size={10} ring="card" className="absolute -bottom-0.5 -right-0.5" />
        </span>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={t('chat.shell.account.menu', { name: displayName })}
          className="ml-1 min-w-0 flex-1 rounded-md px-1 py-0.5 text-left leading-tight hover:bg-overlay-hover focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => menuStore.setState({ open: !menuOpen })}
        >
          <span className="block truncate text-[14px] font-semibold text-foreground">{displayName}</span>
          <span className={cn('block truncate text-[12px]', ptt.talking ? 'text-success' : 'text-muted-foreground')}>{statusLine}</span>
        </button>
        <button
          type="button"
          aria-label={micLabel}
          title={micLabel}
          aria-pressed={ptt.talking ? true : v.listenOnly ? undefined : v.muted}
          disabled={micLocked}
          className={cn(BTN, micCls)}
          onClick={() => { void v.toggleMute() }}
        ><UiIcon name={v.muted || v.listenOnly ? 'mic-off' : 'mic-on'} className="h-5 w-5" /></button>
        <button
          type="button"
          aria-label={v.deafened ? t('chat.shell.account.undeafen') : t('chat.shell.account.deafen')}
          title={v.deafened ? t('chat.shell.account.undeafen') : t('chat.shell.account.deafen')}
          aria-pressed={v.deafened}
          className={cn(BTN, v.deafened ? 'text-danger hover:bg-overlay-hover' : BTN_IDLE)}
          onClick={() => { void v.toggleDeafen() }}
        ><UiIcon name={v.deafened ? 'headphones-off' : 'headphones'} className="h-5 w-5" /></button>
        <button
          type="button"
          aria-label={t('chat.shell.account.settings')}
          title={t('chat.shell.account.settings')}
          className={cn(BTN, BTN_IDLE)}
          onClick={() => { openChatSettings('profile') }}
        ><UiIcon name="settings" className="h-5 w-5" /></button>
      </div>

      {menuOpen && (
        <div ref={menuRef} className="absolute bottom-full left-0 z-dropdown mb-2">
          <LayoutUserMenu onClose={closeAccountMenu} />
        </div>
      )}
      {v.statsOpen && <VoiceStatsPanel anchor={anchor} onClose={() => v.setStatsOpen(false)} />}
      {v.qualityOpen && <VoiceQualityPanel anchor={anchor} onClose={() => v.setQualityOpen(false)} />}
    </div>
  )
}

export default ChatAccountPanel
