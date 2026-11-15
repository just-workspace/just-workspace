/**
 * 설치 마법사 진입점(installer.html). 빌드: npm run build:installer(vite.installer.config.ts → dist-installer/).
 * 설치 관리자가 내주는 독립 화면이다 — 워크스페이스 서버가 아직 없을 때 뜨므로 워크스페이스 앱의 셸·라우터·API·저장소를 쓰지 않는다
 * (UI 키트 · 토큰 CSS · 아이콘 · i18n 엔진만 같이 쓴다. 빌드가 검사한다 — installer-bundle-guard.ts).
 * 다크가 기본(installer.html 의 class="dark"). 인라인 스크립트 없음.
 *
 * 가짜 서버: 개발 서버(npm run dev:installer)이거나 가짜 서버를 넣어 빌드했을 때, 주소에 `?mock=이름` 을 붙이면
 * 실제 API 대신 가짜 서버로 돈다(시나리오 이름은 api/mock.ts 머리의 표). 배포용 빌드에는 가짜 서버 코드가 실리지 않는다.
 */
import { createRoot } from 'react-dom/client'
import './installer.css'
import { createHttpApi } from './api/client'
import type { InstallerApi } from './api/types'
import { initInstallerI18n } from './i18n'
import { InstallerApp } from './InstallerApp'
import { takeTokenFromUrl, takeTokenStatusFromUrl } from './router'
import { applyTheme } from './shell/ShellTools'

declare const __INSTALLER_MOCK__: boolean

async function pickApi(): Promise<InstallerApi> {
  if (__INSTALLER_MOCK__) {
    const scenario = new URLSearchParams(window.location.search).get('mock')
    if (scenario != null) {
      const { createMockApi } = await import('./api/mock')
      return createMockApi(scenario, { delay: 350, stepMs: 1400 })
    }
  }
  return createHttpApi()
}

async function boot() {
  try {
    applyTheme(window.localStorage.getItem('jw-installer-theme') === 'light' ? 'light' : 'dark')
  } catch { /* 기억해 둔 값이 없으면 기본(다크) */ }
  const token = takeTokenFromUrl()
  const tokenStatus = takeTokenStatusFromUrl()
  const [api] = await Promise.all([pickApi(), initInstallerI18n()])
  createRoot(document.getElementById('app')!).render(<InstallerApp api={api} token={token} tokenStatus={tokenStatus} />)
}

void boot()
