import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useCapsLock } from '~/composables/useCapsLock'

// useCapsLock 은 hook 이므로 renderHook 으로 호출하고 result.current.capsLock 을 확인한다.
function key(caps: boolean): KeyboardEvent {
  return { getModifierState: (k: string) => k === 'CapsLock' && caps } as unknown as KeyboardEvent
}

describe('useCapsLock', () => {
  it('키 입력의 CapsLock 상태를 따라간다', () => {
    const { result } = renderHook(() => useCapsLock())
    expect(result.current.capsLock).toBe(false)
    act(() => result.current.onKey(key(true)))
    expect(result.current.capsLock).toBe(true)
    act(() => result.current.onKey(key(false)))
    expect(result.current.capsLock).toBe(false)
  })

  it('reset 하면 힌트를 내린다(포커스 이탈)', () => {
    const { result } = renderHook(() => useCapsLock())
    act(() => result.current.onKey(key(true)))
    act(() => result.current.reset())
    expect(result.current.capsLock).toBe(false)
  })

  it('getModifierState 가 없는 이벤트는 무시한다', () => {
    const { result } = renderHook(() => useCapsLock())
    act(() => result.current.onKey({} as KeyboardEvent))
    expect(result.current.capsLock).toBe(false)
  })
})
