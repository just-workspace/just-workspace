/**
 * 모바일 상세 화면 상단 바(Vue components/layout/MobileDetailBar.vue):
 * 56, ‹(44) · 제목 16/600(+보조 12 mono/muted) · 액션 ≤2(44, ⋯ 로 접기).
 * 상세(본문·문서·작업·연락처·게시글·미리보기)에서는 탭바를 숨긴다 — hideTabbar 가 셸의 mobile-detail-open 을 켠다.
 * 데스크톱(md↑)에서는 렌더하지 않는다(md:hidden). 1차 행동은 하단 고정 바로.
 * 오른쪽 액션은 actions(UiIconButton size="lg" ≤2, 글자 버튼 h-11). 제목 자리를 바꾸려면 titleSlot(Vue #title).
 * 뒤로: 기본은 onBack 후 backTo → router.back → '/'. navigate=false 면 onBack 만 부른다
 *       (같은 라우트 안에서 판을 닫는 상세 — 파일 상세 패널·연락처 상세 등).
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { navigateTo, routerApi } from '~/lib/router'
import { useSharedState } from '~/lib/state'
import { useIsMobile } from '~/composables/useIsMobile'
import { useOwnMobileHeader } from '~/composables/useOwnMobileHeader'
import { UiIconButton } from '~/components/ui/IconButton'

export interface LayoutMobileDetailBarProps {
  title: string
  subtitle?: string
  /** 보조 글자를 mono 로(예: 3 / 24) */
  subtitleMono?: boolean
  backLabel?: string
  /** 뒤로 이동 경로. 없으면 router.back(기록 없으면 '/') */
  backTo?: string
  /** 붙어 있는 동안 모바일 하단 탭바를 숨긴다. 기본 켬 */
  hideTabbar?: boolean
  /** false 면 라우터를 움직이지 않고 onBack 만 */
  navigate?: boolean
  /** 붙어 있는 동안 모바일 공용 상단바를 숨긴다(이 바가 화면 머리를 대신한다). 기본 켬 */
  replaceTopbar?: boolean
  /** 뒤로 버튼을 눌렀을 때 */
  onBack?: () => void
  /** 제목 자리 전체를 바꾼다(Vue 슬롯 #title) */
  titleSlot?: ReactNode
  /** 오른쪽 액션 ≤2 (UiIconButton size="lg") — Vue 슬롯 #actions */
  actions?: ReactNode
}

export function LayoutMobileDetailBar({
  title, subtitle, subtitleMono = false, backLabel, backTo, hideTabbar = true, navigate = true, replaceTopbar = true,
  onBack, titleSlot, actions,
}: LayoutMobileDetailBarProps) {
  const { t } = useI18n()
  const [, setDetailOpen] = useSharedState<boolean>('mobile-detail-open', () => false)
  const isMobile = useIsMobile()

  // watch([hideTabbar, isMobile], immediate) — 켜는 것만. 끄는 것은 언마운트 때.
  useEffect(() => { if (hideTabbar && isMobile) setDetailOpen(true) }, [hideTabbar, isMobile, setDetailOpen])
  const hideRef = useRef(hideTabbar)
  hideRef.current = hideTabbar
  useEffect(() => () => { if (hideRef.current) setDetailOpen(false) }, [setDetailOpen])
  useOwnMobileHeader(replaceTopbar)

  function back() {
    onBack?.()
    if (!navigate) return
    if (backTo) void navigateTo(backTo)
    else if (window.history.length > 1) routerApi.back()
    else void navigateTo('/')
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-0.5 border-b border-border bg-background px-1 md:hidden">
      <UiIconButton label={backLabel ?? t('common.back')} icon="chevron-left" size="lg" noTooltip className="text-foreground [&>svg]:h-6 [&>svg]:w-6" onClick={back} />
      <div className="min-w-0 flex-1">
        {titleSlot ?? (
          <>
            <h1 className="truncate text-base font-semibold text-foreground">{title}</h1>
            {subtitle && <p className={cn('truncate text-xs text-muted-foreground', subtitleMono ? 'font-mono' : '')}>{subtitle}</p>}
          </>
        )}
      </div>
      {/* 액션 ≤2 (UiIconButton size="lg") */}
      {actions}
    </header>
  )
}

export default LayoutMobileDetailBar
