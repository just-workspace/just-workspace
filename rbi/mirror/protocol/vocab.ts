/**
 * RBI DOM 미러 — 닫힌 어휘(closed vocabulary), 프로토콜 v1.
 *
 * 세션 컨테이너의 mirror-agent 가 원격 Chromium 의 DOM 을 읽어 **이 파일에 열거된 것만** 내보내고,
 * 클라이언트(우리 React 앱)는 이것만 받아 스크립트 없는 iframe 에 DOM 을 조립한다.
 * 작성자 HTML·CSS·URL 은 한 바이트도 여기 들어오지 않는다 — 들어오는 것은
 *   계산된(해석된) 스타일 값 · 레이아웃 좌표 · 텍스트 런 · 재인코딩 자산의 sha256 · SVG 기하 숫자 · 그라디언트 숫자 · 고정 폰트 키
 * 뿐이다. 값은 양쪽에서 같은 검증기로 다시 본다(심층 방어):
 *   - 에이전트: 송신 전 validateNode(lenient) — 문법에 안 맞는 필드는 떨어뜨린다(원격은 적대적이라 가정).
 *   - 클라이언트: 적용 전 validateServerMsg(strict) — **모르는 메시지·모르는 필드·잘못된 값이 하나라도 있으면 그 메시지(또는 노드)를 거부**한다.
 *
 * 좌표(v1): 노드의 x,y 는 **부모 기준 지역 좌표**다 — 부모 노드의 padding box(스크롤 컨테이너면 스크롤 콘텐츠) 왼쪽 위가 원점,
 *   w,h 는 변환 전 크기, m 은 부모 기준 지역 변환(상자 중심). 부모가 움직여도 자식은 다시 오지 않는다.
 *   뿌리(p=0)의 자식은 문서 좌표(모든 스크롤 0 기준 = 스크롤 불변), position:fixed 뿌리(fx)는 뷰포트 좌표.
 *   문서·컨테이너 스크롤은 노드 갱신을 만들지 않는다.
 * 노드 id: 수집기(원격 페이지의 격리 world)가 붙인 일련번호 — 문서가 바뀌기 전까지 안정적.
 */

export const PROTOCOL_VERSION = 1

// ── 노드 종류 ──
export type NodeKind = 'box' | 'text' | 'img' | 'svg' | 'widget' | 'inset'

export type WidgetKind = 'text' | 'password' | 'checkbox' | 'radio' | 'select' | 'textarea' | 'button' | 'range'

/** 텍스트 한 줄박스(원격이 이미 줄바꿈·셰이핑을 끝낸 결과) */
export interface TextRun {
  x: number
  y: number
  w: number
  h: number
  /** 제어문자(bidi·zero-width)가 제거된 표시 문자열 */
  t: string
}

/**
 * 고정 폰트 묶음(세션 이미지에 들어 있고 클라이언트도 같은 파일을 WOFF2 로 받는다).
 * 원격 Chromium 이 실제로 쓴 폰트(CSS.getPlatformFontsForNode)를 이 키로 바꿔 보낸다. 작성자 폰트 이름은 클라이언트로 가지 않는다.
 * 클라이언트의 font-family 는 `"jw-<key>"` 목록이다(@font-face 는 /rbi/<sid>/view 문서에 있다).
 */
export const FONT_KEYS = ['lsans', 'lserif', 'lmono', 'dsans', 'dserif', 'dmono', 'cjks', 'cjkm', 'cjkr'] as const
export type FontKey = typeof FONT_KEYS[number]

export type LenUnit = 'px' | '%'
export type SideKw = 't' | 'r' | 'b' | 'l' | 'tr' | 'tl' | 'br' | 'bl'

/** 그라디언트 정지점 [색, 위치?, 단위?] — 색은 rgb()/rgba() 만 */
export type GradStop = [string] | [string, number, LenUnit]

export type Gradient =
  | { k: 'lin'; rep?: true; a: number | SideKw; st: GradStop[] }
  | {
    k: 'rad'; rep?: true; sh: 'circle' | 'ellipse'
    /** 크기 키워드 또는 [rx, 단위, ry, 단위] (circle 이면 ry 무시) */
    sz: 'closest-side' | 'closest-corner' | 'farthest-side' | 'farthest-corner' | [number, LenUnit, number, LenUnit]
    at: [number, LenUnit, number, LenUnit]
    st: GradStop[]
  }

export type BgSize = 'cover' | 'contain' | [number, LenUnit | 'auto', number, LenUnit | 'auto']
export type BgRepeat = 'repeat' | 'no-repeat' | 'repeat-x' | 'repeat-y' | 'space' | 'round'

/** 배경 한 겹 — 이미지(재인코딩 자산 sha) 또는 그라디언트(숫자). url() 원문은 어디에도 없다 */
export interface BgLayer {
  i?: string
  g?: Gradient
  sz?: BgSize
  ps?: [number, LenUnit, number, LenUnit]
  rp?: BgRepeat
}

/** 허용된 계산 스타일 — 키는 짧게, 값은 아래 validateStyle 이 통과시킨 것만 */
export interface StyleRec {
  /** background-color rgb()/rgba() */
  bg?: string
  /** background 레이어(위가 먼저, 최대 4) */
  bgl?: BgLayer[]
  /** color */
  c?: string
  /** 고정 폰트 키 목록(원격이 실제로 쓴 순서) */
  pf?: FontKey[]
  /** font-size px */
  fs?: number
  /** font-weight 1..1000 */
  fw?: number
  /** font-style */
  fi?: 'normal' | 'italic' | 'oblique'
  /** text-decoration-line */
  td?: 'none' | 'underline' | 'line-through' | 'overline'
  /** text-decoration-color */
  tdc?: string
  /** text-transform */
  tt?: 'uppercase' | 'lowercase' | 'capitalize'
  /** letter-spacing px */
  ls?: number
  /** border widths [top,right,bottom,left] px */
  bw?: [number, number, number, number]
  /** border styles */
  bs?: [BorderStyle, BorderStyle, BorderStyle, BorderStyle]
  /** border colors */
  bc?: [string, string, string, string]
  /** border radius [tl,tr,br,bl] px */
  br?: [number, number, number, number]
  /** opacity 0..1 */
  op?: number
  /** box-shadow — 검증된 "x y blur spread color" 목록 */
  sh?: string
  /** outline [width px, style, color] */
  ol?: [number, BorderStyle, string]
  /** cursor 키워드(url() 금지) */
  cur?: string
  /** visibility hidden */
  hid?: boolean
  /** overflow 가 hidden/clip/auto/scroll 이면 true → 자식 잘라냄 */
  clip?: boolean
  /** text-align (위젯 안 텍스트에만 사용) */
  ta?: 'left' | 'right' | 'center'
  /** pointer-events:none — 미러에서도 클릭이 아래로 지나간다 */
  pe?: true
  /** user-select:none — 미러에서도 선택(=복사) 안 됨 */
  nosel?: true
  /** padding [top,right,bottom,left] px — 위젯 안 글자 자리에만 쓴다 */
  pd?: [number, number, number, number]
}

export type BorderStyle = 'none' | 'solid' | 'dashed' | 'dotted' | 'double' | 'inset' | 'outset' | 'groove' | 'ridge' | 'hidden'

/** SVG 기하 — 숫자 속성만. href/filter/mask/clipPath/foreignObject/animate/use/image 는 어휘에 없다 */
export type SvgGeom =
  | { k: 'path'; d: string; st: SvgPaint }
  | { k: 'line'; x1: number; y1: number; x2: number; y2: number; st: SvgPaint }
  | { k: 'rect'; x: number; y: number; w: number; h: number; rx?: number; ry?: number; st: SvgPaint }
  | { k: 'circle'; cx: number; cy: number; r: number; st: SvgPaint }
  | { k: 'ellipse'; cx: number; cy: number; rx: number; ry: number; st: SvgPaint }
  | { k: 'polyline'; pts: string; st: SvgPaint }
  | { k: 'polygon'; pts: string; st: SvgPaint }
  | { k: 'g'; ch: SvgGeom[]; st: SvgPaint }
  | { k: 'text'; x: number; y: number; t: string; st: SvgPaint; fs?: number; fw?: number; pf?: FontKey[]; anc?: 'start' | 'middle' | 'end' }

export interface SvgPaint {
  /** fill 색 또는 'none' */
  f?: string
  /** stroke 색 또는 'none' */
  s?: string
  /** stroke-width px */
  sw?: number
  op?: number
  /** stroke-dasharray 숫자 목록 */
  da?: string
  /** transform 속성 — translate/rotate/scale/matrix 숫자만 */
  tr?: string
  /** stroke-linecap/linejoin */
  lc?: 'butt' | 'round' | 'square'
  lj?: 'miter' | 'round' | 'bevel'
}

export interface VNode {
  id: number
  /** 부모 id. 0 = 문서 루트 */
  p: number
  k: NodeKind
  x: number
  y: number
  w: number
  h: number
  /**
   * 형제 사이 순서 키 = 칠하기 층(0: 정적 흐름, 1: position 이 있는 요소) × 1e6 + 문서 순서.
   * 클라이언트는 이 키로 형제를 정렬한다 — CSS 칠하기 순서(정적 블록 → 위치 요소)를 한 단계 근사.
   */
  o?: number
  /** z-index(위치 요소이고 auto 가 아닐 때만) — 쌓임 맥락을 만든다(원격과 같게) */
  zi?: number
  /** position:fixed 의 뿌리 — x,y 는 뷰포트 좌표, 클라이언트도 fixed 로 둔다 */
  fx?: true
  s?: StyleRec
  /** text */
  runs?: TextRun[]
  /** img: 재인코딩 자산 sha256 */
  a?: string
  /** svg: viewBox [minx,miny,w,h] + 기하 */
  vb?: [number, number, number, number]
  g?: SvgGeom[]
  /** widget */
  wk?: WidgetKind
  /** 위젯이 표시하는 값(password 는 마스킹 문자만). 클라이언트가 텍스트 노드로만 그린다 — 속성 선택자가 닿을 수 없다 */
  wv?: string
  wph?: string
  wc?: boolean
  wdis?: boolean
  /** select 의 표시 텍스트 */
  wopt?: string
  /** range 손잡이 위치(0..1) */
  wr?: number
  /** scroll container: scrollWidth, scrollHeight, scrollLeft, scrollTop */
  sc?: [number, number, number, number]
  /** 부모 기준 지역 선형 변환(CSS matrix 의 a,b,c,d, 상자 중심 기준) — 단위행렬이면 없다(줌 scale·라벨 rotate) */
  m?: [number, number, number, number]
  /** inset: 픽셀로만 보내는 영역(canvas/video/iframe/embed, 아이콘 글리프 래스터는 img) — 프레임은 바이너리로 따로 온다 */
  ik?: 'canvas' | 'video' | 'iframe' | 'embed' | 'other'
}

// ── 메시지 ──
export interface DocInfo {
  /** 원격 문서 전체 크기 */
  cw: number
  ch: number
  /** 원격 뷰포트 */
  vw: number
  vh: number
  /** 원격 문서 스크롤 */
  sx: number
  sy: number
  /** 표시용 URL — 신뢰 크롬(미러 밖)에 텍스트로만 보인다. 링크로 쓰지 않는다 */
  url: string
  title: string
  bg?: string
}

export interface PolicyInfo {
  /** clipboard in: 내 PC → 격리 브라우저(붙여넣기) */
  ci: boolean
  /** clipboard out: 격리 브라우저 → 내 PC(복사) */
  co: boolean
  dl: boolean
  ul: boolean
}

export type NoticeKind =
  | 'blocked-download' | 'blocked-upload' | 'blocked-clip-in' | 'blocked-clip-out' | 'blocked-nav' | 'blocked-popup'
  | 'download' | 'filechooser' | 'limit' | 'degraded'

export type ServerMsg =
  | { t: 'hello'; v: number; sid: string; seq: number; vw: number; vh: number; pol: PolicyInfo }
  | { t: 'snapshot'; seq: number; iseq: number; doc: DocInfo; nodes: VNode[]; ms: number }
  | { t: 'patch'; seq: number; iseq: number; doc?: DocInfo; add: VNode[]; upd: VNode[]; del: number[]; ms: number }
  | { t: 'tick'; seq: number; iseq: number; ms: number }
  /** 원격 포커스 — 위젯이면 그 id, 아니면 0 */
  | { t: 'focus'; id: number }
  /** 로컬 에코 대조 — 포커스된 위젯의 값 해시(fnv1a32)·길이·선택. v 는 password 가 아닐 때만(표시값과 같다) */
  | { t: 'val'; id: number; iseq: number; vh: number; n: number; ss: number; se: number; v?: string }
  /** 원격 선택 텍스트(복사 정책이 허용할 때만) */
  | { t: 'clip'; seq: number; text: string }
  | { t: 'notice'; k: NoticeKind; id?: string; name?: string; size?: number; detail?: string; multi?: boolean }
  /** 원격 페이지의 alert/confirm/prompt/beforeunload — 신뢰 크롬이 자기 UI 로 묻고 dialog 로 답한다 */
  | { t: 'dialog'; id: number; k: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; msg: string; def?: string }
  | { t: 'pong'; ts: number }
  | { t: 'error'; msg: string }

export type Mods = number // 1=Alt 2=Ctrl 4=Meta 8=Shift (CDP 와 같은 비트)

export type ClientMsg =
  /**
   * an(chored): 버튼을 누른 채 움직이는 동안은 rx,ry 가 **누를 때의** 그 노드 상자 기준이다(양쪽이 누를 때 사각형을 기억).
   * 원격 노드가 끌려 움직여도 기준이 따라 움직이지 않아 드래그가 과주행하지 않는다.
   */
  | { t: 'mouse'; type: 'down' | 'up' | 'move' | 'wheel'; id: number; rx: number; ry: number; button?: 'left' | 'right' | 'middle' | 'none'; buttons?: number; clicks?: number; mods?: Mods; dx?: number; dy?: number; an?: boolean; seq: number }
  | { t: 'key'; type: 'down' | 'up'; key: string; code: string; vk: number; text?: string; mods?: Mods; rep?: boolean; seq: number }
  | { t: 'text'; text: string; seq: number }
  | { t: 'paste'; text: string; seq: number }
  | { t: 'comp'; text: string; ss: number; se: number; seq: number }
  | { t: 'compend'; text: string; seq: number }
  | { t: 'scroll'; id: number; sx: number; sy: number; seq: number }
  | { t: 'resize'; w: number; h: number }
  | { t: 'resync' }
  | { t: 'ping'; ts: number }
  /** 원격의 현재 선택 텍스트를 달라(복사 — 로컬 선택이 없을 때) */
  | { t: 'getsel'; seq: number }
  | { t: 'dialog'; id: number; ok: boolean; text?: string }
  /** 파일 선택 대화상자 취소(업로드는 HTTP POST /upload/<id>) */
  | { t: 'chooser'; id: string; cancel: true }

/**
 * 바이너리 프레임(서버→클라) 머리: [0x01][u32 nodeId][u32 seq][u16 w][u16 h][i16 dx][i16 dy] + webp
 * dx,dy: 찍힌 조각이 노드 상자 안에서 놓이는 자리(뷰포트에 일부만 보일 때). 클라이언트는 머리를 검사하고 WebP 바이트만 blob 으로 쓴다.
 */
export const INSET_FRAME_TAG = 0x01
export const INSET_HEADER_BYTES = 1 + 4 + 4 + 2 + 2 + 2 + 2
/** 인셋 프레임 한 장 상한 */
export const MAX_INSET_FRAME_BYTES = 4 * 1024 * 1024

// ── 상한(양쪽 공통) ──
export const LIMITS = {
  /** 한 문서의 노드 수 — 넘으면 에이전트는 'degraded' 알림(픽셀 모드 권고)과 함께 잘라 보낸다 */
  maxNodes: 40000,
  maxRunsPerText: 2000,
  maxTextLen: 10000,
  maxGeom: 5000,
  /** 서버→클라 텍스트 메시지 한 개 */
  maxServerMsgBytes: 16 * 1024 * 1024,
  /** 클라→서버 메시지 한 개 */
  maxClientMsgBytes: 64 * 1024,
  /** 클라→서버 메시지 속도(토큰 버킷) */
  clientMsgsPerSec: 400,
  clientMsgBurst: 1200,
  /** 서버→클라 초당 메시지(인셋 프레임 포함) — 클라이언트가 넘는 것은 버린다 */
  serverMsgsPerSec: 240,
  /** 붙여넣기 메시지 한 개(글자) — 한글 UTF-8 3바이트 × 16000 = 48KB < 메시지 상한 64KB. 긴 붙여넣기는 클라이언트가 나눠 보낸다 */
  maxPasteChars: 16000,
  /** 붙여넣기 한 번 전체(나눈 조각 합) */
  maxPasteTotal: 200000,
  /** 업로드 한 파일 */
  maxUploadBytes: 50 * 1024 * 1024,
} as const

// ── 검증 기본기 ──
const COLOR_RE = /^rgba?\(\d{1,3}, \d{1,3}, \d{1,3}(?:, (?:0|1|0?\.\d{1,6}))?\)$/
const SHA_RE = /^[0-9a-f]{64}$/
const HEX32_RE = /^[0-9a-f]{32}$/
const PATH_D_RE = /^[MmZzLlHhVvCcSsQqTtAa0-9eE.,\s+-]{1,20000}$/
const POINTS_RE = /^[0-9eE.,\s+-]{1,20000}$/
const DASH_RE = /^[0-9. ,]{1,64}$/
const TRANSFORM_RE = /^(?:\s*(?:translate|rotate|scale|skewX|skewY|matrix)\(\s*-?\d+(?:\.\d+)?(?:e-?\d+)?(?:(?:\s*,\s*|\s+)-?\d+(?:\.\d+)?(?:e-?\d+)?){0,5}\s*\)\s*){1,6}$/
const SHADOW_RE = /^(?:(?:inset )?(?:rgba?\(\d{1,3}, \d{1,3}, \d{1,3}(?:, (?:0|1|0?\.\d{1,6}))?\) )?-?\d+(?:\.\d+)?px -?\d+(?:\.\d+)?px(?: -?\d+(?:\.\d+)?px)?(?: -?\d+(?:\.\d+)?px)?(?: rgba?\(\d{1,3}, \d{1,3}, \d{1,3}(?:, (?:0|1|0?\.\d{1,6}))?\))?(?: inset)?(?:, )?){1,4}$/

export const BORDER_STYLES: readonly BorderStyle[] = ['none', 'solid', 'dashed', 'dotted', 'double', 'inset', 'outset', 'groove', 'ridge', 'hidden']
export const CURSORS = new Set(['auto', 'default', 'pointer', 'text', 'move', 'not-allowed', 'crosshair', 'grab', 'grabbing', 'wait', 'progress', 'help',
  'col-resize', 'row-resize', 'n-resize', 's-resize', 'e-resize', 'w-resize', 'ne-resize', 'nw-resize', 'se-resize', 'sw-resize', 'ew-resize', 'ns-resize',
  'nesw-resize', 'nwse-resize', 'zoom-in', 'zoom-out', 'none', 'copy', 'alias', 'context-menu', 'cell', 'vertical-text', 'no-drop', 'all-scroll'])
const SIDE_KW: readonly SideKw[] = ['t', 'r', 'b', 'l', 'tr', 'tl', 'br', 'bl']
const RAD_SZ = ['closest-side', 'closest-corner', 'farthest-side', 'farthest-corner'] as const
const BG_REPEAT: readonly BgRepeat[] = ['repeat', 'no-repeat', 'repeat-x', 'repeat-y', 'space', 'round']

export function isColor(v: unknown): v is string { return typeof v === 'string' && COLOR_RE.test(v) }
export function isNum(v: unknown, min = -1e6, max = 1e6): v is number { return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max }
export function isInt(v: unknown, min = 0, max = 2 ** 31): v is number { return isNum(v, min, max) && Number.isInteger(v) }
export function isSha(v: unknown): v is string { return typeof v === 'string' && SHA_RE.test(v) }
export function isHex32(v: unknown): v is string { return typeof v === 'string' && HEX32_RE.test(v) }
export function isFontKey(v: unknown): v is FontKey { return typeof v === 'string' && (FONT_KEYS as readonly string[]).includes(v) }
const isUnit = (v: unknown): v is LenUnit => v === 'px' || v === '%'

export function cleanShadow(v: unknown): string | undefined {
  return typeof v === 'string' && v !== 'none' && v.length <= 400 && SHADOW_RE.test(v) ? v : undefined
}

export function cleanTransform(v: unknown): string | undefined {
  return typeof v === 'string' && v.length <= 300 && TRANSFORM_RE.test(v) ? v.trim() : undefined
}

/** 제어·보이지 않는 문자 제거(Trojan Source·zero-width) — 표시 문자열만 */
// 소스에 보이지 않는 문자를 두지 않으려고 모두 \u 이스케이프로 적는다(그 자체가 Trojan Source 표면)
// eslint-disable-next-line no-control-regex
const CTRL_RE = new RegExp('[\u200B-\u200F\u2028-\u202E\u2066-\u2069\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]', 'g')
export function cleanText(t: string): string {
  return t.replace(CTRL_RE, '')
}

/** FNV-1a 32비트 — 로컬 에코 대조(값 해시). 양쪽이 같은 함수 */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

function quad<T>(a: unknown, ok: (x: unknown) => x is T): [T, T, T, T] | undefined {
  if (!Array.isArray(a) || a.length !== 4) return undefined
  return a.every(ok) ? (a as [T, T, T, T]) : undefined
}

/** 엄격 모드 보고기 — 엄격 검증에서 무엇이 왜 떨어졌는지(클라이언트 통계·테스트용) */
export interface Strict { strict: boolean; why?: string }
const LENIENT: Strict = { strict: false }
function bad(sx: Strict, why: string): undefined { if (sx.strict && !sx.why) sx.why = why; return undefined }
/** 엄격 모드에서 허용 키 밖이 있으면 거부 */
function keysOk(o: Record<string, unknown>, allowed: ReadonlySet<string>, sx: Strict, what: string): boolean {
  if (!sx.strict) return true
  for (const k of Object.keys(o)) if (!allowed.has(k)) { bad(sx, `${what}: 모르는 필드 ${k}`); return false }
  return true
}

// ── 그라디언트 ──
const GRAD_KEYS = { lin: new Set(['k', 'rep', 'a', 'st']), rad: new Set(['k', 'rep', 'sh', 'sz', 'at', 'st']) }

function validateStops(st: unknown, sx: Strict): GradStop[] | undefined {
  if (!Array.isArray(st) || st.length < 1 || st.length > 32) return bad(sx, 'grad stops')
  const out: GradStop[] = []
  for (const s of st) {
    if (!Array.isArray(s) || !isColor(s[0])) return bad(sx, 'grad stop color')
    if (s.length === 1) out.push([s[0]])
    else if (s.length === 3 && isNum(s[1], -1e5, 1e5) && isUnit(s[2])) out.push([s[0], s[1], s[2]])
    else return bad(sx, 'grad stop pos')
  }
  return out
}

export function validateGradient(g: unknown, sx: Strict = LENIENT): Gradient | undefined {
  if (!g || typeof g !== 'object') return bad(sx, 'grad')
  const r = g as Record<string, unknown>
  if (r.k !== 'lin' && r.k !== 'rad') return bad(sx, 'grad kind')
  if (!keysOk(r, GRAD_KEYS[r.k], sx, 'grad')) return undefined
  if (r.rep !== undefined && r.rep !== true) return bad(sx, 'grad rep')
  const st = validateStops(r.st, sx); if (!st) return undefined
  if (r.k === 'lin') {
    const a = r.a
    if (!(isNum(a, -3600, 3600) || (typeof a === 'string' && (SIDE_KW as readonly string[]).includes(a)))) return bad(sx, 'grad angle')
    const o: Gradient = { k: 'lin', a: a as number | SideKw, st }
    if (r.rep) o.rep = true
    return o
  }
  if (r.sh !== 'circle' && r.sh !== 'ellipse') return bad(sx, 'grad shape')
  let sz: Extract<Gradient, { k: 'rad' }>['sz']
  if (typeof r.sz === 'string' && (RAD_SZ as readonly string[]).includes(r.sz)) sz = r.sz as typeof RAD_SZ[number]
  else if (Array.isArray(r.sz) && r.sz.length === 4 && isNum(r.sz[0], 0, 1e5) && isUnit(r.sz[1]) && isNum(r.sz[2], 0, 1e5) && isUnit(r.sz[3])) sz = [r.sz[0], r.sz[1], r.sz[2], r.sz[3]]
  else return bad(sx, 'grad size')
  const at = r.at
  if (!(Array.isArray(at) && at.length === 4 && isNum(at[0], -1e5, 1e5) && isUnit(at[1]) && isNum(at[2], -1e5, 1e5) && isUnit(at[3]))) return bad(sx, 'grad at')
  const o: Gradient = { k: 'rad', sh: r.sh, sz, at: [at[0], at[1], at[2], at[3]] as [number, LenUnit, number, LenUnit], st }
  if (r.rep) o.rep = true
  return o
}

const BG_KEYS = new Set(['i', 'g', 'sz', 'ps', 'rp'])
export function validateBgLayer(l: unknown, sx: Strict = LENIENT): BgLayer | undefined {
  if (!l || typeof l !== 'object') return bad(sx, 'bg layer')
  const r = l as Record<string, unknown>
  if (!keysOk(r, BG_KEYS, sx, 'bg')) return undefined
  const out: BgLayer = {}
  if (r.i !== undefined) { if (!isSha(r.i)) return bad(sx, 'bg sha'); out.i = r.i }
  if (r.g !== undefined) { const g = validateGradient(r.g, sx); if (!g) return undefined; out.g = g }
  if ((out.i ? 1 : 0) + (out.g ? 1 : 0) !== 1) return bad(sx, 'bg: 이미지 또는 그라디언트 하나')
  if (r.sz !== undefined) {
    const z = r.sz
    const lenOrAuto = (u: unknown) => u === 'px' || u === '%' || u === 'auto'
    if (z === 'cover' || z === 'contain') out.sz = z
    else if (Array.isArray(z) && z.length === 4 && isNum(z[0], 0, 1e5) && lenOrAuto(z[1]) && isNum(z[2], 0, 1e5) && lenOrAuto(z[3])) out.sz = [z[0], z[1], z[2], z[3]] as BgSize
    else return bad(sx, 'bg size')
  }
  if (r.ps !== undefined) {
    const p = r.ps
    if (Array.isArray(p) && p.length === 4 && isNum(p[0], -1e5, 1e5) && isUnit(p[1]) && isNum(p[2], -1e5, 1e5) && isUnit(p[3])) out.ps = [p[0], p[1], p[2], p[3]] as BgLayer['ps']
    else return bad(sx, 'bg pos')
  }
  if (r.rp !== undefined) { if (!(BG_REPEAT as readonly string[]).includes(r.rp as string)) return bad(sx, 'bg repeat'); out.rp = r.rp as BgRepeat }
  return out
}

/** 검증된 그라디언트 → CSS 문자열(클라이언트가 setProperty 로만 쓴다). 숫자·rgb()·키워드만 이어 붙이므로 url() 이 생길 수 없다 */
export function gradientCss(g: Gradient): string {
  const stops = g.st.map(s => (s.length === 3 ? `${s[0]} ${s[1]}${s[2]}` : s[0])).join(', ')
  const SIDE: Record<SideKw, string> = { t: 'to top', r: 'to right', b: 'to bottom', l: 'to left', tr: 'to top right', tl: 'to top left', br: 'to bottom right', bl: 'to bottom left' }
  if (g.k === 'lin') {
    const a = typeof g.a === 'number' ? `${g.a}deg` : SIDE[g.a]
    return `${g.rep ? 'repeating-' : ''}linear-gradient(${a}, ${stops})`
  }
  const sz = typeof g.sz === 'string' ? g.sz : g.sh === 'circle' ? `${g.sz[0]}${g.sz[1]}` : `${g.sz[0]}${g.sz[1]} ${g.sz[2]}${g.sz[3]}`
  return `${g.rep ? 'repeating-' : ''}radial-gradient(${g.sh} ${sz} at ${g.at[0]}${g.at[1]} ${g.at[2]}${g.at[3]}, ${stops})`
}

// ── 스타일 ──
const STYLE_KEYS = new Set(['bg', 'bgl', 'c', 'pf', 'fs', 'fw', 'fi', 'td', 'tdc', 'tt', 'ls', 'bw', 'bs', 'bc', 'br', 'op', 'sh', 'ol', 'cur', 'hid', 'clip', 'ta', 'pe', 'nosel', 'pd'])

/**
 * 스타일 레코드 검증.
 * lenient(에이전트): 모르는 키는 버리고, 값이 문법에 안 맞으면 그 키만 버린다.
 * strict(클라이언트): 모르는 키·틀린 값이 하나라도 있으면 undefined(노드 거부).
 */
export function validateStyle(s: unknown, sx: Strict = LENIENT): StyleRec | undefined {
  const out: StyleRec = {}
  if (!s || typeof s !== 'object' || Array.isArray(s)) return sx.strict ? bad(sx, 'style') : out
  const r = s as Record<string, unknown>
  if (!keysOk(r, STYLE_KEYS, sx, 'style')) return undefined
  const fail = (k: string) => { if (sx.strict) { bad(sx, `style.${k}`); return true } return false }
  const has = (k: string) => r[k] !== undefined
  if (has('bg')) { if (isColor(r.bg)) out.bg = r.bg; else if (fail('bg')) return undefined }
  if (has('bgl')) {
    if (Array.isArray(r.bgl) && r.bgl.length >= 1 && r.bgl.length <= 4) {
      const ls: BgLayer[] = []
      for (const l of r.bgl) { const v = validateBgLayer(l, sx); if (v) ls.push(v); else if (sx.strict) return undefined }
      if (ls.length) out.bgl = ls
    } else if (fail('bgl')) return undefined
  }
  if (has('c')) { if (isColor(r.c)) out.c = r.c; else if (fail('c')) return undefined }
  if (has('pf')) {
    if (Array.isArray(r.pf) && r.pf.length >= 1 && r.pf.length <= 4 && r.pf.every(isFontKey)) out.pf = [...r.pf] as FontKey[]
    else if (fail('pf')) return undefined
  }
  if (has('fs')) { if (isNum(r.fs, 0, 500)) out.fs = r.fs; else if (fail('fs')) return undefined }
  if (has('fw')) { if (isNum(r.fw, 1, 1000)) out.fw = r.fw; else if (fail('fw')) return undefined }
  if (has('fi')) { if (r.fi === 'normal' || r.fi === 'italic' || r.fi === 'oblique') out.fi = r.fi; else if (fail('fi')) return undefined }
  if (has('td')) { if (r.td === 'none' || r.td === 'underline' || r.td === 'line-through' || r.td === 'overline') out.td = r.td; else if (fail('td')) return undefined }
  if (has('tdc')) { if (isColor(r.tdc)) out.tdc = r.tdc; else if (fail('tdc')) return undefined }
  if (has('tt')) { if (r.tt === 'uppercase' || r.tt === 'lowercase' || r.tt === 'capitalize') out.tt = r.tt; else if (fail('tt')) return undefined }
  if (has('ls')) { if (isNum(r.ls, -50, 50)) out.ls = r.ls; else if (fail('ls')) return undefined }
  if (has('bw')) { const v = quad(r.bw, (x): x is number => isNum(x, 0, 200)); if (v) out.bw = v; else if (fail('bw')) return undefined }
  if (has('bs')) { const v = quad(r.bs, (x): x is BorderStyle => typeof x === 'string' && (BORDER_STYLES as readonly string[]).includes(x)); if (v) out.bs = v; else if (fail('bs')) return undefined }
  if (has('bc')) { const v = quad(r.bc, isColor); if (v) out.bc = v; else if (fail('bc')) return undefined }
  if (has('br')) { const v = quad(r.br, (x): x is number => isNum(x, 0, 2000)); if (v) out.br = v; else if (fail('br')) return undefined }
  if (has('op')) { if (isNum(r.op, 0, 1)) out.op = r.op; else if (fail('op')) return undefined }
  if (has('sh')) { const v = cleanShadow(r.sh); if (v) out.sh = v; else if (fail('sh')) return undefined }
  if (has('ol')) {
    const o = r.ol
    if (Array.isArray(o) && o.length === 3 && isNum(o[0], 0, 100) && (BORDER_STYLES as readonly string[]).includes(o[1]) && isColor(o[2])) out.ol = [o[0], o[1] as BorderStyle, o[2]]
    else if (fail('ol')) return undefined
  }
  if (has('cur')) { if (typeof r.cur === 'string' && CURSORS.has(r.cur)) out.cur = r.cur; else if (fail('cur')) return undefined }
  if (has('hid')) { if (r.hid === true) out.hid = true; else if (fail('hid')) return undefined }
  if (has('clip')) { if (r.clip === true) out.clip = true; else if (fail('clip')) return undefined }
  if (has('ta')) { if (r.ta === 'left' || r.ta === 'right' || r.ta === 'center') out.ta = r.ta; else if (fail('ta')) return undefined }
  if (has('pe')) { if (r.pe === true) out.pe = true; else if (fail('pe')) return undefined }
  if (has('nosel')) { if (r.nosel === true) out.nosel = true; else if (fail('nosel')) return undefined }
  if (has('pd')) { const v = quad(r.pd, (x): x is number => isNum(x, 0, 2000)); if (v) out.pd = v; else if (fail('pd')) return undefined }
  return out
}

const PAINT_KEYS = new Set(['f', 's', 'sw', 'op', 'da', 'tr', 'lc', 'lj'])
export function validatePaint(p: unknown, sx: Strict = LENIENT): SvgPaint | undefined {
  const out: SvgPaint = {}
  if (p === undefined) return out
  if (!p || typeof p !== 'object') return sx.strict ? bad(sx, 'paint') : out
  const r = p as Record<string, unknown>
  if (!keysOk(r, PAINT_KEYS, sx, 'paint')) return undefined
  const fail = (k: string) => { if (sx.strict) { bad(sx, `paint.${k}`); return true } return false }
  if (r.f !== undefined) { if (isColor(r.f) || r.f === 'none') out.f = r.f as string; else if (fail('f')) return undefined }
  if (r.s !== undefined) { if (isColor(r.s) || r.s === 'none') out.s = r.s as string; else if (fail('s')) return undefined }
  if (r.sw !== undefined) { if (isNum(r.sw, 0, 500)) out.sw = r.sw; else if (fail('sw')) return undefined }
  if (r.op !== undefined) { if (isNum(r.op, 0, 1)) out.op = r.op; else if (fail('op')) return undefined }
  if (r.da !== undefined) { if (typeof r.da === 'string' && DASH_RE.test(r.da)) out.da = r.da; else if (fail('da')) return undefined }
  if (r.tr !== undefined) { const tr = cleanTransform(r.tr); if (tr) out.tr = tr; else if (fail('tr')) return undefined }
  if (r.lc !== undefined) { if (r.lc === 'butt' || r.lc === 'round' || r.lc === 'square') out.lc = r.lc; else if (fail('lc')) return undefined }
  if (r.lj !== undefined) { if (r.lj === 'miter' || r.lj === 'round' || r.lj === 'bevel') out.lj = r.lj; else if (fail('lj')) return undefined }
  return out
}

const GEOM_KEYS: Record<string, ReadonlySet<string>> = {
  path: new Set(['k', 'd', 'st']), line: new Set(['k', 'x1', 'y1', 'x2', 'y2', 'st']), rect: new Set(['k', 'x', 'y', 'w', 'h', 'rx', 'ry', 'st']),
  circle: new Set(['k', 'cx', 'cy', 'r', 'st']), ellipse: new Set(['k', 'cx', 'cy', 'rx', 'ry', 'st']), polyline: new Set(['k', 'pts', 'st']),
  polygon: new Set(['k', 'pts', 'st']), g: new Set(['k', 'ch', 'st']), text: new Set(['k', 'x', 'y', 't', 'st', 'fs', 'fw', 'pf', 'anc']),
}

export function validateGeom(g: unknown, depth = 0, sx: Strict = LENIENT): SvgGeom | undefined {
  if (!g || typeof g !== 'object' || depth > 8) return bad(sx, 'geom')
  const r = g as Record<string, unknown>
  const keys = typeof r.k === 'string' ? GEOM_KEYS[r.k] : undefined
  if (!keys) return bad(sx, `geom kind ${String(r.k)}`)
  if (!keysOk(r, keys, sx, 'geom')) return undefined
  const st = validatePaint(r.st, sx)
  if (!st) return undefined
  const nums = (...vs: unknown[]) => vs.every(v => isNum(v))
  switch (r.k) {
    case 'path': return typeof r.d === 'string' && PATH_D_RE.test(r.d) ? { k: 'path', d: r.d, st } : bad(sx, 'path d')
    case 'line': return nums(r.x1, r.y1, r.x2, r.y2) ? { k: 'line', x1: r.x1 as number, y1: r.y1 as number, x2: r.x2 as number, y2: r.y2 as number, st } : bad(sx, 'line')
    case 'rect': {
      if (!nums(r.x, r.y, r.w, r.h)) return bad(sx, 'rect')
      const o: SvgGeom = { k: 'rect', x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number, st }
      if (r.rx !== undefined) { if (isNum(r.rx, 0)) o.rx = r.rx; else if (sx.strict) return bad(sx, 'rect rx') }
      if (r.ry !== undefined) { if (isNum(r.ry, 0)) o.ry = r.ry; else if (sx.strict) return bad(sx, 'rect ry') }
      return o
    }
    case 'circle': return nums(r.cx, r.cy) && isNum(r.r, 0) ? { k: 'circle', cx: r.cx as number, cy: r.cy as number, r: r.r as number, st } : bad(sx, 'circle')
    case 'ellipse': return nums(r.cx, r.cy) && isNum(r.rx, 0) && isNum(r.ry, 0) ? { k: 'ellipse', cx: r.cx as number, cy: r.cy as number, rx: r.rx as number, ry: r.ry as number, st } : bad(sx, 'ellipse')
    case 'polyline': return typeof r.pts === 'string' && POINTS_RE.test(r.pts) ? { k: 'polyline', pts: r.pts, st } : bad(sx, 'polyline')
    case 'polygon': return typeof r.pts === 'string' && POINTS_RE.test(r.pts) ? { k: 'polygon', pts: r.pts, st } : bad(sx, 'polygon')
    case 'g': {
      if (!Array.isArray(r.ch) || r.ch.length > LIMITS.maxGeom) return bad(sx, 'g ch')
      const ch: SvgGeom[] = []
      for (const c of r.ch) { const v = validateGeom(c, depth + 1, sx); if (v) ch.push(v); else if (sx.strict) return undefined }
      return { k: 'g', ch, st }
    }
    case 'text': {
      if (!nums(r.x, r.y) || typeof r.t !== 'string') return bad(sx, 'svg text')
      const o: Extract<SvgGeom, { k: 'text' }> = { k: 'text', x: r.x as number, y: r.y as number, t: cleanText(r.t).slice(0, 2000), st }
      if (sx.strict && o.t !== r.t) return bad(sx, 'svg text ctrl')
      if (r.fs !== undefined) { if (isNum(r.fs, 0, 500)) o.fs = r.fs; else if (sx.strict) return bad(sx, 'svg text fs') }
      if (r.fw !== undefined) { if (isNum(r.fw, 1, 1000)) o.fw = r.fw; else if (sx.strict) return bad(sx, 'svg text fw') }
      if (r.pf !== undefined) { if (Array.isArray(r.pf) && r.pf.length <= 4 && r.pf.every(isFontKey)) o.pf = [...r.pf] as FontKey[]; else if (sx.strict) return bad(sx, 'svg text pf') }
      if (r.anc !== undefined) { if (r.anc === 'start' || r.anc === 'middle' || r.anc === 'end') o.anc = r.anc; else if (sx.strict) return bad(sx, 'svg text anc') }
      return o
    }
    default: return bad(sx, 'geom kind')
  }
}

const KINDS: readonly NodeKind[] = ['box', 'text', 'img', 'svg', 'widget', 'inset']
const WKINDS: readonly WidgetKind[] = ['text', 'password', 'checkbox', 'radio', 'select', 'textarea', 'button', 'range']
const IKINDS = ['canvas', 'video', 'iframe', 'embed', 'other'] as const
const NODE_KEYS = new Set(['id', 'p', 'k', 'x', 'y', 'w', 'h', 'o', 'zi', 'fx', 's', 'runs', 'a', 'vb', 'g', 'wk', 'wv', 'wph', 'wc', 'wdis', 'wopt', 'wr', 'sc', 'm', 'ik'])
const RUN_KEYS = new Set(['x', 'y', 'w', 'h', 't'])

/**
 * 노드 하나를 검증해 어휘 밖 필드가 하나도 남지 않은 사본을 돌려준다. 못 쓰면 undefined.
 * strict: 모르는 필드·틀린 값·제어문자가 섞인 텍스트가 하나라도 있으면 거부(클라이언트).
 */
export function validateNode(n: unknown, sx: Strict = LENIENT): VNode | undefined {
  if (!n || typeof n !== 'object' || Array.isArray(n)) return bad(sx, 'node')
  const r = n as Record<string, unknown>
  if (!keysOk(r, NODE_KEYS, sx, 'node')) return undefined
  if (!isInt(r.id, 1) || !isInt(r.p, 0)) return bad(sx, 'node id')
  if (typeof r.k !== 'string' || !(KINDS as readonly string[]).includes(r.k)) return bad(sx, 'node kind')
  if (![r.x, r.y, r.w, r.h].every(v => isNum(v, -1e6, 1e6))) return bad(sx, 'node box')
  const out: VNode = { id: r.id, p: r.p, k: r.k as NodeKind, x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number }
  const fail = (k: string) => { if (sx.strict) { bad(sx, `node.${k}`); return true } return false }
  if (r.o !== undefined) { if (isNum(r.o, 0, 1e9)) out.o = r.o; else if (fail('o')) return undefined }
  if (r.zi !== undefined) { if (isInt(r.zi, -1e7, 1e7)) out.zi = r.zi; else if (fail('zi')) return undefined }
  if (r.fx !== undefined) { if (r.fx === true) out.fx = true; else if (fail('fx')) return undefined }
  if (r.s !== undefined) { const s = validateStyle(r.s, sx); if (s) out.s = s; else if (sx.strict) return undefined }
  if (r.runs !== undefined) {
    if (!Array.isArray(r.runs) || r.runs.length > LIMITS.maxRunsPerText) { if (fail('runs')) return undefined } else {
      out.runs = []
      for (const run of r.runs) {
        if (!run || typeof run !== 'object') { if (fail('run')) return undefined; continue }
        const q = run as Record<string, unknown>
        if (!keysOk(q, RUN_KEYS, sx, 'run')) return undefined
        if ([q.x, q.y, q.w, q.h].every(v => isNum(v)) && typeof q.t === 'string') {
          const t = cleanText(q.t).slice(0, LIMITS.maxTextLen)
          if (sx.strict && t !== q.t) return bad(sx, 'run text')
          out.runs.push({ x: q.x as number, y: q.y as number, w: q.w as number, h: q.h as number, t })
        } else if (fail('run')) return undefined
      }
    }
  }
  if (r.a !== undefined) { if (isSha(r.a)) out.a = r.a; else if (fail('a')) return undefined }
  if (r.vb !== undefined) { if (Array.isArray(r.vb) && r.vb.length === 4 && r.vb.every(v => isNum(v))) out.vb = r.vb as VNode['vb']; else if (fail('vb')) return undefined }
  if (r.g !== undefined) {
    if (!Array.isArray(r.g) || r.g.length > LIMITS.maxGeom) { if (fail('g')) return undefined } else {
      out.g = []
      for (const g of r.g) { const v = validateGeom(g, 0, sx); if (v) out.g.push(v); else if (sx.strict) return undefined }
    }
  }
  if (r.wk !== undefined) { if (typeof r.wk === 'string' && (WKINDS as readonly string[]).includes(r.wk)) out.wk = r.wk as WidgetKind; else if (fail('wk')) return undefined }
  for (const [k, max] of [['wv', LIMITS.maxTextLen], ['wph', 500], ['wopt', 500]] as const) {
    const v = r[k]
    if (v === undefined) continue
    if (typeof v !== 'string') { if (fail(k)) return undefined; continue }
    const c = cleanText(v).slice(0, max)
    if (sx.strict && c !== v) return bad(sx, `node.${k} text`)
    out[k] = c
  }
  if (r.wc !== undefined) { if (r.wc === true) out.wc = true; else if (fail('wc')) return undefined }
  if (r.wr !== undefined) { if (isNum(r.wr, 0, 1)) out.wr = r.wr; else if (fail('wr')) return undefined }
  if (r.wdis !== undefined) { if (r.wdis === true) out.wdis = true; else if (fail('wdis')) return undefined }
  if (r.sc !== undefined) { if (Array.isArray(r.sc) && r.sc.length === 4 && r.sc.every(v => isNum(v, -1e6, 1e7))) out.sc = r.sc as VNode['sc']; else if (fail('sc')) return undefined }
  if (r.m !== undefined) { if (Array.isArray(r.m) && r.m.length === 4 && r.m.every(v => isNum(v, -100, 100))) out.m = r.m as VNode['m']; else if (fail('m')) return undefined }
  if (r.ik !== undefined) { if (typeof r.ik === 'string' && (IKINDS as readonly string[]).includes(r.ik)) out.ik = r.ik as VNode['ik']; else if (fail('ik')) return undefined }
  return out
}

// ── 메시지 검증(클라이언트: 엄격) ──
const DOC_KEYS = new Set(['cw', 'ch', 'vw', 'vh', 'sx', 'sy', 'url', 'title', 'bg'])
export function validateDoc(d: unknown, sx: Strict = LENIENT): DocInfo | undefined {
  if (!d || typeof d !== 'object') return bad(sx, 'doc')
  const r = d as Record<string, unknown>
  if (!keysOk(r, DOC_KEYS, sx, 'doc')) return undefined
  if (![r.cw, r.ch].every(v => isNum(v, 0, 1e7)) || ![r.vw, r.vh].every(v => isNum(v, 0, 1e5)) || ![r.sx, r.sy].every(v => isNum(v, -1e7, 1e7))) return bad(sx, 'doc nums')
  if (typeof r.url !== 'string' || r.url.length > 4096 || typeof r.title !== 'string' || r.title.length > 400) return bad(sx, 'doc strings')
  const url = cleanText(r.url), title = cleanText(r.title)
  if (sx.strict && (url !== r.url || title !== r.title)) return bad(sx, 'doc ctrl')
  const out: DocInfo = { cw: r.cw as number, ch: r.ch as number, vw: r.vw as number, vh: r.vh as number, sx: r.sx as number, sy: r.sy as number, url, title }
  if (r.bg !== undefined) { if (isColor(r.bg)) out.bg = r.bg; else if (sx.strict) return bad(sx, 'doc bg') }
  return out
}

const NOTICE_KINDS: readonly NoticeKind[] = ['blocked-download', 'blocked-upload', 'blocked-clip-in', 'blocked-clip-out', 'blocked-nav', 'blocked-popup', 'download', 'filechooser', 'limit', 'degraded']
const MSG_KEYS: Record<string, ReadonlySet<string>> = {
  hello: new Set(['t', 'v', 'sid', 'seq', 'vw', 'vh', 'pol']),
  snapshot: new Set(['t', 'seq', 'iseq', 'doc', 'nodes', 'ms']),
  patch: new Set(['t', 'seq', 'iseq', 'doc', 'add', 'upd', 'del', 'ms']),
  tick: new Set(['t', 'seq', 'iseq', 'ms']),
  focus: new Set(['t', 'id']),
  val: new Set(['t', 'id', 'iseq', 'vh', 'n', 'ss', 'se', 'v']),
  clip: new Set(['t', 'seq', 'text']),
  notice: new Set(['t', 'k', 'id', 'name', 'size', 'detail', 'multi']),
  dialog: new Set(['t', 'id', 'k', 'msg', 'def']),
  pong: new Set(['t', 'ts']),
  error: new Set(['t', 'msg']),
}
const POL_KEYS = new Set(['ci', 'co', 'dl', 'ul'])

export interface MsgReject { why: string; rejectedNodes: number }

/**
 * 서버 메시지 엄격 검증 — 클라이언트는 이 결과만 적용한다.
 * 모르는 메시지 종류·모르는 최상위 필드 → 메시지 전체 거부. 노드는 하나씩 엄격 검증해 틀린 노드만 빼고 rej 에 센다.
 */
export function validateServerMsg(m: unknown, rej?: MsgReject): ServerMsg | undefined {
  const sx: Strict = { strict: true }
  const no = (why: string) => { if (rej) rej.why = why; return undefined }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return no('not object')
  const r = m as Record<string, unknown>
  const keys = typeof r.t === 'string' ? MSG_KEYS[r.t] : undefined
  if (!keys) return no(`모르는 메시지 ${String(r.t).slice(0, 20)}`)
  if (!keysOk(r, keys, sx, `msg ${r.t}`)) return no(sx.why || 'fields')
  const nodes = (arr: unknown): VNode[] | undefined => {
    if (!Array.isArray(arr) || arr.length > LIMITS.maxNodes) return undefined
    const out: VNode[] = []
    for (const n of arr) {
      const s2: Strict = { strict: true }
      const v = validateNode(n, s2)
      if (v) out.push(v)
      else if (rej) { rej.rejectedNodes++; if (!rej.why) rej.why = s2.why || 'node' }
    }
    return out
  }
  const seqs = () => isInt(r.seq, 0) && isInt(r.iseq, 0) && isNum(r.ms, 0, 1e7)
  switch (r.t) {
    case 'hello': {
      const p = r.pol as Record<string, unknown> | undefined
      if (!isInt(r.v, 0, 1000) || typeof r.sid !== 'string' || r.sid.length > 64 || !isInt(r.seq, 0) || !isNum(r.vw, 0, 1e5) || !isNum(r.vh, 0, 1e5)) return no('hello')
      if (!p || typeof p !== 'object' || !keysOk(p, POL_KEYS, sx, 'pol') || ![p.ci, p.co, p.dl, p.ul].every(b => typeof b === 'boolean')) return no('hello pol')
      return { t: 'hello', v: r.v, sid: r.sid, seq: r.seq, vw: r.vw as number, vh: r.vh as number, pol: { ci: p.ci as boolean, co: p.co as boolean, dl: p.dl as boolean, ul: p.ul as boolean } }
    }
    case 'snapshot': {
      if (!seqs()) return no('snapshot seq')
      const doc = validateDoc(r.doc, sx); if (!doc) return no(sx.why || 'doc')
      const ns = nodes(r.nodes); if (!ns) return no('snapshot nodes')
      return { t: 'snapshot', seq: r.seq as number, iseq: r.iseq as number, doc, nodes: ns, ms: r.ms as number }
    }
    case 'patch': {
      if (!seqs()) return no('patch seq')
      let doc: DocInfo | undefined
      if (r.doc !== undefined) { doc = validateDoc(r.doc, sx); if (!doc) return no(sx.why || 'doc') }
      const add = nodes(r.add), upd = nodes(r.upd)
      if (!add || !upd) return no('patch nodes')
      if (!Array.isArray(r.del) || r.del.length > LIMITS.maxNodes || !r.del.every(x => isInt(x, 1))) return no('patch del')
      const out: ServerMsg = { t: 'patch', seq: r.seq as number, iseq: r.iseq as number, add, upd, del: [...r.del] as number[], ms: r.ms as number }
      if (doc) out.doc = doc
      return out
    }
    case 'tick': return seqs() ? { t: 'tick', seq: r.seq as number, iseq: r.iseq as number, ms: r.ms as number } : no('tick')
    case 'focus': return isInt(r.id, 0) ? { t: 'focus', id: r.id } : no('focus')
    case 'val': {
      if (!isInt(r.id, 0) || !isInt(r.iseq, 0) || !isInt(r.vh, 0, 2 ** 32) || !isInt(r.n, 0, 1e7) || !isInt(r.ss, 0, 1e7) || !isInt(r.se, 0, 1e7)) return no('val')
      const out: ServerMsg = { t: 'val', id: r.id, iseq: r.iseq, vh: r.vh, n: r.n, ss: r.ss, se: r.se }
      if (r.v !== undefined) {
        if (typeof r.v !== 'string' || r.v.length > LIMITS.maxTextLen || cleanText(r.v) !== r.v) return no('val v')
        out.v = r.v
      }
      return out
    }
    case 'clip': {
      if (!isInt(r.seq, 0) || typeof r.text !== 'string' || r.text.length > LIMITS.maxPasteTotal) return no('clip')
      return { t: 'clip', seq: r.seq, text: r.text }
    }
    case 'notice': {
      if (typeof r.k !== 'string' || !(NOTICE_KINDS as readonly string[]).includes(r.k)) return no('notice kind')
      const out: ServerMsg = { t: 'notice', k: r.k as NoticeKind }
      if (r.id !== undefined) { if (!isHex32(r.id)) return no('notice id'); out.id = r.id }
      if (r.name !== undefined) { if (typeof r.name !== 'string' || r.name.length > 255 || cleanText(r.name) !== r.name) return no('notice name'); out.name = r.name }
      if (r.size !== undefined) { if (!isInt(r.size, 0, 2 ** 40)) return no('notice size'); out.size = r.size }
      if (r.detail !== undefined) { if (typeof r.detail !== 'string' || r.detail.length > 2048 || cleanText(r.detail) !== r.detail) return no('notice detail'); out.detail = r.detail }
      if (r.multi !== undefined) { if (typeof r.multi !== 'boolean') return no('notice multi'); out.multi = r.multi }
      return out
    }
    case 'dialog': {
      if (!isInt(r.id, 0) || !['alert', 'confirm', 'prompt', 'beforeunload'].includes(r.k as string) || typeof r.msg !== 'string' || r.msg.length > 4000 || cleanText(r.msg) !== r.msg) return no('dialog')
      const out: ServerMsg = { t: 'dialog', id: r.id, k: r.k as 'alert', msg: r.msg }
      if (r.def !== undefined) { if (typeof r.def !== 'string' || r.def.length > 4000 || cleanText(r.def) !== r.def) return no('dialog def'); out.def = r.def }
      return out
    }
    case 'pong': return isNum(r.ts, 0, 1e13) ? { t: 'pong', ts: r.ts as number } : no('pong')
    case 'error': return typeof r.msg === 'string' && r.msg.length <= 500 ? { t: 'error', msg: cleanText(r.msg) } : no('error')
    default: return no('kind')
  }
}

// ── 클라이언트 메시지 검증(에이전트: 엄격 — 모르는 것은 버린다) ──
const CMSG_KEYS: Record<string, ReadonlySet<string>> = {
  mouse: new Set(['t', 'type', 'id', 'rx', 'ry', 'button', 'buttons', 'clicks', 'mods', 'dx', 'dy', 'an', 'seq']),
  key: new Set(['t', 'type', 'key', 'code', 'vk', 'text', 'mods', 'rep', 'seq']),
  text: new Set(['t', 'text', 'seq']),
  paste: new Set(['t', 'text', 'seq']),
  comp: new Set(['t', 'text', 'ss', 'se', 'seq']),
  compend: new Set(['t', 'text', 'seq']),
  scroll: new Set(['t', 'id', 'sx', 'sy', 'seq']),
  resize: new Set(['t', 'w', 'h']),
  resync: new Set(['t']),
  ping: new Set(['t', 'ts']),
  getsel: new Set(['t', 'seq']),
  dialog: new Set(['t', 'id', 'ok', 'text']),
  chooser: new Set(['t', 'id', 'cancel']),
}
const KEY_RE = /^[\x20-\x7e]{1,32}$|^.{1,4}$/su

export function validateClientMsg(m: unknown): ClientMsg | undefined {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return undefined
  const r = m as Record<string, unknown>
  const keys = typeof r.t === 'string' ? CMSG_KEYS[r.t] : undefined
  if (!keys) return undefined
  for (const k of Object.keys(r)) if (!keys.has(k)) return undefined
  const seq = isInt(r.seq, 0)
  const mods = r.mods === undefined || isInt(r.mods, 0, 15)
  const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max
  switch (r.t) {
    case 'mouse': {
      if (!seq || !mods || !['down', 'up', 'move', 'wheel'].includes(r.type as string) || !isInt(r.id, 0) || !isNum(r.rx, -1e5, 1e5) || !isNum(r.ry, -1e5, 1e5)) return undefined
      if (r.button !== undefined && !['left', 'right', 'middle', 'none'].includes(r.button as string)) return undefined
      if (r.buttons !== undefined && !isInt(r.buttons, 0, 31)) return undefined
      if (r.clicks !== undefined && !isInt(r.clicks, 0, 3)) return undefined
      if (r.dx !== undefined && !isNum(r.dx, -1e5, 1e5)) return undefined
      if (r.dy !== undefined && !isNum(r.dy, -1e5, 1e5)) return undefined
      if (r.an !== undefined && typeof r.an !== 'boolean') return undefined
      return r as ClientMsg
    }
    case 'key':
      if (!seq || !mods || (r.type !== 'down' && r.type !== 'up') || !str(r.key, 32) || !KEY_RE.test(r.key as string) || !str(r.code, 32) || !isInt(r.vk, 0, 255)) return undefined
      if (r.text !== undefined && !str(r.text, 8)) return undefined
      if (r.rep !== undefined && typeof r.rep !== 'boolean') return undefined
      return r as ClientMsg
    case 'text': case 'compend': return seq && str(r.text, 10000) ? r as ClientMsg : undefined
    case 'paste': return seq && str(r.text, LIMITS.maxPasteChars) ? r as ClientMsg : undefined
    case 'comp': return seq && str(r.text, 1000) && isInt(r.ss, 0, 1000) && isInt(r.se, 0, 1000) ? r as ClientMsg : undefined
    case 'scroll': return seq && isInt(r.id, 0) && isNum(r.sx, -1e7, 1e7) && isNum(r.sy, -1e7, 1e7) ? r as ClientMsg : undefined
    case 'resize': return isNum(r.w, 1, 1e5) && isNum(r.h, 1, 1e5) ? r as ClientMsg : undefined
    case 'resync': return r as ClientMsg
    case 'ping': return isNum(r.ts, 0, 1e13) ? r as ClientMsg : undefined
    case 'getsel': return seq ? r as ClientMsg : undefined
    case 'dialog': return isInt(r.id, 0) && typeof r.ok === 'boolean' && (r.text === undefined || str(r.text, 4000)) ? r as ClientMsg : undefined
    case 'chooser': return isHex32(r.id) && r.cancel === true ? r as ClientMsg : undefined
    default: return undefined
  }
}

/** 고정 폰트 키 → 클라이언트 CSS font-family(키는 열거형이라 따옴표 안이 항상 [a-z]) */
export function fontFamilyCss(pf: readonly FontKey[] | undefined): string {
  const keys = pf && pf.length ? pf : (['lsans', 'cjks'] as const)
  const list = keys.map(k => `"jw-${k}"`)
  // 마지막 대비책도 우리 묶음 안에서(DejaVu 는 기호·그리스·키릴 범위가 넓다)
  if (!keys.includes('dsans')) list.push('"jw-dsans"')
  if (!keys.includes('cjks')) list.push('"jw-cjks"')
  return list.join(', ')
}

/**
 * 에이전트가 원격에서 읽는 계산 스타일 목록 — 여기 없는 속성은 읽지도 않는다.
 * 순서가 곧 수집기(collector)가 돌려주는 배열의 인덱스다.
 */
export const COMPUTED_STYLE_ALLOWLIST = [
  'display', 'visibility', 'opacity', 'overflow-x', 'overflow-y', 'position', 'z-index',
  'background-color', 'background-image', 'background-size', 'background-position-x', 'background-position-y', 'background-repeat',
  'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration-line', 'text-decoration-color', 'text-transform',
  'letter-spacing', 'text-align', 'white-space', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'box-shadow', 'cursor', 'outline-width', 'outline-style', 'outline-color', 'pointer-events', 'user-select',
  // 에이전트 안에서 좌표 계산에만 쓴다(값 그대로 내보내지 않음 — 숫자 행렬로 바뀌어 m 이 된다)
  'transform',
  // SVG paint
  'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'fill-opacity', 'stroke-opacity', 'text-anchor',
] as const
export type ComputedKey = typeof COMPUTED_STYLE_ALLOWLIST[number]
