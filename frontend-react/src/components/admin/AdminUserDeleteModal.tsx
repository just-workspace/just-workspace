/**
 * 사용자 삭제 모달(관리 › 사용자 ⋮ › 삭제) — Vue components/admin/AdminUserDeleteModal.vue.
 * 시안에 화면이 없어 파괴적 확인 + 기존 폼 규격으로 구성(디자이너 확인 필요).
 * 1) GET /api/admin/users/{id}/delete-impact — 막힘(자기 자신·마지막 관리자) · 넘겨야 할 공동 콘텐츠 · 지워질 개인 데이터 · 남는 파일
 * 2) 공동 콘텐츠가 있으면 넘겨받을 사람(transfer_to, 활성 사용자) 선택 필수
 * 3) 사용자명을 그대로 입력해야 [삭제] 가 켜진다 → DELETE /api/admin/users/{id}?confirm=&transfer_to=
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { addToast } from '~/composables/useToast'
import { UiModal } from '~/components/ui/Modal'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSelect } from '~/components/ui/Select'
import { UiInput } from '~/components/ui/Input'
import { UiButton } from '~/components/ui/Button'

export interface AdminUserDeleteModalProps {
  /** 지울 사용자 */
  user: { id: string; username: string; display_name?: string | null }
  /** 닫기(취소) */
  onClose?: () => void
  /** 삭제가 끝났을 때 */
  onDeleted?: () => void
}

interface Impact {
  user: { id: string; username: string; status: string; is_admin: boolean }
  transfer_required: Record<string, number>
  nullified: Record<string, number>
  deleted: Record<string, number>
  kept_outside_db: { files_dir: string | null; mail_account: string | null }
  blocked: string | null
}

// 공동 콘텐츠 표 이름(table.column → i18n)
const TRANSFER_LABEL: Record<string, string> = {
  'channels.created_by': 'admin.users.delete.what.channels',
  'wiki_spaces.owner_id': 'admin.users.delete.what.wikiSpaces',
  'wiki_pages.author_id': 'admin.users.delete.what.wikiPages',
  'wiki_page_versions.author_id': 'admin.users.delete.what.wikiVersions',
  'posts.author_id': 'admin.users.delete.what.posts',
  'post_comments.author_id': 'admin.users.delete.what.comments',
}
const sum = (o?: Record<string, number>) => Object.values(o || {}).reduce((a, b) => a + b, 0)

export function AdminUserDeleteModal({ user, onClose, onDeleted }: AdminUserDeleteModalProps) {
  const { t } = useI18n()

  const [impact, setImpact] = useState<Impact | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [heirs, setHeirs] = useState<{ value: string; label: string }[]>([])
  const [transferTo, setTransferTo] = useState<string | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const name = user.display_name || user.username

  const transferRows = Object.entries(impact?.transfer_required || {}).map(([k, n]) => ({ k, n, label: TRANSFER_LABEL[k] ? t(TRANSFER_LABEL[k]) : k }))
  const needsHeir = transferRows.length > 0
  const deletedCount = sum(impact?.deleted)
  const nullifiedCount = sum(impact?.nullified)
  const canDelete = !!impact && !impact.blocked && confirmText.trim() === user.username
    && (!needsHeir || !!transferTo) && !busy

  async function loadHeirs() {
    try {
      const r = await $fetch<{ users: { id: string; username: string; display_name: string | null }[] }>('/api/admin/users', {
        params: { status: 'active', sort: 'display_name', page: 1, size: 200 },
      })
      setHeirs(r.users.filter(u => u.id !== user.id).map(u => ({ value: u.id, label: u.display_name ? `${u.display_name} (${u.username})` : u.username })))
    } catch { setHeirs([]) }
  }
  async function load() {
    setLoading(true); setLoadError('')
    try {
      const imp = await $fetch<Impact>(`/api/admin/users/${user.id}/delete-impact`)
      setImpact(imp)
      if (Object.keys(imp.transfer_required || {}).length > 0 && !heirs.length) await loadHeirs()
    } catch (e: any) {
      setLoadError(e?.data?.detail || t('admin.users.delete.loadError'))
    } finally { setLoading(false) }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [])

  async function submit() {
    if (!canDelete) return
    setBusy(true); setError('')
    try {
      const params: Record<string, string> = { confirm: user.username }
      if (transferTo) params.transfer_to = transferTo
      await $fetch(`/api/admin/users/${user.id}`, { method: 'DELETE', params })
      addToast('success', t('admin.users.delete.done', { name }))
      onDeleted?.()
    } catch (e: any) {
      const d = e?.data?.detail
      if (e?.statusCode === 409 && d && typeof d === 'object' && d.transfer_required) {
        // 그새 공동 콘텐츠가 생겼다 — 표를 새로 보이고 넘겨받을 사람을 고르게
        setImpact(cur => (cur ? { ...cur, transfer_required: d.transfer_required } : cur))
        if (!heirs.length) await loadHeirs()
        setError(d.message || t('admin.users.delete.needHeir'))
      } else {
        setError(typeof d === 'string' ? d : (d?.message || t('admin.users.delete.failed')))
      }
    } finally { setBusy(false) }
  }

  const footer = (
    <>
      <UiButton variant="outline" size="sm" onClick={() => onClose?.()}>{t('common.cancel')}</UiButton>
      {impact && !impact.blocked && (
        <UiButton variant="danger" size="sm" disabled={!canDelete} onClick={submit}>{busy ? t('common.processing') : t('admin.users.delete.confirm')}</UiButton>
      )}
    </>
  )

  return (
    <UiModal title={t('admin.users.delete.title', { name })} size="480" danger persistent onClose={() => onClose?.()} footer={footer}>
      {loading
        ? <UiSkeleton preset="list" rows={3} />
        : loadError
          ? <UiErrorTile placement="panel" title={loadError} onRetry={load} />
          : impact
            ? (
              <div className="flex flex-col gap-4 text-[13px]">
                {impact.blocked
                  ? <UiErrorTile title={impact.blocked} noRetry />
                  : (
                    <>
                      <p className="text-foreground">{t('admin.users.delete.lead')}</p>

                      {/* 넘겨야 할 공동 콘텐츠 */}
                      {needsHeir && (
                        <section className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/[0.08] px-3.5 py-3">
                          <div className="font-semibold text-foreground">{t('admin.users.delete.transferTitle')}</div>
                          <ul className="flex flex-col gap-0.5 text-muted-foreground">
                            {transferRows.map(r => (
                              <li key={r.k} className="flex"><span className="flex-1">{r.label}</span><span className="font-mono text-foreground">{r.n}</span></li>
                            ))}
                          </ul>
                          <UiSelect
                            modelValue={transferTo}
                            onUpdateModelValue={v => setTransferTo(v == null ? null : String(v))}
                            options={heirs}
                            label={t('admin.users.delete.heir')}
                            placeholder={t('admin.users.delete.heirPlaceholder')}
                            hint={heirs.length ? undefined : t('admin.users.delete.noHeirs')}
                          />
                        </section>
                      )}

                      <ul className="flex flex-col gap-1 text-muted-foreground">
                        {deletedCount > 0 && <li>· {t('admin.users.delete.deletedLine', { n: deletedCount })}</li>}
                        {nullifiedCount > 0 && <li>· {t('admin.users.delete.nullifiedLine', { n: nullifiedCount })}</li>}
                        <li>
                          · {t('admin.users.delete.keptLine')}
                          {impact.kept_outside_db.files_dir && <span className="block truncate font-mono text-[11px]">{impact.kept_outside_db.files_dir}</span>}
                          {impact.kept_outside_db.mail_account && <span className="block truncate font-mono text-[11px]">{impact.kept_outside_db.mail_account}</span>}
                        </li>
                      </ul>

                      <UiInput
                        modelValue={confirmText}
                        onUpdateModelValue={setConfirmText}
                        label={t('admin.users.delete.confirmLabel', { username: user.username })}
                        placeholder={user.username}
                        autocomplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        mono
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit() } }}
                      />
                      {error && <UiErrorTile title={error} noRetry />}
                    </>
                  )}
              </div>
            )
            : null}
    </UiModal>
  )
}

export default AdminUserDeleteModal
