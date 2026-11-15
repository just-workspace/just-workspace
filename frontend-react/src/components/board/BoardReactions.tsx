/**
 * 글 리액션(시안 BD3 · BM2) — Vue 판 components/board/BoardReactions.vue 이식.
 * 알약 높이 28(모바일 32) · 테두리 · 내가 누른 것 = primary/60 테두리 + primary/10 바탕 + 수 primary 600.
 * + 알약 → 프리셋 이모지 고르기(시안 그림 없음 — 기존 6종 유지, 히트 40).
 */
import { useRef, useState } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useClickOutside } from '~/lib/dom'
import { toggleReaction, type ReactionGroup } from '~/composables/useBoard'
import { UiIcon } from '~/components/ui/Icon'

export interface BoardReactionsProps {
  reactions: ReadonlyArray<ReactionGroup>
  postId: string
}

const PRESET_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥']

/** 리액션 알약 줄 + 이모지 고르기 */
export function BoardReactions({ reactions, postId }: BoardReactionsProps) {
  const { t } = useI18n()
  const [showPicker, setShowPicker] = useState(false)
  const pickerRoot = useRef<HTMLDivElement | null>(null)
  useClickOutside(pickerRoot, () => setShowPicker(false))

  function onToggle(emoji: string) {
    void toggleReaction(postId, emoji)
    setShowPicker(false)
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {reactions.map(r => (
        <button
          key={r.emoji}
          type="button"
          aria-pressed={r.reacted}
          aria-label={r.reacted ? t('board.reaction.ariaMine', { emoji: r.emoji, n: r.count }) : t('board.reaction.aria', { emoji: r.emoji, n: r.count })}
          className={cn('inline-flex h-8 items-center gap-1 rounded-full border px-2.5 text-sm transition-colors md:h-7 md:text-[13px]', r.reacted ? 'border-primary/60 bg-primary/10' : 'border-border hover:bg-accent')}
          onClick={() => onToggle(r.emoji)}
        >
          <span aria-hidden="true">{r.emoji}</span>
          <span className={cn('font-mono text-xs md:text-[11px]', r.reacted ? 'font-semibold text-primary' : 'text-muted-foreground')}>{r.count}</span>
        </button>
      ))}

      <div ref={pickerRoot} className="relative">
        <button
          type="button"
          aria-label={t('board.reaction.addTitle')}
          aria-expanded={showPicker}
          className="inline-flex h-8 items-center rounded-full border border-border px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:h-7"
          onClick={() => setShowPicker(!showPicker)}
        ><UiIcon name="plus" className="h-3.5 w-3.5" strokeWidth={2.4} /></button>
        {showPicker && (
          <div
            role="menu"
            aria-label={t('board.reaction.pick')}
            className="absolute bottom-full left-0 z-dropdown mb-1 flex gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-md"
          >
            {PRESET_EMOJIS.map(emoji => (
              <button
                key={emoji}
                type="button"
                role="menuitem"
                aria-label={emoji}
                className="grid h-10 w-10 place-items-center rounded-sm text-lg transition-colors hover:bg-accent"
                onClick={() => onToggle(emoji)}
              >{emoji}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default BoardReactions
