/**
 * 관리 › 사용자 데스크톱 표(표).
 * 선택 항목이 있으면 표 헤더에 일괄 바(AdminUsersBulkBar)가 부착되고 표 상단 모서리의 둥글림이 제거된다.
 * th 36 11/600 · 행 48 · 이름/마지막 접속 ▲▼ 정렬 · 체크 40 · ⋮ 40. 상태 = 틴트 배지(+ 관리자 배지).
 */
import type { ReactNode } from 'react'
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiIcon } from '~/components/ui/Icon'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiBadge } from '~/components/ui/Badge'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { fmtLast, groupNames, initialOf, nameOf, statusMeta, statusOf, type AdminUser, type UserSortKey } from './adminUsers'

export interface AdminUsersTableProps {
  /** 현재 페이지의 사용자 */
  users: AdminUser[]
  /** 선택된 id 집합 */
  selected: Set<string>
  /** 정렬 열 · 방향(1 오름 · -1 내림) */
  sortKey: UserSortKey
  sortDir: 1 | -1
  /** 행 ⋮ 메뉴 항목(userMenuItems — 상태·본인 여부에 따라) */
  menuItems: (u: AdminUser) => UiMenuItem[]
  /** 표 헤더에 부착되는 일괄 바(선택 항목이 있을 때만 전달) */
  bulkBar?: ReactNode
  /** 열 헤더 정렬 클릭 */
  onSort?: (k: UserSortKey) => void
  /** 전체 선택(보이는 행) */
  onToggleAll?: (v: boolean) => void
  /** 행 1개 선택 */
  onToggleOne?: (id: string, v: boolean) => void
  /** ⋮ 메뉴 항목 선택 */
  onMenu?: (u: AdminUser, key: string) => void
}

export function AdminUsersTable({ users, selected, sortKey, sortDir, menuItems, bulkBar, onSort, onToggleAll, onToggleOne, onMenu }: AdminUsersTableProps) {
  const { t } = useI18n()
  const STATUS = statusMeta(t)
  const allVisibleSelected = users.length > 0 && users.every(u => selected.has(u.id))
  const someSelected = selected.size > 0 && !allVisibleSelected
  const ariaSort = (k: UserSortKey) => sortKey === k ? (sortDir === 1 ? 'ascending' : 'descending') : 'none'

  return (
    <div className="hidden md:block">
      {/* 일괄 바(선택 시 표 헤더에 부착) */}
      {selected.size > 0 && bulkBar}

      <div className={cn('overflow-hidden border border-border', selected.size ? 'rounded-b-lg' : 'rounded-lg')}>
        <table className="w-full table-fixed text-[13px]">
          <colgroup>
            <col className="w-10" /><col className="w-[22%]" /><col /><col className="w-[15%]" /><col className="w-[11%]" /><col className="w-[12%]" /><col className="w-12" />
          </colgroup>
          <thead>
            <tr className="h-9 border-b border-border bg-card text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">
              <th scope="col" className="px-0">
                <span className="grid place-items-center">
                  <UiCheckbox modelValue={allVisibleSelected} indeterminate={someSelected} size={16} ariaLabel={t('admin.users.selectAllVisible')} onUpdateModelValue={v => onToggleAll?.(v)} />
                </span>
              </th>
              <th scope="col" aria-sort={ariaSort('name')}>
                <button type="button" className={cn('inline-flex h-9 items-center gap-1 hover:text-foreground', sortKey === 'name' ? 'text-foreground' : '')} onClick={() => onSort?.('name')}>
                  {t('admin.users.colName')} <UiIcon name={sortKey === 'name' && sortDir === -1 ? 'chevron-down' : 'chevron-up'} className={cn('h-3 w-3', sortKey === 'name' ? 'text-primary' : 'opacity-40')} />
                </button>
              </th>
              <th scope="col">{t('admin.users.table.email')}</th>
              <th scope="col">{t('admin.users.colGroup')}</th>
              <th scope="col">{t('admin.users.table.status')}</th>
              <th scope="col" aria-sort={ariaSort('last')}>
                <button type="button" className={cn('inline-flex h-9 items-center gap-1 hover:text-foreground', sortKey === 'last' ? 'text-foreground' : '')} onClick={() => onSort?.('last')}>
                  {t('admin.users.colLastSeen')} <UiIcon name={sortKey === 'last' && sortDir === 1 ? 'chevron-up' : 'chevron-down'} className={cn('h-3 w-3', sortKey === 'last' ? 'text-primary' : 'opacity-40')} />
                </button>
              </th>
              <th scope="col"><span className="sr-only">{t('common.menu')}</span></th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr
                key={u.id}
                className={cn('h-12 border-b border-border last:border-b-0', selected.has(u.id) ? 'bg-primary/[0.13]' : 'hover:bg-accent/40')}
              >
                <td className="px-0">
                  <span className="grid place-items-center">
                    <UiCheckbox modelValue={selected.has(u.id)} size={16} ariaLabel={t('admin.users.selectUser', { name: nameOf(u) })} onUpdateModelValue={v => onToggleOne?.(u.id, v)} />
                  </span>
                </td>
                <td>
                  <span className="flex min-w-0 items-center gap-2.5 pr-2">
                    <UiAvatar src={u.avatar_url} alt={nameOf(u)} fallback={initialOf(u)} className="h-7 w-7 shrink-0 text-[11px]" />
                    <span className="truncate text-foreground">{nameOf(u)}</span>
                  </span>
                </td>
                <td className="pr-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-muted-foreground">{u.email || u.recovery_email || '—'}</span>
                    {u.email_verified === false && <UiBadge tone="warning" tint size={18}>{t('admin.users.emailUnverified')}</UiBadge>}
                  </span>
                </td>
                <td className="truncate pr-2 text-foreground">{groupNames(u) || '—'}</td>
                <td>
                  <UiBadge tone={STATUS[statusOf(u)].tone} tint>{STATUS[statusOf(u)].label}</UiBadge>
                  {u.is_admin && <UiBadge tone="primary" tint size={18} className="ml-1">{t('common.role.admin')}</UiBadge>}
                </td>
                <td className="font-mono text-[11px] text-muted-foreground">{fmtLast(u.last_login_at, t)}</td>
                <td>
                  <span className="grid place-items-center">
                    <UiMenu triggerIcon="more-vertical" label={t('admin.users.rowMenuFull', { name: nameOf(u) })} items={menuItems(u)} onSelect={k => onMenu?.(u, k)} />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default AdminUsersTable
