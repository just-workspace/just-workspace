/**
 * 메시지 불러오는 중(handover-22 Chat22 #loading) — 아바타 40 원 + 이름 막대 14×128 + 본문 막대 1–2줄(14 높이), 묶음 간격 20, 좌우 16.
 * animate-pulse — reduce-motion 이면 멈춘다. aria-busy 로 읽는 중임을 알린다.
 */
import { useI18n } from '~/i18n'

const ROWS: string[][] = [['w-3/4', 'w-1/2'], ['w-2/3'], ['w-1/2', 'w-2/5'], ['w-1/2']]

export function ChatMessageSkeleton() {
  const { t } = useI18n()
  return (
    <div className="flex flex-col gap-5 px-4 py-4" aria-busy="true" aria-label={t('chat.shell.loading')} data-testid="chat-skeleton">
      {ROWS.map((lines, i) => (
        <div key={i} className="flex gap-4">
          <span className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
          <div className="flex flex-1 flex-col gap-2 pt-1">
            <span className="h-3.5 w-32 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            {lines.map(w => <span key={w} className={`h-3.5 animate-pulse rounded bg-muted motion-reduce:animate-none ${w}`} />)}
          </div>
        </div>
      ))}
    </div>
  )
}

export default ChatMessageSkeleton
