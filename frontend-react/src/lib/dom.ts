/**
 * Vue 지시자·내장 기능 대응 hook 모음.
 *
 * - useClickOutside(ref, handler)  ← v-click-outside (Vue plugins/click-outside.ts 와 같은 동작:
 *   마운트 다음 프레임부터 document click 을 듣고, 요소 밖 클릭이면 handler)
 * - useEventListener(target, type, handler)  ← onMounted/onBeforeUnmount 짝으로 붙이던 리스너
 * - useMounted()  ← onMounted 이후 true (Vue <ClientOnly> 가 필요한 드문 경우)
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
    // 마운트를 일으킨 같은 클릭을 잡지 않게 한 프레임 늦춘다
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
