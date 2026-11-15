/**
 * 빈 상태 3변형.
 *  full  — 페이지·목록 영역: 카드 틀, 아이콘 타일 40, 제목 15/600, 설명 13, 1차 버튼 36
 *  panel — 카드·사이드 패널 안: 테두리 없음, 타일 32, 제목 13/600, 텍스트 버튼
 *  inline— 트리·하위 목록·댓글 한 줄: 32 행, muted 글자 + primary 텍스트 버튼
 * 행동은 actionTo(링크) 또는 onAction(클릭) 둘 다 받는다. 기능 아이콘은 icon(이름) 또는 iconSlot(그림).
 * 아이콘 타일 반지름: 시안의 11px/9px 는 사용 중지한 값 → 10px/8px 로 둠.
 */
import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { NuxtLink } from '~/components/NuxtLink'
import { UiIcon } from './Icon'

export interface UiEmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** 제목(필수) */
  title: string
  /** 설명(panel·full) */
  description?: string
  /** 행동 문구. 없으면 행동 없음 */
  actionLabel?: string
  /** 행동을 링크로(앱 안 경로). 없으면 버튼 → onAction */
  actionTo?: string
  /** utils/icons 이름. 없으면 기본 inbox */
  icon?: string
  /** full(기본) · panel · inline */
  variant?: 'full' | 'panel' | 'inline'
  /** inline 을 카드 행(px-5) 줄에 맞춘다 — 카드 안 빈 행의 글자가 다른 행과 같은 세로선에 */
  inset?: boolean
  /** 행동 버튼 클릭(actionTo 가 없을 때) */
  onAction?: () => void
  /** 아이콘 타일 자리 통째 바꾸기 — panel·full */
  iconSlot?: ReactNode
  /** 카드 안 맨 아래 추가 내용 — full 전용 */
  extra?: ReactNode
}

/**
 * 빈 상태.
 * @example <UiEmptyState title="메일이 없습니다" description="받은 메일이 여기에 표시됩니다" actionLabel="새 메일" onAction={compose} />
 */
export function UiEmptyState({ title, description, actionLabel, actionTo, icon, variant, inset, onAction, iconSlot, extra, className, ...rest }: UiEmptyStateProps) {
  // 한 줄형
  if (variant === 'inline') {
    return (
      <div {...rest} className={cn('flex h-8 items-center gap-2 text-[13px] text-muted-foreground', inset ? 'px-5' : 'px-3.5', className)}>
        <span>{title}</span>
        {actionLabel && (
          <>
            <span aria-hidden="true">·</span>
            {actionTo
              ? <NuxtLink to={actionTo} className="font-semibold text-primary hover:underline">{actionLabel}</NuxtLink>
              : <button type="button" className="font-semibold text-primary hover:underline" onClick={() => onAction?.()}>{actionLabel}</button>}
          </>
        )}
      </div>
    )
  }

  // 패널형
  if (variant === 'panel') {
    return (
      <div {...rest} className={cn('flex flex-col items-center gap-2 px-5 py-5 text-center', className)}>
        {iconSlot ?? (
          <span className="grid h-8 w-8 place-items-center rounded-sm bg-muted text-muted-foreground">
            <UiIcon name={icon || 'inbox'} className="h-4 w-4" />
          </span>
        )}
        <p className="text-[13px] font-semibold text-foreground">{title}</p>
        {description && <p className="text-xs text-muted-foreground [word-break:keep-all]">{description}</p>}
        {actionLabel && (actionTo
          ? <NuxtLink to={actionTo} className="text-xs font-semibold text-primary hover:underline">{actionLabel}</NuxtLink>
          : <button type="button" className="text-xs font-semibold text-primary hover:underline" onClick={() => onAction?.()}>{actionLabel}</button>)}
      </div>
    )
  }

  // 전체형(기본)
  return (
    <div {...rest} className={cn('flex flex-1 items-center justify-center p-6', className)}>
      <div className="flex w-full max-w-sm flex-col items-center gap-2.5 rounded-lg border border-border bg-card p-7 text-center">
        {iconSlot ?? (
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-muted text-muted-foreground">
            <UiIcon name={icon || 'inbox'} className="h-5 w-5" />
          </span>
        )}
        <p className="text-[15px] font-semibold text-foreground">{title}</p>
        {description && <p className="text-[13px] leading-relaxed text-muted-foreground [word-break:keep-all]">{description}</p>}
        {actionLabel && (actionTo
          ? (
            <NuxtLink
              to={actionTo}
              className="mt-1 inline-flex h-9 items-center rounded-md bg-primary px-4 text-[13px] font-semibold text-primary-foreground hover:bg-primary/90"
            >{actionLabel}</NuxtLink>
          )
          : (
            <button
              type="button"
              className="mt-1 inline-flex h-9 items-center rounded-md bg-primary px-4 text-[13px] font-semibold text-primary-foreground hover:bg-primary/90"
              onClick={() => onAction?.()}
            >{actionLabel}</button>
          ))}
        {extra}
      </div>
    </div>
  )
}

export default UiEmptyState
