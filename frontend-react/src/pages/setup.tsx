// 최초 설정(FTW): auth 틀(AuthShell) 위, 폼 위에 "단계명 n / 6 + 진행 바".
// 관리자가 한 명도 없을 때만 열린다 — 설치 관리자 없이 직접 띄우고 관리자를 미리 만들지 않은 서버의 첫 화면.
// 첫 관리자 만들기는 서버 로그에 찍힌 설정 토큰이 있어야 한다(setup_mode = token).
// 설치 관리자가 꾸린 서버(setup_mode = installer)에서는 웹에서 만들 수 없다 — 안내만 보여 준다.
// 관리자 단계 = 이름·아이디·비밀번호(규칙 체크, 확인 칸 대신 보기 토글) + [이전][다음 — 브랜딩].
// 백업에서 옮겨 오는 일은 여기서 하지 않는다(설치 관리자의 "백업에서 복원") — 시작 단계에 안내만 둔다.
// 기능 선택 = 토글 목록 한 화면(스위치 즉시 저장 — 실패하면 되돌림).
import { useEffect, useState, type FormEvent } from 'react'
import { $fetch, errorStatus } from '~/lib/api'
import { useHead } from '~/lib/head'
import { getSharedState, setSharedState } from '~/lib/state'
import { useI18n } from '~/i18n'
import { nativeLogin } from '~/composables/useAuth'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { checkPasswordRules, passwordRulesPass, FIRST_ADMIN_PASSWORD_MIN } from '~/utils/passwordRules'
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

  // 가드(router/guards.ts)와 같은 공유 상태('setup-status')
  const setSetupStatus = (v: any) => setSharedState<any>('setup-status', v)

  const steps = [t('setup.steps.start'), t('setup.steps.admin'), t('setup.steps.branding'), t('setup.steps.mail'), t('setup.steps.features'), t('setup.steps.done')]
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 첫 관리자를 웹에서 만드는 방식 — 가드가 받아 둔 상태를 쓰고, 없으면 묻는다. 모르면 토큰 방식으로 본다(서버가 다시 판정한다).
  const [mode, setMode] = useState<'token' | 'installer'>(() => (getSharedState<any>('setup-status', () => null)?.setup_mode === 'installer' ? 'installer' : 'token'))
  useEffect(() => {
    let alive = true
    $fetch<any>('/api/setup/status').then(s => { if (alive && s?.setup_mode === 'installer') setMode('installer') }).catch(() => { /* 가드가 받은 값으로 둔다 */ })
    return () => { alive = false }
  }, [])

  const [aUser, setAUser] = useState(''); const [aPass, setAPass] = useState(''); const [aName, setAName] = useState('')
  const [aToken, setAToken] = useState('')
  const aRules = checkPasswordRules(aPass, [aUser.trim()], FIRST_ADMIN_PASSWORD_MIN)
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
      await $fetch('/api/setup/admin', { method: 'POST', body: { username: aUser, password: aPass, display_name: aName || undefined, setup_token: aToken.trim() } })
      await nativeLogin(aUser, aPass, true)
      setStep(2)
    } catch (e: any) {
      const detail = e?.data?.detail
      const code = detail && typeof detail === 'object' ? detail.code : undefined
      if (code === 'setup_closed') setMode('installer')
      else if (code === 'setup_token_invalid') setError(t('setup.errors.tokenInvalid'))
      else if (code === 'admin_exists') setError(t('setup.errors.adminExists'))
      else if (errorStatus(e) === 429) setError(t('setup.errors.tooMany'))
      else setError((typeof detail === 'string' && detail) || t('setup.errors.adminFailed'))
    } finally { setBusy(false) }
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

  // 설치 관리자가 꾸린 서버 — 관리자는 설치 관리자가 만든다. 여기서는 만들 수 없다.
  if (mode === 'installer' && step < 2) {
    return (
      <AuthShell>
        <AuthHeading title={t('setup.closed.title')} subtitle={t('setup.closed.subtitle')} />
        <AuthAlert tone="info" title={t('setup.closed.where')} description={t('setup.closed.whereDesc')} />
        <p className="text-[13px] text-muted-foreground">{t('setup.closed.cliHint')}</p>
        <UiButton size="lg" variant="outline" className="w-full font-semibold" onClick={() => { window.location.reload() }}>{t('setup.closed.retry')}</UiButton>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <AuthStepHeader label={steps[step]} step={step + 1} total={steps.length} />

      {step === 0 ? (
        /* 1 시작 */
        <>
          <AuthHeading title={t('setup.start.title', { appName })} subtitle={t('setup.start.subtitle')} />
          <div className="flex flex-col gap-2">
            <UiButton size="lg" className="w-full font-semibold" onClick={() => setStep(1)}>{t('setup.start.fresh')}</UiButton>
          </div>
          <p className="text-[13px] text-muted-foreground">{t('setup.start.restoreHint')}</p>
        </>
      ) : step === 1 ? (
        /* 2 관리자 계정 */
        <>
          <AuthHeading title={t('setup.admin.title')} subtitle={t('setup.admin.subtitle')} />
          {error && <AuthAlert tone="danger" title={error} />}
          <form className="flex flex-col gap-[18px]" noValidate onSubmit={(e) => { void createAdmin(e) }}>
            <div className="flex flex-col gap-1.5">
              <UiInput id="setup-token" modelValue={aToken} onUpdateModelValue={setAToken} size="lg" mono label={t('setup.token.label')} autocomplete="off" autoCapitalize="none" spellCheck="false" autoFocus />
              <p className="text-xs leading-normal text-muted-foreground">
                {t('setup.token.hint')}{' '}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">docker compose logs backend</code>{' · '}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">docker compose exec backend python -m app.cli setup-token</code>
              </p>
            </div>
            <UiInput id="setup-admin-name" modelValue={aName} onUpdateModelValue={setAName} size="lg" label={t('authScreens.register.name')} hint={t('setup.admin.nameHint')} autocomplete="name" />
            <UiInput id="setup-admin-user" modelValue={aUser} onUpdateModelValue={setAUser} size="lg" label={t('authScreens.register.username')} placeholder={t('setup.admin.usernamePlaceholder')} autocomplete="username" autoCapitalize="none" spellCheck="false" />
            <div className="flex flex-col gap-1.5">
              <UiPasswordInput id="setup-admin-pass" modelValue={aPass} onUpdateModelValue={setAPass} size="lg" label={t('authScreens.register.password')} autocomplete="new-password" />
              <AuthPasswordRules results={aRules} contextLabel={t('authScreens.register.username')} min={FIRST_ADMIN_PASSWORD_MIN} />
            </div>
            <div className="mt-1 flex gap-2">
              <UiButton type="button" variant="outline" size="lg" className="px-[18px]" disabled={busy} onClick={() => setStep(0)}>{t('common.prev')}</UiButton>
              <UiButton type="submit" size="lg" className="flex-1 px-4 font-semibold" disabled={busy || !aUser || !aToken.trim() || !passwordRulesPass(aRules)}>
                {busy ? t('setup.admin.creating') : t('setup.admin.next')}
              </UiButton>
            </div>
          </form>
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
    </AuthShell>
  )
}
