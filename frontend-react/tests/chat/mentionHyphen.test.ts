import { describe, expect, it } from 'vitest'
import { mentionsMe } from '~/utils/chatMarkdown'

describe('멘션 — 이름 안의 . - (first-last)', () => {
  it('하이픈 든 이름 전체를 한 멘션으로', () => {
    expect(mentionsMe('안녕 @first-last 확인', 'first-last')).toBe(true)
    expect(mentionsMe('안녕 @first 확인', 'first-last')).toBe(false)
  })
  it('끝의 . - 는 문장부호로 뗀다', () => {
    expect(mentionsMe('고마워요 @first-last.', 'first-last')).toBe(true)
    expect(mentionsMe('@han.gil-', 'han.gil')).toBe(true)
  })
  it('한글 이름 그대로', () => { expect(mentionsMe('@민수 봐 주세요', '민수')).toBe(true) })
})
