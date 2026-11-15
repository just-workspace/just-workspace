/*
 * 웹푸시 표시 — 서비스 워커(workbox generateSW)가 importScripts 로 불러온다(vite.config.ts).
 *
 * 서버(backend/app/push/router.py send_push)가 보내는 payload: {"title": "...", "body": "...", "url": "/..."}.
 * 이 파일이 없던 동안에는 푸시가 도착해도 아무것도 표시하지 못했다(브라우저 기본 "백그라운드에서 업데이트됨"만).
 *
 * 누르면 열려 있는 창을 앞으로 가져와 그 주소로 옮기고, 없으면 새 창을 연다.
 * 이동 주소는 같은 출처 경로(/…)만 — 그 밖(다른 출처·//host·/api/…)은 홈으로.
 */
/* eslint-disable no-restricted-globals */
function jwSafePath(url) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || url.charCodeAt(1) === 92 /* 역슬래시 — 브라우저가 // 로 읽는다 */) return '/'
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
    // 같은 곳으로 가는 알림은 하나로 겹친다(채널 하나에 멘션이 연달아 와도 알림함이 쌓이지 않게) — 다시 울리기는 한다
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
    // 같은 출처라도 앱(SPA)이 아닌 탭(Git·문서 편집기·로그인 흐름)은 jw:navigate 를 듣지 않는다 — 그런 탭만 있으면 새 창으로 연다
    const notApp = /^\/(git|onlyoffice|oauth|sso|dav|api)(\/|$)/
    const own = all.filter((c) => { try { const u = new URL(c.url); return u.origin === self.location.origin && !notApp.test(u.pathname) } catch (e) { return false } })
    if (own.length) {
      const c = own.find((x) => x.focused) || own[0]
      try { await c.focus() } catch (e) { /* 포커스 불가 — 이동만 */ }
      // 새로 불러오지 않고 앱 라우터로 옮긴다(통화·작성 중인 글이 끊기지 않게). 페이지가 이 메시지를 듣는다(usePwa.ts)
      c.postMessage({ type: 'jw:navigate', url })
      return
    }
    await self.clients.openWindow(url)
  })())
})

// 예전 판이 쓰던 /api 응답 캐시(사용자 구분 없음)는 이제 쓰지 않는다 — 남은 것을 지운다
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.delete('api-cache').catch(() => false))
})
