/**
 * 관리 › 설정 › 메일 발송. 폼 720.
 *  ① 메일 모듈 방식 — "방식" 선택(내장 메일 서버 / 외부 IMAP·SMTP) + 카드 푸터 저장.
 *  ② SMTP 발송 — 호스트·포트·보낸이·보안 + 계정·비밀번호, 푸터 = "마지막 시험 …" + [시험 메일 보내기] [되돌리기] [저장].
 *  ③ 메일 OAuth2 앱 자격 증명 = AdminMailOAuth.
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { navigateTo } from '~/lib/router'
import { $fetch } from '~/lib/api'
import { cn } from '~/lib/utils'
import { useAuth } from '~/composables/useAuth'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { addToast } from '~/composables/useToast'
import { AdminPageShell } from '~/components/admin/AdminPageShell'
import { AdminMailOAuth } from '~/components/admin/AdminMailOAuth'
import { SettingsCard } from '~/components/settings/SettingsCard'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiSelect } from '~/components/ui/Select'
import { UiInput } from '~/components/ui/Input'
import { UiPasswordInput } from '~/components/ui/PasswordInput'
import { UiButton } from '~/components/ui/Button'
import { UiModal } from '~/components/ui/Modal'
import { UiIcon } from '~/components/ui/Icon'

type Mode = 'builtin' | 'external'
interface Smtp { host: string; port: number | string; security: string; user: string; password: string; from_addr: string; last_test_at?: string | null; last_test_ok?: boolean }
const KEYS = ['host', 'port', 'security', 'user', 'password', 'from_addr'] as const
const SMTP_DEFAULT: Smtp = { host: '', port: 587, security: 'starttls', user: '', password: '', from_addr: '' }

export default function AdminMailPage() {
  const { t, locale } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: t('admin.common.headTitle', { page: t('admin.mail.title'), app: appName }) })
  const { user } = useAuth()
  useEffect(() => { if (user && !user.is_admin) void navigateTo('/') }, [user])

  function flash(set: (v: boolean) => void) { set(true); setTimeout(() => { set(false) }, 2000) }

  // ── ① 메일 모듈 방식 ──
  const [mode, setMode] = useState<Mode | null>(null)
  const [modeOrig, setModeOrig] = useState<Mode | null>(null)
  const [modeSaving, setModeSaving] = useState(false)
  const [modeSaved, setModeSaved] = useState(false)
  const [modeError, setModeError] = useState(false)
  async function loadMode() {
    setModeError(false)
    try {
      const v: Mode = (await $fetch<{ builtin_mailserver: boolean }>('/api/setup/features')).builtin_mailserver ? 'builtin' : 'external'
      setMode(v); setModeOrig(v)
    } catch { setModeError(true) }
  }
  const modeOptions = [
    { value: 'builtin', label: t('admin.mail.builtinTitle') },
    { value: 'external', label: t('admin.mail.externalOption') },
  ]
  const modeChanges = Number(mode !== modeOrig)
  async function saveMode() {
    setModeSaving(true)
    try {
      await $fetch('/api/setup/features', { method: 'PATCH', body: { builtin_mailserver: mode === 'builtin' } })
      setModeOrig(mode)
      flash(setModeSaved)
    } catch (e: any) { addToast('error', e?.data?.detail || t('admin.mail.modeSaveFailed')) }
    finally { setModeSaving(false) }
  }

  // ── ② SMTP ──
  const [smtp, setSmtp] = useState<Smtp>({ ...SMTP_DEFAULT })
  const [smtpOrig, setSmtpOrig] = useState<Smtp>({ ...SMTP_DEFAULT })
  const [lastTest, setLastTest] = useState<{ at: string; ok: boolean } | null>(null)
  const [smtpLoading, setSmtpLoading] = useState(true)
  const [smtpError, setSmtpError] = useState(false)
  const [smtpSaving, setSmtpSaving] = useState(false)
  const [smtpSaved, setSmtpSaved] = useState(false)
  const setS = <K extends keyof Smtp>(k: K, v: Smtp[K]) => setSmtp(s => ({ ...s, [k]: v }))

  async function loadSmtp() {
    setSmtpLoading(true); setSmtpError(false)
    try {
      const r = await $fetch<Smtp>('/api/admin/settings/smtp')
      const next = { ...SMTP_DEFAULT }
      for (const k of KEYS) (next as any)[k] = (r as any)[k]
      setSmtp(next)
      setSmtpOrig({ ...next })
      setLastTest(r.last_test_at ? { at: r.last_test_at, ok: !!r.last_test_ok } : null)
    } catch { setSmtpError(true) } finally { setSmtpLoading(false) }
  }
  const smtpChanges = KEYS.filter(k => String(smtp[k]) !== String(smtpOrig[k])).length
  function resetSmtp() { setSmtp(s => { const n = { ...s }; for (const k of KEYS) (n as any)[k] = (smtpOrig as any)[k]; return n }) }
  async function saveSmtp() {
    setSmtpSaving(true)
    try {
      const body: Record<string, unknown> = { host: smtp.host, port: Number(smtp.port), security: smtp.security, user: smtp.user, from_addr: smtp.from_addr }
      if (smtp.password && !smtp.password.startsWith('•') && smtp.password !== smtpOrig.password) body.password = smtp.password
      await $fetch('/api/admin/settings/smtp', { method: 'PATCH', body })
      setSmtpOrig({ ...smtp })
      flash(setSmtpSaved)
    } catch (e: any) { addToast('error', e?.data?.detail || t('error.genericError')) }
    finally { setSmtpSaving(false) }
  }
  const SECURITY = [
    { value: 'ssl', label: 'SSL/TLS' },
    { value: 'starttls', label: 'STARTTLS' },
    { value: 'none', label: t('common.none') },
  ]
  let lastTestText: string
  if (!lastTest) lastTestText = t('admin.mail.neverTested')
  else {
    const d = new Date(lastTest.at)
    const when = d.toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    lastTestText = t('admin.mail.lastTest', { when, result: lastTest.ok ? t('admin.mail.testOk') : t('admin.mail.testFail') })
  }

  // 시험 메일 — 받는 주소를 묻는 작은 모달
  const [testOpen, setTestOpen] = useState(false)
  const [testTo, setTestTo] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  function openTest() { setTestTo(v => v || user?.email || ''); setTestResult(null); setTestOpen(true) }
  async function sendTest() {
    if (!testTo) return
    setTesting(true); setTestResult(null)
    let res: { ok: boolean; message: string } | null = null
    try {
      const r = await $fetch<{ message: string }>('/api/admin/settings/smtp/test', { method: 'POST', body: { to_email: testTo } })
      res = { ok: true, message: r.message }
    } catch (e: any) { res = { ok: false, message: e?.data?.detail || t('admin.settings.smtp.testFail') } }
    finally {
      setTestResult(res)
      setTesting(false)
      setLastTest({ at: new Date().toISOString(), ok: !!res?.ok })
    }
  }

  useEffect(() => { void loadMode(); void loadSmtp() }, [])

  if (!user?.is_admin) return null
  return (
    <AdminPageShell title={t('admin.mail.pageTitle')} subtitle={t('admin.mail.subtitle')} width="form">
      {/* ① 메일 모듈 방식 */}
      <SettingsCard title={t('admin.mail.modeTitle')} description={t('admin.mail.modeDesc')} changes={modeChanges} saving={modeSaving} saved={modeSaved} onSave={saveMode} onReset={() => setMode(modeOrig)}>
        {modeError ? (
          <UiErrorTile placement="card" title={t('admin.mail.modeLoadError')} onRetry={loadMode} />
        ) : mode === null ? (
          <UiSkeleton preset="text" rows={1} />
        ) : (
          <div className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2">
            <UiSelect modelValue={mode} onUpdateModelValue={v => setMode(v as Mode)} options={modeOptions} label={t('admin.mail.modeLabel')} />
            <p className="flex items-end pb-2.5 text-xs text-muted-foreground">{mode === 'builtin' ? t('admin.mail.builtinDesc') : t('admin.mail.externalDesc')}</p>
          </div>
        )}
      </SettingsCard>

      {/* ② SMTP 발송 */}
      <SettingsCard title={t('admin.mail.smtpTitle')} description={t('admin.mail.smtpDesc')} saved={smtpSaved} flush>
        {smtpLoading ? (
          <UiSkeleton preset="text" rows={4} className="px-5 py-4" />
        ) : smtpError ? (
          <UiErrorTile placement="card" title={t('admin.mail.smtpLoadError')} className="mx-5 mb-4" onRetry={loadSmtp} />
        ) : (
          <>
            <form className="grid gap-x-4 gap-y-3.5 px-5 py-4 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); void saveSmtp() }}>
              <UiInput modelValue={smtp.host} onUpdateModelValue={v => setS('host', v)} label={t('admin.settings.smtp.host')} placeholder="smtp.example.com" mono />
              <UiInput modelValue={smtp.port} onUpdateModelValue={v => setS('port', v)} type="number" label={t('admin.settings.smtp.port')} mono />
              <UiInput modelValue={smtp.from_addr} onUpdateModelValue={v => setS('from_addr', v)} type="email" label={t('admin.mail.fromAddr')} placeholder="noreply@example.com" mono />
              <UiSelect modelValue={smtp.security} onUpdateModelValue={v => setS('security', String(v))} options={SECURITY} label={t('admin.settings.smtp.security')} />
              <UiInput modelValue={smtp.user} onUpdateModelValue={v => setS('user', v)} label={t('admin.mail.account')} mono autocomplete="off" />
              <UiPasswordInput modelValue={smtp.password} onUpdateModelValue={v => setS('password', v)} label={t('admin.settings.smtp.password')} autocomplete="new-password" />
              <button type="submit" className="hidden" />
            </form>
            <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-border px-5 py-3">
              <span className={cn('mr-auto flex items-center gap-1.5 text-xs', lastTest && !lastTest.ok ? 'text-danger' : 'text-muted-foreground')} role="status">{lastTestText}</span>
              <UiButton variant="outline" size="sm" onClick={openTest}>{t('admin.mail.sendTest')}</UiButton>
              <UiButton variant="outline" size="sm" disabled={!smtpChanges || smtpSaving} onClick={resetSmtp}>{t('settingsCard.reset')}</UiButton>
              <UiButton size="sm" disabled={!smtpChanges || smtpSaving} className={smtpChanges ? '' : 'opacity-50'} onClick={saveSmtp}>{smtpSaving ? t('settingsCard.saving') : t('settingsCard.save')}</UiButton>
            </div>
          </>
        )}
      </SettingsCard>

      <AdminMailOAuth />

      {testOpen && (
        <UiModal
          title={t('admin.settings.smtp.testTitle')}
          size="440"
          onClose={() => setTestOpen(false)}
          footer={
            <>
              <UiButton variant="outline" size="sm" onClick={() => setTestOpen(false)}>{t('common.close')}</UiButton>
              <UiButton size="sm" disabled={testing || !testTo} onClick={sendTest}>{testing ? t('common.sending') : t('admin.settings.smtp.testButton')}</UiButton>
            </>
          }
        >
          {smtpChanges > 0 && <p className="text-xs text-warning">{t('admin.mail.testUnsaved')}</p>}
          <form onSubmit={e => { e.preventDefault(); void sendTest() }}>
            <UiInput modelValue={testTo} onUpdateModelValue={setTestTo} type="email" label={t('admin.mail.testTo')} placeholder={t('admin.settings.smtp.testPlaceholder')} />
            <button type="submit" className="hidden" />
          </form>
          {testResult && (
            <p role="status" className={cn('flex items-center gap-1.5 text-xs', testResult.ok ? 'text-success' : 'text-danger')}>
              <UiIcon name={testResult.ok ? 'check-circle' : 'alert-circle'} className="h-3.5 w-3.5 shrink-0" /><span className="break-all">{testResult.message}</span>
            </p>
          )}
        </UiModal>
      )}
    </AdminPageShell>
  )
}
