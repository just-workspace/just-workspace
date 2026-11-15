/**
 * 메일 필터 규칙 — Vue 판 components/mail/MailFilterRules.vue (설정 › 메일 › 필터 탭, 시안 ML3 · 메일 8 ②).
 * 예전 사이드바 모달(MailFilters)을 설정 화면 안 카드로 옮겼다.
 * 시안엔 필터 탭 내용 그림이 없어 PatRows(행 48·제목 13/600·보조 12) + PatForm(모달 폼) 공통 규격으로 구성.
 * API: GET/POST/PATCH/DELETE /api/mail/filters, POST /api/mail/filters/apply — 그대로.
 * 쓰는 곳: 개인 설정 › 메일(설정 모듈이 연결한다 — MIGRATION.md 4-1).
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
// Vue 의 class 묶음처럼 그냥 잇는다(tailwind-merge 를 쓰는 cn 은 leading-[1.35]+text-xl 같은 짝을 지워 Vue 와 달라진다)
import { clsx as cx } from 'clsx'
import { $fetch } from '~/lib/api'
import { useMail, mailStore, fetchAccounts, fetchMailboxes } from '~/composables/useMail'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { SettingsCard } from '~/components/settings/SettingsCard'
import { UiButton } from '~/components/ui/Button'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiSwitch } from '~/components/ui/Switch'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiModal } from '~/components/ui/Modal'
import { UiInput } from '~/components/ui/Input'
import { UiSelect } from '~/components/ui/Select'

interface FilterRule {
  id: string
  name: string
  field: string
  match_type: string
  value: string
  action: string
  target_folder: string
  priority: number
  is_active: boolean
}

interface RuleForm { name: string; field: string; match_type: string; value: string; target_folder: string }
const emptyForm = (): RuleForm => ({ name: '', field: 'from', match_type: 'contains', value: '', target_folder: '' })

export interface MailFilterRulesProps {
  /** 규칙 수(탭 배지 등) — Vue emit('count') */
  onCount?: (n: number) => void
}

/** 메일 필터 규칙 카드 + 편집 모달 */
export function MailFilterRules({ onCount }: MailFilterRulesProps) {
  const { t } = useI18n()
  const { mailboxes } = useMail()

  const [rules, setRules] = useState<FilterRule[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [applying, setApplying] = useState(false)

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setFormState] = useState<RuleForm>(emptyForm)
  const setForm = (p: Partial<RuleForm>) => setFormState(f => ({ ...f, ...p }))
  const [formError, setFormError] = useState('')

  const FIELDS = [
    { value: 'from', label: t('mail.filters.fieldFrom') },
    { value: 'to', label: t('mail.filters.fieldTo') },
    { value: 'subject', label: t('mail.filters.fieldSubject') },
    { value: 'any', label: t('mail.filters.fieldAny') },
  ]
  const MATCH_TYPES = [
    { value: 'contains', label: t('mail.filters.matchContains') },
    { value: 'equals', label: t('mail.filters.matchEquals') },
    { value: 'starts_with', label: t('mail.filters.matchStartsWith') },
  ]
  const folderOptions = mailboxes.map(mb => ({ value: mb.id, label: mb.name || mb.id }))

  async function fetchRules() {
    setLoading(true)
    setLoadError('')
    try {
      const data = await $fetch<{ rules: FilterRule[] }>('/api/mail/filters')
      setRules(data.rules)
      onCount?.(data.rules.length)
    } catch (e: any) {
      setLoadError(e?.data?.detail || t('mail.filters.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  function openCreate() {
    setEditingId(null)
    setFormState(emptyForm())
    setFormError('')
    setShowForm(true)
  }
  function openEdit(rule: FilterRule) {
    setEditingId(rule.id)
    setFormState({ name: rule.name, field: rule.field, match_type: rule.match_type, value: rule.value, target_folder: rule.target_folder })
    setFormError('')
    setShowForm(true)
  }

  async function saveRule() {
    if (!form.name.trim() || !form.value.trim() || !form.target_folder) {
      setFormError(t('mail.filters.formRequired'))
      return
    }
    setSaving(true)
    try {
      if (editingId) await $fetch(`/api/mail/filters/${editingId}`, { method: 'PATCH', body: form })
      else await $fetch('/api/mail/filters', { method: 'POST', body: form })
      setShowForm(false)
      await fetchRules()
    } catch (e: any) {
      setFormError(e?.data?.detail || t('mail.filters.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  async function deleteRule(rule: FilterRule) {
    if (!await confirmBox(t('mail.filters.deleteConfirm'), { title: t('mail.filters.deleteTitle'), confirmLabel: t('common.delete'), danger: true })) return
    try {
      await $fetch(`/api/mail/filters/${rule.id}`, { method: 'DELETE' })
      await fetchRules()
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('mail.filters.deleteFailed'))
    }
  }

  async function setActive(rule: FilterRule, v: boolean) {
    const prev = rule.is_active
    setRules(rs => rs.map(r => (r.id === rule.id ? { ...r, is_active: v } : r)))
    try {
      await $fetch(`/api/mail/filters/${rule.id}`, { method: 'PATCH', body: { is_active: v } })
    } catch (e: any) {
      setRules(rs => rs.map(r => (r.id === rule.id ? { ...r, is_active: prev } : r)))
      addToast('error', e?.data?.detail || t('mail.filters.toggleFailed'))
    }
  }

  async function applyFilters() {
    setApplying(true)
    try {
      const data = await $fetch<{ moved: number }>('/api/mail/filters/apply', { method: 'POST' })
      if (data.moved > 0) addToast('success', t('mail.filters.applyResult', { count: data.moved }))
      else addToast('info', t('mail.filters.applyNone'))
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('mail.filters.applyFailed'))
    } finally {
      setApplying(false)
    }
  }

  function label(list: { value: string; label: string }[], v: string) { return list.find(x => x.value === v)?.label || v }
  function folderLabel(id: string) { return mailboxes.find(m => m.id === id)?.name || id }

  useEffect(() => {
    void fetchRules()
    // 옮길 폴더 목록 — 설정 화면에서 바로 들어오면 메일함을 아직 안 받았다
    void (async () => {
      if (!mailStore.getState().mailboxes.length) {
        if (!mailStore.getState().accounts.length) await fetchAccounts()
        if (mailStore.getState().accounts.length) await fetchMailboxes()
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <SettingsCard
        title={t('mail.filters.cardTitle')}
        description={t('mail.filters.cardDesc')}
        flush
        header={(
          <>
            <UiButton variant="outline" size="xs" disabled={applying || !rules.length} onClick={applyFilters}>{applying ? t('common.processing') : t('mail.filters.applyNow')}</UiButton>
            <UiButton size="xs" onClick={openCreate}>{t('mail.filters.add')}</UiButton>
          </>
        )}
      >
        {loading
          ? <UiSkeleton preset="list" rows={3} />
          : loadError
            ? <div className="border-t border-border p-4"><UiErrorTile placement="card" title={loadError} onRetry={fetchRules} /></div>
            : !rules.length && <UiEmptyState variant="panel" icon="filter" title={t('mail.filters.empty')} actionLabel={t('mail.filters.add')} onAction={openCreate} />}
        {rules.map(rule => (
          <div
            key={rule.id}
            className={cx('flex min-h-12 items-center gap-3 border-t border-border px-5 py-2 text-[13px]', rule.is_active ? '' : 'text-muted-foreground')}
          >
            <div className="min-w-0 flex-1">
              <div className={cx('truncate font-semibold', rule.is_active ? 'text-foreground' : '')}>{rule.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {label(FIELDS, rule.field)} {label(MATCH_TYPES, rule.match_type)} "<span className="font-medium text-foreground/85">{rule.value}</span>" → {folderLabel(rule.target_folder)}
              </div>
            </div>
            <UiSwitch modelValue={rule.is_active} ariaLabel={t('mail.filters.enableRule', { name: rule.name })} onUpdateModelValue={v => setActive(rule, v)} />
            <UiIconButton label={t('common.edit')} icon="edit" onClick={() => openEdit(rule)} />
            <UiIconButton label={t('common.delete')} icon="trash" className="text-danger hover:text-danger" onClick={() => deleteRule(rule)} />
          </div>
        ))}
      </SettingsCard>

      {showForm && (
        <UiModal
          title={editingId ? t('mail.filters.edit') : t('mail.filters.add')}
          onClose={() => setShowForm(false)}
          footer={(
            <>
              <UiButton variant="outline" size="sm" onClick={() => setShowForm(false)}>{t('common.cancel')}</UiButton>
              <UiButton size="sm" disabled={saving} onClick={saveRule}>{saving ? t('common.processing') : t('common.save')}</UiButton>
            </>
          )}
        >
          <UiInput modelValue={form.name} onUpdateModelValue={v => setForm({ name: v })} label={t('mail.filters.ruleName')} placeholder={t('mail.filters.ruleNamePlaceholder')} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <UiSelect modelValue={form.field} onUpdateModelValue={v => setForm({ field: String(v ?? '') })} label={t('mail.filters.condition')} options={FIELDS} />
            <UiSelect modelValue={form.match_type} onUpdateModelValue={v => setForm({ match_type: String(v ?? '') })} label={t('mail.filters.matchType')} options={MATCH_TYPES} />
          </div>
          <UiInput modelValue={form.value} onUpdateModelValue={v => setForm({ value: v })} label={t('mail.filters.value')} placeholder={t('mail.filters.valuePlaceholder')} />
          <UiSelect modelValue={form.target_folder} onUpdateModelValue={v => setForm({ target_folder: String(v ?? '') })} label={t('mail.filters.targetFolder')} options={folderOptions} placeholder={t('mail.filters.selectFolder')} />
          {formError && <UiErrorTile placement="card" title={formError} noRetry />}
        </UiModal>
      )}
    </>
  )
}

export default MailFilterRules
