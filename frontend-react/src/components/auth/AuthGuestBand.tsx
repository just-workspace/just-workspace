/**
 * 손님 편집 중 상단 띠:
 * 40px, 로고 22 · 문서명 600 · 칩 "손님 · 이름"(muted 20) · 공유자·만료 muted · 오른쪽 [나가기] 28 outline.
 * 나가기 시각 크기는 28 유지, 히트 영역은 40.
 */
import { useI18n } from '~/i18n'
import { useSiteConfig } from '~/composables/useSiteConfig'

export interface AuthGuestBandProps {
  /** 문서명 */
  title: string
  guestName: string
  /** 공유자·만료(sm 이상에서만) */
  meta?: string
  /** 기본값 authScreens.guest.leave */
  leaveLabel?: string
  onLeave?: () => void
}

export function AuthGuestBand({ title, guestName, meta, leaveLabel, onLeave }: AuthGuestBandProps) {
  const { appName, brandLogo } = useSiteConfig()
  const initial = (appName || 'W').trim().charAt(0).toUpperCase()
  const { t } = useI18n()

  return (
    <div role="banner" className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border bg-card pl-3.5 pr-2 text-[13px] text-foreground">
      {brandLogo
        ? <img src={brandLogo} alt={appName} className="h-[22px] w-[22px] shrink-0 rounded-[6px] object-cover" />
        : <span aria-label={appName} className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-[6px] bg-primary text-[11px] font-bold text-primary-foreground">{initial}</span>}
      <b className="truncate font-semibold">{title}</b>
      <span className="inline-flex h-5 shrink-0 items-center rounded-[5px] bg-muted px-1.5 text-[11px] font-semibold">{t('authScreens.guest.chip', { name: guestName })}</span>
      {meta && <span className="hidden truncate text-muted-foreground sm:inline">{meta}</span>}
      <button
        type="button"
        className="relative ml-auto inline-flex h-7 shrink-0 items-center rounded-sm border border-border px-3 text-xs font-semibold hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-['']"
        onClick={() => onLeave?.()}
      >{leaveLabel ?? t('authScreens.guest.leave')}</button>
    </div>
  )
}

export default AuthGuestBand
