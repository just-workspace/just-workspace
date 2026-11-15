/**
 * 카드 머리: 세로 묶음 · 간격 6 · p-5.
 */
import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '~/lib/utils'

export interface UiCardHeaderProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode
}

/**
 * 카드 머리.
 * @example <UiCardHeader><UiCardTitle>저장 공간</UiCardTitle></UiCardHeader>
 */
export function UiCardHeader({ className, children, ...rest }: UiCardHeaderProps) {
  return (
    <div {...rest} className={cn('flex flex-col space-y-1.5 p-5', className ?? '')}>
      {children}
    </div>
  )
}

export default UiCardHeader
