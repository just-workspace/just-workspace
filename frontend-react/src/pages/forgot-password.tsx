// Vue 원본: frontend/pages/forgot-password.vue
// 비밀번호 찾기(시안 8-3-1·8-3-2, AuthForm 로그인 세대): 아이디 1필드 → 재설정 링크.
// 성공은 같은 자리 결과 화면(아이콘 타일 40 + 제목 + 서버 안내) — 서버는 아이디 존재 여부를 숨기려 항상 같은 문구를 준다.
import { useState, type FormEvent } from 'react'
import { navigateTo } from '~/lib/router'
import { useHead } from '~/lib/head'
import { useI18n } from '~/i18n'
import { forgotPassword } from '~/composables/useAuth'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { NuxtLink } from '~/components/NuxtLink'
import { AuthShell } from '~/components/auth/AuthShell'
import { AuthHeading } from '~/components/auth/AuthHeading'
import { AuthAlert } from '~/components/auth/AuthAlert'
import { UiInput } from '~/components/ui/Input'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'

export default function Page() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()

  useHead({ title: `${t('authScreens.forgot.title')} | ${appName}` })

  const [username, setUsername] = useState('')
  const [error, setError] = useState('')
  const [fieldError, setFieldError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)
  const [successMessage, setSuccessMessage] = useState('')

  async function handleSubmit(ev: FormEvent) {
    ev.preventDefault()
    setFieldError('')
    setError('')
    if (!username.trim()) {
      setFieldError(t('forgotPassword.usernameRequired'))
      return
    }

    setSubmitting(true)
    try {
      const result = await forgotPassword(username.trim())
      setSuccess(true)
      setSuccessMessage(result.message)
    } catch (e: any) {
      setError(e?.data?.detail || t('error.genericError'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell>
      {success ? (
        <>
          <AuthHeading icon="send" tone="success" title={t('authScreens.forgot.doneTitle')} subtitle={successMessage} />
          <UiButton as="a" href="/login" size="lg" className="w-full font-semibold" onClick={(e) => { e.preventDefault(); void navigateTo('/login') }}>
            {t('authScreens.forgot.backToLogin')}
          </UiButton>
        </>
      ) : (
        <>
          <AuthHeading title={t('authScreens.forgot.title')} subtitle={t('authScreens.forgot.subtitle')} />

          {error && <AuthAlert tone="danger" title={error} />}

          <form className="flex flex-col gap-[18px]" noValidate onSubmit={(e) => { void handleSubmit(e) }}>
            <UiInput
              id="username"
              modelValue={username}
              onUpdateModelValue={setUsername}
              size="lg"
              label={t('authScreens.forgot.username')}
              error={fieldError}
              autocomplete="username"
              autoCapitalize="none"
              placeholder={t('forgotPassword.usernamePlaceholder')}
              autoFocus
            />
            <UiButton type="submit" size="lg" className="w-full font-semibold" disabled={submitting}>
              {submitting && <UiIcon name="refresh" className="mr-2 h-4 w-4 animate-spin" />}
              {submitting ? t('common.processing') : t('authScreens.forgot.submit')}
            </UiButton>
          </form>

          <p className="text-[13px] text-muted-foreground">
            <NuxtLink to="/login" className="font-semibold text-primary hover:underline">{t('authScreens.forgot.backToLogin')}</NuxtLink>
          </p>
        </>
      )}
    </AuthShell>
  )
}
