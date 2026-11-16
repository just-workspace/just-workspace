/**
 * 채널 헤더.
 * 데스크톱 48 + 아래 1px(= 49, 디스코드 실측): 아이콘 20 · 채널 이름 16/600(클릭 시 채널 메뉴) · 구분선 · 주제(13 muted 말줄임)
 *   · 세그먼트 sm(메시지·파일·회의·작업 — 포럼 채널은 글 목록/갤러리) · 구분선 · 통화 · 스레드 목록 · 고정 · 멤버 토글(각 32, aria-pressed)
 *   · 검색칸 160(포커스 360 — ChatSearchBox, RIGHT). 검색칸이 펼쳐지면 세그먼트는 숨긴다(시안 #search-*).
 *   채팅 화면에는 전역 상단바가 없다(routes.ts noDesktopTopbar) — 상단 크롬은 본 헤더 하나이다.
 *   채널 메뉴(이름 버튼): 알림 설정 · 탭 관리(관리 권한) · 채널 나가기 · 채널 삭제(소유자). 시안 헤더에 ⋯ 가 없어 이름 버튼으로 이동했다.
 * 모바일 56: ‹ 뒤로(+ 다른 채널 멘션 합계) · 이름 + "멤버 N명 · M명 접속 중"(클릭 시 멤버) · 스레드 · 멤버 · ⋯(통화·알림·나가기·삭제) — 전부 44.
 * 오른쪽 자리는 하나이다(utils/chatRightColumn): 새로 연 패널이 기존 패널을 대체한다 — openChatPanel.
 */
import { useStore } from 'zustand'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import {
  chatStore, closeThread, deleteChannel, leaveChannel, presenceOf, setShowMemberPanel, setShowPinsPanel, setShowSearchPanel, useChat,
} from '~/composables/useChat'
import { authStore } from '~/composables/useAuth'
import { confirmBox } from '~/composables/useDialog'
import { addToast } from '~/composables/useToast'
import { chatUiStore, setMembersOpen, setNotifySheetChannelId, setThreadListOpen, useChatUi } from '~/composables/useChatUi'
import { voiceStore } from '~/composables/useVoice'
import { viewportStore } from '~/composables/useViewport'
import { isMobileNow } from '~/composables/useIsMobile'
import { useChatSearchExpanded } from '~/composables/useChatSearch'
import { openRoom } from '~/composables/useMeetingCall'
import { channelMentionCount } from '~/lib/chatEvents'
import { panelOf } from '~/utils/chatStage'
import {
  CHAT_MEMBERS_DOCK_MIN, nextRightState, resolveRightColumn, type RightColumn, type RightOpenKind,
} from '~/utils/chatRightColumn'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiStatusDot } from '~/components/ui/StatusDot'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { UiSegment, type SegmentItem } from '~/components/ui/Segment'
import { ChatSearchBox } from './ChatSearchBox'
import { ForumViewToggle } from './ChatForumView'

export type ForumView = 'list' | 'gallery'

export interface ChatHeaderProps {
  /** 모바일 ‹ 뒤로(목록으로) */
  onBack?: () => void
  /** 세로 화면(데스크톱): 헤더 왼쪽 ☰ — 접힌 채널 목록 서랍 열기. 없으면 미표시 */
  onOpenChannels?: () => void
  className?: string
  /** 채널 보기 세그먼트(메시지·파일·회의·작업). 없으면 미표시(DM) */
  tabs?: SegmentItem[] | null
  tab?: string
  onTab?: (v: string) => void
  /** 포럼 채널: 세그먼트 대신 글 목록/갤러리 */
  forumView?: ForumView | null
  onForumView?: (v: ForumView) => void
  /** 채널 메뉴 "탭 관리"(관리 권한 보유 시에만 전달) */
  onManageTabs?: () => void
}

/** 현재 오른쪽 자리(store 값 기준) */
export function currentRightColumn(): RightColumn {
  const s = chatStore.getState()
  const ui = chatUiStore.getState()
  const ch = s.channels.find(c => c.id === s.selectedChannelId)
  return resolveRightColumn({
    panel: panelOf(s, ui.threadListOpen),
    width: viewportStore.getState().width,
    membersOpen: ui.membersOpen,
    hasChannel: !!s.selectedChannelId,
    voiceTextAvailable: !!ch?.is_voice && voiceStore.getState().channelId === ch.id,
    voiceTextOpen: ui.voiceTextOpen,
  })
}

/** 오른쪽 자리 열기/닫기 — 하나만 유지(새로 연 패널이 기존 패널을 대체). 이미 표시 중이면 닫음 */
export function openChatPanel(kind: RightOpenKind) {
  const wide = !isMobileNow() && viewportStore.getState().width >= CHAT_MEMBERS_DOCK_MIN
  const n = nextRightState(kind, currentRightColumn(), wide, chatUiStore.getState().membersOpen)
  if (n.closeThread && chatStore.getState().activeThreadId) closeThread()
  setShowSearchPanel(n.showSearchPanel)
  setShowMemberPanel(n.showMemberPanel)
  setShowPinsPanel(n.showPinsPanel)   // 목록은 ChatPinsPanel 이 열릴 때 조회
  setThreadListOpen(n.threadListOpen)
  if (n.membersOpen !== chatUiStore.getState().membersOpen) setMembersOpen(n.membersOpen)
}

const HB = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-ring'
const hbCls = (on: boolean) => cn(HB, on ? 'bg-overlay-selected text-foreground' : 'text-muted-foreground hover:bg-overlay-hover hover:text-foreground')

/** 대화 헤더 */
export function ChatHeader({ onBack, onOpenChannels, className, tabs, tab, onTab, onForumView, onManageTabs }: ChatHeaderProps) {
  const { t } = useI18n()
  const chat = useChat()
  const { dmPartner } = useChatUi()
  const ch = chat.selectedChannel
  const members = chat.members
  const callStates = chat.callStates
  const totalMentions = chat.totalMentions
  const searchExpanded = useChatSearchExpanded()
  // 오른쪽 자리(구독 — 버튼 aria-pressed)
  useStore(chatUiStore, s => s.threadListOpen + ':' + s.membersOpen + ':' + s.voiceTextOpen)
  useStore(chatStore, s => `${s.showSearchPanel}:${s.showMemberPanel}:${s.showPinsPanel}:${s.activeThreadId}`)
  useStore(viewportStore, s => s.width >= CHAT_MEMBERS_DOCK_MIN)
  useStore(voiceStore, s => s.channelId)
  const col = currentRightColumn()
  const onlineCount = useStore(chatStore, s => s.members.filter(m => presenceOf(m.user_id, s).state !== 'offline').length)

  const isDm = ch?.type === 'dm'
  const isForum = !!ch?.forum_board_id
  const myId = authStore.getState().user?.id
  const isOwner = !!ch && !isDm && !!myId && (members.find(m => m.user_id === myId)?.role === 'owner' || ch.created_by === myId)
  const callState = ch ? callStates[ch.id] : undefined
  const memberCount = ch?.member_count || members.length
  const displayName = ch ? (isDm ? chat.getDMDisplayName(ch) : ch.name) : ''
  const partner = dmPartner(ch)
  const presence = partner ? chat.presenceOf(partner.id) : null
  const presenceLine = (() => {
    const p = presence
    if (!p) return ''
    if (p.text) return `${p.emoji ? p.emoji + ' ' : ''}${p.text}`
    return t(`ui.status.${p.state}`)
  })()
  const topic = isDm ? presenceLine : (ch?.description || '')

  // ‹ 옆 숫자 — 현재 채널을 제외한 본인 멘션 + DM 합계
  const otherMentions = Math.max(0, totalMentions - (ch ? channelMentionCount(ch) : 0))
  const backLabel = otherMentions > 0
    ? t('chat.header.backToListMentions', { n: otherMentions })
    : t('chat.header.backToList')

  const callLabel = callState ? t('chat.header.callJoin', { n: callState.count }) : t('chat.shell.header.call')

  // 드롭인 통화 — 채널 전용 LiveKit 방. 동일 탭의 회의 화면으로 열며, 채팅으로 복귀하면 미니 통화 창이 통화를 유지한다.
  function startCall() {
    if (!ch) return
    openRoom(`chan-${ch.id}`)
  }

  const LEVEL_LABEL = { all: t('chat.notify.all'), mentions: t('chat.notify.mentions'), none: t('chat.notify.none') }
  const level = ch?.muted ? 'none' : (ch?.notify_level || (isDm ? 'all' : 'mentions'))
  function menuItems(mobile: boolean): UiMenuItem[] {
    return [
      ...(mobile ? [{ key: 'call', label: callLabel, icon: 'audio-lines' }] : []),
      { key: 'notify', label: t('chat.header.notify'), hint: LEVEL_LABEL[level as 'all' | 'mentions' | 'none'] },
      ...(mobile ? [{ key: 'pins', label: t('chat.header.pins'), icon: 'pin' }] : []),
      ...(onManageTabs ? [{ key: 'tabs', label: t('chat.tabs.manage') }] : []),
      ...(!isDm ? [{ key: 'leave', label: t('chat.members.leaveChannel'), icon: 'log-out', separated: true }] : []),
      // 채널 소유자만 가능(DM 제외) — 이전에는 삭제 경로가 없어 나가면 고아 채널이 남았음
      ...(isOwner ? [{ key: 'delete', label: t('chat.header.deleteChannel'), icon: 'trash', danger: true, separated: isDm }] : []),
    ]
  }
  async function onDelete() {
    if (!ch) return
    if (!await confirmBox(t('chat.header.deleteConfirm', { name: displayName }), { danger: true, confirmLabel: t('common.delete') })) return
    try {
      await deleteChannel(ch.id)
      addToast('success', t('chat.header.deleted'))
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('chat.header.deleteFail'))
    }
  }
  async function onLeave() {
    if (!ch) return
    if (!await confirmBox(t('chat.members.leaveConfirm'))) return
    await leaveChannel(ch.id)
  }
  function onMenu(id: string) {
    if (id === 'delete') void onDelete()
    else if (id === 'leave') void onLeave()
    else if (id === 'notify' && ch) setNotifySheetChannelId(ch.id)
    else if (id === 'tabs') onManageTabs?.()
    else if (id === 'pins') openChatPanel('pins')
    else if (id === 'call') startCall()
  }

  if (!ch) return null

  const icon = isDm
    ? null
    : ch.type === 'private' ? 'lock' : ch.is_voice ? 'volume-2' : isForum ? 'messages-square' : 'hash'
  const membersPressed = col === 'members'

  return (
    <header className={cn('flex shrink-0 items-center border-b border-border bg-background', 'h-14 gap-0.5 px-1 md:h-[49px] md:gap-2 md:pl-4 md:pr-2', className)}>
      {/* ── 모바일 ── */}
      <button
        type="button"
        className="inline-flex h-11 shrink-0 items-center rounded-md pl-1 pr-1.5 text-foreground hover:bg-overlay-hover md:hidden"
        aria-label={backLabel}
        onClick={() => onBack?.()}
      >
        <UiIcon name="chevron-left" className="h-6 w-6" />
        {otherMentions > 0 && (
          <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1.5 font-mono text-xs font-bold text-primary-foreground" aria-hidden="true">
            {otherMentions > 99 ? '99+' : otherMentions}
          </span>
        )}
      </button>
      <button
        type="button"
        className="min-h-11 min-w-0 flex-1 pl-1 text-left leading-tight md:hidden"
        aria-label={t('chat.header.openInfo')}
        onClick={() => openChatPanel('members')}
      >
        <span className="flex items-center gap-1 text-[17px] font-semibold text-foreground">
          {icon && <UiIcon name={icon} className="h-[18px] w-[18px] shrink-0 text-muted-foreground" />}
          <span className="truncate">{displayName}</span>
        </span>
        <span className="block truncate text-[12px] text-muted-foreground">
          {isDm ? presenceLine : t('chat.shell.header.membersLine', { n: memberCount, online: onlineCount })}
        </span>
      </button>
      <div className="flex shrink-0 items-center md:hidden">
        {!isDm && <UiIconButton icon="threads" label={t('chat.shell.header.threads')} size="lg" pressed={col === 'threads'} onClick={() => openChatPanel('threads')} />}
        <UiIconButton icon="users" label={t('chat.shell.header.members')} size="lg" pressed={col === 'members'} onClick={() => openChatPanel('members')} />
        <UiMenu
          items={menuItems(true)}
          label={t('chat.header.menu')}
          onSelect={onMenu}
          trigger={({ toggle, open, controls }) => (
            <UiIconButton label={t('chat.header.menuLabel')} icon="more-horizontal" size="lg" aria-haspopup="menu" aria-expanded={open} aria-controls={controls} onClick={toggle} />
          )}
        />
      </div>

      {/* ── 데스크톱 ── */}
      {onOpenChannels && <UiIconButton icon="menu" label={t('chat.header.channelList')} className="-ml-2 hidden shrink-0 md:inline-flex" onClick={onOpenChannels} />}
      <span className="hidden shrink-0 text-muted-foreground md:inline-flex" aria-hidden="true">
        {isDm
          ? (presence ? <UiStatusDot status={presence.state} size={10} /> : <UiIcon name="at-sign" className="h-5 w-5" />)
          : <UiIcon name={icon!} className="h-5 w-5" />}
      </span>
      <UiMenu
        className="hidden min-w-0 shrink md:block"
        items={menuItems(false)}
        label={t('chat.header.menu')}
        onSelect={onMenu}
        align="start"
        sheet={false}
        trigger={({ toggle, open, controls }) => (
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={controls}
            aria-label={t('chat.shell.header.channelMenu', { name: displayName })}
            className="flex min-w-0 max-w-full items-center rounded-md px-1 py-0.5 hover:bg-overlay-hover focus-visible:outline-2 focus-visible:outline-ring"
            onClick={toggle}
          >
            <h1 className="truncate text-[16px] font-semibold text-foreground">{displayName}</h1>
          </button>
        )}
      />
      {topic && <span className="hidden h-5 w-px shrink-0 bg-border md:block" aria-hidden="true" />}
      <p className="hidden min-w-0 flex-1 truncate text-[13px] text-muted-foreground md:block" title={topic || undefined}>{topic}</p>

      <div className="hidden shrink-0 items-center gap-2 md:flex">
        {!searchExpanded && isForum && onForumView && (
          <>
            {/* 보기 전환은 RIGHT 의 ForumViewToggle(사용자별 보존 — useChatForum) */}
            <ForumViewToggle />
            <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
          </>
        )}
        {!searchExpanded && !isForum && tabs && tabs.length > 1 && onTab && (
          <>
            <UiSegment ariaLabel={t('chat.tabs.label')} size="sm" items={tabs} modelValue={tab ?? 'messages'} onUpdateModelValue={v => { if (v != null) onTab(String(v)) }} />
            <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
          </>
        )}
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label={callLabel}
            title={callLabel}
            className={cn(HB, callState ? 'w-auto gap-1 bg-success/15 px-2 text-success hover:bg-success/25' : 'text-muted-foreground hover:bg-overlay-hover hover:text-foreground')}
            onClick={startCall}
          >
            <UiIcon name="audio-lines" className="h-5 w-5" />
            {callState && <span className="font-mono text-xs font-medium">{callState.count}</span>}
          </button>
          {!isDm && (
            <button type="button" aria-label={t('chat.shell.header.threads')} title={t('chat.shell.header.threads')} aria-pressed={col === 'threads'} className={hbCls(col === 'threads')} onClick={() => openChatPanel('threads')}>
              <UiIcon name="threads" className="h-5 w-5" />
            </button>
          )}
          <button type="button" aria-label={t('chat.header.pins')} title={t('chat.header.pins')} aria-pressed={col === 'pins'} className={hbCls(col === 'pins')} onClick={() => openChatPanel('pins')}>
            <UiIcon name="pin" className="h-5 w-5" />
          </button>
          <button
            type="button"
            aria-label={membersPressed ? t('chat.shell.header.membersClose') : t('chat.shell.header.membersOpen')}
            title={membersPressed ? t('chat.shell.header.membersClose') : t('chat.shell.header.membersOpen')}
            aria-pressed={membersPressed}
            className={hbCls(membersPressed)}
            onClick={() => openChatPanel('members')}
          >
            <UiIcon name="users" className="h-5 w-5" />
          </button>
        </div>
        <ChatSearchBox className="ml-1" />
      </div>
    </header>
  )
}

export default ChatHeader
