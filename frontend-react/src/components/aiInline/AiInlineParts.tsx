/**
 * 화면 안 AI 공용 조각 — 버튼(숨김·비활성+이유)·진행·오류·외부 AI 안내·AI 생성 꼬리표.
 *  - 진행·오류·외부 AI 안내는 디자인에 그림이 없어 기존 패널 관례(스켈레톤·ErrorTile 줄·12 muted 안내)로 정했다.
 *  - "AI 생성" 표시는 AI 기본법(2026-01-22) — 결과마다 꼬리표 한 줄.
 */
import type { ReactNode } from 'react'
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { UiButton, type UiButtonProps } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiTooltip } from '~/components/ui/Tooltip'
import { UiSkeleton } from '~/components/ui/Skeleton'
import type { AiInlineStatus } from '~/utils/aiInline'
import { buttonState } from '~/composables/useAiInline'

export interface AiInlineButtonProps extends UiButtonProps {
  status: AiInlineStatus | null
  /** 진행 중(누를 수 없음) */
  busy?: boolean
  children?: ReactNode
}

/** AI 진입 버튼 — 모듈 꺼짐이면 그리지 않고, 쓸 수 없으면 비활성 + 이유 툴팁 */
export function AiInlineButton({ status, busy, disabled, children, ...rest }: AiInlineButtonProps) {
  const { t } = useI18n()
  const st = buttonState(status)
  if (st === 'hidden') return null
  if (st === 'disabled') {
    const why = t(`aiInline.reason.${status?.reason || 'not_configured'}`)
    return (
      <UiTooltip text={why}>
        <UiButton {...rest} disabled title={why}>{children}</UiButton>
      </UiTooltip>
    )
  }
  return <UiButton {...rest} disabled={busy || disabled} aria-busy={busy || undefined}>{children}</UiButton>
}

/** 진행 — 스켈레톤 + 한 줄(스크린리더에 알림) */
export function AiInlineLoading({ label, rows = 3, className }: { label: string; rows?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)} aria-busy="true">
      <p role="status" className="m-0 flex items-center gap-1.5 text-xs text-muted-foreground">
        <UiIcon name="sparkles" className="h-3.5 w-3.5 animate-pulse text-primary" />{label}
      </p>
      <UiSkeleton preset="text" rows={rows} />
    </div>
  )
}

/** 오류 — 메시지 + [다시 시도] */
export function AiInlineErrorLine({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
  const { t } = useI18n()
  return (
    <div role="alert" className={cn('flex flex-wrap items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[13px]', className)}>
      <UiIcon name="alert-triangle" className="h-4 w-4 text-danger" />
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry && <UiButton size="xs" variant="outline" onClick={onRetry}>{t('aiInline.retry')}</UiButton>}
    </div>
  )
}

/** 외부 AI 안내 — 외부 제공자일 때만. 가리기가 켜져 있으면 무엇을 가리는지 */
export function AiInlinePrivacy({ status, className }: { status: AiInlineStatus | null; className?: string }) {
  const { t } = useI18n()
  if (!status?.external) return null
  return (
    <p className={cn('m-0 flex items-start gap-1.5 text-xs text-muted-foreground', className)}>
      <UiIcon name="shield" className="mt-px h-3.5 w-3.5 shrink-0" />
      <span>{t(status.mask_pii ? 'aiInline.privacyMasked' : 'aiInline.privacyExternal', { model: status.model })}</span>
    </p>
  )
}

/** 꼬리표 "AI 생성 · [모델] · 원문과 다를 수 있습니다" */
export function AiInlineFoot({ model, extra, className }: { model: string; extra?: ReactNode; className?: string }) {
  const { t } = useI18n()
  return (
    <p className={cn('m-0 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground', className)}>
      <UiIcon name="sparkles" className="h-3.5 w-3.5" />
      <span>{t('aiInline.generated')} · <span className="font-mono">{model || '—'}</span> · {t('aiInline.mayDiffer')}</span>
      {extra}
    </p>
  )
}
