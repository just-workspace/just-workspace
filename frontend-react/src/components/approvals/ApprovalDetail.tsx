/**
 * 승인 대기함 상세 — 데스크톱 오른쪽 · 만료 · 모바일 상세.
 *  머리(아이콘·제목·위험도·요청 ID) → 요청 출처·도구·대상·요청 시각·만료 → 직전 외부 읽기 경고 → 변경 내용 → 전체 인자
 *  → 대기 상태이면 [거부 사유(선택, AI 에게 전달)][거부][승인], 처리 완료이면 결과 줄(+ 되돌리기).
 * 남은 시간은 서버 시각 기준(offset). 버튼 동작의 API 호출은 부모가 담당한다.
 */
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiInput } from '~/components/ui/Input'
import { useNowTick } from '~/composables/useNowTick'
import { ApprovalExternalWarning, ApprovalPreviewRows, clientLabel, sourceLabel } from '~/components/approvals/ApprovalParts'
import {
  approvalIcon, canUndoNow, clockTime, dateTime, effectiveStatus, formatCountdown, prettyArgs, remainingMs, statusTone,
  type ApprovalRequest, type ApprovalStatus,
} from '~/utils/approvals'

type T = (k: string, v?: Record<string, unknown>) => string

/** 상태 이름(실행됨 중 사람이 승인한 건은 "승인됨") */
export function statusLabel(t: T, req: Pick<ApprovalRequest, 'status' | 'decided_at' | 'risk' | 'source'>, s: ApprovalStatus = req.status): string {
  if (s === 'executed' && req.decided_at && (req.risk === 'high' || req.source === 'mcp')) return t('approvals.status.approved')
  return t(`approvals.status.${s}`)
}

export interface ApprovalDetailProps {
  req: ApprovalRequest
  /** 서버 시각 − 클라이언트 시각 */
  offset: number
  /** 처리자 이름 */
  userName: string
  reason: string
  onReason: (v: string) => void
  busy?: string | null
  onApprove?: () => void
  onReject?: () => void
  onUndo?: () => void
  /** 모바일 — 머리는 상세 바가 담당하고, 행동은 하단 고정 2칸 */
  mobile?: boolean
  className?: string
}

export function ApprovalDetail({ req, offset, userName, reason, onReason, busy, onApprove, onReject, onUndo, mobile, className }: ApprovalDetailProps) {
  const { t, locale } = useI18n()
  useNowTick(req.status === 'pending' || (req.status === 'executed' && !!req.can_undo))
  const now = Date.now()
  const status = effectiveStatus(req, offset, now)
  const left = remainingMs(req.expires_at, offset, now)
  const undoLeft = remainingMs(req.undo_until, offset, now)
  const undoable = canUndoNow(req, offset, now)
  const isPending = status === 'pending'
  const isHigh = req.risk === 'high'
  const where = `${sourceLabel(t, req)} · `

  const rows = (
    <dl className={cn('grid gap-x-3.5 gap-y-2.5 text-[13.5px] leading-[21px]', mobile ? 'grid-cols-[84px_minmax(0,1fr)]' : 'grid-cols-[112px_minmax(0,1fr)]')}>
      <dt className="text-muted-foreground">{t('approvals.field.source')}</dt>
      <dd className="min-w-0 break-words">{where}<span className="font-semibold">{clientLabel(t, req)}</span></dd>
      {!mobile && (
        <>
          <dt className="text-muted-foreground">{t('approvals.field.tool')}</dt>
          <dd className="min-w-0 break-all font-mono">{req.tool}</dd>
        </>
      )}
      <dt className="text-muted-foreground">{t('approvals.field.target')}</dt>
      <dd className="min-w-0 break-words">{req.target_summary || req.title}</dd>
      <dt className="text-muted-foreground">{t('approvals.field.requestedAt')}</dt>
      <dd className="font-mono">{dateTime(req.created_at)}</dd>
      <dt className="text-muted-foreground">{t('approvals.field.expires')}</dt>
      <dd>
        {isPending
          ? <><span className={cn('font-mono', left !== null && left < 10 * 60_000 && 'text-warning')}>{formatCountdown(left)}</span> {t('approvals.detail.left')}</>
          : <span className="font-mono">{dateTime(req.expires_at, false)}</span>}
      </dd>
    </dl>
  )

  return (
    <section aria-label={t('approvals.detail.label')} className={cn('flex min-w-0 flex-col', !mobile && 'overflow-hidden rounded-xl border border-border bg-card', className)}>
      {!mobile ? (
        <header className="flex flex-wrap items-center gap-2.5 border-b border-border px-5 py-4">
          <UiIcon name={approvalIcon(req.tool)} className={cn('h-5 w-5', isPending ? (isHigh ? 'text-danger' : 'text-warning') : 'text-muted-foreground')} />
          <h2 className="m-0 text-[17px] font-semibold">{req.title}</h2>
          <UiBadge tone={isHigh ? 'danger' : 'success'} tint size={18}>{isHigh ? 'high' : 'low'}</UiBadge>
          {!isPending && <UiBadge tone={statusTone(status)} tint={status === 'expired'} size={18}>{statusLabel(t, req, status)}</UiBadge>}
          <span className="flex-1" />
          <span className="font-mono text-xs text-muted-foreground">{req.id}</span>
        </header>
      ) : (
        <div className="flex flex-wrap items-center gap-2 px-4 pt-4">
          <UiBadge tone={isHigh ? 'danger' : 'success'} tint size={18}>{isHigh ? 'high' : 'low'}</UiBadge>
          {!isPending && <UiBadge tone={statusTone(status)} tint={status === 'expired'} size={18}>{statusLabel(t, req, status)}</UiBadge>}
          <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">{req.tool} · {req.id}</span>
        </div>
      )}

      <div className={cn('flex flex-col gap-4', mobile ? 'px-4 py-4' : 'px-5 py-4')}>
        {rows}
        <ApprovalExternalWarning req={req} />
        {!!req.preview?.length && (
          <div className="flex flex-col gap-2">
            <span className="text-[12.5px] font-semibold text-muted-foreground">{t('approvals.detail.changes')}</span>
            <ApprovalPreviewRows rows={req.preview} className="rounded-lg border border-border px-3.5 py-3" />
          </div>
        )}
        <div className="flex flex-col gap-2">
          <span className="text-[12.5px] font-semibold text-muted-foreground">{t('approvals.detail.args')}</span>
          <pre className={cn('m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background px-3.5 py-3 font-mono leading-5', mobile ? 'text-[11.5px] leading-[18px]' : 'text-[12.5px]')}>{prettyArgs(req.args)}</pre>
        </div>
        {status === 'rejected' && req.reject_reason && (
          <p className="m-0 text-[13px] text-muted-foreground">{t('approvals.card.rejectReason', { reason: req.reject_reason })}</p>
        )}
        {status === 'failed' && req.error && (
          <p role="alert" className="m-0 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[13px]">{req.error}</p>
        )}
      </div>

      {isPending ? (
        <footer className={cn('mt-auto border-t border-border', mobile ? 'sticky bottom-0 flex flex-col gap-2.5 bg-card px-4 pb-4 pt-3' : 'flex flex-wrap items-end gap-2.5 bg-background/40 px-5 py-3.5')}>
          <div className={mobile ? '' : 'flex-1 basis-64'}>
            <UiInput label={t('approvals.detail.reasonLabel')} placeholder={t('approvals.detail.reasonPlaceholder')} modelValue={reason} onUpdateModelValue={onReason} maxLength={1000} />
          </div>
          <div className={mobile ? 'grid grid-cols-2 gap-2' : 'flex gap-2.5'}>
            <UiButton variant="outline" icon="ban" size={mobile ? 'lg' : 'default'} className={mobile ? 'px-2' : ''} disabled={!!busy} onClick={onReject}>
              {busy === 'reject' ? t('approvals.detail.rejecting') : t('approvals.detail.reject')}
            </UiButton>
            <UiButton icon="check" size={mobile ? 'lg' : 'default'} className={mobile ? 'px-2' : ''} disabled={!!busy} onClick={onApprove}>
              {busy === 'approve' ? t('approvals.detail.approving') : (mobile ? t('approvals.detail.approveShort') : t('approvals.detail.approve'))}
            </UiButton>
          </div>
        </footer>
      ) : (
        <footer className={cn('mt-auto flex flex-wrap items-center gap-2.5 border-t border-border text-[13px] text-muted-foreground', mobile ? 'px-4 py-3.5' : 'px-5 py-3.5')}>
          {status === 'expired' ? (
            <span className="flex-1">{t(isHigh || req.source === 'mcp' ? 'approvals.detail.expiredNoteHigh' : 'approvals.detail.expiredNote')}</span>
          ) : (
            <>
              <UiBadge tone={statusTone(status)} size={18}>{statusLabel(t, req, status)}</UiBadge>
              <span className="flex-1 basis-52">
                {status === 'canceled' || status === 'rejected' || status === 'executed' || status === 'failed' || status === 'undone'
                  ? <>{t('approvals.detail.handledBy', { name: userName })} · <span className="font-mono">{clockTime(req.decided_at || req.executed_at, true, locale)}</span></>
                  : null}
                {req.source === 'ai' && req.conversation_id && isHigh && status !== 'undone' && <> · {t('approvals.detail.reportedBack')}</>}
              </span>
              {undoable && onUndo && (
                <UiButton variant="ghost" size="xs" icon="rotate-ccw" disabled={!!busy} onClick={onUndo}>
                  {t('approvals.card.undo')} <span className="ml-1 font-mono">{formatCountdown(undoLeft)}</span>
                </UiButton>
              )}
            </>
          )}
        </footer>
      )}
    </section>
  )
}

export default ApprovalDetail
