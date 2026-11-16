/**
 * AI 사이드바의 승인 대기함 진입 칸(시안 회신 rB — "AI 사이드바 진입 칸").
 *  sidebar(데스크톱 AI 사이드바 하단): 항상 표시, 대기 건이 있으면 mono 숫자 배지.
 *  mobile(모바일 대화 목록 머리 아래): 대기 건이 있는 경우에만 한 줄 띠 표시(모바일에는 레일 없음).
 */
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { NuxtLink } from '~/components/NuxtLink'
import { UiIcon } from '~/components/ui/Icon'
import { useApprovalsCount } from '~/composables/useApprovals'

export function ApprovalsEntry({ variant = 'sidebar', className }: { variant?: 'sidebar' | 'mobile'; className?: string }) {
  const { t } = useI18n()
  const n = useApprovalsCount() ?? 0
  if (variant === 'mobile') {
    if (n <= 0) return null
    return (
      <NuxtLink
        to="/approvals"
        className={cn('flex min-h-12 shrink-0 items-center gap-2.5 border-b border-border bg-warning/[0.06] px-4 text-[14px] text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', className)}
      >
        <UiIcon name="shield" className="h-4 w-4 text-warning" />
        <span className="min-w-0 flex-1 truncate">{t('approvals.entry.mobile', { n })}</span>
        <UiIcon name="chevron-right" className="h-4 w-4 text-muted-foreground" />
      </NuxtLink>
    )
  }
  return (
    <NuxtLink
      to="/approvals"
      aria-label={n > 0 ? t('approvals.entry.aria', { n }) : t('approvals.title')}
      className={cn('flex h-[34px] items-center gap-2 rounded-lg px-2.5 text-[13px] text-muted-foreground hover:bg-accent/40 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring', className)}
    >
      <UiIcon name="shield" className={cn('h-[15px] w-[15px]', n > 0 && 'text-warning')} />
      <span className="min-w-0 flex-1 truncate">{t('approvals.title')}</span>
      {n > 0 && (
        <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-warning/15 px-1 font-mono text-[11px] font-bold text-warning">{n > 99 ? '99+' : n}</span>
      )}
    </NuxtLink>
  )
}

export default ApprovalsEntry
