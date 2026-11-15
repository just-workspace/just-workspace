/**
 * 호스트 상단바 제목 덮어쓰기 — 플러그인 페이지가 지금 보고 있는 것(문서·프로젝트 이름 등)을 상단바 제목으로 올린다.
 * 상단바 확장 자리(useShellHeaderActions)와 같은 구조: 같은 상태를 두 길로 연다.
 *   ① 전역:   window.__WS_SHELL__.setTitle(title | null, owner?) → 해제 함수
 *             window.__WS_SHELL__.clearTitle(owner?)
 *   ② 주입:   pluginApi.setTitle(...) / .clearTitle(...)  (pages/p/[id] 가 넘긴다)
 * 빈 문자열·null·문자열 아닌 값 = 그 owner 몫 해제(호스트 기본 제목으로 원복).
 * 플러그인 페이지를 떠나거나 다른 플러그인으로 바꾸면 호스트가 전부 지운다(해제를 잊어도 남지 않음).
 *
 * 렌더(LayoutTopBar): 데스크톱 = 3단 경로의 마지막 칸(워크스페이스 / 모듈 / 제목), 모바일 = 머리 제목 한 줄.
 * 페이지가 useBreadcrumb 로 올린 위치보다 우선한다. 여러 owner 가 걸면 마지막에 건 것이 보인다.
 *
 * React(상단바): const title = useShellTitle()   — 없으면 ''
 * 테스트·밖: getShellTitle()
 */
import { createStore, useStore } from 'zustand'

/** 너무 긴 제목은 잘라 둔다(상단바는 한 줄 말줄임이지만 aria·툴팁까지 무한정 길 필요는 없다) */
export const MAX_TITLE_LENGTH = 200
const DEFAULT_OWNER = 'plugin'

/** 등록 순서(마지막이 보임). 같은 owner 를 다시 걸면 맨 뒤로 */
export const shellTitleStore = createStore<{ entries: { owner: string; title: string }[] }>()(() => ({ entries: [] }))

function clean(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH)
}

/** 제목 걸기(같은 owner 는 바꿈). null·'' 이면 해제. 돌려주는 함수를 부르면 해제 */
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

/** owner 몫 해제. owner 생략 = 기본 owner('plugin') */
export function clearTitle(owner: string = DEFAULT_OWNER) {
  const key = String(owner || DEFAULT_OWNER)
  const entries = shellTitleStore.getState().entries
  if (!entries.some(e => e.owner === key)) return
  shellTitleStore.setState({ entries: entries.filter(e => e.owner !== key) })
}

/** 전부 해제(플러그인 페이지를 떠날 때 호스트가 부른다) */
export function clearAllTitles() {
  if (shellTitleStore.getState().entries.length) shellTitleStore.setState({ entries: [] })
}

/** 지금 보일 제목(컴포넌트 밖). 없으면 '' */
export function getShellTitle(): string {
  return shellTitleStore.getState().entries.at(-1)?.title ?? ''
}

/** 상단바용: 지금 보일 제목. 없으면 '' */
export function useShellTitle(): string {
  return useStore(shellTitleStore, s => s.entries.at(-1)?.title ?? '')
}
