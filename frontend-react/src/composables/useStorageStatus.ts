/**
 * 파일 저장소 접근 가능 여부 — 파일 탭의 단절 안내와 관리자 알림 띠가 공유하는 싱글턴.
 *
 * - 서버의 `/api/system/storage-status` 를 주기적으로 조회한다: 정상 시 60초, 단절 시 15초. 탭이 숨겨진 상태에서는 조회하지 않는다.
 *   저장소 마커 확인을 사용하지 않는 설치(guarded = false)는 1회 조회 후 중지한다.
 * - 쓰기 요청이 503 `storage_unavailable` 로 거부되면(lib/api 가 통지) 대기 없이 즉시 단절 상태로 전환한다.
 * - 구독 중인 화면이 없으면 중지한다(useStorageWatch 를 사용한 컴포넌트 수를 집계).
 *
 * React: const { down, checking, recheck } = useStorageStatus();  useStorageWatch(켤 조건)
 */
import { useEffect } from 'react'
import { createStore, useStore } from 'zustand'
import { $fetch, STORAGE_DOWN_EVENT } from '~/lib/api'

export interface StorageStatusState {
  /** 저장소 마커 확인을 사용하는 설치인지 여부. null = 미확인 */
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

/** 즉시 조회한다. 조회 불가 시(네트워크·서버 재시작) 상태를 변경하지 않는다 */
export async function recheckStorage(): Promise<void> {
  if (typeof document !== 'undefined' && document.hidden && storageStatusStore.getState().guarded !== null) { schedule(); return }
  storageStatusStore.setState({ checking: true })
  try {
    const r = await $fetch<{ guarded: boolean; available: boolean; reason: string | null }>('/api/system/storage-status')
    storageStatusStore.setState({ guarded: !!r.guarded, available: r.available !== false, reason: r.reason ?? null })
  } catch { /* 현 상태 유지 */ } finally {
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

/** 본 컴포넌트가 마운트된 동안 저장소 상태를 감시한다 */
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

/** 테스트용 — 싱글턴을 초기 상태로 복원 */
export function _resetStorageStatus() {
  if (timer) { clearTimeout(timer); timer = null }
  watchers = 0
  storageStatusStore.setState({ guarded: null, available: true, reason: null, checking: false })
}
