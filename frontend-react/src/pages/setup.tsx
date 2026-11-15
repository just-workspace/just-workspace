// Vue 원본: frontend/pages/setup.vue
// 최초 설정(FTW · 8-4-1·8-4-2): auth 틀(AuthShell) 위, 폼 위에 "단계명 n / 6 + 진행 바".
// 관리자 단계 = 이름·아이디·비밀번호(규칙 체크, 확인 칸 대신 보기 토글) + [이전][다음 — 브랜딩] + 백업에서 복원 링크.
// 기능 선택 = 토글 목록 한 화면(스위치 즉시 저장 — 실패하면 되돌림). API 호출 순서·엔드포인트는 Vue 그대로.
import { useState, type ChangeEvent, type FormEvent } from 'react'
import { $fetch } from '~/lib/api'
import { navigateTo } from '~/lib/router'
import { useHead } from '~/lib/head'
import { setSharedState } from '~/lib/state'
import { useI18n } from '~/i18n'
import { nativeLogin } from '~/composables/useAuth'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { checkPasswordRules, passwordRulesPass } from '~/utils/passwordRules'
import { AuthShell } from '~/components/auth/AuthShell'
import { AuthHeading } from '~/components/auth/AuthHeading'
import { AuthAlert } from '~/components/auth/AuthAlert'
import { AuthStepHeader } from '~/components/auth/AuthStepHeader'
import { AuthPasswordRules } from '~/components/auth/AuthPasswordRules'
import { UiInput } from '~/components/ui/Input'
import { UiPasswordInput } from '~/components/ui/PasswordInput'
import { UiButton } from '~/components/ui/Button'
import { UiRadioCard } from '~/components/ui/RadioCard'
import { UiSwitch } from '~/components/ui/Switch'
import { UiSkeleton } from '~/components/ui/Skeleton'

type MailMode = 'builtin' | 'external' | 'none'

export default function Page() {
  const { appName } = useSiteConfig()
  const { t } = useI18n()
  useHead({ title: `${t('setup.title')} | ${appName}` })

  // Vue useState('setup-status') — 가드(router/guards.ts)와 같은 공유 상태
  const setSetupStatus = (v: any) => setSharedState<any>('setup-status', v)

  const steps = [t('setup.steps.start'), t('setup.steps.admin'), t('setup.steps.branding'), t('setup.steps.mail'), t('setup.steps.features'), t('setup.steps.done')]
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 마이그레이션(기존 백업에서 복원)
  const [migrating, setMigrating] = useState(false)
  const [mFile, setMFile] = useState<File | null>(null)
  const [mBusy, setMBusy] = useState(false)
  const [mMsg, setMMsg] = useState('')
  const [mTone, setMTone] = useState<'info' | 'danger' | 'warning'>('info')
  function onFile(e: ChangeEvent<HTMLInputElement>) { setMFile(e.target.files?.[0] || null) }
  async function doRestore() {
    if (!mFile) { setMMsg(t('setup.restore.selectFile')); setMTone('info'); return }
    setMBusy(true); setMMsg(t('setup.restore.uploading')); setMTone('info')
    try {
      const fd = new FormData(); fd.append('file', mFile)
      await $fetch('/api/setup/restore', { method: 'POST', body: fd })
      setMMsg(t('setup.restore.restarting')); setMTone('info')
      setSetupStatus(null)
      let tries = 0
      const iv = setInterval(async () => {
        tries++
        try {
          const s = await $fetch<any>('/api/setup/status')
          if (s && s.has_admin) { clearInterval(iv); setSetupStatus({ needs_setup: false }); await navigateTo('/login') }
        } catch { /* 재시작 중 */ }
        if (tries > 50) { clearInterval(iv); setMMsg(t('setup.restore.delayed')); setMTone('warning') }
      }, 3000)
    } catch (e: any) { setMMsg(t('setup.restore.failed', { detail: e?.data?.detail || e?.message || '' })); setMTone('danger'); setMBusy(false) }
  }

  const [aUser, setAUser] = useState(''); const [aPass, setAPass] = useState(''); const [aName, setAName] = useState('')
  const aRules = checkPasswordRules(aPass, [aUser.trim()])
  const [bName, setBName] = useState('Just Workspace'); const [bColor, setBColor] = useState('#2563eb')
  const [mailMode, setMailMode] = useState<MailMode>('builtin')
  const MAIL_OPTS = [
    { v: 'builtin', t: t('setup.mail.builtin.title'), d: t('setup.mail.builtin.desc') },
    { v: 'external', t: t('setup.mail.external.title'), d: t('setup.mail.external.desc') },
    { v: 'none', t: t('setup.mail.none.title'), d: t('setup.mail.none.desc') },
  ] as const
  const [modules, setModules] = useState<any[]>([])

  async function createAdmin(ev: FormEvent) {
    ev.preventDefault()
    setError('')
    if (!passwordRulesPass(aRules)) { setError(t('setup.errors.passwordRules')); return }
    setBusy(true)
    try {
      await $fetch('/api/setup/admin', { method: 'POST', body: { username: aUser, password: aPass, display_name: aName || undefined } })
      await nativeLogin(aUser, aPass, true)
      setStep(2)
    } catch (e: any) { setError(e?.data?.detail || t('setup.errors.adminFailed')) } finally { setBusy(false) }
  }

  async function saveBranding() {
    setError(''); setBusy(true)
    try { await $fetch('/api/admin/settings/branding', { method: 'PATCH', body: { site_name: bName, primary_color: bColor } }); setStep(3) }
    catch (e: any) { setError(e?.data?.detail || t('setup.errors.brandingFailed')) } finally { setBusy(false) }
  }

  async function loadModules() {
    try { const d = await $fetch<any>('/api/platform/modules'); setModules(d.modules || d || []) } catch { /* */ }
  }

  async function saveMail() {
    setError(''); setBusy(true)
    try { await $fetch('/api/setup/features', { method: 'PATCH', body: { builtin_mailserver: mailMode === 'builtin' } }); await loadModules(); setStep(4) }
    catch (e: any) { setError(e?.data?.detail || t('setup.errors.mailFailed')) } finally { setBusy(false) }
  }

  // 기능 선택 — 토글 목록 한 화면. 이름·설명은 시안 문구, 목록에 없는 모듈은 서버 이름.
  const FEAT: Record<string, { t: string; d: string }> = {
    mail: { t: t('setup.modules.items.mail.title'), d: t('setup.modules.items.mail.desc') },
    chat: { t: t('setup.modules.items.chat.title'), d: t('setup.modules.items.chat.desc') },
    files: { t: t('setup.modules.items.files.title'), d: t('setup.modules.items.files.desc') },
    calendar: { t: t('setup.modules.items.calendar.title'), d: t('setup.modules.items.calendar.desc') },
    meetings: { t: t('setup.modules.items.meetings.title'), d: t('setup.modules.items.meetings.desc') },
    wiki: { t: t('setup.modules.items.wiki.title'), d: t('setup.modules.items.wiki.desc') },
    board: { t: t('setup.modules.items.board.title'), d: t('setup.modules.items.board.desc') },
    tasks: { t: t('setup.modules.items.tasks.title'), d: t('setup.modules.items.tasks.desc') },
    contacts: { t: t('setup.modules.items.contacts.title'), d: t('setup.modules.items.contacts.desc') },
    git: { t: t('setup.modules.items.git.title'), d: t('setup.modules.items.git.desc') },
    ai: { t: t('setup.modules.items.ai.title'), d: t('setup.modules.items.ai.desc') },
  }
  function featInfo(m: any) { return FEAT[m?.id] || { t: m?.name || m?.id, d: m?.description || '' } }
  const [featBusy, setFeatBusy] = useState<Record<string, boolean>>({})
  const setEnabled = (id: string, v: boolean) => setModules(list => list.map(x => (x.id === id ? { ...x, enabled: v } : x)))
  async function toggleFeature(m: any, on: boolean) {
    if (!m || m.enabled === on || featBusy[m.id]) return
    setEnabled(m.id, on)
    setFeatBusy(b => ({ ...b, [m.id]: true }))
    try {
      await $fetch(`/api/admin/modules/${m.id}`, { method: 'PATCH', body: { enabled: on } })
    } catch { setEnabled(m.id, !on) } finally { setFeatBusy(b => ({ ...b, [m.id]: false })) }
  }

  async function finish() {
    setBusy(true)
    try {
      await $fetch('/api/setup/complete', { method: 'POST' })
      setSetupStatus({ needs_setup: false })
      // 하드 리로드 — 활성화된 모듈이 nav에 즉시 반영되도록
      window.location.href = '/'
    } catch (e: any) { setError(e?.data?.detail || t('setup.errors.finishFailed')) } finally { setBusy(false) }
  }

  return (
    <AuthShell>
      {migrating ? (
        /* 마이그레이션 (기존 백업 복원) */
        <>
          <AuthHeading title={t('setup.restore.title')} subtitle={t('setup.restore.subtitle')} />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="setup-restore-file" className="text-xs font-semibold text-muted-foreground">{t('setup.restore.fileLabel')}</label>
            <input
              id="setup-restore-file"
              type="file"
              accept=".gz,.tgz,.tar.gz,application/gzip"
              disabled={mBusy}
              className="h-11 w-full rounded-md border border-input bg-background px-1.5 py-1.5 text-sm text-foreground file:mr-3 file:h-full file:rounded-sm file:border-0 file:bg-muted file:px-3 file:text-sm file:font-medium file:text-foreground focus:border-ring focus:outline-hidden focus:ring-2 focus:ring-ring/35"
              onChange={onFile}
            />
          </div>
          {mMsg && <AuthAlert tone={mTone} title={mMsg} />}
          <div className="flex gap-2">
            <UiButton variant="outline" size="lg" className="px-[18px]" disabled={mBusy} onClick={() => setMigrating(false)}>{t('common.prev')}</UiButton>
            <UiButton size="lg" className="flex-1 px-4 font-semibold" disabled={mBusy || !mFile} onClick={() => { void doRestore() }}>{mBusy ? t('setup.restore.restoring') : t('setup.restore.start')}</UiButton>
          </div>
        </>
      ) : (
        <>
          <AuthStepHeader label={steps[step]} step={step + 1} total={steps.length} />

          {step === 0 ? (
            /* 1 시작 */
            <>
              <AuthHeading title={t('setup.start.title', { appName })} subtitle={t('setup.start.subtitle')} />
              <div className="flex flex-col gap-2">
                <UiButton size="lg" className="w-full font-semibold" onClick={() => setStep(1)}>{t('setup.start.fresh')}</UiButton>
                <UiButton variant="outline" size="lg" className="w-full bg-card" onClick={() => setMigrating(true)}>{t('setup.start.restore')}</UiButton>
              </div>
            </>
          ) : step === 1 ? (
            /* 2 관리자 계정 */
            <>
              <AuthHeading title={t('setup.admin.title')} subtitle={t('setup.admin.subtitle')} />
              {error && <AuthAlert tone="danger" title={error} />}
              <form className="flex flex-col gap-[18px]" noValidate onSubmit={(e) => { void createAdmin(e) }}>
                <UiInput id="setup-admin-name" modelValue={aName} onUpdateModelValue={setAName} size="lg" label={t('authScreens.register.name')} hint={t('setup.admin.nameHint')} autocomplete="name" autoFocus />
                <UiInput id="setup-admin-user" modelValue={aUser} onUpdateModelValue={setAUser} size="lg" label={t('authScreens.register.username')} placeholder={t('setup.admin.usernamePlaceholder')} autocomplete="username" autoCapitalize="none" spellCheck="false" />
                <div className="flex flex-col gap-1.5">
                  <UiPasswordInput id="setup-admin-pass" modelValue={aPass} onUpdateModelValue={setAPass} size="lg" label={t('authScreens.register.password')} autocomplete="new-password" />
                  <AuthPasswordRules results={aRules} contextLabel={t('authScreens.register.username')} />
                </div>
                <div className="mt-1 flex gap-2">
                  <UiButton type="button" variant="outline" size="lg" className="px-[18px]" disabled={busy} onClick={() => setStep(0)}>{t('common.prev')}</UiButton>
                  <UiButton type="submit" size="lg" className="flex-1 px-4 font-semibold" disabled={busy || !aUser || !passwordRulesPass(aRules)}>
                    {busy ? t('setup.admin.creating') : t('setup.admin.next')}
                  </UiButton>
                </div>
              </form>
              <p className="text-[13px] text-muted-foreground">
                {t('setup.admin.hasPrevious')}{' '}
                <button type="button" className="font-semibold text-primary hover:underline" onClick={() => setMigrating(true)}>{t('setup.restore.title')}</button>
              </p>
            </>
          ) : step === 2 ? (
            /* 3 브랜딩 */
            <>
              <AuthHeading title={t('setup.steps.branding')} subtitle={t('setup.branding.subtitle')} />
              {error && <AuthAlert tone="danger" title={error} />}
              <UiInput id="setup-brand-name" modelValue={bName} onUpdateModelValue={setBName} size="lg" label={t('setup.branding.siteName')} autocomplete="off" />
              <div className="flex flex-col gap-1.5">
                <label htmlFor="setup-brand-color-hex" className="text-xs font-semibold text-muted-foreground">{t('setup.branding.color')}</label>
                <div className="flex items-center gap-2">
                  <input value={bColor} onChange={e => setBColor(e.target.value)} type="color" aria-label={t('setup.branding.pickColor')} className="h-11 w-12 shrink-0 cursor-pointer rounded-md border border-input bg-background p-1" />
                  <UiInput id="setup-brand-color-hex" modelValue={bColor} onUpdateModelValue={setBColor} size="lg" mono className="flex-1" autocomplete="off" />
                </div>
              </div>
              <div className="flex gap-2">
                <UiButton variant="outline" size="lg" className="px-[18px]" disabled={busy} onClick={() => setStep(3)}>{t('setup.branding.skip')}</UiButton>
                <UiButton size="lg" className="flex-1 px-4 font-semibold" disabled={busy} onClick={() => { void saveBranding() }}>{busy ? t('setup.saving') : t('setup.branding.next')}</UiButton>
              </div>
            </>
          ) : step === 3 ? (
            /* 4 메일 */
            <>
              <AuthHeading title={t('setup.mail.title')} subtitle={t('setup.mail.subtitle')} />
              {error && <AuthAlert tone="danger" title={error} />}
              <div role="radiogroup" aria-label={t('setup.mail.title')} className="flex flex-col gap-2">
                {MAIL_OPTS.map(opt => (
                  <UiRadioCard
                    key={opt.v}
                    modelValue={mailMode}
                    onUpdateModelValue={v => setMailMode(v as MailMode)}
                    value={opt.v}
                    title={opt.t}
                    description={opt.d}
                    className="w-full"
                  />
                ))}
              </div>
              <div className="flex gap-2">
                <UiButton variant="outline" size="lg" className="px-[18px]" disabled={busy} onClick={() => setStep(2)}>{t('common.prev')}</UiButton>
                <UiButton size="lg" className="flex-1 px-4 font-semibold" disabled={busy} onClick={() => { void saveMail() }}>{busy ? t('setup.saving') : t('setup.mail.next')}</UiButton>
              </div>
            </>
          ) : step === 4 ? (
            /* 5 기능 선택 */
            <>
              <AuthHeading title={t('setup.modules.title')} subtitle={t('setup.modules.subtitle')} />
              {modules.length ? (
                <div className="overflow-hidden rounded-lg border border-border bg-card">
                  {modules.map(m => (
                    <div key={m.id} className="flex min-h-12 items-center border-b border-border px-3.5 py-1 last:border-b-0">
                      <UiSwitch
                        modelValue={!!m.enabled}
                        label={featInfo(m).t}
                        description={featInfo(m).d}
                        disabled={!!featBusy[m.id]}
                        className="w-full"
                        onUpdateModelValue={(v: boolean) => { void toggleFeature(m, v) }}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <UiSkeleton preset="list" rows={6} framed />
              )}
              <div className="flex gap-2">
                <UiButton variant="outline" size="lg" className="px-[18px]" onClick={() => setStep(3)}>{t('common.prev')}</UiButton>
                <UiButton size="lg" className="flex-1 px-4 font-semibold" onClick={() => setStep(5)}>{t('setup.modules.next')}</UiButton>
              </div>
            </>
          ) : (
            /* 6 완료 */
            <>
              <AuthHeading icon="check" tone="success" title={t('setup.done.title')} subtitle={t('setup.done.subtitle')} />
              {error && <AuthAlert tone="danger" title={error} />}
              <UiButton size="lg" className="w-full font-semibold" disabled={busy} onClick={() => { void finish() }}>{busy ? t('setup.processing') : t('setup.done.goDashboard')}</UiButton>
            </>
          )}
        </>
      )}
    </AuthShell>
  )
}
