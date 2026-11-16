/**
 * 셸 전역 열림 상태 모음 — 활동 패널(벨 → 우측 400), 단축키 도움말(Ctrl /), 사용자 메뉴, 팰릿(Ctrl K).
 * 동시에 하나만 열린다(패널을 열면 메뉴는 닫힘).
 *
 * React: const { activityOpen, ..., openActivity, setCommandPaletteOpen } = useShell()
 *   값 변경은 setCommandPaletteOpen(false) 와 같이 setXxx 로 수행한다.
 * 컴포넌트 외부: shellStore.getState() / openPalette() 등 함수 import
 */
import { createStore, useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

export interface ShellState {
  activityOpen: boolean
  shortcutsOpen: boolean
  userMenuOpen: boolean
  commandPaletteOpen: boolean
  /**
   * 표시 중인 플로팅 미니 통화 창의 폭 — 표시 중이 아니면 0. 겹침 순서: 통화 창 z 45 가 위, 메일 작성 창 z 40.
   * 둘 다 표시되면 작성 창 묶음이 (이 폭 + 16)만큼 왼쪽으로 이동한다(MailComposeHost). 통화 창이 마운트/언마운트 시 값을 갱신한다.
   */
  miniCallWidth: number
}

export const shellStore = createStore<ShellState>()(() => ({
  activityOpen: false,
  shortcutsOpen: false,
  userMenuOpen: false,
  commandPaletteOpen: false,
  miniCallWidth: 0,
}))

const set = (p: Partial<ShellState>) => shellStore.setState(p)

export function openActivity() { set({ userMenuOpen: false, commandPaletteOpen: false, activityOpen: true }) }
export function closeActivity() { set({ activityOpen: false }) }
export function toggleActivity() { if (shellStore.getState().activityOpen) closeActivity(); else openActivity() }
export function openShortcuts() { set({ userMenuOpen: false, shortcutsOpen: true }) }
export function openPalette() { set({ userMenuOpen: false, activityOpen: false, commandPaletteOpen: true }) }

export const setActivityOpen = (v: boolean) => set({ activityOpen: v })
export const setShortcutsOpen = (v: boolean) => set({ shortcutsOpen: v })
// 메뉴를 열면 활동 패널은 닫는다(동시에 하나만) — 패널(오른쪽 400)이 열린 상태이면 메뉴가 동일 위치에 겹친다
export const setUserMenuOpen = (v: boolean) => set(v ? { userMenuOpen: true, activityOpen: false } : { userMenuOpen: false })
export const setCommandPaletteOpen = (v: boolean) => set({ commandPaletteOpen: v })
export const setMiniCallWidth = (v: number) => set({ miniCallWidth: v })

export function useShell() {
  const s = useStore(shellStore, useShallow((x: ShellState) => x))
  return {
    ...s,
    openActivity, closeActivity, toggleActivity, openShortcuts, openPalette,
    setActivityOpen, setShortcutsOpen, setUserMenuOpen, setCommandPaletteOpen, setMiniCallWidth,
  }
}
