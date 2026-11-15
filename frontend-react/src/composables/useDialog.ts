/**
 * Dialog — 브라우저 네이티브 alert/confirm/prompt 를 대체하는 인앱 다이얼로그(Vue 판 그대로).
 * Promise 기반 싱글톤(useToast 패턴). UiDialogHost 가 렌더링.
 *
 * React: const { alertBox, confirmBox, promptBox, choose } = useDialog()
 * 컴포넌트 밖에서도 같은 함수를 import 해 쓴다.
 */
import { createStore, useStore } from 'zustand'
import { i18n } from '~/i18n'

export type DialogKind = 'alert' | 'confirm' | 'prompt' | 'choose'

export interface DialogAction {
  key: string
  label: string
  variant?: 'primary' | 'danger' | 'ghost'
}

export interface DialogState {
  id: number
  kind: DialogKind
  title?: string
  message: string
  confirmLabel: string
  cancelLabel: string
  danger: boolean
  defaultValue: string
  placeholder: string
  actions?: DialogAction[]
  /** 확인형 폭(UiModal confirm size) — 기본 sm 384, 반복 일정 삭제 등은 '400' */
  size?: 'sm' | '400' | '440'
  resolve: (value: boolean | string | null) => void
}

export const dialogStore = createStore<{ current: DialogState | null }>()(() => ({ current: null }))
let idCounter = 0

interface Opts {
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  defaultValue?: string
  placeholder?: string
  /** 확인형 폭 — 기본 sm 384 · '400' · '440' */
  size?: 'sm' | '400' | '440'
}

const getCurrent = () => dialogStore.getState().current
const setCurrent = (v: DialogState | null) => dialogStore.setState({ current: v })

function _open(kind: DialogKind, message: string, opts: Opts = {}): Promise<boolean | string | null> {
  // 기본 버튼 이름(확인·취소) — 다이얼로그를 여는 순간의 로캘로 정한다
  const { t } = i18n
  return new Promise((resolve) => {
    // 이전 다이얼로그가 떠있으면 취소 처리
    const prev = getCurrent()
    if (prev) prev.resolve(kind === 'prompt' ? null : false)
    const id = ++idCounter
    // resolve 를 감싸서 호출 시 다이얼로그를 직접 닫는다.
    const wrappedResolve = (value: boolean | string | null) => {
      resolve(value)
      const cur = getCurrent()
      if (cur && cur.id === id) setCurrent(null)
    }
    setCurrent({
      id,
      kind,
      title: opts.title,
      message,
      confirmLabel: opts.confirmLabel ?? t('common.confirm'),
      cancelLabel: opts.cancelLabel ?? t('common.cancel'),
      danger: opts.danger ?? false,
      defaultValue: opts.defaultValue ?? '',
      placeholder: opts.placeholder ?? '',
      size: opts.size,
      resolve: wrappedResolve,
    })
  })
}

/** 알림 (OK만). 항상 true resolve. */
export function alertBox(message: string, opts: Opts = {}): Promise<boolean> {
  return _open('alert', message, opts) as Promise<boolean>
}
/** 확인/취소 → boolean */
export function confirmBox(message: string, opts: Opts = {}): Promise<boolean> {
  return _open('confirm', message, opts) as Promise<boolean>
}
/** 입력 → string(확인) | null(취소) */
export function promptBox(message: string, opts: Opts = {}): Promise<string | null> {
  return _open('prompt', message, opts) as Promise<string | null>
}
/** 다중 선택(3버튼 등) → 선택한 action.key | null(바깥 클릭/ESC) */
export function choose(opts: { title?: string; message?: string; actions: DialogAction[]; size?: 'sm' | '400' | '440' }): Promise<string | null> {
  const { t } = i18n
  return new Promise((resolve) => {
    const prev = getCurrent()
    if (prev) prev.resolve(null)
    const id = ++idCounter
    const wrappedResolve = (value: boolean | string | null) => {
      resolve(value as string | null)
      const cur = getCurrent()
      if (cur && cur.id === id) setCurrent(null)
    }
    setCurrent({
      id,
      kind: 'choose',
      title: opts.title,
      message: opts.message ?? '',
      confirmLabel: t('common.confirm'),
      cancelLabel: t('common.cancel'),
      danger: false,
      defaultValue: '',
      placeholder: '',
      actions: opts.actions,
      size: opts.size,
      resolve: wrappedResolve,
    })
  })
}

export function useDialog() {
  const current = useStore(dialogStore, s => s.current)
  return { current, alertBox, confirmBox, promptBox, choose }
}
