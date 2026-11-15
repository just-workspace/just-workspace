/**
 * 메시지 한 줄(텍스트 · 첨부 공용). Vue 원본: frontend/components/chat/ChatMessage.vue
 * 행 틀 = ChatMessageRow(cozy · compact · mobile), 본문 = ChatMarkdown, 첨부 = ChatAttachmentGrid(+ 이미지 보기 ChatImageViewer).
 *  · 나·내 역할·@everyone 멘션, 또는 나에게 온 답장(reply_to.sender = 나 && reply_ping) → bg-overlay-mention
 *  · 데스크톱: 호버·키보드 포커스 바(ChatMessageActions) · 단축키(호버·포커스 중) R 답장 · T 스레드 · S 저장 · E 수정
 *    · Alt+클릭 = 여기부터 안 읽음(새 메시지 선이 그 줄 위로 + 토스트)
 *  · 모바일: 길게 누르기 = 시트(ChatMessageSheet) · 왼쪽으로 밀기 = 답장(§2.2(3))
 *  · 수정은 컴포저에서(컴포저 위 "메시지 수정 중" 띠) — 여기서는 요청만.
 */
import { memo, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type TouchEvent as ReactTouchEvent } from 'react'
import { useStore } from 'zustand'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { authStore } from '~/composables/useAuth'
import { chatStore, selectSelectedChannel, type ChatMessage as ChatMessageT } from '~/composables/useChat'
import { chatUiStore, setEditRequest } from '~/composables/useChatUi'
import { useChatDisplay } from '~/composables/useChatDisplay'
import { chatRolesStore } from '~/composables/useChatRoles'
import { userPrefsStore } from '~/composables/useUserPrefs'
import { mentionsMe } from '~/utils/chatMarkdown'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiIcon } from '~/components/ui/Icon'
import { ChatReactions } from './ChatReactions'
import { ChatThreadSummary } from './ChatThreadSummary'
import { ChatMessageActions, markUnreadHere, useMessageActionRunner } from './ChatMessageActions'
import { ChatMessageSheet } from './ChatMessageSheet'
import { ChatLinkPreview } from './ChatLinkPreview'
import { ChatMessageRow } from './ChatMessageRow'
import { ChatMarkdown } from './ChatMarkdown'
import { ChatAttachmentGrid, downloadAttachment, messageAttachments, type ViewAttachment } from './ChatAttachmentGrid'
import { ChatImageViewer } from './ChatImageViewer'

export interface ChatMessageProps {
  message: ChatMessageT
  /** 앞 메시지와 묶음(아바타·이름 생략) */
  grouped: boolean
  isOwn: boolean
  /** 묶음의 마지막 — 읽음 표시 */
  isLastInGroup?: boolean
  /** 스레드 패널 안 */
  inThread?: boolean
  /** 전송 대기 같은 가짜 메시지 — 액션 없음 */
  readonlyRow?: boolean
  /** 스레드 패널 맨 위 원 메시지 */
  root?: boolean
  /** 스레드 열기(메시지 id) */
  onOpenThread?: (messageId: string) => void
  /** 본문 아래 줄(전송 대기 · 보내기 실패) */
  footer?: ReactNode
  /** 본문 글자를 흐리게(보내기 실패) */
  dimBody?: boolean
}

function isTyping(el: EventTarget | null) {
  const n = el as HTMLElement | null
  return !!n && (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.isContentEditable)
}

/** 이 줄을 강조(멘션·답장받음)할지 — 순수 */
export function callsMeRow(
  m: Pick<ChatMessageT, 'content' | 'reply_to' | 'reply_ping'>,
  me: { id?: string | null; username?: string | null },
  roleKeys: readonly string[],
): boolean {
  if (me.id && m.reply_ping !== false && m.reply_to?.state === 'ok' && m.reply_to.sender?.id === me.id) return true
  return mentionsMe(m.content, me.username, roleKeys)
}

const SWIPE_REPLY = 60

/** 메시지 행 */
export const ChatMessage = memo(function ChatMessage({
  message, grouped, isOwn, isLastInGroup = false, inThread = false, readonlyRow = false, root = false, onOpenThread, footer, dimBody = false,
}: ChatMessageProps) {
  const { t } = useI18n()
  const myId = useStore(authStore, s => s.user?.id)
  const myUsername = useStore(authStore, s => s.user?.username)
  const showLinkPreview = useStore(userPrefsStore, s => s.prefs.chatLinkPreview)
  const threadOpen = useStore(chatStore, s => !inThread && s.activeThreadId === message.id)
  const channelName = useStore(chatStore, s => selectSelectedChannel(s)?.name ?? null)
  const editingThis = useStore(chatUiStore, s => s.editingMessageId === message.id)
  const myRoleIds = useStore(chatRolesStore, s => (myId ? s.userRoles[myId] : undefined))
  const roles = useStore(chatRolesStore, s => s.roles)
  const roleKeys = useMemo(
    () => roles.filter(r => myRoleIds?.includes(r.id) && r.mention).map(r => r.mention!.toLowerCase()),
    [roles, myRoleIds],
  )
  const { display, gap } = useChatDisplay()
  const mobile = display === 'mobile'

  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [held, setHeld] = useState(false)
  const lit = hovered || focused || held
  const [sheetOpen, setSheetOpen] = useState(false)
  const [viewer, setViewer] = useState<{ images: ViewAttachment[]; index: number } | null>(null)
  const rowRef = useRef<HTMLDivElement | null>(null)

  const atts = messageAttachments(message)
  const isFile = message.message_type === 'file' || atts.length > 0 || !!message._upload
  const onlyFileName = isFile && atts.length === 1 && message.content === atts[0].filename
  const text = onlyFileName ? '' : message.content
  const mention = !isOwn && !readonlyRow && callsMeRow(message, { id: myId, username: myUsername }, roleKeys)
  const canDownload = atts.length > 0 && !message._upload

  const readReceipts = isLastInGroup ? message.read_by || [] : []
  const visibleReaders = readReceipts.slice(0, 5)
  const extraReaderCount = Math.max(0, readReceipts.length - 5)

  function startEdit() {
    if (!isOwn || isFile) return
    setEditRequest(message.id)
  }
  function onDownload() { if (atts[0]) void downloadAttachment(atts[0]) }
  const { run } = useMessageActionRunner({ message, isOwn, inThread, onOpenThread, onEdit: startEdit, onDownload })

  // ─── 호버·포커스 중인 메시지 단축키(R 답장 · T 스레드 · S 저장 · E 수정) ───
  const L = useRef({ lit, readonlyRow, inThread, isOwn, run })
  L.current = { lit, readonlyRow, inThread, isOwn, run }
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const c = L.current
      if (!c.lit || c.readonlyRow || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return
      const k = e.key.toLowerCase()
      if (k === 't' && !c.inThread) { e.preventDefault(); void c.run('threadReply') }
      else if (k === 'r') { e.preventDefault(); void c.run('reply') }
      else if (k === 's') { e.preventDefault(); void c.run('save') }
      else if (k === 'e' && c.isOwn) { e.preventDefault(); void c.run('edit') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ─── 모바일: 길게 누르기 → 시트, 왼쪽으로 밀기 → 답장 ───
  // 시트(포털) 안 터치도 React 트리를 따라 이 행까지 올라온다 — 행 DOM 안에서 시작한 것만 센다.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touch0 = useRef<{ x: number; y: number; swiping: boolean } | null>(null)
  const [swipeX, setSwipeX] = useState(0)
  const inRow = (e: { target: EventTarget }) => !!rowRef.current?.contains(e.target as Node)
  function cancelPress() { if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null } }
  function onTouchStart(e: ReactTouchEvent) {
    if (!inRow(e) || readonlyRow) return
    const p = e.touches?.[0]
    touch0.current = { x: p?.clientX ?? 0, y: p?.clientY ?? 0, swiping: false }
    pressTimer.current = setTimeout(() => { setSheetOpen(true); pressTimer.current = null; touch0.current = null }, 500)
  }
  function onTouchMove(e: ReactTouchEvent) {
    const t0 = touch0.current
    if (!t0) { cancelPress(); return }
    const p = e.touches?.[0]
    if (!p) return
    const dx = p.clientX - t0.x
    const dy = p.clientY - t0.y
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) cancelPress()
    if (!t0.swiping && dx < -12 && Math.abs(dx) > Math.abs(dy) * 1.5) t0.swiping = true
    if (t0.swiping) setSwipeX(Math.max(-80, Math.min(0, dx)))
  }
  function onTouchEnd() {
    cancelPress()
    const t0 = touch0.current
    touch0.current = null
    if (t0?.swiping && swipeX <= -SWIPE_REPLY) void run('reply')
    setSwipeX(0)
  }
  useEffect(() => () => cancelPress(), [])

  function onRowClick(e: ReactMouseEvent<HTMLDivElement>) {
    if (!e.altKey || readonlyRow || inThread) return
    e.preventDefault()
    void markUnreadHere(message, t).catch(() => {})
  }

  const edited = message.is_edited ? <span className="text-[11px] text-muted-foreground">{t('chat.message.edited')}</span> : null
  const body = (lead: ReactNode | null) => (
    text || lead || edited
      ? <ChatMarkdown content={text} lead={lead} tail={edited} className={cn('chat-body', readonlyRow || dimBody ? 'text-muted-foreground' : 'text-foreground')} />
      : null
  )

  const extra = (
    <>
      {isFile && <ChatAttachmentGrid message={message} onOpenImage={(images, index) => setViewer({ images, index })} />}
      {showLinkPreview && message.link_preview && (
        <ChatLinkPreview messageId={message.id} preview={message.link_preview} canDismiss={isOwn && !readonlyRow} />
      )}
      {message.reactions && message.reactions.length > 0 && (
        <ChatReactions reactions={message.reactions} messageId={message.id} className="mt-1" />
      )}
      {!inThread && (message.reply_count > 0 || !!message.thread) && (
        <ChatThreadSummary message={message} onOpen={() => onOpenThread?.(message.id)} />
      )}
      {footer}
    </>
  )

  const overlay = (
    <>
      {visibleReaders.length > 0 && (
        <div className="absolute bottom-0.5 right-3 flex -space-x-1" title={readReceipts.map(r => r.display_name || r.username).join(', ')}>
          {visibleReaders.map(reader => (
            <UiAvatar
              key={reader.id}
              src={reader.avatar_url}
              alt={reader.display_name || reader.username}
              fallback={(reader.display_name || reader.username || '?').charAt(0).toUpperCase()}
              className="h-4 w-4 text-[8px] ring-1 ring-background"
            />
          ))}
          {extraReaderCount > 0 && <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-0.5 text-[8px] text-muted-foreground ring-1 ring-background">+{extraReaderCount}</span>}
        </div>
      )}
      {!readonlyRow && !message._upload && !mobile && (
        <ChatMessageActions
          message={message}
          isOwn={isOwn}
          visible={lit}
          inThread={inThread}
          canEdit={!isFile}
          canDownload={canDownload}
          onHold={setHeld}
          onOpenThread={onOpenThread}
          onEdit={startEdit}
          onDownload={onDownload}
        />
      )}
      {swipeX < 0 && (
        <span aria-hidden="true" className={cn('absolute right-3 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full', swipeX <= -SWIPE_REPLY ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
          <UiIcon name="reply" className="h-4 w-4" />
        </span>
      )}
    </>
  )

  return (
    <>
      <ChatMessageRow
        ref={rowRef}
        message={message}
        grouped={grouped && !root}
        isOwn={isOwn}
        display={display}
        gap={root ? 12 : gap}
        mention={mention}
        selected={threadOpen || editingThis || sheetOpen}
        lit={lit}
        pending={readonlyRow}
        hideReply={root}
        body={body}
        extra={extra}
        overlay={overlay}
        className={root ? 'pb-3' : undefined}
        style={swipeX ? { transform: `translateX(${swipeX}px)` } : undefined}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false) }}
        onClick={onRowClick}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchMove={onTouchMove}
        onContextMenu={(e) => { if (sheetOpen) e.preventDefault() }}
      />
      {sheetOpen && (
        <ChatMessageSheet
          message={message}
          isOwn={isOwn}
          inThread={inThread}
          canEdit={!isFile}
          canDownload={canDownload}
          canDismissPreview={showLinkPreview && !!message.link_preview}
          onClose={() => setSheetOpen(false)}
          onOpenThread={onOpenThread}
          onEdit={startEdit}
          onDownload={onDownload}
        />
      )}
      {viewer && (
        <ChatImageViewer
          images={viewer.images}
          index={viewer.index}
          onIndex={i => setViewer(v => (v ? { ...v, index: i } : v))}
          onClose={() => setViewer(null)}
          sender={message.sender}
          createdAt={message.created_at}
          channelName={channelName}
        />
      )}
    </>
  )
})

export default ChatMessage
