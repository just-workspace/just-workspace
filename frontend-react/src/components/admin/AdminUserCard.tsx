/**
 * 관리 › 사용자 모바일 카드 한 장 — 아바타 36 · 이름 15/600 + 상태 배지 · 이메일 · ⋮ 40,
 * 승인 대기면 아래에 [승인][거절] 40. Vue pages/admin/users.vue 의 "모바일 카드 스택" 한 항목.
 */
import { useI18n } from '~/i18n'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiBadge } from '~/components/ui/Badge'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { initialOf, nameOf, statusMeta, statusOf, type AdminUser } from './adminUsers'

export interface AdminUserCardProps {
  /** 사용자 */
  user: AdminUser
  /** ⋮ 메뉴 항목 */
  menuItems: UiMenuItem[]
  /** 처리 중([승인][거절] 비활성) */
  busy: boolean
  onMenu?: (key: string) => void
  onApprove?: () => void
  onReject?: () => void
}

export function AdminUserCard({ user: u, menuItems, busy, onMenu, onApprove, onReject }: AdminUserCardProps) {
  const { t } = useI18n()
  const st = statusMeta(t)[statusOf(u)]
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-card py-3 pl-3.5 pr-1">
      <div className="flex items-center gap-3">
        <UiAvatar src={u.avatar_url} alt={nameOf(u)} fallback={initialOf(u)} className="h-9 w-9 shrink-0 text-[13px]" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 text-[15px] font-semibold text-foreground">
            <span className="truncate">{nameOf(u)}</span>
            <UiBadge tone={st.tone} tint size={18} className="h-5">{st.label}</UiBadge>
          </div>
          <div className="truncate text-[13px] text-muted-foreground">{u.email || u.recovery_email || '—'}</div>
        </div>
        <UiMenu triggerIcon="more-vertical" triggerSize="md" label={t('admin.common.rowMenu', { name: nameOf(u) })} items={menuItems} onSelect={k => onMenu?.(k)} />
      </div>
      {statusOf(u) === 'pending' && (
        <div className="flex gap-2 pr-2.5">
          <button type="button" className="flex h-10 flex-1 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-50" disabled={busy} onClick={() => onApprove?.()}>{t('admin.users.approve')}</button>
          <button type="button" className="flex h-10 flex-1 items-center justify-center rounded-md border border-border text-sm text-danger disabled:opacity-50" disabled={busy} onClick={() => onReject?.()}>{t('admin.users.reject')}</button>
        </div>
      )}
    </div>
  )
}

export default AdminUserCard
