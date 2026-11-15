// 설정 › 메일: 탭 계정 · 필터(n) · 서명 · 보관·전달.
//  계정: GET/PATCH/DELETE /api/mail/accounts, POST …/test. 추가·상세 편집은 기존 /mail/accounts 화면(IMAP/SMTP·OAuth 폼)으로.
//  필터: MailFilterRules(메일 모듈) · 서명: /api/mail/signatures
//  보관: 외부 메일 .eml 아카이브(archive_enabled · archive/backfill · archive/status)
//  전달·자동 응답: 서버 API 가 없어 비활성으로 보여 준다.
import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { $fetch } from '~/lib/api'
import { navigateTo, useRoute } from '~/lib/router'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { fetchAccounts, mailStore, type MailAccountInfo } from '~/composables/useMail'
import { useMailSignature, type Signature } from '~/composables/useMailSignature'
import { useUserPrefs } from '~/composables/useUserPrefs'
import { confirmBox } from '~/composables/useDialog'
import { addToast } from '~/composables/useToast'
import { NuxtLink } from '~/components/NuxtLink'
import { UiTabs } from '~/components/ui/Tabs'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiButton } from '~/components/ui/Button'
import type { UiMenuItem } from '~/components/ui/Menu'
import { SettingsHeader } from '~/components/settings/SettingsHeader'
import { SettingsCard } from '~/components/settings/SettingsCard'
import { SettingsMailFilterRules } from '~/components/settings/SettingsMailFilterRules'
import { SettingsMailClientSetup } from '~/components/settings/SettingsMailClientSetup'
import {
  SettingsMailAccountRow, SettingsMailArchiveRow, SettingsMailDisabledRow, SettingsMdnRow, SettingsSignatureModal, SettingsSignatureRow,
  type SignatureDraft,
} from '~/components/settings/SettingsMailParts'

const TAB_KEYS = ['accounts', 'filters', 'signatures', 'archive'] as const
const detailOf = (e: unknown) => (e as { data?: { detail?: string } } | null)?.data?.detail

export default function SettingsMailPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: `${t('profile.navMail')} | ${appName}` })

  const route = useRoute()
  const [tab, setTabState] = useState<string | null>(() => {
    const q = route.query.tab
    return typeof q === 'string' && (TAB_KEYS as readonly string[]).includes(q) ? q : 'accounts'
  })
  // watch(tab) → 쿼리 반영(replace)
  function setTab(v: string | null) {
    setTabState(v)
    void navigateTo({ query: { ...route.query, tab: v || undefined } }, { replace: true })
  }

  const accounts = useStore(mailStore, s => s.accounts)
  const { signatures, loading: sigLoading, fetchSignatures, createSignature, updateSignature, deleteSignature } = useMailSignature()

  const [accountsLoading, setAccountsLoading] = useState(true)
  const [accountsError, setAccountsError] = useState('')
  async function loadAccounts() {
    setAccountsLoading(true)
    setAccountsError('')
    await fetchAccounts() // 실패를 삼키는 공용 조회 — 비어 있으면 한 번 더 물어 오류인지 확인한다
    if (!mailStore.getState().accounts.length) {
      try { await $fetch('/api/mail/accounts') } catch (e) { setAccountsError(detailOf(e) || t('settings.mail.accountsLoadError')) }
    }
    setAccountsLoading(false)
  }
  const [filterCount, setFilterCount] = useState<number | undefined>(undefined)

  // onMounted · onBeforeUnmount(alive=false)
  const alive = useRef(true)
  const mounted = useRef(false)
  useEffect(() => {
    alive.current = true
    if (!mounted.current) {
      mounted.current = true
      void fetchSignatures()
      void loadAccounts()
      $fetch<{ rules: unknown[] }>('/api/mail/filters').then((d) => { setFilterCount(d.rules.length) }).catch(() => {})
    }
    return () => { alive.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const TABS = [
    { key: 'accounts', label: t('settings.mail.tabAccounts'), count: accounts.length || undefined },
    { key: 'filters', label: t('settings.mail.tabFilters'), count: filterCount || undefined },
    { key: 'signatures', label: t('settings.mail.tabSignatures'), count: signatures.length || undefined },
    { key: 'archive', label: t('settings.mail.tabArchive') },
  ]

  // ─── 계정 ───
  const [testing, setTesting] = useState<string | null>(null)
  async function testAccount(a: MailAccountInfo) {
    setTesting(a.id)
    try {
      const r = await $fetch<{ imap: { ok: boolean; message: string }; smtp: { ok: boolean; message: string } }>(`/api/mail/accounts/${a.id}/test`, { method: 'POST' })
      if (r.imap.ok && r.smtp.ok) addToast('success', t('settings.mail.testOk', { email: a.email }))
      else addToast('error', `${a.email} — ${!r.imap.ok ? t('settings.mail.testImapError', { msg: r.imap.message }) : ''} ${!r.smtp.ok ? t('settings.mail.testSmtpError', { msg: r.smtp.message }) : ''}`.trim())
    } catch (e) {
      addToast('error', detailOf(e) || t('mail.accounts.testFail'))
    } finally {
      setTesting(null)
    }
  }
  async function setDefault(a: MailAccountInfo) {
    try {
      await $fetch(`/api/mail/accounts/${a.id}`, { method: 'PATCH', body: { is_default: true } })
      await fetchAccounts()
    } catch (e) { addToast('error', detailOf(e) || t('settings.mail.setDefaultError')) }
  }
  async function removeAccount(a: MailAccountInfo) {
    if (!await confirmBox(t('mail.accounts.deleteConfirm'), { title: t('settings.mail.deleteAccountTitle'), confirmLabel: t('common.delete'), danger: true })) return
    try {
      await $fetch(`/api/mail/accounts/${a.id}`, { method: 'DELETE' })
      await fetchAccounts()
    } catch (e) { addToast('error', detailOf(e) || t('mail.accounts.deleteFail')) }
  }
  function accountMenu(a: MailAccountInfo): UiMenuItem[] {
    const items: UiMenuItem[] = [
      { key: 'test', label: testing === a.id ? t('settings.mail.testing') : t('settings.mail.testConnection'), icon: 'refresh', disabled: testing === a.id },
    ]
    if (!a.is_default) items.push({ key: 'default', label: t('settings.mail.makeDefault'), icon: 'star' })
    if (!a.is_builtin) items.push({ key: 'delete', label: t('common.delete'), icon: 'trash', danger: true })
    return items
  }
  function onAccountMenu(a: MailAccountInfo, key: string) {
    if (key === 'test') void testAccount(a)
    else if (key === 'default') void setDefault(a)
    else if (key === 'delete') void removeAccount(a)
  }

  // 읽음 확인 요청 응답 — 개인 설정 read_receipt_default(서버 동기화)
  const { readReceiptDefault, setReadReceiptDefault } = useUserPrefs()
  const [mdnSaved, setMdnSaved] = useState(false)
  function setMdnPolicy(v: string | number | null) {
    if (v !== 'ask' && v !== 'always' && v !== 'never') return
    setReadReceiptDefault(v)
    setMdnSaved(true); setTimeout(() => { setMdnSaved(false) }, 2000)
  }

  // ─── 서명 ───
  function stripHtml(html: string) { return html.replace(/<[^>]*>/g, '').slice(0, 100) }
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Signature | null>(null)
  const [form, setForm] = useState<SignatureDraft>({ name: '', html_content: '', is_default: false })
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  function openCreate() { setEditing(null); setForm({ name: '', html_content: '', is_default: false }); setFormError(''); setShowForm(true) }
  function openEdit(s: Signature) { setEditing(s); setForm({ name: s.name, html_content: s.html_content, is_default: s.is_default }); setFormError(''); setShowForm(true) }
  async function submit() {
    if (!form.name.trim() || !form.html_content.trim()) { setFormError(t('profile.sigNameAndContentRequired')); return }
    setSubmitting(true); setFormError('')
    try {
      const body = { name: form.name, html_content: form.html_content, is_default: form.is_default }
      if (editing) await updateSignature(editing.id, body)
      else await createSignature(body)
      setShowForm(false)
    } catch (e) { setFormError(detailOf(e) || t('profile.sigSaveError')) }
    finally { setSubmitting(false) }
  }
  async function removeSig(id: string) {
    if (!await confirmBox(t('profile.sigDeleteConfirm'), { title: t('settings.mail.deleteSignatureTitle'), confirmLabel: t('common.delete'), danger: true })) return
    await deleteSignature(id)
  }

  // ─── 보관(외부 메일 .eml 아카이브) ───
  const externalAccounts = accounts.filter(a => !a.is_builtin)
  const [archiving, setArchiving] = useState<string | null>(null)
  const [backfill, setBackfill] = useState<Record<string, { scanned: number; saved: number }>>({})
  async function setArchive(a: MailAccountInfo, v: boolean) {
    setArchiving(a.id)
    try {
      await $fetch(`/api/mail/accounts/${a.id}`, { method: 'PATCH', body: { archive_enabled: v } })
      await fetchAccounts()
      addToast('success', v ? t('mail.archive.enabled') : t('mail.archive.disabled'))
    } catch (e) {
      addToast('error', detailOf(e) || t('mail.archive.toggleFailed'))
    } finally {
      setArchiving(null)
    }
  }
  async function startBackfill(a: MailAccountInfo) {
    if (!await confirmBox(t('mail.archive.backfillConfirm'), { title: t('settings.mail.backfill'), confirmLabel: t('settings.mail.backfillStart') })) return
    setArchiving(a.id)
    try {
      // 요청 안에서 끝나지 않는 일(nginx 120초) — 시작만 시키고 상태를 폴링한다(기존 /mail/accounts 와 같은 방식)
      await $fetch(`/api/mail/accounts/${a.id}/archive/backfill?limit=200`, { method: 'POST' })
      addToast('info', t('mail.archive.backfillStarted'))
      void pollBackfill(a)
    } catch (e) {
      setArchiving(null)
      addToast('error', detailOf(e) || t('mail.archive.backfillFailed'))
    }
  }
  async function pollBackfill(a: MailAccountInfo) {
    for (let i = 0; i < 600 && alive.current; i++) {
      await new Promise(r => setTimeout(r, 2000))
      let st: { state?: string; scanned?: number; saved?: number; skipped?: number; error?: string }
      try { st = await $fetch(`/api/mail/accounts/${a.id}/archive/status`) } catch { continue }
      if (st.state === 'running') { setBackfill(b => ({ ...b, [a.id]: { scanned: st.scanned || 0, saved: st.saved || 0 } })); continue }
      setBackfill((b) => { const next = { ...b }; delete next[a.id]; return next })
      setArchiving(null)
      if (st.state === 'done') addToast('success', t('mail.archive.backfillDone', { saved: st.saved || 0, skipped: st.skipped || 0 }))
      else if (st.state === 'error') addToast('error', st.error || t('mail.archive.backfillFailed'))
      return
    }
    setArchiving(null)
  }

  return (
    <>
      <SettingsHeader title={t('profile.navMail')} subtitle={t('settings.mail.subtitle')} />

      <UiTabs modelValue={tab} onUpdateModelValue={setTab} items={TABS} ariaLabel={t('settings.mail.tabsLabel')} />

      {/* ─────────── 계정 ─────────── */}
      {tab === 'accounts' && (
        <>
          {accountsLoading && !accounts.length
            ? <UiSkeleton preset="card" rows={2} />
            : accountsError
              ? <UiErrorTile placement="card" title={accountsError} onRetry={() => void loadAccounts()} />
              : accounts.length
                ? (
                  <div className="overflow-hidden rounded-lg border border-border bg-card">
                    {accounts.map((a, i) => (
                      <SettingsMailAccountRow
                        key={a.id}
                        account={a}
                        divided={i > 0}
                        menuItems={accountMenu(a)}
                        onMenu={k => onAccountMenu(a, k)}
                        onEdit={() => void navigateTo('/mail/accounts')}
                      />
                    ))}
                  </div>
                )
                : <UiEmptyState variant="full" icon="mail" title={t('mail.onboarding.title')} description={t('mail.onboarding.desc')} />}

          <NuxtLink
            to="/mail/accounts?add=1"
            className="inline-flex h-9 items-center self-start rounded-md border border-dashed border-border px-3.5 text-[13px] font-semibold hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >{t('settings.mail.addAccount')}</NuxtLink>

          <SettingsMdnRow modelValue={readReceiptDefault} onUpdateModelValue={setMdnPolicy} saved={mdnSaved} />

          <SettingsMailClientSetup />
        </>
      )}

      {/* ─────────── 필터 ─────────── */}
      {tab === 'filters' && <SettingsMailFilterRules onCount={setFilterCount} />}

      {/* ─────────── 서명 ─────────── */}
      {tab === 'signatures' && (
        <>
          <SettingsCard
            title={t('profile.sectionSignatures')}
            description={t('settings.mail.signaturesDesc')}
            flush
            header={<UiButton size="xs" onClick={openCreate}>{t('profile.sigNew')}</UiButton>}
          >
            {sigLoading
              ? <UiSkeleton preset="list" rows={2} />
              : !signatures.length
                ? <UiEmptyState variant="panel" icon="edit" title={t('profile.sigEmpty')} actionLabel={t('profile.sigNew')} onAction={openCreate} />
                : null}
            {signatures.map(s => (
              <SettingsSignatureRow
                key={s.id}
                name={s.name}
                preview={stripHtml(s.html_content)}
                isDefault={s.is_default}
                onSetDefault={() => void updateSignature(s.id, { is_default: true })}
                onEdit={() => openEdit(s)}
                onDelete={() => void removeSig(s.id)}
              />
            ))}
          </SettingsCard>

          {showForm && (
            <SettingsSignatureModal
              editing={!!editing}
              form={form}
              onChange={p => setForm(f => ({ ...f, ...p }))}
              error={formError}
              submitting={submitting}
              onSubmit={() => void submit()}
              onClose={() => setShowForm(false)}
            />
          )}
        </>
      )}

      {/* ─────────── 보관·전달 ─────────── */}
      {tab !== 'accounts' && tab !== 'filters' && tab !== 'signatures' && (
        <>
          <SettingsCard title={t('settings.mail.archiveTitle')} description={t('settings.mail.archiveDesc')} flush>
            {!externalAccounts.length && (
              <UiEmptyState variant="panel" icon="archive" title={t('settings.mail.archiveEmpty')} actionLabel={t('settings.mail.addAccount')} actionTo="/mail/accounts?add=1" />
            )}
            {externalAccounts.map(a => (
              <SettingsMailArchiveRow
                key={a.id}
                account={a}
                progress={backfill[a.id]}
                busy={archiving === a.id}
                onBackfill={() => void startBackfill(a)}
                onToggle={v => void setArchive(a, v)}
              />
            ))}
          </SettingsCard>

          <SettingsCard title={t('settings.mail.forwardTitle')} description={t('settings.mail.forwardDesc')} flush>
            <SettingsMailDisabledRow title={t('settings.mail.autoForward')} ariaLabel={t('settings.mail.autoForward')} />
            <SettingsMailDisabledRow title={t('settings.mail.autoReplyFull')} ariaLabel={t('settings.mail.autoReply')} />
          </SettingsCard>
        </>
      )}
    </>
  )
}
