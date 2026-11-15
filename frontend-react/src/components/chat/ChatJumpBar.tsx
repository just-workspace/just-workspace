/**
 * 아래 떠 있는 "최근으로" 바(handover-21 #unread · handover-22 #jump-far · 디스코드 "현재로 이동").
 * 높이 36 · inset 16 · radius 8 · 1px · 그림자. 왼쪽 글 13 muted("이전 메시지를 보고 있습니다" / 점프한 창이면 "9월 3일 메시지를 보고 있습니다"),
 * 아래에 새 메시지가 쌓였으면 개수 꼬리표, 오른쪽 "최근으로 ↓"(primary 600).
 */
import { useI18n } from '~/i18n'
import { UiIcon } from '~/components/ui/Icon'

export interface ChatJumpBarProps {
  /** 점프해서 옛 창을 보는 중이면 그 창 날짜(ISO) */
  viewingDate?: string | null
  /** 아래에 쌓인 새 메시지 수 */
  newCount?: number
  onPresent: () => void
}

export function ChatJumpBar({ viewingDate, newCount = 0, onPresent }: ChatJumpBarProps) {
  const { t, locale } = useI18n()
  const label = viewingDate
    ? t('chat.msg.jump.viewingDate', { date: new Date(viewingDate).toLocaleDateString(locale === 'en' ? 'en-US' : 'ko-KR', { month: 'long', day: 'numeric' }) })
    : t('chat.msg.jump.viewingOlder')
  return (
    <div role="status" className="absolute inset-x-4 bottom-2 z-10 flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3 text-[13px] shadow-md" data-jump-bar="">
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{label}</span>
      {newCount > 0 && (
        <span className="rounded-full bg-danger px-1.5 font-mono text-[11px] font-bold leading-[18px] text-background">{t('chat.msg.jump.newCount', { n: newCount > 99 ? '99+' : newCount })}</span>
      )}
      <button type="button" className="flex items-center gap-1 font-semibold text-primary hover:underline" onClick={onPresent}>
        {t('chat.msg.jump.present')}<UiIcon name="arrow-down" className="h-4 w-4" />
      </button>
    </div>
  )
}

export default ChatJumpBar
