/**
 * DOM hook 모음.
 *
 * - useClickOutside(ref, handler)  ← 외부 클릭 감지(
 *   마운트 다음 프레임부터 document click 을 수신하고, 요소 외부 클릭이면 handler 호출)
 * - useEventListener(target, type, handler)  ← 마운트·언마운트에 맞춰 등록·해제하는 리스너
 * - useMounted()  ← 마운트 이후 true (클라이언트에서만 렌더링해야 하는 드문 경우)
 */
import { useEffect, useRef, useState, type RefObject } from 'react'

export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  handler: (e: MouseEvent) => void,
  enabled = true,
) {
  const h = useRef(handler)
  h.current = handler
  useEffect(() => {
    if (!enabled) return
    const onClick = (e: MouseEvent) => {
      const el = ref.current
      if (el && !el.contains(e.target as Node)) h.current(e)
    }
    // 마운트를 유발한 동일 클릭을 수신하지 않도록 1프레임 지연한다
    const raf = requestAnimationFrame(() => document.addEventListener('click', onClick))
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('click', onClick)
    }
  }, [ref, enabled])
}

export function useEventListener<K extends keyof WindowEventMap>(
  target: Window | Document | HTMLElement | null | undefined,
  type: K | string,
  handler: (e: WindowEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
) {
  const h = useRef(handler)
  h.current = handler
  useEffect(() => {
    if (!target) return
    const fn = (e: Event) => h.current(e as WindowEventMap[K])
    target.addEventListener(type, fn, options)
    return () => target.removeEventListener(type, fn, options)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, type])
}

export function useMounted(): boolean {
  const [m, setM] = useState(false)
  useEffect(() => setM(true), [])
  return m
}
