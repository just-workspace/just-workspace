/**
 * 카드 틀: rounded-lg · border · bg-card. 안에 UiCardHeader / UiCardTitle / UiCardContent.
 */
import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '~/lib/utils'

export interface UiCardProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode
}

/**
 * 카드.
 * @example <UiCard><UiCardHeader><UiCardTitle>오늘 일정</UiCardTitle></UiCardHeader><UiCardContent>…</UiCardContent></UiCard>
 */
export function UiCard({ className, children, ...rest }: UiCardProps) {
  return (
    <div {...rest} className={cn('rounded-lg border border-border bg-card text-card-foreground', className ?? '')}>
      {children}
    </div>
  )
}

export default UiCard
