import { describe, it, expect } from 'vitest'

// React 판은 Vue 반응성 전역(ref·readonly·computed)이 필요 없다 — 순수 함수만 바로 가져온다
const { fromServer, toServer } = await import('~/composables/useUserPrefs')

describe('개인 설정 서버 키 변환', () => {
  it('서버 값을 로컬 형식으로 — 형식이 틀리면 무시', () => {
    expect(fromServer('density', 'compact')).toBe('compact')
    expect(fromServer('density', 'tiny')).toBeUndefined()
    expect(fromServer('weekStart', 'mon')).toBe('mon')
    expect(fromServer('weekStart', 1)).toBeUndefined()
    expect(fromServer('mailDarkView', true)).toBe(true)
    expect(fromServer('mailDarkView', 'yes')).toBeUndefined()
    expect(fromServer('readReceiptDefault', 'never')).toBe('never')
    expect(fromServer('readReceiptDefault', 'sometimes')).toBeUndefined()
  })

  it('탭바 고정 탭은 서버에 목록으로, 로컬은 첫 칸 하나', () => {
    expect(toServer('pinnedTab', 'calendar')).toEqual(['calendar'])
    expect(fromServer('pinnedTab', ['files', 'wiki'])).toBe('files')
    expect(fromServer('pinnedTab', 'tasks')).toBe('tasks')
    expect(fromServer('pinnedTab', [])).toBeUndefined()
  })

  it('시간대 빈 값(시스템) = 서버에서 지움', () => {
    expect(toServer('timezone', '')).toBeNull()
    expect(toServer('timezone', 'Asia/Seoul')).toBe('Asia/Seoul')
  })
})
