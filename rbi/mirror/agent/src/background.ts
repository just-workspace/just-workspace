/**
 * 배경 — 계산된 background-image(+size/position/repeat) 문자열을 어휘(BgLayer[])로 변환한다.
 *
 * Chromium 의 계산값은 정규화되어 있다: 색은 rgb()/rgba(), 길이는 px, 위치는 % 또는 px, url() 은 절대 URL.
 *   linear-gradient(rgb(238, 238, 238) 1px, rgba(0, 0, 0, 0) 1px)
 *   linear-gradient(90deg, rgb(255, 0, 0), rgb(0, 0, 255))   ·   linear-gradient(to right, …)
 *   radial-gradient(circle at 50% 30%, rgb(…) 0%, rgb(…) 70%)  ·  radial-gradient(150px 80px at 10px 20px, …)
 * 여기서 숫자·색·키워드만으로 재작성한 결과를 어휘로 전송하고, url() 레이어는 재인코딩 자산 sha 로 치환한다(원문 URL 은 전송하지 않는다).
 * 해석 불가 레이어(conic·calc()·color() 등의 새 색 공간)는 폐기한다 — 폐기한 그라디언트는 첫 정지점 색을 배경색 대체값으로 반환한다.
 */
import { type BgLayer, type BgRepeat, type BgSize, type GradStop, type Gradient, type LenUnit, type SideKw, isColor, validateBgLayer } from '../../protocol/vocab.ts'

/** 최상위 쉼표로 분할(괄호·따옴표 내부는 유지) */
export function splitTop(s: string, sep = ','): string[] {
  const out: string[] = []
  let depth = 0, cur = '', q: string | null = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) { cur += ch; if (ch === '\\') { cur += s[++i] ?? '' } else if (ch === q) q = null; continue }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue }
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === sep && depth === 0) { out.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (cur.trim() || out.length) out.push(cur.trim())
  return out
}

/** 공백으로 분할(괄호 내부는 유지) */
function words(s: string): string[] {
  const out: string[] = []
  let depth = 0, cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

const LEN_RE = /^(-?\d+(?:\.\d+)?(?:e-?\d+)?)(px|%)$/
function len(s: string): [number, LenUnit] | undefined {
  if (s === '0') return [0, 'px']
  const m = LEN_RE.exec(s)
  if (!m) return undefined
  const n = Math.round(parseFloat(m[1]) * 1000) / 1000
  return Number.isFinite(n) ? [n, m[2] as LenUnit] : undefined
}

function angle(s: string): number | undefined {
  const m = /^(-?\d+(?:\.\d+)?)(deg|grad|rad|turn)$/.exec(s)
  if (!m) return undefined
  const v = parseFloat(m[1])
  const deg = m[2] === 'deg' ? v : m[2] === 'grad' ? v * 0.9 : m[2] === 'rad' ? v * 180 / Math.PI : v * 360
  return Math.round(deg * 1000) / 1000
}

const SIDES: Record<string, SideKw> = {
  'to top': 't', 'to right': 'r', 'to bottom': 'b', 'to left': 'l',
  'to top right': 'tr', 'to right top': 'tr', 'to top left': 'tl', 'to left top': 'tl',
  'to bottom right': 'br', 'to right bottom': 'br', 'to bottom left': 'bl', 'to left bottom': 'bl',
}

/** 정지점 "rgb(…) 10% 20%" → 정지점 1~2개. 색 힌트(위치만)는 폐기한다 */
function stops(parts: string[]): GradStop[] | undefined {
  const out: GradStop[] = []
  for (const p of parts) {
    const w = words(p)
    if (!w.length) return undefined
    if (w.length === 1 && len(w[0])) continue // 색 힌트
    const color = w[0]
    if (!isColor(color)) return undefined
    if (w.length === 1) { out.push([color]); continue }
    const a = len(w[1]); if (!a) return undefined
    out.push([color, a[0], a[1]])
    if (w.length === 3) { const b = len(w[2]); if (!b) return undefined; out.push([color, b[0], b[1]]) }
    if (w.length > 3) return undefined
  }
  return out.length >= 1 && out.length <= 32 ? out : undefined
}

const POS_KW: Record<string, [number, LenUnit]> = { left: [0, '%'], center: [50, '%'], right: [100, '%'], top: [0, '%'], bottom: [100, '%'] }
function position(ws: string[]): [number, LenUnit, number, LenUnit] | undefined {
  if (!ws.length) return [50, '%', 50, '%']
  const v = (s: string) => POS_KW[s] ?? len(s)
  if (ws.length === 1) {
    const a = v(ws[0]); if (!a) return undefined
    if (ws[0] === 'top' || ws[0] === 'bottom') return [50, '%', a[0], a[1]]
    return [a[0], a[1], 50, '%']
  }
  if (ws.length === 2) {
    let x = ws[0], y = ws[1]
    if (x === 'top' || x === 'bottom' || y === 'left' || y === 'right') [x, y] = [y, x]
    const a = v(x), b = v(y)
    return a && b ? [a[0], a[1], b[0], b[1]] : undefined
  }
  return undefined // 4값(가장자리 오프셋) 표기는 계산값에 거의 나타나지 않음 — 폐기
}

export function parseGradient(s: string): Gradient | undefined {
  const m = /^(repeating-)?(linear|radial)-gradient\((.*)\)$/s.exec(s.trim())
  if (!m) return undefined
  const rep = !!m[1]
  const args = splitTop(m[3])
  if (!args.length) return undefined
  if (m[2] === 'linear') {
    let a: number | SideKw = 180
    let rest = args
    const first = args[0]
    const ang = angle(first)
    if (ang !== undefined) { a = ang; rest = args.slice(1) } else if (SIDES[first]) { a = SIDES[first]; rest = args.slice(1) }
    const st = stops(rest); if (!st) return undefined
    const g: Gradient = { k: 'lin', a, st }
    if (rep) g.rep = true
    return g
  }
  // radial: [shape || size] [at position], stops…
  let sh: 'circle' | 'ellipse' = 'ellipse'
  let sz: Extract<Gradient, { k: 'rad' }>['sz'] = 'farthest-corner'
  let at: [number, LenUnit, number, LenUnit] = [50, '%', 50, '%']
  let rest = args
  const head = words(args[0])
  if (head.length && !isColor(head[0])) {
    rest = args.slice(1)
    const atIdx = head.indexOf('at')
    const pre = atIdx >= 0 ? head.slice(0, atIdx) : head
    const post = atIdx >= 0 ? head.slice(atIdx + 1) : []
    const lens: [number, LenUnit][] = []
    let sawShape = false
    for (const w of pre) {
      if (w === 'circle' || w === 'ellipse') { sh = w; sawShape = true } else if (w === 'closest-side' || w === 'closest-corner' || w === 'farthest-side' || w === 'farthest-corner') sz = w
      else { const l = len(w); if (!l) return undefined; lens.push(l) }
    }
    if (lens.length === 1) { sz = [lens[0][0], lens[0][1], lens[0][0], lens[0][1]]; if (!sawShape) sh = 'circle' } else if (lens.length === 2) sz = [lens[0][0], lens[0][1], lens[1][0], lens[1][1]]
    else if (lens.length > 2) return undefined
    if (atIdx >= 0) { const p = position(post); if (!p) return undefined; at = p }
  }
  const st = stops(rest); if (!st) return undefined
  const g: Gradient = { k: 'rad', sh, sz, at, st }
  if (rep) g.rep = true
  return g
}

function bgSize(s: string | undefined): BgSize | undefined {
  if (!s || s === 'auto' || s === 'auto auto') return undefined
  if (s === 'cover' || s === 'contain') return s
  const w = words(s)
  const one = (t: string): [number, LenUnit | 'auto'] | undefined => (t === 'auto' ? [0, 'auto'] : len(t))
  const a = one(w[0]); const b = w[1] ? one(w[1]) : [0, 'auto'] as [number, 'auto']
  if (!a || !b || w.length > 2) return undefined
  return [a[0], a[1], b[0], b[1]]
}

function bgRepeat(s: string | undefined): BgRepeat | undefined {
  if (!s) return undefined
  const w = words(s)
  if (w.length === 1 && ['repeat', 'no-repeat', 'repeat-x', 'repeat-y', 'space', 'round'].includes(w[0])) return w[0] === 'repeat' ? undefined : w[0] as BgRepeat
  if (w.length === 2) {
    if (w[0] === 'repeat' && w[1] === 'no-repeat') return 'repeat-x'
    if (w[0] === 'no-repeat' && w[1] === 'repeat') return 'repeat-y'
    if (w[0] === w[1] && ['no-repeat', 'space', 'round'].includes(w[0])) return w[0] as BgRepeat
    if (w[0] === 'repeat' && w[1] === 'repeat') return undefined
  }
  return undefined
}

export interface BgParse {
  layers: BgLayer[]
  /** url() 레이어의 절대 URL(자산 요청용 — 에이전트 내부 전용) */
  urls: string[]
  /** 폐기한 그라디언트가 있으면 그 첫 색(배경색이 없을 때의 대체값) */
  fallbackColor?: string
}

/**
 * 계산값 → 레이어. shaFor(url) 이 아직 없으면(자산 준비 중) 해당 레이어는 이번 변환에서 제외된다(준비되면 재변환된다).
 * 레이어 수는 최대 4.
 */
export function parseBackground(
  image: string, size: string, posX: string, posY: string, repeat: string,
  shaFor: (url: string) => string | undefined,
): BgParse {
  const res: BgParse = { layers: [], urls: [] }
  if (!image || image === 'none') return res
  const imgs = splitTop(image)
  const sizes = splitTop(size || ''), xs = splitTop(posX || ''), ys = splitTop(posY || ''), reps = splitTop(repeat || '')
  const at = <T>(arr: T[], i: number) => (arr.length ? arr[i % arr.length] : undefined)
  for (let i = 0; i < imgs.length && res.layers.length < 4; i++) {
    const s = imgs[i]
    if (s === 'none') continue
    const layer: BgLayer = {}
    const um = /^url\("((?:[^"\\]|\\.)*)"\)$/.exec(s) || /^url\(([^)"']*)\)$/.exec(s)
    if (um) {
      const u = um[1].replace(/\\(.)/g, '$1')
      if (!/^(https?|data|blob):/i.test(u)) continue
      res.urls.push(u)
      const sha = shaFor(u)
      if (!sha) continue
      layer.i = sha
    } else {
      const g = parseGradient(s)
      if (!g) {
        // 해석 불가 그라디언트 — 첫 rgb() 를 대체 색으로 사용
        const c = /rgba?\([^)]*\)/.exec(s)
        if (c && isColor(c[0]) && !res.fallbackColor) res.fallbackColor = c[0]
        continue
      }
      layer.g = g
    }
    const sz = bgSize(at(sizes, i)); if (sz) layer.sz = sz
    const px = at(xs, i), py = at(ys, i)
    if (px && py) {
      const a = len(px), b = len(py)
      if (a && b && !(a[0] === 0 && b[0] === 0)) layer.ps = [a[0], a[1], b[0], b[1]]
    }
    const rp = bgRepeat(at(reps, i)); if (rp) layer.rp = rp
    const v = validateBgLayer(layer)
    if (v) res.layers.push(v)
  }
  return res
}
