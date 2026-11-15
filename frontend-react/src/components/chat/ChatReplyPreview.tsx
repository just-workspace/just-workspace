/**
 * 답장 미리보기 — 본문 위 한 줄(handover-22 "답장 미리보기" · Chat22 #reply · Mob22 #m-reply · 디스코드 repliedMessage).
 * 높이 22, 글자 14/18. 아바타 16 · 이름 14/600 역할 색 · 요약 14 muted 말줄임(마크다운을 벗긴 글).
 * 연결선(spine): 1.5px border 색 · 거터 36(모바일 30)에서 시작 · 30×10(모바일 26×10) · 왼쪽 위 모서리 6.
 * 원문 상태 4가지: 첨부만 = 종류 아이콘 + "이미지/영상/음성/파일" · 삭제됨 = trash + 기울임 · 불러올 수 없음 = alert-circle · 권한 없음 = lock.
 * 누르면 원문으로 점프(useChatUi.jumpTo → useChatJump).
 */
import { memo } from 'react'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import type { ChatMessage, ReplyRef } from '~/composables/useChat'
import { initialOf, jumpTo } from '~/composables/useChatUi'
import { roleTextClass, useChatRoles, userRoleColor } from '~/composables/useChatRoles'
import { stripChatMarkdown } from '~/utils/chatMarkdown'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiIcon } from '~/components/ui/Icon'
import type { ChatRowDisplay } from './ChatMessageRow'

export type ReplyView =
  | { kind: 'ok'; name: string; text: string; icon: string | null; senderId: string | null; avatar: string | null }
  | { kind: 'deleted' | 'unavailable' | 'forbidden'; icon: string }

const ATT_ICON: Record<string, string> = { image: 'image', video: 'video', audio: 'music', file: 'file' }

/** 답장 원문 → 그릴 모양(순수 — 테스트). reply_to 가 없는데 reply_to_id 만 있으면(옛 서버·원문 못 읽음) unavailable */
export function replyView(msg: Pick<ChatMessage, 'reply_to' | 'reply_to_id'>): ReplyView | null {
  const r: ReplyRef | null | undefined = msg.reply_to
  if (!r) return msg.reply_to_id ? { kind: 'unavailable', icon: 'alert-circle' } : null
  if (r.state === 'deleted') return { kind: 'deleted', icon: 'trash' }
  if (r.state === 'forbidden') return { kind: 'forbidden', icon: 'lock' }
  if (r.state !== 'ok' || !r.sender) return { kind: 'unavailable', icon: 'alert-circle' }
  const text = stripChatMarkdown(r.content)
  const name = r.sender.display_name || r.sender.username
  const base = { kind: 'ok' as const, name, senderId: r.sender.id, avatar: r.sender.avatar_url }
  if (!text && (r.has_attachment || r.message_type === 'file')) {
    const k = r.attachment_kind || 'file'
    return { ...base, text: '', icon: ATT_ICON[k] || 'file' }
  }
  return { ...base, text, icon: null }
}

const STATE_KEY = { deleted: 'chat.msg.reply.deleted', unavailable: 'chat.msg.reply.unavailable', forbidden: 'chat.msg.reply.forbidden' } as const
const STATE_ARIA = { deleted: 'chat.msg.reply.deletedAria', unavailable: 'chat.msg.reply.unavailableAria', forbidden: 'chat.msg.reply.forbiddenAria' } as const

export interface ChatReplyPreviewProps {
  message: ChatMessage
  display: ChatRowDisplay
}

export const ChatReplyPreview = memo(function ChatReplyPreview({ message, display }: ChatReplyPreviewProps) {
  const { t } = useI18n()
  const v = replyView(message)
  const senderId = v?.kind === 'ok' ? v.senderId : null
  const color = useChatRoles(s => (senderId ? userRoleColor(senderId, s) : null))
  if (!v) return null
  const mobile = display === 'mobile'
  const compact = display === 'compact'
  const pad = mobile ? 60 : compact ? 80 : 72
  const canJump = v.kind === 'ok' && !!message.reply_to?.id
  const attLabel = v.kind === 'ok' && v.icon ? t(`chat.msg.reply.att.${message.reply_to?.attachment_kind || 'file'}`) : ''
  const aria = v.kind === 'ok'
    ? t('chat.msg.reply.jumpAria', { name: v.name, text: v.text || attLabel })
    : t(STATE_ARIA[v.kind])

  return (
    <button
      type="button"
      aria-label={aria}
      disabled={!canJump}
      data-reply-preview=""
      className={cn('relative flex h-[22px] min-w-0 items-center gap-1.5 text-left text-[14px] leading-[18px]', mobile ? 'pr-3' : 'pr-4', canJump ? 'cursor-pointer' : 'cursor-default')}
      style={{ paddingLeft: pad }}
      onClick={(e) => { e.stopPropagation(); if (canJump) jumpTo(message.channel_id, message.reply_to!.id) }}
    >
      {!compact && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute rounded-tl-[6px] border-l-[1.5px] border-t-[1.5px] border-border"
          style={{ left: mobile ? 30 : 36, top: 11, width: mobile ? 26 : 30, height: 10 }}
        />
      )}
      {v.kind === 'ok'
        ? (
          <>
            <UiAvatar src={v.avatar} alt={v.name} fallback={initialOf(v.name)} textSize={8} className="h-4 w-4 shrink-0" />
            <span className={cn('shrink-0 font-semibold', roleTextClass(color))}>{v.name}</span>
            {v.icon && <UiIcon name={v.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
            <span className={cn('min-w-0 truncate text-muted-foreground', canJump ? 'hover:text-foreground' : '')}>{v.text || attLabel}</span>
          </>
        )
        : (
          <>
            <UiIcon name={v.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate italic text-muted-foreground">{t(STATE_KEY[v.kind])}</span>
          </>
        )}
    </button>
  )
})

export default ChatReplyPreview
