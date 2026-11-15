import { describe, it, expect } from 'vitest'

// React 판은 Vue 반응성 전역(ref·readonly·computed)이 필요 없다 — 순수 함수만 바로 가져온다
const { notificationTarget, isSafeActionUrl } = await import('~/composables/useNotifications')

describe('활동 알림 이동·행동 주소', () => {
  it('action_url 이 있으면 그쪽, 없으면 link', () => {
    expect(notificationTarget({ action_url: '/meetings', link: '/calendar' })).toBe('/meetings')
    expect(notificationTarget({ action_url: null, link: '/tasks?id=1' })).toBe('/tasks?id=1')
    expect(notificationTarget({ action_url: null, link: null })).toBeNull()
  })

  it('외부 주소·프로토콜 상대 주소·API 경로로는 이동하지 않는다', () => {
    expect(notificationTarget({ action_url: 'https://evil.example', link: '/chat' })).toBe('/chat')
    expect(notificationTarget({ action_url: '//evil.example', link: null })).toBeNull()
    expect(notificationTarget({ action_url: '/api/meetings/by-id/1/rsvp', link: null })).toBeNull()
  })

  it('행동 버튼은 같은 출처 /api/ 경로만 부른다', () => {
    expect(isSafeActionUrl('/api/meetings/by-id/1/rsvp')).toBe(true)
    expect(isSafeActionUrl('/meetings')).toBe(false)
    expect(isSafeActionUrl('https://x.example/api/a')).toBe(false)
    expect(isSafeActionUrl('//x.example/api/a')).toBe(false)
    expect(isSafeActionUrl(null)).toBe(false)
  })
})
