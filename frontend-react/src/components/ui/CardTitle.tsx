/**
 * 카드 제목(시안 8-2-5): 13/600. 예전 text-2xl 기본은 카드 안 제목으로 너무 커서 대시보드가 매번 덮어썼다.
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
