// vitest 공통 준비: i18n 메시지(ko) 로드 + DOM 정리 + 브라우저 API 보강(happy-dom 에 없는 것).
import { afterEach, beforeAll, vi } from 'vitest'
import { cleanup, configure } from '@testing-library/react'
import { initI18n } from '~/i18n'

if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

beforeAll(async () => {
  await initI18n('ko')
})

// findBy*/waitFor 기본 1초는 부하가 걸리면(병렬 워커·CI) 첫 동적 import(Vue 런타임·페이지 청크) 변환만으로
// 넘는다 — 실제로 AI 화면 모바일 목록·v1 플러그인 섬 테스트가 가끔 "Unable to find …" 로 떨어졌다.
// 기다림 상한만 넉넉히(조건이 맞으면 즉시 통과하므로 정상 실행 시간은 같다).
configure({ asyncUtilTimeout: 5000 })

afterEach(() => {
  cleanup()
  // 테스트가 도중에 실패해도 가짜 타이머·전역 대체(fetch 등)가 다음 테스트로 새지 않게
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
