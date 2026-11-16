/**
 * 진입점 — 앱 부팅(플러그인·i18n·color-mode).
 * 순서: 화면폭·화면 배율·컬러 모드 감시 → 현재 언어 메시지 로드 → 전역 노출(플러그인 호스트) → 라우터(첫 이동에서 사용자 정보 await)
 * StrictMode 는 사용하지 않는다 — 앱 수준 싱글턴(실시간 소켓·통화 세션)이 개발 모드 이중 실행으로 2회 열리는 것을 방지.
 */
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router/dom'
import { QueryClientProvider } from '@tanstack/react-query'
import '~/assets/css/main.css'
import { initI18n } from '~/i18n'
import { installMobileListener } from '~/composables/useIsMobile'
import { installViewportListener } from '~/composables/useViewport'
import { installColorModeListener } from '~/composables/useColorMode'
import { createAppRouter } from '~/router'
import { setAppRouter } from '~/lib/router'
import { queryClient } from '~/lib/query'
import { installBundledAppCleanup } from '~/lib/bundledApp'
import { installChunkReload } from '~/lib/chunkReload'
import { clearLegacyWebToken } from '~/lib/runtimeConfig'
import { installHostGlobals } from '~/plugins/hostGlobals'

async function boot() {
  installMobileListener()
  // 화면 배율(루트 zoom) — 첫 페인트부터 적용되도록 렌더 전에 설치
  installViewportListener()
  installColorModeListener()
  installBundledAppCleanup()
  // 재배포 후 이전 화면 청크 로드 실패 → 새로고침 1회
  installChunkReload()
  // 웹은 httpOnly 쿠키만 사용 — 이전 버전이 localStorage 에 남긴 세션값을 삭제한다(번들 앱은 유지)
  clearLegacyWebToken()
  installHostGlobals()
  await initI18n()
  const router = createAppRouter()
  setAppRouter(router)
  const el = document.getElementById('app')!
  createRoot(el).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

void boot()
