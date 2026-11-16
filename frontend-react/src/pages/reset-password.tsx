// 비밀번호 재설정("재설정 성공"): 새 비밀번호 1필드(확인 칸 대신 보기 토글) + 규칙 체크.
// 성공 = 결과 화면(success 타일 40 + "비밀번호를 바꿨습니다" + 로그인하기). 백엔드는 재설정 시 전체 세션을 종료한다.
// 토큰 없음 = 동일 결과 화면 틀의 warning(링크가 올바르지 않습니다).
import { useState, type FormEvent } from 'react'
import { $fetch } from '~/lib/api'
import { navigateTo, useRoute } from '~/lib/router'
import { useHead } from '~/lib/head'
import { useI18n } from '~/i18n'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { checkPasswordRules, passwordRulesPass } from '~/utils/passwordRules'
import { errText } from '~/utils/errText'
import { NuxtLink } from '~/components/NuxtLink'
import { AuthShell } from '~/components/auth/AuthShell'
import { AuthHeading } from '~/components/auth/AuthHeading'
import { AuthAlert } from '~/components/auth/AuthAlert'
import { AuthPasswordRules } from '~/components/auth/AuthPasswordRules'
import { UiPasswordInput } from '~/components/ui/PasswordInput'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'

export default function Page() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  const route = useRoute()

  useHead({ title: `${t('authScreens.reset.title')} | ${appName}` })
  const token = (route.query.token as string) || ''

  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)

  // 링크만으로는 아이디를 확인할 수 없다 → "아이디와 다름" 규칙은 서버가 판정(실패 시 상단 타일)
  const rules = checkPasswordRules(newPassword).filter(r => r.key !== 'distinct')
  const canSubmit = passwordRulesPass(rules) && !submitting

  async function handleSubmit(ev: FormEvent) {
    ev.preventDefault()
    setError('')
    if (!token) {
      setError(t('resetPassword.invalidToken'))
      return
    }
    if (!passwordRulesPass(rules)) return

    setSubmitting(true)
    try {
      await $fetch('/api/auth/reset-password', {
        method: 'POST',
        body: { token, new_password: newPassword },
      })
      setSuccess(true)
    } catch (e: any) {
      setError(errText(e, t('error.genericError')))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell>
      {success ? (
        <>
          <AuthHeading icon="check" tone="success" title={t('authScreens.reset.doneTitle')} subtitle={t('authScreens.reset.doneMessage')} />
          <UiButton as="a" href="/login" size="lg" className="w-full font-semibold" onClick={(e) => { e.preventDefault(); void navigateTo('/login') }}>
            {t('authScreens.reset.goLogin')}
          </UiButton>
        </>
      ) : !token ? (
        <>
          <AuthHeading icon="clock" tone="warning" title={t('authScreens.reset.invalidTitle')} subtitle={t('authScreens.reset.invalidMessage')} />
          <UiButton as="a" href="/forgot-password" variant="outline" size="lg" className="w-full bg-card" onClick={(e) => { e.preventDefault(); void navigateTo('/forgot-password') }}>
            {t('authScreens.reset.requestAgain')}
          </UiButton>
        </>
      ) : (
        <>
          <AuthHeading title={t('authScreens.reset.title')} subtitle={t('authScreens.reset.subtitle')} />

          {error && <AuthAlert tone="danger" title={error} />}

          <form className="flex flex-col gap-[18px]" noValidate onSubmit={(e) => { void handleSubmit(e) }}>
            <div className="flex flex-col gap-1.5">
              <UiPasswordInput
                id="new-password"
                modelValue={newPassword}
                onUpdateModelValue={setNewPassword}
                size="lg"
                label={t('authScreens.reset.newPassword')}
                autocomplete="new-password"
                placeholder={t('resetPassword.newPasswordPlaceholder')}
                autofocus
              />
              <AuthPasswordRules results={rules} />
            </div>
            <UiButton type="submit" size="lg" className="w-full font-semibold" disabled={!canSubmit}>
              {submitting && <UiIcon name="refresh" className="mr-2 h-4 w-4 animate-spin" />}
              {submitting ? t('common.processing') : t('authScreens.reset.submit')}
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
