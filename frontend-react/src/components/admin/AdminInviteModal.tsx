/**
 * 사용자 초대 모달(관리 › 사용자 헤더 [사용자 초대]).
 * 디자인에 해당 화면이 없어 기존 폼·표 규격으로 구성.
 * 탭 2개: 새 초대(POST /api/admin/invites) · 보낸 초대(GET /api/admin/invites, 열린 초대 회수 DELETE /invites/{id}).
 * 새 초대: 이메일 복수 입력(쉼표·줄바꿈) — 비우면 메일 없이 링크만 n개 생성. 만료 일수 · 넣을 그룹 · 초대 메일 보내기.
 * 링크 원문은 생성 직후 본 화면에서만 확인 가능하다(서버는 해시만 저장) → 결과 목록에서 복사.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { cn } from '~/lib/utils'
import { UiModal } from '~/components/ui/Modal'
import { UiTabs } from '~/components/ui/Tabs'
import { UiTextarea } from '~/components/ui/Textarea'
import { UiInput } from '~/components/ui/Input'
import { UiSelect } from '~/components/ui/Select'
import { UiSwitch } from '~/components/ui/Switch'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiBadge } from '~/components/ui/Badge'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiButton } from '~/components/ui/Button'
import { writeClipboard } from '~/lib/clipboard'

export interface AdminInviteModalProps {
  /** 넣을 그룹 선택지(관리 › 사용자 화면이 조회해 둔 그룹) */
  groups: { id: string; name: string }[]
  /** 닫기 */
  onClose?: () => void
  /** 초대 생성 또는 회수 시 호출(운영 요약 갱신용) */
  onChanged?: () => void
}

interface CreatedInvite { id: string; email: string | null; url: string; emailed: boolean; email_error: string | null; expires_at: string | null }
interface Invite { id: string; email: string | null; group_id: string | null; expires_at: string | null; used_at: string | null; created_at: string | null; state: 'open' | 'used' | 'expired' | 'revoked' }

/** 이메일 칸 → 주소 목록(공백·쉼표·세미콜론으로 분리) */
export function parseInviteEmails(text: string): string[] {
  return text.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)
}
/** 형식이 올바르지 않은 주소 목록 */
export function badInviteEmails(list: string[]): string[] {
  return list.filter(e => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
}
/** 보낸 초대 정렬: 열린 초대 우선, 이후 생성 시각 최신순 */
export function sortInvites<T extends { state: string; created_at: string | null }>(list: T[]): T[] {
  return [...list].sort((a, b) => Number(b.state === 'open') - Number(a.state === 'open') || (b.created_at || '').localeCompare(a.created_at || ''))
}

const STATE: Record<Invite['state'], { key: string; tone: 'success' | 'neutral' | 'warning' | 'danger' }> = {
  open: { key: 'admin.users.invites.stateOpen', tone: 'success' },
  used: { key: 'admin.users.invites.stateUsed', tone: 'neutral' },
  expired: { key: 'admin.users.invites.stateExpired', tone: 'warning' },
  revoked: { key: 'admin.users.invites.stateRevoked', tone: 'danger' },
}

export function AdminInviteModal({ groups, onClose, onChanged }: AdminInviteModalProps) {
  const { t, locale } = useI18n()
  const [tab, setTab] = useState<'new' | 'list'>('new')

  // ── 새 초대 ──
  const [form, setForm] = useState({ emails: '', count: 1 as number | string, expires: '7', group: '' as string, sendEmail: true })
  const patch = (p: Partial<typeof form>) => setForm(f => ({ ...f, ...p }))
  const emails = useMemo(() => parseInviteEmails(form.emails), [form.emails])
  const badEmails = useMemo(() => badInviteEmails(emails), [emails])
  const EXPIRES = [1, 3, 7, 14, 30].map(d => ({ value: String(d), label: t('admin.users.invites.days', { n: d }) }))
  const groupOptions = [{ value: '', label: t('admin.users.invites.noGroup') }, ...groups.map(g => ({ value: g.id, label: g.name }))]
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState('')
  const [created, setCreated] = useState<CreatedInvite[] | null>(null)

  async function create() {
    setFormError('')
    if (badEmails.length) { setFormError(t('admin.users.invites.badEmail', { email: badEmails[0] })); return }
    const count = Math.min(50, Math.max(1, Number(form.count) || 1))
    setCreating(true)
    try {
      const r = await $fetch<{ invites: CreatedInvite[] }>('/api/admin/invites', {
        method: 'POST',
        body: {
          emails, count, expires_days: Number(form.expires), group_id: form.group || null,
          send_email: emails.length > 0 && form.sendEmail,
        },
      })
      setCreated(r.invites)
      onChanged?.()
    } catch (e: any) {
      setFormError(e?.data?.detail || t('admin.users.invites.createFailed'))
    } finally { setCreating(false) }
  }
  function again() { setCreated(null); patch({ emails: '', count: 1 }) }

  async function copy(text: string, ok = t('admin.users.invites.copied')) {
    try { await writeClipboard(text); addToast('success', ok) } catch { addToast('error', t('admin.users.invites.copyFailed')) }
  }
  function copyAll() {
    if (!created) return
    void copy(created.map(i => (i.email ? `${i.email}\t${i.url}` : i.url)).join('\n'), t('admin.users.invites.copiedAll', { n: created.length }))
  }

  // ── 보낸 초대 ──
  const [invites, setInvites] = useState<Invite[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)
  const openCount = invites.filter(i => i.state === 'open').length
  async function loadList() {
    setListLoading(true); setListError(false)
    try { setInvites((await $fetch<{ invites: Invite[] }>('/api/admin/invites')).invites || []) }
    catch { setListError(true) } finally { setListLoading(false) }
  }
  // onMounted(loadList) + watch(tab → 'list' 이면 재조회)
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; void loadList(); return }
    if (tab === 'list') void loadList()
  }, [tab])

  const sorted = useMemo(() => sortInvites(invites), [invites])
  function fmtDate(iso: string | null) {
    if (!iso) return '—'
    return new Date(iso).toLocaleDateString(locale === 'ko' ? 'ko-KR' : 'en-US', { month: '2-digit', day: '2-digit' })
  }
  const groupName = (id: string | null) => (id ? groups.find(g => g.id === id)?.name : null)
  async function revoke(i: Invite) {
    if (!await confirmBox(t('admin.users.invites.revokeBody', { who: i.email || t('admin.users.invites.linkOnly') }), { title: t('admin.users.invites.revokeTitle'), confirmLabel: t('admin.users.invites.revoke'), danger: true })) return
    setRevoking(i.id)
    try {
      const r = await $fetch<Invite>(`/api/admin/invites/${i.id}`, { method: 'DELETE' })
      setInvites(list => list.map(x => (x.id === i.id ? { ...x, ...r } : x)))
      onChanged?.()
    } catch (e: any) { addToast('error', e?.data?.detail || t('admin.users.invites.revokeFailed')) }
    finally { setRevoking(null) }
  }

  const TABS = [
    { key: 'new', label: t('admin.users.invites.tabNew') },
    { key: 'list', label: t('admin.users.invites.tabList'), count: openCount || undefined },
  ]

  const close = () => onClose?.()

  const footer = tab === 'new' && created
    ? (
      <>
        <UiButton variant="outline" size="sm" className="mr-auto" onClick={again}>{t('admin.users.invites.again')}</UiButton>
        <UiButton variant="outline" size="sm" onClick={copyAll}>{t('admin.users.invites.copyAll')}</UiButton>
        <UiButton size="sm" onClick={close}>{t('common.close')}</UiButton>
      </>
    )
    : tab === 'new'
      ? (
        <>
          <UiButton variant="outline" size="sm" onClick={close}>{t('common.cancel')}</UiButton>
          <UiButton size="sm" disabled={creating} onClick={create}>
            {creating ? t('common.processing') : emails.length ? t('admin.users.invites.createN', { n: emails.length }) : t('admin.users.invites.createLinks')}
          </UiButton>
        </>
      )
      : <UiButton variant="outline" size="sm" onClick={close}>{t('common.close')}</UiButton>

  return (
    <UiModal title={t('admin.users.invite')} size="520" onClose={close} footer={footer}>
      <UiTabs modelValue={tab} onUpdateModelValue={v => setTab(v as 'new' | 'list')} items={TABS} size="sm" flush ariaLabel={t('admin.users.invite')} className="-mx-5 -mt-2 border-b border-border px-5" />

      {/* 새 초대 */}
      {tab === 'new'
        ? (!created
          ? (
            <div className="flex flex-col gap-3.5">
              <UiTextarea
                modelValue={form.emails}
                onUpdateModelValue={v => patch({ emails: v })}
                label={t('admin.users.invites.emails')}
                hint={t('admin.users.invites.emailsHint')}
                placeholder={t('admin.users.invites.emailsPlaceholder')}
                rows={3}
                mono
              />
              <div className="grid gap-3 sm:grid-cols-2">
                {!emails.length && (
                  <UiInput modelValue={form.count} onUpdateModelValue={v => patch({ count: v })} type="number" min="1" max="50" label={t('admin.users.invites.count')} mono />
                )}
                <UiSelect modelValue={form.expires} onUpdateModelValue={v => patch({ expires: String(v ?? '') })} options={EXPIRES} label={t('admin.users.invites.expires')} />
                {groups.length > 0 && (
                  <UiSelect modelValue={form.group} onUpdateModelValue={v => patch({ group: String(v ?? '') })} options={groupOptions} label={t('admin.users.invites.group')} placeholder="" />
                )}
              </div>
              {emails.length > 0 && (
                <UiSwitch modelValue={form.sendEmail} onUpdateModelValue={v => patch({ sendEmail: v })} label={t('admin.users.invites.sendEmail')} description={t('admin.users.invites.sendEmailDesc')} />
              )}
              <p className="text-xs text-muted-foreground">{t('admin.users.invites.note')}</p>
              {formError && <UiErrorTile title={formError} noRetry />}
            </div>
          )
          : (
            /* 생성 결과: 링크는 이 시점에만 확인 가능 */
            <div className="flex flex-col gap-3 text-[13px]">
              <p className="text-foreground">{t('admin.users.invites.createdLead', { n: created.length })}</p>
              <ul className="-mx-5 border-y border-border">
                {created.map(i => (
                  <li key={i.id} className="flex min-h-12 items-center gap-3 border-b border-border px-5 py-2 last:border-b-0">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-semibold text-foreground">{i.email || t('admin.users.invites.linkOnly')}</span>
                        {i.emailed
                          ? <UiBadge tone="success" tint size={18}>{t('admin.users.invites.emailed')}</UiBadge>
                          : i.email_error ? <UiBadge tone="warning" tint size={18} title={i.email_error}>{t('admin.users.invites.emailFailed')}</UiBadge> : null}
                      </div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">{i.url}</div>
                    </div>
                    <UiIconButton label={t('admin.users.invites.copyLink')} icon="copy" onClick={() => void copy(i.url)} />
                  </li>
                ))}
              </ul>
            </div>
          ))
        : (
          /* 보낸 초대 */
          listLoading && !invites.length
            ? <UiSkeleton preset="list" rows={3} />
            : listError
              ? <UiErrorTile placement="panel" title={t('admin.users.invites.listError')} onRetry={loadList} />
              : !invites.length
                ? <UiEmptyState variant="panel" icon="user-plus" title={t('admin.users.invites.listEmpty')} actionLabel={t('admin.users.invites.tabNew')} onAction={() => setTab('new')} />
                : (
                  <ul className="-mx-5 -mb-2 max-h-[50dvh] overflow-y-auto text-[13px]">
                    {sorted.map(i => (
                      <li key={i.id} className="flex min-h-12 items-center gap-3 border-b border-border px-5 py-2 last:border-b-0">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className={cn('truncate text-foreground', i.state === 'open' ? 'font-semibold' : '')}>{i.email || t('admin.users.invites.linkOnly')}</span>
                            <UiBadge tone={STATE[i.state].tone} tint size={18}>{t(STATE[i.state].key)}</UiBadge>
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {i.state === 'used'
                              ? t('admin.users.invites.usedOn', { date: fmtDate(i.used_at) })
                              : t('admin.users.invites.expiresOn', { date: fmtDate(i.expires_at) })}
                            {groupName(i.group_id) && <span> · {groupName(i.group_id)}</span>}
                          </div>
                        </div>
                        {i.state === 'open' && (
                          <button
                            type="button"
                            className="relative shrink-0 text-xs font-semibold text-danger hover:underline after:absolute after:-inset-3 after:content-[''] disabled:opacity-50"
                            disabled={revoking === i.id}
                            onClick={() => void revoke(i)}
                          >{t('admin.users.invites.revoke')}</button>
                        )}
                      </li>
                    ))}
                  </ul>
                )
        )}
    </UiModal>
  )
}

export default AdminInviteModal
