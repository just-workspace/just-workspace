import { describe, expect, it } from 'vitest'
import { decodeHost, encode, fmtRate, isLossy, isReleaseCombo, keyMsg, mouseButton, pointerToRatio, qualityOf, summarizeStats, wheel, MAX_CLIP } from './protocol'
import { cleanCodeInput, codeFormatOk, joinErrorKind } from './api'

const dec = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b))

describe('remote protocol (viewer)', () => {
  it('maps pointer to ratio inside letterboxed video', () => {
    // 1000x500 상자에 16:9(1920x1080) 영상 → 높이에 맞춰 888.9 폭, 좌우 여백
    const box = { left: 0, top: 0, width: 1000, height: 500 }
    const v = { width: 1920, height: 1080 }
    const w = 1920 * (500 / 1080)
    const ox = (1000 - w) / 2
    expect(pointerToRatio(ox, 0, box, v)).toEqual({ x: 0, y: 0 })
    expect(pointerToRatio(ox + w, 500, box, v)).toEqual({ x: 1, y: 1 })
    expect(pointerToRatio(ox - 5, 250, box, v)).toBeNull() // 여백 클릭은 보내지 않음
    expect(pointerToRatio(10, 10, { left: 0, top: 0, width: 0, height: 0 }, v)).toBeNull()
  })

  it('clamps and rounds on encode, truncates clipboard', () => {
    expect(dec(encode({ t: 'mm', x: 1.7, y: -3 }))).toEqual({ t: 'mm', x: 1, y: 0 })
    expect(dec(encode({ t: 'md', b: 0, x: 0.123456, y: 0.5 }))).toEqual({ t: 'md', b: 0, x: 0.1235, y: 0.5 })
    expect(dec(encode({ t: 'clip', text: 'a'.repeat(MAX_CLIP + 10) })).text.length).toBe(MAX_CLIP)
  })

  it('keys: only allow-listed codes', () => {
    expect(keyMsg(true, 'KeyA')).toEqual({ t: 'kd', c: 'KeyA' })
    expect(keyMsg(false, 'ShiftLeft')).toEqual({ t: 'ku', c: 'ShiftLeft' })
    expect(keyMsg(true, 'Unidentified')).toBeNull()
    expect(keyMsg(true, '<script>')).toBeNull()
  })

  it('wheel normalizes and clamps, buttons map', () => {
    expect(wheel(0, 3, 1)).toEqual({ t: 'wh', dx: 0, dy: 120 })
    expect(wheel(0, 99999, 0).dy).toBe(1200)
    expect(mouseButton(0)).toBe(0)
    expect(mouseButton(2)).toBe(2)
    expect(mouseButton(4)).toBeNull()
    expect(isLossy({ t: 'mm', x: 0, y: 0 })).toBe(true)
    expect(isLossy({ t: 'kd', c: 'KeyA' })).toBe(false)
  })

  it('decodes only well-formed host messages', () => {
    const e = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))
    expect(decodeHost(e({ t: 'state', s: 'secure_desktop' }))).toEqual({ t: 'state', s: 'secure_desktop', msg: undefined })
    expect(decodeHost(e({ t: 'state', s: 'pwned' }))).toBeNull()
    expect(decodeHost(e({ t: 'err', code: 'cad_unsupported' }))).toEqual({ t: 'err', code: 'cad_unsupported' })
    expect(decodeHost(e({ t: 'info', w: 1920, h: 1080, mons: [], cur: 0 }))?.t).toBe('info')
    expect(decodeHost(e({ t: 'exec', cmd: 'x' }))).toBeNull()
    expect(decodeHost(new TextEncoder().encode('not json'))).toBeNull()
  })

  it('code input: spaces, hyphens or none', () => {
    expect(cleanCodeInput('482 913 057')).toBe('482 913 057')
    expect(cleanCodeInput('12a3-4x')).toBe('123 4')
    expect(cleanCodeInput('482-913-057')).toBe('482 913 057')
    // 문장째·줄바꿈째 붙여넣기(예전엔 13자 자르기에 숫자가 잘렸다)
    expect(cleanCodeInput('원격 지원 접속 코드: 482 913 057\n')).toBe('482 913 057')
    expect(cleanCodeInput('482\u00a0913\u00a0057')).toBe('482 913 057')
    expect(codeFormatOk(cleanCodeInput('원격 지원 접속 코드: 482 913 057'))).toBe(true)
    // 넘치면 자르지 않고 형식 오류로 남긴다
    expect(codeFormatOk(cleanCodeInput('482 913 0571'))).toBe(false)
    expect(codeFormatOk('482 913 057')).toBe(true)
    expect(codeFormatOk('482-913-057')).toBe(true)
    expect(codeFormatOk('482913057')).toBe(true)
    expect(codeFormatOk('482-913-05')).toBe(false)
    expect(codeFormatOk('482-913-0571')).toBe(false)
    expect(codeFormatOk('48a913057')).toBe(false)
  })

  it('join errors map to mockup kinds', () => {
    expect(joinErrorKind({ status: 404, data: { detail: { code: 'no_match', message: 'x' } } })).toBe('no_match')
    expect(joinErrorKind({ statusCode: 404, data: { detail: { code: 'expired' } } })).toBe('expired')
    expect(joinErrorKind({ status: 422, data: { detail: { code: 'format' } } })).toBe('format')
    expect(joinErrorKind({ status: 429 })).toBe('tooMany')
    expect(joinErrorKind({ status: 500, data: { detail: 'boom' } })).toBe('other')
  })

  it('quality and release combo', () => {
    expect(qualityOf(40, 60)).toBe('ok')
    expect(qualityOf(null, null)).toBe('ok')
    expect(qualityOf(250, 60)).toBe('slow')
    expect(qualityOf(40, 9)).toBe('slow')
    expect(isReleaseCombo({ ctrlKey: true, altKey: true, shiftKey: true })).toBe(true)
    expect(isReleaseCombo({ ctrlKey: true, altKey: true, shiftKey: false })).toBe(false)
  })

  it('special keys and clipboard request encode', () => {
    expect(dec(encode({ t: 'sk', k: 'ctrl-shift-esc' }))).toEqual({ t: 'sk', k: 'ctrl-shift-esc' })
    expect(dec(encode({ t: 'clipreq' }))).toEqual({ t: 'clipreq' })
    expect(isLossy({ t: 'clipreq' })).toBe(false)
  })
})

describe('화질·통계', () => {
  it('decodeHost: info.q 와 q 확인', () => {
    const enc8 = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))
    expect(decodeHost(enc8({ t: 'info', w: 1, h: 1, mons: [], cur: 0, q: 'sharp' }))).toMatchObject({ q: 'sharp' })
    expect(decodeHost(enc8({ t: 'info', w: 1, h: 1, mons: [], cur: 0 }))).toMatchObject({ q: undefined })
    expect(decodeHost(enc8({ t: 'q', m: 'smooth' }))).toEqual({ t: 'q', m: 'smooth' })
    expect(decodeHost(enc8({ t: 'q', m: 'ultra' }))).toBeNull()
  })

  it('summarizeStats: 비트레이트·손실·코덱·경로', () => {
    const rows = (bytes: number, pkts: number, lost: number) => [
      { id: 'in', type: 'inbound-rtp', kind: 'video', bytesReceived: bytes, packetsReceived: pkts, packetsLost: lost, framesPerSecond: 29.7, frameWidth: 2560, frameHeight: 1440, codecId: 'c1' },
      { id: 'c1', type: 'codec', mimeType: 'video/H264' },
      { id: 'p', type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.021, localCandidateId: 'l', remoteCandidateId: 'r' },
      { id: 'l', type: 'local-candidate', candidateType: 'relay', relayProtocol: 'tls', protocol: 'udp' },
      { id: 'r', type: 'remote-candidate', candidateType: 'host', protocol: 'udp' },
    ]
    const a = summarizeStats(rows(0, 0, 0), null, 1000)
    expect(a.kbps).toBeNull()
    const b = summarizeStats(rows(2_500_000, 990, 10), a, 3000)
    expect(b.kbps).toBe(10000)
    expect(b.lossPct).toBe(1)
    expect(b.codec).toBe('H264')
    expect(b.fps).toBe(30)
    expect(b.rtt).toBe(21)
    expect(b.path).toBe('relay-tls')
    expect(fmtRate(b.kbps)).toBe('10 Mbps')
    expect(fmtRate(1234)).toBe('1.2 Mbps')
    expect(fmtRate(800)).toBe('800 kbps')
  })
})
