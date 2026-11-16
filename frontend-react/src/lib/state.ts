/**
 * 키로 공유하는 전역 상태 — `useSharedState(key, init)`.
 *
 * 사용: const [open, setOpen] = useSharedState<boolean>('mobile-detail-open', () => false);  setOpen(true)
 * 컴포넌트 외부: getSharedState('mobile-detail-open') / setSharedState('mobile-detail-open', true)
 *
 * 동일 키를 사용하는 모든 컴포넌트가 동일 값을 참조한다(모듈 싱글턴). 신규 전역 상태는 가급적
 * 이름 있는 zustand store(`xxxStore`)로 생성하고, 본 함수는 키 하나로 값만 공유하는 경우에 사용한다.
 */
import { useCallback } from 'react'
import { create } from 'zustand'

type Bag = { values: Record<string, unknown> }
const bag = create<Bag>(() => ({ values: {} }))

function ensure<T>(key: string, init?: () => T): T {
  const cur = bag.getState().values
  if (!(key in cur) && init) {
    const v = init()
    bag.setState({ values: { ...cur, [key]: v } })
    return v
  }
  return cur[key] as T
}

export function getSharedState<T>(key: string, init?: () => T): T {
  return ensure(key, init)
}

export function setSharedState<T>(key: string, value: T | ((prev: T) => T)) {
  const cur = bag.getState().values
  const next = typeof value === 'function' ? (value as (p: T) => T)(cur[key] as T) : value
  if (Object.is(cur[key], next)) return
  bag.setState({ values: { ...cur, [key]: next } })
}

/** 테스트용: 모든 키 초기화 */
export function resetSharedState() {
  bag.setState({ values: {} })
}

export function useSharedState<T>(key: string, init?: () => T): [T, (v: T | ((prev: T) => T)) => void] {
  // 첫 렌더 전에 초기값을 설정한다(렌더 중 setState 경고를 피하기 위해 store 에 직접 기록 — 구독 전이므로 안전)
  if (!(key in bag.getState().values) && init) {
    bag.getState().values[key] = init()
  }
  const value = bag(s => s.values[key]) as T
  const set = useCallback((v: T | ((prev: T) => T)) => setSharedState<T>(key, v), [key])
  return [value, set]
}
