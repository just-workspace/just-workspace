/**
 * 오류 화면(Vue components/auth/AuthErrorScreen.vue · 시안 S3·8-4-3) — pages/error(/error 라우트)와 라우터 전역 오류·404 가 같이 쓴다.
 *  로그인 후 404 = 셸 안(mono 404 · 제목 22/700 · 설명 14 + 경로 mono · [홈으로][검색 Ctrl K]).
 *  서버 오류(5xx) = 셸 없는 500 화면(시안 ShellPage error500 — AuthServerErrorScreen, 요청 번호 복사).
 *  그 밖(로그인 전 404·403 등) = 인증 틀(AuthShell) 위 결과 화면(아이콘 타일 40 + 제목 24/700 + 설명 + [다시 시도][홈으로]).
 *
 * Vue 의 useError()/clearError({ redirect }) 대신: 오류는 prop error 로 받고(없으면 500 취급 — Vue 의 /error 직접 방문과 같다),
 * 지우기는 navigateTo(주소, { replace: true }).
 */
import { useEffect } from 'react'
import { useI18n } from '~/i18n'
import { navigateTo, useRoute } from '~/lib/router'
import { useHead } from '~/lib/head'
import { useSiteConfig, fetchAppConfig } from '~/composables/useSiteConfig'
import { useAuth } from '~/composables/useAuth'
import { useBreadcrumb } from '~/composables/useBreadcrumb'
import { openPalette } from '~/composables/useShell'
import { DefaultLayout } from '~/layouts/default'
import { UiButton } from '~/components/ui/Button'
import { UiKeycap } from '~/components/ui/Keycap'
import { AuthServerErrorScreen } from './ServerErrorScreen'
import { AuthShell } from './AuthShell'
import { AuthHeading } from './AuthHeading'

export interface AuthErrorScreenProps {
  /** 전역 오류(라우터 errorElement·404)가 넘기는 오류. 없으면 500 취급 */
  error?: { statusCode?: number; message?: string; url?: string; data?: unknown } | null
}

export function AuthErrorScreen({ error }: AuthErrorScreenProps) {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  // 전역 오류 화면은 App 을 거치지 않을 수 있어 사이트 설정(이름·로고)이 비어 있을 수 있다 — 여기서 한 번 받는다(이미 받았으면 그냥 돌아온다)
  useEffect(() => { void fetchAppConfig() }, [])
  const { user } = useAuth()
  const route = useRoute()

  const err = error ?? null

  useHead({ title: `${t('common.error')} | ${appName}` })

  const statusCode: number = err?.statusCode ?? 500
  const inShell = !!user && statusCode === 404
  const isServerError = statusCode >= 500
  // 셸 안 404 의 상단바 = "워크스페이스 / (모듈 또는 홈) / 찾을 수 없음"(시안 S3)
  useBreadcrumb(inShell ? t('error.404.crumb') : '')

  const info = (() => {
    switch (statusCode) {
      case 404: return { title: t('error.404.title'), description: t('error.404.description') }
      case 500: return { title: t('error.500.title'), description: t('error.500.description') }
      default: return { title: t('error.default.title'), description: err?.message || t('error.default.description') }
    }
  })()
  const path = err?.url || route.fullPath
  // 기술 메시지는 기본 문구와 다를 때만 보조로(접어 둔 mono 상자)
  const detail = (() => {
    const m = err?.message
    if (!m || statusCode === 404 || m === info.description) return ''
    return m
  })()

  function goHome() { void navigateTo('/', { replace: true }) }
  function retry() { void navigateTo(route.fullPath, { replace: true }) }
  function search() { openPalette() }

  if (inShell) {
    return (
      <DefaultLayout>
        <div className="flex h-full min-h-[60dvh] items-center justify-center px-4">
          <div className="flex max-w-[420px] flex-col items-center gap-3 text-center">
            <span className="font-mono text-[13px] font-semibold text-muted-foreground">{statusCode}</span>
            <h1 className="text-[22px] font-bold text-foreground">{info.title}</h1>
            <p className="text-sm leading-relaxed text-muted-foreground [word-break:keep-all]">
              {info.description}
              <span className="block font-mono text-xs">{path}</span>
            </p>
            <div className="mt-1.5 flex gap-2">
              <UiButton onClick={goHome}>{t('common.goHome')}</UiButton>
              <UiButton variant="outline" className="gap-1.5" onClick={search}>
                {t('common.search')} <UiKeycap size={20}>Ctrl</UiKeycap><UiKeycap size={20}>K</UiKeycap>
              </UiButton>
            </div>
          </div>
        </div>
      </DefaultLayout>
    )
  }

  if (isServerError) return <AuthServerErrorScreen error={err} />

  return (
    <AuthShell>
      <AuthHeading
        icon={statusCode === 404 ? 'search' : 'alert-triangle'}
        tone={statusCode === 404 ? 'primary' : 'danger'}
        title={info.title}
      >
        <span className="mb-1 block font-mono text-xs font-semibold">{statusCode}</span>
        {info.description}
        {statusCode === 404 && <span className="mt-1 block break-all font-mono text-xs">{path}</span>}
      </AuthHeading>

      {detail && (
        <details className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none font-semibold">{t('authScreens.error.details')}</summary>
          <p className="mt-1.5 break-all font-mono">{detail}</p>
        </details>
      )}

      <div className="flex gap-2">
        {statusCode !== 404 && <UiButton size="lg" className="flex-1 px-4 font-semibold" onClick={retry}>{t('authScreens.error.retry')}</UiButton>}
        <UiButton
          variant={statusCode !== 404 ? 'outline' : 'default'}
          size="lg"
          className={statusCode !== 404 ? 'flex-1 px-4 bg-card' : 'flex-1 px-4 font-semibold'}
          onClick={goHome}
        >{t('authScreens.error.home')}</UiButton>
      </div>
    </AuthShell>
  )
}

export default AuthErrorScreen
