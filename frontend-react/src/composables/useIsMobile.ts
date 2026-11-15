/**
 * 적응형 모바일 셸 — 화면폭 ≤767px 여부.
 * 리스너는 앱 전체에 1회만 등록한다.
 *
 * React: const isMobile = useIsMobile()   (boolean)
 * 컴포넌트 밖: isMobileNow()
 */
import { createStore, useStore } from 'zustand'

export const MOBILE_QUERY = '(max-width: 767px)'

export const isMobileStore = createStore<{ isMobile: boolean }>()(() => ({ isMobile: false }))

let _installed = false
/** main.tsx 가 첫 렌더 전에 부른다(ssr:false 와 같이 첫 렌더부터 맞는 값) */
export function installMobileListener() {
  if (_installed || typeof window === 'undefined' || !window.matchMedia) return
  _installed = true
  const mq = window.matchMedia(MOBILE_QUERY)
  isMobileStore.setState({ isMobile: mq.matches })
  mq.addEventListener('change', (e) => { isMobileStore.setState({ isMobile: e.matches }) })
}

export function isMobileNow(): boolean {
  return isMobileStore.getState().isMobile
}

export function useIsMobile(): boolean {
  return useStore(isMobileStore, s => s.isMobile)
}
