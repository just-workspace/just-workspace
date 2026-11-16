/*
 * 웹푸시 표시 — 서비스 워커(workbox generateSW)가 importScripts 로 로드한다(vite.config.ts).
 *
 * 서버(backend/app/push/router.py send_push)가 송신하는 payload: {"title": "...", "body": "...", "url": "/..."}.
 * 본 파일이 없던 기간에는 푸시가 도착해도 내용을 표시하지 못했다(브라우저 기본 "백그라운드에서 업데이트됨"만 표시).
 *
 * 클릭 시 열려 있는 창에 포커스를 주고 해당 주소로 이동하며, 창이 없으면 새 창을 연다.
 * 이동 주소는 동일 출처 경로(/…)만 허용한다 — 그 외(타 출처·//host·/api/…)는 홈으로 이동한다.
 */
/* eslint-disable no-restricted-globals */
function jwSafePath(url) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || url.charCodeAt(1) === 92 /* 역슬래시 — 브라우저가 // 로 해석한다 */) return '/'
  if (url.startsWith('/api/')) return '/'
  try {
    const u = new URL(url, self.location.origin)
    return u.origin === self.location.origin ? u.pathname + u.search + u.hash : '/'
  } catch (e) {
    return '/'
  }
}

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch (e) {
    try { data = { body: event.data.text() } } catch (e2) { data = {} }
  }
  const title = (data && typeof data.title === 'string' && data.title) || self.registration.scope.replace(/^https?:\/\//, '').replace(/\/$/, '')
  const url = jwSafePath(data && data.url)
  event.waitUntil(self.registration.showNotification(title, {
    body: (data && typeof data.body === 'string' && data.body) || '',
    icon: '/icon.svg',
    // 동일 주소로 이동하는 알림은 하나로 병합한다(한 채널에 멘션이 연속 수신되어도 알림함에 누적되지 않도록) — 재알림은 수행한다
    tag: 'jw:' + url,
    renotify: true,
    data: { url },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = jwSafePath(event.notification.data && event.notification.data.url)
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    // 동일 출처라도 앱(SPA)이 아닌 탭(Git·문서 편집기·로그인 흐름)은 jw:navigate 를 수신하지 않는다 — 그런 탭만 있으면 새 창으로 연다
    const notApp = /^\/(git|onlyoffice|oauth|sso|dav|api)(\/|$)/
    const own = all.filter((c) => { try { const u = new URL(c.url); return u.origin === self.location.origin && !notApp.test(u.pathname) } catch (e) { return false } })
    if (own.length) {
      const c = own.find((x) => x.focused) || own[0]
      try { await c.focus() } catch (e) { /* 포커스 불가 — 이동만 수행 */ }
      // 페이지를 다시 로드하지 않고 앱 라우터로 이동한다(통화·작성 중인 글이 중단되지 않도록). 페이지가 본 메시지를 수신한다(usePwa.ts)
      c.postMessage({ type: 'jw:navigate', url })
      return
    }
    await self.clients.openWindow(url)
  })())
})

// 이전 버전이 사용하던 /api 응답 캐시(사용자 구분 없음)는 더 이상 사용하지 않는다 — 잔존분을 삭제한다
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.delete('api-cache').catch(() => false))
})
