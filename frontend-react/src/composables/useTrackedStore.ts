/**
 * 큰 zustand store 를 "읽은 필드만" 구독하는 hook — Vue 의 반응성(읽은 ref 만 추적)과 같은 효과.
 *
 * useChat()·useMeetings() 처럼 멤버가 수십 개인 hook 이 store 전체를 구독하면 타이핑 이벤트 하나에
 * 상단바·레일까지 다시 그려진다. 이 hook 은 렌더(와 그 뒤)에서 실제로 읽은 키만 기억해 두고,
 * 그 키의 값이 바뀔 때만 다시 그린다. 한 번 읽은 키는 계속 구독한다(넉넉하게 — 놓치는 것보다 낫다).
 *
 * 사용: const s = useTrackedStore(chatStore); s.channels  ← 이 순간 'channels' 를 구독
 * hook 이 돌려주는 객체를 getter 로 만들어 `const { channels } = useChat()` 구조 분해에서도 추적된다.
 */
import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { StoreApi } from 'zustand'

export function useTrackedStore<T extends object>(store: StoreApi<T>): { state: T; track: <K extends keyof T>(k: K) => T[K] } {
  const keys = useRef<Set<keyof T>>(new Set())
  const seen = useRef<T>(store.getState())
  const version = useRef(0)

  const subscribe = useCallback((cb: () => void) => {
    const check = (s: T) => {
      for (const k of keys.current) {
        if (!Object.is(s[k], seen.current[k])) { version.current++; cb(); return }
      }
    }
    const unsub = store.subscribe(check)
    // 렌더와 구독 사이에 바뀐 것
    check(store.getState())
    return unsub
  }, [store])

  useSyncExternalStore(subscribe, () => version.current, () => version.current)

  const state = store.getState()
  seen.current = state
  const track = <K extends keyof T>(k: K): T[K] => {
    keys.current.add(k)
    return state[k]
  }
  return { state, track }
}
