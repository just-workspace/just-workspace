/**
 * 컬러 모드 — @nuxtjs/color-mode(classSuffix '') 와 같은 동작.
 * - 저장 키 `nuxt-color-mode`(localStorage) — 기존 사용자 설정을 그대로 읽는다.
 * - preference: 'system' | 'light' | 'dark' (기본 system) · value: 실제 적용값(system 이면 OS 설정, 판별 불가 light)
 * - <html> 에 value 이름의 class('dark' | 'light')를 단다. 첫 적용은 index.html 의 머리 스크립트가 한다(깜빡임 방지).
 *
 * React: const colorMode = useColorMode(); colorMode.preference; colorMode.value; colorMode.setPreference('dark')
 */
import { createStore, useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

export const COLOR_MODE_KEY = 'nuxt-color-mode'
export type ColorPreference = 'system' | 'light' | 'dark' | string

function systemScheme(): 'dark' | 'light' {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light'
  if (window.matchMedia('(prefers-color-scheme)').media !== 'not all') {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
    if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light'
  }
  return 'light'
}

function readPreference(): ColorPreference {
  try { return localStorage.getItem(COLOR_MODE_KEY) || 'system' } catch { return 'system' }
}

const resolveValue = (p: ColorPreference) => (p === 'system' ? systemScheme() : p)

export const colorModeStore = createStore<{ preference: ColorPreference; value: string }>()(() => {
  const preference = readPreference()
  return { preference, value: resolveValue(preference) }
})

function applyClass(prev: string | null, next: string) {
  if (typeof document === 'undefined') return
  const de = document.documentElement
  if (prev && prev !== next) de.classList.remove(prev)
  de.classList.add(next)
}

export function setColorPreference(p: ColorPreference) {
  const prev = colorModeStore.getState().value
  const value = resolveValue(p)
  try { localStorage.setItem(COLOR_MODE_KEY, p) } catch { /* ignore */ }
  colorModeStore.setState({ preference: p, value })
  applyClass(prev, value)
}

let _installed = false
/** OS 테마 변경 감시(preference=system 일 때) — main.tsx 에서 한 번 */
export function installColorModeListener() {
  if (_installed || typeof window === 'undefined' || !window.matchMedia) return
  _installed = true
  // 머리 스크립트가 이미 class 를 달았다. store 와 맞춘다.
  applyClass(null, colorModeStore.getState().value)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const { preference, value: prev } = colorModeStore.getState()
    if (preference !== 'system') return
    const value = systemScheme()
    colorModeStore.setState({ value })
    applyClass(prev, value)
  })
}

export function useColorMode() {
  const s = useStore(colorModeStore, useShallow((x: { preference: ColorPreference; value: string }) => x))
  return { preference: s.preference, value: s.value, setPreference: setColorPreference }
}
