/**
 * 채널 우클릭(데스크톱)·길게 누르기(모바일 시트) 메뉴.
 * 항목(시안 순서): 읽음으로 표시 · 알림 끄기 › (15분 · 1시간 · 3시간 · 8시간 · 24시간 · 직접 끌 때까지) · 알림 설정 | 채널 편집 · 링크 복사.
 * 음소거 중이면 "알림 끄기 ›" 앞에 "알림 켜기"를 더 둔다(참고 — 시안은 꺼진 상태만 그렸다).
 * 알림 끄기 = chatApi22.muteChannelFor(PATCH prefs muted_minutes) → 채널 목록 muted · muted_until 을 바로 고친다(WS channel_prefs 가 오면 덮어씀).
 * DM 은 채널 편집 없음. 채널 편집은 MANAGE_CHANNELS 가 있을 때만(설정 화면 channel-perm).
 */
import { useI18n } from '~/i18n'
import { chatStore, markChannelRead, toggleMute, type Channel } from '~/composables/useChat'
import { openChatSettings, setNotifySheetChannelId } from '~/composables/useChatUi'
import { MUTE_DURATIONS, muteChannelFor } from '~/composables/chatApi22'
import { addToast } from '~/composables/useToast'
import { writeClipboard } from '~/lib/clipboard'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { channelLabel, isMutedNow } from '~/utils/chatSidebarDnd'

export interface ChatChannelMenuProps {
  channel: Channel
  /** 표시 이름(DM 은 상대 이름) */
  displayName: string
  anchor: DOMRect | HTMLElement
  canManage: boolean
  onClose: () => void
}

/** 음소거 기간 키 → 분(null = 직접 끌 때까지) */
export function muteKeyMinutes(key: string): number | null | undefined {
  if (!key.startsWith('mute:')) return undefined
  const v = key.slice(5)
  return v === 'forever' ? null : Number(v)
}

/** 음소거 기간 하위 메뉴 6개 */
export function muteChildren(t: (k: string) => string): UiMenuItem[] {
  return MUTE_DURATIONS.map(m => ({
    key: `mute:${m ?? 'forever'}`,
    label: t(`chat.side.muteFor.${m ?? 'forever'}`),
  }))
}

/** 기간 음소거 + 목록 반영 */
export async function muteFor(channelId: string, minutes: number | null) {
  const r = await muteChannelFor(channelId, minutes)
  const until = r && 'muted_until' in r ? r.muted_until
    : minutes === null ? null : new Date(Date.now() + minutes * 60_000).toISOString()
  chatStore.setState({
    channels: chatStore.getState().channels.map(c => (c.id === channelId ? { ...c, muted: true, muted_until: until ?? null } : c)),
  })
}

export async function unmute(channelId: string) {
  await toggleMute(channelId, false)
  chatStore.setState({
    channels: chatStore.getState().channels.map(c => (c.id === channelId ? { ...c, muted: false, muted_until: null } : c)),
  })
}

/** 채널 메뉴 */
export function ChatChannelMenu({ channel, displayName, anchor, canManage, onClose }: ChatChannelMenuProps) {
  const { t } = useI18n()
  const isDm = channel.type === 'dm'
  const muted = isMutedNow(channel)

  const items: UiMenuItem[] = [
    { key: 'title', label: isDm ? displayName : channelLabel(channel), heading: true },
    { key: 'read', label: t('chat.side.ch.markRead') },
    ...(muted ? [{ key: 'unmute', label: t('chat.side.ch.unmute') }] : []),
    { key: 'mute', label: t('chat.side.ch.mute'), children: muteChildren(t), panelWidth: 200 },
    { key: 'notify', label: t('chat.side.ch.notify') },
    ...(!isDm && canManage ? [{ key: 'edit', label: t('chat.side.ch.edit'), separated: true }] : []),
    { key: 'link', label: t('chat.side.ch.copyLink'), separated: isDm || !canManage },
  ]

  async function run(key: string) {
    try {
      const mins = muteKeyMinutes(key)
      if (mins !== undefined) await muteFor(channel.id, mins)
      else if (key === 'unmute') await unmute(channel.id)
      else if (key === 'read') await markChannelRead(channel.id)
      else if (key === 'notify') setNotifySheetChannelId(channel.id)
      else if (key === 'edit') openChatSettings('channel-perm', channel.id)
      else if (key === 'link') {
        await writeClipboard(`${location.origin}/chat?${new URLSearchParams({ channel: channel.id }).toString()}`)
        addToast('success', t('chat.side.ch.linkCopied'))
      }
    } catch {
      addToast('error', t(key.startsWith('mute') || key === 'unmute' ? 'chat.side.muteFailed' : 'chat.side.actionFailed'))
    }
  }

  return (
    <UiMenu
      anchor={anchor}
      align="start"
      width={236}
      dense
      label={isDm ? displayName : channelLabel(channel)}
      title={isDm ? displayName : channelLabel(channel)}
      items={items}
      onSelect={(k) => { void run(k) }}
      onClose={onClose}
    />
  )
}

export default ChatChannelMenu
