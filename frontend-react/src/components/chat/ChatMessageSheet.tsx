/**
 * 모바일 메시지 메뉴 — 길게 누르기 하단 시트(handover-22 · Mob22 #m-menu · handover-21 #m-menu).
 * 원문 한 줄 → 리액션 6(최근 5 + "더 보기" = 이모지 피커 시트) → 답장 · 스레드로 답장 · 저장 · 여기부터 안 읽음으로 · 텍스트 복사 · 메시지 링크 복사
 * → (그 밖: 수정 · 미리보기 지우기 · 고정 · 다운로드 · 삭제) → 아래 안내 "메시지를 왼쪽으로 밀어도 답장합니다". 행 48 · 터치 48.
 */
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from 'zustand'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { chatStore, isSaved, type ChatMessage } from '~/composables/useChat'
import { chatClock, setEmojiPicker } from '~/composables/useChatUi'
import { userPrefsStore } from '~/composables/useUserPrefs'
import { stripChatMarkdown } from '~/utils/chatMarkdown'
import { UiIcon } from '~/components/ui/Icon'
import { ReactionGlyph } from './ChatReactions'
import { quickReactions, useMessageActionRunner, type MessageActionKey } from './ChatMessageActions'

export interface ChatMessageSheetProps {
  message: ChatMessage
  isOwn: boolean
  inThread?: boolean
  canEdit?: boolean
  canDownload?: boolean
  canDismissPreview?: boolean
  onClose: () => void
  onOpenThread?: (messageId: string) => void
  onEdit?: () => void
  onDownload?: () => void
}

interface Row { key: MessageActionKey; label: string; icon: string; danger?: boolean }

export function ChatMessageSheet({ message, isOwn, inThread = false, canEdit = false, canDownload = false, canDismissPreview = false, onClose, onOpenThread, onEdit, onDownload }: ChatMessageSheetProps) {
  const { t } = useI18n()
  const saved = useStore(chatStore, s => isSaved(message.id, s))
  const recent = useStore(userPrefsStore, s => s.prefs.chatEmojiRecent)
  const { run, react, canDelete, canPin } = useMessageActionRunner({ message, isOwn, inThread, onOpenThread, onEdit, onDownload })
  const sheetRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    sheetRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const name = message.sender?.display_name || message.sender?.username || ''

  const main: Row[] = [
    { key: 'reply', label: t('chat.msg.actions.reply'), icon: 'reply' },
    ...(inThread ? [] : [{ key: 'threadReply' as const, label: t('chat.message.threadReply'), icon: 'threads' }]),
    { key: 'save', label: saved ? t('chat.message.unsave') : t('chat.message.save'), icon: 'bookmark' },
    ...(inThread ? [] : [{ key: 'unread' as const, label: t('chat.message.markUnreadHere'), icon: 'mail-unread' }]),
    { key: 'copyText', label: t('chat.message.copyText'), icon: 'copy' },
    { key: 'link', label: t('chat.message.copyMessageLink'), icon: 'link' },
  ]
  const rest: Row[] = [
    ...(isOwn && canEdit ? [{ key: 'edit' as const, label: t('common.edit'), icon: 'edit-3' }] : []),
    ...(isOwn && canDismissPreview ? [{ key: 'dismissPreview' as const, label: t('chat.message.removePreview'), icon: 'close' }] : []),
    ...(!inThread && !message.thread && !(message.reply_count > 0) ? [{ key: 'startThread' as const, label: t('chat.msg.actions.startThread'), icon: 'messages-square' }] : []),
    ...(canPin ? [{ key: 'pin' as const, label: message.pinned_at ? t('chat.message.unpin') : t('chat.message.pin'), icon: 'pin' }] : []),
    ...(canDownload ? [{ key: 'download' as const, label: t('common.download'), icon: 'download' }] : []),
    ...(canDelete ? [{ key: 'delete' as const, label: t('common.delete'), icon: 'trash', danger: true }] : []),
  ]

  const row = (r: Row) => (
    <button
      key={r.key}
      type="button"
      className={cn('flex h-12 w-full items-center gap-3 border-b border-border px-4 text-left text-[16px] last:border-b-0', r.danger ? 'text-danger' : 'text-foreground')}
      onClick={() => { onClose(); void run(r.key) }}
    >
      <UiIcon name={r.icon} className={cn('h-5 w-5', r.danger ? 'text-danger' : 'text-muted-foreground')} />
      {r.label}
    </button>
  )

  return createPortal(
    <div className="fixed inset-0 z-modal">
      <div className="absolute inset-0 bg-scrim/60" aria-hidden="true" onClick={onClose} />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('chat.message.sheetTitle')}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col gap-3 overflow-y-auto rounded-t-sheet border-t border-border bg-popover px-3 pt-2 shadow-xl outline-none"
        style={{ paddingBottom: 'calc(2rem + env(safe-area-inset-bottom))' }}
      >
        <span className="mx-auto h-1 w-10 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden="true" />
        <div className="rounded-lg bg-card px-3 py-2 text-[14px]">
          <p className="truncate"><b className="font-semibold">{name}</b> <span className="font-mono text-[12px] text-muted-foreground">{chatClock(message.created_at)}</span></p>
          <p className="truncate text-muted-foreground">{stripChatMarkdown(message.content) || t('chat.msg.reply.att.file')}</p>
        </div>
        <div className="flex justify-between" role="group" aria-label={t('chat.message.addReaction')}>
          {quickReactions(recent, 5).map(e => (
            <button key={e} type="button" aria-label={t('chat.message.quickReact', { emoji: e })} className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-[22px]" onClick={() => { react(e); onClose() }}>
              <ReactionGlyph emoji={e} className="h-6 w-6" />
            </button>
          ))}
          <button
            type="button"
            aria-label={t('chat.message.otherReaction')}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-[22px]"
            onClick={() => { onClose(); setEmojiPicker({ mode: 'react', messageId: message.id }) }}
          >+</button>
        </div>
        <div className="flex flex-col overflow-hidden rounded-lg bg-card">{main.map(row)}</div>
        {rest.length > 0 && <div className="flex flex-col overflow-hidden rounded-lg bg-card">{rest.map(row)}</div>}
        <p className="text-center text-[12px] text-muted-foreground">{t('chat.msg.sheet.swipeHint')}</p>
      </div>
    </div>,
    document.body,
  )
}

export default ChatMessageSheet
