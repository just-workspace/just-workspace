/**
 * UI 키트 내부 도우미 — 키트 컴포넌트가 공용으로 사용한다(앱 화면에서는 사용하지 않는다).
 *
 * - useModel      ← modelValue 지정 시 제어형, 미지정(undefined) 시 컴포넌트가 값을 보유
 * - useUid        ← `ui-xxx-${Math.random()…}` 1회만 생성하는 id
 * - useTransition ← <Transition> enter/leave 단계(동일한 Tailwind 클래스를 단계별로 적용)
 * - mergeRefs     ← 내부 ref 와 외부 ref 를 함께 사용할 때
 * - FOCUSABLE     ← 모달·시트 포커스 트랩이 사용하는 선택자
 * - menuItemRole · menuKeepsOpen ← UiMenu·UiActionSheet 항목 역할과 선택 후 닫힘 규칙
 */
import { useCallback, useEffect, useRef, useState, type Ref, type RefCallback } from 'react'
import type { UiMenuItem } from './Menu'

export const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/** defineModel 대응: [현재 값, 값 변경 함수(onUpdate 호출 포함)] */
export function useModel<T>(value: T | undefined, defaultValue: T, onUpdate?: (v: T) => void): [T, (v: T) => void] {
  const controlled = value !== undefined
  const [local, setLocal] = useState<T>(controlled ? (value as T) : defaultValue)
  const cb = useRef(onUpdate)
  cb.current = onUpdate
  const set = useCallback((v: T) => {
    if (!controlled) setLocal(v)
    cb.current?.(v)
  }, [controlled])
  return [controlled ? (value as T) : local, set]
}

/** 렌더 간 변경되지 않는 무작위 id(`${prefix}-xxxxxx`) */
export function useUid(prefix: string): string {
  const [id] = useState(() => `${prefix}-${Math.random().toString(36).slice(2, 8)}`)
  return id
}

export function mergeRefs<T>(...refs: Array<Ref<T> | undefined | null>): RefCallback<T> {
  return (node: T | null) => {
    for (const r of refs) {
      if (!r) continue
      if (typeof r === 'function') r(node)
      else (r as { current: T | null }).current = node
    }
  }
}

/**
 * <Transition> 단계.
 *  enter-from → (두 프레임 뒤) enter-to → (enterMs 뒤) idle
 *  leave-from → (두 프레임 뒤) leave-to → (leaveMs 뒤) hidden(언마운트)
 * appear=false 이면 처음부터 표시된 경우 애니메이션 없이 idle.
 */
export type TransitionPhase = 'enter-from' | 'enter-to' | 'idle' | 'leave-from' | 'leave-to' | 'hidden'

export function useTransition(show: boolean, enterMs: number, leaveMs: number, appear = false): { mounted: boolean; phase: TransitionPhase } {
  const [phase, setPhase] = useState<TransitionPhase>(show ? (appear ? 'enter-from' : 'idle') : 'hidden')
  const [prev, setPrev] = useState(show)
  if (show !== prev) {
    setPrev(show)
    setPhase(show ? 'enter-from' : (phase === 'hidden' ? 'hidden' : 'leave-from'))
  }
  useEffect(() => {
    if (phase === 'enter-from' || phase === 'leave-from') {
      let r2 = 0
      const r1 = requestAnimationFrame(() => {
        r2 = requestAnimationFrame(() => setPhase(phase === 'enter-from' ? 'enter-to' : 'leave-to'))
      })
      return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2) }
    }
    if (phase === 'enter-to' || phase === 'leave-to') {
      const tm = setTimeout(() => setPhase(phase === 'enter-to' ? 'idle' : 'hidden'), phase === 'enter-to' ? enterMs : leaveMs)
      return () => clearTimeout(tm)
    }
  }, [phase, enterMs, leaveMs])
  return { mounted: phase !== 'hidden', phase }
}

/** Transition 클래스 묶음 → 현재 단계 클래스 */
export interface TransitionClasses {
  enterActive?: string
  enterFrom?: string
  enterTo?: string
  leaveActive?: string
  leaveFrom?: string
  leaveTo?: string
}

export function transitionClass(phase: TransitionPhase, c: TransitionClasses): string {
  switch (phase) {
    case 'enter-from': return `${c.enterActive ?? ''} ${c.enterFrom ?? ''}`
    case 'enter-to': return `${c.enterActive ?? ''} ${c.enterTo ?? ''}`
    case 'leave-from': return `${c.leaveActive ?? ''} ${c.leaveFrom ?? ''}`
    case 'leave-to': return `${c.leaveActive ?? ''} ${c.leaveTo ?? ''}`
    default: return ''
  }
}

/** 항목 역할 — checked 가 있으면 radio/checkbox */
export function menuItemRole(it: UiMenuItem): 'menuitem' | 'menuitemcheckbox' | 'menuitemradio' {
  if (it.checked === undefined) return 'menuitem'
  return it.radio ? 'menuitemradio' : 'menuitemcheckbox'
}

/** 선택 후 메뉴 열림 유지 여부 — 링크 < 항목 keepOpen < 메뉴 closeOnSelect < 기본(다중 토글만 열림 유지) */
export function menuKeepsOpen(it: UiMenuItem, closeOnSelect?: boolean): boolean {
  if (it.to) return false
  if (it.keepOpen !== undefined) return it.keepOpen
  if (closeOnSelect !== undefined) return !closeOnSelect
  return it.checked !== undefined && !it.radio
}
