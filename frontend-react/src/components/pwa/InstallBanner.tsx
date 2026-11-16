/**
 * PWA 설치 안내 — 설치 가능하며 미설치 상태이면 오른쪽 아래에 카드 표시.
 */
import { useState } from 'react'
import { useI18n } from '~/i18n'
import { usePwa } from '~/composables/usePwa'

const DISMISS_KEY = 'pwa-install-dismissed'
function readDismissed(): boolean {
  try { return localStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
}

export function PwaInstallBanner() {
  const { canInstall, isInstalled, promptInstall } = usePwa()
  const { t } = useI18n()
  // 닫음 상태는 이 기기에 저장한다 — 과거에는 새로 불러올 때마다 다시 표시되었다
  const [dismissed, setDismissed] = useState(readDismissed)
  function dismiss() {
    setDismissed(true)
    try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* 현재 화면에만 적용 */ }
  }

  async function handleInstall() {
    await promptInstall()
  }

  if (!(canInstall && !isInstalled && !dismissed)) return null

  return (
    <div
      // 모바일은 하단 탭바(64 + safe-area) 위에 배치 — 바닥 16 에 두면 탭바 전체를 가렸다. 겹침 순서는 토큰(z-drawer)으로 지정.
      className="fixed bottom-[calc(72px+env(safe-area-inset-bottom))] left-4 right-4 sm:bottom-4 sm:left-auto sm:right-4 sm:w-80 z-drawer bg-card border rounded-lg shadow-lg p-4 flex items-start gap-3"
    >
      <div className="shrink-0 w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 text-primary">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{t('pwa.installTitle')}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{t('pwa.installDescription')}</p>
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={handleInstall}
            className="px-3 py-2 sm:py-1 min-h-9 sm:min-h-0 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {t('pwa.install')}
          </button>
          <button
            onClick={dismiss}
            className="px-3 py-2 sm:py-1 min-h-9 sm:min-h-0 text-xs font-medium rounded-md hover:bg-accent transition-colors text-muted-foreground"
          >
            {t('pwa.dismiss')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default PwaInstallBanner
