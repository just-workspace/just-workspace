/**
 * Ctrl+K 전환기의 "최근"(최근 6개, 종류 혼합). 클라이언트(localStorage)에만 저장한다 — 백엔드 없음.
 * 셸이 라우트 변경마다 모듈 단위로 기록하며, 페이지가 더 정확한 이름(채널·문서·폴더)을 알면 pushRecent 로 갱신한다.
 *
 * React: const { recent, pushRecent, removeRecent } = useRecents()   — recent 는 배열 값
 * 컴포넌트 외부: pushRecent(...) / removeRecent(key) 를 import
 */
import { createStore, useStore } from 'zustand'

export interface RecentItem {
  /** 고유 키(통상 경로) */
  key: string
  name: string
  /** 종류 표시(채널 · DM · 파일 · 위키 · 메일 · 작업 …) */
  kind: string
  icon: string
  to: string
  at: number
}

const KEY = 'ws.recents'
const MAX = 20

export const recentsStore = createStore<{ items: RecentItem[] }>()(() => ({ items: [] }))
let _loaded = false

function load() {
  if (_loaded || typeof window === 'undefined') return
  _loaded = true
  let items: RecentItem[]
  try { items = JSON.parse(localStorage.getItem(KEY) || '[]') } catch { items = [] }
  recentsStore.setState({ items })
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(recentsStore.getState().items.slice(0, MAX))) } catch {}
}

export function pushRecent(it: Omit<RecentItem, 'at'>) {
  load()
  const items = recentsStore.getState().items
  recentsStore.setState({ items: [{ ...it, at: Date.now() }, ...items.filter(r => r.key !== it.key)].slice(0, MAX) })
  save()
}

export function removeRecent(key: string) {
  load()
  recentsStore.setState({ items: recentsStore.getState().items.filter(r => r.key !== key) })
  save()
}

/** 테스트용: 다음 사용 시 localStorage 에서 재적재 */
export function _resetRecents() { _loaded = false; recentsStore.setState({ items: [] }) }

export function useRecents() {
  load()
  const recent = useStore(recentsStore, s => s.items)
  return { recent, pushRecent, removeRecent }
}
