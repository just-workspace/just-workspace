/**
 * 모바일 하단 탭바 — 높이 64 + safe-area, 바탕 card, 상단 테두리. 스토어 없이 props 만으로 렌더링한다.
 * (상세 설명·예시는 아래 컴포넌트 JSDoc 참조)
 */
import type { ButtonHTMLAttributes, CSSProperties } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { UiIcon } from './Icon'

export interface UiTabbarTab {
  /** 고유 id(onSelect 로 전달) */
  id: string
  /** 이름(11) */
  label: string
  /** UiIcon 이름 */
  icon: string
  /** 활성(primary 글자 + 타일) */
  active?: boolean
  /** aria-current="page" 여부(기본 = active). 시트를 여는 칸처럼 활성 외형과 현재 위치가 상이한 경우 사용 */
  current?: boolean
  /** 숫자 배지(0·빈 값이면 숨김) */
  badge?: number
  /** 안 읽음 점(숫자 없이) — 배지가 있거나 활성 칸이면 숨김 */
  dot?: boolean
  /** 점 접근성 이름(기본 "안 읽음") */
  dotLabel?: string
  /** aria-label(기본: 배지가 있으면 "이름 — n", 없으면 이름) */
  ariaLabel?: string
  /** 버튼에 추가할 속성(aria-haspopup·aria-expanded 등) */
  buttonProps?: ButtonHTMLAttributes<HTMLButtonElement>
}

export interface UiTabbarProps {
  /** 칸 목록(왼쪽→오른쪽) */
  tabs: UiTabbarTab[]
  /** 칸 클릭 시 호출 */
  onSelect?: (id: string) => void
  /** nav 접근성 이름(기본 "주요 메뉴") */
  ariaLabel?: string
  /** 하단 safe-area 여백 미적용 */
  noSafeBottom?: boolean
  className?: string
  style?: CSSProperties
}

const badgeText = (n: number) => (n > 99 ? '99+' : String(n))

/**
 * 모바일 하단 탭바 — 높이 64 + safe-area, 바탕 card, 상단 테두리. 스토어 없이 props 만으로 렌더링한다.
 * 칸(통상 5: 홈 · 채팅 · 활동 · 메일 · 전체)은 균등 분할한다. 칸 = 아이콘 타일 32(18 아이콘) + 이름 11.
 * 활성 = primary 글자 600 + 타일 primary/16. 배지 = primary 숫자 알약 18(타일 오른쪽 위, card 2px 테두리, 99 초과 시 99+).
 * 점(dot) = 7px foreground 점(안 읽음 — 숫자 없이 존재 여부만 표시, 활성 칸에서는 숨김).
 *
 * 표시/숨김(md 이상 숨김 등)은 사용처의 className 으로 지정한다(예: "md:hidden"). 시트·이동 등의 동작도 사용처가 onSelect 로 처리한다.
 *
 * @example
 * <UiTabbar className="md:hidden" onSelect={go} tabs={[
 *   { id: 'home', label: '홈', icon: 'home', active: true },
 *   { id: 'chat', label: '채팅', icon: 'chat', badge: 6 },
 *   { id: 'activity', label: '활동', icon: 'bell', badge: 9 },
 *   { id: 'mail', label: '메일', icon: 'mail', dot: true },
 *   { id: 'all', label: '전체', icon: 'grid' },
 * ]} />
 */
export function UiTabbar({ tabs, onSelect, ariaLabel, noSafeBottom = false, className, style }: UiTabbarProps) {
  const { t } = useI18n()
  return (
    <nav
      aria-label={ariaLabel ?? t('shell.tab.mainMenu')}
      className={cn('shrink-0 border-t border-border bg-card', className)}
      style={noSafeBottom ? style : { paddingBottom: 'env(safe-area-inset-bottom)', ...style }}
    >
      <div className="flex h-tabbar items-stretch">
        {tabs.map((tb) => {
          const badge = tb.badge ?? 0
          const current = tb.current ?? tb.active
          return (
            <button
              key={tb.id}
              type="button"
              aria-current={current ? 'page' : undefined}
              aria-label={tb.ariaLabel ?? (badge ? `${tb.label} — ${badge}` : undefined)}
              {...tb.buttonProps}
              className={cn('flex min-h-11 flex-1 flex-col items-center justify-center gap-1 text-[11px] transition-colors', tb.active ? 'font-semibold text-primary' : 'text-muted-foreground', tb.buttonProps?.className)}
              onClick={(e) => { tb.buttonProps?.onClick?.(e); onSelect?.(tb.id) }}
            >
              <span className={cn('relative grid h-8 w-8 place-items-center rounded-lg transition-colors', tb.active ? 'bg-primary/[0.16]' : '')}>
                <UiIcon name={tb.icon} className="h-[18px] w-[18px]" />
                {badge > 0 && (
                  <span
                    className="absolute -right-2 -top-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-card bg-primary px-1 font-mono text-[11px] font-bold text-primary-foreground"
                  >{badgeText(badge)}</span>
                )}
                {!badge && tb.dot && !tb.active && (
                  <span
                    role="img"
                    aria-label={tb.dotLabel ?? t('ui.unread')}
                    className="absolute right-0 top-0.5 h-[7px] w-[7px] rounded-full bg-foreground ring-2 ring-card"
                  />
                )}
              </span>
              <span>{tb.label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

export default UiTabbar
