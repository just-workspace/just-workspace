/**
 * 오류 타일(시안 H): 실패는 절대 "비어 있음"으로 보이지 않게. 경고 아이콘 + 원인 한 줄 + "다시 시도".
 *  card  — 카드 안 인라인 띠: warning/10 바탕 + warning/40 테두리, role=alert (기본)
 *  panel — 패널·목록 안: 타일 32(warning/15) + 제목 13/600 + 보조 12 + outline 버튼 32
 *  page  — 페이지 전체(셸은 유지): 타일 40 + 제목 15/600 + 설명 13 + [다시 시도][2차]
 */
import type { HTMLAttributes } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { NuxtLink } from '~/components/NuxtLink'
import { UiIcon } from './Icon'

export interface UiErrorTileProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** 원인 한 줄(필수) */
  title: string
  /** 원인·시각 등 보조 문구(예: "서버 응답 500 · 10:42") */
  detail?: string
  /** card(기본) · panel · page */
  placement?: 'card' | 'panel' | 'page'
  /** 다시 시도 문구(기본 common.retry) */
  retryLabel?: string
  /** 2차 행동(page 전용). 예: 서비스 상태 보기 */
  secondaryLabel?: string
  /** 2차 행동을 링크로 */
  secondaryTo?: string
  /** 다시 시도 버튼 숨김 */
  noRetry?: boolean
  /** page 의 다시 시도 버튼 — primary(기본) · outline(테두리 + 배경색 + ↻ 아이콘, 채팅 목록 실패) */
  retryVariant?: 'primary' | 'outline'
  /** 다시 시도 클릭 */
  onRetry?: () => void
  /** 2차 행동 클릭(secondaryTo 가 없을 때) */
  onSecondary?: () => void
}

/**
 * 오류 타일.
 * @example <UiErrorTile placement="panel" title="목록을 불러오지 못했습니다" detail="서버 응답 500" onRetry={reload} />
 */
export function UiErrorTile({ title, detail, placement, retryLabel, secondaryLabel, secondaryTo, noRetry, retryVariant, onRetry, onSecondary, className, ...rest }: UiErrorTileProps) {
  const { t } = useI18n()
  const retry = () => onRetry?.()

  // 카드 안 띠
  if (placement === 'card' || !placement) {
    return (
      <div
        {...rest}
        role="alert"
        className={cn('flex items-center gap-2.5 rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-[13px] text-foreground', className)}
      >
        <UiIcon name="alert-triangle" className="h-4 w-4 shrink-0 text-warning" />
        <span className="min-w-0 flex-1">
          <span>{title}</span>
          {detail && <span className="ml-1.5 text-xs text-muted-foreground">{detail}</span>}
        </span>
        {!noRetry && (
          <button type="button" className="shrink-0 whitespace-nowrap font-semibold text-primary hover:underline" onClick={retry}>
            {retryLabel || t('common.retry')}
          </button>
        )}
      </div>
    )
  }

  // 패널·목록 안
  if (placement === 'panel') {
    return (
      <div
        {...rest}
        role="alert"
        className={cn('flex flex-1 flex-col items-center justify-center gap-2.5 p-5 text-center', className)}
      >
        <span className="grid h-8 w-8 place-items-center rounded-sm bg-warning/15 text-warning">
          <UiIcon name="alert-triangle" className="h-4 w-4" />
        </span>
        <p className="text-[13px] font-semibold text-foreground">{title}</p>
        {detail && <p className="font-mono text-xs text-muted-foreground">{detail}</p>}
        {!noRetry && (
          <button
            type="button"
            className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-semibold text-foreground hover:bg-accent"
            onClick={retry}
          >{retryLabel || t('common.retry')}</button>
        )}
      </div>
    )
  }

  // 페이지 전체
  return (
    <div {...rest} role="alert" className={cn('flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center', className)}>
      <span className="grid h-10 w-10 place-items-center rounded-[10px] bg-warning/15 text-warning">
        <UiIcon name="alert-triangle" className="h-5 w-5" />
      </span>
      <p className="text-[15px] font-semibold text-foreground">{title}</p>
      {detail && <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground [word-break:keep-all]">{detail}</p>}
      <div className="flex gap-2">
        {!noRetry && retryVariant === 'outline'
          ? (
            <button
              type="button"
              className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-border bg-background px-3.5 text-[13px] font-semibold text-foreground hover:bg-accent"
              onClick={retry}
            ><UiIcon name="refresh" className="h-3.5 w-3.5" />{retryLabel || t('common.retry')}</button>
          )
          : !noRetry && (
            <button
              type="button"
              className="inline-flex h-9 items-center rounded-md bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground hover:bg-primary/90"
              onClick={retry}
            >{retryLabel || t('common.retry')}</button>
          )}
        {secondaryLabel && secondaryTo
          ? (
            <NuxtLink
              to={secondaryTo}
              className="inline-flex h-9 items-center rounded-md border border-border px-3.5 text-[13px] text-foreground hover:bg-accent"
            >{secondaryLabel}</NuxtLink>
          )
          : secondaryLabel && (
            <button
              type="button"
              className="inline-flex h-9 items-center rounded-md border border-border px-3.5 text-[13px] text-foreground hover:bg-accent"
              onClick={() => onSecondary?.()}
            >{secondaryLabel}</button>
          )}
      </div>
    </div>
  )
}

export default UiErrorTile
