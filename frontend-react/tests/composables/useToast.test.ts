import { describe, it, expect, vi, beforeEach } from 'vitest'

import { toastStore, addToast, toast, removeToast } from '~/composables/useToast'

// React 판 useToast 는 hook 이라, 테스트는 같은 store 를 직접 읽는다(Vue 판 toasts.value 와 같은 값).
const useToast = () => ({ toasts: { get value() { return toastStore.getState().toasts } }, addToast, toast, removeToast })

describe('useToast', () => {
  beforeEach(() => {
    // Clear all toasts between tests
    const { toasts, removeToast } = useToast()
    toasts.value.forEach(t => removeToast(t.id))
  })

  it('addToast adds a toast to the queue', () => {
    const { toasts, addToast } = useToast()
    const before = toasts.value.length

    addToast('success', 'Test message', 0) // duration 0 = no auto-dismiss

    expect(toasts.value.length).toBe(before + 1)
    expect(toasts.value[toasts.value.length - 1].type).toBe('success')
    expect(toasts.value[toasts.value.length - 1].message).toBe('Test message')
  })

  it('removeToast removes a specific toast from the queue', () => {
    const { toasts, addToast, removeToast } = useToast()

    addToast('info', 'To be removed', 0)
    const toastId = toasts.value[toasts.value.length - 1].id

    removeToast(toastId)

    const found = toasts.value.find(t => t.id === toastId)
    expect(found).toBeUndefined()
  })

  it('auto-dismisses toast after timeout', () => {
    vi.useFakeTimers()

    const { toasts, addToast } = useToast()
    addToast('warning', 'Temporary', 3000)

    const toastId = toasts.value[toasts.value.length - 1].id

    // Toast should still exist before timeout
    expect(toasts.value.find(t => t.id === toastId)).toBeDefined()

    // Advance time past the duration
    vi.advanceTimersByTime(3000)

    // Toast should be removed after timeout
    expect(toasts.value.find(t => t.id === toastId)).toBeUndefined()

    vi.useRealTimers()
  })
  it('같은 오류가 짧은 시간에 반복되면 하나로 합치고 횟수를 센다', () => {
    vi.useFakeTimers()
    const { toasts, addToast } = useToast()
    const id1 = addToast('error', '서버에 연결할 수 없습니다')
    vi.advanceTimersByTime(1000)
    const id2 = addToast('error', '서버에 연결할 수 없습니다')
    addToast('error', '서버에 연결할 수 없습니다')
    expect(id2).toBe(id1)
    const same = toasts.value.filter(t => t.message === '서버에 연결할 수 없습니다')
    expect(same.length).toBe(1)
    expect(same[0].count).toBe(3)
    // 다른 내용·다른 종류는 따로 쌓인다
    addToast('error', '다른 오류')
    addToast('success', '서버에 연결할 수 없습니다', 0)
    expect(toasts.value.length).toBe(3)
    // 시간 창이 지나면 새 토스트
    vi.advanceTimersByTime(11_000)
    const id3 = addToast('error', '서버에 연결할 수 없습니다')
    expect(id3).not.toBe(id1)
    vi.useRealTimers()
  })

  it('합쳐진 자동 닫힘 토스트는 타이머를 다시 잰다', () => {
    vi.useFakeTimers()
    const { toasts, addToast } = useToast()
    const id = addToast('error', '잠깐 오류', 3000)
    vi.advanceTimersByTime(2000)
    addToast('error', '잠깐 오류', 3000)
    vi.advanceTimersByTime(2000)
    expect(toasts.value.find(t => t.id === id)).toBeDefined()
    vi.advanceTimersByTime(1500)
    expect(toasts.value.find(t => t.id === id)).toBeUndefined()
    vi.useRealTimers()
  })
})
