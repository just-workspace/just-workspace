/**
 * 관리 › 그룹. 최대 1100, 2단: 왼쪽 320 목록 + 오른쪽 상세.
 *  목록 카드: "그룹 검색"(32) · 행 48(이름 600 + 설명 12 muted, 오른쪽 멤버 수, 선택 = primary/13 바탕).
 *  상세 ① 멤버 카드: 이름 15/600 + "설명 · 멤버 N", [이름 변경] [멤버 추가], 행 48 = 아바타 28 + 이름·이메일 + 역할 + 빼기.
 *  상세 ② "이 그룹이 사용할 수 있는 모듈" — 토글 칩. 선택 즉시 저장.
 *  [새 그룹](헤더형 오른쪽 1차 버튼), 그룹 삭제 = 상세 머리 ⋮ 메뉴(danger, 확인형). 모바일은 목록 위·상세 아래로 배치.
 */
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { navigateTo } from '~/lib/router'
import { $fetch } from '~/lib/api'
import { cn } from '~/lib/utils'
import { useAuth } from '~/composables/useAuth'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { AdminPageShell } from '~/components/admin/AdminPageShell'
import { UiButton } from '~/components/ui/Button'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiInput } from '~/components/ui/Input'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiIcon } from '~/components/ui/Icon'
import { UiChip } from '~/components/ui/Chip'
import { UiModal } from '~/components/ui/Modal'
import { UiSelect } from '~/components/ui/Select'
import { UiMenu } from '~/components/ui/Menu'

interface Grp { id: string; name: string; description: string; member_count: number; modules: string[] }
interface Mod { id: string; name: string; enabled: boolean }
interface Usr { id: string; username: string; display_name?: string | null; email?: string | null }
interface Member { user_id: string; username: string; role: string; display_name?: string | null; email?: string | null }

const memberName = (m: Member) => m.display_name || m.username

export default function AdminGroupsPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: t('admin.common.headTitle', { page: t('admin.groups.title'), app: appName }) })
  const { user } = useAuth()
  useEffect(() => { if (user && !user.is_admin) void navigateTo('/') }, [user])

  const [groups, setGroups] = useState<Grp[]>([])
  const [modules, setModules] = useState<Mod[]>([])
  const [allUsers, setAllUsers] = useState<Usr[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [q, setQ] = useState('')
  const [selId, setSelId] = useState<string | null>(null)
  const selIdRef = useRef(selId)
  selIdRef.current = selId

  async function load() {
    setLoading(true); setLoadError(false)
    try {
      const [g, m] = await Promise.all([
        $fetch<{ groups: Grp[] }>('/api/admin/groups', { credentials: 'include' }),
        $fetch<{ modules: Mod[] }>('/api/platform/modules', { credentials: 'include' }),
      ])
      const list = g.groups || []
      setGroups(list)
      setModules(m.modules || [])
      const cur = selIdRef.current
      if (!cur || !list.some(x => x.id === cur)) setSelId(list[0]?.id ?? null)
    } catch { setLoadError(true) } finally { setLoading(false) }
  }
  async function loadUsers() {
    try {
      const d: any = await $fetch('/api/admin/users', { credentials: 'include' })
      setAllUsers(Array.isArray(d) ? d : (d.users || d.items || []))
    } catch { setAllUsers([]) }
  }
  useEffect(() => { void load(); void loadUsers() }, [])

  const s = q.trim().toLowerCase()
  const filtered = s ? groups.filter(g => g.name.toLowerCase().includes(s) || (g.description || '').toLowerCase().includes(s)) : groups
  const sel = groups.find(g => g.id === selId) ?? null

  // ── 멤버 ──
  const [members, setMembers] = useState<Member[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [membersError, setMembersError] = useState(false)
  async function loadMembers() {
    const gid = selIdRef.current
    // 현재 선택이 목록에 존재하는 그룹인 경우에만 수행
    if (!gid || !groups.some(g => g.id === gid)) { setMembers([]); return }
    setMembersLoading(true); setMembersError(false)
    try { setMembers((await $fetch<{ members: Member[] }>(`/api/admin/groups/${gid}/members`, { credentials: 'include' })).members || []) }
    catch { setMembers([]); setMembersError(true) } finally { setMembersLoading(false) }
  }
  // watch(selId, loadMembers) — immediate 아님: 첫 렌더(null)는 생략하고 변경 시마다 수행
  const firstSel = useRef(true)
  useEffect(() => {
    if (firstSel.current) { firstSel.current = false; return }
    void loadMembers()
  }, [selId]) // eslint-disable-line react-hooks/exhaustive-deps

  const ROLE: Record<string, string> = { manager: t('admin.groups.roleManager'), member: t('admin.groups.roleMember') }

  async function removeMember(m: Member) {
    if (!sel) return
    if (!await confirmBox(t('admin.groups.removeBody'), { title: t('admin.groups.removeTitle', { name: memberName(m) }), confirmLabel: t('admin.groups.remove'), danger: true })) return
    try {
      await $fetch(`/api/admin/groups/${sel.id}/members/${m.user_id}`, { method: 'DELETE', credentials: 'include' })
      await Promise.all([loadMembers(), load()])
    } catch (e: any) { addToast('error', e?.data?.detail || t('admin.groups.removeFailed')) }
  }

  const [addOpen, setAddOpen] = useState(false)
  const [addUserId, setAddUserId] = useState<string | null>(null)
  const [addRole, setAddRole] = useState('member')
  const userOptions = allUsers
    .filter(u => !members.some(m => m.user_id === u.id))
    .map(u => ({ value: u.id, label: `${u.display_name || u.username}${u.email ? ` (${u.email})` : ''}` }))
  const roleOptions = [{ value: 'member', label: ROLE.member }, { value: 'manager', label: ROLE.manager }]
  function openAdd() { setAddUserId(null); setAddRole('member'); setAddOpen(true) }
  async function addMember() {
    if (!addUserId || !sel) return
    try {
      await $fetch(`/api/admin/groups/${sel.id}/members`, { method: 'POST', credentials: 'include', body: { user_id: addUserId, role: addRole } })
      setAddOpen(false)
      await Promise.all([loadMembers(), load()])
    } catch (e: any) { addToast('error', e?.data?.detail || t('admin.groups.addFailed')) }
  }

  // ── 모듈 칩(즉시 저장) ──
  const [modsSaved, setModsSaved] = useState(false)
  async function toggleModule(id: string, on: boolean) {
    const g = sel
    if (!g) return
    const prev = [...g.modules]
    const next = on ? [...new Set([...g.modules, id])] : g.modules.filter(x => x !== id)
    const setMods = (mods: string[]) => setGroups(list => list.map(x => (x.id === g.id ? { ...x, modules: mods } : x)))
    setMods(next)
    try {
      await $fetch(`/api/admin/groups/${g.id}/modules`, { method: 'PUT', credentials: 'include', body: { module_ids: next } })
      setModsSaved(true); setTimeout(() => { setModsSaved(false) }, 2000)
    } catch (e: any) { setMods(prev); addToast('error', e?.data?.detail || t('admin.groups.saveModsFailed')) }
  }

  // ── 새 그룹 · 이름 바꾸기 · 삭제 ──
  const [edit, setEdit] = useState({ open: false, mode: 'create' as 'create' | 'rename', name: '', desc: '', error: '', saving: false })
  function openCreate() { setEdit({ open: true, mode: 'create', name: '', desc: '', error: '', saving: false }) }
  function openRename() { if (sel) setEdit({ open: true, mode: 'rename', name: sel.name, desc: sel.description || '', error: '', saving: false }) }
  async function saveEdit() {
    if (!edit.name.trim()) { setEdit(e => ({ ...e, error: t('admin.groups.nameRequired') })); return }
    setEdit(e => ({ ...e, saving: true }))
    try {
      if (edit.mode === 'create') {
        const r = await $fetch<Grp>('/api/admin/groups', { method: 'POST', credentials: 'include', body: { name: edit.name.trim(), description: edit.desc.trim() } })
        setSelId(r.id); selIdRef.current = r.id
      } else if (sel) {
        await $fetch(`/api/admin/groups/${sel.id}`, { method: 'PATCH', credentials: 'include', body: { name: edit.name.trim(), description: edit.desc.trim() } })
      }
      setEdit(e => ({ ...e, open: false }))
      await load()
    } catch (err: any) { setEdit(e => ({ ...e, error: err?.data?.detail || t('admin.groups.createFailed') })) }
    finally { setEdit(e => ({ ...e, saving: false })) }
  }
  async function delGroup() {
    const g = sel
    if (!g) return
    if (!await confirmBox(t('admin.groups.deleteBody', { n: g.member_count }), { title: t('admin.groups.deleteTitle', { name: g.name }), confirmLabel: t('common.delete'), danger: true })) return
    try {
      await $fetch(`/api/admin/groups/${g.id}`, { method: 'DELETE', credentials: 'include' })
      setEdit(e => ({ ...e, open: false })); setSelId(null); selIdRef.current = null
      await load()
    } catch (e: any) { addToast('error', e?.data?.detail || t('admin.groups.deleteFailed')) }
  }

  if (!user?.is_admin) return null
  return (
    <AdminPageShell
      title={t('admin.groups.title')}
      subtitle={t('admin.groups.count', { n: groups.length })}
      actions={(
        <>
          {/* 채팅 역할·권한·이모지는 채팅 내 전체 화면 설정에서 관리 — 여기는 링크만 제공 */}
          <UiButton size="sm" variant="outline" icon="external-link" title={t('chat.settings.admin.hint')} onClick={() => void navigateTo('/chat?settings=roles')}>{t('chat.settings.admin.open')}</UiButton>
          <UiButton size="sm" className="font-semibold" onClick={openCreate}>{t('admin.groups.newGroup')}</UiButton>
        </>
      )}
    >
      {loadError ? (
        <UiErrorTile placement="panel" title={t('admin.groups.loadError')} onRetry={load} />
      ) : (
        <div className="grid max-w-[1100px] gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          {/* 목록 */}
          <section className="self-start rounded-lg border border-border bg-card" aria-label={t('admin.groups.listAria')}>
            <div className="border-b border-border px-3 py-2.5">
              <UiInput modelValue={q} onUpdateModelValue={setQ} icon="search" placeholder={t('admin.groups.search')} aria-label={t('admin.groups.search')} inputClass="h-8 text-xs" />
            </div>
            {loading && !groups.length ? (
              <UiSkeleton preset="list" rows={4} />
            ) : !groups.length ? (
              <UiEmptyState variant="panel" icon="users" title={t('admin.groups.emptyTitle')} description={t('admin.groups.emptyDesc')} actionLabel={t('admin.groups.newGroup')} onAction={openCreate} />
            ) : !filtered.length ? (
              <UiEmptyState variant="inline" title={t('admin.groups.noMatch')} />
            ) : (
              <ul role="listbox" aria-label={t('admin.groups.listAria')}>
                {filtered.map(g => (
                  <li key={g.id} role="option" aria-selected={g.id === selId}>
                    <button
                      type="button"
                      className={cn('flex h-12 w-full items-center gap-2.5 border-b border-border px-3.5 text-left text-[13px] hover:bg-accent/40', g.id === selId ? 'bg-primary/[0.13] hover:bg-primary/[0.13]' : '')}
                      onClick={() => setSelId(g.id)}
                    >
                      <span className="min-w-0 flex-1">
                        <b className="block truncate font-semibold text-foreground">{g.name}</b>
                        <span className="block truncate text-xs text-muted-foreground">{g.description || t('admin.groups.noDesc')}</span>
                      </span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">{g.member_count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 상세 */}
          {sel ? (
            <div className="flex min-w-0 flex-col gap-3.5">
              <section className="rounded-lg border border-border bg-card">
                <div className="flex flex-wrap items-center gap-2.5 px-5 pb-3 pt-4">
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-[15px] font-semibold text-foreground">{sel.name}</h3>
                    <p className="mt-1 text-[13px] text-muted-foreground">
                      {sel.description && <span>{sel.description} · </span>}{t('admin.groups.memberLine')} <span className="font-mono">{sel.member_count}</span>
                    </p>
                  </div>
                  <UiButton variant="outline" size="xs" onClick={openRename}>{t('admin.groups.rename')}</UiButton>
                  <UiButton size="xs" className="font-semibold" onClick={openAdd}>{t('admin.groups.addMember')}</UiButton>
                  <UiMenu
                    triggerIcon="more-vertical"
                    label={t('admin.groups.detailMenu', { name: sel.name })}
                    items={[{ key: 'delete', label: t('admin.groups.menuDelete'), icon: 'trash', danger: true }]}
                    onSelect={(k) => { if (k === 'delete') void delGroup() }}
                  />
                </div>
                {membersLoading && !members.length ? (
                  <UiSkeleton preset="list" rows={3} className="border-t border-border" />
                ) : membersError ? (
                  <UiErrorTile placement="panel" title={t('admin.groups.membersLoadError')} className="border-t border-border" onRetry={loadMembers} />
                ) : !members.length ? (
                  <UiEmptyState variant="inline" inset title={t('admin.groups.noMembers')} className="border-t border-border" />
                ) : members.map(m => (
                  <div key={m.user_id} className="flex h-12 items-center gap-3 border-t border-border px-5 text-[13px]">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold text-foreground" aria-hidden="true">{memberName(m).charAt(0)}</span>
                    <span className="min-w-0 flex-1 truncate">
                      <span className="text-foreground">{memberName(m)}</span>
                      {m.email && <span className="text-muted-foreground"> {m.email}</span>}
                    </span>
                    <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{ROLE[m.role] ?? m.role}</span>
                    <UiIconButton icon="close" label={t('admin.groups.removeAria', { name: memberName(m) })} className="text-muted-foreground" onClick={() => removeMember(m)} />
                  </div>
                ))}
              </section>

              <section className="rounded-lg border border-border bg-card">
                <div className="flex items-center gap-3 px-5 pb-2 pt-4">
                  <h3 className="flex-1 text-[13px] font-semibold text-foreground">{t('admin.groups.modulesTitle')}</h3>
                  {modsSaved && (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-success" role="status">
                      <UiIcon name="check" className="h-[13px] w-[13px]" strokeWidth={3} />{t('settingsCard.saved')}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 px-5 pb-4">
                  {modules.map(m => (
                    <UiChip key={m.id} modelValue={sel.modules.includes(m.id)} label={m.name} onUpdateModelValue={v => { void toggleModule(m.id, v) }} />
                  ))}
                </div>
                <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">{t('admin.groups.modulesHint2')}</p>
              </section>
            </div>
          ) : groups.length ? (
            <UiEmptyState variant="panel" icon="users" title={t('admin.groups.pickOne')} />
          ) : null}
        </div>
      )}

      {/* 새 그룹 · 이름 바꾸기 */}
      {edit.open && (
        <UiModal
          title={edit.mode === 'create' ? t('admin.groups.newGroup') : t('admin.groups.rename')}
          size="440"
          onClose={() => setEdit(e => ({ ...e, open: false }))}
          footer={
            <>
              <UiButton variant="outline" size="sm" onClick={() => setEdit(e => ({ ...e, open: false }))}>{t('common.cancel')}</UiButton>
              <UiButton size="sm" disabled={edit.saving} onClick={saveEdit}>{edit.mode === 'create' ? t('common.add') : t('common.save')}</UiButton>
            </>
          }
        >
          <form className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); void saveEdit() }}>
            <UiInput modelValue={edit.name} onUpdateModelValue={v => setEdit(e => ({ ...e, name: v }))} label={t('admin.groups.name')} placeholder={t('admin.groups.namePlaceholder')} error={edit.error} onInput={() => setEdit(e => ({ ...e, error: '' }))} />
            <UiInput modelValue={edit.desc} onUpdateModelValue={v => setEdit(e => ({ ...e, desc: v }))} label={t('admin.groups.descOptional')} />
            <button type="submit" className="hidden" />
          </form>
        </UiModal>
      )}

      {/* 멤버 추가 */}
      {addOpen && sel && (
        <UiModal
          title={t('admin.groups.addMemberTitle', { name: sel.name })}
          size="440"
          onClose={() => setAddOpen(false)}
          footer={
            <>
              <UiButton variant="outline" size="sm" onClick={() => setAddOpen(false)}>{t('common.cancel')}</UiButton>
              <UiButton size="sm" disabled={!addUserId} onClick={addMember}>{t('common.add')}</UiButton>
            </>
          }
        >
          <UiSelect modelValue={addUserId} onUpdateModelValue={v => setAddUserId(v == null ? null : String(v))} options={userOptions} label={t('admin.groups.addPerson')} placeholder={t('admin.groups.selectUser')} />
          <UiSelect modelValue={addRole} onUpdateModelValue={v => setAddRole(String(v))} options={roleOptions} label={t('admin.groups.role')} />
        </UiModal>
      )}
    </AdminPageShell>
  )
}
