/**
 * 승인 카드(A1·A2)·승인 대기함(B1·B2)이 같이 쓰는 조각 — 미리보기 줄, 직전 외부 읽기 경고, 요청한 곳 이름.
 */
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { UiIcon } from '~/components/ui/Icon'
import { clockTime, previewValue, type ApprovalPreviewRow, type ApprovalRequest } from '~/utils/approvals'

type T = (k: string, v?: Record<string, unknown>) => string

/** 요청한 곳(종류) — 내장 AI · AI 커넥터 · 개인 토큰 */
export function sourceLabel(t: T, req: Pick<ApprovalRequest, 'source' | 'client_kind'>): string {
  if (req.client_kind === 'claude_app') return t('approvals.source.mcp')
  if (req.client_kind === 'personal_token') return t('approvals.source.token')
  if (req.source === 'ai' || req.client_kind === 'builtin_web' || req.client_kind === 'builtin_desktop') return t('approvals.source.ai')
  return t('approvals.source.mcp')
}

/** 클라이언트 이름 — 없으면 종류로 */
export function clientLabel(t: T, req: Pick<ApprovalRequest, 'client_name' | 'client_kind'>): string {
  if (req.client_name) return req.client_name
  if (req.client_kind === 'builtin_desktop') return t('approvals.client.desktop')
  if (req.client_kind === 'builtin_web') return t('approvals.client.web')
  return t('approvals.client.unknown')
}

/** 미리보기(diff) 줄 — {field,label,before,after}. before 가 없으면 "+ 값"(추가), 있으면 "이전 → 이후" */
export function ApprovalPreviewRows({ rows, target, targetLabel, className }: {
  rows: ApprovalPreviewRow[]
  /** 맨 위 "대상" 줄 */
  target?: string | null
  targetLabel?: string
  className?: string
}) {
  const { t } = useI18n()
  return (
    <dl className={cn('grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[13.5px] leading-[21px]', className)}>
      {target && (
        <>
          <dt className="text-muted-foreground">{targetLabel ?? t('approvals.field.target')}</dt>
          <dd className="min-w-0 break-words">{target}</dd>
        </>
      )}
      {rows.map(r => {
        const before = previewValue(r.before)
        const after = previewValue(r.after)
        return (
          <div key={r.field} className="contents">
            <dt className="truncate text-muted-foreground">{r.label}</dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words">
              {before ? (
                <>
                  <span className="text-muted-foreground line-through">{before}</span>
                  <span aria-hidden="true" className="px-1 text-muted-foreground">→</span>
                  <span className="sr-only">{t('approvals.preview.changedTo')}</span>
                  <span className="text-success">{after}</span>
                </>
              ) : (
                <span className="text-success"><span aria-hidden="true">+ </span><span className="sr-only">{t('approvals.preview.added')} </span>{after}</span>
              )}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

/** 직전 외부 읽기 경고(B1 상세) — read_external 이 있거나 after_untrusted 일 때 */
export function ApprovalExternalWarning({ req, compact, className }: { req: ApprovalRequest; compact?: boolean; className?: string }) {
  const { t, locale } = useI18n()
  const ext = req.read_external
  if (!ext && !req.after_untrusted) return null
  const at = clockTime(ext?.at, false, locale)
  const parts = [
    ext?.label || '',
    ext?.from ? t('approvals.external.from', { from: ext.from }) : '',
    ext?.subject ? t('approvals.external.subject', { subject: ext.subject }) : '',
  ].filter(Boolean)
  return (
    <div role="note" className={cn('flex gap-2.5 rounded-[10px] border border-warning/50 bg-warning/10 px-3.5 py-3 text-[13px] leading-5', className)}>
      <UiIcon name="alert-triangle" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-semibold">{t('approvals.external.title')}</span>
        {/* 자동 수락·허용 규칙인데도 묻는 까닭 한 줄 — 남에게 보이는 쓰기 관문(서버 ask_reason) */}
        {req.ask_reason === 'visible_after_untrusted' && (
          <span className="break-words">{t('approvals.external.visibleGate', '외부 내용을 읽은 뒤라 확인합니다. 다른 사람에게 보이는 작업은 자동 수락·허용 규칙이 있어도 묻습니다.')}</span>
        )}
        {(!!parts.length || at) && (
          <span className="break-words text-muted-foreground">
            {at && <span className="font-mono">{at}</span>}{at && !!parts.length && ' '}{parts.join(' · ')}
          </span>
        )}
        {!compact && <span className="text-muted-foreground">{t('approvals.external.hint')}</span>}
      </div>
    </div>
  )
}
