/**
 * 대형 zustand store 를 "읽은 필드만" 구독하는 hook.
 *
 * useChat()·useMeetings() 처럼 멤버가 수십 개인 hook 이 store 전체를 구독하면 타이핑 이벤트 하나에
 * 상단바·레일까지 재렌더링된다. 본 hook 은 렌더(및 그 이후)에서 실제로 읽은 키만 기록하고,
 * 해당 키의 값이 변경될 때만 재렌더링한다. 한 번 읽은 키는 계속 구독한다(과다 구독이 누락보다 안전하다).
 *
 * 사용: const s = useTrackedStore(chatStore); s.channels  ← 이 시점에 'channels' 를 구독
 * hook 이 반환하는 객체를 getter 로 구성하므로 `const { channels } = useChat()` 구조 분해에서도 추적된다.
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
    // 렌더와 구독 사이에 변경된 항목
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
