/**
 * 역할 섹션(모바일 #m-roles #m-role-edit).
 * 왼쪽 목록 240: "역할 — N" 12/600 + [역할 만들기] · 행 40(손잡이는 호버 때만 · 색 점 12 · 이름 15 · 잠금/그룹 배지 · 인원 mono 12) ·
 *   @everyone 은 구분선 아래 고정 · 끌어 정렬(#role-drag — 자리 선 UiDropLine, 끄는 행 40%, aria-live) + 키보드 ↑↓(손잡이).
 *   내 최고 역할 이상(useChatRoles.myTopPosition)은 잠금 아이콘(#role-locked) — 편집은 보기만.
 * 오른쪽: RoleEditor. 저장 안 된 변경(#role-dirty) = 아래 띠 + 되돌리기 · 저장, 다른 역할·섹션으로 가려 하면 띠 흔들기.
 * 실시간: 다른 사람이 같은 역할을 바꾸면(chat_roles_changed → store 다시 읽음) 변경 중이면 덮어쓰지 않고 "새로 고침" 안내.
 * 모바일: 목록 → 편집 한 화면씩.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useStore } from 'zustand'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiDragHandle, UiDropLine } from '~/components/ui/DragHandle'
import { addToast } from '~/composables/useToast'
import { authStore } from '~/composables/useAuth'
import {
  PERM, canWorkspace, createRole, deleteRole, myTopPosition, reorderRoles, roleColorIndex, syncGroupRoles, updateRole,
  useChatRoles, type ChatRole,
} from '~/composables/useChatRoles'
import {
  draftOf, draftPatch, isRoleLocked, moveRoleIds, permGroups as buildPermGroups, reorderAllowed, type RoleDraft,
} from './settingsLogic'
import { RoleEditor, confirmDeleteRole, type GroupOption, type RoleTab } from './RoleEditor'
import { SaveBar } from './SaveBar'
import { MobileHeader, RoleDot, SettingsBanner, SettingsHeader, errorText, useSettingsCtx } from './parts'
import { requestLeave, setSettingsDirty } from './settingsStore'

const ALL_BITS = Object.values(PERM).reduce((a, b) => a + b, 0)
const same = (a: RoleDraft | null, b: RoleDraft | null) => JSON.stringify(a) === JSON.stringify(b)

export function RolesSection() {
  const { t } = useI18n()
  const { mobile, backToMenu } = useSettingsCtx()
  const rolesRaw = useChatRoles(s => s.roles)
  const loaded = useChatRoles(s => s.loaded)
  const loadErr = useChatRoles(s => s.error)
  const catalog = useChatRoles(s => s.catalog)
  const myTop = useChatRoles(s => myTopPosition(s))
  const canManage = useChatRoles(s => canWorkspace(PERM.MANAGE_ROLES, s))
  const myWs = useChatRoles(s => s.myWorkspacePerms)
  const userRoles = useChatRoles(s => s.userRoles)
  const me = useStore(authStore, s => s.user)
  const isGlobalAdmin = !!me?.is_admin
  const myBits = isGlobalAdmin ? ALL_BITS : myWs

  const roles = useMemo(() => [...rolesRaw].sort((a, b) => b.position - a.position), [rolesRaw])
  const movable = roles.filter(r => !r.is_default)
  const everyone = roles.find(r => r.is_default) ?? null
  const myTopRole = myTop === Infinity ? null : roles.find(r => !r.is_default && (userRoles[me?.id || ''] || []).includes(r.id) && r.position === myTop) ?? null

  const [selId, setSelId] = useState<string | null>(null)
  const [mobileEdit, setMobileEdit] = useState(false)
  const sel = roles.find(r => r.id === selId) ?? null
  const [base, setBase] = useState<RoleDraft | null>(null)
  const [draft, setDraft] = useState<RoleDraft | null>(null)
  const [tab, setTab] = useState<RoleTab>('disp')
  const [stale, setStale] = useState(false)
  const [saving, setSaving] = useState(false)
  const dirty = !!sel && !!base && !!draft && Object.keys(draftPatch(base, draft, sel.is_default)).length > 0

  useEffect(() => { setSettingsDirty(dirty) }, [dirty])
  useEffect(() => () => setSettingsDirty(false), [])

  // 처음: 맨 위 역할(데스크톱) — 모바일은 목록부터
  useEffect(() => {
    if (!roles.length) return
    if (!selId || !roles.some(r => r.id === selId)) {
      const first = movable[0] ?? everyone
      if (first) { setSelId(first.id); setBase(draftOf(first)); setDraft(draftOf(first)); setStale(false); setTab(first.is_default ? 'perm' : 'disp') }
    }
  }, [roles]) // eslint-disable-line react-hooks/exhaustive-deps

  // store 가 다시 읽히면(저장 뒤 · 다른 사람 변경) — 변경 없으면 따라가고, 변경 중이면 안내만
  const savingRef = useRef(false)
  useEffect(() => {
    if (!sel) return
    const fresh = draftOf(sel)
    if (same(fresh, base)) return
    if (!dirty) { setBase(fresh); setDraft(fresh); setStale(false) }
    else if (!savingRef.current) setStale(true)
  }, [sel]) // eslint-disable-line react-hooks/exhaustive-deps

  function select(r: ChatRole) {
    if (r.id === selId) { if (mobile) setMobileEdit(true); return }
    if (!requestLeave()) return
    setSelId(r.id); setBase(draftOf(r)); setDraft(draftOf(r)); setStale(false)
    setTab(r.is_default ? 'perm' : tab)
    if (mobile) setMobileEdit(true)
  }
  function revert() { setDraft(base); setStale(false); if (sel && stale) { const f = draftOf(sel); setBase(f); setDraft(f) } }
  async function save() {
    if (!sel || !base || !draft) return
    const patch = draftPatch(base, draft, sel.is_default)
    if (patch.name !== undefined && !patch.name) return
    setSaving(true); savingRef.current = true
    try {
      const r = await updateRole(sel.id, patch)
      const f = draftOf({ ...sel, ...r })
      setBase(f); setDraft(f); setStale(false)
      addToast('success', t('chat.settings.dirty.saved'))
    } catch (e) {
      addToast('error', errorText(e, t('chat.settings.dirty.saveFail')))
    } finally { setSaving(false); savingRef.current = false }
  }
  async function create() {
    if (!requestLeave()) return
    try {
      const r = await createRole({ name: t('chat.settings.roles.newName') })
      setSelId(r.id); setBase(draftOf(r)); setDraft(draftOf(r)); setTab('disp'); setStale(false)
      if (mobile) setMobileEdit(true)
    } catch (e) { addToast('error', errorText(e, t('chat.settings.roles.createFail'))) }
  }
  async function remove() {
    if (!sel || sel.is_default) return
    if (!(await confirmDeleteRole(sel, t))) return
    try {
      await deleteRole(sel.id)
      setSettingsDirty(false)
      setSelId(null); setBase(null); setDraft(null); setMobileEdit(false)
    } catch (e) { addToast('error', errorText(e, t('chat.settings.roles.deleteFail'))) }
  }

  // ─── 그룹(§5.6 a) — 그룹 목록은 관리자 그룹 API(전역 관리자만 읽힌다) ───
  const [groups, setGroups] = useState<GroupOption[] | null>(null)
  const [groupsLoading, setGroupsLoading] = useState(false)
  useEffect(() => {
    if (!isGlobalAdmin) return
    setGroupsLoading(true)
    $fetch<{ groups: GroupOption[] }>('/api/admin/groups')
      .then(r => setGroups((r.groups || []).map(g => ({ id: g.id, name: g.name }))))
      .catch(() => setGroups(null))
      .finally(() => setGroupsLoading(false))
  }, [isGlobalAdmin])
  const unlinkedGroups = (groups || []).filter(g => !roles.some(r => r.group_id === g.id))
  async function syncGroups() {
    try { await syncGroupRoles(); addToast('success', t('chat.settings.roles.syncDone')) } catch (e) { addToast('error', errorText(e, t('chat.settings.roles.syncFail'))) }
  }

  // ─── 끌어 정렬 ───
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropIdx, setDropIdx] = useState<number | null>(null)
  const [live, setLive] = useState('')
  const ids = movable.map(r => r.id)
  const lockedOf = (r: ChatRole) => isRoleLocked(r, myTop, canManage)
  async function applyOrder(fromId: string, toIndex: number) {
    const next = moveRoleIds(ids, fromId, toIndex)
    if (!next) return
    const r = roles.find(x => x.id === fromId)
    if (!reorderAllowed(movable, next, myTop)) { addToast('error', t('chat.settings.roles.reorderLocked')); return }
    setLive(t('chat.settings.roles.moved', { name: r?.name ?? '', n: next.indexOf(fromId) + 1 }))
    try { await reorderRoles(next) } catch (e) { addToast('error', errorText(e, t('chat.settings.roles.reorderFail'))) }
  }
  function onDragOver(e: DragEvent<HTMLDivElement>, i: number) {
    if (!dragId) return
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const idx = e.clientY - rect.top > rect.height / 2 ? i + 1 : i
    if (idx !== dropIdx) {
      setDropIdx(idx)
      const name = roles.find(x => x.id === dragId)?.name ?? ''
      const pos = (moveRoleIds(ids, dragId, idx) ?? ids).indexOf(dragId) + 1
      setLive(t('chat.settings.roles.moving', { name, n: pos }))
    }
  }
  function endDrag() { setDragId(null); setDropIdx(null) }

  // ─── 그리기 ───
  const selLocked = sel ? lockedOf(sel) : true
  const banner = (() => {
    if (loadErr) return <SettingsBanner tone="danger" icon="alert-circle">{t('chat.settings.roles.loadFail')}</SettingsBanner>
    if (!canManage) return <SettingsBanner tone="info" icon="lock">{t('chat.settings.roles.noPerm')}</SettingsBanner>
    if (stale) return <SettingsBanner tone="warn" icon="refresh" action={t('chat.settings.roles.staleRefresh')} onAction={revert}>{t('chat.settings.roles.stale')}</SettingsBanner>
    if (sel && selLocked) return <SettingsBanner tone="warn" icon="lock">{t('chat.settings.roles.lockedBanner', { name: sel.name, top: myTopRole?.name ?? '' })}</SettingsBanner>
    if (sel && draft?.group_id && tab === 'mem') {
      const g = groups?.find(x => x.id === draft.group_id)?.name ?? ''
      return <SettingsBanner tone="info" icon="users">{t('chat.settings.roles.managedBanner', { group: g })}</SettingsBanner>
    }
    return null
  })()

  const editor = sel && draft && (
    <RoleEditor
      role={sel}
      draft={draft}
      onDraft={p => setDraft(d => (d ? { ...d, ...p } : d))}
      tab={tab}
      onTab={setTab}
      locked={selLocked}
      groups={groups}
      groupsLoading={groupsLoading}
      permGroups={buildPermGroups(catalog, 'role')}
      myBits={myBits}
      isGlobalAdmin={isGlobalAdmin}
      defaultEveryone={catalog?.default_everyone ?? 0}
      onDelete={() => void remove()}
      mobile={mobile}
    />
  )
  const bar = dirty && <SaveBar mobile={mobile} saving={saving} canSave={!!draft?.name.trim()} onRevert={revert} onSave={() => void save()} />

  if (mobile) {
    if (mobileEdit && sel) {
      const tabName = { disp: t('chat.settings.role.tabDisp'), perm: t('chat.settings.role.tabPerm'), mem: t('chat.settings.role.tabMemShort') }[sel.is_default ? 'perm' : tab]
      return (
        <div className="flex h-full flex-col">
          <MobileHeader title={`${sel.is_default ? '@everyone' : sel.name} · ${tabName}`} onBack={() => { if (requestLeave()) setMobileEdit(false) }} />
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-2">
            {banner}
            {editor}
            {bar}
          </div>
        </div>
      )
    }
    return (
      <div className="flex h-full flex-col">
        <MobileHeader title={t('chat.settings.nav.roles')} onBack={backToMenu} addLabel={canManage ? t('chat.settings.roles.create') : undefined} onAdd={() => void create()} />
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
          {banner && <div className="pb-2">{banner}</div>}
          {roles.map(r => {
            const lk = lockedOf(r) && canManage && !r.is_default
            const d = r.is_default
              ? t('chat.settings.roles.everyoneNote')
              : lk ? t('chat.settings.roles.lockedShort') : ''
            return (
              <button key={r.id} type="button" className="flex min-h-14 w-full items-center gap-3 border-b border-border px-1 py-1.5 text-left hover:bg-overlay-hover" onClick={() => select(r)}>
                <RoleDot index={r.is_default ? 0 : roleColorIndex(r.color)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[16px]">{r.is_default ? '@everyone' : r.name}</span>
                  <span className="block text-[13px] text-muted-foreground">{t('chat.settings.roles.count', { n: (r.member_count ?? 0).toLocaleString() })}{d ? ` · ${d}` : ''}</span>
                </span>
                {r.managed && <span className="rounded bg-muted px-1 text-[10px] font-semibold text-muted-foreground">{t('chat.settings.roles.groupBadge')}</span>}
                <UiIcon name="chevron-right" className="h-5 w-5 text-muted-foreground" />
              </button>
            )
          })}
          {!loaded && <p className="py-6 text-center text-[13px] text-muted-foreground">{t('common.loading')}</p>}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <SettingsHeader title={t('chat.settings.roles.title')} sub={t('chat.settings.roles.sub')} />
      {banner}
      <div className="flex gap-6">
        <div className="relative flex shrink-0 flex-col gap-0.5" style={{ width: 240 }}>
          <div className="flex items-center pb-2">
            <p className="flex-1 text-[12px] font-semibold text-muted-foreground">{t('chat.settings.roles.listTitle', { n: roles.length })}</p>
            {canManage && <UiButton type="button" size="xs" onClick={() => void create()}>{t('chat.settings.roles.create')}</UiButton>}
          </div>
          <div role="listbox" aria-label={t('chat.settings.roles.listAria')} className="flex flex-col gap-0.5" onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropIdx(null) }}>
            {roles.map(r => {
              const i = ids.indexOf(r.id)
              const lk = lockedOf(r)
              const dragOk = canManage && !r.is_default && !lk
              const isSel = r.id === selId
              return (
                <div key={r.id}>
                  {r.is_default && <span aria-hidden="true" className="my-1.5 block h-px bg-border" />}
                  {!r.is_default && dropIdx === i && dragId && <UiDropLine className="my-0.5" />}
                  <div
                    role="option"
                    aria-selected={isSel}
                    tabIndex={isSel ? 0 : -1}
                    data-role-id={r.id}
                    className={cn(
                      'group relative flex h-10 cursor-pointer items-center gap-2 rounded-lg px-2 text-[15px] outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                      isSel ? 'bg-overlay-selected font-medium' : 'hover:bg-overlay-hover',
                      dragId === r.id ? 'opacity-40' : '',
                    )}
                    onClick={() => select(r)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(r) }
                      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey) {
                        e.preventDefault()
                        const j = roles.indexOf(r) + (e.key === 'ArrowDown' ? 1 : -1)
                        const nx = roles[j]
                        if (nx) { select(nx); (e.currentTarget.parentElement?.parentElement?.querySelector(`[data-role-id="${nx.id}"]`) as HTMLElement | null)?.focus() }
                      }
                    }}
                    draggable={dragOk}
                    onDragStart={e => { if (!dragOk) return; setDragId(r.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.id) }}
                    onDragEnd={endDrag}
                    onDragOver={e => { if (!r.is_default) onDragOver(e, i); else if (dragId) { e.preventDefault(); setDropIdx(ids.length) } }}
                    onDrop={e => { e.preventDefault(); const from = dragId; const to = dropIdx; endDrag(); if (from && to != null) void applyOrder(from, to) }}
                  >
                    {dragOk
                      ? <UiDragHandle hoverOnly ariaLabel={t('chat.settings.roles.reorderAria', { name: r.name })} onClick={e => e.stopPropagation()} onMove={d => void applyOrder(r.id, d < 0 ? i - 1 : i + 2)} />
                      : <span aria-hidden="true" className="h-6 w-6 shrink-0" />}
                    <RoleDot index={r.is_default ? 0 : roleColorIndex(r.color)} />
                    <span className="relative min-w-0 flex-1 truncate">{r.is_default ? '@everyone' : r.name}</span>
                    {lk && canManage && !r.is_default && (
                      <span title={t('chat.settings.roles.lockedShort')} aria-label={t('chat.settings.roles.lockedShort')} className="relative text-muted-foreground">
                        <UiIcon name="lock" className="h-3.5 w-3.5" />
                      </span>
                    )}
                    {r.is_default && <span title={t('chat.settings.roles.everyoneNote')} className="sr-only">{t('chat.settings.roles.everyoneNote')}</span>}
                    {r.managed && <span title={t('chat.settings.roles.groupBadgeTitle')} className="relative rounded bg-muted px-1 text-[10px] font-semibold text-muted-foreground">{t('chat.settings.roles.groupBadge')}</span>}
                    <span className="relative font-mono text-[12px] text-muted-foreground">{(r.member_count ?? 0).toLocaleString()}</span>
                  </div>
                </div>
              )
            })}
            {dragId && dropIdx === ids.length && <UiDropLine className="my-0.5" />}
          </div>
          {!loaded && <p className="px-2 py-4 text-[13px] text-muted-foreground">{t('common.loading')}</p>}
          {loaded && !roles.length && <p className="px-2 py-4 text-[13px] text-muted-foreground">{t('chat.settings.roles.empty')}</p>}
          <p className="px-2 pt-2 text-[12px] leading-relaxed text-muted-foreground">
            {t('chat.settings.roles.footHigher')}{myTopRole ? ` ${t('chat.settings.roles.footTop', { name: myTopRole.name })}` : ''}
          </p>
          {canManage && unlinkedGroups.length > 0 && (
            <UiButton type="button" variant="ghost" size="xs" icon="users" className="mt-1 self-start" onClick={() => void syncGroups()}>
              {t('chat.settings.roles.syncGroups', { n: unlinkedGroups.length })}
            </UiButton>
          )}
          <p aria-live="assertive" className="sr-only">{live}</p>
        </div>
        {editor || <div className="flex-1" />}
      </div>
      {bar}
    </div>
  )
}

export default RolesSection
