import { describe, expect, it, vi } from 'vitest'
import { isChunkLoadError, isReloading, reloadOnce } from '~/lib/chunkReload'
import { clientErrorPayload } from '~/lib/clientErrorReport'

function mem() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

describe('chunk reload', () => {
  it('브라우저별 동적 import 실패를 알아본다', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: http://x/assets/chat-abc.js'))).toBe(true)
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true)
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
  })
  it('30초 안에 되풀이되면 새로고침하지 않는다', () => {
    const s = mem(); const reload = vi.fn()
    expect(reloadOnce(1_000_000, s, reload)).toBe(true)
    expect(reloadOnce(1_010_000, s, reload)).toBe(false)
    expect(reloadOnce(1_040_001, s, reload)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
    expect(isReloading()).toBe(true)
  })
})

describe('client error payload', () => {
  it('요청 번호·메시지·스택을 싣는다', () => {
    const e = new Error('boom')
    const p = clientErrorPayload('8347-f99d', e, 500)
    expect(p.request_id).toBe('8347-f99d')
    expect(p.message).toBe('boom')
    expect(p.stack).toContain('boom')
    expect(p.status).toBe(500)
  })
  it('라우터가 감싼 원래 오류(data)도 본다', () => {
    const p = clientErrorPayload('aaaa-bbbb', { data: { message: 'inner', stack: 'S' } })
    expect(p.message).toBe('inner')
    expect(p.stack).toBe('S')
  })
})
