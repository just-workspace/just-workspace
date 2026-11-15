import { describe, it, expect } from 'vitest'
import { parseShellVersion, shellDrawsListsFor } from '~/composables/useDesktopShell'

const BASE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Electron/44.9.0 Safari/537.36'

describe('useDesktopShell — 셸 버전으로 목록 칸 소유 판별', () => {
  it('셸이 아니면 버전 없음 · 목록은 웹이 그린다', () => {
    expect(parseShellVersion(BASE)).toBeNull()
    expect(shellDrawsListsFor(BASE)).toBe(false)
  })

  it('UA 에서 버전을 뽑는다', () => {
    expect(parseShellVersion(`${BASE} JustWorkspaceDesktop/0.3.1`)).toEqual([0, 3, 1])
    expect(parseShellVersion(`${BASE} JustWorkspaceDesktop/1.12.0-beta`)).toEqual([1, 12, 0])
  })

  it('옛 셸(0.3.0 이하)은 자체 목록 칸이 있어 웹이 숨긴다', () => {
    expect(shellDrawsListsFor(`${BASE} JustWorkspaceDesktop/0.3.0`)).toBe(true)
    expect(shellDrawsListsFor(`${BASE} JustWorkspaceDesktop/0.2.9`)).toBe(true)
    // 버전을 못 읽는 셸도 옛 셸로 본다(두 벌 방지가 안전한 쪽)
    expect(shellDrawsListsFor(`${BASE} JustWorkspaceDesktop`)).toBe(true)
  })

  it('0.3.1 이상 셸은 목록을 그리지 않아 웹이 그린다', () => {
    expect(shellDrawsListsFor(`${BASE} JustWorkspaceDesktop/0.3.1`)).toBe(false)
    expect(shellDrawsListsFor(`${BASE} JustWorkspaceDesktop/0.4.0`)).toBe(false)
    expect(shellDrawsListsFor(`${BASE} JustWorkspaceDesktop/1.0.0`)).toBe(false)
  })
})

describe('useDesktopShell — 0.5.0 부터 웹이 껍데기를 전부 그린다', () => {
  it('0.5.0 미만 셸만 웹 껍데기를 숨긴다', async () => {
    const { shellHidesWebChromeFor } = await import('~/composables/useDesktopShell')
    expect(shellHidesWebChromeFor(BASE)).toBe(false)
    expect(shellHidesWebChromeFor(`${BASE} JustWorkspaceDesktop/0.4.0`)).toBe(true)
    expect(shellHidesWebChromeFor(`${BASE} JustWorkspaceDesktop`)).toBe(true)
    expect(shellHidesWebChromeFor(`${BASE} JustWorkspaceDesktop/0.5.0`)).toBe(false)
    expect(shellHidesWebChromeFor(`${BASE} JustWorkspaceDesktop/1.0.0`)).toBe(false)
  })
})
