/**
 * 시스템 줄(Chat22 kSys · Rich22 #pin). Vue 원본: frontend/components/chat/ChatSystemMessage.vue
 * 거터 72 안 오른쪽 아이콘 16 + 본문 14/22 muted(사람 이름은 foreground 500) + 시각 mono 12. 위 8.
 * 고정 줄(file_meta.kind = 'pin'): "○○ 님이 메시지를 고정했습니다. [고정 보기]" — 누르면 원문으로 점프.
 */
import { memo } from 'react'
import { useStore } from 'zustand'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { chatStore, type ChatMessage } from '~/composables/useChat'
import { chatClock, jumpTo } from '~/composables/useChatUi'
import { roleTextClass, useChatRoles, userRoleColor } from '~/composables/useChatRoles'
import { UiIcon } from '~/components/ui/Icon'

export interface ChatSystemMessageProps {
  /** 시스템 메시지 */
  message: ChatMessage
  display?: 'cozy' | 'compact' | 'mobile'
}

export interface PinMeta { kind: 'pin'; message_id: string; actor_id: string | null }
export function pinMetaOf(m: Pick<ChatMessage, 'file_meta'>): PinMeta | null {
  if (!m.file_meta) return null
  try {
    const v = JSON.parse(m.file_meta)
    return v && v.kind === 'pin' && v.message_id ? { kind: 'pin', message_id: String(v.message_id), actor_id: v.actor_id ? String(v.actor_id) : null } : null
  } catch { return null }
}

function iconOf(content: string): { icon: string; cls: string } {
  if (/들어왔|참여|joined/i.test(content)) return { icon: 'arrow-right', cls: 'text-success' }
  if (/나갔|내보냈|left|removed/i.test(content)) return { icon: 'arrow-left', cls: 'text-danger' }
  return { icon: 'info', cls: 'text-muted-foreground' }
}

export const ChatSystemMessage = memo(function ChatSystemMessage({ message, display = 'cozy' }: ChatSystemMessageProps) {
  const { t } = useI18n()
  const pin = pinMetaOf(message)
  const actorId = pin?.actor_id || message.sender?.id || null
  const actor = useStore(chatStore, s => (actorId ? s.allUsers.find(u => u.id === actorId) : undefined))
  const color = useChatRoles(s => (actorId ? userRoleColor(actorId, s) : null))
  const gutter = display === 'mobile' ? 60 : 72
  const at = chatClock(message.created_at)
  const ic = pin ? { icon: 'pin', cls: 'text-muted-foreground' } : iconOf(message.content)
  const actorName = actor?.display_name || actor?.username || message.sender?.display_name || message.sender?.username || ''

  return (
    <div className="mt-2 flex items-center py-0.5 pr-4" data-system={pin ? 'pin' : ''}>
      <span className={cn('flex shrink-0 justify-end pr-4', ic.cls)} style={{ width: gutter }} aria-hidden="true">
        <UiIcon name={ic.icon} className="h-4 w-4" />
      </span>
      <p className="min-w-0 text-[14px] leading-[22px] text-muted-foreground">
        {pin
          ? (
            <>
              <b className={cn('font-medium text-foreground', roleTextClass(color))}>{actorName}</b>
              {' '}{t('chat.msg.system.pinned')}{' '}
              <button type="button" className="font-semibold text-primary hover:underline" onClick={() => jumpTo(message.channel_id, pin.message_id)}>{t('chat.msg.system.viewPin')}</button>
            </>
          )
          : message.content}
        <time dateTime={message.created_at} className="ml-1 font-mono text-[12px]">{at}</time>
      </p>
    </div>
  )
})

export default ChatSystemMessage
