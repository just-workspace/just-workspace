/**
 * 회의 참가 전 화면의 상태 로직 — 순수 함수만 포함. 화면은 MeetingsDeviceSetup.tsx.
 *
 *  · getUserMedia 오류 이름 → 상태(권한 거부 · 다른 앱 사용 중 · 장치 없음)
 *  · 최초 장치 획득: 둘 다 → 오디오만 → 비디오만 순으로 시도해 차단 원인을 장치별로 구분한다
 *  · 출력 장치 선택 가능 여부(setSinkId), http 주소 → https 주소
 *  · 블루투스 헤드셋 마이크 선택 시 동일 기기의 스피커도 연동(+복원)
 *  · 손님 이름 잠금 · 참가 버튼 아래 한 줄 · 레벨 20칸 · 경과 시간 "0:42"
 *
 * 테스트: tests/meetings/prejoin.test.ts
 */

/** 장치 차단 사유. null = 정상 */
export type DeviceIssue = 'denied' | 'inuse' | 'none' | 'lost'

/** getUserMedia 가 발생시킨 오류 → 사유. 미확인 오류는 '장치 없음'으로 처리한다(기존 동작과 동일) */
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
  /** 수신한 스트림(둘 다 수신 실패 시 null) */
  stream: MediaStream | null
  /** 해당 스트림의 비디오/오디오 트랙 존재 여부 */
  video: boolean
  audio: boolean
  /** 카메라·마이크 차단 사유(null = 정상) */
  camera: DeviceIssue | null
  mic: DeviceIssue | null
  /** 둘 다 권한 거부 — 미리보기 위치에 "권한이 꺼져 있습니다" 표시 */
  denied: boolean
}

/**
 * 최초 장치 획득. 권한 창이 한 번만 표시되도록 둘 다 먼저 요청하고, 실패 시 오디오만 → 비디오만 순으로 구분한다.
 *  둘 다 OK                       → 정상
 *  둘 다 실패(e1) · 오디오 OK      → 카메라만 e1 사유(권한 거부 · 다른 앱 사용 중 · 없음)
 *  오디오도 실패(e2) · 비디오 OK   → 마이크만 e2 사유
 *  셋 다 실패                     → 둘 중 하나라도 권한 거부면 denied, 아니면 각각의 사유
 */
/**
 * 목록·대시보드 [참여]의 이동 대상. 회의 화면(/meetings/room)은 토큰을 직접 수신하는 사용자(호스트·계정으로 초대받은 사용자·
 * 채널 통화 멤버)만 입장할 수 있다. 그 외에 목록에 포함되는 사용자는 초대 링크로 이미 입장한 사용자뿐이며(서버가 해당 사용자에게만
 * 본인이 사용한 share_token 을 반환한다 — 타인이 개설한 진행 중 회의는 목록에 없다), 해당 링크의 입장 화면(대기실·비밀번호)으로 이동시킨다.
 * 반환값: 초대 링크 경로, 또는 null(회의 화면으로 이동 — 호출부가 openRoom 수행).
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

/** 출력 장치 선택이 가능한 브라우저 여부 — setSinkId 가 있고 audiooutput 목록이 있는 경우에만 해당 */
export function sinkSelectable(mediaElementProto: object | undefined, speakerCount: number): boolean {
  return !!mediaElementProto && 'setSinkId' in mediaElementProto && speakerCount > 0
}

/** http 로 열린 비보안 주소 → 동일 경로의 https 주소(기본 포트가 아니면 포트 유지) */
export function httpsUrlFor(loc: { protocol: string; host: string; pathname: string; search: string; hash: string }): string {
  const host = loc.host.replace(/:80$/, '')
  return `https://${host}${loc.pathname}${loc.search}${loc.hash}`
}

/** 비보안 컨텍스트(http) 여부 — 장치 API 자체가 제공되지 않는다 */
export function isInsecureContext(win: { isSecureContext?: boolean; location?: { protocol: string } } | undefined): boolean {
  if (!win) return false
  if (win.isSecureContext === false) return true
  return win.location?.protocol === 'http:' && win.isSecureContext !== true
}

export interface PairedSpeaker { deviceId: string; label: string }

export interface PairResult {
  /** 연동 변경된 스피커 id */
  speakerId: string
  /** 복원 시 적용할 이전 스피커 id */
  previousSpeakerId: string
  /** 알림에 포함할 헤드셋 이름 */
  name: string
}

/**
 * 마이크 변경 시 스피커 연동 필요 여부를 판정한다.
 * 사용자가 스피커를 직접 선택한 이력이 있으면(touched) 변경하지 않는다. 이미 동일한 스피커이면 알림도 생략한다.
 */
export function pairSpeaker(
  micId: string, speakerId: string, touched: boolean, pairedFor: (micId: string) => PairedSpeaker | null,
): PairResult | null {
  if (!micId || touched) return null
  const paired = pairedFor(micId)
  if (!paired || paired.deviceId === speakerId) return null
  return { speakerId: paired.deviceId, previousSpeakerId: speakerId, name: paired.label }
}

/** 손님 이름 잠금 — 참가 버튼이 잠기는 유일한 경우. 잠금 시 사유(i18n 키), 아니면 null */
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

/** 시간 도메인 샘플(0~255) → 레벨 0~100(RMS × 300, 기존 값 유지) */
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
 * 스피커 테스트 차임(1초 내외, 비프 대체) — 세 음(C5·E5·G5)이 겹치며 상승한 뒤 완만하게 감쇠한다.
 * 그래프만 생성한다(실제 재생·출력 장치 지정은 화면 측 담당). 총 길이(초)를 반환한다.
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
