/**
 * Meeting-specific chat panel.
 * Uses direct $fetch instead of useChat singleton to avoid interference.
 * 참고: 현재 사용처 없음(회의 채팅은 MeetingsSidebar 의 DataChannel 채팅).
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { useAuth } from '~/composables/useAuth'

export interface MeetingChatPanelProps {
  /** 채팅 채널 id(/api/chat/channels/{id}/messages) */
  channelId: string
}

interface MeetingMsg {
  id: string
  sender: { id: string; username: string; display_name: string | null; avatar_url: string | null } | null
  content: string
  message_type: string
  created_at: string
}

function formatTime(dateStr: string) {
  const d = new Date(dateStr)
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
}

/** 채널 메시지를 3초마다 조회해 표시하는 간단한 회의 채팅 패널 */
export function MeetingChatPanel({ channelId }: MeetingChatPanelProps) {
  const { t } = useI18n()
  const { user } = useAuth()
  const [messages, setMessages] = useState<MeetingMsg[]>([])
  const [newMessage, setNewMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  const channelRef = useRef(channelId)
  channelRef.current = channelId

  async function fetchMessages() {
    try {
      const data = await $fetch<{ messages: MeetingMsg[]; has_more: boolean }>(
        `/api/chat/channels/${channelRef.current}/messages`,
        { params: { limit: 50 } },
      )
      setMessages(data.messages)
    } catch (e: any) {
      console.error('MeetingChat fetch error:', e)
    }
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
    })
  }

  async function sendMessage() {
    const content = newMessage.trim()
    if (!content) return
    setNewMessage('')
    try {
      await $fetch(`/api/chat/channels/${channelRef.current}/messages`, {
        method: 'POST',
        body: { content, message_type: 'text' },
      })
      await fetchMessages()
      scrollToBottom()
    } catch (e: any) {
      console.error('MeetingChat send error:', e)
    }
  }

  function onKeydown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendMessage()
    }
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      setLoading(true)
      await fetchMessages()
      if (!alive) return
      setLoading(false)
      scrollToBottom()
    })()
    // Poll for new messages (simple approach, avoids WS coupling)
    const pollTimer = setInterval(fetchMessages, 3000)
    return () => { alive = false; clearInterval(pollTimer) }
     
  }, [])

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden bg-card border-l border-border w-full md:w-72">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border">
        <h4 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{t('meetings.chat.title')}</h4>
      </div>

      {/* Messages */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-2 py-1 space-y-1">
        {loading && (
          <div className="flex items-center justify-center py-4">
            <span className="text-xs text-muted-foreground">{t('common.loading')}</span>
          </div>
        )}

        {messages.map(msg => (
          <div key={msg.id} className="py-0.5">
            {msg.message_type === 'system'
              ? (
                <div className="text-center">
                  <span className="text-[11px] text-muted-foreground">{msg.content}</span>
                </div>
              )
              : (
                <div>
                  <div className="flex min-w-0 items-baseline gap-1">
                    <span className={cn('min-w-0 truncate text-[11px] font-semibold', msg.sender?.id === user?.id ? 'text-primary' : '')}>
                      {msg.sender?.display_name || msg.sender?.username || '?'}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{formatTime(msg.created_at)}</span>
                  </div>
                  <p className="text-xs whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{msg.content}</p>
                </div>
              )}
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="border-t border-border px-2 py-1.5">
        <div className="flex gap-1">
          <input
            autoComplete="off"
            value={newMessage}
            onChange={e => setNewMessage(e.target.value)}
            onKeyDown={onKeydown}
            placeholder={t('meetings.chat.placeholder')}
            className="min-w-0 flex-1 px-2 py-1 text-xs border border-border rounded bg-background focus:outline-hidden focus:ring-1 focus:ring-ring"
          />
          <button
            onClick={() => void sendMessage()}
            disabled={!newMessage.trim()}
            className="shrink-0 whitespace-nowrap px-2 py-1 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {t('common.send')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default MeetingChatPanel
