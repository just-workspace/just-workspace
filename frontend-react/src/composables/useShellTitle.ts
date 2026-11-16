/**
 * 호스트 상단바 제목 재정의 — 플러그인 페이지가 현재 표시 중인 대상(문서·프로젝트 이름 등)을 상단바 제목으로 지정한다.
 * 상단바 확장 영역(useShellHeaderActions)과 동일한 구조: 동일 상태를 두 경로로 제공한다.
 *   ① 전역:   window.__WS_SHELL__.setTitle(title | null, owner?) → 해제 함수
 *             window.__WS_SHELL__.clearTitle(owner?)
 *   ② 주입:   pluginApi.setTitle(...) / .clearTitle(...)  (pages/p/[id] 가 전달한다)
 * 빈 문자열·null·문자열이 아닌 값 = 해당 owner 의 제목 해제(호스트 기본 제목으로 원복).
 * 플러그인 페이지를 이탈하거나 다른 플러그인으로 전환하면 호스트가 전부 제거한다(해제를 누락해도 잔존하지 않음).
 *
 * 렌더(LayoutTopBar): 데스크톱 = 3단 경로의 마지막 칸(워크스페이스 / 모듈 / 제목), 모바일 = 머리 제목 한 줄.
 * 페이지가 useBreadcrumb 로 지정한 위치보다 우선한다. 여러 owner 가 지정하면 마지막에 지정한 것이 표시된다.
 *
 * React(상단바): const title = useShellTitle()   — 없으면 ''
 * 테스트·외부: getShellTitle()
 */
import { createStore, useStore } from 'zustand'

/** 과도하게 긴 제목은 절단한다(상단바는 한 줄 말줄임이나 aria·툴팁까지 무제한일 필요는 없다) */
export const MAX_TITLE_LENGTH = 200
const DEFAULT_OWNER = 'plugin'

/** 등록 순서(마지막 항목이 표시됨). 동일 owner 를 재지정하면 맨 뒤로 이동 */
export const shellTitleStore = createStore<{ entries: { owner: string; title: string }[] }>()(() => ({ entries: [] }))

function clean(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH)
}

/** 제목 지정(동일 owner 는 교체). null·'' 이면 해제. 반환된 함수를 호출하면 해제 */
export function setTitle(title: string | null, owner: string = DEFAULT_OWNER): () => void {
  const key = String(owner || DEFAULT_OWNER)
  const text = clean(title)
  if (!text) {
    clearTitle(key)
  } else {
    const rest = shellTitleStore.getState().entries.filter(e => e.owner !== key)
    shellTitleStore.setState({ entries: [...rest, { owner: key, title: text }] })
  }
  return () => clearTitle(key)
}

/** 해당 owner 의 제목 해제. owner 생략 = 기본 owner('plugin') */
export function clearTitle(owner: string = DEFAULT_OWNER) {
  const key = String(owner || DEFAULT_OWNER)
  const entries = shellTitleStore.getState().entries
  if (!entries.some(e => e.owner === key)) return
  shellTitleStore.setState({ entries: entries.filter(e => e.owner !== key) })
}

/** 전체 해제(플러그인 페이지 이탈 시 호스트가 호출한다) */
export function clearAllTitles() {
  if (shellTitleStore.getState().entries.length) shellTitleStore.setState({ entries: [] })
}

/** 현재 표시할 제목(컴포넌트 외부). 없으면 '' */
export function getShellTitle(): string {
  return shellTitleStore.getState().entries.at(-1)?.title ?? ''
}

/** 상단바용: 현재 표시할 제목. 없으면 '' */
export function useShellTitle(): string {
  return useStore(shellTitleStore, s => s.entries.at(-1)?.title ?? '')
}
