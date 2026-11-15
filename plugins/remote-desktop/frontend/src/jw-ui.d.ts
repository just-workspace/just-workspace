// 호스트 UI 키트(window.__WS_UI__) — 빌드 때 '@jw/ui' import 가 전역 구조분해로 바뀐다(docs/plugin-v2.md 7절).
// props 기준은 호스트 frontend-react/src/components/ui/*.tsx JSDoc. 여기서는 형만 연다.
declare module '@jw/ui' {
  type C = (props: any) => any
  export const UiButton: C, UiEmptyState: C, UiErrorTile: C, UiIcon: C, UiSkeleton: C, UiStatusDot: C, UiSwitch: C, UiBadge: C, UiIconButton: C, UiInput: C, UiMenu: C, UiTooltip: C
  export function addToast(type: 'success' | 'error' | 'warning' | 'info', message: string, duration?: number): string
}
