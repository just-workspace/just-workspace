/**
 * 입력 중 표시(디스코드 실측): 컴포저 아래 24 예약 자리 · 점 3개 7px(1.2s) · 12/500 · 이름은 foreground 600.
 * 글이 없어도 자리를 차지해 레이아웃을 밀지 않는다. reduce-motion 이면 점이 움직이지 않는다.
 * Vue 원본: frontend/components/chat/ChatTypingIndicator.vue
 */
import { useStore } from 'zustand'
import { clsx as cn } from 'clsx'
import { UiTrans } from '~/components/ui/Trans'
import { chatStore, type TypingUser } from '~/composables/useChat'

export interface ChatTypingIndicatorProps {
  /** 입력 중인 사람(useChat().typingUsers) */
  typingUsers: ReadonlyMap<string, TypingUser>
  className?: string
}

export function ChatTypingIndicator({ typingUsers, className }: ChatTypingIndicatorProps) {
  const allUsers = useStore(chatStore, s => s.allUsers)
  // 표시 이름으로 — 타이핑 이벤트는 username 만 준다
  function nameOf(username: string) {
    const u = allUsers.find(x => x.username === username)
    return u?.display_name || username
  }
  const names = Array.from(typingUsers.values()).map(u => nameOf(u.username))
  const b = (s: string) => <b className="font-semibold text-foreground">{s}</b>

  let line: React.ReactNode = null
  if (names.length === 1) line = <UiTrans k="chat.msg.typing.one" as="span" slots={{ name: b(names[0]) }} />
  else if (names.length === 2) line = <UiTrans k="chat.msg.typing.two" as="span" slots={{ name1: b(names[0]), name2: b(names[1]) }} />
  else if (names.length > 2) line = <UiTrans k="chat.msg.typing.many" as="span" slots={{ name: b(names[0]), n: String(names.length - 1) }} />

  return (
    <div className={cn('h-6 shrink-0 px-4 text-[12px] font-medium text-muted-foreground', className)} aria-live="polite">
      {line && (
        <div className="flex h-6 items-center gap-1.5">
          <span className="flex items-center gap-[3px]" aria-hidden="true">
            {[0, 1, 2].map(i => (
              <span
                key={i}
                className="h-[7px] w-[7px] animate-pulse rounded-full bg-muted-foreground motion-reduce:animate-none"
                style={{ animationDuration: '1.2s', animationDelay: `${i * 0.2}s` }}
              />
            ))}
          </span>
          <p className="min-w-0 truncate">{line}</p>
        </div>
      )}
    </div>
  )
}

export default ChatTypingIndicator
