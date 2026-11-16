/**
 * 모바일 앱(apps/mobile, Capacitor) 내에서 회의를 OS 에 "통화"로 등록한다.
 *  - 포그라운드 서비스: 화면이 꺼지거나 앱이 백그라운드로 전환되어도 회의가 유지된다
 *  - Telecom self-managed 통화: 일반 전화 수신 시 hold, 종료 시 unhold 가 전달된다
 * 네이티브 측은 apps/mobile/android/.../MeetingPlugin.java. 브라우저·데스크톱에서는 전부 no-op.
 *
 * 웹 앱은 @capacitor/core 를 번들하지 않는다. 앱 웹뷰가 주입한 window.Capacitor(native-bridge)의
 * nativePromise / addListener 로 직접 호출한다.
 *
 * React 상태가 없는 함수 집합이다 — 컴포넌트에서는 useNativeMeeting(), 컴포넌트 외부에서는 nativeMeetingApi(동일 객체).
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

/** 회의 입장 직후 호출. 이벤트는 마지막으로 start 를 호출한 측이 수신한다. */
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
    // 네이티브 연동이 실패해도 회의는 웹에서 유지된다
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

/** 컴포넌트 외부(useMeetings 세션)에서 사용하는 동일 함수 집합 */
export const nativeMeetingApi = { start, stop, available: () => !!bridge() }

export function useNativeMeeting() {
  return nativeMeetingApi
}
