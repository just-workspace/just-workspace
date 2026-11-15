/**
 * 채팅 설정 화면 안 공용 상태 — 저장 안 된 변경(역할 편집 초안)이 있는지, 띠 흔들기 신호.
 * 디스코드처럼 변경이 있으면 다른 섹션·역할로 못 가고 띠가 흔들린다. 닫기(✕ · Esc)는 확인 대화 상자.
 */
import { createStore, useStore } from 'zustand'

interface SettingsUiState {
  dirty: boolean
  /** 값이 바뀌면 띠가 한 번 흔들린다 */
  shakeTick: number
}
export const settingsUiStore = createStore<SettingsUiState>()(() => ({ dirty: false, shakeTick: 0 }))

export function setSettingsDirty(v: boolean) {
  if (settingsUiStore.getState().dirty !== v) settingsUiStore.setState({ dirty: v })
}
/** 다른 곳으로 가도 되나 — 변경이 있으면 띠를 흔들고 false */
export function requestLeave(): boolean {
  const s = settingsUiStore.getState()
  if (!s.dirty) return true
  settingsUiStore.setState({ shakeTick: s.shakeTick + 1 })
  return false
}
export function useSettingsUi<T>(sel: (s: SettingsUiState) => T): T {
  return useStore(settingsUiStore, sel)
}
