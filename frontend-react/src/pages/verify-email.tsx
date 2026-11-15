// 이메일 인증: 결과 화면 틀(아이콘 타일 40 + 제목 24/700 + 서버 안내 + 1차 버튼).
// 확인 중엔 같은 틀의 스켈레톤(제목·문단 자리) — 스피너 대신.
import { useEffect, useState } from 'react'
import { $fetch } from '~/lib/api'
import { navigateTo, useRoute } from '~/lib/router'
import { useHead } from '~/lib/head'
import { useI18n } from '~/i18n'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { checkRecoveryEmailLink, confirmRecoveryEmailChange } from '~/composables/useAuth'
import { NuxtLink } from '~/components/NuxtLink'
import { AuthShell } from '~/components/auth/AuthShell'
import { AuthHeading } from '~/components/auth/AuthHeading'
import { UiButton } from '~/components/ui/Button'
import { UiSkeleton } from '~/components/ui/Skeleton'

export default function Page() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  const route = useRoute()
  // confirm = 복구 이메일 변경 링크가 살아 있고 사람의 확인(버튼)을 기다리는 중
  const [status, setStatus] = useState<'loading' | 'confirm' | 'success' | 'error'>('loading')
  const [confirming, setConfirming] = useState(false)
  const [message, setMessage] = useState('')

  useHead({ title: `${t('authScreens.verify.title')} | ${appName}` })

  const token = route.query.token as string
  // 복구 이메일 변경 확인 링크(/verify-email?change=…, 설정 › 계정에서 요청) — 같은 결과 화면을 쓴다
  const change = route.query.change as string
  useEffect(() => {
    void (async () => {
      if (change) {
        // 착지만으로는 확정하지 않는다 — 메일 보안 장비가 링크를 미리 열어 봐도 바뀌지 않게. 여기서는 링크 상태만 보고
        // (토큰을 쓰지 않는다), 사람이 아래 버튼을 눌러야 확정한다. 확정 뒤 새로고침하면 "이미 적용됨"으로 보인다.
        try {
          const { state } = await checkRecoveryEmailLink(change)
          if (state === 'pending') setStatus('confirm')
          else if (state === 'done') {
            setStatus('success')
            setMessage(t('settings.account.recovery.alreadyDone', '이 링크로 복구 이메일을 이미 바꿨습니다.'))
          } else {
            setStatus('error')
            setMessage(t('settings.account.recovery.linkInvalid', '유효하지 않거나 만료된 확인 링크입니다. 설정에서 다시 요청해주세요.'))
          }
        } catch (e: any) {
          setStatus('error')
          setMessage(typeof e?.data?.detail === 'string' ? e.data.detail : t('verifyEmail.errorGeneric'))
        }
        return
      }
      if (!token) {
        setStatus('error')
        setMessage(t('verifyEmail.invalidToken'))
        return
      }
      try {
        const data = await $fetch<{ message: string }>('/api/auth/verify-email', {
          params: { token },
        })
        setStatus('success')
        setMessage(data.message)
      } catch (e: any) {
        setStatus('error')
        setMessage(e?.data?.detail || t('verifyEmail.errorGeneric'))
      }
    })()
    // 마운트 때 한 번
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const goLogin = (e: { preventDefault: () => void }) => { e.preventDefault(); void navigateTo('/login') }
  // 변경 확인은 이미 가입한 사용자의 일 — 설정 › 계정으로(로그인 전이면 가드가 로그인을 거쳐 데려온다), "가입" 안내는 없다
  const goAccount = (e: { preventDefault: () => void }) => { e.preventDefault(); void navigateTo('/settings/account') }

  async function confirmChange() {
    if (confirming) return
    setConfirming(true)
    try {
      const data = await confirmRecoveryEmailChange(change)
      setStatus('success')
      setMessage(data.message)
    } catch (e: any) {
      setStatus('error')
      setMessage(typeof e?.data?.detail === 'string' ? e.data.detail : t('verifyEmail.errorGeneric'))
    } finally { setConfirming(false) }
  }

  return (
    <AuthShell>
      {status === 'confirm' ? (
        <>
          <AuthHeading
            icon="mail"
            title={t('settings.account.recovery.confirmTitle', '복구 이메일 변경 확인')}
            subtitle={t('settings.account.recovery.confirmBody', '이 주소를 계정의 복구 이메일로 쓰려면 아래 버튼을 누르세요. 누르기 전에는 아무것도 바뀌지 않습니다.')}
          />
          <UiButton size="lg" className="w-full font-semibold" disabled={confirming} onClick={() => void confirmChange()}>
            {t('settings.account.recovery.confirmButton', '복구 이메일 변경 확인')}
          </UiButton>
          <p className="text-[13px] text-muted-foreground">
            {t('settings.account.recovery.confirmNotMe', '본인이 요청하지 않았다면 이 창을 닫으세요.')}
          </p>
        </>
      ) : status !== 'loading' && change ? (
        <>
          <AuthHeading
            icon={status === 'success' ? 'check' : 'alert-circle'}
            tone={status === 'success' ? 'success' : 'danger'}
            title={status === 'success'
              ? t('settings.account.recovery.doneTitle', '복구 이메일을 바꿨습니다')
              : t('settings.account.recovery.failTitle', '복구 이메일을 바꾸지 못했습니다')}
            subtitle={message}
          />
          <UiButton as="a" href="/settings/account" size="lg" className="w-full font-semibold" onClick={goAccount}>
            {t('settings.account.recovery.goAccount', '계정 설정으로')}
          </UiButton>
        </>
      ) : status === 'loading' ? (
        <div className="flex flex-col gap-[18px]" role="status" aria-label={t('authScreens.verify.loading')}>
          <UiSkeleton className="h-10 w-10 rounded-[10px]" />
          <div className="flex flex-col gap-2">
            <UiSkeleton className="h-7 w-48" />
            <UiSkeleton className="h-4 w-full" />
          </div>
          <p className="text-sm text-muted-foreground">{t('authScreens.verify.loading')}</p>
        </div>
      ) : status === 'success' ? (
        <>
          <AuthHeading icon="check" tone="success" title={t('authScreens.verify.doneTitle')} subtitle={message} />
          <UiButton as="a" href="/login" size="lg" className="w-full font-semibold" onClick={goLogin}>
            {t('authScreens.verify.goLogin')}
          </UiButton>
        </>
      ) : (
        <>
          <AuthHeading icon="alert-circle" tone="danger" title={t('authScreens.verify.failTitle')} subtitle={message} />
          <UiButton as="a" href="/login" size="lg" className="w-full font-semibold" onClick={goLogin}>
            {t('authScreens.verify.goLogin')}
          </UiButton>
          <p className="text-[13px] text-muted-foreground">
            <NuxtLink to="/register" className="font-semibold text-primary hover:underline">{t('authScreens.verify.goRegister')}</NuxtLink>
          </p>
        </>
      )}
    </AuthShell>
  )
}
