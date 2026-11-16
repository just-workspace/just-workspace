/**
 * 화면 꺼짐 방지.
 * 회의 중 조작이 없으면 모바일 기기가 화면을 끄며, 이 경우 브라우저가 비디오 업링크를 축소하거나 중단한다.
 *
 * Wake Lock 은 탭이 비가시 상태가 되면 시스템이 해제하므로 visible 로 복귀할 때
 * 재획득해야 한다. 미지원 브라우저(iOS 16 이전, Firefox)에서는 no-op 으로 처리한다.
 *
 * React: createWakeLock() 은 수명을 직접 관리하는 객체이다(dispose 로 정리).
 *   useWakeLock() 은 컴포넌트 수명에 연동된 버전이다(언마운트 시 dispose).
 *   회의 세션(useMeetings)은 앱 수준이므로 createWakeLock() 을 1회 생성하여 계속 사용한다.
 */
import { useEffect, useState } from 'react'

export interface WakeLockHandle {
  request: () => Promise<void>
  release: () => Promise<void>
  supported: () => boolean
  /** 문서 리스너 해제 및 잠금 해제 */
  dispose: () => void
}

export function createWakeLock(): WakeLockHandle {
  let sentinel: any = null
  let wanted = false

  const supported = () =>
    'wakeLock' in navigator && typeof (navigator as any).wakeLock?.request === 'function'

  async function acquire() {
    if (!supported() || sentinel) return
    try {
      sentinel = await (navigator as any).wakeLock.request('screen')
      sentinel.addEventListener?.('release', () => { sentinel = null })
    } catch {
      // 배터리 절약 모드 등으로 거부될 수 있음. 회의 차단 사유는 아님.
      sentinel = null
    }
  }

  async function request() {
    wanted = true
    await acquire()
  }

  async function release() {
    wanted = false
    try { await sentinel?.release() } catch { /* noop */ }
    sentinel = null
  }

  function onVisibility() {
    if (wanted && document.visibilityState === 'visible') void acquire()
  }

  document.addEventListener('visibilitychange', onVisibility)
  const dispose = () => {
    document.removeEventListener('visibilitychange', onVisibility)
    void release()
  }

  return { request, release, supported, dispose }
}

export function useWakeLock(): Omit<WakeLockHandle, 'dispose'> {
  const [handle] = useState(createWakeLock)
  useEffect(() => () => handle.dispose(), [handle])
  return { request: handle.request, release: handle.release, supported: handle.supported }
}
