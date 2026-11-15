/**
 * PWA — 설치 안내 + 푸시 구독.
 *
 * React: const { canInstall, isInstalled, pushSupported, pushSubscribed, init, promptInstall, subscribePush, ... } = usePwa()
 * 컴포넌트 밖: pwaStore.getState(), subscribePush()
 */
import { createStore, useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { $fetch } from '~/lib/api'
import { navigateTo } from '~/lib/router'

interface PwaState {
  canInstall: boolean
  isInstalled: boolean
  pushSupported: boolean
  pushSubscribed: boolean
}

export const pwaStore = createStore<PwaState>()(() => ({
  canInstall: false,
  isInstalled: false,
  pushSupported: false,
  pushSubscribed: false,
}))

let installPromptEvent: any = null

/** 푸시 알림을 눌렀을 때 서비스 워커(public/push-sw.js)가 보내는 이동 주소 — 같은 출처 앱 경로만 받는다 */
export function pushTargetPath(url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || url.charCodeAt(1) === 92 /* 역슬래시 — 브라우저가 // 로 읽는다 */ || url.startsWith('/api/')) return null
  return url
}

let _inited = false

export function initPwa() {
  if (typeof window === 'undefined') return
  // App.tsx 와 대시보드가 둘 다 부른다 — 리스너는 한 번만
  if (_inited) return
  _inited = true

  // 푸시 알림을 누르면 서비스 워커가 열린 창에 이동을 부탁한다 — 새로 불러오지 않고 라우터로 옮긴다
  try {
    navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
      const d = e.data as { type?: unknown; url?: unknown } | null
      if (!d || d.type !== 'jw:navigate') return
      const to = pushTargetPath(d.url)
      if (to) void navigateTo(to)
    })
  } catch { /* 서비스 워커 없음 */ }

  // Detect if already installed (standalone mode)
  pwaStore.setState({
    isInstalled: window.matchMedia('(display-mode: standalone)').matches
      || (navigator as unknown as { standalone?: boolean }).standalone === true,
  })

  // Listen for install prompt
  window.addEventListener('beforeinstallprompt', (e: Event) => {
    e.preventDefault()
    installPromptEvent = e
    pwaStore.setState({ canInstall: true })
  })

  // Detect successful install
  window.addEventListener('appinstalled', () => {
    installPromptEvent = null
    pwaStore.setState({ canInstall: false, isInstalled: true })
  })

  // Check push support
  pwaStore.setState({ pushSupported: 'PushManager' in window && 'serviceWorker' in navigator })
}

export async function promptInstall(): Promise<boolean> {
  if (!installPromptEvent) return false
  installPromptEvent.prompt()
  const { outcome } = await installPromptEvent.userChoice
  installPromptEvent = null
  pwaStore.setState({ canInstall: false })
  return outcome === 'accepted'
}

export async function subscribePush(): Promise<boolean> {
  if (!pwaStore.getState().pushSupported) return false
  try {
    const registration = await navigator.serviceWorker.ready

    // Get VAPID public key from server
    const { vapid_public_key } = await $fetch<{ vapid_public_key: string }>('/api/push/vapid-key')
    if (!vapid_public_key) return false

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapid_public_key),
    })

    // Send subscription to server
    await $fetch('/api/push/subscribe', { method: 'POST', body: subscription.toJSON() })

    pwaStore.setState({ pushSubscribed: true })
    return true
  } catch (e) {
    console.error('Push subscription failed:', e)
    return false
  }
}

export async function unsubscribePush(): Promise<boolean> {
  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    if (subscription) {
      await subscription.unsubscribe()
      await $fetch('/api/push/unsubscribe', { method: 'POST', body: subscription.toJSON() })
    }
    pwaStore.setState({ pushSubscribed: false })
    return true
  } catch (e) {
    console.error('Push unsubscribe failed:', e)
    return false
  }
}

/**
 * 로그아웃 직전에 부른다 — 이 브라우저의 푸시 구독을 서버(아직 로그인 상태일 때)와 브라우저 양쪽에서 푼다.
 * 안 풀면 로그아웃한 사람의 알림(제목·본문)이 이 브라우저에 계속 뜬다(공용 PC).
 * 서비스 워커가 없거나 느려도 로그아웃을 붙잡지 않게 길어야 2초만 기다리고, 실패는 삼킨다.
 */
export async function releasePushOnLogout(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  const work = (async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    const subscription = await registration?.pushManager?.getSubscription()
    if (!subscription) return
    await $fetch('/api/push/unsubscribe', { method: 'POST', body: subscription.toJSON() }).catch(() => {})
    await subscription.unsubscribe().catch(() => false)
    pwaStore.setState({ pushSubscribed: false })
  })().catch(() => {})
  await Promise.race([work, new Promise<void>(r => setTimeout(r, 2000))])
}

export async function checkPushSubscription() {
  if (!pwaStore.getState().pushSupported) return
  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    pwaStore.setState({ pushSubscribed: !!subscription })
  } catch {
    pwaStore.setState({ pushSubscribed: false })
  }
}

export function usePwa() {
  const s = useStore(pwaStore, useShallow((x: PwaState) => x))
  return {
    ...s,
    init: initPwa,
    promptInstall,
    subscribePush,
    unsubscribePush,
    checkPushSubscription,
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(new ArrayBuffer(rawData.length))
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i)
  return outputArray
}
