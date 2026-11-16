/**
 * 리액션 칩 행(디스코드 수치).
 * 칩: radius 8 · 패딩 2×6 · 간격 4 · 1px · 이모지 + 수(mono 12). 본인이 누른 칩 = primary 테두리 + primary/15.
 * 커스텀 이모지 리액션(`:name:`)은 이미지 16. 툴팁 = 누른 사용자 이름(최대 5 + "외 N명").
 * 행 끝 smile-plus = 이모지 피커(리액션 모드 — useChatUi.setEmojiPicker, 선택 시 ChatEmojiPicker 가 toggleReaction 호출).
 */
import { useStore } from 'zustand'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { apiUrl } from '~/lib/runtimeConfig'
import { chatStore, toggleReaction, type ReactionGroup } from '~/composables/useChat'
import { anchorOf, setEmojiPicker } from '~/composables/useChatUi'
import { parseCustomToken } from '~/composables/useChatEmoji'
import { UiIcon } from '~/components/ui/Icon'
import { useCustomEmojiUrl } from './ChatMarkdown'

export interface ChatReactionsProps {
  /** 리액션 그룹(이모지·수·누른 사용자) */
  reactions: ReactionGroup[]
  messageId: string
  size?: 'sm' | 'md'
  className?: string
}

/** 리액션 글리프 — 유니코드는 문자, 커스텀 :name: 은 이미지(없으면 문자) */
export function ReactionGlyph({ emoji, className }: { emoji: string; className?: string }) {
  const emojiUrl = useCustomEmojiUrl()
  const name = parseCustomToken(emoji)
  const url = name ? emojiUrl(name) : null
  if (url) return <img src={apiUrl(url)} alt={emoji} draggable={false} className={cn('inline-block h-4 w-4 object-contain', className)} />
  return <span aria-hidden="true" className={className}>{emoji}</span>
}

export function ChatReactions({ reactions, messageId, className }: ChatReactionsProps) {
  const { t } = useI18n()
  const members = useStore(chatStore, s => s.members)
  const allUsers = useStore(chatStore, s => s.allUsers)

  // 리액션한 사용자 이름 툴팁
  function reactorTitle(r: ReactionGroup): string {
    const names = r.user_ids
      .map((id) => {
        const m = members.find(mm => mm.user_id === id)
        if (m) return m.display_name || m.username
        const u = allUsers.find(x => x.id === id)
        return u ? (u.display_name || u.username) : null
      })
      .filter((n): n is string => !!n)
    if (names.length === 0) return t('board.reaction.countLabel', { n: r.user_ids.length })
    const shown = names.slice(0, 5).join(', ')
    const extra = names.length - 5
    return `${extra > 0 ? t('chat.reactions.andOthers', { names: shown, n: extra }) : shown} · ${r.emoji}`
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)} data-reactions="">
      {reactions.map(r => (
        <button
          key={r.emoji}
          type="button"
          className={cn(
            'inline-flex items-center gap-1 rounded-lg border text-[14px] leading-5 transition-colors',
            r.reacted ? 'border-primary bg-primary/15' : 'border-border bg-card hover:border-muted-foreground/60',
          )}
          style={{ padding: '2px 6px' }}
          title={reactorTitle(r)}
          aria-pressed={r.reacted}
          aria-label={t('chat.msg.reactions.chip', { emoji: r.emoji, n: r.count })}
          onClick={() => toggleReaction(messageId, r.emoji)}
        >
          <ReactionGlyph emoji={r.emoji} />
          <span className={cn('font-mono text-[12px]', r.reacted ? 'font-semibold text-primary' : 'text-muted-foreground')} aria-hidden="true">{r.count}</span>
        </button>
      ))}
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-overlay-hover hover:text-foreground"
        aria-label={t('chat.reactions.add')}
        title={t('chat.reactions.add')}
        onClick={e => setEmojiPicker({ mode: 'react', messageId, anchor: anchorOf(e.currentTarget) })}
      >
        <UiIcon name="smile-plus" className="h-4 w-4" />
      </button>
    </div>
  )
}

export default ChatReactions
