/**
 * 음성채널에 붙은 글 채팅(handover-20 답 §5.5) — 본문 오른쪽 340 패널, 머리 "채팅 · 이 음성채널 안에서만". 접속 중일 때만 보인다.
 * 메시지는 그 음성 채널 자체의 메시지(음성 채널도 채널이라 chatStore 의 선택 채널 메시지 = 이 채널 것) — 저장·API 모두 텍스트 채널과 같다.
 * 줄: 아바타 32 · 이름(13/600) + 시각(mono 11) · 본문(14). 위로 스크롤하면 이전 메시지(loadMore). 작성 상자는 공용 ChatInput(멘션·첨부·이모지 그대로).
 * 모바일: 머리 오른쾽 채팅 아이콘으로 전체 화면으로 연다(VoiceChannelView 가 onBack 을 준다).
 */
import { useEffect, useRef } from 'react'
import { useStore } from 'zustand'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { authStore } from '~/composables/useAuth'
import { loadMore, sendMessage, sendTyping, useChat } from '~/composables/useChat'
import { chatClock, initialOf } from '~/composables/useChatUi'
import { renderChatMarkdown } from '~/utils/chatMarkdown'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiIcon } from '~/components/ui/Icon'
import { ChatInput } from '~/components/chat/ChatInput'

export interface VoiceChatPanelProps {
  channelName: string
  /** 모바일 전체 화면일 때 — 뒤로 */
  onBack?: () => void
  className?: string
}

export function VoiceChatPanel({ channelName, onBack, className }: VoiceChatPanelProps) {
  const { t } = useI18n()
  const { messages, hasMoreMessages, loadingMore, outbox, selectedChannelId } = useChat()
  // 끊긴 동안 보낸 글(전송 대기) — 이 채널 것만 맨 아래에 흐리게
  const pending = outbox.filter(o => o.channelId === selectedChannelId)
  const me = useStore(authStore, s => s.user)
  const myName = me?.display_name || me?.username || ''
  const listRef = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)

  // 새 메시지 — 바닥에 붙어 있었으면 따라 내려간다
  useEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages.length])

  function onScroll() {
    const el = listRef.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (el.scrollTop < 60 && hasMoreMessages && !loadingMore) void loadMore()
  }

  const shown = messages.filter(m => !m.is_deleted && m.message_type !== 'system' && (!m.parent_id || m.thread_broadcast))

  return (
    <aside aria-label={t('chat.voice.view.chat.panel')} data-testid="voice-chat" className={cn('flex min-h-0 flex-col border-border bg-card', onBack ? 'h-full' : 'w-[340px] shrink-0 border-l', className)}>
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        {onBack && (
          <button type="button" className="-ml-2 inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-accent" aria-label={t('chat.voice.view.chat.back')} onClick={onBack}>
            <UiIcon name="chevron-left" className="h-6 w-6" />
          </button>
        )}
        <p className="flex-1 text-[14px] font-semibold">{t('chat.voice.view.chat.title')}</p>
        <span className="text-[12px] text-muted-foreground">{t('chat.voice.view.chat.scope')}</span>
      </div>
      <div ref={listRef} onScroll={onScroll} className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        <div className="mt-auto flex flex-col gap-4">
          {shown.length === 0 && pending.length === 0 && <p className="text-center text-[13px] text-muted-foreground">{t('chat.voice.view.chat.empty')}</p>}
          {shown.map((m) => {
            const who = m.sender?.display_name || m.sender?.username || ''
            return (
              <div key={m.id} className="flex gap-2.5">
                <UiAvatar src={m.sender?.avatar_url} alt={who} fallback={initialOf(who)} className="h-8 w-8" textSize={11} />
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold">{who} <span className="font-mono text-[11px] font-normal text-muted-foreground">{chatClock(m.created_at)}</span></p>
                  {m.message_type === 'file'
                    ? <p className="text-[14px] leading-relaxed text-primary">{m.content}</p>
                    : <p className="text-[14px] leading-relaxed break-words [&_a]:text-primary [&_a]:underline" dangerouslySetInnerHTML={{ __html: renderChatMarkdown(m.content) }} />}
                </div>
              </div>
            )
          })}
          {pending.map((o) => (
            <div key={o.localId} className="flex gap-2.5 opacity-60" aria-label={t('chat.messages.pendingSend')}>
              <UiAvatar src={me?.avatar_url} alt={myName} fallback={initialOf(myName)} className="h-8 w-8" textSize={11} />
              <div className="min-w-0">
                <p className="text-[13px] font-semibold">{myName} <span className="font-mono text-[11px] font-normal text-muted-foreground">{t('chat.messages.pendingSend')}</span></p>
                <p className="text-[14px] leading-relaxed break-words">{o.content}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="border-t border-border">
        <ChatInput placeholder={t('chat.voice.view.chat.placeholder', { name: channelName })} onSend={sendMessage} onTyping={sendTyping} />
      </div>
    </aside>
  )
}

export default VoiceChatPanel
