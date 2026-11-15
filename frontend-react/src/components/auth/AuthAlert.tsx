/**
 * 인증 폼 상단 타일:
 * 서버 오류 = danger(무엇 + 다음에 일어날 일), 성공 = success, 경고 = warning.
 * 아이콘 16 + 13px/1.5, 제목 600 + 설명 muted. 형식 오류는 여기가 아니라 입력 아래(UiInput error).
 */
import type { ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { UiIcon } from '~/components/ui/Icon'

export interface AuthAlertProps {
  /** 기본 danger */
  tone?: 'danger' | 'success' | 'warning' | 'info'
  title?: string
  description?: string
  /** 설명 자리 — description 대신 */
  children?: ReactNode
  /** 설명 뒤 행동 */
  action?: ReactNode
}

const STYLE = {
  danger: { box: 'border-danger/45 bg-danger/10', icon: 'alert-circle', color: 'text-danger' },
  success: { box: 'border-success/45 bg-success/10', icon: 'check-circle', color: 'text-success' },
  warning: { box: 'border-warning/40 bg-warning/10', icon: 'alert-triangle', color: 'text-warning' },
  info: { box: 'border-border bg-muted/40', icon: 'info', color: 'text-muted-foreground' },
}

export function AuthAlert({ tone = 'danger', title, description, children, action }: AuthAlertProps) {
  const hasBody = !!description || children != null
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex gap-2.5 rounded-md border px-3 py-2.5 text-[13px] leading-normal text-foreground', STYLE[tone].box)}
    >
      <UiIcon name={STYLE[tone].icon} className={cn('mt-px h-4 w-4 shrink-0', STYLE[tone].color)} strokeWidth={2.2} />
      <span className="min-w-0 flex-1 break-words [word-break:keep-all]">
        {title && <b className="font-semibold">{title}</b>}
        {title && hasBody && ' '}
        {hasBody && (
          <span className={title ? 'text-muted-foreground' : ''}>
            {children ?? description}
          </span>
        )}
        {action}
      </span>
    </div>
  )
}

export default AuthAlert
