/**
 * 내장 AI 권한 모드 — Claude Code 와 같은 이름·뜻(GET/PUT /api/approvals/mode).
 *  default 기본(매번 확인) · acceptEdits 편집 자동 수락 · plan 계획(실행 안 함) · auto 오토 · bypassPermissions 바이패스
 * Shift+Tab 순환은 Claude Code 처럼 bypass 를 빼고 돈다(bypass 는 메뉴 + 확인으로만 켠다).
 */
import { createStore, useStore } from 'zustand'
import { $fetch } from '~/lib/api'
import { i18n } from '~/i18n'
import { confirmBox } from '~/composables/useDialog'
import { toast } from '~/composables/useToast'

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'
export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']
const CYCLE: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto']

export const permissionStore = createStore<{ mode: PermissionMode; loaded: boolean }>()(() => ({ mode: 'default', loaded: false }))

export function usePermissionMode() {
  return useStore(permissionStore, s => s.mode)
}

let loading: Promise<void> | null = null
export function loadPermissionMode(force = false) {
  if (permissionStore.getState().loaded && !force) return Promise.resolve()
  loading ??= $fetch<{ mode: PermissionMode }>('/api/approvals/mode')
    .then(r => permissionStore.setState({ mode: PERMISSION_MODES.includes(r.mode) ? r.mode : 'default', loaded: true }))
    .catch(() => { /* 모르면 기본 */ })
    .finally(() => { loading = null })
  return loading
}

export async function setPermissionMode(mode: PermissionMode): Promise<boolean> {
  const { t } = i18n
  let confirm = false
  if (mode === 'bypassPermissions') {
    confirm = await confirmBox(t('ai.perm.bypassConfirm'), { title: t('ai.perm.bypassTitle'), confirmLabel: t('ai.perm.bypassOn'), danger: true })
    if (!confirm) return false
  }
  const prev = permissionStore.getState().mode
  permissionStore.setState({ mode })
  try {
    await $fetch('/api/approvals/mode', { method: 'PUT', body: { mode, confirm } })
    return true
  } catch (e: any) {
    permissionStore.setState({ mode: prev })
    toast({ type: 'error', title: e?.data?.detail || t('ai.perm.failed') })
    return false
  }
}

/** Shift+Tab — 다음 모드(bypass 면 기본으로 돌아온다) */
export function cyclePermissionMode() {
  const cur = permissionStore.getState().mode
  const i = CYCLE.indexOf(cur)
  void setPermissionMode(i < 0 ? 'default' : CYCLE[(i + 1) % CYCLE.length])
}
