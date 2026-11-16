/**
 * 번들 SPA 앱(Tauri/Capacitor) 분기 지점 — 부팅 부분.
 * apiBase 가 있는 빌드에서만: 잔존 서비스워커/캐시 정리(구 PWA SW 가 구번들을 precache 하여 영구 서빙하는 사고 방지).
 * (요청 측 분기 — /api·/oauth 를 apiBase 로 + Bearer — 는 lib/api.ts 가 담당한다.)
 */
import { isBundledApp } from '~/lib/runtimeConfig'

export function installBundledAppCleanup() {
  if (!isBundledApp()) return
  try {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {})
    }
    if (typeof caches !== 'undefined') {
      caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {})
    }
  } catch { /* ignore */ }
}
