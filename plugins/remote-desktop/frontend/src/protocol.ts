/**
 * 원격 데스크톱 데이터 채널 프로토콜(뷰어 쪽) — LiveKit publishData(topic 'rd') 위 JSON 한 줄.
 * 호스트 쪽 검증은 apps/desktop/src/main/remote/protocol.ts(같은 모양, 범위·형식·속도 검사). 문서: plugins/remote-desktop/README.md
 *
 * 뷰어 → 호스트
 *   {t:'mm', x, y}            마우스 이동 — x·y 는 화면 크기에 대한 0..1 비율(lossy 로 보낸다)
 *   {t:'md'|'mu', b, x, y}    버튼 누름/뗌 — b 0=왼쪽 1=가운데 2=오른쪽(reliable)
 *   {t:'wh', dx, dy}          휠(픽셀 단위, ±1200 으로 자른다)
 *   {t:'kd'|'ku', c}          키 — KeyboardEvent.code(물리 키). 문자 입력이 아니라 키 위치라 IME 와 무관
 *   {t:'sk', k}               특수 조합 — 'cad'(Ctrl+Alt+Del: 1단계는 무인 모드 전용이라 뷰어에서 비활성) | 'win' | 'alt-tab' | 'esc-all'
 *                             | 'ctrl-shift-esc' | 'win-d' | 'win-r' | 'printscreen'
 *   {t:'clipreq'}             호스트 클립보드 요청([클립보드 받기]) — 호스트는 요청이 있을 때만 보낸다
 *   {t:'clip', text}          클립보드 텍스트를 호스트에 넣기(최대 100k 자)
 *   {t:'mon', i}              보낼 모니터 바꾸기
 *   {t:'q', m, vw, vh}        화질 모드 'auto'|'sharp'|'smooth' + 보는 창 크기(물리 픽셀, 0 = 줄이지 않음)
 * 호스트 → 뷰어
 *   {t:'info', w, h, mons, cur, q?}   캡처 크기·모니터 목록·지금 화질(q 가 없으면 화질 모드를 모르는 옛 호스트)
 *   {t:'q', m}                    화질 모드 적용 확인
 *   {t:'clip', text}              호스트 클립보드(사용자가 [받기] 할 때)
 *   {t:'state', s, msg?}          'ok' | 'secure_desktop'(UAC 등 보안 화면 — 조작 불가) | 'paused'
 *   {t:'err', code}               'cad_unsupported' | 'rate' | 'bad' | 'clip_empty' | 'clip_too_long'
 */
export const TOPIC = 'rd'
export type SpecialKey = 'cad' | 'win' | 'alt-tab' | 'esc-all' | 'ctrl-shift-esc' | 'win-d' | 'win-r' | 'printscreen'
export const MAX_CLIP = 100_000

export type ViewerMsg =
  | { t: 'mm'; x: number; y: number }
  | { t: 'md' | 'mu'; b: 0 | 1 | 2; x: number; y: number }
  | { t: 'wh'; dx: number; dy: number }
  | { t: 'kd' | 'ku'; c: string }
  | { t: 'sk'; k: SpecialKey }
  | { t: 'clipreq' }
  | { t: 'clip'; text: string }
  | { t: 'mon'; i: number }
  | { t: 'q'; m: QualityMode; vw: number; vh: number }

export type QualityMode = 'auto' | 'sharp' | 'smooth'
export const QUALITY_MODES: readonly QualityMode[] = ['auto', 'sharp', 'smooth']
const isMode = (v: unknown): v is QualityMode => v === 'auto' || v === 'sharp' || v === 'smooth'

export type HostMsg =
  | { t: 'info'; w: number; h: number; mons: Array<{ i: number; name: string; w: number; h: number }>; cur: number; q?: QualityMode }
  | { t: 'q'; m: QualityMode }
  | { t: 'clip'; text: string }
  | { t: 'state'; s: 'ok' | 'secure_desktop' | 'paused'; msg?: string }
  | { t: 'err'; code: string }

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))
const round4 = (v: number) => Math.round(v * 10000) / 10000

/** 표시 요소 안 포인터 위치 → 비율. 영상이 레터박스(object-contain)로 들어간 경우 실제 그림 영역 기준 */
export function pointerToRatio(
  clientX: number, clientY: number,
  box: { left: number; top: number; width: number; height: number },
  video: { width: number; height: number },
): { x: number; y: number } | null {
  if (!box.width || !box.height || !video.width || !video.height) return null
  const scale = Math.min(box.width / video.width, box.height / video.height)
  const w = video.width * scale
  const h = video.height * scale
  const ox = box.left + (box.width - w) / 2
  const oy = box.top + (box.height - h) / 2
  const x = (clientX - ox) / w
  const y = (clientY - oy) / h
  if (x < 0 || x > 1 || y < 0 || y > 1) return null
  return { x: round4(x), y: round4(y) }
}

export function mouseButton(button: number): 0 | 1 | 2 | null {
  return button === 0 ? 0 : button === 1 ? 1 : button === 2 ? 2 : null
}

export function wheel(dx: number, dy: number, deltaMode: number): { t: 'wh'; dx: number; dy: number } {
  const k = deltaMode === 1 ? 40 : deltaMode === 2 ? 800 : 1 // 줄·페이지 단위 → 픽셀
  const c = (v: number) => Math.max(-1200, Math.min(1200, Math.round(v * k)))
  return { t: 'wh', dx: c(dx), dy: c(dy) }
}

/** 보낼 수 있는 키 코드(KeyboardEvent.code) — 호스트도 같은 목록으로 거른다 */
export const KEY_CODES: ReadonlySet<string> = new Set([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(c => `Key${c}`),
  ...'0123456789'.split('').map(c => `Digit${c}`),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...'0123456789'.split('').map(c => `Numpad${c}`),
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEnter', 'NumLock',
  'Escape', 'Tab', 'CapsLock', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight', 'Space', 'Enter', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash',
  'Semicolon', 'Quote', 'Backquote', 'Comma', 'Period', 'Slash', 'IntlBackslash', 'ContextMenu',
  'PrintScreen', 'ScrollLock', 'Pause', 'Lang1', 'Lang2', 'KanaMode', 'Convert', 'NonConvert',
])

export function keyMsg(down: boolean, code: string): { t: 'kd' | 'ku'; c: string } | null {
  return KEY_CODES.has(code) ? { t: down ? 'kd' : 'ku', c: code } : null
}

export function encode(msg: ViewerMsg): Uint8Array<ArrayBuffer> {
  if (msg.t === 'clip') msg = { t: 'clip', text: msg.text.slice(0, MAX_CLIP) }
  if (msg.t === 'mm' || msg.t === 'md' || msg.t === 'mu') msg = { ...msg, x: round4(clamp01(msg.x)), y: round4(clamp01(msg.y)) }
  return new TextEncoder().encode(JSON.stringify(msg))
}

/** 호스트 메시지 해석 — 모양이 다르면 null(무시) */
export function decodeHost(payload: Uint8Array): HostMsg | null {
  let m: unknown
  try { m = JSON.parse(new TextDecoder().decode(payload)) } catch { return null }
  if (!m || typeof m !== 'object') return null
  const o = m as Record<string, unknown>
  switch (o.t) {
    case 'info':
      if (!(typeof o.w === 'number' && typeof o.h === 'number' && Array.isArray(o.mons))) return null
      return { ...(o as unknown as HostMsg & { t: 'info' }), q: isMode(o.q) ? o.q : undefined }
    case 'clip':
      return typeof o.text === 'string' ? { t: 'clip', text: o.text.slice(0, MAX_CLIP) } : null
    case 'state':
      return o.s === 'ok' || o.s === 'secure_desktop' || o.s === 'paused' ? { t: 'state', s: o.s, msg: typeof o.msg === 'string' ? o.msg : undefined } : null
    case 'err':
      return typeof o.code === 'string' ? { t: 'err', code: o.code } : null
    case 'q':
      return isMode(o.m) ? { t: 'q', m: o.m } : null
    default:
      return null
  }
}

/** 마우스 이동만 lossy(늦게 와도 다음 값이 덮는다), 나머지는 순서·도착 보장 */
export function isLossy(msg: ViewerMsg): boolean {
  return msg.t === 'mm'
}

/** 연결 품질 — 왕복 지연 200ms 넘거나 15fps 아래면 느림(시안 C) */
export function qualityOf(rttMs: number | null, fps: number | null): 'ok' | 'slow' {
  if ((rttMs != null && rttMs > 200) || (fps != null && fps > 0 && fps < 15)) return 'slow'
  return 'ok'
}

/** Ctrl+Alt+Shift 를 함께 누르면 키보드 잡기를 푼다 */
export function isReleaseCombo(e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return e.ctrlKey && e.altKey && e.shiftKey
}

/**
 * 받는 영상 통계(2초마다 getStats) → 화면에 보일 숫자. prev 는 직전 표본(비트레이트·손실률은 차이로 낸다).
 * path: 'udp' 직접 · 'tcp' 직접(UDP 막힘) · 'relay-udp'/'relay-tcp'/'relay-tls' TURN 중계 — 중계면 지연·대역이 손해다.
 */
export interface StreamStats {
  at: number
  bytes: number
  packets: number
  lost: number
  /** 아래는 표시값(없으면 null) */
  kbps: number | null
  fps: number | null
  width: number | null
  height: number | null
  codec: string | null
  lossPct: number | null
  rtt: number | null
  path: string | null
}

export function summarizeStats(rows: Array<Record<string, unknown>>, prev: StreamStats | null, now: number): StreamStats {
  const byId = new Map<string, Record<string, unknown>>()
  for (const r of rows) if (typeof r.id === 'string') byId.set(r.id, r)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const inbound = rows.find(r => r.type === 'inbound-rtp' && r.kind === 'video')
  const pair = rows.find(r => r.type === 'candidate-pair' && (r.nominated === true || r.selected === true) && r.state === 'succeeded')
    ?? rows.find(r => r.type === 'candidate-pair' && r.state === 'succeeded')
  const bytes = num(inbound?.bytesReceived) ?? 0
  const packets = num(inbound?.packetsReceived) ?? 0
  const lost = num(inbound?.packetsLost) ?? 0
  const dt = prev ? (now - prev.at) / 1000 : 0
  const kbps = prev && dt > 0 && bytes >= prev.bytes ? Math.round(((bytes - prev.bytes) * 8) / dt / 1000) : null
  const dp = prev ? packets - prev.packets : 0
  const dl = prev ? lost - prev.lost : 0
  const lossPct = prev && dp + dl > 0 && dl >= 0 ? Math.round((dl / (dp + dl)) * 1000) / 10 : null
  const codecRow = typeof inbound?.codecId === 'string' ? byId.get(inbound.codecId) : undefined
  const codec = typeof codecRow?.mimeType === 'string' ? codecRow.mimeType.replace(/^video\//i, '').toUpperCase() : null
  let path: string | null = null
  if (pair) {
    const local = typeof pair.localCandidateId === 'string' ? byId.get(pair.localCandidateId) : undefined
    const remote = typeof pair.remoteCandidateId === 'string' ? byId.get(pair.remoteCandidateId) : undefined
    const relay = local?.candidateType === 'relay' || remote?.candidateType === 'relay'
    const proto = String(local?.relayProtocol ?? local?.protocol ?? remote?.protocol ?? '').toLowerCase() || null
    path = proto ? (relay ? `relay-${proto}` : proto) : null
  }
  const rttS = num(pair?.currentRoundTripTime)
  return {
    at: now, bytes, packets, lost, kbps,
    fps: num(inbound?.framesPerSecond) != null ? Math.round(num(inbound?.framesPerSecond)!) : null,
    width: num(inbound?.frameWidth), height: num(inbound?.frameHeight),
    codec, lossPct, rtt: rttS != null ? Math.round(rttS * 1000) : null, path,
  }
}

/** 1234 kbps → '1.2 Mbps', 800 → '800 kbps' */
export function fmtRate(kbps: number | null): string | null {
  if (kbps == null) return null
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(kbps >= 10_000 ? 0 : 1)} Mbps` : `${kbps} kbps`
}
