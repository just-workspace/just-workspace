// 순수 로직(배율 하한 · 수도 이름)
import { describe, it, expect } from 'vitest'
import { uiScaleAllowed, UI_SCALE_MIN_WIDTH } from '~/lib/fluid'
import { tzCity, tzMatches, tzSearchNames } from '~/utils/timezoneBand'

describe('화면 크기 — 실효 폭 1280 미만이 되는 배율은 못 고름(답 9)', () => {
  it('자동은 늘 가능', () => { expect(uiScaleAllowed('auto', 1300)).toBe(true) })
  it('FHD 1920: 150%(1280)까지 가능, 200%(960)·300%(640) 막힘', () => {
    expect(uiScaleAllowed(100, 1920)).toBe(true)
    expect(uiScaleAllowed(150, 1920)).toBe(true)
    expect(uiScaleAllowed(200, 1920)).toBe(false)
    expect(uiScaleAllowed(300, 1920)).toBe(false)
  })
  it('4K 3840: 300%(1280)까지 가능', () => { expect(uiScaleAllowed(300, 3840)).toBe(true) })
  it('모바일 폭은 배율을 안 쓰니 막지 않음', () => { expect(uiScaleAllowed(300, 700)).toBe(true) })
  it('하한 = 1280', () => { expect(UI_SCALE_MIN_WIDTH).toBe(1280) })
})

describe('수도 이름(답 12)', () => {
  it('ko 표시는 베이징·하노이·뉴델리', () => {
    expect(tzCity('Asia/Shanghai', 'ko')).toBe('베이징')
    expect(tzCity('Asia/Ho_Chi_Minh', 'ko')).toBe('하노이')
    expect(tzCity('Asia/Kolkata', 'ko')).toBe('뉴델리')
    expect(tzCity('Asia/Calcutta', 'ko')).toBe('뉴델리')
  })
  it('검색은 두 이름 모두 맞음', () => {
    for (const q of ['베이징', '상하이', 'shanghai', 'Beijing']) expect(tzMatches('Asia/Shanghai', q)).toBe(true)
    for (const q of ['하노이', '호찌민', 'ho chi minh', 'hanoi']) expect(tzMatches('Asia/Ho_Chi_Minh', q)).toBe(true)
    for (const q of ['뉴델리', '콜카타', 'Kolkata', 'new delhi']) expect(tzMatches('Asia/Kolkata', q)).toBe(true)
    expect(tzMatches('Asia/Seoul', '베이징')).toBe(false)
    expect(tzMatches('Asia/Seoul', '')).toBe(true)
  })
  it('검색 이름 목록에 IANA 이름이 들어 있음', () => { expect(tzSearchNames('Asia/Shanghai')).toContain('Asia/Shanghai') })
})
