/**
 * 관리 › 사용자 —
 * 헤더 [전체 강제 로그아웃][사용자 초대], 표 위 검색 260 + 상태 칩(승인 대기 n = warning) + 그룹 선택,
 * 선택하면 표 머리에 붙는 일괄 바(AdminUsersBulkBar), 표(AdminUsersTable), 모바일은 카드 스택(AdminUserCard).
 *
 * 서버 연결:
 *   목록 = GET /admin/users?q&status(쉼표 여럿)&role&group&sort&page&size → {users,total,page,size} — 검색·필터·정렬·페이지 전부 서버.
 *   상태 = 행의 status(active·pending·suspended). 칩 숫자(승인 대기)는 운영 요약(ops-summary).
 *   일괄·단건 승인/거절/정지/그룹 추가 = POST /admin/users/bulk(사람마다 결과).
 *   삭제 = ⋮ › 삭제 → AdminUserDeleteModal(delete-impact → 넘겨받을 사람 → 사용자명 입력).
 *   초대 = AdminInviteModal(이메일 여러 개·링크 복사·만료·그룹 + 보낸 초대 목록·회수).
 * 예전처럼 "승인 대기를 늘 맨 위" 정렬은 서버 페이지와 맞지 않아 뺐다 — 승인 대기 칩으로 본다.
 */
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { $fetch } from '~/lib/api'
import { navigateTo, useRoute } from '~/lib/router'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useAuth } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import { alertBox, confirmBox } from '~/composables/useDialog'
import { useAdminOps } from '~/composables/useAdminOps'
import { useIsMobile } from '~/composables/useIsMobile'
import { AdminPageShell } from '~/components/admin/AdminPageShell'
import { AdminUsersTable } from '~/components/admin/AdminUsersTable'
import { AdminUsersBulkBar } from '~/components/admin/AdminUsersBulkBar'
import { AdminUserCard } from '~/components/admin/AdminUserCard'
import { AdminUserSessionsModal } from '~/components/admin/AdminUserSessionsModal'
import { AdminUserDeleteModal } from '~/components/admin/AdminUserDeleteModal'
import { AdminInviteModal } from '~/components/admin/AdminInviteModal'
import {
  PAGE_SIZE, deviceHint, nameOf, nextSort, rangeText, serverSort, statusOf, userListParams, userMenuItems,
  type AdminSessionInfo, type AdminUser, type AdminUserGroup, type UserSortKey,
} from '~/components/admin/adminUsers'
import { UiButton } from '~/components/ui/Button'
import { UiInput } from '~/components/ui/Input'
import { UiChip } from '~/components/ui/Chip'
import { UiSelect } from '~/components/ui/Select'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiModal } from '~/components/ui/Modal'
import { writeClipboard } from '~/lib/clipboard'

interface BulkResult { action: string; ok: number; failed: number; results: { id: string; ok: boolean; error?: string; warning?: string }[] }
interface SessionModalState { open: boolean; user: AdminUser | null; sessions: AdminSessionInfo[]; loading: boolean; error: boolean }

export default function AdminUsersPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: t('admin.common.headTitle', { page: t('admin.users.pageTitle'), app: appName }) })
  const { user } = useAuth()
  const route = useRoute()
  useEffect(() => { if (user && !user.is_admin) void navigateTo('/') }, [user])
  const { ops, refresh: refreshOps } = useAdminOps()
  const isMobile = useIsMobile()

  const [users, setUsers] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)

  // 그룹(필터·일괄 추가·초대용)
  const [groups, setGroups] = useState<AdminUserGroup[]>([])
  async function loadGroups() {
    try { setGroups((await $fetch<{ groups: AdminUserGroup[] }>('/api/admin/groups', { credentials: 'include' })).groups || []) }
    catch { setGroups([]) }
  }

  // ── 검색·필터·정렬(서버) ──
  const [q, setQ] = useState('')
  const [qDebounced, setQDebounced] = useState('')
  const qTouched = useRef(false)
  useEffect(() => {
    // watch(q) — 첫 렌더에는 타이머를 걸지 않는다
    if (!qTouched.current) { qTouched.current = true; return }
    const id = setTimeout(() => setQDebounced(q.trim()), 300)
    return () => clearTimeout(id)
  }, [q])
  const [fPending, setFPending] = useState(route.query.filter === 'pending')
  const [fAdmin, setFAdmin] = useState(false)
  const [fSuspended, setFSuspended] = useState(route.query.filter === 'suspended')
  const [fGroup, setFGroup] = useState<string>('')
  const [sort, setSort] = useState<{ key: UserSortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const sortParam = serverSort(sort.key, sort.dir)

  const params = userListParams({ q: qDebounced, pending: fPending, admin: fAdmin, suspended: fSuspended, group: fGroup }, sortParam, page)
  // 이벤트 처리기(일괄 뒤 다시 읽기 등)가 "지금" 쿼리를 쓰도록
  const paramsRef = useRef(params)
  paramsRef.current = params

  const loadSeq = useRef(0)
  async function load() {
    const seq = ++loadSeq.current
    setLoading(true); setLoadError(false)
    try {
      const r = await $fetch<{ users: AdminUser[]; total: number; page: number } | AdminUser[]>('/api/admin/users', { params: paramsRef.current })
      if (seq !== loadSeq.current) return
      if (Array.isArray(r)) { setUsers(r); setTotal(r.length) } // 예전 서버
      else { const list = r.users || []; setUsers(list); setTotal(r.total ?? list.length) }
    } catch { if (seq === loadSeq.current) setLoadError(true) } finally { if (seq === loadSeq.current) setLoading(false) }
  }
  async function reloadAll() { await Promise.all([load(), loadGroups()]); void refreshOps() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reloadAll() }, [])

  // 거르는 조건이 바뀌면 1쪽부터 / 쪽이 바뀌면 다시 읽기 (둘 다 첫 실행은 건너뜀)
  const filterKey = JSON.stringify([qDebounced, fPending, fAdmin, fSuspended, fGroup, sortParam])
  const prevFilterKey = useRef(filterKey)
  const prevPage = useRef(page)
  useEffect(() => {
    const filterChanged = prevFilterKey.current !== filterKey
    const pageChanged = prevPage.current !== page
    prevFilterKey.current = filterKey
    prevPage.current = page
    if (filterChanged) {
      clearSel()
      if (page !== 1) { setPage(1); return } // 쪽 변경이 다시 읽는다
      void load()
    } else if (pageChanged) {
      clearSel(); void load()
    }
  }, [filterKey, page])

  const counts = { pending: ops.users?.pending ?? ops.pending ?? 0 }
  const groupOptions = [{ value: '', label: t('admin.users.groupAll') }, ...groups.map(g => ({ value: g.id, label: t('admin.users.groupPrefix', { name: g.name }) }))]
  const visible = users
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  function sortBy(k: UserSortKey) { setSort(cur => nextSort(cur, k)) }

  // ── 선택 · 일괄 ──
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const selectedUsers = users.filter(u => selected.has(u.id))
  function toggleOne(id: string, v: boolean) {
    setSelected((cur) => {
      const s = new Set(cur)
      if (v) s.add(id)
      else s.delete(id)
      return s
    })
  }
  function toggleAll(v: boolean) { setSelected(v ? new Set(visible.map(u => u.id)) : new Set()) }
  function clearSel() { setSelected(new Set()) }

  const canApprove = selectedUsers.filter(u => statusOf(u) !== 'active')
  const canReject = selectedUsers.filter(u => statusOf(u) === 'pending')

  async function runBulk(list: AdminUser[], action: 'approve' | 'reject' | 'suspend' | 'add_group', verb: string, groupId?: string) {
    if (!list.length) return
    setBusy(true)
    try {
      const r = await $fetch<BulkResult>('/api/admin/users/bulk', { method: 'POST', body: { ids: list.map(u => u.id), action, group_id: groupId } })
      const fails = r.results.filter(x => !x.ok)
      if (fails.length) {
        const who = users.find(u => u.id === fails[0].id)
        addToast('error', t('admin.users.bulkResult', { verb, ok: r.ok, fail: r.failed, first: `${who ? nameOf(who) : fails[0].id}: ${fails[0].error || t('admin.users.failedShort')}` }))
      }
      const warn = r.results.find(x => x.ok && x.warning)
      if (warn) addToast('warning', warn.warning!)
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('admin.users.failedShort'))
    } finally { setBusy(false) }
    clearSel()
    await reloadAll()
  }

  async function bulkApprove() {
    const list = canApprove
    if (!list.length) return
    const unverified = list.filter(u => u.email_verified === false).length
    const msg = unverified ? t('admin.users.unverifiedCount', { n: unverified }) : t('admin.users.approveHint')
    if (!await confirmBox(msg, { title: t('admin.users.bulkApproveTitle', { n: list.length }), confirmLabel: t('admin.users.approve') })) return
    await runBulk(list, 'approve', t('admin.users.approve'))
  }
  async function bulkReject() {
    const list = canReject
    if (!list.length) return
    if (!await confirmBox(t('admin.users.rejectBody'), { title: t('admin.users.bulkRejectTitle', { n: list.length }), confirmLabel: t('admin.users.reject'), danger: true })) return
    await runBulk(list, 'reject', t('admin.users.reject'))
  }

  // 그룹에 추가(작은 모달)
  const [groupPick, setGroupPick] = useState<{ open: boolean; groupId: string | null }>({ open: false, groupId: null })
  async function bulkAddToGroup() {
    const gid = groupPick.groupId
    if (!gid) return
    const list = selectedUsers.filter(u => !(u.groups || []).some(g => g.id === gid))
    setGroupPick(g => ({ ...g, open: false }))
    if (!list.length) { clearSel(); return }
    await runBulk(list, 'add_group', t('admin.users.verbAddGroup'), gid)
  }

  // ── 단건 행동(⋮) ──
  async function approveOne(u: AdminUser) {
    if (u.email_verified === false && !await confirmBox(t('admin.users.confirmApproveUnverified'), { title: t('admin.users.approveOneTitle', { name: nameOf(u) }), confirmLabel: t('admin.users.approve') })) return
    await runBulk([u], 'approve', t('admin.users.approve'))
  }
  async function rejectOne(u: AdminUser) {
    if (!await confirmBox(t('admin.users.rejectBody'), { title: t('admin.users.rejectOneTitle', { name: nameOf(u) }), confirmLabel: t('admin.users.reject'), danger: true })) return
    await runBulk([u], 'reject', t('admin.users.reject'))
  }
  async function suspend(u: AdminUser) {
    if (!await confirmBox(t('admin.users.suspendBody'), { title: t('admin.users.suspendTitle', { name: nameOf(u) }), confirmLabel: t('admin.users.statusSuspended'), danger: true })) return
    await runBulk([u], 'suspend', t('admin.users.statusSuspended'))
  }
  async function toggleAdmin(u: AdminUser) {
    const next = !u.is_admin
    const msg = next ? t('admin.users.confirmGrantAdmin', { name: nameOf(u) }) : t('admin.users.confirmRevokeAdmin', { name: nameOf(u) })
    if (!await confirmBox(msg, { title: next ? t('admin.users.makeAdmin') : t('admin.users.revokeAdmin'), confirmLabel: next ? t('admin.users.assign') : t('admin.users.unassign'), danger: !next })) return
    setBusy(true)
    try { await $fetch(`/api/admin/users/${u.id}/set-role`, { method: 'POST', body: { is_admin: next } }) }
    catch (e: any) { addToast('error', t('admin.users.bulkResult', { verb: t('admin.users.verbRoleChange'), ok: 0, fail: 1, first: `${nameOf(u)}: ${e?.data?.detail || t('admin.users.failedShort')}` })) }
    finally { setBusy(false) }
    await reloadAll()
  }
  async function resendVerification(u: AdminUser) {
    try {
      const r = await $fetch<{ message: string }>(`/api/admin/users/${u.id}/resend-verification`, { method: 'POST' })
      addToast('success', r.message)
    } catch (e: any) { addToast('error', e?.data?.detail || t('admin.users.resendError')) }
  }
  async function issueResetLink(u: AdminUser) {
    if (!await confirmBox(t('admin.users.confirmResetLink'), { title: t('admin.users.resetLink') })) return
    try {
      const r = await $fetch<{ reset_url: string; expires_hours: number }>(`/api/admin/users/${u.id}/password-reset-link`, { method: 'POST' })
      // 복구 이메일까지 잃어버린 사용자를 구제하는 게 목적이라 링크를 직접 건넨다
      try { await writeClipboard(r.reset_url); addToast('success', t('admin.users.resetLinkCopied', { h: r.expires_hours })) }
      catch { await alertBox(r.reset_url) }
    } catch (e: any) { addToast('error', e?.data?.detail || t('admin.users.resetLinkError')) }
  }
  async function reset2fa(u: AdminUser) {
    if (!await confirmBox(
      t('admin.users.reset2faBody', '이 사용자의 2단계 인증과 복구 코드를 지우고, 열려 있는 로그인을 모두 끊습니다. 인증 앱을 잃어버린 본인이 요청했는지 확인하세요.'),
      { title: t('admin.users.reset2faTitle', `${nameOf(u)} — 2단계 인증 초기화`, { name: nameOf(u) }), confirmLabel: t('admin.users.reset2faConfirm', '초기화'), danger: true },
    )) return
    try {
      const r = await $fetch<{ message: string }>(`/api/admin/users/${u.id}/reset-2fa`, { method: 'POST' })
      addToast('success', r.message)
      await reloadAll()
    } catch (e: any) { addToast('error', e?.data?.detail || t('admin.users.reset2faFailed', '2단계 인증을 초기화하지 못했습니다')) }
  }
  async function logoutUser(u: AdminUser) {
    if (!await confirmBox(t('admin.users.logoutBody'), { title: t('admin.users.logoutTitle', { name: nameOf(u) }), confirmLabel: t('auth.logout'), danger: true })) return
    try {
      await $fetch(`/api/admin/users/${u.id}/logout`, { method: 'POST' })
      setSessionModal(m => (m.user?.id === u.id ? { ...m, sessions: [] } : m))
      addToast('success', t('admin.users.loggedOut', { name: nameOf(u) }))
    } catch (e: any) { addToast('error', e?.data?.detail || t('admin.users.logoutFailed')) }
  }
  async function logoutAll() {
    if (!await confirmBox(t('admin.users.logoutAllBody'), { title: t('admin.users.logoutAllTitle'), confirmLabel: t('admin.users.logoutAllConfirm'), danger: true })) return
    try {
      const r = await $fetch<{ users_affected: number }>('/api/admin/sessions/logout-all', { method: 'POST' })
      addToast('success', t('admin.users.logoutAllDone', { n: r.users_affected }))
      setTimeout(() => void navigateTo('/login'), 1200)
    } catch (e: any) { addToast('error', e?.data?.detail || t('admin.users.logoutAllFailed')) }
  }

  // ── 삭제 · 초대 모달 ──
  const [deleting, setDeleting] = useState<AdminUser | null>(null)
  async function onDeleted() { setDeleting(null); await reloadAll() }
  const [inviteOpen, setInviteOpen] = useState(false)

  function onMenu(u: AdminUser, key: string) {
    ({
      approve: () => approveOne(u), reject: () => rejectOne(u), resend: () => resendVerification(u),
      role: () => toggleAdmin(u), sessions: () => openSessions(u), logout: () => logoutUser(u),
      reset: () => issueResetLink(u), reset2fa: () => reset2fa(u), suspend: () => suspend(u), delete: () => { setDeleting(u) },
    } as Record<string, () => unknown>)[key]?.()
  }
  const menuItems = (u: AdminUser) => userMenuItems(u, user?.id, t)

  // ── 세션 모달 ──
  const [sessionModal, setSessionModal] = useState<SessionModalState>({ open: false, user: null, sessions: [], loading: false, error: false })
  async function openSessions(u: AdminUser) {
    setSessionModal({ open: true, user: u, sessions: [], loading: true, error: false })
    try {
      const sessions = (await $fetch<{ sessions: AdminSessionInfo[] }>(`/api/admin/users/${u.id}/sessions`)).sessions
      setSessionModal(m => ({ ...m, sessions }))
    } catch { setSessionModal(m => ({ ...m, error: true })) } finally { setSessionModal(m => ({ ...m, loading: false })) }
  }
  async function revokeSession(s: AdminSessionInfo) {
    if (!await confirmBox(`${s.ip || ''} ${deviceHint(s.ua, t)}`.trim(), { title: t('admin.users.revokeTitle'), confirmLabel: t('auth.logout'), danger: true })) return
    try {
      await $fetch(`/api/admin/sessions/${s.sid}/revoke`, { method: 'POST' })
      setSessionModal(m => ({ ...m, sessions: m.sessions.filter(x => x.sid !== s.sid) }))
    } catch (e: any) { addToast('error', e?.data?.detail || t('admin.users.logoutFailed')) }
  }

  // 부제 = 전체 사용자 수(운영 요약) · 승인 대기 — 운영 요약을 못 받으면 지금 목록 total
  const allUsers = ops.users ? ops.users.active + ops.users.pending + ops.users.suspended : total
  const subtitle = counts.pending
    ? t('admin.users.subtitleWithPending', { n: allUsers, p: counts.pending })
    : t('admin.users.subtitleCount', { n: allUsers })
  const filtered = !!(q.trim() || fPending || fAdmin || fSuspended || fGroup)
  function clearFilters() { setQ(''); setQDebounced(''); setFPending(false); setFAdmin(false); setFSuspended(false); setFGroup('') }

  if (!user?.is_admin) return null

  return (
    <AdminPageShell
      title={t('admin.users.pageTitle')}
      subtitle={subtitle}
      actions={(
        <>
          <UiButton variant="outline" onClick={logoutAll}>{t('admin.users.logoutAllButton')}</UiButton>
          <UiButton onClick={() => setInviteOpen(true)}>{t('admin.users.invite')}</UiButton>
        </>
      )}
    >
      {/* 검색 · 상태 칩 · 그룹 */}
      <div className="flex flex-wrap items-center gap-2">
        <UiInput modelValue={q} onUpdateModelValue={setQ} icon="search" placeholder={t('admin.users.searchPlaceholder')} aria-label={t('admin.users.searchPlaceholder')} type="search" className="w-full sm:w-[260px]" inputClass="h-8 text-xs md:h-8" />
        <div className="flex gap-1.5 overflow-x-auto">
          <UiChip modelValue={fPending} onUpdateModelValue={setFPending} label={t('admin.users.tabs.pending')} count={counts.pending} tone="warning" size={isMobile ? 'lg' : 'md'} />
          <UiChip modelValue={fAdmin} onUpdateModelValue={setFAdmin} label={t('common.role.admin')} size={isMobile ? 'lg' : 'md'} />
          <UiChip modelValue={fSuspended} onUpdateModelValue={setFSuspended} label={t('admin.users.statusSuspended')} size={isMobile ? 'lg' : 'md'} />
        </div>
        {groups.length > 0 && (
          <UiSelect modelValue={fGroup} onUpdateModelValue={v => setFGroup(String(v ?? ''))} options={groupOptions} size="sm" className="w-full sm:w-[180px]" aria-label={t('admin.users.groupAria')} />
        )}
      </div>

      {loading && !users.length && !loadError
        ? <UiSkeleton preset="table" rows={8} framed />
        : loadError
          ? <UiErrorTile placement="panel" title={t('admin.users.loadError')} onRetry={() => void reloadAll()} />
          : !visible.length
            ? (
              <UiEmptyState
                variant="full"
                icon="users"
                title={filtered ? t('admin.users.noMatch') : t('admin.users.allEmpty')}
                actionLabel={filtered ? t('admin.users.clearFilters') : undefined}
                onAction={clearFilters}
              />
            )
            : (
              <>
                {/* 데스크톱 표 */}
                <AdminUsersTable
                  users={visible}
                  selected={selected}
                  sortKey={sort.key}
                  sortDir={sort.dir}
                  menuItems={menuItems}
                  bulkBar={(
                    <AdminUsersBulkBar
                      count={selected.size}
                      busy={busy}
                      canApprove={canApprove.length > 0}
                      canReject={canReject.length > 0}
                      hasGroups={groups.length > 0}
                      onApprove={bulkApprove}
                      onAddToGroup={() => setGroupPick({ open: true, groupId: null })}
                      onReject={bulkReject}
                      onClear={clearSel}
                    />
                  )}
                  onSort={sortBy}
                  onToggleAll={toggleAll}
                  onToggleOne={toggleOne}
                  onMenu={onMenu}
                />

                {/* 모바일 카드 스택 */}
                <div className="flex flex-col gap-2 md:hidden">
                  {visible.map(u => (
                    <AdminUserCard
                      key={u.id}
                      user={u}
                      menuItems={menuItems(u)}
                      busy={busy}
                      onMenu={k => onMenu(u, k)}
                      onApprove={() => void approveOne(u)}
                      onReject={() => void rejectOne(u)}
                    />
                  ))}
                </div>

                {/* 페이지(32 버튼 · mono 범위) — 한 쪽이면 숨김 */}
                {totalPages > 1 && (
                  <div className="flex items-center gap-2">
                    <span className="flex-1 font-mono text-[11px] text-muted-foreground">{rangeText(page, total)}</span>
                    <UiIconButton label={t('admin.common.prevPage')} icon="chevron-left" variant="outline" disabled={page <= 1 || loading} onClick={() => setPage(p => p - 1)} />
                    <UiIconButton label={t('admin.common.nextPage')} icon="chevron-right" variant="outline" disabled={page >= totalPages || loading} onClick={() => setPage(p => p + 1)} />
                  </div>
                )}
              </>
            )}

      {/* 사용자 삭제 · 초대 */}
      {deleting && <AdminUserDeleteModal user={deleting} onClose={() => setDeleting(null)} onDeleted={onDeleted} />}
      {inviteOpen && <AdminInviteModal groups={groups} onClose={() => setInviteOpen(false)} onChanged={() => void refreshOps()} />}

      {/* 그룹에 추가 */}
      {groupPick.open && (
        <UiModal
          title={t('admin.users.addToGroup')}
          size="sm"
          onClose={() => setGroupPick(g => ({ ...g, open: false }))}
          footer={(
            <>
              <UiButton variant="outline" size="sm" onClick={() => setGroupPick(g => ({ ...g, open: false }))}>{t('common.cancel')}</UiButton>
              <UiButton size="sm" disabled={!groupPick.groupId} onClick={bulkAddToGroup}>{t('common.add')}</UiButton>
            </>
          )}
        >
          <p className="text-[13px] text-muted-foreground">{t('admin.users.groupModalHint', { n: selected.size })}</p>
          <UiSelect
            modelValue={groupPick.groupId}
            onUpdateModelValue={v => setGroupPick(g => ({ ...g, groupId: v == null ? null : String(v) }))}
            options={groups.map(g => ({ value: g.id, label: g.name }))}
            label={t('admin.users.groupLabel')}
            placeholder={t('admin.users.groupPlaceholder')}
          />
        </UiModal>
      )}

      {/* 세션 */}
      {sessionModal.open && (
        <AdminUserSessionsModal
          user={sessionModal.user}
          sessions={sessionModal.sessions}
          loading={sessionModal.loading}
          error={sessionModal.error}
          onClose={() => setSessionModal(m => ({ ...m, open: false }))}
          onRetry={() => { if (sessionModal.user) void openSessions(sessionModal.user) }}
          onRevoke={s => void revokeSession(s)}
          onLogoutAll={u => void logoutUser(u)}
        />
      )}
    </AdminPageShell>
  )
}
