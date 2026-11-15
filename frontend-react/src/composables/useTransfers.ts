/**
 * 업로드/다운로드 전송 상태 전역 스토어 — 진행률/속도/취소를 파일 UI 전반에서 공유.
 * 속도 평활·정리 타이머 포함.
 *
 * React: const { transfers, addTransfer, cancelTransfer, cancelAll, removeTransfer, clearFinished, activeCount, ... } = useTransfers()
 * 컴포넌트 밖: transfersStore.getState().transfers, 또는 동작 함수 직접 import.
 *
 * 주의: addTransfer 가 돌려준 객체를 호출부가 제자리에서 고치면 안 된다(t.folder = …, t._abort = …, t.status 읽기).
 * 객체를 바꿀 때마다 새 객체로 갈아 끼우므로(React 가 변화를 알게) 손에 든 객체는 낡는다.
 * 그래서 patchTransfer(id, patch) 로 고치고 getTransfer(id) 로 지금 값을 읽는다.
 */
import { createStore, useStore } from 'zustand'

export interface Transfer {
  id: string
  name: string
  dir: 'up' | 'down'
  loaded: number
  total: number            // 0 = 크기 미상
  // queued = 동시 업로드 한도(3)에 걸려 차례를 기다리는 중(시안 "대기 중")
  status: 'queued' | 'active' | 'done' | 'error' | 'canceled'
  /** 업로드: 올린 폴더(가상경로) — 완료 행 "폴더에서 보기" */
  folder?: string
  /** 실패한 업로드 다시 시도(같은 파일·같은 폴더) */
  retry?: () => void
  error?: string
  startedAt: number
  speed: number            // 네트워크 bytes/sec (평활화)
  // 업로드 전용: 서버가 실제 디스크에 기록한 바이트(NFS/HDD 기록 진행률)
  written: number
  diskSpeed: number
  _lastT: number
  _lastLoaded: number
  _lastWT: number
  _lastWritten: number
  _abort?: () => void
}

export const transfersStore = createStore<{ transfers: Transfer[] }>()(() => ({ transfers: [] }))
let _seq = 0

const list = () => transfersStore.getState().transfers
const setList = (transfers: Transfer[]) => transfersStore.setState({ transfers })

/** 테스트용: 비우기 */
export function _resetTransfersStore() {
  _seq = 0
  setList([])
}

/** 지금 값(낡은 객체 대신 이걸로 읽는다) */
export function getTransfer(id: string): Transfer | undefined {
  return list().find(x => x.id === id)
}

/** 한 행 고치기 */
export function patchTransfer(id: string, patch: Partial<Transfer>) {
  if (!getTransfer(id)) return
  setList(list().map(x => (x.id === id ? { ...x, ...patch } : x)))
}

export function addTransfer(name: string, dir: 'up' | 'down', total = 0, status: 'queued' | 'active' = 'active'): Transfer {
  const now = Date.now()
  const t: Transfer = {
    id: `${now}-${_seq++}`, name, dir, loaded: 0, total,
    status, startedAt: now, speed: 0,
    written: 0, diskSpeed: 0,
    _lastT: now, _lastLoaded: 0, _lastWT: now, _lastWritten: 0,
  }
  setList([t, ...list()])
  return t
}

/** 서버 디스크 기록 진행률 갱신(업로드용) */
export function updateDisk(id: string, written: number, total?: number) {
  const cur = getTransfer(id)
  if (!cur) return
  const t = { ...cur }
  t.written = written
  if (total && !t.total) t.total = total
  const now = Date.now()
  const dt = (now - t._lastWT) / 1000
  if (dt >= 0.4) {
    const inst = (written - t._lastWritten) / dt
    t.diskSpeed = t.diskSpeed ? t.diskSpeed * 0.6 + inst * 0.4 : inst
    t._lastWT = now
    t._lastWritten = written
  }
  setList(list().map(x => (x.id === id ? t : x)))
}

export function updateProgress(id: string, loaded: number, total?: number) {
  const cur = getTransfer(id)
  if (!cur) return
  const t = { ...cur }
  t.loaded = loaded
  if (total) t.total = total
  const now = Date.now()
  const dt = (now - t._lastT) / 1000
  if (dt >= 0.25) {
    const inst = (loaded - t._lastLoaded) / dt
    // 지수 평활(EMA)으로 속도 튐 완화
    t.speed = t.speed ? t.speed * 0.6 + inst * 0.4 : inst
    t._lastT = now
    t._lastLoaded = loaded
  }
  setList(list().map(x => (x.id === id ? t : x)))
}

export function finishTransfer(id: string, status: Transfer['status'], error?: string) {
  const cur = getTransfer(id)
  if (!cur) return
  const t = { ...cur }
  t.status = status
  if (error) t.error = error
  if (status === 'done' && t.total) { t.loaded = t.total; t.written = t.total }
  t.speed = 0
  t.diskSpeed = 0
  setList(list().map(x => (x.id === id ? t : x)))
  // 완료 항목은 묶음이 다 끝난 뒤 잠시 후 한꺼번에 정리(성공만; 실패/취소는 사용자가 확인).
  // 진행 중에 하나씩 사라지면 "3 / 5" 세기와 완료 행(시안 "완료 · 2.1 MB")이 맞지 않는다.
  if (status === 'done') {
    setTimeout(() => {
      if (!list().some(x => x.status === 'active' || x.status === 'queued')) {
        setList(list().filter(x => x.status !== 'done'))
      }
    }, 4000)
  }
}

/** 대기 → 진행(동시 한도 안으로 들어올 때·다시 시도) */
export function startTransfer(id: string) {
  if (!getTransfer(id)) return
  const now = Date.now()
  patchTransfer(id, { status: 'active', loaded: 0, written: 0, speed: 0, diskSpeed: 0, error: undefined, startedAt: now, _lastT: now, _lastLoaded: 0, _lastWT: now, _lastWritten: 0 })
}

/** 진행·대기 중인 것 전부 취소(시안 "모두 취소") */
export function cancelAll() {
  for (const t of list()) {
    if (t.status === 'active' || t.status === 'queued') t._abort?.()
  }
}

export function cancelTransfer(id: string) {
  const t = getTransfer(id)
  t?._abort?.()
}

export function removeTransfer(id: string) {
  setList(list().filter(x => x.id !== id))
}

export function clearFinished() {
  setList(list().filter(x => x.status === 'active' || x.status === 'queued'))
}

/** 대기 중도 "아직 안 끝난 것"으로 센다 */
export function transfersActiveCount(transfers: Transfer[] = list()) {
  return transfers.filter(t => t.status === 'active' || t.status === 'queued').length
}

/** 상태 + 동작(getTransfer·patchTransfer 포함) */
export function useTransfers() {
  const transfers = useStore(transfersStore, s => s.transfers)
  return {
    transfers,
    addTransfer,
    startTransfer,
    updateProgress,
    updateDisk,
    finishTransfer,
    cancelTransfer,
    cancelAll,
    removeTransfer,
    clearFinished,
    activeCount: transfersActiveCount(transfers),
    getTransfer,
    patchTransfer,
  }
}
