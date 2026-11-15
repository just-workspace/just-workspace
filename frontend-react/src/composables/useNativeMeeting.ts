/**
 * 모바일 앱(apps/mobile, Capacitor) 안에서 회의를 OS 에 "통화"로 알린다. Vue 판 composables/useNativeMeeting.ts 그대로.
 *  - 포그라운드 서비스: 화면이 꺼지거나 앱을 내려도 회의가 유지된다
 *  - Telecom self-managed 통화: 일반 전화가 오면 hold, 끝나면 unhold 가 온다
 * 네이티브 쪽은 apps/mobile/android/.../MeetingPlugin.java. 브라우저·데스크톱에서는 전부 no-op.
 *
 * 웹 앱은 @capacitor/core 를 번들하지 않는다. 앱 웹뷰가 주입한 window.Capacitor(native-bridge)의
 * nativePromise / addListener 로 직접 부른다.
 *
 * React 상태가 없는 함수 묶음이다 — 컴포넌트에서는 useNativeMeeting(), 컴포넌트 밖에서는 nativeMeetingApi(같은 객체).
 */
export type NativeMeetingEvent = {
  type: 'hold' | 'unhold' | 'disconnect' | 'leave' | 'audioRoute' | 'telecomFailed' | 'serviceFailed'
  detail?: string
}

const PLUGIN = 'Meeting'
let handler: ((ev: NativeMeetingEvent) => void) | null = null
let listening = false

function bridge(): any | null {
  const cap = (globalThis as any).Capacitor
  if (!cap?.isNativePlatform?.() || cap.getPlatform?.() !== 'android') return null
  const headers: any[] = cap.PluginHeaders || []
  if (!headers.some((h) => h?.name === PLUGIN)) return null
  return cap
}

/** 회의 입장 직후. 이벤트는 마지막으로 start 한 쪽이 받는다. */
async function start(title: string, video: boolean, onEvent: (ev: NativeMeetingEvent) => void) {
  const cap = bridge()
  if (!cap) return
  handler = onEvent
  try {
    if (!listening) {
      listening = true
      cap.addListener(PLUGIN, 'meeting', (ev: NativeMeetingEvent) => handler?.(ev))
    }
    await cap.nativePromise(PLUGIN, 'start', { title, video })
  } catch (e) {
    // 네이티브 연동이 실패해도 회의는 웹에서 계속된다
    console.warn('[meet] native start 실패', e)
  }
}

/** 회의 퇴장 시 */
async function stop() {
  handler = null
  const cap = bridge()
  if (!cap) return
  try { await cap.nativePromise(PLUGIN, 'stop', {}) } catch { /* noop */ }
}

/** 컴포넌트 밖(useMeetings 세션)에서 쓰는 같은 묶음 */
export const nativeMeetingApi = { start, stop, available: () => !!bridge() }

export function useNativeMeeting() {
  return nativeMeetingApi
}
