/**
 * 채팅 설정 화면 내 공용 상태 — 미저장 변경(역할 편집 초안) 존재 여부, 바 흔들기 신호.
 * 디스코드와 같이 변경이 있으면 다른 섹션·역할로 이동할 수 없고 바가 흔들린다. 닫기(✕ · Esc)는 확인 대화 상자를 표시한다.
 */
import { createStore, useStore } from 'zustand'

interface SettingsUiState {
  dirty: boolean
  /** 값이 변경되면 바가 1회 흔들린다 */
  shakeTick: number
}
export const settingsUiStore = createStore<SettingsUiState>()(() => ({ dirty: false, shakeTick: 0 }))

export function setSettingsDirty(v: boolean) {
  if (settingsUiStore.getState().dirty !== v) settingsUiStore.setState({ dirty: v })
}
/** 이동 가능 여부 — 변경이 있으면 바를 흔들고 false 반환 */
export function requestLeave(): boolean {
  const s = settingsUiStore.getState()
  if (!s.dirty) return true
  settingsUiStore.setState({ shakeTick: s.shakeTick + 1 })
  return false
}
export function useSettingsUi<T>(sel: (s: SettingsUiState) => T): T {
  return useStore(settingsUiStore, sel)
}
