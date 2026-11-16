/**
 * 관리 › 사용자 일괄 바 — 선택 시 표 헤더에 부착되는 40 높이 바: n명 선택 · [승인] · [그룹에 추가] · [거절] · ✕.
 */
import { useI18n } from '~/i18n'
import { UiIconButton } from '~/components/ui/IconButton'

export interface AdminUsersBulkBarProps {
  /** 선택한 사용자 수 */
  count: number
  /** 처리 중(버튼 전부 비활성) */
  busy: boolean
  /** 승인 가능한 사용자 존재 여부(활성 상태가 아닌 사용자) */
  canApprove: boolean
  /** 거절 가능한 사용자 존재 여부(승인 대기) */
  canReject: boolean
  /** 그룹 존재 여부(없으면 [그룹에 추가] 비활성) */
  hasGroups: boolean
  onApprove?: () => void
  onAddToGroup?: () => void
  onReject?: () => void
  /** 선택 해제 */
  onClear?: () => void
}

export function AdminUsersBulkBar({ count, busy, canApprove, canReject, hasGroups, onApprove, onAddToGroup, onReject, onClear }: AdminUsersBulkBarProps) {
  const { t } = useI18n()
  return (
    <div
      className="-mb-px flex h-10 items-center gap-2.5 rounded-t-lg border border-primary/35 bg-primary/10 px-3 text-[13px]"
      role="toolbar"
      aria-label={t('admin.users.bulkAria')}
    >
      <b className="font-semibold text-foreground">{t('admin.users.selectedCount', { n: count })}</b>
      <button type="button" className="inline-flex h-7 items-center rounded-sm bg-primary px-2.5 text-xs font-semibold text-primary-foreground disabled:opacity-50" disabled={busy || !canApprove} onClick={() => onApprove?.()}>{t('admin.users.approve')}</button>
      <button type="button" className="inline-flex h-7 items-center rounded-sm border border-border bg-card px-2.5 text-xs text-foreground hover:bg-accent disabled:opacity-50" disabled={busy || !hasGroups} onClick={() => onAddToGroup?.()}>{t('admin.users.addToGroup')}</button>
      <button type="button" className="inline-flex h-7 items-center rounded-sm px-2.5 text-xs font-semibold text-danger hover:bg-danger/10 disabled:opacity-50" disabled={busy || !canReject} onClick={() => onReject?.()}>{t('admin.users.reject')}</button>
      <span className="flex-1" />
      <UiIconButton label={t('admin.users.clearSelection')} icon="close" onClick={() => onClear?.()} />
    </div>
  )
}

export default AdminUsersBulkBar
