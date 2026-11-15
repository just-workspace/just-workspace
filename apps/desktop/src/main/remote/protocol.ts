/**
 * 원격 데스크톱 데이터 채널 프로토콜 — 호스트 쪽 검증·변환(뷰어 쪽 정본: plugins/remote-desktop/frontend/src/protocol.ts).
 *
 * 데이터 채널로 온 값은 그대로 믿지 않는다:
 *  - 모양·타입·범위를 검사하고 맞지 않으면 버린다(bad)
 *  - 종류별 토큰 버킷으로 속도를 자른다(rate) — 이동 240/초, 그 밖 60/초
 *  - 키는 KeyboardEvent.code 허용목록 → 스캔코드(Set 1) 표로만 바꾼다(임의 가상키·문자 주입 없음)
 *  - 좌표는 0..1 비율 → 지금 보내는 모니터의 영역 안으로만 매핑한다
 */
export const TOPIC = 'rd';
export const MAX_CLIP = 100_000;
export const MAX_PAYLOAD = MAX_CLIP * 4 + 256;

export const SPECIAL_KEYS = ['cad', 'win', 'alt-tab', 'esc-all', 'ctrl-shift-esc', 'win-d', 'win-r', 'printscreen'] as const;
export type SpecialKey = typeof SPECIAL_KEYS[number];

export type InputMsg =
  | { t: 'mm'; x: number; y: number }
  | { t: 'md' | 'mu'; b: 0 | 1 | 2; x: number; y: number }
  | { t: 'wh'; dx: number; dy: number }
  | { t: 'kd' | 'ku'; c: string }
  | { t: 'sk'; k: SpecialKey }
  | { t: 'clip'; text: string }
  | { t: 'clipreq' }
  | { t: 'mon'; i: number }
  /** 화질 모드 + 보는 창 크기(물리 픽셀, 0 이면 줄이지 않음) — quality.ts */
  | { t: 'q'; m: 'auto' | 'sharp' | 'smooth'; vw: number; vh: number };

/** KeyboardEvent.code → [스캔코드(Set 1), 확장키] */
export const SCANCODES: Readonly<Record<string, readonly [number, boolean]>> = (() => {
  const m: Record<string, readonly [number, boolean]> = {};
  const row = (codes: string[], start: number) => codes.forEach((c, i) => { m[c] = [start + i, false]; });
  row(['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal', 'Backspace', 'Tab'], 0x02);
  row(['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight', 'Enter', 'ControlLeft'], 0x10);
  row(['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote', 'Backquote', 'ShiftLeft', 'Backslash'], 0x1e);
  row(['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash', 'ShiftRight', 'NumpadMultiply', 'AltLeft', 'Space', 'CapsLock'], 0x2c);
  row(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'NumLock', 'ScrollLock'], 0x3b);
  row(['Numpad7', 'Numpad8', 'Numpad9', 'NumpadSubtract', 'Numpad4', 'Numpad5', 'Numpad6', 'NumpadAdd', 'Numpad1', 'Numpad2', 'Numpad3', 'Numpad0', 'NumpadDecimal'], 0x47);
  m.Escape = [0x01, false];
  m.IntlBackslash = [0x56, false];
  m.F11 = [0x57, false];
  m.F12 = [0x58, false];
  for (let i = 13; i <= 24; i++) m[`F${i}`] = [0x64 + (i - 13), false];
  // 한/영·한자: 한국어 키보드 드라이버(유형 103/106)는 오른쪽 Alt·오른쪽 Ctrl 을 한/영·한자로 쓴다 → 같은 스캔코드로 보낸다
  m.Lang1 = [0x38, true];
  m.Lang2 = [0x1d, true];
  m.KanaMode = [0x70, false];
  m.Convert = [0x79, false];
  m.NonConvert = [0x7b, false];
  // Pause 는 E1 1D 45 3바이트라 단일 스캔코드로 못 보낸다(0x45 는 NumLock) — 받지 않는다
  m.PrintScreen = [0x37, true];
  // 확장키(E0 접두)
  const ext: Array<[string, number]> = [
    ['NumpadEnter', 0x1c], ['ControlRight', 0x1d], ['NumpadDivide', 0x35], ['AltRight', 0x38],
    ['Home', 0x47], ['ArrowUp', 0x48], ['PageUp', 0x49], ['ArrowLeft', 0x4b], ['ArrowRight', 0x4d],
    ['End', 0x4f], ['ArrowDown', 0x50], ['PageDown', 0x51], ['Insert', 0x52], ['Delete', 0x53],
    ['MetaLeft', 0x5b], ['MetaRight', 0x5c], ['ContextMenu', 0x5d],
  ];
  for (const [c, sc] of ext) m[c] = [sc, true];
  return Object.freeze(m);
})();

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const in01 = (v: unknown): v is number => isNum(v) && v >= 0 && v <= 1;

/** 바이트 → 검증된 메시지. 맞지 않으면 null */
export function parseInput(payload: Uint8Array): InputMsg | null {
  if (!payload || payload.byteLength === 0 || payload.byteLength > MAX_PAYLOAD) return null;
  let o: Record<string, unknown>;
  try {
    const v = JSON.parse(new TextDecoder().decode(payload));
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    o = v as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (o.t) {
    case 'mm':
      return in01(o.x) && in01(o.y) ? { t: 'mm', x: o.x, y: o.y } : null;
    case 'md':
    case 'mu':
      return (o.b === 0 || o.b === 1 || o.b === 2) && in01(o.x) && in01(o.y) ? { t: o.t, b: o.b, x: o.x, y: o.y } : null;
    case 'wh':
      return isNum(o.dx) && isNum(o.dy) && Math.abs(o.dx) <= 1200 && Math.abs(o.dy) <= 1200
        ? { t: 'wh', dx: Math.round(o.dx), dy: Math.round(o.dy) } : null;
    case 'kd':
    case 'ku':
      return typeof o.c === 'string' && Object.prototype.hasOwnProperty.call(SCANCODES, o.c) ? { t: o.t, c: o.c } : null;
    case 'sk':
      return (SPECIAL_KEYS as readonly unknown[]).includes(o.k) ? { t: 'sk', k: o.k as SpecialKey } : null;
    case 'clip':
      return typeof o.text === 'string' && o.text.length <= MAX_CLIP ? { t: 'clip', text: o.text } : null;
    case 'clipreq':
      return { t: 'clipreq' };
    case 'mon':
      return Number.isInteger(o.i) && (o.i as number) >= 0 && (o.i as number) < 16 ? { t: 'mon', i: o.i as number } : null;
    case 'q': {
      const dim = (v: unknown) => (isNum(v) && v >= 0 && v <= 16384 ? Math.round(v) : null);
      const vw = dim(o.vw ?? 0), vh = dim(o.vh ?? 0);
      return (o.m === 'auto' || o.m === 'sharp' || o.m === 'smooth') && vw != null && vh != null ? { t: 'q', m: o.m, vw, vh } : null;
    }
    default:
      return null;
  }
}

/** 종류별 토큰 버킷. allow() 가 false 면 그 이벤트는 버린다 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly limits: Record<string, { rate: number; burst: number }>, private readonly now: () => number = Date.now) {}

  allow(kind: string): boolean {
    const lim = this.limits[kind] ?? this.limits.default;
    if (!lim) return false;
    const t = this.now();
    const b = this.buckets.get(kind) ?? { tokens: lim.burst, at: t };
    b.tokens = Math.min(lim.burst, b.tokens + ((t - b.at) / 1000) * lim.rate);
    b.at = t;
    if (b.tokens < 1) { this.buckets.set(kind, b); return false; }
    b.tokens -= 1;
    this.buckets.set(kind, b);
    return true;
  }
}

export const DEFAULT_LIMITS = {
  mm: { rate: 240, burst: 120 },
  wh: { rate: 60, burst: 60 },
  clip: { rate: 2, burst: 4 },
  clipreq: { rate: 1, burst: 3 },
  q: { rate: 2, burst: 4 },
  default: { rate: 60, burst: 120 },
} as const;

export interface Rect { x: number; y: number; width: number; height: number }

/** 비율 좌표 → 그 모니터 영역 안의 정수 좌표(마지막 픽셀 포함, 밖으로 못 나감) */
export function ratioToPoint(x: number, y: number, r: Rect): { x: number; y: number } {
  const px = r.x + Math.round(Math.min(1, Math.max(0, x)) * (r.width - 1));
  const py = r.y + Math.round(Math.min(1, Math.max(0, y)) * (r.height - 1));
  return { x: px, y: py };
}

/** 특수 조합 → 누를 키 순서(누름 뒤 역순 뗌). cad 는 SendInput 으로 불가 → null */
export function comboKeys(k: SpecialKey): string[] | null {
  switch (k) {
    case 'win': return ['MetaLeft'];
    case 'alt-tab': return ['AltLeft', 'Tab'];
    case 'esc-all': return ['Escape'];
    case 'ctrl-shift-esc': return ['ControlLeft', 'ShiftLeft', 'Escape'];
    case 'win-d': return ['MetaLeft', 'KeyD'];
    case 'win-r': return ['MetaLeft', 'KeyR'];
    case 'printscreen': return ['PrintScreen'];
    default: return null;
  }
}

export function encodeHost(msg: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg));
}
