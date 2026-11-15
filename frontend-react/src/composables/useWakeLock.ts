/**
 * 화면 꺼짐 방지. Vue 판 composables/useWakeLock.ts 그대로.
 * 회의 중에 손을 안 대면 모바일이 화면을 끄고, 그러면 브라우저가 비디오 업링크를 줄이거나 아예 멈춘다.
 *
 * Wake Lock 은 탭이 보이지 않으면 시스템이 풀어 버리므로 visible 로 돌아올 때
 * 다시 잡아야 한다. 미지원 브라우저(iOS 16 이전, Firefox)에서는 조용히 no-op.
 *
 * React: createWakeLock() 은 수명을 직접 쥐는 객체(dispose 로 정리 — Vue 의 onScopeDispose 자리).
 *   useWakeLock() 은 컴포넌트 수명에 묶인 판(언마운트 때 dispose).
 *   회의 세션(useMeetings)은 앱 수준이라 createWakeLock() 을 한 번 만들어 계속 쓴다(Vue 의 떼어 낸 effectScope).
 */
import { useEffect, useState } from 'react'

export interface WakeLockHandle {
  request: () => Promise<void>
  release: () => Promise<void>
  supported: () => boolean
  /** 문서 리스너를 떼고 잠금을 푼다(Vue 의 onScopeDispose) */
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
      // 배터리 절약 모드 등으로 거부될 수 있다. 회의를 막을 이유는 없다.
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
