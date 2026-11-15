/**
 * 단축키 도움말(Ctrl /) 의 모듈별 묶음 등록.
 *
 * 페이지(모듈 화면)가 `usePageShortcuts('메일', [...])` 를 부르면 그 화면이 떠 있는 동안
 * LayoutShortcutsModal 의 "어디서나 · 목록" 위에 해당 모듈 묶음이 붙는다. 화면을 떠나면(언마운트) 빠진다.
 * 실제 키 처리는 각 페이지가 그대로 한다 — 여기는 표시용 목록만.
 *
 * React(페이지 — 렌더마다 지금 목록을 넘긴다. 내용이 바뀌면 갱신, 언마운트 때 해제):
 *   usePageShortcuts(t('nav.mail'), isMobile ? [] : [{ keys: ['C'], label: t('mail.compose') }])
 * 컴포넌트 밖·조건부 등록: const off = registerPageShortcuts(title, items | () => items); off()
 * 읽기: usePageShortcutGroups() (hook, 배열 값) / getPageShortcutGroups() (밖, getter 를 지금 읽음)
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

/** 지금 등록된 묶음(등록 순서) — 컴포넌트 밖. getter 목록은 부를 때 다시 읽는다 */
export function getPageShortcutGroups(): ShortcutGroup[] {
  return groupsOf(shortcutsStore.getState().entries)
}

/** 지금 화면이 등록한 묶음(등록 순서) — 도움말 창용 hook */
export function usePageShortcutGroups(): ShortcutGroup[] {
  const entries = useStore(shortcutsStore, s => s.entries)
  return useMemo(() => groupsOf(entries), [entries])
}

/** 묶음 등록(컴포넌트 밖·조건부). 해제 함수를 돌려준다 */
export function registerPageShortcuts(title: string, items: ShortcutItem[] | (() => ShortcutItem[])): () => void {
  const id = ++seq
  const get = typeof items === 'function' ? items : () => items
  shortcutsStore.setState({ entries: [...shortcutsStore.getState().entries, { id, title, items: get }] })
  return () => { shortcutsStore.setState({ entries: shortcutsStore.getState().entries.filter(e => e.id !== id) }) }
}

/**
 * 페이지에서 부른다. 마운트 동안 등록(등록 순서 = 마운트 순서), 언마운트 때 자동 해제.
 * items 는 렌더마다 새 배열이어도 된다(내용이 바뀔 때만 갱신).
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
