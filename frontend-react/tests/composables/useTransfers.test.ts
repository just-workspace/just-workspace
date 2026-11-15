// 전송 store — 추가·진행·취소·완료 정리 타이머
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  transfersStore, addTransfer, patchTransfer, getTransfer, updateProgress, finishTransfer, startTransfer,
  cancelTransfer, cancelAll, removeTransfer, clearFinished, transfersActiveCount, _resetTransfersStore,
} from '~/composables/useTransfers'

const list = () => transfersStore.getState().transfers

beforeEach(() => { _resetTransfersStore() })
afterEach(() => { vi.useRealTimers() })

describe('useTransfers', () => {
  it('추가하면 맨 앞에 들어가고 대기 중도 활성으로 센다', () => {
    const a = addTransfer('a.txt', 'up', 10)
    const b = addTransfer('b.txt', 'up', 20, 'queued')
    expect(list().map(t => t.id)).toEqual([b.id, a.id])
    expect(transfersActiveCount()).toBe(2)
  })

  it('취소 — _abort 를 부르고, 대기 중 취소는 canceled 로', () => {
    const t = addTransfer('q.bin', 'up', 5, 'queued')
    patchTransfer(t.id, { _abort: () => { if (getTransfer(t.id)?.status === 'queued') finishTransfer(t.id, 'canceled') } })
    cancelTransfer(t.id)
    expect(getTransfer(t.id)?.status).toBe('canceled')
    expect(transfersActiveCount()).toBe(0)
    removeTransfer(t.id)
    expect(list()).toHaveLength(0)
  })

  it('모두 취소는 진행·대기 중인 것만', () => {
    const calls: string[] = []
    const a = addTransfer('a', 'down'); patchTransfer(a.id, { _abort: () => calls.push('a') })
    const b = addTransfer('b', 'up', 0, 'queued'); patchTransfer(b.id, { _abort: () => calls.push('b') })
    const c = addTransfer('c', 'down'); patchTransfer(c.id, { _abort: () => calls.push('c') })
    finishTransfer(c.id, 'error', '실패')
    cancelAll()
    expect(calls.sort()).toEqual(['a', 'b'])
    expect(getTransfer(c.id)).toMatchObject({ status: 'error', error: '실패', speed: 0 })
  })

  it('진행률 갱신은 새 객체로 바꾼다(React 가 변화를 안다)', () => {
    const t = addTransfer('x', 'down', 100)
    updateProgress(t.id, 40)
    const now = getTransfer(t.id)!
    expect(now).not.toBe(t)
    expect(now.loaded).toBe(40)
    expect(t.loaded).toBe(0)
  })

  it('완료 — 4초 뒤 남은 진행이 없으면 완료 행을 지운다', () => {
    vi.useFakeTimers()
    const a = addTransfer('a', 'up', 10)
    const b = addTransfer('b', 'up', 10)
    finishTransfer(a.id, 'done')
    expect(getTransfer(a.id)).toMatchObject({ status: 'done', loaded: 10, written: 10 })
    vi.advanceTimersByTime(4000)
    expect(getTransfer(a.id)).toBeDefined() // b 가 아직 진행 중
    finishTransfer(b.id, 'done')
    vi.advanceTimersByTime(4000)
    expect(list()).toHaveLength(0)
  })

  it('다시 시작하면 진행값을 0 으로, 끝난 것 정리', () => {
    const a = addTransfer('a', 'up', 10)
    finishTransfer(a.id, 'error', 'x')
    startTransfer(a.id)
    expect(getTransfer(a.id)).toMatchObject({ status: 'active', loaded: 0, error: undefined })
    const b = addTransfer('b', 'down')
    finishTransfer(b.id, 'canceled')
    clearFinished()
    expect(list().map(t => t.id)).toEqual([a.id])
  })
})
