/**
 * 스페이스 설정 · 멤버("스페이스 설정 · 멤버 12").
 * 공통 폼 + 행 규격으로 구성한다.
 * 공유: 공개 범위 전환 · 멤버 추가(채팅 설정의 사용자 선택 창 UserPicker 재사용) · 역할 변경 · 내보내기 — 조작 즉시 반영된다
 * (이름·설명만 "저장" 버튼). 소유자는 멤버 표에 없고 항상 관리자이므로 최상단 고정 행으로만 표시한다.
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { useAuth } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { updateSpace, deleteSpace, fetchMembers, addMember, updateMember, removeMember, fetchSpace, type WikiSpace, type WikiMember } from '~/composables/useWiki'
import { UiModal } from '~/components/ui/Modal'
import { UiInput } from '~/components/ui/Input'
import { UiTextarea } from '~/components/ui/Textarea'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiBadge } from '~/components/ui/Badge'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiButton } from '~/components/ui/Button'
import { UiSelect } from '~/components/ui/Select'
import { UserPicker } from '~/components/chat/settings/RoleEditor'

export interface WikiSpaceSettingsProps {
  space: WikiSpace
  onClose?: () => void
  onDeleted?: () => void
  /** 멤버 수 조회 시 */
  onMembers?: (n: number) => void
}

/** 스페이스 설정 모달(이름·설명·멤버·삭제) */
export function WikiSpaceSettings({ space, onClose, onDeleted, onMembers }: WikiSpaceSettingsProps) {
  const { t } = useI18n()
  const { user } = useAuth()

  const isAdmin = space.user_role === 'admin' || !!user?.is_admin
  const [name, setName] = useState(space.name)
  const [description, setDescription] = useState(space.description ?? '')
  const [saving, setSaving] = useState(false)
  const [members, setMembers] = useState<WikiMember[]>([])
  const [loadingMembers, setLoadingMembers] = useState(true)
  const [loadError, setLoadError] = useState(false)

  const [visibility, setVisibility] = useState(space.visibility === 'public' ? 'public' : 'private')
  const [busy, setBusy] = useState(false)   // 공개 범위·역할 요청의 중복 방지
  const [picker, setPicker] = useState(false)

  const ROLE: Record<string, string> = { admin: t('wiki.role.admin'), writer: t('wiki.role.writer'), reader: t('wiki.role.reader') }
  const roleOptions = (['reader', 'writer', 'admin'] as const).map(r => ({ value: r, label: ROLE[r] }))
  const visibilityOptions = [
    { value: 'private', label: t('wiki.share.private', '비공개 — 멤버만') },
    { value: 'public', label: t('wiki.share.public', '공개 — 모든 사용자가 읽기') },
  ]
  const owner = space.owner?.id ? space.owner : null

  async function loadMembers() {
    setLoadingMembers(true)
    setLoadError(false)
    try {
      const list = await fetchMembers(space.id)
      setMembers(list)
      onMembers?.(list.length)
    } catch {
      setLoadError(true)
    } finally {
      setLoadingMembers(false)
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadMembers() }, [])

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    try {
      await updateSpace(space.id, { name: name.trim(), description: description.trim() || null })
      await fetchSpace(space.id)
      addToast('success', t('wiki.settings.saved'))
      onClose?.()
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('wiki.settings.saveError'))
    } finally {
      setSaving(false)
    }
  }

  async function changeVisibility(next: string) {
    if (next === visibility || busy) return
    // 공개 시 되돌리기 전까지 모든 사용자가 열람 가능하므로 1회 확인한다
    if (next === 'public' && !await confirmBox(
      t('wiki.share.publicConfirm', '이 스페이스를 공개하시겠습니까? 워크스페이스의 모든 사용자가 읽을 수 있게 됩니다.'),
      { confirmLabel: t('wiki.share.publicConfirmLabel', '공개하기') },
    )) return
    setBusy(true)
    try {
      await updateSpace(space.id, { visibility: next })
      setVisibility(next)
      await fetchSpace(space.id).catch(() => {})
      addToast('success', t('wiki.share.visibilitySaved', '공개 범위를 변경했습니다'))
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('wiki.share.visibilityError', '공개 범위를 변경하지 못했습니다'))
    } finally {
      setBusy(false)
    }
  }

  async function add(userId: string) {
    try {
      await addMember(space.id, userId, 'reader')
      await loadMembers()
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('wiki.share.addError', '멤버를 추가하지 못했습니다'))
    }
  }

  async function changeRole(m: WikiMember, role: string) {
    if (role === m.role || busy) return
    setBusy(true)
    const prev = members
    setMembers(members.map(x => x.user_id === m.user_id ? { ...x, role } : x))
    try {
      await updateMember(space.id, m.user_id, role)
    } catch (e: any) {
      setMembers(prev)
      addToast('error', e?.data?.detail || t('wiki.share.roleError', '역할을 변경하지 못했습니다'))
    } finally {
      setBusy(false)
    }
  }

  async function kick(m: WikiMember) {
    if (!await confirmBox(t('wiki.settings.kickConfirm', { name: m.display_name || m.username }), { danger: true, confirmLabel: t('wiki.settings.kick') })) return
    try {
      await removeMember(space.id, m.user_id)
      await loadMembers()
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('wiki.settings.kickError'))
    }
  }

  async function remove() {
    if (!await confirmBox(t('wiki.settings.deleteConfirm'), { danger: true, confirmLabel: t('common.delete') })) return
    try {
      await deleteSpace(space.id)
      addToast('success', t('wiki.settings.deleted'))
      onDeleted?.()
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('board.comment.deleteError'))
    }
  }

  return (
    <>
    <UiModal
      size="md"
      title={t('wiki.settings.title')}
      onClose={() => onClose?.()}
      footer={(
        <>
          {isAdmin && <UiButton variant="ghost" size="sm" className="mr-auto text-danger hover:text-danger" onClick={remove}>{t('wiki.settings.deleteSpace')}</UiButton>}
          <UiButton variant="outline" size="sm" onClick={() => onClose?.()}>{t('common.close')}</UiButton>
          {isAdmin && <UiButton size="sm" disabled={saving || !name.trim()} onClick={save}>{t('common.save')}</UiButton>}
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <UiInput modelValue={name} onUpdateModelValue={setName} label={t('wiki.settings.name')} disabled={!isAdmin} />
        <UiTextarea modelValue={description} onUpdateModelValue={setDescription} label={t('wiki.settings.description')} rows={2} disabled={!isAdmin} />

        <UiSelect
          label={t('wiki.share.visibility', '공개 범위')}
          options={visibilityOptions}
          modelValue={visibility}
          onUpdateModelValue={v => { void changeVisibility(String(v)) }}
          hint={visibility === 'public'
            ? t('wiki.share.hintPublic', '모든 사용자가 읽을 수 있습니다. 편집은 아래 멤버만 합니다.')
            : t('wiki.share.hintPrivate', '소유자와 아래 멤버만 볼 수 있습니다.')}
          disabled={!isAdmin || busy}
        />

        <div>
          <div className="mb-1.5 flex min-h-8 items-center gap-2 text-[13px] font-medium text-foreground">
            <span className="min-w-0 flex-1">{t('wiki.settings.members')} <span className="font-mono text-muted-foreground">{members.length}</span></span>
            {isAdmin && <UiButton type="button" variant="outline" size="sm" icon="plus" onClick={() => setPicker(true)}>{t('wiki.share.addMember', '멤버 추가')}</UiButton>}
          </div>
          {loadingMembers ? <UiSkeleton preset="list" rows={3} />
            : loadError ? <UiErrorTile placement="card" title={t('wiki.settings.membersError')} onRetry={loadMembers} />
            : (
              <ul className="max-h-64 overflow-y-auto rounded-lg border border-border">
                {owner && (
                  <li className="flex h-row items-center gap-2.5 border-b border-border px-3 last:border-b-0">
                    <UiAvatar src={owner.avatar_url} alt={owner.display_name || owner.username} className="h-7 w-7" />
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-foreground">{owner.display_name || owner.username}</span>
                    <UiBadge tone="neutral" tint size={18}>{t('wiki.share.owner', '소유자')}</UiBadge>
                  </li>
                )}
                {!owner && !members.length && (
                  <li className="px-3 py-4 text-center text-[13px] text-muted-foreground">{t('wiki.share.noMembers', '아직 멤버가 없습니다')}</li>
                )}
                {members.map(m => (
                  <li key={m.user_id} className="flex h-row items-center gap-2.5 border-b border-border px-3 last:border-b-0">
                    <UiAvatar src={m.avatar_url} alt={m.display_name || m.username} className="h-7 w-7" />
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-foreground">{m.display_name || m.username}</span>
                    {/* 본인 역할은 여기서 변경 불가 — 스스로 강등하면 이 창을 다시 열 수 없다(내보내기도 동일 규칙) */}
                    {isAdmin && m.user_id !== user?.id
                      ? (
                        <UiSelect
                          className="w-24 shrink-0"
                          size="sm"
                          aria-label={`${m.display_name || m.username} ${t('wiki.share.role', '역할')}`}
                          options={roleOptions}
                          modelValue={m.role}
                          onUpdateModelValue={v => { void changeRole(m, String(v)) }}
                          disabled={busy}
                        />
                      )
                      : <UiBadge tone="neutral" tint size={18}>{ROLE[m.role] ?? m.role}</UiBadge>}
                    {isAdmin && m.user_id !== user?.id && (
                      <UiIconButton label={t('wiki.settings.kickLabel', { name: m.display_name || m.username })} icon="close" onClick={() => kick(m)} />
                    )}
                  </li>
                ))}
              </ul>
            )}
        </div>
      </div>
    </UiModal>
      {picker && (
        <UserPicker
          title={t('wiki.share.addMember', '멤버 추가')}
          exclude={new Set([...members.map(m => m.user_id), ...(owner?.id ? [owner.id] : [])])}
          onPick={uid => { void add(uid) }}
          onClose={() => setPicker(false)}
        />
      )}
    </>
  )
}

export default WikiSpaceSettings
