// 유동 레이아웃 규칙 — handover 14 답 · R14.dc.html renderVals 의 예시 값을 표로 고정한다.
import { describe, it, expect } from 'vitest'
import {
  autoScale, resolveScale, effective, railWideByDefault, mainWidthOf, dashColumns, dashCardCount,
  listColumnWidth, chatSideWidth, chatThreadDocked, mailSideOpen,
} from '~/lib/fluid'

/** R14 renderVals 를 그대로 다시 계산(레일은 기본값) */
function r14(W: number, H: number) {
  const s = autoScale(W, H)
  const e = effective(W, H, s)
  const railWide = railWideByDefault(e.width, e.portrait)
  const mainW = mainWidthOf(e.width, railWide)
  const listW = listColumnWidth(mainW, e.portrait)
  const sideW = chatSideWidth(mainW)
  const cols = dashColumns(mainW, e.portrait)
  return {
    s, we: e.width, he: e.height, portrait: e.portrait, railWide, mainW, cols, cards: dashCardCount(cols),
    listW, mailSide: mailSideOpen(mainW - listW, e.portrait), sideW, chatThread: chatThreadDocked(mainW, sideW, e.portrait),
  }
}

describe('배율 = min(폭 구간, 높이 구간)', () => {
  it.each([
    // W, H, 배율, 실효 W×H
    [1440, 900, 1, 1440, 900],
    [1920, 1080, 1, 1920, 1080],
    [2560, 1440, 1.25, 2048, 1152],
    [3840, 2160, 1.5, 2560, 1440],
    [7680, 4320, 3, 2560, 1440],      // 4K·8K 가 같은 화면
    [3440, 1440, 1.25, 2752, 1152],   // 21:9
    [5120, 1440, 1.25, 4096, 1152],   // 32:9 는 ×2 가 아니라 높이가 막아 ×1.25
    [5120, 2880, 2, 2560, 1440],
    [1080, 1920, 1, 1080, 1920],      // 세로 9:16
    [2560, 1080, 1, 2560, 1080],      // 높이가 막는다
    [2559, 1600, 1, 2559, 1600],      // 구간 경계 바로 아래
  ])('%i×%i → ×%s, 실효 %i×%i', (W, H, s, we, he) => {
    expect(autoScale(W, H)).toBe(s)
    const e = effective(W, H, s)
    expect([e.width, e.height]).toEqual([we, he])
  })

  it('모바일(<768)엔 배율 없음 — 자동·수동 모두', () => {
    expect(autoScale(767, 4000)).toBe(1)
    expect(resolveScale(200, 390, 844)).toBe(1)
    expect(resolveScale('auto', 390, 844)).toBe(1)
  })

  it('수동 선택은 구간과 상관없이 그 배율', () => {
    expect(resolveScale(150, 1920, 1080)).toBe(1.5)
    expect(resolveScale(100, 3840, 2160)).toBe(1)
    expect(resolveScale('auto', 3840, 2160)).toBe(1.5)
  })

  it('세로 = 실효 높이 > 폭, 낮은 화면 = 실효 높이 < 760', () => {
    expect(effective(1080, 1920, 1).portrait).toBe(true)
    expect(effective(1920, 1080, 1).portrait).toBe(false)
    expect(effective(1920, 700, 1).low).toBe(true)
    expect(effective(1920, 760, 1).low).toBe(false)
  })
})

describe('R14 renderVals 예시', () => {
  it.each([
    // W, H, railWide, cols, cards, listW, mailSide, sideW, chatThread
    [1440, 900, false, 3, 6, 330, false, 240, false],
    [2560, 1440, true, 4, 8, 435, false, 290, false],
    [3840, 2160, true, 5, 10, 440, true, 320, true],
    [7680, 4320, true, 5, 10, 440, true, 320, true],
    [3440, 1440, true, 6, 12, 440, true, 320, true],
    [5120, 1440, true, 6, 12, 440, true, 320, true],
    [1080, 1920, false, 2, 6, 1016, false, 240, false],
  ])('%i×%i', (W, H, railWide, cols, cards, listW, mailSide, sideW, chatThread) => {
    expect(r14(W, H)).toMatchObject({ railWide, cols, cards, listW, mailSide, sideW, chatThread })
  })

  it('32:9 는 6열 상한 — 그리드 3120 가운데', () => {
    const v = r14(5120, 1440)
    expect(v.mainW).toBe(4096 - 236)
    expect(v.cols * 520).toBe(3120)
  })
})

describe('열 수 · 카드 수 · 패널 폭 함수', () => {
  it.each([
    [1376, 3], [1812, 4], [2324, 5], [2516, 6], [3860, 6], [900, 3],
  ])('본문 %i → %i열', (w, c) => { expect(dashColumns(w, false)).toBe(c) })

  it('세로 화면은 2열', () => { expect(dashColumns(3000, true)).toBe(2) })
  it('공식 예외: 가로 화면 실효 폭 1280 미만은 2열(handover 16 답 8)', () => {
    expect(dashColumns(1216, false, 1280)).toBe(3)
    expect(dashColumns(1215, false, 1279)).toBe(2)
    expect(dashColumns(960, false, 1024)).toBe(2)
  })

  it.each([[1, 6], [2, 6], [3, 6], [4, 8], [5, 10], [6, 12], [7, 12]])('%i열 → 카드 %i장', (c, n) => {
    expect(dashCardCount(c)).toBe(n)
  })

  it('목록 열 clamp(320, 24%, 440) · 채널 목록 clamp(240, 16%, 320)', () => {
    expect(listColumnWidth(1000)).toBe(320)
    expect(listColumnWidth(1500)).toBe(360)
    expect(listColumnWidth(3000)).toBe(440)
    expect(listColumnWidth(1016, true)).toBe(1016)
    expect(chatSideWidth(1000)).toBe(240)
    expect(chatSideWidth(1750)).toBe(280)
    expect(chatSideWidth(3000)).toBe(320)
  })

  it('오른쪽 패널 자동 펼침 — 메일 상세 칸 ≥ 1400, 채팅 (본문 − 채널) ≥ 1840, 세로는 안 함', () => {
    expect(mailSideOpen(1399, false)).toBe(false)
    expect(mailSideOpen(1400, false)).toBe(true)
    expect(mailSideOpen(2000, true)).toBe(false)
    expect(chatThreadDocked(2160, 320, false)).toBe(true)
    expect(chatThreadDocked(2159, 320, false)).toBe(false)
    expect(chatThreadDocked(3000, 320, true)).toBe(false)
  })

  it('레일 기본 펼침 — 실효 폭 ≥ 1920, 세로는 64', () => {
    expect(railWideByDefault(1919, false)).toBe(false)
    expect(railWideByDefault(1920, false)).toBe(true)
    expect(railWideByDefault(2000, true)).toBe(false)
  })
})
