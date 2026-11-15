/**
 * 파일 저장소에 닿는가 — 파일 탭의 끊김 안내와 관리자 알림 띠가 함께 보는 싱글턴.
 *
 * - 서버의 `/api/system/storage-status` 를 가끔 묻는다: 정상일 때 60초, 끊겼을 때 15초. 탭이 가려져 있으면 묻지 않는다.
 *   저장소 표식 확인을 쓰지 않는 설치(guarded = false)는 한 번 묻고 그만둔다.
 * - 쓰기 요청이 503 `storage_unavailable` 로 거부되면(lib/api 가 알린다) 기다리지 않고 바로 끊김으로 바꾼다.
 * - 보는 화면이 하나도 없으면 멈춘다(useStorageWatch 를 쓴 컴포넌트 수를 센다).
 *
 * React: const { down, checking, recheck } = useStorageStatus();  useStorageWatch(켤 조건)
 */
import { useEffect } from 'react'
import { createStore, useStore } from 'zustand'
import { $fetch, STORAGE_DOWN_EVENT } from '~/lib/api'

export interface StorageStatusState {
  /** 표식 확인을 쓰는 설치인가. null = 아직 모른다 */
  guarded: boolean | null
  available: boolean
  reason: string | null
  checking: boolean
}

export const storageStatusStore = createStore<StorageStatusState>()(() => ({ guarded: null, available: true, reason: null, checking: false }))

export const storageTiming = { okMs: 60_000, downMs: 15_000 }

let watchers = 0
let timer: ReturnType<typeof setTimeout> | null = null
let listening = false

function schedule() {
  if (timer) { clearTimeout(timer); timer = null }
  const s = storageStatusStore.getState()
  if (!watchers || s.guarded === false) return
  timer = setTimeout(() => { void recheckStorage() }, s.available ? storageTiming.okMs : storageTiming.downMs)
}

/** 지금 묻는다. 묻지 못하면(네트워크·서버 재시작) 상태를 바꾸지 않는다 */
export async function recheckStorage(): Promise<void> {
  if (typeof document !== 'undefined' && document.hidden && storageStatusStore.getState().guarded !== null) { schedule(); return }
  storageStatusStore.setState({ checking: true })
  try {
    const r = await $fetch<{ guarded: boolean; available: boolean; reason: string | null }>('/api/system/storage-status')
    storageStatusStore.setState({ guarded: !!r.guarded, available: r.available !== false, reason: r.reason ?? null })
  } catch { /* 그대로 둔다 */ } finally {
    storageStatusStore.setState({ checking: false })
    schedule()
  }
}

function onStorageDown() {
  storageStatusStore.setState({ guarded: true, available: false })
  schedule()
}
function onVisible() {
  if (typeof document !== 'undefined' && !document.hidden && watchers) void recheckStorage()
}

/** 이 컴포넌트가 떠 있는 동안 저장소 상태를 지켜본다 */
export function useStorageWatch(enabled = true) {
  useEffect(() => {
    if (!enabled) return
    watchers += 1
    if (!listening && typeof window !== 'undefined') {
      listening = true
      window.addEventListener(STORAGE_DOWN_EVENT, onStorageDown)
      document.addEventListener('visibilitychange', onVisible)
    }
    if (watchers === 1) void recheckStorage()
    return () => {
      watchers -= 1
      if (!watchers && timer) { clearTimeout(timer); timer = null }
    }
  }, [enabled])
}

export function useStorageStatus() {
  const s = useStore(storageStatusStore)
  return { ...s, down: s.guarded === true && !s.available, recheck: recheckStorage }
}

/** 테스트용 — 싱글턴을 처음 상태로 */
export function _resetStorageStatus() {
  if (timer) { clearTimeout(timer); timer = null }
  watchers = 0
  storageStatusStore.setState({ guarded: null, available: true, reason: null, checking: false })
}
