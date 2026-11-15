// 참가 전 화면 상태 논리(components/meetings/prejoin.ts): 오류 분류 · 처음 장치 잡기 · 출력 선택 가능 · https 주소 · 짝 스피커 · 잠금 · 레벨 · 경과
import { describe, it, expect, vi } from 'vitest'
import {
  acquireInitial, classifyMediaError, detectBrowser, formatElapsed, guestJoinLock, httpsUrlFor, isInsecureContext,
  joinNoteFor, meterSegments, pairSpeaker, permissionHintKey, rmsLevel, scheduleChime, sinkSelectable,
} from '~/components/meetings/prejoin'

const err = (name: string) => Object.assign(new Error(name), { name })
const stream = (video: boolean, audio: boolean) => ({
  getVideoTracks: () => (video ? [{ kind: 'video' }] : []),
  getAudioTracks: () => (audio ? [{ kind: 'audio' }] : []),
  getTracks: () => [],
}) as unknown as MediaStream

describe('classifyMediaError', () => {
  it('권한 거부 · 다른 앱 사용 중 · 장치 없음을 가른다', () => {
    expect(classifyMediaError(err('NotAllowedError'))).toBe('denied')
    expect(classifyMediaError(err('PermissionDeniedError'))).toBe('denied')
    expect(classifyMediaError(err('NotReadableError'))).toBe('inuse')
    expect(classifyMediaError(err('TrackStartError'))).toBe('inuse')
    expect(classifyMediaError(err('AbortError'))).toBe('inuse')
    expect(classifyMediaError(err('NotFoundError'))).toBe('none')
    expect(classifyMediaError(err('OverconstrainedError'))).toBe('none')
    expect(classifyMediaError(null)).toBe('none')
  })
})

describe('acquireInitial', () => {
  it('둘 다 OK', async () => {
    const gum = vi.fn().mockResolvedValue(stream(true, true))
    const r = await acquireInitial(gum)
    expect(r).toMatchObject({ video: true, audio: true, camera: null, mic: null, denied: false })
    expect(gum).toHaveBeenCalledTimes(1)
  })
  it('카메라를 다른 앱이 쓰면(NotReadableError) 오디오만 받고 카메라는 inuse', async () => {
    const gum = vi.fn().mockRejectedValueOnce(err('NotReadableError')).mockResolvedValueOnce(stream(false, true))
    const r = await acquireInitial(gum)
    expect(r).toMatchObject({ video: false, audio: true, camera: 'inuse', mic: null, denied: false })
    expect(gum.mock.calls[1][0]).toEqual({ audio: true })
  })
  it('카메라가 없으면(NotFoundError) 오디오만 받고 카메라는 none', async () => {
    const gum = vi.fn().mockRejectedValueOnce(err('NotFoundError')).mockResolvedValueOnce(stream(false, true))
    const r = await acquireInitial(gum)
    expect(r).toMatchObject({ camera: 'none', mic: null, audio: true })
  })
  it('마이크만 없으면 비디오만 받고 마이크는 none', async () => {
    const gum = vi.fn()
      .mockRejectedValueOnce(err('NotFoundError'))
      .mockRejectedValueOnce(err('NotFoundError'))
      .mockResolvedValueOnce(stream(true, false))
    const r = await acquireInitial(gum)
    expect(r).toMatchObject({ video: true, audio: false, camera: null, mic: 'none', denied: false })
    expect(gum.mock.calls[2][0]).toEqual({ video: true })
  })
  it('둘 다 권한 거부 → denied(비디오만은 더 묻지 않는다)', async () => {
    const gum = vi.fn().mockRejectedValue(err('NotAllowedError'))
    const r = await acquireInitial(gum)
    expect(r).toMatchObject({ stream: null, camera: 'denied', mic: 'denied', denied: true })
    expect(gum).toHaveBeenCalledTimes(2)
  })
  it('둘 다 없음 → 각자 none, denied 아님', async () => {
    const gum = vi.fn().mockRejectedValue(err('NotFoundError'))
    const r = await acquireInitial(gum)
    expect(r).toMatchObject({ stream: null, camera: 'none', mic: 'none', denied: false })
    expect(gum).toHaveBeenCalledTimes(3)
  })
})

describe('권한 안내 · 브라우저', () => {
  it('UA → 브라우저, 브라우저 → 한 줄 키(길게·짧게)', () => {
    expect(detectBrowser('Mozilla/5.0 Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('Edge')
    expect(detectBrowser('Mozilla/5.0 Chrome/130.0 Safari/537.36')).toBe('Chrome')
    expect(detectBrowser('Mozilla/5.0 Gecko/20100101 Firefox/131.0')).toBe('Firefox')
    expect(detectBrowser('Mozilla/5.0 (Macintosh) AppleWebKit/605 Version/17.0 Safari/605.1.15')).toBe('Safari')
    expect(detectBrowser('curl/8')).toBe('')
    expect(permissionHintKey('Chrome', 'long')).toBe('meetings.prejoin.denied.chrome')
    expect(permissionHintKey('Edge', 'short')).toBe('meetings.prejoin.denied.edgeShort')
    expect(permissionHintKey('Firefox', 'long')).toBe('meetings.prejoin.denied.firefox')
    expect(permissionHintKey('Safari', 'short')).toBe('meetings.prejoin.denied.safariShort')
    expect(permissionHintKey('', 'long')).toBe('meetings.prejoin.denied.other')
  })
})

describe('출력 선택 가능(setSinkId) · http', () => {
  it('setSinkId 가 있고 스피커 목록이 있어야 고를 수 있다', () => {
    expect(sinkSelectable({ setSinkId() {} }, 2)).toBe(true)
    expect(sinkSelectable({ setSinkId() {} }, 0)).toBe(false)
    expect(sinkSelectable({}, 2)).toBe(false)
    expect(sinkSelectable(undefined, 2)).toBe(false)
  })
  it('http 주소 → 같은 경로 https(기본 포트 80 은 뗀다)', () => {
    expect(httpsUrlFor({ protocol: 'http:', host: '192.168.10.120', pathname: '/meetings/room/qa', search: '?host=1', hash: '' }))
      .toBe('https://192.168.10.120/meetings/room/qa?host=1')
    expect(httpsUrlFor({ protocol: 'http:', host: 'ws.example.test:80', pathname: '/x', search: '', hash: '#a' })).toBe('https://ws.example.test/x#a')
    expect(httpsUrlFor({ protocol: 'http:', host: 'localhost:3000', pathname: '/', search: '', hash: '' })).toBe('https://localhost:3000/')
  })
  it('비보안 컨텍스트 판정', () => {
    expect(isInsecureContext({ isSecureContext: false })).toBe(true)
    expect(isInsecureContext({ isSecureContext: true, location: { protocol: 'http:' } })).toBe(false)
    expect(isInsecureContext({ location: { protocol: 'http:' } })).toBe(true)
    expect(isInsecureContext({ location: { protocol: 'https:' } })).toBe(false)
  })
})

describe('블루투스 짝 스피커', () => {
  const pairedFor = (id: string) => (id === 'bt-mic' ? { deviceId: 'bt-spk', label: 'WH-1000XM5' } : null)
  it('헤드셋 마이크를 고르면 스피커도 따라가고 이전 값을 남긴다(되돌리기용)', () => {
    expect(pairSpeaker('bt-mic', 'realtek-spk', false, pairedFor)).toEqual({ speakerId: 'bt-spk', previousSpeakerId: 'realtek-spk', name: 'WH-1000XM5' })
  })
  it('사용자가 스피커를 직접 골랐으면(touched) 건드리지 않는다 · 이미 같으면 알림 없음 · 짝 없음', () => {
    expect(pairSpeaker('bt-mic', 'realtek-spk', true, pairedFor)).toBeNull()
    expect(pairSpeaker('bt-mic', 'bt-spk', false, pairedFor)).toBeNull()
    expect(pairSpeaker('usb-mic', 'realtek-spk', false, pairedFor)).toBeNull()
    expect(pairSpeaker('', 'realtek-spk', false, pairedFor)).toBeNull()
  })
})

describe('손님 이름 잠금 · 참가 버튼 아래 한 줄', () => {
  it('이름이 비었을 때만 잠긴다(공백만도 비어 있음)', () => {
    expect(guestJoinLock(true, '')).toBe('meetings.prejoin.guestNameLock')
    expect(guestJoinLock(true, '   ')).toBe('meetings.prejoin.guestNameLock')
    expect(guestJoinLock(true, '김손님')).toBeNull()
    expect(guestJoinLock(false, '')).toBeNull()
  })
  it('상태별 한 줄 — 장치가 막혀도 잠그지 않고 문구만', () => {
    const base = { phase: 'ready' as const, cameraOn: true, micOn: true, camera: null, mic: null }
    expect(joinNoteFor(base)).toBeNull()
    expect(joinNoteFor({ ...base, phase: 'requesting' })).toEqual({ key: 'meetings.prejoin.req.note', tone: 'muted' })
    expect(joinNoteFor({ ...base, phase: 'denied' })).toEqual({ key: 'meetings.prejoin.denied.note', tone: 'warning' })
    expect(joinNoteFor({ ...base, phase: 'insecure' })).toEqual({ key: 'meetings.prejoin.http.note', tone: 'warning' })
    expect(joinNoteFor({ ...base, camera: 'inuse' })).toEqual({ key: 'meetings.prejoin.nodev.noteCam', tone: 'muted' })
    expect(joinNoteFor({ ...base, camera: 'none' })?.key).toBe('meetings.prejoin.nodev.noteCam')
    expect(joinNoteFor({ ...base, mic: 'none' })?.key).toBe('meetings.prejoin.nodev.noteMic')
    expect(joinNoteFor({ ...base, camera: 'none', mic: 'none' })?.key).toBe('meetings.prejoin.nodev.noteBoth')
    expect(joinNoteFor({ ...base, cameraOn: false, micOn: false })?.key).toBe('meetings.prejoin.off.noteBoth')
    expect(joinNoteFor({ ...base, cameraOn: false })?.key).toBe('meetings.prejoin.off.noteCam')
    expect(joinNoteFor({ ...base, micOn: false })?.key).toBe('meetings.prejoin.off.noteMic')
  })
})

describe('레벨 · 경과 · 차임', () => {
  it('20칸: 켜진 칸 success, 상위 15% warning, 나머지 꺼짐', () => {
    expect(meterSegments(0)).toEqual(Array(20).fill('off'))
    const half = meterSegments(55)
    expect(half.filter(s => s === 'on').length).toBe(11)
    expect(half.filter(s => s === 'off').length).toBe(9)
    const full = meterSegments(100)
    expect(full.slice(0, 17).every(s => s === 'on')).toBe(true)
    expect(full.slice(17)).toEqual(['peak', 'peak', 'peak'])
    expect(meterSegments(50, 12).filter(s => s === 'on').length).toBe(6)
    expect(meterSegments(999).length).toBe(20)
  })
  it('RMS 레벨: 무음 0, 가득 찬 파형은 100 으로 잘린다', () => {
    expect(rmsLevel(new Uint8Array(8).fill(128))).toBe(0)
    expect(rmsLevel(new Uint8Array([0, 255, 0, 255]))).toBe(100)
    expect(rmsLevel(new Uint8Array(0))).toBe(0)
  })
  it('경과 "0:42" · "12:05"', () => {
    expect(formatElapsed(42_000)).toBe('0:42')
    expect(formatElapsed(725_000)).toBe('12:05')
    expect(formatElapsed(-5)).toBe('0:00')
  })
  it('차임은 1초 안팎 세 음', () => {
    const oscs: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = []
    const ctx = {
      currentTime: 10,
      createOscillator() { const o = { type: '', frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() }; oscs.push(o); return o },
      createGain() { return { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() } },
    } as unknown as BaseAudioContext
    const len = scheduleChime(ctx, {} as AudioNode)
    expect(len).toBeGreaterThan(0.8)
    expect(len).toBeLessThan(1.3)
    expect(oscs.length).toBe(3)
    expect(oscs[0].start).toHaveBeenCalledWith(10)
    expect(oscs[2].stop.mock.calls[0][0]).toBeCloseTo(10 + len + 0.02, 5)
  })
})
