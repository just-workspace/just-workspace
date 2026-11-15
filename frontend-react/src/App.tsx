/**
 * 앱 루트 — Vue 판 app.vue 대응. 라우터 루트 라우트의 element 로 쓰인다.
 * - 런타임 브랜딩: /api/health 를 읽고 브랜드 색을 accent(primary/ring)에만 입힌다 · 기본 테마 · 동적 파비콘
 * - 제목 기본값 = 런타임 브랜딩 이름(화면이 useHead 로 정하면 그쪽이 이긴다)
 * - 전역 오류 경계: 렌더 오류를 토스트로 알리고 콘솔에 남긴다(Vue onErrorCaptured)
 * - 루트에 늘 떠 있는 것: 토스트 · 다이얼로그 · (로그인 중) 떠 있는 메일 작성 창 호스트
 */
import { useEffect } from 'react'
import { Outlet } from 'react-router'
import { useSiteConfig, fetchAppConfig } from '~/composables/useSiteConfig'
import { useAuth } from '~/composables/useAuth'
import { initPwa } from '~/composables/usePwa'
import { useHead } from '~/lib/head'
import { brandThemeCss } from '~/lib/brandColor'
import { AppErrorBoundary } from '~/components/AppErrorBoundary'
import { UiToast } from '~/components/ui/Toast'
import { UiDialogHost } from '~/components/ui/DialogHost'
import { MailComposeHost } from '~/components/mail/MailComposeHost'
// 로그아웃(user → null) 때 떠 있는 메일 작성 창 목록을 비우는 구독을 앱 시작 때 건다(Vue app.vue 의 watch(user) → useMailCompose().reset())
import '~/composables/useMailCompose'

export { hexToHsl } from '~/lib/brandColor'

/**
 * 브랜드 색 주입 — Dashboard Dark 시안은 고정 중립 팔레트를 표면·텍스트·테두리에 쓴다.
 * 브랜드색은 accent(primary/ring)만 물들이고 나머지는 main.css 시안값을 유지한다.
 * 대비 자동 보정: 테마별로 card·background 위 4.5:1 이 되게 밝기만 조정, 버튼 글자는 흰/검 중 높은 쪽(lib/brandColor).
 */
export function applyBrandTheme(hex: string) {
  const css = brandThemeCss(hex)
  if (!css) return
  let style = document.getElementById('brand-theme') as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = 'brand-theme'
    document.head.appendChild(style)
  }
  style.textContent = css
}

export default function App() {
  const { brandColor, defaultTheme, favicon, appName } = useSiteConfig()
  const { user } = useAuth()

  // 제목을 정하지 않은 화면의 기본 제목 = 런타임 브랜딩 이름(빌드 때 이름 아님)
  useHead({ title: appName, link: favicon ? [{ rel: 'icon', href: favicon, key: 'dynamic-favicon' }] : [] })

  useEffect(() => {
    void fetchAppConfig()
    initPwa()
  }, [])

  useEffect(() => { applyBrandTheme(brandColor) }, [brandColor])

  // 첫 로드 기본 테마(사용자가 color-theme 를 직접 정한 적 없으면) — app.vue 와 같은 동작
  useEffect(() => {
    let userPref: string | null = null
    try { userPref = localStorage.getItem('color-theme') } catch { /* ignore */ }
    if (userPref) return
    if (defaultTheme === 'dark') document.documentElement.classList.add('dark')
    else if (defaultTheme === 'light') document.documentElement.classList.remove('dark')
    // 'system' — leave as-is (color-mode 가 처리)
  }, [defaultTheme])

  return (
    <>
      <AppErrorBoundary scope="app">
        <Outlet />
      </AppErrorBoundary>
      <UiToast />
      <UiDialogHost />
      {/* 떠 있는 메일 작성 창(데스크톱) — 화면·레이아웃을 옮겨도 쓰던 창이 살아 있게 루트에 둔다 */}
      {user && <MailComposeHost />}
    </>
  )
}
