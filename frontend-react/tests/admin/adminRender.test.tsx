// 관리 화면 조각 렌더 — 사용자 표·일괄 바·분석 카드
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { i18n } from '~/i18n'
import { AdminUsersTable } from '~/components/admin/AdminUsersTable'
import { AdminUsersBulkBar } from '~/components/admin/AdminUsersBulkBar'
import { AdminAnalyticsOverview } from '~/components/admin/AdminAnalyticsOverview'
import { AdminAnalyticsRecentLogins } from '~/components/admin/AdminAnalyticsRecentLogins'
import { AdminPageShell } from '~/components/admin/AdminPageShell'
import type { AdminUser } from '~/components/admin/adminUsers'

const t = (k: string, p?: any) => i18n.t(k, p)
const users: AdminUser[] = [
  { id: 'a', username: 'kim', display_name: '김', email: 'k@x.io', recovery_email: null, is_admin: true, is_active: true, created_at: null, status: 'active', email_verified: false },
  { id: 'b', username: 'lee', display_name: null, email: null, recovery_email: null, is_admin: false, is_active: false, created_at: null, status: 'pending' },
]

describe('AdminUsersTable', () => {
  it('행·배지·정렬·선택', () => {
    const onSort = vi.fn(); const onToggleAll = vi.fn(); const onToggleOne = vi.fn()
    render(<AdminUsersTable users={users} selected={new Set()} sortKey="name" sortDir={1} menuItems={() => []} onSort={onSort} onToggleAll={onToggleAll} onToggleOne={onToggleOne} />)
    expect(screen.getAllByText('김').length).toBeGreaterThan(0)
    expect(screen.getByText('lee')).toBeTruthy()
    expect(screen.getByText(t('admin.users.emailUnverified'))).toBeTruthy()
    expect(screen.getByText(t('admin.users.tabs.pending'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('admin.users.colLastSeen')) }))
    expect(onSort).toHaveBeenCalledWith('last')
    fireEvent.click(screen.getByLabelText(t('admin.users.selectAllVisible')))
    expect(onToggleAll).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByLabelText(t('admin.users.selectUser', { name: 'lee' })))
    expect(onToggleOne).toHaveBeenCalledWith('b', true)
  })

  it('선택이 있으면 일괄 바를 표 머리에 붙인다', () => {
    const onApprove = vi.fn()
    render(
      <AdminUsersTable
        users={users}
        selected={new Set(['b'])}
        sortKey="name"
        sortDir={1}
        menuItems={() => []}
        bulkBar={<AdminUsersBulkBar count={1} busy={false} canApprove canReject hasGroups={false} onApprove={onApprove} />}
      />,
    )
    expect(screen.getByRole('toolbar')).toBeTruthy()
    expect(screen.getByText(t('admin.users.selectedCount', { n: 1 }))).toBeTruthy()
    expect((screen.getByRole('button', { name: t('admin.users.addToGroup') }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: t('admin.users.approve') }))
    expect(onApprove).toHaveBeenCalledOnce()
  })
})

describe('분석 카드·틀', () => {
  it('요약 4칸·최근 로그인 IP 가림', () => {
    render(<AdminAnalyticsOverview data={{ total_visits: 1234, unique_ips: 5, authenticated_visits: 6, unauthenticated_visits: 1, avg_response_time_ms: 42 }} />)
    expect(screen.getByText('1,234')).toBeTruthy()
    expect(screen.getByText('42ms')).toBeTruthy()
    render(<AdminAnalyticsRecentLogins data={[{ user_id: 'x', username: 'kim', display_name: null, ip_address: '192.168.10.9', login_at: '' }]} />)
    expect(screen.getByText('192.168.x.x')).toBeTruthy()
  })
  it('AdminPageShell — 제목·부제·행동', () => {
    render(<AdminPageShell title="사용자" subtitle="부제" actions={<button type="button">초대</button>}>본문</AdminPageShell>)
    expect(screen.getByRole('heading', { name: '사용자' })).toBeTruthy()
    expect(screen.getAllByText('부제').length).toBe(2)
    expect(screen.getByRole('button', { name: '초대' })).toBeTruthy()
  })
})
