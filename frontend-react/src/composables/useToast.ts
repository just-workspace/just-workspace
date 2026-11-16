/**
 * Toast — 싱글턴.
 * 제목+본문 2줄형, 행동 1개까지, 기본 4초 / 행동 있으면 6초 / 오류는 닫을 때까지.
 *
 * 기존 호출 addToast(type, message, duration?) 은 그대로 동작한다(duration 미지정 시 규칙 적용).
 * 신규 호출은 toast({ type, title, description, action }) 로 2줄형·되돌리기를 사용한다.
 *
 * 동일 오류 병합: 동일 내용(종류·제목·본문)의 오류 토스트가 아직 표시 중이고 마지막 표시 후 MERGE_WINDOW 이내에
 * 다시 발생하면 새로 추가하지 않고 해당 토스트의 count 만 증가시킨다(전역 오류 처리기·폴링 실패가 화면을 덮지 않도록).
 * 병합된 토스트는 맨 아래(최신 위치)로 이동하며, 자동으로 닫히는 토스트이면 타이머를 재시작한다.
 *
 * React: const { toasts, addToast, toast, removeToast } = useToast()
 * 컴포넌트 외부: import { addToast } from '~/composables/useToast'
 */
import { createStore, useStore } from 'zustand'

export type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface ToastAction {
  label: string
  onClick: () => void | Promise<void>
}

export interface Toast {
  id: string
  type: ToastType
  /** 한 줄 문구(기존). 2줄형에서는 제목 */
  message: string
  /** 2줄형 본문 */
  description?: string
  action?: ToastAction
  duration: number
  /** 동일 오류가 병합된 횟수(1 = 1회) */
  count?: number
}

export interface ToastOptions {
  type?: ToastType
  title: string
  description?: string
  action?: ToastAction
  /** ms. 0 = 닫을 때까지. 미지정 시 규칙(4초 / 행동 6초 / 오류 0) */
  duration?: number
}

export const toastStore = createStore<{ toasts: Toast[] }>()(() => ({ toasts: [] }))

let idCounter = 0
/** 동일 오류를 하나로 병합하는 시간 창(ms) — 마지막 표시 후 이 시간 내에 동일 오류가 다시 발생하면 병합한다 */
export const MERGE_WINDOW = 10_000
const lastAt = new Map<string, number>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function defaultDuration(type: ToastType, hasAction: boolean): number {
  if (type === 'error') return 0
  return hasAction ? 6000 : 4000
}

function sameContent(a: Omit<Toast, 'id'>, b: Toast) {
  return a.type === b.type && a.message === b.message && (a.description ?? '') === (b.description ?? '') && !a.action && !b.action
}

function arm(id: string, duration: number) {
  const old = timers.get(id)
  if (old) clearTimeout(old)
  if (duration > 0) timers.set(id, setTimeout(() => { removeToast(id) }, duration))
}

function push(t: Omit<Toast, 'id'>): string {
  const now = Date.now()
  const list = toastStore.getState().toasts
  if (t.type === 'error') {
    const dup = list.find(x => sameContent(t, x))
    if (dup && now - (lastAt.get(dup.id) ?? 0) <= MERGE_WINDOW) {
      lastAt.set(dup.id, now)
      const merged = { ...dup, count: (dup.count ?? 1) + 1 }
      toastStore.setState({ toasts: [...list.filter(x => x.id !== dup.id), merged] })
      arm(dup.id, merged.duration)
      return dup.id
    }
  }
  const id = `toast-${++idCounter}-${now}`
  toastStore.setState({ toasts: [...list, { ...t, id, count: 1 }] })
  lastAt.set(id, now)
  arm(id, t.duration)
  return id
}

/** 기존 API. duration 생략 시 시안 규칙(4초 / 오류는 수동 닫기). */
export function addToast(type: ToastType, message: string, duration?: number) {
  return push({ type, message, duration: duration ?? defaultDuration(type, false) })
}

/** 2줄형 + 행동 1개(되돌리기·다시 보내기 등). */
export function toast(opts: ToastOptions) {
  const type = opts.type ?? 'info'
  return push({
    type,
    message: opts.title,
    description: opts.description,
    action: opts.action,
    duration: opts.duration ?? defaultDuration(type, !!opts.action),
  })
}

export function removeToast(id: string) {
  toastStore.setState({ toasts: toastStore.getState().toasts.filter(t => t.id !== id) })
  lastAt.delete(id)
  const tm = timers.get(id)
  if (tm) { clearTimeout(tm); timers.delete(id) }
}

export function useToast() {
  const toasts = useStore(toastStore, s => s.toasts)
  return { toasts, addToast, toast, removeToast }
}
