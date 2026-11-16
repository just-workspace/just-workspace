/**
 * 알림 상자 — 화면 안에 상주하는 안내(정보·주의·오류·확인됨). 일시 표시 후 사라지는 알림은 UiToast.
 * 상태는 색 + 아이콘 + 글자로 함께 전달한다. tone 별 기본 아이콘이 있으며 `icon` 으로 변경한다.
 * - variant="box"(기본): 옅은 바탕의 상자. 제목(title) + 본문(children) + 행동(actions).
 * - variant="plain": 바탕 없는 한 줄(입력 아래 확인 결과 등).
 * role 은 기본으로 부여하지 않는다 — 신규 발생 오류는 role="alert", 비긴급 결과는 role="status" 를 호출처가 지정한다
 * (자주 변경되는 내용에 부여하면 화면 낭독기가 반복 낭독한다).
 */
import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { UiIcon } from './Icon'

export type UiCalloutTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral'

export interface UiCalloutProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** info(기본) · success · warning · danger · neutral */
  tone?: UiCalloutTone
  /** 첫 줄(굵게). 없으면 본문만 */
  title?: ReactNode
  /** 아이콘 회전(확인 중) */
  icon?: string
  /** 아이콘을 돌린다(확인 중) */
  spin?: boolean
  /** box(기본) · plain(바탕 없는 한 줄) */
  variant?: 'box' | 'plain'
  /** 본문 아래(또는 plain 에서는 오른쪽) 행동 버튼들 */
  actions?: ReactNode
  children?: ReactNode
}

const ICON: Record<UiCalloutTone, string> = {
  info: 'info',
  success: 'check-circle',
  warning: 'alert-triangle',
  danger: 'alert-circle',
  neutral: 'info',
}
const BOX: Record<UiCalloutTone, string> = {
  info: 'bg-muted-foreground/10',
  success: 'bg-success/10',
  warning: 'bg-warning/10',
  danger: 'bg-danger/10',
  neutral: 'bg-muted-foreground/10',
}
const ICON_COLOR: Record<UiCalloutTone, string> = {
  info: 'text-muted-foreground',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  neutral: 'text-muted-foreground',
}

/**
 * 알림 상자.
 * @example <UiCallout tone="warning" title="레코드 2개가 맞지 않습니다.">설치 후 다시 확인할 수 있습니다.</UiCallout>
 * @example <UiCallout variant="plain" tone="success" role="status">확인됨</UiCallout>
 */
export function UiCallout({ tone = 'info', title, icon, spin = false, variant = 'box', actions, className, children, ...rest }: UiCalloutProps) {
  const glyph = (
    <span className={cn('mt-px flex shrink-0', ICON_COLOR[tone])}>
      <UiIcon name={icon ?? ICON[tone]} aria-hidden="true" className={cn('size-[18px]', spin && 'animate-spin motion-reduce:animate-none')} />
    </span>
  )
  if (variant === 'plain') {
    return (
      <div {...rest} data-tone={tone} className={cn('flex flex-wrap items-start gap-x-2 gap-y-1.5 text-[13px] leading-5', className ?? '')}>
        {glyph}
        <span className="min-w-0 flex-1 basis-40">
          {title && <span className="font-semibold">{title}</span>}
          {title && children ? ' · ' : null}
          {children}
        </span>
        {actions && <span className="flex shrink-0 flex-wrap items-center gap-2">{actions}</span>}
      </div>
    )
  }
  return (
    <div {...rest} data-tone={tone} className={cn('flex items-start gap-3 rounded-xl px-4 py-3', BOX[tone], className ?? '')}>
      {glyph}
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-[13px] leading-5">
        {title && <span className="font-semibold">{title}</span>}
        {children && <div className={cn('min-w-0', title ? 'text-muted-foreground' : '')}>{children}</div>}
        {actions && <div className="mt-2 flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}

export default UiCallout
