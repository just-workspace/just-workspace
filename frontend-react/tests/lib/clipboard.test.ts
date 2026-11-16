// http(비보안 연결)에서는 navigator.clipboard 없음 — execCommand 폴백, 그것도 실패하면 throw(호출자가 실패 안내)
import { describe, it, expect, vi, afterEach } from 'vitest'
import { writeClipboard } from '~/lib/clipboard'

const orig = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
afterEach(() => {
  if (orig) Object.defineProperty(navigator, 'clipboard', orig)
  else delete (navigator as any).clipboard
  delete (document as any).execCommand
})

describe('writeClipboard', () => {
  it('navigator.clipboard 가 있으면 그것', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await writeClipboard('a')
    expect(writeText).toHaveBeenCalledWith('a')
  })
  it('없으면 execCommand(copy) 폴백', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    const exec = vi.fn(() => true);
    (document as any).execCommand = exec
    await writeClipboard('b')
    expect(exec).toHaveBeenCalledWith('copy')
  })
  it('둘 다 안 되면 throw', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    (document as any).execCommand = () => false
    await expect(writeClipboard('c')).rejects.toThrow()
  })
})
