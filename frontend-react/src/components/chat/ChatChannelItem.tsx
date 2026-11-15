/**
 * 채널·DM·음성·포럼 한 줄(handover-22 사이드바 · 시안 Chat22 #list #voice #drag · Mob22 #m-list).
 * 데스크톱 행 32: 아이콘 20 · 간격 8 · radius 8 · 왼쪽 8 · 글자 16.
 *   기본 muted-foreground / 안 읽음 600 + 왼쪽 알약 4×8 / 멘션 danger 숫자 / 음소거 bell-off(+ "오후 3:00까지 알림 끔" 툴팁) /
 *   선택 bg-overlay-selected / 호버 bg-overlay-hover + 초대·설정 아이콘 / 비공개 lock / 포럼 messages-square / DM 아바타 24 + 상태 점.
 *   음성 채널은 아래 접속자 줄(아바타 24 · 이름 14 · PTT · 사람별 음량 · 음소거 · 음질) 최대 4줄 + "+N명", 말하는 중 초록 링.
 *   접힌 카테고리(sectionCollapsed)면 접속자 줄 없이 오른쪽 인원 수만.
 * 모바일 행 44: 아이콘 20 · 글자 16 · 간격 12, 음성은 접속자 아바타 겹침(최대 3), 길게 누르기 = 채널 메뉴.
 * 음소거는 디스코드의 50% 투명 대신 bell-off 아이콘(접근성 — 4.5:1 유지, CONTRACT).
 * 호버 아이콘(초대·설정)은 행 버튼 안에 넣지 않고(버튼 중첩 금지) 형제 버튼으로 오른쪽 위에 겹친다.
 */
import { memo, useRef, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { useStore } from 'zustand'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { authStore } from '~/composables/useAuth'
import { chatStore, presenceOf, type Channel, type VoicePresence } from '~/composables/useChat'
import { dmPartner, initialOf } from '~/composables/useChatUi'
import { voiceStore } from '~/composables/useVoice'
import { userPrefsStore, USER_VOLUME } from '~/composables/useUserPrefs'
import { channelMentionCount, isChannelBold } from '~/lib/chatEvents'
import { isMutedNow, muteTooltip, voiceRows } from '~/utils/chatSidebarDnd'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiStatusDot } from '~/components/ui/StatusDot'
import { UiIcon } from '~/components/ui/Icon'

export interface ChatChannelItemProps {
  channel: Channel
  /** 지금 연 채널 */
  selected: boolean
  /** DM 표시 이름(없으면 채널 이름) */
  dmName?: string
  /** 모바일 목록 행(44) */
  mobile?: boolean
  /** 접힌 카테고리 안 — 음성 접속자 줄을 숨기고 인원 수만 */
  sectionCollapsed?: boolean
  /** 끄는 중인 원래 행(40%) */
  ghosted?: boolean
  /** 채널 관리 권한 — 설정 아이콘 */
  canManage?: boolean
  onClick?: () => void
  /** 우클릭 · 길게 누르기 → 채널 메뉴 */
  onMenu?: (anchor: DOMRect) => void
  /** Alt+Shift+↑↓ 한 칸 옮기기(권한 있을 때만 넘긴다) */
  onKeyMove?: (delta: -1 | 1) => void
  /** 호버 초대 아이콘 */
  onInvite?: () => void
  /** 호버 설정 아이콘 */
  onSettings?: () => void
  /** 접속자 줄 우클릭·길게 → 사람별 음량 */
  onOccupantMenu?: (p: VoicePresence, anchor: DOMRect) => void
  /** HTML5 끌기(권한 있을 때만) */
  draggable?: boolean
  onDragStart?: (e: DragEvent<HTMLElement>) => void
  onDragEnd?: (e: DragEvent<HTMLElement>) => void
  onDragOver?: (e: DragEvent<HTMLElement>) => void
  onDrop?: (e: DragEvent<HTMLElement>) => void
  /** 행 버튼 id(포커스 되돌리기) */
  rowId?: string
}

const LONG_PRESS_MS = 500
const pointRect = (x: number, y: number) => new DOMRect(x, y, 0, 0)

/** 길게 누르기 → cb(터치) */
function useLongPress(cb?: (r: DOMRect) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fired = useRef(false)
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null }
  return {
    fired,
    handlers: cb
      ? {
        onTouchStart: (e: React.TouchEvent) => {
          fired.current = false
          const t0 = e.touches[0]
          const r = pointRect(t0.clientX, t0.clientY)
          clear()
          timer.current = setTimeout(() => { fired.current = true; cb(r) }, LONG_PRESS_MS)
        },
        onTouchEnd: clear,
        onTouchMove: clear,
        onTouchCancel: clear,
      }
      : {},
  }
}

/** 접속자 한 줄(데스크톱) */
function OccupantRow({ p, speaking, me, ptt, volume, onMenu }: {
  p: VoicePresence; speaking: boolean; me: boolean; ptt: boolean; volume: number | null
  onMenu?: (p: VoicePresence, r: DOMRect) => void
}) {
  const { t } = useI18n()
  const lp = useLongPress(onMenu ? (r) => onMenu(p, r) : undefined)
  return (
    <li
      className="flex h-8 items-center gap-2 pl-9 pr-2 text-[14px]"
      data-speaking={speaking || undefined}
      onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu(p, pointRect(e.clientX, e.clientY)) } : undefined}
      {...lp.handlers}
    >
      <span className={cn('shrink-0 rounded-full', speaking ? 'ring-2 ring-success ring-offset-2 ring-offset-background' : '')}>
        <UiAvatar src={p.avatar_url} alt={p.name} fallback={initialOf(p.name)} className="h-6 w-6" textSize={10} />
      </span>
      <span className={cn('min-w-0 flex-1 truncate', me ? 'font-semibold text-foreground' : 'text-muted-foreground', speaking ? 'text-success' : '')}>{p.name}</span>
      {ptt && <span className="shrink-0 rounded border border-success/60 px-1 font-mono text-[10px] font-semibold text-success">{t('chat.side.ptt')}</span>}
      {volume !== null && (
        <span className="shrink-0 font-mono text-[11px] text-primary" title={t('chat.side.volumeOf', { name: p.name, n: volume })}>{t('chat.side.volumePct', { n: volume })}</span>
      )}
      {p.deafened
        ? <span role="img" aria-label={t('chat.voice.sidebar.deafened')} className="inline-flex shrink-0 text-danger"><UiIcon name="headphones-off" className="h-3.5 w-3.5" /></span>
        : p.muted
          ? <span role="img" aria-label={t('chat.voice.muted')} className="inline-flex shrink-0 text-danger"><UiIcon name="mic-off" className="h-3.5 w-3.5" /></span>
          : null}
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground" title={t(`chat.voice.tier.${p.tier}.name`)}>{t(`chat.voice.tier.${p.tier}.short`)}</span>
    </li>
  )
}

/** 채널·DM 목록 한 줄 */
export const ChatChannelItem = memo(function ChatChannelItem({
  channel, selected, dmName, mobile = false, sectionCollapsed = false, ghosted = false, canManage = false,
  onClick, onMenu, onKeyMove, onInvite, onSettings, onOccupantMenu,
  draggable, onDragStart, onDragEnd, onDragOver, onDrop, rowId,
}: ChatChannelItemProps) {
  const { t, locale } = useI18n()
  const user = useStore(authStore, s => s.user)
  const allUsers = useStore(chatStore, s => s.allUsers)
  const call = useStore(chatStore, s => s.callStates[channel.id])
  const voiceState = useStore(chatStore, s => (channel.is_voice ? s.voiceStates[channel.id] : undefined))
  const myVoice = useStore(voiceStore, s => s.channelId === channel.id)
  const myIdentity = useStore(voiceStore, s => s.identity)
  const conn = useStore(voiceStore, s => (s.channelId === channel.id ? s.connectionState : 'disconnected'))
  // 말하는 중은 내가 그 방에 있을 때만 안다(문자열로 골라 무한 갱신 방지)
  const speakingIds = useStore(voiceStore, s => (s.channelId === channel.id ? s.peers.filter(p => p.isSpeaking).map(p => p.identity).join(',') : ''))
  const pttMode = useStore(userPrefsStore, s => s.prefs.chatVoiceMode === 'ptt')
  const volumes = useStore(userPrefsStore, s => s.prefs.chatUserVolumes)

  const isDm = channel.type === 'dm'
  const isVoice = !!channel.is_voice
  const isForum = !!channel.forum_board_id
  const displayName = dmName || channel.name
  const partner = isDm ? dmPartner(channel, allUsers, user?.username) : null
  const presenceState = useStore(chatStore, s => (partner ? presenceOf(partner.id, s).state : null))

  const muted = isMutedNow(channel)
  const badgeCount = channelMentionCount(channel)
  const groupOnly = badgeCount === 0 && !!channel.group_mention && !muted
  const unread = isChannelBold(channel) && !muted
  const bold = unread || badgeCount > 0 || groupOnly
  const muteL = muted ? muteTooltip(channel.muted_until, t, locale) : ''

  const people = voiceState?.participants ?? []
  const speaking = new Set(speakingIds ? speakingIds.split(',') : [])
  const { shown, more } = voiceRows(people)

  const lp = useLongPress(mobile && onMenu ? onMenu : undefined)

  const icon = isVoice ? 'volume-2' : isForum ? 'messages-square' : channel.type === 'private' ? 'lock' : 'hash'

  const voiceLabel = isVoice
    ? (people.length ? t('chat.voice.sidebar.occupants', { name: channel.name, n: people.length }) : t('chat.voice.sidebar.empty', { name: channel.name }))
      + (myVoice ? ` — ${t('chat.voice.sidebar.connected')}` : '')
    : undefined
  const badgeLabel = isDm ? t('chat.sidebar.dmUnreadN', { n: badgeCount }) : t('chat.side.mentionsN', { n: badgeCount })

  function onKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (onKeyMove && e.altKey && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      onKeyMove(e.key === 'ArrowUp' ? -1 : 1)
    }
  }
  function onCtx(e: ReactMouseEvent) {
    if (!onMenu) return
    e.preventDefault()
    onMenu(pointRect(e.clientX, e.clientY))
  }
  function onRowClick() {
    if (lp.fired.current) { lp.fired.current = false; return }
    onClick?.()
  }

  const active = selected || myVoice
  const showHoverIcons = !isDm && !mobile && (!!onInvite || (canManage && !!onSettings))

  return (
    <div
      className={cn('group/row relative flex flex-col', ghosted ? 'opacity-40' : '')}
      data-channel-row={channel.id}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <button
        type="button"
        id={rowId}
        draggable={draggable || undefined}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={onRowClick}
        onContextMenu={onCtx}
        onKeyDown={onKey}
        {...lp.handlers}
        aria-current={selected ? 'true' : undefined}
        aria-label={voiceLabel}
        className={cn(
          'relative flex w-full items-center rounded-lg text-left text-[16px] transition-colors duration-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          mobile ? 'h-11 gap-3 px-2' : 'h-8 gap-2 pl-2 pr-2',
          active ? 'bg-overlay-selected font-semibold text-foreground' : bold ? 'font-semibold text-foreground hover:bg-overlay-hover' : 'text-muted-foreground hover:bg-overlay-hover hover:text-foreground',
          showHoverIcons ? 'group-hover/row:pr-14 group-focus-within/row:pr-14' : '',
        )}
      >
        {/* 안 읽음 알약 4×8 — 목록 안쪽 여백(8) 끝에 붙는다 */}
        {unread && !active && <span aria-hidden="true" className="absolute -left-2 top-1/2 h-2 w-1 -translate-y-1/2 rounded-r-full bg-foreground" />}

        {isDm
          ? (
            <span className="relative shrink-0">
              <UiAvatar
                src={partner?.avatar_url}
                alt={displayName}
                fallback={initialOf(displayName)}
                className={mobile ? 'h-8 w-8' : 'h-6 w-6'}
                textSize={mobile ? 12 : 10}
              />
              {presenceState && (
                <UiStatusDot status={presenceState} size={mobile ? 10 : 8} ring="background" className="absolute -bottom-0.5 -right-0.5" />
              )}
            </span>
          )
          : <UiIcon name={icon} className="h-5 w-5 shrink-0" aria-hidden="true" />}

        <span className="min-w-0 flex-1 truncate">{displayName}</span>

        {/* 통화 중(회의) */}
        {call && (
          <span
            className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium tabular-nums text-success"
            title={t('chat.sidebar.callN', { n: call.count }) + ' — ' + call.names.join(', ')}
            aria-label={t('chat.sidebar.callN', { n: call.count })}
          >
            <UiIcon name="video" className="h-3.5 w-3.5" />{call.count}
          </span>
        )}

        {/* 음성: 접속 중 표시 / 모바일 아바타 겹침 / 인원 수 */}
        {isVoice && myVoice && conn !== 'connected'
          ? <span role="img" aria-label={t(`chat.voice.state.${conn}`)} className="inline-flex shrink-0"><UiIcon name="loader" className="h-3.5 w-3.5 animate-spin text-warning" /></span>
          : isVoice && people.length > 0 && (mobile
            ? (
              <span className="flex shrink-0 -space-x-2" aria-hidden="true">
                {people.slice(0, 3).map(p => (
                  <span key={p.identity} className="rounded-full ring-2 ring-background">
                    <UiAvatar src={p.avatar_url} alt="" fallback={initialOf(p.name)} className="h-6 w-6" textSize={10} />
                  </span>
                ))}
              </span>
            )
            : <span className="shrink-0 font-mono text-[12px] font-normal text-muted-foreground" aria-hidden="true">{people.length}</span>)}

        {/* 음소거 — 툴팁에 끝나는 시각 */}
        {muted && badgeCount === 0 && (
          <span role="img" aria-label={muteL} title={muteL} className="inline-flex shrink-0 text-muted-foreground">
            <UiIcon name="bell-off" className={mobile ? 'h-[18px] w-[18px]' : 'h-4 w-4'} />
          </span>
        )}

        {badgeCount > 0
          ? (
            <span
              className={cn(
                'inline-flex shrink-0 items-center justify-center rounded-full bg-danger px-1.5 text-center font-bold leading-5 text-background',
                mobile ? 'min-w-6 text-[13px]' : 'min-w-[20px] text-[12px]',
              )}
              aria-label={badgeLabel}
              title={badgeLabel}
            >{badgeCount > 99 ? '99+' : badgeCount}</span>
          )
          : groupOnly && (
            <span
              className="inline-flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-danger px-1 font-mono text-[11px] font-bold text-danger"
              aria-label={t('chat.sidebar.groupMention')}
              title={t('chat.sidebar.groupMention')}
            >@</span>
          )}
      </button>

      {/* 호버 — 초대 · 설정(형제 버튼, 행 오른쪽 위에 겹침) */}
      {showHoverIcons && (
        <span className="absolute right-1.5 top-0 hidden h-8 items-center gap-1.5 text-muted-foreground group-hover/row:flex group-focus-within/row:flex">
          {onInvite && (
            <button type="button" className="inline-flex rounded hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring" aria-label={t('chat.side.invite')} title={t('chat.side.invite')} onClick={onInvite}>
              <UiIcon name="user-plus" className="h-4 w-4" />
            </button>
          )}
          {canManage && onSettings && (
            <button type="button" className="inline-flex rounded hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring" aria-label={t('chat.side.channelSettings')} title={t('chat.side.channelSettings')} onClick={onSettings}>
              <UiIcon name="settings" className="h-4 w-4" />
            </button>
          )}
        </span>
      )}

      {/* 음성 접속자 줄 — 최대 4줄 + "+N명". 접힌 카테고리·모바일은 숨김 */}
      {isVoice && !mobile && !sectionCollapsed && shown.length > 0 && (
        <ul aria-label={t('chat.voice.sidebar.occupantList', { name: channel.name })}>
          {shown.map(p => {
            const me = p.identity === myIdentity
            const vol = p.user_id ? volumes[p.user_id] : undefined
            return (
              <OccupantRow
                key={p.identity}
                p={p}
                speaking={speaking.has(p.identity)}
                me={me}
                ptt={me && myVoice && pttMode}
                volume={!me && vol !== undefined && vol !== USER_VOLUME.def ? vol : null}
                onMenu={!me && p.user_id ? onOccupantMenu : undefined}
              />
            )
          })}
          {more > 0 && <li className="flex h-6 items-center pl-9 text-[12px] text-muted-foreground">{t('chat.side.voiceMore', { n: more })}</li>}
        </ul>
      )}
    </div>
  )
})

export default ChatChannelItem
