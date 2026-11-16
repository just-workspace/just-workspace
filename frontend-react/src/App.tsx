/**
 * 앱 루트. 라우터 루트 라우트의 element 로 사용된다.
 * - 런타임 브랜딩: /api/health 를 조회하여 브랜드 색을 accent(primary/ring)에만 적용 · 기본 테마 · 동적 파비콘
 * - 제목 기본값 = 런타임 브랜딩 이름(화면이 useHead 로 지정하면 해당 값이 우선)
 * - 전역 오류 경계: 렌더 오류를 토스트로 표시하고 콘솔에 기록
 * - 루트에 상주하는 요소: 토스트 · 다이얼로그 · (로그인 상태) 플로팅 메일 작성 창 호스트
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
import { UpdateNoticeHost } from '~/components/layout/MaintenanceScreen'
// 로그아웃(user → null) 시 플로팅 메일 작성 창 목록을 초기화하는 구독을 앱 시작 시 등록한다
import '~/composables/useMailCompose'

export { hexToHsl } from '~/lib/brandColor'

/**
 * 브랜드 색 주입 — Dashboard Dark 시안은 고정 중립 팔레트를 표면·텍스트·테두리에 사용한다.
 * 브랜드 색은 accent(primary/ring)에만 적용하고 나머지는 main.css 시안값을 유지한다.
 * 대비 자동 보정: 테마별로 card·background 위 4.5:1 이 되도록 밝기만 조정하며, 버튼 글자는 흰색/검정 중 대비가 높은 쪽을 사용한다(lib/brandColor).
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

  // 제목을 지정하지 않은 화면의 기본 제목 = 런타임 브랜딩 이름(빌드 시점 이름 아님)
  useHead({ title: appName, link: favicon ? [{ rel: 'icon', href: favicon, key: 'dynamic-favicon' }] : [] })

  useEffect(() => {
    void fetchAppConfig()
    initPwa()
  }, [])

  useEffect(() => { applyBrandTheme(brandColor) }, [brandColor])

  // 최초 로드 시 기본 테마 적용(사용자가 color-theme 를 직접 지정한 적이 없는 경우)
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
      {/* 플로팅 메일 작성 창(데스크톱) — 화면·레이아웃 전환 시에도 작성 중인 창이 유지되도록 루트에 배치 */}
      {user && <MailComposeHost />}
      {/* 업데이트 사전 공지·점검 모드 — 점검 중에는 모든 화면 위에 점검 화면을 표시 */}
      <UpdateNoticeHost />
    </>
  )
}
