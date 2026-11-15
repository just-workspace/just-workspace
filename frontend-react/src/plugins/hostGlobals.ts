/**
 * 플러그인 번들이 쓰는 호스트 전역 — Vue 판 plugins/plugin-runtime.client.ts 대응.
 *   window.__REACT__ / window.__REACT_DOM__ : v2(React) 플러그인이 external 로 두고 쓰는 호스트 React
 *   window.__WS_SHELL__                     : 상단바 확장 자리(버튼·칩) + 제목 덮어쓰기(setTitle) — 기존 API 에 멤버만 더함
 *   window.__WS_UI__                        : 호스트 UI 키트(Ui* 부품 + useToast·useDialog) — v2 플러그인이 '@jw/ui' 로 쓴다(plugins/uiKit)
 * v1(Vue) 플러그인용 window.__VUE__ 는 v1 플러그인을 열 때만 Vue 런타임을 지연 로드해 붙인다(plugins/pluginHost).
 */
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import { wsShellApi } from '~/composables/useShellHeaderActions'
import { wsUiKit } from './uiKit'

declare global {
  interface Window {
    __REACT__?: typeof React
    __REACT_DOM__?: typeof ReactDOM & typeof ReactDOMClient
    __WS_SHELL__?: typeof wsShellApi
    __WS_UI__?: typeof wsUiKit
    __VUE__?: unknown
  }
}

export function installHostGlobals() {
  if (typeof window === 'undefined') return
  window.__REACT__ = React
  window.__REACT_DOM__ = { ...ReactDOM, ...ReactDOMClient }
  // 셸 확장 API(상단바 버튼·칩 등록 · 제목) — docs/plugin-frontend.md "상단바 확장 자리"·"상단바 제목"
  window.__WS_SHELL__ = wsShellApi
  // 호스트 UI 키트 — docs/plugin-v2.md "7. 호스트 UI 키트"
  window.__WS_UI__ = wsUiKit
}
