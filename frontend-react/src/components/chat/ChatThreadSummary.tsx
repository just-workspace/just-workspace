// Vue 원본: frontend/components/chat/ChatThreadSummary.vue
// 메시지 아래 스레드 칩: 32 높이 rounded-lg 1px bg-card px-10 · 13 —
//   threads 16 muted · 스레드 이름(primary 600, 이름 없으면 “원문 첫 40자” 기울임) · "답글 N개 · 10분 전"(muted)
//   · 참여자 아바타 18 겹침(있으면, 이름 앞) · 보관됨이면 archive 아이콘.
// 메타(이름·보관·답글 수·마지막 시각)는 서버가 루트 메시지에 붙인 thread(ThreadMeta), 옛 서버면 reply_count·last_reply_at.
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import type { ChatMessage } from '~/composables/useChat'
import { threadAgo, threadTitle } from '~/composables/useChatThreadList'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiIcon } from '~/components/ui/Icon'

export interface ChatThreadSummaryProps {
  /** 스레드가 시작된(답글이 있는) 루트 메시지 */
  message: ChatMessage
  /** 눌러서 스레드 열기 */
  onOpen?: () => void
}

/** 스레드 칩(이름 · 답글 N개 · 마지막 답글 시각) */
export function ChatThreadSummary({ message, onOpen }: ChatThreadSummaryProps) {
  const { t } = useI18n()
  const meta = message.thread || null
  const participants = message.thread_participants || []
  const n = meta?.reply_count ?? message.reply_count ?? 0
  const at = threadAgo(meta?.last_reply_at || message.last_reply_at)
  const title = threadTitle(meta, message)
  return (
    <button
      type="button"
      className="group/thr mt-1 flex h-8 max-w-full items-center gap-2 rounded-lg border border-border bg-card px-2.5 text-[13px] hover:bg-overlay-hover max-md:h-11"
      aria-label={`${t('chat.right.thread.openChip', { name: title.text })} · ${t('chat.right.threads.repliesN', { n })}`}
      onClick={() => onOpen?.()}
    >
      <UiIcon name={meta?.archived ? 'archive' : 'threads'} className="h-4 w-4 shrink-0 text-muted-foreground" />
      {participants.length > 0 && (
        <span className="flex shrink-0" aria-hidden="true">
          {participants.slice(0, 3).map((p, i) => (
            <UiAvatar
              key={p.id}
              src={p.avatar_url}
              alt={p.display_name || p.username}
              fallback={(p.display_name || p.username || '?').charAt(0).toUpperCase()}
              textSize={9}
              className={cn('h-[18px] w-[18px] ring-2 ring-card', i > 0 ? '-ml-1' : '')}
            />
          ))}
        </span>
      )}
      <b className={cn('min-w-0 truncate font-semibold text-primary group-hover/thr:underline', title.unnamed && 'italic')}>{title.text}</b>
      <span className="shrink-0 text-muted-foreground">{t('chat.right.threads.repliesN', { n })}{at ? ` · ${at}` : ''}</span>
    </button>
  )
}

export default ChatThreadSummary
