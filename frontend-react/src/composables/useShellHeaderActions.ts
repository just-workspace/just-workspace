/**
 * 호스트 상단바 확장 자리 — 플러그인 페이지가 상단바 오른쪽(데스크톱 TopBar · 모바일 머리)에 버튼·칩을 넣는다.
 * (Vue 판 composables/useShellHeaderActions.ts 그대로)
 *
 * 플러그인 번들은 별도 빌드라 호스트 모듈을 import 할 수 없다. 같은 기능을 두 길로 연다(같은 상태를 바꾼다):
 *   ① 전역:   window.__WS_SHELL__.setHeaderActions(actions, owner?) → 해제 함수
 *             window.__WS_SHELL__.clearHeaderActions(owner?)
 *   ② 주입:   pluginApi.setHeaderActions(...) / .clearHeaderActions(...)  (pages/p/[id] 가 넘긴다)
 * 플러그인 페이지가 마운트돼 있는 동안만 등록한다. 해제를 잊어도 호스트가 페이지를 떠날 때 지운다.
 * 상태(pressed 등)를 바꾸려면 같은 owner 로 setHeaderActions 를 다시 부른다(통째로 바꾼다).
 *
 * 렌더(LayoutTopBar): text 가 없으면 UiIconButton(데스크톱 32 · 모바일 44), 있으면 칩(UiChip, 모바일 히트 44).
 * label 은 aria-label·툴팁. 최대 MAX_ACTIONS 개(넘치면 앞에서부터만).
 *
 * React(상단바): const { actions } = useShellHeaderActions()   — actions 는 배열 값
 * 테스트·밖: getHeaderActions()
 */
import { useMemo } from 'react'
import { createStore, useStore } from 'zustand'
import { setTitle, clearTitle } from './useShellTitle'

export type ShellHeaderTone = 'default' | 'primary' | 'warning' | 'danger' | 'success'

export interface ShellHeaderAction {
  /** owner 안에서 고유 */
  id: string
  /** 접근성 이름·툴팁(필수) */
  label: string
  /** utils/icons 이름(예: 'wand', 'sliders'). text 가 없으면 필수 */
  icon?: string
  /** 있으면 아이콘 버튼 대신 칩(글자 버튼) */
  text?: string
  tone?: ShellHeaderTone
  /** 토글이면 true/false(aria-pressed). 일반 버튼이면 생략 */
  pressed?: boolean
  disabled?: boolean
  onClick?: (e: MouseEvent) => void
}

export const MAX_ACTIONS = 4
const DEFAULT_OWNER = 'plugin'

/** owner → 항목. 상단바는 등록 순서대로 이어 붙여 그린다 */
export const headerActionsStore = createStore<{ registry: Record<string, ShellHeaderAction[]> }>()(() => ({ registry: {} }))

function sanitize(list: unknown): ShellHeaderAction[] {
  if (!Array.isArray(list)) return []
  type Loose = Record<string, unknown>
  return list
    .filter((a): a is ShellHeaderAction => !!a && typeof a === 'object'
      && typeof (a as Loose).id === 'string' && typeof (a as Loose).label === 'string'
      && (typeof (a as Loose).icon === 'string' || typeof (a as Loose).text === 'string'))
    .map(a => ({
      id: a.id,
      label: a.label,
      icon: a.icon,
      text: a.text,
      tone: a.tone,
      pressed: typeof a.pressed === 'boolean' ? a.pressed : undefined,
      disabled: !!a.disabled,
      onClick: typeof a.onClick === 'function' ? a.onClick : undefined,
    }))
}

/** 항목 등록(같은 owner 는 통째로 바꿈). 돌려주는 함수를 부르면 해제 */
export function setHeaderActions(actions: ShellHeaderAction[], owner: string = DEFAULT_OWNER): () => void {
  const key = String(owner || DEFAULT_OWNER)
  headerActionsStore.setState({ registry: { ...headerActionsStore.getState().registry, [key]: sanitize(actions) } })
  return () => clearHeaderActions(key)
}

/** owner 몫 해제. owner 생략 = 기본 owner('plugin') */
export function clearHeaderActions(owner: string = DEFAULT_OWNER) {
  const key = String(owner || DEFAULT_OWNER)
  const reg = headerActionsStore.getState().registry
  if (!(key in reg)) return
  const next = { ...reg }
  delete next[key]
  headerActionsStore.setState({ registry: next })
}

/** 전부 해제(플러그인 페이지를 떠날 때 호스트가 부른다) */
export function clearAllHeaderActions() {
  if (Object.keys(headerActionsStore.getState().registry).length) headerActionsStore.setState({ registry: {} })
}

const flatten = (reg: Record<string, ShellHeaderAction[]>) => Object.values(reg).flat().slice(0, MAX_ACTIONS)

/** 지금 그릴 항목(컴포넌트 밖) */
export function getHeaderActions(): ShellHeaderAction[] {
  return flatten(headerActionsStore.getState().registry)
}

/** 상단바용: 지금 그릴 항목 */
export function useShellHeaderActions() {
  const registry = useStore(headerActionsStore, s => s.registry)
  const actions = useMemo(() => flatten(registry), [registry])
  return { actions }
}

/**
 * 전역 API — 플러그인 번들에서 window.__WS_SHELL__ 로 부른다(plugins/hostGlobals 가 붙인다).
 * version 은 1 그대로 — 멤버는 늘기만 한다. 새 멤버(setTitle·clearTitle)는 `?.` 로 있는지 보고 쓴다.
 */
export interface WsShellApi {
  version: 1
  setHeaderActions: typeof setHeaderActions
  clearHeaderActions: typeof clearHeaderActions
  /** 상단바 제목 덮어쓰기(composables/useShellTitle). null·'' = 원복. 해제 함수를 돌려준다 */
  setTitle: typeof setTitle
  clearTitle: typeof clearTitle
}
export const wsShellApi: WsShellApi = { version: 1, setHeaderActions, clearHeaderActions, setTitle, clearTitle }
