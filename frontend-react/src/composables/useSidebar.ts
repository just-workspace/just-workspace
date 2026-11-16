/**
 * 사이드바 동적 단일화.
 * 단일 컴포넌트 · 폭 하나(wide). rail(64) ↔ 확장(236):
 *   - hover → 덮기(overlay): 본문을 밀지 않고 패널만 236 으로 확장된다
 *   - pin   → 밀기(push): 클릭 고정 시에만 본문이 밀린다. localStorage(ws.sidebar) 저장.
 * 모바일(<768)은 사이드바를 렌더하지 않는다(하단 탭바).
 *
 * 기본값: 사용자가 고정을 한 번도 변경하지 않았으면 실효 폭 ≥ 1920 에서 펼침(밀기), 미만이면 64.
 * 사용자가 변경한 값(ws.sidebar 에 pinned 존재)이 있으면 해당 값을 따른다. 세로 화면은 항상 64(고정 펼침 금지 — hover 덮기만 허용).
 *
 * React: const { wide, pushes, pinned, onEnter, onLeave, togglePin, toggle, init } = useSidebar()
 */
import { createStore, useStore } from 'zustand'
import { railWideByDefault } from '~/lib/fluid'
import { viewportStore } from '~/composables/useViewport'

/** pinned = 사용자가 선택한 값, userSet = 사용자가 고정을 한 번이라도 변경했는지 여부(아니면 화면 폭 기본값) */
export const sidebarStore = createStore<{ pinned: boolean; userSet: boolean; hovering: boolean }>()(() => ({ pinned: false, userSet: false, hovering: false }))

/** 실제 고정(밀기) 상태 — 세로 화면 64 · 사용자 값 · 실효 폭 기본값 순 */
export function effectivePinned(s: { pinned: boolean; userSet: boolean }, width: number, portrait: boolean): boolean {
  if (portrait) return false
  return s.userSet ? s.pinned : railWideByDefault(width, portrait)
}

function pinnedNow(): boolean {
  const v = viewportStore.getState()
  return effectivePinned(sidebarStore.getState(), v.width, v.portrait)
}

let _inited = false
let openT: ReturnType<typeof setTimeout> | null = null
let closeT: ReturnType<typeof setTimeout> | null = null

const OPEN_DELAY = 110 // 지나가는 포인터에 의한 열림 방지
const CLOSE_DELAY = 200 // 항목으로 이동하는 중 일시적으로 벗어나도 닫히지 않도록 함

function _persist() {
  try { localStorage.setItem('ws.sidebar', JSON.stringify({ pinned: sidebarStore.getState().pinned })) } catch { /* ignore */ }
}

export function sidebarOnEnter() {
  if (closeT) { clearTimeout(closeT); closeT = null }
  // 터치 기기에서는 hover 를 사용하지 않는다(탭 한 번에 열림)
  if (window.matchMedia('(pointer: coarse)').matches) return
  openT = setTimeout(() => { sidebarStore.setState({ hovering: true }) }, OPEN_DELAY)
}

export function sidebarOnLeave() {
  if (openT) { clearTimeout(openT); openT = null }
  closeT = setTimeout(() => { sidebarStore.setState({ hovering: false }) }, CLOSE_DELAY)
}

/** 상단바/사이드바 토글 = 고정 상태 전환 */
export function toggleSidebarPin() {
  sidebarStore.setState({ pinned: !pinnedNow(), userSet: true, hovering: false })
  _persist()
}

export function initSidebar() {
  if (_inited) return
  _inited = true
  try {
    const s = JSON.parse(localStorage.getItem('ws.sidebar') || '{}')
    if (typeof s.pinned === 'boolean') sidebarStore.setState({ pinned: s.pinned, userSet: true })
  } catch { /* ignore */ }
}

export function useSidebar() {
  const width = useStore(viewportStore, s => s.width)
  const portrait = useStore(viewportStore, s => s.portrait)
  const pinned = useStore(sidebarStore, s => effectivePinned(s, width, portrait))
  const hovering = useStore(sidebarStore, s => s.hovering)
  return {
    /** 넓게 표시되는 조건 = 고정 상태이거나 hover 중 */
    wide: pinned || hovering,
    /** 본문을 미는 조건 = 고정 상태일 때만 */
    pushes: pinned,
    pinned,
    onEnter: sidebarOnEnter,
    onLeave: sidebarOnLeave,
    togglePin: toggleSidebarPin,
    toggle: toggleSidebarPin,
    init: initSidebar,
  }
}
