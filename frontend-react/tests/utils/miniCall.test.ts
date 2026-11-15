import { describe, it, expect } from 'vitest'
import {
  isMeetingRoomPath, shouldShowMiniCall, nearestMiniCallCorner, miniCallCornerStyle, miniCallReservedWidth,
  pickMiniCallSpotlight, currentRemoteSpeaker, miniCallHasVideo, formatCallElapsed, miniCallBackTarget,
  isMeetingPopupWindow, MINI_CALL_WIDTH,
} from '~/utils/miniCall'

const p = (identity: string, o: Partial<{ isLocal: boolean; isSpeaking: boolean; isMuted: boolean; video: boolean; screen: boolean }> = {}) => ({
  identity,
  isLocal: o.isLocal ?? false,
  isSpeaking: o.isSpeaking ?? false,
  isMuted: o.isMuted ?? false,
  videoTrack: o.video ? {} : null,
  screenTrack: o.screen ? {} : null,
})

describe('미니 통화 창 표시 여부', () => {
  it('회의 화면 경로', () => {
    expect(isMeetingRoomPath('/meetings/room/abc')).toBe(true)
    expect(isMeetingRoomPath('/meetings/join/tok')).toBe(true)
    expect(isMeetingRoomPath('/meetings')).toBe(false)
    expect(isMeetingRoomPath('/chat')).toBe(false)
  })
  it('통화 중 + 돌아갈 경로 + 회의 화면 밖일 때만', () => {
    expect(shouldShowMiniCall({ inCall: true, returnPath: '/meetings/room/a', path: '/chat' })).toBe(true)
    expect(shouldShowMiniCall({ inCall: true, returnPath: '/meetings/room/a', path: '/meetings/room/a' })).toBe(false)
    expect(shouldShowMiniCall({ inCall: false, returnPath: '/meetings/room/a', path: '/chat' })).toBe(false)
    // 손님(돌아갈 경로 없음)은 뜨지 않는다
    expect(shouldShowMiniCall({ inCall: true, returnPath: null, path: '/chat' })).toBe(false)
  })
})

describe('네 귀퉁이 스냅', () => {
  it('놓은 지점의 사분면', () => {
    expect(nearestMiniCallCorner(100, 100, 1440, 900)).toBe('tl')
    expect(nearestMiniCallCorner(1300, 100, 1440, 900)).toBe('tr')
    expect(nearestMiniCallCorner(100, 800, 1440, 900)).toBe('bl')
    expect(nearestMiniCallCorner(1300, 800, 1440, 900)).toBe('br')
  })
  it('귀퉁이 → 여백 24 위치', () => {
    expect(miniCallCornerStyle('br')).toEqual({ bottom: '24px', right: '24px' })
    expect(miniCallCornerStyle('tl')).toEqual({ top: '24px', left: '24px' })
    expect(miniCallCornerStyle('tr', 8)).toEqual({ top: '8px', right: '8px' })
  })
})

describe('메일 작성 창 비켜 서기 폭', () => {
  it('데스크톱 오른쪽 아래에 떠 있을 때만 320', () => {
    expect(miniCallReservedWidth({ visible: true, mobile: false, corner: 'br' })).toBe(MINI_CALL_WIDTH)
    expect(miniCallReservedWidth({ visible: true, mobile: false, corner: 'bl' })).toBe(0)
    expect(miniCallReservedWidth({ visible: true, mobile: true, corner: 'br' })).toBe(0)
    expect(miniCallReservedWidth({ visible: false, mobile: false, corner: 'br' })).toBe(0)
  })
})

describe('비출 사람 고르기', () => {
  it('빈 목록이면 없음', () => {
    expect(pickMiniCallSpotlight([], null)).toBeNull()
  })
  it('화면 공유가 가장 먼저', () => {
    const list = [p('me', { isLocal: true, screen: true }), p('a', { isSpeaking: true })]
    expect(pickMiniCallSpotlight(list, null)?.identity).toBe('me')
  })
  it('말하는 다른 사람 > 마지막 화자 > 영상 켠 사람 > 아무나 > 나', () => {
    const me = p('me', { isLocal: true, isSpeaking: true, video: true })
    expect(pickMiniCallSpotlight([me, p('a'), p('b', { isSpeaking: true })], 'a')?.identity).toBe('b')
    expect(pickMiniCallSpotlight([me, p('a'), p('b', { video: true })], 'a')?.identity).toBe('a')
    expect(pickMiniCallSpotlight([me, p('a'), p('b', { video: true })], 'gone')?.identity).toBe('b')
    expect(pickMiniCallSpotlight([me, p('a'), p('b')], null)?.identity).toBe('a')
    expect(pickMiniCallSpotlight([me], null)?.identity).toBe('me')
  })
  it('음소거인데 isSpeaking 이 남은 사람은 화자로 보지 않는다', () => {
    const list = [p('me', { isLocal: true }), p('a', { isSpeaking: true, isMuted: true }), p('b', { isSpeaking: true })]
    expect(currentRemoteSpeaker(list)?.identity).toBe('b')
    expect(currentRemoteSpeaker([p('me', { isLocal: true, isSpeaking: true })])).toBeNull()
  })
  it('영상 없으면 알약', () => {
    expect(miniCallHasVideo(null)).toBe(false)
    expect(miniCallHasVideo(p('a'))).toBe(false)
    expect(miniCallHasVideo(p('a', { video: true }))).toBe(true)
    expect(miniCallHasVideo(p('a', { screen: true }))).toBe(true)
  })
})

describe('경과 시간', () => {
  it('m:ss · h:mm:ss', () => {
    expect(formatCallElapsed(0)).toBe('0:00')
    expect(formatCallElapsed(763_000)).toBe('12:43')
    expect(formatCallElapsed(3_725_000)).toBe('1:02:05')
    expect(formatCallElapsed(-5)).toBe('0:00')
    expect(formatCallElapsed(Number.NaN)).toBe('0:00')
  })
})

describe('회의 화면을 떠날 곳', () => {
  it('직전이 앱 안 다른 화면이면 뒤로, 아니면 목록', () => {
    expect(miniCallBackTarget('/chat?channel=1')).toBe('back')
    expect(miniCallBackTarget('/meetings/room/x')).toBe('/meetings')
    expect(miniCallBackTarget(null)).toBe('/meetings')
    expect(miniCallBackTarget('https://evil.example')).toBe('/meetings')
  })
  it('팝업 창 이름', () => {
    expect(isMeetingPopupWindow('meeting-abc')).toBe(true)
    expect(isMeetingPopupWindow('jw-call-1')).toBe(true)
    expect(isMeetingPopupWindow('')).toBe(false)
  })
})
