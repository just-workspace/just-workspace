import { describe, it, expect } from 'vitest'
import { connectDesktopBridge, isAppPath, type JwShellBridge } from '~/lib/desktopBridge'

function fakeBridge() {
  let fn: ((p: string) => void) | null = null
  const b: JwShellBridge = { apiVersion: 1, onNavigate: (f) => { fn = f; return () => { fn = null } } }
  return { b, send: (p: string) => fn?.(p), connected: () => fn !== null }
}

describe('desktopBridge — 셸 이동 명령', () => {
  it('셸이 아니면 아무것도 잇지 않는다', () => {
    expect(connectDesktopBridge(() => {}, {})).toBeNull()
  })

  it('앱 내부 경로만 라우터로 넘긴다', () => {
    const { b, send } = fakeBridge()
    const got: string[] = []
    connectDesktopBridge(p => got.push(p), { jwShell: b })
    send('/chat?channel=1')
    send('https://evil.example/')
    send('//evil.example/')
    send('/\\evil')
    expect(got).toEqual(['/chat?channel=1'])
  })

  it('해제하면 더 받지 않는다', () => {
    const { b, connected } = fakeBridge()
    const off = connectDesktopBridge(() => {}, { jwShell: b })
    expect(connected()).toBe(true)
    off?.()
    expect(connected()).toBe(false)
  })

  it('isAppPath', () => {
    expect(isAppPath('/')).toBe(true)
    expect(isAppPath('')).toBe(false)
    expect(isAppPath(null)).toBe(false)
  })
})
