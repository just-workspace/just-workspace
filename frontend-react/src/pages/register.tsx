// 가입: 이름 · 아이디 · 비밀번호(규칙 실시간 체크, 확인 칸 대신 보기 토글) · 복구 이메일.
// 백엔드가 복구 이메일로 인증 메일을 발송하고 인증 전에는 로그인을 차단하므로(RegisterRequest.recovery_email 필수) 펼친 필수 필드로 둔다.
//
// 초대 가입(/register?invite=<token>): GET /api/auth/invites/{token} 으로 확인 → 수신 메일 주소를 복구 이메일에 사전 입력하고
// 가입 요청에 invite_token 을 포함한다. 가입이 닫혀 있어도 초대인 경우 허용된다.
// 링크가 만료·사용됨이면 상단에 경고 타일 표시 — 가입이 열려 있으면 일반 가입으로 계속 진행할 수 있다.
import { useEffect, useState, type FormEvent } from 'react'
import { $fetch } from '~/lib/api'
import { navigateTo, useRoute } from '~/lib/router'
import { useHead } from '~/lib/head'
import { useI18n } from '~/i18n'
import { register } from '~/composables/useAuth'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { checkPasswordRules, passwordRulesPass } from '~/utils/passwordRules'
import { NuxtLink } from '~/components/NuxtLink'
import { AuthShell } from '~/components/auth/AuthShell'
import { AuthHeading } from '~/components/auth/AuthHeading'
import { AuthAlert } from '~/components/auth/AuthAlert'
import { AuthPasswordRules } from '~/components/auth/AuthPasswordRules'
import { UiInput } from '~/components/ui/Input'
import { UiPasswordInput } from '~/components/ui/PasswordInput'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'

interface InviteState { state: 'none' | 'checking' | 'valid' | 'invalid'; email: string | null; expiresAt: string | null }
interface Form { username: string; password: string; display_name: string; recovery_email: string }
interface FieldErrors { username?: string; display_name?: string; recovery_email?: string }

export default function Page() {
  const { t } = useI18n()
  const { appName, registrationMode, domain: mailDomain } = useSiteConfig()
  const route = useRoute()

  const inviteToken = typeof route.query.invite === 'string' ? route.query.invite.trim() : ''
  // checking → valid | invalid (토큰이 없으면 none)
  const [invite, setInvite] = useState<InviteState>(() => ({ state: inviteToken ? 'checking' : 'none', email: null, expiresAt: null }))

  const [form, setForm] = useState<Form>({ username: '', password: '', display_name: '', recovery_email: '' })
  const setField = (k: keyof Form) => (v: string) => setForm(f => ({ ...f, [k]: v }))

  async function checkInvite() {
    if (!inviteToken) { setInvite({ state: 'none', email: null, expiresAt: null }); return }
    setInvite({ state: 'checking', email: null, expiresAt: null })
    try {
      const r = await $fetch<{ valid: boolean; email?: string | null; expires_at?: string | null }>(`/api/auth/invites/${encodeURIComponent(inviteToken)}`)
      setInvite(r.valid ? { state: 'valid', email: r.email ?? null, expiresAt: r.expires_at ?? null } : { state: 'invalid', email: null, expiresAt: null })
      if (r.valid && r.email) { const email = r.email; setForm(f => (f.recovery_email ? f : { ...f, recovery_email: email })) }
    } catch {
      setInvite({ state: 'invalid', email: null, expiresAt: null })
    }
  }
  useEffect(() => {
    void checkInvite()
    // 마운트 시 1회
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 가입이 닫혀 있으면 로그인으로 이동 — 단, 초대 링크로 진입한 경우 유지한다(사용 불가 링크면 경고만 표시하고 제출은 차단)
  useEffect(() => {
    if (registrationMode === 'closed' && !inviteToken) void navigateTo('/login')
  }, [registrationMode, inviteToken])
  const closedWithoutInvite = registrationMode === 'closed' && invite.state !== 'valid'
  const inviteExpires = invite.expiresAt ? new Date(invite.expiresAt).toLocaleDateString() : ''

  useHead({ title: `${t('authScreens.register.title')} | ${appName}` })

  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)
  const [successMessage, setSuccessMessage] = useState('')

  // 계정 메일 주소는 서버의 메일 도메인으로 생성된다(username@DOMAIN). 접속 주소의 호스트명(ws.example.com)을
  // 사용하면 미리보기가 불일치하고, "복구 이메일은 외부 주소" 검사도 잘못된 도메인을 대상으로 한다. 설정 조회 실패 시에만 호스트명 사용.
  const domain = mailDomain && mailDomain !== 'localhost' ? mailDomain : window.location.hostname
  const emailPreview = form.username ? `${form.username.trim().toLowerCase()}@${domain}` : ''

  const rules = checkPasswordRules(form.password, [form.username.trim(), emailPreview])
  const rulesOk = passwordRulesPass(rules)
  const canSubmit = invite.state !== 'checking' && !closedWithoutInvite &&
    !!form.display_name.trim() && !!form.username.trim() && !!form.recovery_email.trim() && rulesOk && !submitting

  function validate(): boolean {
    const fe: FieldErrors = {}
    fe.username = form.username.trim() ? undefined : t('validation.allFieldsRequired')
    fe.display_name = form.display_name.trim() ? undefined : t('validation.allFieldsRequired')
    const re = form.recovery_email.trim().toLowerCase()
    if (!re) fe.recovery_email = t('validation.allFieldsRequired')
    else if (re.endsWith(`@${domain}`)) fe.recovery_email = t('validation.recoveryEmailMustBeExternal')
    else fe.recovery_email = undefined
    setFieldErrors(fe)
    return !fe.username && !fe.display_name && !fe.recovery_email && rulesOk
  }

  async function handleSubmit(ev: FormEvent) {
    ev.preventDefault()
    setError('')
    if (!validate()) return

    setSubmitting(true)
    try {
      const r = await register({
        username: form.username.trim().toLowerCase(),
        password: form.password,
        display_name: form.display_name.trim(),
        recovery_email: form.recovery_email.trim(),
        ...(invite.state === 'valid' ? { invite_token: inviteToken } : {}),
      })
      // 가입 방식(open/approval)에 따라 서버가 상이한 안내를 반환한다 — 그대로 표시한다
      setSuccessMessage(r?.message || t('register.successMessage'))
      setSuccess(true)
    } catch (e: any) {
      const detail = e?.data?.detail
      if (Array.isArray(detail)) {
        setError(detail.map((d: any) => d.msg?.replace('Value error, ', '') || d.msg).join(', '))
      } else if (typeof detail === 'string') {
        setError(detail)
      } else {
        setError(t('register.errorGeneric'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell>
      {success ? (
        /* 결과 화면(아이콘 타일은 결과 화면에만) */
        <>
          <AuthHeading icon="check" tone="success" title={t('register.successTitle')} subtitle={successMessage} />
          <UiButton as="a" href="/login" size="lg" className="w-full font-semibold" onClick={(e) => { e.preventDefault(); void navigateTo('/login') }}>
            {t('authScreens.register.goLogin')}
          </UiButton>
        </>
      ) : (
        <>
          <AuthHeading title={t('authScreens.register.title')} subtitle={t('authScreens.register.subtitle')} />

          {error ? (
            <AuthAlert tone="danger" title={error} />
          ) : invite.state === 'valid' ? (
            <AuthAlert
              tone="info"
              title={t('authScreens.register.invited')}
              description={inviteExpires ? t('authScreens.register.invitedDesc', { date: inviteExpires }) : undefined}
            />
          ) : invite.state === 'invalid' ? (
            <AuthAlert tone="warning" title={t('authScreens.register.inviteInvalid')} description={registrationMode === 'closed' ? undefined : t('authScreens.register.inviteInvalidDesc')} />
          ) : null}

          <form className="flex flex-col gap-[18px]" noValidate onSubmit={(e) => { void handleSubmit(e) }}>
            <UiInput
              id="display_name"
              modelValue={form.display_name}
              onUpdateModelValue={setField('display_name')}
              size="lg"
              label={t('authScreens.register.name')}
              error={fieldErrors.display_name}
              autocomplete="name"
              placeholder={t('register.displayNamePlaceholder')}
              autoFocus
            />

            <UiInput
              id="username"
              modelValue={form.username}
              onUpdateModelValue={setField('username')}
              size="lg"
              label={t('authScreens.register.username')}
              error={fieldErrors.username}
              hint={emailPreview ? t('authScreens.register.usernameHint', { email: emailPreview }) : undefined}
              autocomplete="username"
              autoCapitalize="none"
              spellCheck="false"
              placeholder={t('register.usernamePlaceholder')}
            />

            <div className="flex flex-col gap-1.5">
              <UiPasswordInput
                id="password"
                modelValue={form.password}
                onUpdateModelValue={setField('password')}
                size="lg"
                label={t('authScreens.register.password')}
                autocomplete="new-password"
                placeholder={t('register.passwordPlaceholder')}
              />
              <AuthPasswordRules results={rules} contextLabel={t('authScreens.rules.defaultTarget')} />
            </div>

            <UiInput
              id="recovery_email"
              modelValue={form.recovery_email}
              onUpdateModelValue={setField('recovery_email')}
              size="lg"
              type="email"
              label={t('authScreens.register.recoveryEmail')}
              error={fieldErrors.recovery_email}
              hint={t('authScreens.register.recoveryEmailHint', { domain })}
              autocomplete="email"
              placeholder={t('register.recoveryEmailPlaceholder')}
            />

            <UiButton type="submit" size="lg" className="w-full font-semibold" disabled={!canSubmit}>
              {submitting && <UiIcon name="refresh" className="mr-2 h-4 w-4 animate-spin" />}
              {submitting ? t('common.processing') : t('authScreens.register.submit')}
            </UiButton>
          </form>

          <p className="text-[13px] text-muted-foreground">
            {t('authScreens.register.hasAccount')}{' '}
            <NuxtLink to="/login" className="font-semibold text-primary hover:underline">{t('authScreens.register.login')}</NuxtLink>
          </p>
        </>
      )}
    </AuthShell>
  )
}
