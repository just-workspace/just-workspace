/**
 * FAB: 56 rounded-sheet primary, 그림자 scrim/45, 오른쪽 16, 탭바(64)+16 위(+safe-area).
 * 모바일에서 사이드바 1차 행동(새 일정·새 연락처·새 작업)이 배치되는 위치. 기본적으로 데스크톱(md↑)에서는 숨긴다.
 *  extended  — 아이콘 + 글자(메일 "새 메일": 좌우 20 · 15/600 · 아이콘 18). 아이콘형은 56×56.
 *  until="lg" — 768~1023 에서도 표시한다(해당 폭에서 사이드바가 드로어라 1차 행동이 표시되지 않는 모듈). md↑ 는 탭바가 없어 아래 16.
 *  contained — 화면 고정이 아닌 가장 가까운 relative 부모의 오른쪽 아래(분할 판 안 목록 등).
 * 탭바가 숨겨진 상세 화면에서는 aboveTabbar={false}.
 */
import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { NuxtLink } from '~/components/NuxtLink'
import { UiIcon } from './Icon'

export interface UiFabProps extends Omit<HTMLAttributes<HTMLElement>, 'onClick'> {
  /** aria-label(필수). 아이콘형은 title 로도, extended 는 글자로도 표시된다 */
  label: string
  /** 아이콘 이름(기본 'plus') */
  icon?: string
  /** 링크로 렌더링(앱 내부 경로). 없으면 버튼 */
  to?: string
  /** 탭바 위에 배치(기본 활성화) */
  aboveTabbar?: boolean
  /** 아이콘 + 글자형 */
  extended?: boolean
  /** md(기본) — 768↑ 숨김 · lg — 1024↑ 숨김 */
  until?: 'md' | 'lg'
  /** 가장 가까운 relative 부모 안 오른쪽 아래 */
  contained?: boolean
  /** 클릭(링크형에서도 호출됨) */
  onClick?: () => void
  /** 아이콘·글자 대신 렌더링할 내용 */
  children?: ReactNode
}

/**
 * 플로팅 1차 행동 버튼(모바일).
 * @example <UiFab label="새 일정" onClick={openNew} />
 */
export function UiFab({ label, icon = 'plus', to, aboveTabbar = true, extended = false, until = 'md', contained = false, onClick, className, children, ...rest }: UiFabProps) {
  const placeClass = contained
    ? 'absolute bottom-4 right-4 z-10'
    : cn(
      'fixed right-4 z-drawer',
      aboveTabbar ? 'bottom-[calc(80px+env(safe-area-inset-bottom))]' : 'bottom-[calc(16px+env(safe-area-inset-bottom))]',
      // md↑ 은 탭바 없음
      'md:bottom-[calc(16px+env(safe-area-inset-bottom))]',
    )
  const cls = cn(
    'h-14 items-center rounded-sheet bg-primary text-primary-foreground shadow-[0_6px_16px_hsl(var(--scrim)/0.45)] transition-transform active:scale-95 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background',
    placeClass,
    extended ? 'flex gap-2 px-5 text-[15px] font-semibold' : 'grid w-14 place-items-center',
    until === 'lg' ? 'lg:hidden' : 'md:hidden',
    className,
  )
  const content = children ?? (
    <>
      <UiIcon name={icon} className={extended ? 'h-[18px] w-[18px]' : 'h-[22px] w-[22px]'} strokeWidth={extended ? 2.2 : 2.4} />
      {extended && label}
    </>
  )
  if (to) {
    return (
      <NuxtLink {...rest} to={to} aria-label={label} title={extended ? undefined : label} className={cls} onClick={() => onClick?.()}>
        {content}
      </NuxtLink>
    )
  }
  return (
    <button {...rest} type="button" aria-label={label} title={extended ? undefined : label} className={cls} onClick={() => onClick?.()}>
      {content}
    </button>
  )
}

export default UiFab
