/**
 * 격리 브라우저 단독 앱 진입점(rbi.html — rbi 전용 출처에서만 서빙). 빌드: npm run build:rbi(vite.rbi.config.ts → dist-rbi/).
 * 워크스페이스 셸(라우터·레이아웃·모듈·플러그인 호스트·PWA)은 넣지 않는다 — 키트·토큰·i18n(rbi·common·ui 만)·미러 클라이언트뿐.
 * 다크 토큰 고정(rbi.html 의 class="dark"). 인라인 스크립트 없음(이 출처 CSP 가 script-src 'self').
 */
import { createRoot } from 'react-dom/client'
import '~/assets/css/main.css'
import { initI18n } from '~/i18n'
import { installMobileListener } from '~/composables/useIsMobile'
import { installViewportListener } from '~/composables/useViewport'
import { UiToast } from '~/components/ui/Toast'
import { UiDialogHost } from '~/components/ui/DialogHost'
import { RbiApp } from './RbiApp'

async function boot() {
  installMobileListener()
  installViewportListener()
  await initI18n()
  createRoot(document.getElementById('app')!).render(
    <>
      <RbiApp />
      <UiToast />
      <UiDialogHost />
    </>,
  )
}

void boot()
