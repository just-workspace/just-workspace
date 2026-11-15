// Vue 원본: frontend/pages/login.vue
// 로그인. 모듈 셸(AuthShell)로 감싼다.
// 서버 오류 = 폼 상단 danger 타일, Caps Lock = 비밀번호 아래 warning 힌트, 보조 진입 = "또는" 아래.
// 2단계 인증 계정이면 같은 자리에서 코드 입력 단계로 넘어간다(/api/auth/2fa/verify).
// ※ 초록 "Git 바로가기" 버튼은 운영 결정으로 유지(사용자 고집) — 클래스 그대로.
import { useEffect, useState, type FormEvent } from 'react'
import { $fetch } from '~/lib/api'
import { navigateTo, useRoute } from '~/lib/router'
import { useHead } from '~/lib/head'
import { useI18n } from '~/i18n'
import { useAuth, nativeLogin, verify2fa } from '~/composables/useAuth'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { NuxtLink } from '~/components/NuxtLink'
import { AuthShell } from '~/components/auth/AuthShell'
import { AuthHeading } from '~/components/auth/AuthHeading'
import { AuthAlert } from '~/components/auth/AuthAlert'
import { AuthDivider } from '~/components/auth/AuthDivider'
import { UiInput } from '~/components/ui/Input'
import { UiPasswordInput } from '~/components/ui/PasswordInput'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'

type AnyErr = any

export default function Page() {
  const { t } = useI18n()
  const { user } = useAuth()
  const { appName, registrationMode, giteaUrl, config } = useSiteConfig()
  const route = useRoute()

  useHead({ title: `${t('authScreens.login.title')} | ${appName}` })

  const cfg = (k: string) => (config?.[k] ?? '').trim()
  const subtitle = cfg('auth.subtitle') || t('authScreens.login.subtitle')
  const secondaryLabel = cfg('auth.secondary_label')
  const secondaryHref = cfg('auth.secondary_href')
  const signupEnabled = cfg('auth.signup_enabled') !== 'false'
  const footerNote = cfg('auth.footer_note')
  const footerLinks = cfg('brand.footer_links').split(',').map(s => s.trim()).filter(Boolean)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const [error, setError] = useState('')
  // 이메일 미인증으로 막힌 경우에만 재발송 버튼을 띄운다
  const [needsVerify, setNeedsVerify] = useState(false)
  const [resending, setResending] = useState(false)
  const [resentMsg, setResentMsg] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // 2단계 인증 단계
  const [tempToken, setTempToken] = useState('')
  const [otp, setOtp] = useState('')
  const [otpError, setOtpError] = useState('')
  // 인증 앱을 잃어버렸을 때 — 복구 코드(xxxx-xxxx)로 바꿔 입력. 서버(/2fa/verify)는 원래 받는데
  // 이 칸이 숫자 6자리만 받아 복구 코드가 있어도 로그인할 길이 없었다.
  const [useRecovery, setUseRecovery] = useState(false)

  // 로그인 뒤 갈 곳(쿼리 redirect, 없으면 대시보드)
  const redirectQ = route.query.redirect as string | undefined
  const redirectTo = (() => {
    const r = redirectQ
    if (!r) return '/'
    // 상대 경로 허용(예: /oauth/authorize?...)
    if (r.startsWith('/')) return r
    // 우리 도메인의 HTTPS 주소만 허용(호스트명 엄격 비교)
    if (r.startsWith('https://')) {
      try {
        const parsed = new URL(r)
        if (parsed.hostname === window.location.hostname || parsed.hostname.endsWith(`.${window.location.hostname}`)) return r
      } catch { /* invalid URL */ }
    }
    return '/'
  })()

  function goAfterLogin() {
    const dest = redirectTo
    // /oauth/·/rbi-login 은 앱 화면이 아니라 서버 경로(격리 브라우저 SSO 홉 — app/rbi/site.py) — 전체 페이지 이동
    if (dest.startsWith('https://') || dest.startsWith('/oauth/') || dest === '/rbi-login' || dest.startsWith('/rbi-login?')) {
      window.location.href = dest
    } else {
      void navigateTo(dest)
    }
  }

  // 이미 로그인돼 있으면 이동(Vue watch(user, immediate))
  useEffect(() => {
    if (user) goAfterLogin()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  function describeError(e: AnyErr): string {
    const detail = e?.data?.detail || ''
    const statusCode = e?.statusCode || e?.status || 0
    if (typeof detail === 'string' && detail) return detail
    if (statusCode === 401) return t('auth.invalidCredentials')
    if (statusCode === 502) return t('auth.authServerUnavailable')
    return t('auth.loginError')
  }

  async function handleSubmit(ev: FormEvent) {
    ev.preventDefault()
    if (!username.trim() || !password) {
      setError(t('auth.enterCredentials'))
      return
    }
    setSubmitting(true)
    setError('')
    setNeedsVerify(false)
    setResentMsg('')
    try {
      const res = await nativeLogin(username.trim(), password, rememberMe)
      if (res.requires_2fa && res.temp_token) {
        setTempToken(res.temp_token)
        setOtp('')
        setOtpError('')
        return
      }
      goAfterLogin()
    } catch (e: AnyErr) {
      if (e?.data?.code === 'email_unverified') setNeedsVerify(true)
      setError(describeError(e))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleVerify2fa(ev: FormEvent) {
    ev.preventDefault()
    const code = useRecovery ? otp.trim() : otp.replace(/\s/g, '')
    if (useRecovery) {
      // 복구 코드는 글자·숫자 8개(가운데 줄표·공백은 있어도 없어도 된다)
      if (code.replace(/[^a-z0-9]/gi, '').length !== 8) {
        setOtpError(t('authScreens.twoFactor.recoveryFormat', '복구 코드 8자리를 입력하세요 (예: abcd-efgh)'))
        return
      }
    } else if (!/^\d{6}$/.test(code)) {
      setOtpError(t('authScreens.twoFactor.format'))
      return
    }
    setSubmitting(true)
    setOtpError('')
    setError('')
    try {
      await verify2fa(tempToken, code)
      goAfterLogin()
    } catch (e: AnyErr) {
      const detail = e?.data?.detail
      setError(typeof detail === 'string' && detail ? detail : t('authScreens.twoFactor.failed'))
    } finally {
      setSubmitting(false)
    }
  }

  function backToPassword() {
    setTempToken('')
    setOtp('')
    setOtpError('')
    setError('')
    setPassword('')
    setUseRecovery(false)
  }

  function toggleRecovery() {
    setUseRecovery(v => !v)
    setOtp('')
    setOtpError('')
    setError('')
  }

  async function resendVerification() {
    if (resending) return
    setResending(true)
    setResentMsg('')
    try {
      const r = await $fetch<{ message: string }>('/api/auth/resend-verification', {
        method: 'POST',
        body: { username: username.trim() },
      })
      setResentMsg(r.message)
      setError('')
    } catch (e: AnyErr) {
      setError(e?.data?.detail || t('auth.resendFailed'))
    } finally {
      setResending(false)
    }
  }

  return (
    <AuthShell>
      {tempToken ? (
        /* 2단계 인증 */
        <>
          <AuthHeading title={t('authScreens.twoFactor.title')} subtitle={t('authScreens.twoFactor.subtitle')} />

          {error && <AuthAlert tone="danger" title={error} />}

          <form className="flex flex-col gap-[18px]" noValidate onSubmit={(e) => { void handleVerify2fa(e) }}>
            {useRecovery ? (
              <UiInput
                key="recovery"
                id="otp"
                modelValue={otp}
                onUpdateModelValue={setOtp}
                size="lg"
                mono
                label={t('authScreens.twoFactor.recoveryCode', '복구 코드')}
                hint={t('authScreens.twoFactor.recoveryHint', '2단계 인증을 켤 때 받은 일회용 코드입니다. 한 번 쓰면 사라집니다.')}
                error={otpError}
                autocomplete="off"
                autoCapitalize="none"
                spellCheck="false"
                maxLength={12}
                placeholder="xxxx-xxxx"
                autoFocus
              />
            ) : (
              <UiInput
                key="totp"
                id="otp"
                modelValue={otp}
                onUpdateModelValue={setOtp}
                size="lg"
                mono
                label={t('authScreens.twoFactor.code')}
                error={otpError}
                autocomplete="one-time-code"
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                autoFocus
              />
            )}
            <UiButton type="submit" size="lg" className="w-full font-semibold" disabled={submitting}>
              {submitting ? t('authScreens.login.submitting') : t('authScreens.twoFactor.submit')}
            </UiButton>
          </form>

          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
            <button type="button" className="font-semibold text-primary hover:underline" onClick={toggleRecovery}>
              {useRecovery
                ? t('authScreens.twoFactor.useApp', '인증 앱 코드로 입력')
                : t('authScreens.twoFactor.useRecovery', '인증 앱을 쓸 수 없나요? 복구 코드 사용')}
            </button>
            <button type="button" className="font-semibold text-primary hover:underline" onClick={backToPassword}>
              {t('authScreens.twoFactor.back')}
            </button>
          </p>
        </>
      ) : (
        /* 아이디·비밀번호 */
        <>
          <AuthHeading title={t('authScreens.login.title')} subtitle={subtitle} />

          {error && (
            <AuthAlert
              tone="danger"
              title={error}
              action={needsVerify && !resentMsg ? (
                /* 이메일 미인증으로 막혔을 때만 — 스스로 복구할 수 있게 */
                <button
                  type="button"
                  className="mt-1 block font-semibold text-primary hover:underline disabled:opacity-50"
                  disabled={resending}
                  onClick={() => { void resendVerification() }}
                >{resending ? t('auth.resending') : t('auth.resendVerification')}</button>
              ) : undefined}
            />
          )}
          {resentMsg && <AuthAlert tone="success" title={resentMsg} />}

          <form className="flex flex-col gap-[18px]" noValidate onSubmit={(e) => { void handleSubmit(e) }}>
            <UiInput
              id="username"
              modelValue={username}
              onUpdateModelValue={setUsername}
              size="lg"
              label={t('authScreens.login.identifier')}
              autocomplete="username"
              placeholder={t('auth.usernameOrEmailPlaceholder')}
              autoFocus
            />

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label htmlFor="password" className="text-xs font-semibold text-muted-foreground">{t('auth.password')}</label>
                <NuxtLink to="/forgot-password" className="text-xs font-semibold text-primary hover:underline">{t('authScreens.login.forgot')}</NuxtLink>
              </div>
              <UiPasswordInput
                id="password"
                modelValue={password}
                onUpdateModelValue={setPassword}
                size="lg"
                autocomplete="current-password"
                placeholder={t('auth.passwordPlaceholder')}
                capsLockHint={t('authScreens.login.capsLock')}
              />
            </div>

            <UiCheckbox modelValue={rememberMe} onUpdateModelValue={setRememberMe} id="rememberMe" label={t('authScreens.login.remember')} className="-my-2.5 self-start" />

            <UiButton type="submit" size="lg" className="w-full font-semibold" disabled={submitting}>
              {submitting && <UiIcon name="refresh" className="mr-2 h-4 w-4 animate-spin" />}
              {submitting ? t('authScreens.login.submitting') : t('authScreens.login.submit')}
            </UiButton>
          </form>

          <AuthDivider label={t('authScreens.login.or')} />

          <div className="flex flex-col gap-2">
            {/* 비회원용 코드 저장소(Gitea) 바로가기 — 시그니처 초록(운영 결정으로 유지) */}
            <a
              href={giteaUrl || '/git/'}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-success px-4 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-success/90 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-success/50"
            >
              <UiIcon name="git-branch" className="h-4 w-4" />
              {t('auth.gitShortcut')}
            </a>

            {secondaryLabel && secondaryHref && (
              <a
                href={secondaryHref}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-md border border-border bg-card text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              >
                {secondaryLabel}
              </a>
            )}
          </div>

          {registrationMode !== 'closed' && signupEnabled && (
            <p className="text-[13px] text-muted-foreground">
              {t('authScreens.login.noAccount')}{' '}
              <NuxtLink to="/register" className="font-semibold text-primary hover:underline">{t('authScreens.login.signUp')}</NuxtLink>
            </p>
          )}
        </>
      )}

      {(footerNote || footerLinks.length > 0) && (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          {footerNote && <p className="text-xs text-muted-foreground">{footerNote}</p>}
          {footerLinks.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground lg:hidden">
              {footerLinks.map(l => <span key={l}>{l}</span>)}
            </div>
          )}
        </div>
      )}
    </AuthShell>
  )
}
