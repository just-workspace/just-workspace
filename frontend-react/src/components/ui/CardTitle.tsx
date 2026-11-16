/**
 * 카드 제목: 13/600. 기존 text-2xl 기본값은 카드 안 제목으로 과대하여 대시보드가 매번 재정의하였다.
 */
import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '~/lib/utils'

export interface UiCardTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  children?: ReactNode
}

/**
 * 카드 제목(`<h3>`).
 * @example <UiCardTitle>최근 파일</UiCardTitle>
 */
export function UiCardTitle({ className, children, ...rest }: UiCardTitleProps) {
  return (
    <h3 {...rest} className={cn('text-[13px] font-semibold leading-none tracking-[0.02em] text-foreground', className ?? '')}>
      {children}
    </h3>
  )
}

export default UiCardTitle
