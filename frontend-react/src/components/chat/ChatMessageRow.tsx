/**
 * 메시지 행 틀(handover-22 "메시지" · Chat22 #cozy #compact #hover #focus #reply #jump · Mob22 #m-conv · 디스코드 수치) — ChatMessage 공용.
 *  cozy   : 본문 16/22 · 이름 16/22·500·역할 색 · 시간 12 mono "오전 10:02" · 아바타 40(left 16) · 들여쓰기 72 · 그룹 첫 줄 최소 44 ·
 *           연속 줄 패딩 2 · 연속 줄 시간 = 거터 56 오른쪽 정렬 11 mono(호버·포커스 때만) · 그룹 시작 margin-top = groupGap + 1(투명 1px 위 테두리)
 *  compact: 패딩 2 · 시간 칸 68(24시간 표기면 50) · 들여쓰기 80 · 이름은 본문 앞 인라인 · 그룹 시작 4 + 1
 *  mobile : 16/22 · 아바타 36(left 12) · 들여쓰기 60 · 그룹 시작 12 + 1
 * 덧칠(유틸): 호버·포커스 bg-overlay-hover · 선택(스레드 열림·수정 중·시트) bg-overlay-selected · 나를 부른 줄 bg-overlay-mention ·
 *            점프 강조 bg-overlay-jump(2초 유지 후 1초 사라짐, reduce-motion 이면 2초 뒤 바로 — useChatJump).
 * 포커스 표시는 outline(덧칠 유틸이 box-shadow 를 쓰므로 ring 과 섞지 않는다). 이름·아바타 누르면 프로필 팝아웃.
 * 답장 메시지는 본문 위에 답장 미리보기 한 줄(ChatReplyPreview). @silent 로 보낸 줄은 시간 뒤 bell-off.
 */
import { forwardRef, type ReactNode, type HTMLAttributes, type MouseEvent } from 'react'
import { useStore } from 'zustand'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import type { ChatMessage } from '~/composables/useChat'
import { anchorOf, chatClock, chatClockAmPm, initialOf, setProfilePopout } from '~/composables/useChatUi'
import { roleTextClass, useChatRoles, userRoleColor } from '~/composables/useChatRoles'
import { chatJumpStore } from '~/composables/useChatJump'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiIcon } from '~/components/ui/Icon'
import { ChatReplyPreview } from './ChatReplyPreview'

export type ChatRowDisplay = 'cozy' | 'compact' | 'mobile'

/** compact 시간 칸 — 12시간(오전/오후) 68 · 24시간 50 */
export function compactTimeWidth(hour12: boolean): number { return hour12 ? 68 : 50 }
/** 그룹 시작 위 여백(px, 투명 테두리 1 은 따로) */
export function groupStartGap(display: ChatRowDisplay, gap: number): number {
  return display === 'compact' ? 4 : display === 'mobile' ? 12 : gap
}

export interface ChatMessageRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  message: ChatMessage
  /** 묶음의 이어지는 줄 */
  grouped: boolean
  isOwn: boolean
  display: ChatRowDisplay
  /** 묶음 첫 줄 위 간격(px, cozy) — 설정 0/4/8/16/24 */
  gap?: number
  /** 나·내 역할·채널 전원을 부른 줄 · 나에게 온 답장(@ 켬) */
  mention?: boolean
  /** 선택(스레드 열림·수정 중·시트 열림) */
  selected?: boolean
  /** 호버·포커스 중(거터 시간·호버 바) */
  lit?: boolean
  /** 전송 대기 같은 가짜 행 — 시간 숨김 */
  pending?: boolean
  /** 본문. lead = compact 에서 본문 첫 줄 앞에 붙일 이름(다른 모양에서는 null) */
  body: (lead: ReactNode | null) => ReactNode
  /** 본문 아래(첨부·링크 카드·리액션·스레드 칩·실패 줄) */
  extra?: ReactNode
  /** 행 위에 뜨는 것(호버 바·읽음 표시) */
  overlay?: ReactNode
  /** 스레드 패널 맨 위 원문 등 — 답장 미리보기 숨김 */
  hideReply?: boolean
}

export const ChatMessageRow = forwardRef<HTMLDivElement, ChatMessageRowProps>(function ChatMessageRow({
  message, grouped, isOwn, display, gap = 16, mention = false, selected = false, lit = false, pending = false,
  body, extra, overlay, hideReply = false, className, style, ...rest
}, ref) {
  const { t, locale } = useI18n()
  const lang = locale === 'en' ? 'en-US' : 'ko-KR'
  const name = message.sender?.display_name || message.sender?.username || ''
  const senderId = message.sender?.id || ''
  const color = useChatRoles(s => (senderId ? userRoleColor(senderId, s) : null))
  const roleCls = roleTextClass(color)
  const jump = useStore(chatJumpStore, s => (s.id === message.id ? s.phase : null))
  const first = !grouped
  const hm = chatClock(message.created_at)
  const ampm = chatClockAmPm(message.created_at, lang)
  const full = new Date(message.created_at).toLocaleString(lang, { dateStyle: 'full', timeStyle: 'short' })
  const mobile = display === 'mobile'
  const compact = display === 'compact'
  const showReply = !hideReply && !pending && !!(message.reply_to || message.reply_to_id)

  function openProfile(e: MouseEvent<HTMLElement>) {
    e.stopPropagation()
    if (senderId) setProfilePopout({ userId: senderId, anchor: anchorOf(e.currentTarget) })
  }

  const bg = mention ? 'bg-overlay-mention' : selected ? 'bg-overlay-selected' : lit ? 'bg-overlay-hover' : (mobile ? '' : 'hover:bg-overlay-hover')
  const focus = 'outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring'

  const silent = message.silent && (
    <span title={t('chat.msg.row.silent')} aria-label={t('chat.msg.row.silent')} role="img" className="self-center text-muted-foreground">
      <UiIcon name="bell-off" className="h-3.5 w-3.5" />
    </span>
  )
  const meChip = isOwn && <span className="rounded bg-muted px-1 text-[11px] font-medium text-muted-foreground">{t('chat.message.me')}</span>
  const nameBtn = (cls: string) => (
    <button type="button" className={cn('min-w-0 truncate text-left hover:underline', roleCls, cls)} onClick={openProfile}>{name}</button>
  )
  const time = (cls: string, label: string) => (
    <time dateTime={message.created_at} title={full} className={cls}>{label}</time>
  )

  const jumpOverlay = jump && (
    <span
      aria-hidden="true"
      data-jump-highlight={jump}
      className={cn('pointer-events-none absolute inset-0 bg-overlay-jump transition-opacity duration-1000 ease-out motion-reduce:transition-none', jump === 'fade' ? 'opacity-0' : 'opacity-100')}
    />
  )

  const outer = cn('group relative flex flex-col', mobile ? 'select-none' : '', first ? 'border-t border-transparent' : '', bg, focus, className)
  const outerStyle = { ...(first ? { marginTop: groupStartGap(display, gap) } : null), ...style }

  if (compact) {
    const lead = (
      <span className="mr-2 inline-flex items-baseline gap-1">
        {nameBtn('font-medium')}{meChip}{silent}
      </span>
    )
    return (
      <div ref={ref} role="article" tabIndex={0} data-message-id={message.id} className={cn(outer, 'pr-4')} style={outerStyle} {...rest}>
        {jumpOverlay}
        {showReply && <ChatReplyPreview message={message} display={display} />}
        <div className="relative flex py-0.5">
          <div className="shrink-0 pl-2" style={{ width: 80 }}>
            {!pending && time('block text-right font-mono text-[12px] leading-[22px] text-muted-foreground', ampm)}
          </div>
          <div className="min-w-0 flex-1">
            {body(lead)}
            {extra}
          </div>
        </div>
        {overlay}
      </div>
    )
  }

  const gutter = mobile ? 60 : 72
  const avatarLeft = mobile ? 12 : 16
  return (
    <div ref={ref} role="article" tabIndex={mobile ? -1 : 0} data-message-id={message.id} className={cn(outer, mobile ? 'pr-3' : 'pr-4')} style={outerStyle} {...rest}>
      {jumpOverlay}
      {showReply && <ChatReplyPreview message={message} display={display} />}
      <div className="relative flex py-0.5">
        {first
          ? (
            <div className="relative shrink-0" style={{ width: gutter, minHeight: 44 }}>
              <button type="button" tabIndex={-1} aria-hidden="true" className="absolute top-0.5 rounded-full" style={{ left: avatarLeft }} onClick={openProfile}>
                <UiAvatar
                  src={message.sender?.avatar_url}
                  alt={name}
                  fallback={initialOf(name)}
                  textSize={mobile ? 13 : 14}
                  className={cn(mobile ? 'h-9 w-9' : 'h-10 w-10', !message.sender?.avatar_url && isOwn ? 'bg-primary/20 text-primary' : '')}
                />
              </button>
            </div>
          )
          : (
            <div className="shrink-0 pr-4 text-right" style={{ width: gutter }}>
              {!pending && !mobile && time(cn('font-mono text-[11px] leading-[22px] text-muted-foreground', lit ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'), hm)}
            </div>
          )}
        <div className="min-w-0 flex-1">
          {first && (
            <p className="flex min-w-0 items-baseline gap-2 leading-[22px]">
              {nameBtn('text-[16px] font-medium')}
              {meChip}
              {!pending && time('shrink-0 font-mono text-[12px] text-muted-foreground', ampm)}
              {silent}
            </p>
          )}
          {body(null)}
          {!first && silent && <span className="sr-only">{t('chat.msg.row.silent')}</span>}
          {extra}
        </div>
      </div>
      {overlay}
    </div>
  )
})

export default ChatMessageRow
