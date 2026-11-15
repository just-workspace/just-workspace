// 네이티브 회의 브리지(useNativeMeeting — 토대 파일, 회의 모듈이 검증): 안드로이드 앱 웹뷰에서만 동작, 그 밖은 no-op
import { describe, it, expect, vi, afterEach } from 'vitest'
import { nativeMeetingApi, useNativeMeeting } from '~/composables/useNativeMeeting'

function fakeCapacitor(platform = 'android', plugins = [{ name: 'Meeting' }]) {
  const listeners: Array<(ev: any) => void> = []
  return {
    listeners,
    isNativePlatform: () => true,
    getPlatform: () => platform,
    PluginHeaders: plugins,
    addListener: vi.fn((_p: string, _e: string, fn: (ev: any) => void) => { listeners.push(fn) }),
    nativePromise: vi.fn(async () => ({})),
  }
}

afterEach(() => { delete (globalThis as any).Capacitor })

describe('useNativeMeeting', () => {
  it('브라우저(Capacitor 없음)에서는 아무것도 하지 않는다', async () => {
    expect(nativeMeetingApi.available()).toBe(false)
    await expect(nativeMeetingApi.start('t', true, () => {})).resolves.toBeUndefined()
    await expect(nativeMeetingApi.stop()).resolves.toBeUndefined()
  })

  it('iOS·플러그인 없음이면 쓰지 않는다', () => {
    ;(globalThis as any).Capacitor = fakeCapacitor('ios')
    expect(nativeMeetingApi.available()).toBe(false)
    ;(globalThis as any).Capacitor = fakeCapacitor('android', [])
    expect(nativeMeetingApi.available()).toBe(false)
  })

  it('안드로이드: start 는 리스너를 한 번만 달고, 이벤트는 마지막 start 쪽이 받는다 · stop 후엔 받지 않는다', async () => {
    const cap = fakeCapacitor()
    ;(globalThis as any).Capacitor = cap
    const api = useNativeMeeting()
    expect(api.available()).toBe(true)
    const a = vi.fn(); const b = vi.fn()
    await api.start('회의', true, a)
    await api.start('회의2', false, b)
    expect(cap.addListener).toHaveBeenCalledTimes(1)
    expect(cap.nativePromise).toHaveBeenCalledWith('Meeting', 'start', { title: '회의2', video: false })
    cap.listeners[0]({ type: 'hold' })
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledWith({ type: 'hold' })
    await api.stop()
    expect(cap.nativePromise).toHaveBeenLastCalledWith('Meeting', 'stop', {})
    cap.listeners[0]({ type: 'unhold' })
    expect(b).toHaveBeenCalledTimes(1)
  })
})
