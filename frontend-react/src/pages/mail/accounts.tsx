// Vue 원본: frontend/pages/mail/accounts.vue
// 메일 계정 관리 — 계정 목록(연결 시험·아카이브·편집·삭제) + 추가/편집 폼(제공자 자동 감지·IMAP/POP3·OAuth 빠른 연결).
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
// Vue 의 class 묶음처럼 그냥 잇는다(tailwind-merge 를 쓰는 cn 은 leading-[1.35]+text-xl 같은 짝을 지워 Vue 와 달라진다)
import { clsx as cx } from 'clsx'
import { $fetch } from '~/lib/api'
import { useHead } from '~/lib/head'
import { useRoute } from '~/lib/router'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useMail, type MailAccountInfo } from '~/composables/useMail'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { UiIcon } from '~/components/ui/Icon'

interface AccountForm {
  display_name: string
  email: string
  protocol: string
  imap_host: string
  imap_port: number
  imap_security: string
  smtp_host: string
  smtp_port: number
  smtp_security: string
  username: string
  password: string
  is_default: boolean
}

function emptyForm(): AccountForm {
  return {
    display_name: '', email: '', protocol: 'imap',
    imap_host: '', imap_port: 993, imap_security: 'ssl',
    smtp_host: '', smtp_port: 587, smtp_security: 'starttls',
    username: '', password: '', is_default: false,
  }
}

const inputCls = 'w-full mt-1 px-3 py-2 border border-border rounded-md bg-background text-sm focus:outline-hidden focus:ring-2 focus:ring-ring'

export default function MailAccountsPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: `${t('mail.accounts.title')} | ${appName}` })

  const { accounts, fetchAccounts } = useMail()

  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<any>(null)
  const [saving, setSaving] = useState(false)

  // 가이드형 온보딩: 제공자 자동감지
  const [providerInfo, setProviderInfo] = useState<any>(null)
  const [detecting, setDetecting] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const hasBuiltin = accounts.some(a => a.is_builtin)

  const [form, setFormState] = useState<AccountForm>(emptyForm)
  // 처리기·타이머가 "지금" 폼을 읽는다(Vue form.value)
  const formRef = useRef(form)
  formRef.current = form
  function setForm(p: Partial<AccountForm>) {
    formRef.current = { ...formRef.current, ...p }
    setFormState(formRef.current)
  }

  // 이메일 도메인으로 IMAP/SMTP 자동 채움 + 인증 안내 (Outlook식: 이메일만 넣으면 서버 자동)
  async function detectProvider() {
    const email = formRef.current.email.trim()
    if (!email.includes('@')) { setProviderInfo(null); return }
    setDetecting(true)
    try {
      const p = await $fetch<any>('/api/mail/providers/detect', { params: { email } })
      setProviderInfo(p)
      setForm({
        imap_host: p.imap_host, imap_port: p.imap_port, imap_security: p.imap_security,
        smtp_host: p.smtp_host, smtp_port: p.smtp_port, smtp_security: p.smtp_security,
        username: email, // 로그인 사용자명 = 이메일(대부분 동일)
      })
      if (!formRef.current.display_name) setForm({ display_name: p.known ? p.label : email })
      setShowAdvanced(!p.known) // 알려진 제공자면 서버칸 접기, 미지원이면 펼쳐 수정
    } catch { setProviderInfo(null) } finally { setDetecting(false) }
  }

  // 입력 중에도 도메인이 완성되면 자동 감지(디바운스) — blur 를 기다리지 않는다
  const detectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function onEmailInput() {
    if (detectTimer.current) clearTimeout(detectTimer.current)
    if (!formRef.current.email.includes('@')) { setProviderInfo(null); return }
    detectTimer.current = setTimeout(detectProvider, 500)
  }

  // 프로토콜 전환 시 수신 서버 기본 포트를 맞춘다(현재 값이 반대 프로토콜 기본값일 때만)
  function onProtocolChange() {
    const f = formRef.current
    if (f.protocol === 'pop3') {
      if (f.imap_port === 993) setForm({ imap_port: 995 })
      if (!f.imap_host && f.email.includes('@')) {
        setForm({ imap_host: `pop.${f.email.split('@')[1]}` })
      }
      setShowAdvanced(true) // POP3 는 수신 서버를 확인/입력하도록 펼친다
    } else if (f.imap_port === 995) {
      setForm({ imap_port: 993 })
    }
  }

  function resetForm() {
    formRef.current = emptyForm()
    setFormState(formRef.current)
    setEditing(null)
    setProviderInfo(null)
    setShowAdvanced(false)
  }

  function openCreate() {
    resetForm()
    setShowForm(true)
  }

  function openEdit(account: MailAccountInfo) {
    setEditing(account.id)
    formRef.current = {
      display_name: account.display_name,
      email: account.email,
      protocol: account.protocol || 'imap',
      imap_host: account.imap_host,
      imap_port: account.imap_port,
      imap_security: account.imap_security,
      smtp_host: account.smtp_host,
      smtp_port: account.smtp_port,
      smtp_security: account.smtp_security,
      username: account.username,
      password: '',
      is_default: account.is_default,
    }
    setFormState(formRef.current)
    setProviderInfo(null)
    setShowAdvanced(true) // 편집은 서버칸 펼침
    setShowForm(true)
  }

  async function saveAccount() {
    setSaving(true)
    try {
      // Outlook식: 사용자명을 안 건드렸으면 이메일을 그대로 로그인 아이디로 쓴다
      if (!formRef.current.username.trim()) setForm({ username: formRef.current.email.trim() })
      if (editing) {
        const body: any = { ...formRef.current }
        if (!body.password) delete body.password
        await $fetch(`/api/mail/accounts/${editing}`, { method: 'PATCH', body })
      } else {
        await $fetch('/api/mail/accounts', { method: 'POST', body: formRef.current })
      }
      setShowForm(false)
      resetForm()
      await fetchAccounts()
    } catch (e: any) {
      addToast('error', e.data?.detail || t('mail.accounts.saveFail'))
    } finally {
      setSaving(false)
    }
  }

  // ── 아카이브 ──
  const [archiving, setArchiving] = useState<string | null>(null)

  async function toggleArchive(acct: MailAccountInfo) {
    const next = !acct.archive_enabled
    setArchiving(acct.id)
    try {
      await $fetch(`/api/mail/accounts/${acct.id}`, {
        method: 'PATCH', body: { archive_enabled: next },
      })
      // Vue 원본은 여기서 acct.archive_enabled = next 를 했지만 readonly 목록이라 반영되지 않았다(원본 그대로 — 보고서 참고)
      addToast('success', next
        ? t('mail.archive.enabled')
        : t('mail.archive.disabled'))
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('mail.archive.toggleFailed'))
    } finally {
      setArchiving(null)
    }
  }

  const [backfillProgress, setBackfillProgress] = useState<Record<string, { scanned: number; saved: number }>>({})

  async function backfillArchive(acct: MailAccountInfo) {
    if (!await confirmBox(t('mail.archive.backfillConfirm'))) return
    setArchiving(acct.id)
    try {
      // 수백 통을 IMAP 에서 받아 내리는 일이라 요청 안에서 끝나지 않는다(nginx 120초).
      // 시작만 시키고 진행상황은 폴링한다.
      await $fetch(`/api/mail/accounts/${acct.id}/archive/backfill?limit=200`, { method: 'POST' })
      addToast('info', t('mail.archive.backfillStarted'))
      void pollBackfill(acct)
    } catch (e: any) {
      setArchiving(null)
      addToast('error', e?.data?.detail || t('mail.archive.backfillFailed'))
    }
  }

  async function pollBackfill(acct: MailAccountInfo) {
    for (let i = 0; i < 600; i++) { // 최대 20분
      await new Promise(r => setTimeout(r, 2000))
      let st: any
      try {
        st = await $fetch(`/api/mail/accounts/${acct.id}/archive/status`)
      } catch { continue }

      if (st.state === 'running') {
        setBackfillProgress(p => ({ ...p, [acct.id]: { scanned: st.scanned || 0, saved: st.saved || 0 } }))
        continue
      }
      setBackfillProgress((p) => { const n = { ...p }; delete n[acct.id]; return n })
      setArchiving(null)
      if (st.state === 'done') {
        addToast('success', t('mail.archive.backfillDone', {
          saved: st.saved || 0, skipped: st.skipped || 0,
        }))
      } else if (st.state === 'error') {
        addToast('error', st.error || t('mail.archive.backfillFailed'))
      }
      return
    }
    setArchiving(null)
  }

  async function deleteAccount(id: string) {
    if (!await confirmBox(t('mail.accounts.deleteConfirm'))) return
    try {
      await $fetch(`/api/mail/accounts/${id}`, { method: 'DELETE' })
      await fetchAccounts()
    } catch (e: any) {
      addToast('error', e.data?.detail || t('mail.accounts.deleteFail'))
    }
  }

  async function testConnection(id: string) {
    setTesting(id)
    setTestResult(null)
    try {
      setTestResult(await $fetch(`/api/mail/accounts/${id}/test`, { method: 'POST' }))
    } catch (e: any) {
      setTestResult({ error: e.data?.detail || t('mail.accounts.testFail') })
    } finally {
      setTesting(null)
    }
  }

  const route = useRoute()
  const [oauthProviders, setOauthProviders] = useState<Record<string, boolean>>({})
  const OAUTH_LABEL: Record<string, string> = { google: t('mail.accounts.oauthGoogle'), microsoft: t('mail.accounts.oauthMicrosoft') }

  function connectOAuth(provider: string) {
    window.location.href = `/api/mail/oauth/${provider}/authorize`
  }

  const routeRef = useRef(route)
  routeRef.current = route
  useEffect(() => {
    void (async () => {
      await fetchAccounts()
      try { setOauthProviders(await $fetch<Record<string, boolean>>('/api/mail/oauth/providers')) } catch { setOauthProviders({}) }
      // OAuth 콜백 결과
      const q = routeRef.current.query
      if (q.oauth === 'connected') addToast('success', t('mail.accounts.oauthConnected'))
      else if (q.oauth_error) addToast('error', t('mail.accounts.oauthFailed', { error: String(q.oauth_error) }))
      if (q.add) openCreate() // 온보딩 "메일 연결하기" → 위저드 자동 오픈
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const anyOAuth = Object.values(oauthProviders).some(Boolean)

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-4 py-6 lg:px-7 lg:py-7">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('mail.accounts.title')}</h1>
            <p className="text-muted-foreground text-sm mt-1">
              {hasBuiltin ? t('mail.accounts.descBuiltin') : t('mail.accounts.descExternal')}
            </p>
          </div>
          <button onClick={openCreate} className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90">
            {t('mail.accounts.add')}
          </button>
        </div>

        {/* Account list */}
        <div className="space-y-3 mb-6">
          {accounts.map(acct => (
            <div
              key={acct.id}
              className="rounded-lg border border-border bg-card p-5"
            >
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium truncate text-foreground">{acct.display_name}</h3>
                    {acct.is_builtin && <span className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded shrink-0">{t('mail.accounts.builtin')}</span>}
                  </div>
                  <p className="text-sm text-muted-foreground truncate">{acct.email}</p>
                  {!acct.is_builtin && (
                    <p className="font-mono text-[11px] text-muted-foreground mt-1 break-all">
                      {`${acct.protocol === 'pop3' ? 'POP3' : 'IMAP'}: ${acct.imap_host}:${acct.imap_port} · SMTP: ${acct.smtp_host}:${acct.smtp_port}`}
                    </p>
                  )}
                  {acct.is_default && <span className="inline-block mt-1 text-xs px-2 py-0.5 bg-primary/10 text-primary rounded">{t('mail.accounts.default')}</span>}
                </div>
                <div className="flex items-center gap-2 shrink-0 flex-wrap">
                  <button
                    onClick={() => testConnection(acct.id)}
                    disabled={testing === acct.id}
                    className="px-3 py-1.5 text-xs border border-border rounded-md hover:bg-accent transition-colors"
                  >
                    {testing === acct.id ? t('mail.accounts.testing') : t('mail.accounts.test')}
                  </button>
                  {!acct.is_builtin && (
                    <>
                      <button
                        onClick={() => toggleArchive(acct)}
                        disabled={archiving === acct.id}
                        className={cx(
                          'px-3 py-1.5 text-xs rounded-md border transition-colors disabled:opacity-50',
                          acct.archive_enabled
                            ? 'border-success/40 bg-success/10 text-success'
                            : 'border-border hover:bg-accent',
                        )}
                        title={t('mail.archive.hint')}
                      >
                        {acct.archive_enabled ? t('mail.archive.on') : t('mail.archive.off')}
                      </button>
                      {acct.archive_enabled && (
                        <button
                          onClick={() => backfillArchive(acct)}
                          disabled={archiving === acct.id}
                          className="px-3 py-1.5 text-xs border border-border rounded-md hover:bg-accent transition-colors disabled:opacity-50"
                        >
                          {archiving === acct.id
                            ? (backfillProgress[acct.id]
                              ? t('mail.archive.progress', backfillProgress[acct.id])
                              : t('mail.archive.working'))
                            : t('mail.archive.backfill')}
                        </button>
                      )}
                      <button onClick={() => openEdit(acct)} className="px-3 py-1.5 text-xs border border-border rounded-md hover:bg-accent transition-colors">{t('common.edit')}</button>
                      <button onClick={() => deleteAccount(acct.id)} className="px-3 py-1.5 text-xs border border-border rounded-md hover:bg-destructive/10 text-destructive transition-colors">{t('common.delete')}</button>
                    </>
                  )}
                </div>
              </div>
              {testResult && testing === null && testResult !== null && (
                <div className="mt-3 text-sm">
                  {testResult.error
                    ? <p className="text-destructive">{testResult.error}</p>
                    : (
                      <>
                        <p className={testResult.imap?.ok ? 'text-success' : 'text-destructive'}>
                          IMAP: {testResult.imap?.message}
                        </p>
                        <p className={testResult.smtp?.ok ? 'text-success' : 'text-destructive'}>
                          SMTP: {testResult.smtp?.message}
                        </p>
                      </>
                    )}
                </div>
              )}
            </div>
          ))}
          {accounts.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              {t('mail.accounts.empty')}
            </div>
          )}
        </div>

        {/* Add/Edit form modal */}
        {showForm && (
          <div className="fixed inset-0 z-modal flex items-center justify-center bg-scrim" onClick={(e) => { if (e.target === e.currentTarget) setShowForm(false) }} role="dialog" aria-modal="true">
            <div className="bg-card border border-border rounded-lg w-full max-w-lg mx-4 p-6 max-h-[90vh] overflow-y-auto">
              <h2 className="text-lg font-bold mb-4 text-foreground">{editing ? t('mail.accounts.editTitle') : t('mail.accounts.addTitle')}</h2>

              {/* OAuth2 빠른 연결 (관리자가 설정한 provider) */}
              {!editing && anyOAuth && (
                <div className="mb-4 space-y-2">
                  {Object.entries(oauthProviders).map(([p, ok]) => (ok
                    ? (
                      <button
                        key={p}
                        type="button"
                        onClick={() => connectOAuth(p)}
                        className="w-full px-4 py-2.5 text-sm font-medium rounded-md border border-border hover:bg-accent transition-colors flex items-center justify-center gap-2"
                      >
                        {OAUTH_LABEL[p] || p}
                      </button>
                    )
                    : null))}
                  <div className="relative text-center text-xs text-muted-foreground py-1">{t('mail.accounts.orManual')}</div>
                </div>
              )}

              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium">{t('mail.accounts.displayName')}</label>
                  <input autoComplete="off" value={form.display_name} onChange={e => setForm({ display_name: e.target.value })} className={inputCls} placeholder={t('mail.accounts.displayName')} />
                </div>
                <div>
                  <label className="text-sm font-medium">{t('mail.accounts.email')}</label>
                  <input autoComplete="off" value={form.email} type="email" onChange={(e) => { setForm({ email: e.target.value }); onEmailInput() }} onBlur={detectProvider} className={inputCls} placeholder="user@gmail.com" />
                  {detecting && <p className="text-xs text-muted-foreground mt-1">{t('mail.accounts.detecting')}</p>}
                </div>

                {/* 제공자 자동 감지 안내 */}
                {providerInfo && !editing && (
                  <div className={cx('rounded-md border p-3 text-sm', providerInfo.auth === 'password' ? 'border-success/40 bg-success/5' : 'border-warning/40 bg-warning/5')}>
                    <div className="flex items-center gap-2 font-medium">
                      <span>{providerInfo.known ? t('mail.accounts.providerDetected', { name: providerInfo.label }) : t('mail.accounts.providerUnknown')}</span>
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-background border border-border">
                        {providerInfo.auth === 'password' ? t('mail.accounts.password') : providerInfo.auth === 'app_password' ? t('mail.accounts.appPasswordNeeded') : t('mail.accounts.authOAuth')}
                      </span>
                    </div>
                    <p className="text-muted-foreground mt-1">{providerInfo.guide}</p>
                    {providerInfo.help_url && (
                      <a
                        href={providerInfo.help_url}
                        target="_blank"
                        rel="noopener"
                        className="mt-1.5 inline-flex items-center gap-1 text-primary hover:underline"
                      >{t('mail.accounts.openAppPassword')}<UiIcon name="external-link" className="h-3 w-3" /></a>
                    )}
                  </div>
                )}

                {/* 수신 프로토콜: 기본 IMAP. 구형 서버만 POP3 */}
                <div>
                  <label className="text-sm font-medium">{t('mail.accounts.protocol')}</label>
                  <div className="mt-1 flex gap-2">
                    <button
                      type="button"
                      onClick={() => { setForm({ protocol: 'imap' }); onProtocolChange() }}
                      className={cx('flex-1 rounded-md border px-3 py-2 text-sm transition-colors', form.protocol === 'imap' ? 'border-primary bg-primary/10 text-foreground font-medium' : 'border-border text-muted-foreground hover:bg-accent')}
                    >
                      IMAP <span className="text-[11px] text-muted-foreground">{t('mail.accounts.imapHint')}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => { setForm({ protocol: 'pop3' }); onProtocolChange() }}
                      className={cx('flex-1 rounded-md border px-3 py-2 text-sm transition-colors', form.protocol === 'pop3' ? 'border-primary bg-primary/10 text-foreground font-medium' : 'border-border text-muted-foreground hover:bg-accent')}
                    >
                      POP3 <span className="text-[11px] text-muted-foreground">{t('mail.accounts.pop3Hint')}</span>
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  aria-expanded={showAdvanced}
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  {t('mail.accounts.advanced')}<UiIcon name={showAdvanced ? 'chevron-up' : 'chevron-down'} className="h-3 w-3" />{providerInfo?.known && form.protocol === 'imap' && <span> · {t('mail.accounts.autoConfigured')}</span>}
                </button>
                <div className="space-y-4" style={showAdvanced ? undefined : { display: 'none' }}>
                  <hr className="border-border" />
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-sm font-medium">{form.protocol === 'pop3' ? t('mail.accounts.pop3Host') : t('mail.accounts.imapHost')}</label>
                      <input autoComplete="off" value={form.imap_host} onChange={e => setForm({ imap_host: e.target.value })} className={inputCls} placeholder={form.protocol === 'pop3' ? 'pop.example.com' : 'imap.gmail.com'} />
                    </div>
                    <div>
                      <label className="text-sm font-medium">{t('mail.accounts.imapPort')}</label>
                      <input autoComplete="off" value={form.imap_port} onChange={e => setForm({ imap_port: e.target.value === '' ? ('' as any) : Number(e.target.value) })} type="number" className={inputCls} />
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium">{t('mail.accounts.imapSecurity')}</label>
                    <select value={form.imap_security} onChange={e => setForm({ imap_security: e.target.value })} className={inputCls}>
                      <option value="ssl">SSL/TLS</option>
                      <option value="starttls">STARTTLS</option>
                      <option value="none">{t('common.none')}</option>
                    </select>
                  </div>
                  <hr className="border-border" />
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-sm font-medium">{t('mail.accounts.smtpHost')}</label>
                      <input autoComplete="off" value={form.smtp_host} onChange={e => setForm({ smtp_host: e.target.value })} className={inputCls} placeholder="smtp.gmail.com" />
                    </div>
                    <div>
                      <label className="text-sm font-medium">{t('mail.accounts.smtpPort')}</label>
                      <input autoComplete="off" value={form.smtp_port} onChange={e => setForm({ smtp_port: e.target.value === '' ? ('' as any) : Number(e.target.value) })} type="number" className={inputCls} />
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium">{t('mail.accounts.smtpSecurity')}</label>
                    <select value={form.smtp_security} onChange={e => setForm({ smtp_security: e.target.value })} className={inputCls}>
                      <option value="starttls">STARTTLS</option>
                      <option value="ssl">SSL/TLS</option>
                      <option value="none">{t('common.none')}</option>
                    </select>
                  </div>
                  <hr className="border-border" />
                  <div>
                    <label className="text-sm font-medium">{t('mail.accounts.username')}</label>
                    <input autoComplete="off" value={form.username} onChange={e => setForm({ username: e.target.value })} className={inputCls} placeholder="user@gmail.com" />
                    <p className="text-xs text-muted-foreground mt-1">{t('mail.accounts.usernameHint')}</p>
                  </div>
                </div>
                <div>
                  <label className="text-sm font-medium">{t('mail.accounts.password')}{editing ? ` ${t('mail.accounts.passwordEditHint')}` : ''}</label>
                  <input autoComplete="new-password" value={form.password} onChange={e => setForm({ password: e.target.value })} type="password" className={inputCls} />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input checked={form.is_default} onChange={e => setForm({ is_default: e.target.checked })} type="checkbox" className="rounded border-border text-primary focus:ring-ring" />
                  {t('mail.accounts.setDefault')}
                </label>
              </div>

              <div className="flex justify-end gap-2 mt-6">
                <button onClick={() => setShowForm(false)} className="px-4 py-2 border border-border rounded-md text-sm hover:bg-accent transition-colors">{t('common.cancel')}</button>
                <button onClick={saveAccount} disabled={saving} className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90">
                  {saving ? t('common.saving') : (editing ? t('common.edit') : t('common.add'))}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
