/**
 * 회의 참가 전 화면(handover 19 답)의 상태 논리 — 순수 함수만. 화면은 MeetingsDeviceSetup.tsx.
 *
 *  · getUserMedia 오류 이름 → 상태(권한 거부 · 다른 앱 사용 중 · 장치 없음)
 *  · 처음 장치 잡기: 둘 다 → 오디오만 → 비디오만 순으로 시도해 "무엇이 막혔나"를 장치별로 가른다
 *  · 출력 장치 선택 가능 여부(setSinkId), http 주소 → https 주소
 *  · 블루투스 헤드셋 마이크를 고르면 같은 몸의 스피커도 따라가기(+되돌리기)
 *  · 손님 이름 잠금 · 참가 버튼 아래 한 줄 · 레벨 20칸 · 경과 시간 "0:42"
 *
 * 테스트: tests/meetings/prejoin.test.ts
 */

/** 장치가 막힌 이유. null = 정상 */
export type DeviceIssue = 'denied' | 'inuse' | 'none' | 'lost'

/** getUserMedia 가 던진 오류 → 이유. 알 수 없는 오류는 '장치 없음'으로 다룬다(예전과 같다) */
export function classifyMediaError(err: unknown): DeviceIssue {
  const name = (err as { name?: string } | null)?.name || ''
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'denied'
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
    case 'SourceUnavailableError':
      return 'inuse'
    default:
      return 'none'
  }
}

export type GetUserMedia = (c: MediaStreamConstraints) => Promise<MediaStream>

export interface AcquireResult {
  /** 받은 스트림(둘 다 못 받으면 null) */
  stream: MediaStream | null
  /** 이 스트림에 비디오/오디오 트랙이 있는가 */
  video: boolean
  audio: boolean
  /** 카메라·마이크가 막힌 이유(null = 정상) */
  camera: DeviceIssue | null
  mic: DeviceIssue | null
  /** 둘 다 권한 거부 — 미리보기 자리에 "권한이 꺼져 있습니다" */
  denied: boolean
}

/**
 * 처음 장치 잡기. 권한 창은 한 번만 뜨게 둘 다 먼저 묻고, 실패하면 오디오만 → 비디오만 순으로 가른다.
 *  둘 다 OK                       → 정상
 *  둘 다 실패(e1) · 오디오 OK      → 카메라만 e1 이유(권한 거부 · 다른 앱 사용 중 · 없음)
 *  오디오도 실패(e2) · 비디오 OK   → 마이크만 e2 이유
 *  셋 다 실패                     → 둘 중 하나라도 권한 거부면 denied, 아니면 각자 이유
 */
/**
 * 목록·대시보드 [참여]가 갈 곳. 회의 화면(/meetings/room)은 토큰을 직접 받는 사람(호스트·계정으로 초대받은 사람·
 * 채널 통화 멤버)만 들어갈 수 있다. 그 밖에 목록에 실리는 사람은 초대 링크로 이미 들어온 사람뿐이고(서버가 그 사람에게만
 * 자기가 쓴 share_token 을 준다 — 남이 연 진행 중 회의는 목록에 없다), 그 링크의 입장 화면(대기실·비밀번호)으로 보낸다.
 * 돌려주는 값: 초대 링크 경로, 또는 null(회의 화면으로 — 호출부가 openRoom).
 */
export function meetingJoinPath(room: { name: string; is_host?: boolean; my_response?: string | null; share_token?: string | null }): string | null {
  if (room.is_host || room.my_response || room.name.startsWith('chan-')) return null
  return room.share_token ? `/meetings/join/${encodeURIComponent(room.share_token)}` : null
}

export async function acquireInitial(gum: GetUserMedia): Promise<AcquireResult> {
  try {
    const stream = await gum({ video: true, audio: true })
    return { stream, video: true, audio: true, camera: null, mic: null, denied: false }
  } catch (e1) {
    const k1 = classifyMediaError(e1)
    try {
      const stream = await gum({ audio: true })
      return { stream, video: false, audio: true, camera: k1, mic: null, denied: false }
    } catch (e2) {
      const k2 = classifyMediaError(e2)
      if (k1 === 'denied' && k2 === 'denied') {
        return { stream: null, video: false, audio: false, camera: 'denied', mic: 'denied', denied: true }
      }
      try {
        const stream = await gum({ video: true })
        return { stream, video: true, audio: false, camera: null, mic: k2, denied: false }
      } catch (e3) {
        const k3 = classifyMediaError(e3)
        const denied = k2 === 'denied' && k3 === 'denied'
        return { stream: null, video: false, audio: false, camera: denied ? 'denied' : k3, mic: denied ? 'denied' : k2, denied }
      }
    }
  }
}

export type BrowserName = 'Chrome' | 'Edge' | 'Firefox' | 'Safari' | ''

export function detectBrowser(ua: string): BrowserName {
  if (ua.includes('Edg/')) return 'Edge'
  if (ua.includes('Chrome/') || ua.includes('CriOS/')) return 'Chrome'
  if (ua.includes('Firefox/') || ua.includes('FxiOS/')) return 'Firefox'
  if (ua.includes('Safari/') && !ua.includes('Chrome')) return 'Safari'
  return ''
}

/** 권한 거부 안내의 i18n 키(브라우저별 한 줄). long = 데스크톱 · short = 모바일 */
export function permissionHintKey(browser: BrowserName, variant: 'long' | 'short'): string {
  const b = browser === 'Chrome' ? 'chrome' : browser === 'Edge' ? 'edge' : browser === 'Firefox' ? 'firefox' : browser === 'Safari' ? 'safari' : 'other'
  return `meetings.prejoin.denied.${b}${variant === 'short' ? 'Short' : ''}`
}

/** 출력 장치를 고를 수 있는 브라우저인가 — setSinkId 가 있고 audiooutput 목록이 있을 때만 */
export function sinkSelectable(mediaElementProto: object | undefined, speakerCount: number): boolean {
  return !!mediaElementProto && 'setSinkId' in mediaElementProto && speakerCount > 0
}

/** http 로 열린 비보안 주소 → 같은 경로의 https 주소(기본 포트가 아니면 포트는 그대로 둔다) */
export function httpsUrlFor(loc: { protocol: string; host: string; pathname: string; search: string; hash: string }): string {
  const host = loc.host.replace(/:80$/, '')
  return `https://${host}${loc.pathname}${loc.search}${loc.hash}`
}

/** 비보안 컨텍스트(http)인가 — 장치 API 가 아예 없다 */
export function isInsecureContext(win: { isSecureContext?: boolean; location?: { protocol: string } } | undefined): boolean {
  if (!win) return false
  if (win.isSecureContext === false) return true
  return win.location?.protocol === 'http:' && win.isSecureContext !== true
}

export interface PairedSpeaker { deviceId: string; label: string }

export interface PairResult {
  /** 따라 바꾼 스피커 id */
  speakerId: string
  /** 되돌릴 때 복원할 이전 스피커 id */
  previousSpeakerId: string
  /** 알림에 넣을 헤드셋 이름 */
  name: string
}

/**
 * 마이크가 바뀌었을 때 스피커도 따라가야 하는가.
 * 사용자가 스피커를 직접 고른 적이 있으면(touched) 건드리지 않는다. 이미 같은 스피커면 알림도 없다.
 */
export function pairSpeaker(
  micId: string, speakerId: string, touched: boolean, pairedFor: (micId: string) => PairedSpeaker | null,
): PairResult | null {
  if (!micId || touched) return null
  const paired = pairedFor(micId)
  if (!paired || paired.deviceId === speakerId) return null
  return { speakerId: paired.deviceId, previousSpeakerId: speakerId, name: paired.label }
}

/** 손님 이름 잠금 — 참가 버튼이 잠기는 유일한 경우. 잠기면 이유(i18n 키), 아니면 null */
export function guestJoinLock(nameRequired: boolean, name: string): string | null {
  if (!nameRequired) return null
  return name.trim() ? null : 'meetings.prejoin.guestNameLock'
}

/** 상태 → 참가 버튼 아래 한 줄 */
export interface JoinNoteInput {
  phase: 'requesting' | 'ready' | 'denied' | 'insecure'
  cameraOn: boolean
  micOn: boolean
  camera: DeviceIssue | null
  mic: DeviceIssue | null
}
export interface JoinNote { key: string; tone: 'muted' | 'warning' }

export function joinNoteFor(s: JoinNoteInput): JoinNote | null {
  if (s.phase === 'requesting') return { key: 'meetings.prejoin.req.note', tone: 'muted' }
  if (s.phase === 'denied') return { key: 'meetings.prejoin.denied.note', tone: 'warning' }
  if (s.phase === 'insecure') return { key: 'meetings.prejoin.http.note', tone: 'warning' }
  const camBlocked = !!s.camera, micBlocked = !!s.mic
  if (camBlocked && micBlocked) return { key: 'meetings.prejoin.nodev.noteBoth', tone: 'muted' }
  if (camBlocked && (!s.micOn)) return { key: 'meetings.prejoin.nodev.noteBoth', tone: 'muted' }
  if (micBlocked && (!s.cameraOn)) return { key: 'meetings.prejoin.nodev.noteBoth', tone: 'muted' }
  if (camBlocked) return { key: 'meetings.prejoin.nodev.noteCam', tone: 'muted' }
  if (micBlocked) return { key: 'meetings.prejoin.nodev.noteMic', tone: 'muted' }
  if (!s.cameraOn && !s.micOn) return { key: 'meetings.prejoin.off.noteBoth', tone: 'muted' }
  if (!s.cameraOn) return { key: 'meetings.prejoin.off.noteCam', tone: 'muted' }
  if (!s.micOn) return { key: 'meetings.prejoin.off.noteMic', tone: 'muted' }
  return null
}

/** 레벨 칸 상태: 'off' · 'on' · 'peak'(상위 15% warning). level 0~100 */
export type MeterSegment = 'off' | 'on' | 'peak'
export function meterSegments(level: number, total = 20): MeterSegment[] {
  const lit = Math.max(0, Math.min(total, Math.round((Math.max(0, Math.min(100, level)) / 100) * total)))
  return Array.from({ length: total }, (_, i) => (i < lit ? (i >= total * 0.85 ? 'peak' : 'on') : 'off'))
}

/** 시간 도메인 샘플(0~255) → 레벨 0~100(RMS × 300, 예전 값 그대로) */
export function rmsLevel(samples: ArrayLike<number>): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const v = (samples[i] - 128) / 128
    sum += v * v
  }
  return samples.length ? Math.min(100, Math.round(Math.sqrt(sum / samples.length) * 300)) : 0
}

/** 경과 "0:42" · "12:05" */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * 스피커 테스트 차임(1초 안팎, 비프 대신) — 세 음(C5·E5·G5)이 겹치며 올라가고 부드럽게 사라진다.
 * 그래프만 만든다(실제 재생·출력 장치 지정은 화면 쪽). 총 길이(초)를 돌려준다.
 */
export const CHIME_SECONDS = 1.05
export function scheduleChime(ctx: BaseAudioContext, out: AudioNode, at = ctx.currentTime): number {
  const notes = [523.25, 659.25, 783.99]
  notes.forEach((f, i) => {
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = f
    const t0 = at + i * 0.16
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.03)
    g.gain.exponentialRampToValueAtTime(0.0001, at + CHIME_SECONDS)
    osc.connect(g)
    g.connect(out)
    osc.start(t0)
    osc.stop(at + CHIME_SECONDS + 0.02)
  })
  return CHIME_SECONDS
}
