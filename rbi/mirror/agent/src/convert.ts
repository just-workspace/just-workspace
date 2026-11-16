/**
 * 변환 — 수집기의 원시 레코드(RawRec: 계산 스타일 문자열·속성·위젯 상태) → 닫힌 어휘(VNode).
 *
 * 수행 내용(전부 에이전트 내부에서 수행 — 원시 문자열은 사용자 PC 로 전송되지 않는다):
 *  - 계산값 → 숫자·rgb()·키워드(validateStyle 이 재검증한다).
 *  - background-image: url() → 재인코딩 자산 sha, 그라디언트 → 숫자 어휘(background.ts). url 원문은 폐기한다.
 *  - 폰트: 원격이 실제로 사용한 폰트 → 고정 키(fonts.ts). 작성자 폰트 이름은 폐기한다.
 *  - 아이콘 폰트 글리프(사용자 영역 문자, ::before 의 \f04b 등) → 해당 상자를 래스터 자산으로 변환(raster.ts).
 *  - 입력 위젯: 값은 표시 문자열로만 전달(password 는 마스킹 문자 — 수집기가 길이만 제공한다).
 *  - svg: 기하 허용목록·숫자 속성·계산된 칠하기만(href·filter·use·image·foreignObject·animate 는 수집기가 처음부터 읽지 않는다).
 *  - canvas·video·iframe·embed·object·shadow host → inset(픽셀).
 * 마지막에 validateNode(lenient) 를 1회 더 수행한다 — 어휘 밖 필드는 남지 않는다.
 */
import {
  COMPUTED_STYLE_ALLOWLIST, type ComputedKey, type FontKey, type StyleRec, type SvgGeom, type SvgPaint, type VNode, type WidgetKind,
  cleanShadow, cleanText, cleanTransform, isColor, validateNode, CURSORS, BORDER_STYLES, type BorderStyle,
} from '../../protocol/vocab.ts'
import type { RawGeom, RawRec } from './page/collector.ts'
import { parseBackground } from './background.ts'
import { type FontInfo, ICON_FAMILY, hasPua, heuristicKeys } from './fonts.ts'

const IX: Record<string, number> = {}
COMPUTED_STYLE_ALLOWLIST.forEach((k, i) => { IX[k] = i })
const TRANSPARENT = 'rgba(0, 0, 0, 0)'
const INSET_TAGS: Record<string, VNode['ik']> = { canvas: 'canvas', video: 'video', iframe: 'iframe', frame: 'iframe', embed: 'embed', object: 'embed', audio: 'other' }
/** 합성 노드(의사 요소 텍스트) id — 수집기 id(1부터 증가)와 충돌하지 않도록 상위 대역 사용 */
export const SYNTH_BASE = 2 ** 30
export function synthId(hostId: number, which: 'b' | 'a'): number { return SYNTH_BASE + ((hostId * 2 + (which === 'a' ? 1 : 0)) % (2 ** 30 - 1)) }

export interface ConvertDeps {
  /** 자산 sha(없으면 요청만 등록하고 undefined) — url 은 노드 id 와 연결해 둔다(준비되면 재변환) */
  shaFor(url: string, nodeId: number): string | undefined
  font(nodeId: number, refId: number, ff: string, fw: string, fi: string, text: string): FontInfo
  /** 아이콘 래스터 sha(없으면 요청만 등록) */
  raster(nodeId: number, key: string): string | undefined
  /** 다른 노드의 원시 레코드(텍스트의 스타일 출처·배경 탐색) */
  raw(id: number): RawRec | undefined
  /** 아이콘 폰트 글자를 포함한 요소인지 여부(set 이면 표시하고 해당 요소를 재변환) — 텍스트 자식이 아이콘이면 부모를 래스터로 처리 */
  iconHost(id: number, set?: string): string | undefined
}

function px(v: string | undefined): number | undefined {
  if (!v) return undefined
  const m = /^(-?\d+(?:\.\d+)?(?:e-?\d+)?)px$/.exec(v.trim())
  return m ? Math.round(parseFloat(m[1]) * 100) / 100 : undefined
}
const r2 = (n: number) => Math.round(n * 100) / 100
function cs(rec: RawRec | undefined, k: ComputedKey): string { return rec?.cs ? rec.cs[IX[k]] ?? '' : '' }

/** 위치 요소면 z-index(정수) */
function zIndexOf(rec: RawRec): number | undefined {
  if (cs(rec, 'position') === 'static') return undefined
  const z = cs(rec, 'z-index')
  if (!z || z === 'auto') return undefined
  const n = parseInt(z, 10)
  return Number.isFinite(n) ? Math.max(-1e7, Math.min(1e7, n)) : undefined
}

export function boxStyle(rec: RawRec, deps: ConvertDeps, id: number): StyleRec {
  const s: StyleRec = {}
  const bg = cs(rec, 'background-color'); if (isColor(bg) && bg !== TRANSPARENT) s.bg = bg
  const bgp = parseBackground(cs(rec, 'background-image'), cs(rec, 'background-size'), cs(rec, 'background-position-x'), cs(rec, 'background-position-y'), cs(rec, 'background-repeat'), u => deps.shaFor(u, id))
  if (bgp.layers.length) s.bgl = bgp.layers
  if (!s.bg && bgp.fallbackColor) s.bg = bgp.fallbackColor
  const bw: number[] = [], bs: string[] = [], bc: string[] = []
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    bw.push(px(cs(rec, `border-${side}-width` as ComputedKey)) ?? 0)
    const st = cs(rec, `border-${side}-style` as ComputedKey) || 'none'
    bs.push((BORDER_STYLES as readonly string[]).includes(st) ? st : 'solid')
    const c = cs(rec, `border-${side}-color` as ComputedKey)
    bc.push(isColor(c) ? c : TRANSPARENT)
  }
  if (bw.some(w => w > 0) && bs.some(x => x !== 'none' && x !== 'hidden')) { s.bw = bw as StyleRec['bw']; s.bs = bs as StyleRec['bs']; s.bc = bc as StyleRec['bc'] }
  const br = (['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const).map(c => px(cs(rec, `border-${c}-radius` as ComputedKey)) ?? 0)
  if (br.some(r => r > 0)) s.br = br as StyleRec['br']
  const op = parseFloat(cs(rec, 'opacity')); if (Number.isFinite(op) && op < 1) s.op = Math.max(0, r2(op))
  const sh = cleanShadow(cs(rec, 'box-shadow')); if (sh) s.sh = sh
  const ow = px(cs(rec, 'outline-width')), ost = cs(rec, 'outline-style'), oc = cs(rec, 'outline-color')
  if (ow && ow > 0 && ost && ost !== 'none' && (BORDER_STYLES as readonly string[]).includes(ost) && isColor(oc)) s.ol = [Math.min(100, ow), ost as BorderStyle, oc]
  const cur = cs(rec, 'cursor'); if (cur && cur !== 'auto' && CURSORS.has(cur)) s.cur = cur
  const ox = cs(rec, 'overflow-x'), oy = cs(rec, 'overflow-y')
  if ((ox && ox !== 'visible') || (oy && oy !== 'visible')) s.clip = true
  if (cs(rec, 'visibility') === 'hidden' || cs(rec, 'visibility') === 'collapse') s.hid = true
  if (cs(rec, 'pointer-events') === 'none') s.pe = true
  if (cs(rec, 'user-select') === 'none') s.nosel = true
  return s
}

/** 글자 스타일(텍스트 노드는 부모 계산값, 위젯은 자체 값) */
export function textStyle(src: RawRec | undefined, fontKeys: FontKey[]): StyleRec {
  const s: StyleRec = {}
  if (!src) { s.pf = fontKeys; return s }
  const c = cs(src, 'color'); if (isColor(c)) s.c = c
  s.pf = fontKeys
  const fs = px(cs(src, 'font-size')); if (fs !== undefined) s.fs = fs
  const fw = parseInt(cs(src, 'font-weight'), 10); if (Number.isFinite(fw)) s.fw = fw
  const fi = cs(src, 'font-style'); if (fi === 'italic' || fi.startsWith('oblique')) s.fi = fi === 'italic' ? 'italic' : 'oblique'
  const td = cs(src, 'text-decoration-line'); if (td === 'underline' || td === 'line-through' || td === 'overline') { s.td = td; const tdc = cs(src, 'text-decoration-color'); if (isColor(tdc)) s.tdc = tdc }
  const tt = cs(src, 'text-transform'); if (tt === 'uppercase' || tt === 'lowercase' || tt === 'capitalize') s.tt = tt
  const ls = px(cs(src, 'letter-spacing')); if (ls) s.ls = ls
  const vis = cs(src, 'visibility'); if (vis === 'hidden' || vis === 'collapse') s.hid = true
  if (cs(src, 'user-select') === 'none') s.nosel = true
  if (cs(src, 'pointer-events') === 'none') s.pe = true
  const cur = cs(src, 'cursor'); if (cur && cur !== 'auto' && CURSORS.has(cur)) s.cur = cur
  return s
}

/** 가장 가까운 불투명 배경(래스터 키에 포함한다 — 동일 아이콘이라도 뒤 배경이 다르면 다른 래스터) */
function effectiveBg(rec: RawRec, deps: ConvertDeps): string {
  let r: RawRec | undefined = rec
  for (let i = 0; r && i < 64; i++) {
    const bg = cs(r, 'background-color')
    if (isColor(bg) && bg !== TRANSPARENT) return bg
    if (cs(r, 'background-image') && cs(r, 'background-image') !== 'none') return `img:${r.i}`
    r = r.p ? deps.raw(r.p) : undefined
  }
  return 'page'
}

function svgPaint(p: string[], a: Record<string, string>): SvgPaint {
  const [fill, stroke, sw, da, lc, lj, fo, op] = p
  const st: SvgPaint = {}
  if (isColor(fill) || fill === 'none') st.f = fill
  if (isColor(stroke) || stroke === 'none') st.s = stroke
  const w = px(sw); if (w !== undefined) st.sw = w
  const eff = (Number.isFinite(parseFloat(op)) ? parseFloat(op) : 1) * (Number.isFinite(parseFloat(fo)) ? parseFloat(fo) : 1)
  if (eff < 1) st.op = Math.max(0, r2(eff))
  if (da && da !== 'none') { const d = da.replace(/px/g, ''); if (/^[0-9. ,]{1,64}$/.test(d)) st.da = d }
  if (lc === 'round' || lc === 'square') st.lc = lc
  if (lj === 'round' || lj === 'bevel') st.lj = lj
  const tr = cleanTransform(a.transform); if (tr) st.tr = tr
  return st
}

function svgGeoms(gs: RawGeom[] | undefined, depth = 0): SvgGeom[] {
  const out: SvgGeom[] = []
  if (!gs || depth > 8) return out
  const num = (a: Record<string, string>, k: string): number | undefined => { const v = parseFloat(a[k] ?? ''); return Number.isFinite(v) ? r2(v) : undefined }
  for (const g of gs) {
    const st = svgPaint(g.p, g.a)
    let o: SvgGeom | undefined
    switch (g.n) {
      case 'path': if (g.a.d) o = { k: 'path', d: g.a.d.replace(/\s+/g, ' ').trim(), st }; break
      case 'line': o = { k: 'line', x1: num(g.a, 'x1') ?? 0, y1: num(g.a, 'y1') ?? 0, x2: num(g.a, 'x2') ?? 0, y2: num(g.a, 'y2') ?? 0, st }; break
      case 'rect': { o = { k: 'rect', x: num(g.a, 'x') ?? 0, y: num(g.a, 'y') ?? 0, w: num(g.a, 'width') ?? 0, h: num(g.a, 'height') ?? 0, st }; const rx = num(g.a, 'rx'), ry = num(g.a, 'ry'); if (rx !== undefined && rx >= 0) o.rx = rx; if (ry !== undefined && ry >= 0) o.ry = ry; break }
      case 'circle': o = { k: 'circle', cx: num(g.a, 'cx') ?? 0, cy: num(g.a, 'cy') ?? 0, r: Math.max(0, num(g.a, 'r') ?? 0), st }; break
      case 'ellipse': o = { k: 'ellipse', cx: num(g.a, 'cx') ?? 0, cy: num(g.a, 'cy') ?? 0, rx: Math.max(0, num(g.a, 'rx') ?? 0), ry: Math.max(0, num(g.a, 'ry') ?? 0), st }; break
      case 'polyline': if (g.a.points) o = { k: 'polyline', pts: g.a.points.trim(), st }; break
      case 'polygon': if (g.a.points) o = { k: 'polygon', pts: g.a.points.trim(), st }; break
      case 'g': o = { k: 'g', ch: svgGeoms(g.ch, depth + 1), st }; break
      case 'text': {
        if (!g.t) break
        const t: Extract<SvgGeom, { k: 'text' }> = { k: 'text', x: num(g.a, 'x') ?? 0, y: num(g.a, 'y') ?? 0, t: cleanText(g.t), st }
        const fs = px(g.p[8]); if (fs !== undefined) t.fs = fs
        const fw = parseInt(g.p[9], 10); if (Number.isFinite(fw)) t.fw = fw
        t.pf = heuristicKeys(g.p[10] || '', g.t)
        const anc = g.p[11]; if (anc === 'middle' || anc === 'end') t.anc = anc
        o = t
        break
      }
    }
    if (o) out.push(o)
  }
  return out
}

export interface Converted { node?: VNode; extra: VNode[] }

/** 레코드 하나 → VNode(+의사 요소 합성 텍스트). 사용 불가 시 node 없음 */
export function convert(rec: RawRec, deps: ConvertDeps): Converted {
  const [x, y, w, h] = rec.r
  const base: VNode = { id: rec.i, p: rec.p, k: 'box', x, y, w, h, o: rec.o }
  if (rec.m) base.m = rec.m
  const extra: VNode[] = []
  if (rec.t === 'x') {
    const src = rec.ps ? deps.raw(rec.ps) : undefined
    const text = (rec.tx || []).map(t => t[4]).join(' ')
    const fi = deps.font(rec.i, rec.ps || 0, cs(src, 'font-family'), cs(src, 'font-weight'), cs(src, 'font-style'), text)
    // 아이콘 폰트로 그린 글자(사용자 영역) — 부모 상자를 래스터로 처리(아래 요소 측에서 처리). 텍스트 자체는 전송하지 않는다
    if (fi.icon && src && rec.ps) { deps.iconHost(rec.ps, text); return { extra } }
    base.k = 'text'
    base.runs = (rec.tx || []).map(t => ({ x: t[0], y: t[1], w: t[2], h: t[3], t: cleanText(t[4]) }))
    base.s = textStyle(src, fi.keys)
    return { node: validateNode(base), extra }
  }
  const tag = rec.n || 'div'
  const a = rec.a || {}
  const zi = zIndexOf(rec); if (zi !== undefined) base.zi = zi
  if (rec.fr) base.fx = true
  if (tag === 'svg') {
    base.k = 'svg'
    base.s = boxStyle(rec, deps, rec.i)
    const vb = (a.vb || '').trim().split(/[\s,]+/).map(Number)
    if (vb.length === 4 && vb.every(n => Number.isFinite(n))) base.vb = vb as VNode['vb']
    base.g = svgGeoms(rec.g)
    return { node: validateNode(base), extra }
  }
  const ik = INSET_TAGS[tag] ?? (rec.sh ? 'other' : undefined)
  if (ik) {
    base.k = 'inset'; base.ik = ik
    base.s = boxStyle(rec, deps, rec.i)
    return { node: validateNode(base), extra }
  }
  if (tag === 'img' || (tag === 'input' && a.type === 'image')) {
    base.k = 'img'
    base.s = boxStyle(rec, deps, rec.i)
    delete base.s.bgl
    if (a.src && /^(https?|data|blob):/i.test(a.src)) { const sha = deps.shaFor(a.src, rec.i); if (sha) base.a = sha }
    return { node: validateNode(base), extra }
  }
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    base.k = 'widget'
    const type = (a.type || 'text').toLowerCase()
    let wk: WidgetKind = 'text'
    if (tag === 'textarea') wk = 'textarea'
    else if (tag === 'select') wk = 'select'
    else if (type === 'password') wk = 'password'
    else if (type === 'checkbox') wk = 'checkbox'
    else if (type === 'radio') wk = 'radio'
    else if (type === 'range') wk = 'range'
    else if (type === 'submit' || type === 'button' || type === 'reset' || type === 'file' || type === 'color') wk = 'button'
    base.wk = wk
    const st = rec.w || {}
    const shown = wk === 'password' ? '•'.repeat(Math.min(st.n ?? 0, 200)) : wk === 'button' ? (a.val || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : type === 'file' ? (st.v || '파일 선택') : '')) : wk === 'select' ? (st.so ?? '') : (st.v ?? '')
    const fi = deps.font(rec.i, rec.i, cs(rec, 'font-family'), cs(rec, 'font-weight'), cs(rec, 'font-style'), shown || a.ph || 'a')
    base.s = { ...boxStyle(rec, deps, rec.i), ...textStyle(rec, fi.keys) }
    const ta = cs(rec, 'text-align'); if (ta === 'center' || ta === 'right') base.s.ta = ta
    const pd = (['top', 'right', 'bottom', 'left'] as const).map(k => px(cs(rec, `padding-${k}` as ComputedKey)) ?? 0)
    if (pd.some(v => v > 0)) base.s.pd = pd.map(v => Math.max(0, Math.min(2000, v))) as StyleRec['pd']
    if (wk === 'select') base.wopt = cleanText(shown)
    else if (wk === 'range') { const f = parseFloat(st.v ?? ''); base.wr = Number.isFinite(f) ? Math.max(0, Math.min(1, Math.round(f * 10000) / 10000)) : 0.5 } else if (wk !== 'checkbox' && wk !== 'radio') base.wv = cleanText(shown)
    if (a.ph) base.wph = cleanText(a.ph)
    if (st.c) base.wc = true
    if (a.dis) base.wdis = true
    return { node: validateNode(base), extra }
  }
  // 일반 상자
  base.s = boxStyle(rec, deps, rec.i)
  if (rec.sc) base.sc = rec.sc
  // 의사 요소: 아이콘(사용자 영역 글리프) → 이 상자를 래스터 img 로 · 일반 글자 → 합성 텍스트 자식
  // 아이콘: 사용자 영역 글리프이거나 아이콘 폰트 이름(Glyphicons 는 '+' 를 아이콘으로 사용한다)
  const icon = [rec.pb, rec.pa].find(pp => pp && (hasPua(pp[0]) || ICON_FAMILY.test(pp[1])))
  const hostText = deps.iconHost(rec.i)
  if (icon || hostText !== undefined) {
    const sig = icon ? [icon[0], icon[1], icon[2], icon[3], icon[4]] : [hostText, cs(rec, 'font-family'), cs(rec, 'font-size'), cs(rec, 'font-weight'), cs(rec, 'color')]
    const key = JSON.stringify([...sig, Math.round(w), Math.round(h), effectiveBg(rec, deps), cs(rec, 'opacity'), base.s.bg ?? '', base.s.bc ?? ''])
    const sha = deps.raster(rec.i, key)
    base.k = 'img'
    const keep = base.s
    base.s = { op: keep.op, hid: keep.hid, cur: keep.cur, pe: keep.pe }
    if (sha) base.a = sha
    return { node: validateNode(base), extra }
  }
  for (const [which, pp] of [['b', rec.pb], ['a', rec.pa]] as const) {
    if (!pp) continue
    const [text, ff, fsz, fwt, color] = pp
    const fs = px(fsz) ?? 14
    const bl = px(cs(rec, 'border-left-width')) ?? 0
    const pl = px(cs(rec, 'padding-left')) ?? 0, pt = px(cs(rec, 'padding-top')) ?? 0, pr = px(cs(rec, 'padding-right')) ?? 0
    const est = Math.min(w, r2(text.length * fs * 0.6))
    const tx = which === 'b' ? pl : Math.max(pl, w - bl * 2 - pr - est)
    const keys = heuristicKeys(ff, text)
    const s = textStyle(undefined, keys)
    if (isColor(color)) s.c = color
    s.fs = fs
    const fwn = parseInt(fwt, 10); if (Number.isFinite(fwn)) s.fw = fwn
    const node = validateNode({ id: synthId(rec.i, which), p: rec.i, k: 'text', x: r2(tx), y: r2(pt), w: est, h: r2(fs * 1.2), o: which === 'b' ? 0 : 999999, s, runs: [{ x: 0, y: 0, w: est, h: r2(fs * 1.2), t: cleanText(text) }] })
    if (node) extra.push(node)
  }
  return { node: validateNode(base), extra }
}
