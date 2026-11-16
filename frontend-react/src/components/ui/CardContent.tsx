/**
 * 카드 본문: p-5 pt-0(머리 바로 아래에 밀착).
 */
import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '~/lib/utils'

export interface UiCardContentProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode
}

/**
 * 카드 본문.
 * @example <UiCardContent className="space-y-2">…</UiCardContent>
 */
export function UiCardContent({ className, children, ...rest }: UiCardContentProps) {
  return (
    <div {...rest} className={cn('p-5 pt-0', className ?? '')}>
      {children}
    </div>
  )
}

export default UiCardContent
