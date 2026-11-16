/**
 * 단축키 도움말(Ctrl /) 의 모듈별 묶음 등록.
 *
 * 페이지(모듈 화면)가 `usePageShortcuts('메일', [...])` 를 호출하면 해당 화면이 마운트된 동안
 * LayoutShortcutsModal 의 "어디서나 · 목록" 위에 해당 모듈 묶음이 추가된다. 화면 이탈(언마운트) 시 제거된다.
 * 실제 키 처리는 각 페이지가 기존대로 수행한다 — 본 모듈은 표시용 목록만 관리한다.
 *
 * React(페이지 — 렌더마다 현재 목록을 전달한다. 내용 변경 시 갱신, 언마운트 시 해제):
 *   usePageShortcuts(t('nav.mail'), isMobile ? [] : [{ keys: ['C'], label: t('mail.compose') }])
 * 컴포넌트 외부·조건부 등록: const off = registerPageShortcuts(title, items | () => items); off()
 * 조회: usePageShortcutGroups() (hook, 배열 값) / getPageShortcutGroups() (외부, getter 를 호출 시점에 평가)
 */
import { useEffect, useMemo, useRef } from 'react'
import { createStore, useStore } from 'zustand'

export interface ShortcutItem { keys: string[]; label: string }
export interface ShortcutGroup { title: string; items: ShortcutItem[] }

interface Entry { id: number; title: string; items: () => ShortcutItem[] }

export const shortcutsStore = createStore<{ entries: Entry[] }>()(() => ({ entries: [] }))
let seq = 0

function groupsOf(entries: Entry[]): ShortcutGroup[] {
  return entries.map(e => ({ title: e.title, items: e.items() })).filter(g => g.items.length > 0)
}

/** 현재 등록된 묶음(등록 순서) — 컴포넌트 외부. getter 목록은 호출 시 재평가한다 */
export function getPageShortcutGroups(): ShortcutGroup[] {
  return groupsOf(shortcutsStore.getState().entries)
}

/** 현재 화면이 등록한 묶음(등록 순서) — 도움말 창용 hook */
export function usePageShortcutGroups(): ShortcutGroup[] {
  const entries = useStore(shortcutsStore, s => s.entries)
  return useMemo(() => groupsOf(entries), [entries])
}

/** 묶음 등록(컴포넌트 외부·조건부). 해제 함수를 반환한다 */
export function registerPageShortcuts(title: string, items: ShortcutItem[] | (() => ShortcutItem[])): () => void {
  const id = ++seq
  const get = typeof items === 'function' ? items : () => items
  shortcutsStore.setState({ entries: [...shortcutsStore.getState().entries, { id, title, items: get }] })
  return () => { shortcutsStore.setState({ entries: shortcutsStore.getState().entries.filter(e => e.id !== id) }) }
}

/**
 * 페이지에서 호출한다. 마운트 동안 등록(등록 순서 = 마운트 순서), 언마운트 시 자동 해제.
 * items 는 렌더마다 새 배열이어도 무방하다(내용 변경 시에만 갱신).
 */
export function usePageShortcuts(title: string, items: ShortcutItem[]) {
  const idRef = useRef(0)
  const key = JSON.stringify(items)
  const latest = useRef({ title, key })
  latest.current = { title, key }

  useEffect(() => {
    const id = ++seq
    idRef.current = id
    const { title: t0, key: k0 } = latest.current
    const list: ShortcutItem[] = JSON.parse(k0)
    shortcutsStore.setState({ entries: [...shortcutsStore.getState().entries, { id, title: t0, items: () => list }] })
    return () => { shortcutsStore.setState({ entries: shortcutsStore.getState().entries.filter(e => e.id !== id) }) }
  }, [])

  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    const id = idRef.current
    const list: ShortcutItem[] = JSON.parse(key)
    shortcutsStore.setState({
      entries: shortcutsStore.getState().entries.map(e => (e.id === id ? { id, title, items: () => list } : e)),
    })
  }, [title, key])
}
