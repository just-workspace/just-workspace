/**
 * 역할 편집(모바일 #m-role-edit).
 * 머리: 색 점 + "역할 편집 — 이름" 16/600 (+ 그룹 연결이면 "○○ 그룹에서 자동" 배지).
 * 탭(밑줄형 14/500, 선택 = 2px primary 밑줄): 표시 · 권한 · 멤버 N. @everyone 은 권한만(서버가 권한만 받는다).
 *  - 표시: 이름 · 색(UiColorSwatches, 값 = 서버 토큰 키) + 배경/카드 위 미리보기 · 따로 묶기(hoist) · 멘션 허용 ·
 *    "그룹과 연결"(§5.6 a — 연결하면 멤버 탭 잠김) · 역할 삭제(확인).
 *  - 권한: 찾기 + 권한 초기화 + PermissionMatrix.
 *  - 멤버: 찾기 + 멤버 추가(사람 고르기 창) · 행 48(아바타 32 · 이름 14 · 빼기 ✕) — 그룹 연결·잠김이면 "그룹에서 자동".
 * 초안(draft)은 RolesSection 이 가진다 — 여기는 그리기와 즉시 동작(멤버 추가·빼기·삭제)만.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useStore } from 'zustand'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { UiInput } from '~/components/ui/Input'
import { UiSwitch } from '~/components/ui/Switch'
import { UiSelect } from '~/components/ui/Select'
import { UiButton } from '~/components/ui/Button'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiModal } from '~/components/ui/Modal'
import { UiColorSwatches } from '~/components/ui/ColorSwatches'
import { confirmBox } from '~/composables/useDialog'
import { addToast } from '~/composables/useToast'
import { authStore } from '~/composables/useAuth'
import { chatStore, fetchAllUsers } from '~/composables/useChat'
import {
  addRoleMember, fetchRoleMembers, removeRoleMember, roleColorIndex, type ChatRole, type RoleMember,
} from '~/composables/useChatRoles'
import { filterPermGroups, type PermGroup, type RoleDraft } from './settingsLogic'
import { PermissionMatrix, usePermText } from './PermissionMatrix'
import { ROLE_TEXT, RoleDot, errorText } from './parts'

export type RoleTab = 'disp' | 'perm' | 'mem'
export interface GroupOption { id: string; name: string }

export interface RoleEditorProps {
  role: ChatRole
  draft: RoleDraft
  onDraft: (patch: Partial<RoleDraft>) => void
  tab: RoleTab
  onTab: (t: RoleTab) => void
  locked: boolean
  groups: GroupOption[] | null
  groupsLoading?: boolean
  permGroups: PermGroup[]
  myBits: number
  isGlobalAdmin: boolean
  /** @everyone 기본값(권한 초기화) */
  defaultEveryone: number
  onDelete: () => void
  mobile?: boolean
}

export function RoleEditor(p: RoleEditorProps) {
  const { t } = useI18n()
  const { role, draft, tab, locked, mobile } = p
  const isDefault = role.is_default
  const managed = !!draft.group_id
  const groupName = p.groups?.find(g => g.id === draft.group_id)?.name ?? ''
  const tabs: { key: RoleTab; label: string }[] = isDefault
    ? [{ key: 'perm', label: t('chat.settings.role.tabPerm') }]
    : [
        { key: 'disp', label: t('chat.settings.role.tabDisp') },
        { key: 'perm', label: t('chat.settings.role.tabPerm') },
        { key: 'mem', label: t('chat.settings.role.tabMem', { n: role.member_count ?? 0 }) },
      ]
  const cur = tabs.some(x => x.key === tab) ? tab : tabs[0].key
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  function onTabKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    let j = -1
    if (e.key === 'ArrowRight') j = (i + 1) % tabs.length
    else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') j = 0
    else if (e.key === 'End') j = tabs.length - 1
    if (j < 0) return
    e.preventDefault()
    p.onTab(tabs[j].key)
    tabRefs.current[tabs[j].key]?.focus()
  }
  const name = isDefault ? '@everyone' : draft.name

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      {!mobile && (
        <div className="flex items-center gap-2">
          <RoleDot index={isDefault ? 0 : roleColorIndex(draft.color)} />
          <h3 className="min-w-0 flex-1 truncate text-[16px] font-semibold">{t('chat.settings.role.editTitle', { name })}</h3>
          {managed && groupName && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[12px] font-medium text-muted-foreground">{t('chat.settings.role.autoFromGroup', { group: groupName })}</span>
          )}
        </div>
      )}
      <div role="tablist" aria-label={t('chat.settings.role.tablist')} className="flex gap-5 border-b border-border">
        {tabs.map((x, i) => (
          <button
            key={x.key}
            ref={el => { tabRefs.current[x.key] = el }}
            type="button"
            role="tab"
            id={`role-tab-${x.key}`}
            aria-selected={x.key === cur}
            aria-controls={`role-panel-${x.key}`}
            tabIndex={x.key === cur ? 0 : -1}
            className={cn(
              '-mb-px pb-2 text-[14px] font-medium focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              mobile ? 'min-h-11' : '',
              x.key === cur ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => p.onTab(x.key)}
            onKeyDown={e => onTabKey(e, i)}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`role-panel-${cur}`} aria-labelledby={`role-tab-${cur}`}>
        {cur === 'disp' && <DisplayTab {...p} groupName={groupName} />}
        {cur === 'perm' && <PermTab {...p} />}
        {cur === 'mem' && <MembersTab role={role} locked={locked || managed} managed={managed} mobile={mobile} />}
      </div>
    </div>
  )
}

// ─── 표시 ───
function DisplayTab({ role, draft, onDraft, locked, groups, groupsLoading, onDelete, groupName }: RoleEditorProps & { groupName: string }) {
  const { t } = useI18n()
  const me = useStore(authStore, s => s.user)
  const previewName = me?.display_name || me?.username || t('chat.settings.role.previewName')
  const ci = roleColorIndex(draft.color)
  const nameCls = ci ? ROLE_TEXT[ci - 1] : 'text-foreground'
  const opts = [{ value: '', label: t('chat.settings.role.groupNone') }]
    .concat((groups ?? []).map(g => ({ value: g.id, label: g.name })))
  if (draft.group_id && !opts.some(o => o.value === draft.group_id)) opts.push({ value: draft.group_id, label: groupName || t('chat.settings.role.groupUnknown') })
  const nm = draft.name.trim() || role.name
  return (
    <div className="flex flex-col gap-5">
      <UiInput
        label={t('chat.settings.role.name')}
        modelValue={draft.name}
        onUpdateModelValue={v => onDraft({ name: v })}
        disabled={locked}
        maxLength={100}
        error={!draft.name.trim() ? t('chat.settings.role.nameRequired') : undefined}
      />
      <div className="flex flex-col gap-2">
        <span id="role-color-label" className="text-[13px] font-medium">{t('chat.settings.role.color')}</span>
        <UiColorSwatches
          ariaLabel={t('chat.settings.role.colorAria')}
          modelValue={draft.color}
          onUpdateModelValue={v => onDraft({ color: v })}
          noneLabel={t('chat.settings.role.colorNone')}
          disabled={locked}
        />
        <div className="flex flex-wrap gap-2">
          {(['bg-background', 'bg-card'] as const).map((bg, i) => (
            <div key={bg} className={cn('flex min-w-[200px] flex-1 items-center gap-2 rounded-lg border border-border px-3 py-2', bg)}>
              <UiAvatar src={me?.avatar_url} fallback={previewName.charAt(0)} textSize={11} className="h-7 w-7" />
              <span className={cn('text-[16px] font-medium', nameCls)}>{previewName}</span>
              <span className="text-[12px] text-muted-foreground">{i === 0 ? t('chat.settings.role.previewBg') : t('chat.settings.role.previewCard')}</span>
            </div>
          ))}
        </div>
      </div>
      <UiSwitch
        label={t('chat.settings.role.hoist')}
        description={t('chat.settings.role.hoistDesc', { name: nm })}
        modelValue={draft.hoist}
        onUpdateModelValue={v => onDraft({ hoist: v })}
        disabled={locked}
      />
      <UiSwitch
        label={t('chat.settings.role.mentionable', { name: nm })}
        description={t('chat.settings.role.mentionableDesc')}
        modelValue={draft.mentionable}
        onUpdateModelValue={v => onDraft({ mentionable: v })}
        disabled={locked}
      />
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">{t('chat.settings.role.group')}</p>
          <p className="text-[12px] text-muted-foreground">{t('chat.settings.role.groupDesc')}</p>
        </div>
        <UiSelect
          aria-label={t('chat.settings.role.groupAria')}
          size="sm"
          className="w-40"
          modelValue={draft.group_id ?? ''}
          options={opts}
          disabled={locked || groupsLoading}
          onUpdateModelValue={v => onDraft({ group_id: v ? String(v) : null })}
        />
      </div>
      {!locked && (
        <div>
          <UiButton type="button" variant="ghost" size="sm" icon="trash" className="text-danger hover:text-danger" onClick={onDelete}>
            {t('chat.settings.role.delete')}
          </UiButton>
        </div>
      )}
    </div>
  )
}

// ─── 권한 ───
function PermTab({ role, draft, onDraft, locked, permGroups, myBits, isGlobalAdmin, defaultEveryone, mobile }: RoleEditorProps) {
  const { t } = useI18n()
  const pt = usePermText()
  const [q, setQ] = useState('')
  const shown = useMemo(() => filterPermGroups(permGroups, q, n => `${pt.name(n)} ${pt.desc(n)}`), [permGroups, q, pt])
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <UiInput
          className="flex-1"
          icon="search"
          aria-label={t('chat.settings.role.permSearch')}
          placeholder={t('chat.settings.role.permSearch')}
          modelValue={q}
          onUpdateModelValue={setQ}
        />
        <UiButton
          type="button"
          variant="ghost"
          size="sm"
          disabled={locked}
          onClick={() => onDraft({ permissions: role.is_default ? defaultEveryone : 0 })}
        >
          {t('chat.settings.role.permReset')}
        </UiButton>
      </div>
      {shown.length
        ? <PermissionMatrix groups={shown} value={draft.permissions} onChange={bits => onDraft({ permissions: bits })} locked={locked} myBits={myBits} isGlobalAdmin={isGlobalAdmin} mobile={mobile} />
        : <p className="py-6 text-center text-[13px] text-muted-foreground">{t('chat.settings.role.permNoMatch')}</p>}
    </div>
  )
}

// ─── 멤버 ───
function MembersTab({ role, locked, managed, mobile }: { role: ChatRole; locked: boolean; managed: boolean; mobile?: boolean }) {
  const { t } = useI18n()
  const [items, setItems] = useState<RoleMember[] | null>(null)
  const [q, setQ] = useState('')
  const [picker, setPicker] = useState(false)
  const [err, setErr] = useState('')
  const reload = () => fetchRoleMembers(role.id).then(r => { setItems(r.items || []); setErr('') }).catch(e => { setItems([]); setErr(errorText(e, t('chat.settings.role.membersLoadFail'))) })
  useEffect(() => { setItems(null); void reload() }, [role.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = (items || []).filter(m => !q.trim() || `${m.display_name || ''} ${m.username}`.toLowerCase().includes(q.trim().toLowerCase()))

  async function remove(m: RoleMember) {
    const prev = items
    setItems((items || []).filter(x => x.user_id !== m.user_id))
    try { await removeRoleMember(role.id, m.user_id) } catch (e) {
      setItems(prev)
      addToast('error', errorText(e, t('chat.settings.role.memberFail')))
    }
  }
  async function add(uid: string) {
    try {
      await addRoleMember(role.id, uid)
      await reload()
    } catch (e) { addToast('error', errorText(e, t('chat.settings.role.memberFail'))) }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <UiInput className="flex-1" icon="search" aria-label={t('chat.settings.role.memberSearch')} placeholder={t('chat.settings.role.memberSearch')} modelValue={q} onUpdateModelValue={setQ} />
        <UiButton type="button" size="sm" icon="plus" disabled={locked} onClick={() => setPicker(true)}>{t('chat.settings.role.memberAdd')}</UiButton>
      </div>
      {err && <p role="alert" className="text-[13px] text-danger">{err}</p>}
      {items === null
        ? <p className="py-6 text-center text-[13px] text-muted-foreground">{t('common.loading')}</p>
        : shown.length === 0
          ? <p className="py-6 text-center text-[13px] text-muted-foreground">{q ? t('chat.settings.role.memberNoMatch') : t('chat.settings.role.memberEmpty')}</p>
          : (
            <ul aria-label={t('chat.settings.role.tabMem', { n: items.length })}>
              {shown.map(m => (
                <li key={m.user_id} className={cn('flex items-center gap-3 border-b border-border', mobile ? 'min-h-14' : 'h-12')}>
                  <UiAvatar src={m.avatar_url} fallback={(m.display_name || m.username).charAt(0)} textSize={12} className="h-8 w-8" />
                  <span className="min-w-0 flex-1 truncate text-[14px]">{m.display_name || m.username}</span>
                  {managed
                    ? <span className="text-[12px] text-muted-foreground">{t('chat.settings.role.memberAuto')}</span>
                    : !locked && <UiIconButton icon="close" label={t('chat.settings.role.memberRemove')} size={mobile ? 'lg' : 'sm'} onClick={() => void remove(m)} />}
                </li>
              ))}
            </ul>
          )}
      {picker && <UserPicker title={t('chat.settings.role.memberAdd')} exclude={new Set((items || []).map(m => m.user_id))} onPick={uid => void add(uid)} onClose={() => setPicker(false)} />}
    </div>
  )
}

/** 사람 고르기 창 — 워크스페이스 사용자 검색 · 행을 누르면 바로 추가(창은 열린 채) */
export function UserPicker({ title, exclude, onPick, onClose, extra }: {
  title: string; exclude: Set<string>; onPick: (userId: string) => void; onClose: () => void
  /** 사람 목록 위 추가 항목(덮어쓰기 대상 고르기 — 역할) */
  extra?: (q: string) => React.ReactNode
}) {
  const { t } = useI18n()
  const users = useStore(chatStore, s => s.allUsers)
  const [q, setQ] = useState('')
  useEffect(() => { if (!chatStore.getState().allUsers.length) void fetchAllUsers() }, [])
  const s = q.trim().toLowerCase()
  const shown = users.filter(u => !exclude.has(u.id) && (!s || `${u.display_name || ''} ${u.username}`.toLowerCase().includes(s))).slice(0, 50)
  return (
    <UiModal title={title} size="480" mobile="full" onClose={onClose}>
      <div className="flex flex-col gap-2">
        <UiInput icon="search" data-autofocus aria-label={t('chat.settings.picker.search')} placeholder={t('chat.settings.picker.search')} modelValue={q} onUpdateModelValue={setQ} />
        {extra?.(s)}
        <ul className="flex max-h-[50dvh] flex-col overflow-y-auto" aria-label={t('chat.settings.picker.people')}>
          {shown.map(u => (
            <li key={u.id}>
              <button type="button" className="flex min-h-11 w-full items-center gap-3 rounded-md px-2 text-left hover:bg-overlay-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" onClick={() => onPick(u.id)}>
                <UiAvatar src={u.avatar_url} fallback={(u.display_name || u.username).charAt(0)} textSize={11} className="h-7 w-7" />
                <span className="min-w-0 flex-1 truncate text-[14px]">{u.display_name || u.username}</span>
                <span className="font-mono text-[12px] text-muted-foreground">@{u.username}</span>
              </button>
            </li>
          ))}
          {!shown.length && <li className="py-6 text-center text-[13px] text-muted-foreground">{t('chat.settings.picker.none')}</li>}
        </ul>
      </div>
    </UiModal>
  )
}

/** 역할 삭제 확인 */
export async function confirmDeleteRole(role: ChatRole, t: (k: string, a?: Record<string, unknown>) => string): Promise<boolean> {
  return confirmBox(t('chat.settings.role.deleteConfirm', { name: role.name, n: role.member_count ?? 0 }), {
    danger: true, confirmLabel: t('common.delete'), title: t('chat.settings.role.deleteTitle'),
  })
}

export default RoleEditor
