/**
 * 수집기 — 원격 페이지의 **격리 world**(Page.createIsolatedWorld, 이름 jw-mirror)에서 실행된다. 페이지 스크립트는 이 함수·변수에 접근할 수 없으며
 * (world 마다 JS 전역·프로토타입이 분리된다) 수집기와는 DOM 만 공유한다. 수행 내용은 "읽기" 뿐이다(스크롤 지시만 예외).
 *
 * 틱마다 문서 전체(DOMSnapshot.captureSnapshot — 4.5천 노드에 115–135ms)를 재조회하지 않는다.
 *   MutationObserver(+입력·포커스·애니메이션·이미지 로드·폰트 로드·크기 변경·포인터 이벤트)로 변경 지점만 표시하고, 틱마다 해당 지점만 재조회한다.
 *   단계: ① 구조(추가·삭제 서브트리) ② 스타일(변경된 요소만, 상속 속성이 변경되면 자손까지) ③ 기하(변경된 요소의 가장 가까운
 *   흐름 밖 조상 = position absolute/fixed 서브트리만, 해당 조상이 없으면 문서 전체) ④ 텍스트(문자 변화·부모 상자 변화)
 *   ⑤ 스크롤 컨테이너 오프셋 ⑥ 검증(페인트는 있었으나 변이가 없을 때 간헐적으로, 뷰포트 내부만).
 *   jsPlumb 노드 드래그는 absolute 이므로 해당 노드 서브트리만 재측정한다.
 * 좌표는 스크롤 불변(모든 스크롤 0 기준) — 문서·컨테이너 스크롤 시 노드를 재전송하지 않는다(fixed 서브트리는 뷰포트 좌표).
 * 결과는 "원시 레코드"(계산 스타일 문자열 그대로)다. 어휘 변환과 검증은 에이전트(Node, convert.ts)가 수행한다 — 원시 문자열은 사용자 PC 로 전송되지 않는다.
 * 비밀번호 입력칸의 값은 이 함수 밖으로 전달되지 않는다(길이만).
 *
 * 주의: 이 함수는 toString() 으로 원격에 주입된다. 외부 변수·import 를 참조해서는 안 된다.
 */

export interface CollectorCfg {
  styles: readonly string[]
  maxNodes: number
  /** 검증 패스(페인트는 있었으나 변이가 없었을 때) 최소 간격 ms */
  verifyMs: number
}

/** 원시 레코드(수집기 → 에이전트). 필드 이름은 축약형 — 에이전트 convert.ts 가 해석한다 */
export interface RawRec {
  i: number
  p: number
  /** e: 요소, x: 텍스트 */
  t: 'e' | 'x'
  /** 태그(소문자) */
  n?: string
  /** 형제 순서 키 */
  o: number
  /**
   * 기록 부모 기준 지역 배치 [left, top, w, h] — left/top 은 부모의 padding box(스크롤 컨테이너면 스크롤 콘텐츠) 원점 기준,
   * w/h 는 변환 전 크기. 부모가 이동해도 자식 레코드는 변경되지 않는다(부모 하나만 재전송된다).
   * 루트(p=0)는 문서 좌표(스크롤 불변), fixed 루트(fr)는 뷰포트 좌표.
   */
  r: [number, number, number, number]
  /** 부모 기준 지역 2×2 변환 행렬(단위행렬이 아닐 때만) — 상자 중심 기준 */
  m?: [number, number, number, number]
  /** 계산 스타일(허용목록 순서). 텍스트는 부모의 값을 사용한다(ps) */
  cs?: string[]
  /** 텍스트의 부모 요소 id(스타일 출처) */
  ps?: number
  /** position:fixed 루트 — r 은 뷰포트 좌표 */
  fr?: 1
  /** 텍스트 줄 런 [x,y,w,h,text] — 텍스트 노드 상자 기준(변환 전) */
  tx?: [number, number, number, number, string][]
  /** 요소 속성(필요한 것만): src(절대 URL — 에이전트가 자산 sha 로 치환한다)·type·ph·dis·val·vb */
  a?: Record<string, string>
  /** 위젯 상태: v 값(password 는 없음), n 길이, c checked, so 선택된 option 텍스트 */
  w?: { v?: string; n?: number; c?: boolean; so?: string }
  /** 스크롤 [scrollWidth, scrollHeight, scrollLeft, scrollTop] */
  sc?: [number, number, number, number]
  /** svg 원시 기하(루트에만) */
  g?: RawGeom[]
  /** ::before/::after [content, font-family, font-size, font-weight, color] */
  pb?: [string, string, string, string, string]
  pa?: [string, string, string, string, string]
  /** 열린 shadow root 존재(내용은 미러하지 않음 → 인셋) */
  sh?: 1
}

export interface RawGeom {
  n: string
  a: Record<string, string>
  /** fill, stroke, stroke-width, stroke-dasharray, stroke-linecap, stroke-linejoin, fill-opacity, opacity, font-size, font-weight, font-family, text-anchor */
  p: string[]
  ch?: RawGeom[]
  t?: string
}

export interface TickResult {
  full: boolean
  recs: RawRec[]
  del: number[]
  doc: { cw: number; ch: number; vw: number; vh: number; sx: number; sy: number; url: string; title: string; bg: string }
  /** 포커스된 요소(기록된 것)와 위젯 상태 — password 는 길이만 */
  focus: { id: number; wk: string; n: number; ss: number; se: number; v?: string } | null
  ms: number
  nodes: number
  work: { style: number; geom: number; text: number; verify: boolean; geomAll: boolean; recs: number }
  truncated: boolean
}

/**
 * 원격에 주입할 소스. esbuild(tsx 개발 실행)는 함수 내부에 __name(…) 헬퍼 호출을 삽입한다 — 원격 world 에는 해당 헬퍼가 없으므로
 * 동일 이름의 항등 함수로 감싼다(tsc 컴파일본에는 없어 영향 없음).
 */
export function collectorSource(cfg: CollectorCfg): string {
  return `((__name) => (${collectorMain.toString()}))((f) => f)(${JSON.stringify(cfg)})`
}

export function collectorMain(cfg: CollectorCfg): void {
  const W = window as unknown as Record<string, unknown>
  if (W.__jwm) return
  const STY = cfg.styles as string[]
  const IX: Record<string, number> = {}
  STY.forEach((k, i) => { IX[k] = i })
  const SKIP = new Set(['HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'SOURCE', 'TRACK', 'PARAM', 'AREA', 'MAP', 'DATALIST', 'OPTION', 'OPTGROUP'])
  const INSET = new Set(['CANVAS', 'VIDEO', 'IFRAME', 'FRAME', 'EMBED', 'OBJECT', 'AUDIO'])
  const SVG_KEEP = new Set(['path', 'line', 'rect', 'circle', 'ellipse', 'polyline', 'polygon', 'g', 'text', 'a', 'tspan'])
  const GEOM_ATTRS = ['d', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'points', 'transform']
  const PAINT = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'fill-opacity', 'opacity', 'font-size', 'font-weight', 'font-family', 'text-anchor']
  // 상속 속성 중 수집 대상 — 변경되면 자손도 재조회한다
  const INHERITED = ['visibility', 'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-transform', 'letter-spacing', 'text-align', 'white-space', 'cursor', 'pointer-events', 'fill', 'stroke', 'stroke-width', 'text-anchor']
    .map(k => STY.indexOf(k)).filter(i => i >= 0)
  const TEXT_AFFECT = ['font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'white-space', 'text-transform', 'display'].map(k => STY.indexOf(k)).filter(i => i >= 0)
  // 변경 시 다른 요소의 배치에 영향을 주는 속성(수집 대상 중) — 색·배경·그림자처럼 칠하기만 변경되면 기하는 재측정하지 않는다
  const LAYOUT_AFFECT = ['display', 'position', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'white-space', 'text-transform',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'overflow-x', 'overflow-y'].map(k => STY.indexOf(k)).filter(i => i >= 0)

  interface St {
    id: number
    n: Node
    /** 기록 부모 id(가장 가까운 기록된 조상) */
    p: number
    /** DOM 부모 id(삭제 전파용) */
    dp: number
    text: boolean
    /** 상자가 있어 기록 대상인지 여부 */
    rec: boolean
    /** display:none — 서브트리 없음 */
    hidden: boolean
    /** 자식을 별도로 기록하지 않는 리프(svg·inset·img·widget·shadow host) */
    leaf: boolean
    o: number
    r?: [number, number, number, number]
    ow?: number
    oh?: number
    m?: [number, number, number, number]
    cs?: string[]
    csj?: string
    fr?: boolean
    fv?: boolean
    sc?: [number, number, number, number]
    tx?: [number, number, number, number, string][]
    txj?: string
    /** 지역 배치·지역 변환(전송 값) */
    L?: [number, number, number, number]
    lm?: [number, number, number, number]
    /** 텍스트 지역 런 */
    txl?: [number, number, number, number, string][]
    a?: Record<string, string>
    w?: RawRec['w']
    g?: RawGeom[]
    pb?: RawRec['pb']
    pa?: RawRec['pa']
    sh?: boolean
    sent?: string
  }

  let nextId = 1
  const idOf = new WeakMap<Node, number>()
  const st = new Map<number, St>()
  const domKids = new Map<number, Set<number>>()
  const removedIds: number[] = []
  const dirty = new Set<number>()
  let truncated = false

  // ── 변경 표시(dirty) ──
  let needFull = true
  let geomAll = false
  const structDirty = new Set<Node>()         // 추가된 노드 · 자식 목록이 변경된 부모
  const styleDirty = new Set<Element>()       // 자체 스타일 재조회
  const deepStyleDirty = new Set<Element>()   // 서브트리 스타일 재조회(속성 변화)
  const stateDirty = new Set<Element>()       // 값·체크·src·svg 내부 — 스타일과 무관하게 재조회
  const textDirty = new Set<Node>()           // 텍스트 노드 · 텍스트 자식을 재측정할 부모
  const geomRoots = new Set<Element>()
  const scrollDirty = new Set<Element>()
  const hot = new Map<Element, number>()
  const stickies = new Set<Element>()
  let paintSinceVerify = false
  let lastVerify = 0
  let docScrolled = false

  const getId = (n: Node): number => {
    let id = idOf.get(n)
    if (!id) { id = nextId++; idOf.set(n, id) }
    return id
  }
  const stOf = (n: Node | null): St | undefined => { if (!n) return undefined; const id = idOf.get(n); return id ? st.get(id) : undefined }
  const r2 = (v: number) => Math.round(v * 100) / 100
  const scroller = () => document.scrollingElement || document.documentElement
  const touch = (s: St) => { dirty.add(s.id) }
  const eqArr = (a?: readonly unknown[], b?: readonly unknown[]) => {
    if (a === b) return true
    if (!a || !b || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }

  const outOfFlowRoot = (el: Element | null): Element | null => {
    for (let e = el; e && e !== document.documentElement && e !== document.body; e = e.parentElement) {
      const s = stOf(e)
      const pos = s?.cs ? s.cs[IX.position] : ''
      if (pos === 'absolute' || pos === 'fixed') return e
    }
    return null
  }
  const markGeom = (el: Element | null) => {
    if (geomAll || !el) return
    const root = outOfFlowRoot(el)
    if (!root) geomAll = true
    else geomRoots.add(root)
  }

  // ── 변이 관찰 ──
  const onMut = (recs: MutationRecord[]) => {
    for (const r of recs) {
      const tgt = r.target
      if (r.type === 'childList') {
        for (const n of Array.from(r.removedNodes)) { const s = stOf(n); if (s && !n.isConnected) removeSubtree(s.id) }
        for (const n of Array.from(r.addedNodes)) structDirty.add(n)
        structDirty.add(tgt)
        if (tgt.nodeType === 1) {
          const svg = svgRootOf(tgt as Element)
          if (svg) { stateDirty.add(svg); markGeom(svg) } else { textDirty.add(tgt); markGeom(tgt as Element) }
        }
      } else if (r.type === 'attributes') {
        if (tgt.nodeType !== 1) continue
        const el = tgt as Element
        const svg = svgRootOf(el)
        if (svg && svg !== el) { stateDirty.add(svg); markGeom(svg); continue }
        deepStyleDirty.add(el)
        stateDirty.add(el)
        if (el.parentElement) textDirty.add(el.parentElement)
        markGeom(el)
      } else if (r.type === 'characterData') {
        const pe = tgt.parentElement
        const svg = pe ? svgRootOf(pe) : null
        if (svg) { stateDirty.add(svg); markGeom(svg); continue }
        textDirty.add(tgt)
        if (pe) { stateDirty.add(pe); markGeom(pe) }
      }
    }
  }
  function svgRootOf(el: Element): Element | null {
    if (!(el instanceof SVGElement)) return null
    if (el.tagName.toLowerCase() === 'svg' && !(el.parentElement instanceof SVGElement)) return el
    return el.ownerSVGElement ? svgRootOf(el.ownerSVGElement) || el.ownerSVGElement : null
  }
  const mo = new MutationObserver(onMut)
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })

  // 변이가 없는 시각 변화 — 캡처 단계 이벤트로 감지한다(페이지 핸들러와 무관하며 이벤트를 차단하지 않는다)
  const evEl = (ev: Event) => (ev.target instanceof Element ? ev.target : null)
  const chainDirty = (n: Node | null) => {
    for (let e = n instanceof Element ? n : n?.parentElement ?? null; e; e = e.parentElement) styleDirty.add(e)
  }
  /**
   * 이벤트 수신 — document.open() 은 동일 Document 를 유지하면서 리스너를 모두 제거한다(격리 world·__jwm 은 유지된다).
   * 따라서 문서 루트가 변경되면(tick 에서 확인) 재등록한다.
   */
  let listenRoot: Element | null = null
  function listen(): void {
    listenRoot = document.documentElement
    for (const t of ['input', 'change']) {
      document.addEventListener(t, ev => {
        const el = evEl(ev); if (!el) return
        stateDirty.add(el); styleDirty.add(el); markGeom(el)
        if (el instanceof HTMLInputElement && el.type === 'radio' && el.name) {
          document.querySelectorAll('input[type="radio"]').forEach(x => { if ((x as HTMLInputElement).name === el.name) { stateDirty.add(x); styleDirty.add(x) } })
        }
      }, true)
    }
    for (const t of ['focusin', 'focusout']) document.addEventListener(t, ev => { chainDirty(ev.target as Node) }, true)
    for (const t of ['transitionrun', 'animationstart']) document.addEventListener(t, ev => { const el = evEl(ev); if (el) { hot.set(el, (hot.get(el) || 0) + 1); deepStyleDirty.add(el); markGeom(el) } }, true)
    for (const t of ['transitionend', 'transitioncancel', 'animationend', 'animationcancel']) {
      document.addEventListener(t, ev => {
        const el = evEl(ev); if (!el) return
        const c = (hot.get(el) || 1) - 1
        if (c <= 0) hot.delete(el); else hot.set(el, c)
        deepStyleDirty.add(el); markGeom(el)
      }, true)
    }
    for (const t of ['load', 'error']) document.addEventListener(t, ev => { const el = evEl(ev); if (el && el !== document.documentElement) { stateDirty.add(el); geomAll = true } }, true)
    document.addEventListener('scroll', ev => {
      const t = ev.target
      if (t === document || t === document.documentElement || t === document.body || t === scroller()) { docScrolled = true; return }
      if (t instanceof Element) scrollDirty.add(t)
    }, true)
    window.addEventListener('resize', () => { needFull = true })
    try { document.fonts.addEventListener('loadingdone', () => { geomAll = true; for (const s of st.values()) if (s.text) textDirty.add(s.n) }) } catch { /* 없음 */ }
  }
  listen()

  // ── 읽기 ──
  const readCs = (el: Element): string[] => {
    const c = getComputedStyle(el)
    const out = new Array<string>(STY.length)
    for (let i = 0; i < STY.length; i++) out[i] = c.getPropertyValue(STY[i])
    return out
  }
  const pseudo = (el: Element, which: '::before' | '::after'): RawRec['pb'] | undefined => {
    const c = getComputedStyle(el, which)
    const content = c.getPropertyValue('content')
    if (!content || content === 'none' || content === 'normal' || c.getPropertyValue('display') === 'none') return undefined
    const m = /^"((?:[^"\\]|\\.)*)"$/.exec(content)   // 따옴표 문자열 하나만 허용(카운터·attr()·url() 은 폐기)
    if (!m) return undefined
    const text = m[1].replace(/\\(.)/g, '$1')
    if (!text.trim()) return undefined
    return [text.slice(0, 200), c.getPropertyValue('font-family'), c.getPropertyValue('font-size'), c.getPropertyValue('font-weight'), c.getPropertyValue('color')]
  }
  const parseM = (v: string): [number, number, number, number] | null => {
    if (!v || v === 'none') return null
    const mm = /^matrix(3d)?\(([^)]*)\)$/.exec(v.trim())
    if (!mm) return null
    const n = mm[2].split(',').map(x => parseFloat(x))
    const M: [number, number, number, number] = mm[1] ? [n[0], n[1], n[4], n[5]] : [n[0], n[1], n[2], n[3]]
    if (!M.every(Number.isFinite)) return null
    if (Math.abs(M[0] - 1) < 1e-4 && Math.abs(M[1]) < 1e-4 && Math.abs(M[2]) < 1e-4 && Math.abs(M[3] - 1) < 1e-4) return null
    return M
  }
  const mul = (p: number[], l: number[]): [number, number, number, number] =>
    [p[0] * l[0] + p[2] * l[1], p[1] * l[0] + p[3] * l[1], p[0] * l[2] + p[2] * l[3], p[1] * l[2] + p[3] * l[3]]

  interface Ctx { fv: boolean; ox: number; oy: number; m: [number, number, number, number] | null }
  const ROOT_CTX: Ctx = { fv: false, ox: 0, oy: 0, m: null }
  const childCtx = (el: Element, c: Ctx, cs: string[] | undefined): Ctx => {
    const cc = cs ?? readCs(el)
    const lm = parseM(cc[IX.transform])
    const isScr = el === scroller() || el === document.body
    return {
      fv: c.fv || cc[IX.position] === 'fixed',
      ox: c.ox + (isScr ? 0 : el.scrollLeft), oy: c.oy + (isScr ? 0 : el.scrollTop),
      m: lm ? (c.m ? mul(c.m, lm) : lm) : c.m,
    }
  }
  /** 요소 el 의 자식들이 사용하는 컨텍스트 */
  const ctxBelow = (el: Element | null): Ctx => {
    const chain: Element[] = []
    for (let e = el; e; e = e.parentElement) chain.push(e)
    let c = ROOT_CTX
    for (let i = chain.length - 1; i >= 0; i--) c = childCtx(chain[i], c, stOf(chain[i])?.cs)
    return c
  }
  const rectOf = (left: number, top: number, w: number, h: number, c: Ctx): [number, number, number, number] => {
    const bx = c.fv ? 0 : window.scrollX, by = c.fv ? 0 : window.scrollY
    return [r2(left + bx + c.ox), r2(top + by + c.oy), r2(w), r2(h)]
  }

  const range = document.createRange()
  const charTop = (t: Text, i: number): number | null => {
    range.setStart(t, i); range.setEnd(t, i + 1)
    const rs = range.getClientRects()
    return rs.length ? rs[0].top : null
  }
  const collapse = (s: string, ws: string): string => {
    if (ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces') return s.replace(/\n$/, '')
    if (ws === 'pre-line') return s.replace(/[ \t]+/g, ' ').replace(/\n$/, '')
    return s.replace(/[ \t\n\r\f]+/g, ' ')
  }
  /** 텍스트 노드 → 줄 런. 한 줄이면 한 번, 여러 줄이면 줄 경계를 이분 탐색 */
  const textRuns = (t: Text, ws: string, c: Ctx): [number, number, number, number, string][] => {
    const data = t.data
    if (!data) return []
    range.selectNodeContents(t)
    const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 || r.height > 0)
    if (!rects.length) return []
    const lines: { top: number; l: number; t: number; r: number; b: number }[] = []
    for (const r of rects) {
      const ln = lines.find(x => Math.abs(x.top - r.top) < Math.max(2, r.height / 2))
      if (ln) { ln.l = Math.min(ln.l, r.left); ln.t = Math.min(ln.t, r.top); ln.r = Math.max(ln.r, r.right); ln.b = Math.max(ln.b, r.bottom) } else lines.push({ top: r.top, l: r.left, t: r.top, r: r.right, b: r.bottom })
    }
    lines.sort((a, b) => a.top - b.top)
    const pre = ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces'
    /** 줄 상자 — 접히는 공백을 제거한 경우 왼쪽 끝을 첫 가시 글자의 왼쪽으로 설정한다(앞 공백만큼 글자가 당겨지지 않도록) */
    const mk = (ln: typeof lines[0], s: string, from: number, to: number): [number, number, number, number, string] => {
      let l = ln.l, r = ln.r
      if (!pre) {
        let i = from
        while (i < to && /[ \t\n\r\f]/.test(data[i])) i++
        if (i > from && i < to) { range.setStart(t, i); range.setEnd(t, i + 1); const q = range.getClientRects(); const f = q.length ? q[0] : null; if (f && Math.abs(f.top - ln.top) < Math.max(2, (ln.b - ln.t) / 2)) l = Math.max(l, f.left) }
        let j = to - 1
        while (j > i && /[ \t\n\r\f]/.test(data[j])) j--
        if (j < to - 1 && j >= i) { range.setStart(t, j); range.setEnd(t, j + 1); const q = range.getClientRects(); const f = q.length ? q[q.length - 1] : null; if (f && Math.abs(f.top - ln.top) < Math.max(2, (ln.b - ln.t) / 2)) r = Math.min(r, f.right) }
      }
      const rr = rectOf(l, ln.t, r - l, ln.b - ln.t, c)
      return [rr[0], rr[1], rr[2], rr[3], s]
    }
    // 접히는 공백만 제거한다(trim() 은 &nbsp; 까지 제거해 "▶&nbsp;R1" 의 간격이 소실되었다)
    const trimLine = (s: string) => (pre ? s : s.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, ''))
    if (lines.length === 1) {
      const s = trimLine(collapse(data, ws))
      return s ? [mk(lines[0], s, 0, data.length)] : []
    }
    const starts = [0]
    let lo = 0
    for (let k = 1; k < lines.length; k++) {
      const want = lines[k].top - Math.max(1, (lines[k].b - lines[k].t) / 3)
      let a = lo, b = data.length - 1, found = -1
      while (a <= b) {
        const mid = (a + b) >> 1
        let j = mid, top: number | null = null
        while (j <= b && (top = charTop(t, j)) === null) j++
        if (top === null) { b = mid - 1; continue }
        if (top >= want) { found = j; b = mid - 1 } else a = j + 1
      }
      if (found < 0) break
      starts.push(found); lo = found
    }
    const out: [number, number, number, number, string][] = []
    for (let k = 0; k < starts.length; k++) {
      const end = k + 1 < starts.length ? starts[k + 1] : data.length
      const s = trimLine(collapse(data.slice(starts[k], end), ws))
      if (s && lines[k]) out.push(mk(lines[k], s, starts[k], end))
    }
    return out
  }

  const svgGeom = (el: Element, depth: number): RawGeom[] => {
    const out: RawGeom[] = []
    if (depth > 8) return out
    for (const ch of Array.from(el.children)) {
      const tag = ch.tagName.toLowerCase()
      if (!SVG_KEEP.has(tag)) continue
      const c = getComputedStyle(ch)
      if (c.display === 'none' || c.visibility === 'hidden') continue
      const a: Record<string, string> = {}
      for (const k of GEOM_ATTRS) { const v = ch.getAttribute(k); if (v !== null) a[k] = v.slice(0, 20000) }
      const g: RawGeom = { n: tag === 'a' ? 'g' : tag === 'tspan' ? 'text' : tag, a, p: PAINT.map(k => c.getPropertyValue(k)) }
      if (tag === 'g' || tag === 'a') g.ch = svgGeom(ch, depth + 1)
      if (tag === 'text' || tag === 'tspan') {
        const tsp = Array.from(ch.children).filter(x => x.tagName.toLowerCase() === 'tspan' && (x.hasAttribute('x') || x.hasAttribute('y')))
        if (tsp.length && tag === 'text') { g.n = 'g'; g.ch = svgGeom(ch, depth + 1) } else g.t = (ch.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000)
      }
      out.push(g)
    }
    return out
  }

  const isWidget = (el: Element) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
  const widgetState = (el: Element): RawRec['w'] => {
    if (el instanceof HTMLInputElement) {
      const ty = el.type
      if (ty === 'password') return { n: el.value.length }
      if (ty === 'checkbox' || ty === 'radio') return { c: el.checked }
      if (ty === 'range') { const lo = parseFloat(el.min || '0'), hi = parseFloat(el.max || '100'), v = parseFloat(el.value); return { v: String(Number.isFinite(v) && hi > lo ? Math.max(0, Math.min(1, (v - lo) / (hi - lo))) : 0.5) } }
      if (ty === 'file') return { v: el.files && el.files.length ? Array.from(el.files).map(f => f.name).join(', ').slice(0, 300) : '' }
      return { v: el.value.slice(0, 10000) }
    }
    if (el instanceof HTMLTextAreaElement) return { v: el.value.slice(0, 10000) }
    if (el instanceof HTMLSelectElement) {
      const o = el.selectedOptions && el.selectedOptions[0]
      return { so: o ? (o.label || o.text || '').trim().slice(0, 500) : '' }
    }
    return undefined
  }
  const attrsOf = (el: Element): Record<string, string> | undefined => {
    const a: Record<string, string> = {}
    if (el instanceof HTMLImageElement) a.src = el.currentSrc || el.src || ''
    else if (el instanceof HTMLInputElement) {
      a.type = el.type
      if (el.type === 'image') a.src = el.src || ''
      if (el.placeholder) a.ph = el.placeholder.slice(0, 500)
      if (el.disabled) a.dis = '1'
      if (el.type === 'submit' || el.type === 'button' || el.type === 'reset') a.val = el.value.slice(0, 500)
    } else if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      if (el instanceof HTMLTextAreaElement && el.placeholder) a.ph = el.placeholder.slice(0, 500)
      if (el.disabled) a.dis = '1'
    } else if (el instanceof SVGSVGElement) {
      const vb = el.getAttribute('viewBox'); if (vb) a.vb = vb.slice(0, 200)
    }
    return Object.keys(a).length ? a : undefined
  }

  function removeSubtree(id: number): void {
    const s = st.get(id)
    if (!s) return
    const ks = domKids.get(id)
    if (ks) for (const k of Array.from(ks)) removeSubtree(k)
    domKids.delete(id)
    domKids.get(s.dp)?.delete(id)
    st.delete(id)
    dirty.delete(id)
    if (s.sent !== undefined) removedIds.push(id)
    if (!s.text) { stickies.delete(s.n as Element); hot.delete(s.n as Element) }
  }
  const unsend = (s: St) => { if (s.sent !== undefined) { removedIds.push(s.id); s.sent = undefined } }

  // ── 순회 ──
  interface Pass { full: boolean; style: number; geom: number; text: number }

  /** 기록 부모 탐색: DOM 조상 중 처음 나오는 기록된 노드(숨김·리프 하위면 null = 기록하지 않음) */
  const recParentOf = (n: Node): number | null => {
    for (let a: Node | null = n.parentNode; a && a !== document; a = a.parentNode) {
      if (a.nodeType === 1 && SKIP.has((a as Element).tagName)) return null
      const s = stOf(a)
      if (!s) return null
      if (s.hidden || s.leaf) return null
      if (s.rec) return s.id
    }
    return 0
  }
  const orderOf = (n: Node): number => { let i = 0; for (let c = n.parentNode?.firstChild ?? null; c; c = c.nextSibling) { i++; if (c === n) return i } return i }

  /**
   * 새 서브트리(또는 전체) 방문 — 스타일·기하·텍스트를 모두 조회한다.
   */
  function build(n: Node, p: number, dp: number, c: Ctx, pass: Pass, order: number): void {
    if (st.size >= cfg.maxNodes && !idOf.has(n)) { truncated = true; return }
    if (n.nodeType === 3) {
      const t = n as Text
      const id = getId(t)
      let s = st.get(id)
      if (!s) { s = { id, n: t, p, dp, text: true, rec: false, hidden: false, leaf: true, o: order }; st.set(id, s) }
      link(s, p, dp)
      if (s.o !== order) { s.o = order; touch(s) }
      measureText(s, c, pass)
      return
    }
    if (n.nodeType !== 1) return
    const el = n as Element
    if (SKIP.has(el.tagName)) return
    const id = getId(el)
    let s = st.get(id)
    if (!s) { s = { id, n: el, p, dp, text: false, rec: false, hidden: false, leaf: false, o: order }; st.set(id, s) }
    link(s, p, dp)
    restyle(s, pass, false)
    setOrder(s, order)
    if (s.hidden) return
    const myCtx = s.cs![IX.position] === 'fixed' ? { ...c, fv: true } : c
    measure(s, myCtx, c, pass)
    if (s.leaf) return
    const cc = childCtx(el, myCtx, s.cs)
    const childP = s.rec ? id : p
    let i = 0
    for (let ch = el.firstChild; ch; ch = ch.nextSibling) { i++; build(ch, childP, id, cc, pass, i) }
  }
  function link(s: St, p: number, dp: number): void {
    if (s.p !== p) { s.p = p; touch(s) }
    if (s.dp !== dp || !domKids.get(dp)?.has(s.id)) {
      domKids.get(s.dp)?.delete(s.id)
      s.dp = dp
      let set = domKids.get(dp); if (!set) { set = new Set(); domKids.set(dp, set) }
      set.add(s.id)
    }
  }
  function setOrder(s: St, order: number): void {
    const bucket = !s.text && s.cs && s.cs[IX.position] !== 'static' ? 1 : 0
    const o = bucket * 1e6 + order
    if (s.o !== o) { s.o = o; touch(s) }
  }

  /** 스타일 재조회. 변경 사항이 있으면 true. 상태(값·속성·svg·의사요소)도 함께 처리 */
  function restyle(s: St, pass: Pass, stateOnly: boolean): { changed: boolean; inherited: boolean; text: boolean; layout: boolean; self: boolean } {
    const el = s.n as Element
    let changed = false, inherited = false, textAffect = false, layout = false, self = false
    if (!stateOnly || !s.cs) {
      const cs = readCs(el)
      pass.style++
      const csj = cs.join('\u0001')
      if (csj !== s.csj) {
        const prev = s.cs
        changed = true
        if (!prev) { inherited = true; textAffect = true; layout = true } else {
          for (const i of INHERITED) if (prev[i] !== cs[i]) { inherited = true; break }
          for (const i of TEXT_AFFECT) if (prev[i] !== cs[i]) { textAffect = true; break }
          for (const i of LAYOUT_AFFECT) if (prev[i] !== cs[i]) { layout = true; break }
          if (prev[IX.transform] !== cs[IX.transform]) self = true
        }
        s.cs = cs; s.csj = csj; touch(s)
        if (cs[IX.position] === 'sticky') stickies.add(el); else stickies.delete(el)
      }
      const pb = pseudo(el, '::before'), pa = pseudo(el, '::after')
      if (!eqArr(pb, s.pb) || !eqArr(pa, s.pa)) { s.pb = pb; s.pa = pa; touch(s); changed = true; layout = true }
    }
    // 상태(값·속성·svg) — 자체 상자 내부만 변경되는 것으로 간주한다(속성 변이로 배치가 변경되는 경우는 onMut 이 이미 기하를 표시했다)
    const a = attrsOf(el)
    if (JSON.stringify(a) !== JSON.stringify(s.a)) { s.a = a; touch(s); changed = true; self = true }
    if (isWidget(el)) { const w = widgetState(el); if (JSON.stringify(w) !== JSON.stringify(s.w)) { s.w = w; touch(s); changed = true } }
    if (el instanceof SVGSVGElement) { const g = svgGeom(el, 0); const gj = JSON.stringify(g); if (gj !== JSON.stringify(s.g)) { s.g = g; touch(s); changed = true; self = true } }
    const sh = !!(el as HTMLElement).shadowRoot
    if (sh !== !!s.sh) { s.sh = sh; touch(s); changed = true }
    const tag = el.tagName
    s.leaf = el instanceof SVGSVGElement || INSET.has(tag) || tag === 'IMG' || isWidget(el) || sh
    const display = s.cs![IX.display]
    if (display === 'none') {
      if (!s.hidden) { s.hidden = true; const ks = domKids.get(s.id); if (ks) for (const k of Array.from(ks)) removeSubtree(k) }
      s.rec = false; unsend(s)
    } else if (s.hidden) {
      s.hidden = false
      // 다시 표시됨 → 자식을 새로 생성한다(구조 단계에서)
      structDirty.add(el)
    }
    if (s.leaf) { const ks = domKids.get(s.id); if (ks) for (const k of Array.from(ks)) removeSubtree(k) }
    return { changed, inherited, text: textAffect, layout, self }
  }

  // ── 지역 배치(부모 기준) — 수집기가 계산한다(부모 이동이 자식 갱신을 유발하지 않도록) ──
  const inv = (m: number[]): [number, number, number, number] => { const det = m[0] * m[3] - m[1] * m[2] || 1; return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det] }
  const apply = (m: number[], x: number, y: number): [number, number] => [m[0] * x + m[2] * y, m[1] * x + m[3] * y]
  const isId = (m: number[]) => Math.abs(m[0] - 1) < 1e-4 && Math.abs(m[1]) < 1e-4 && Math.abs(m[2]) < 1e-4 && Math.abs(m[3] - 1) < 1e-4
  const r4 = (v: number) => Math.round(v * 10000) / 10000
  /** 외접 W×H 와 M 으로 변환 전 w×h — W=|a|w+|c|h, H=|b|w+|d|h. 45° 근처(특이)면 균등 축척 근사 */
  const untransformSize = (W: number, H: number, M: number[]): [number, number] => {
    const a = Math.abs(M[0]), b = Math.abs(M[1]), c = Math.abs(M[2]), d = Math.abs(M[3])
    const det = a * d - c * b
    if (Math.abs(det) > 0.05 * (a * d + c * b + 1e-9)) {
      const w = (W * d - c * H) / det, h = (a * H - b * W) / det
      if (w > 0 && h > 0) return [w, h]
    }
    const k = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2])) || 1
    return [W / k, H / k]
  }
  const size0 = (s: St): [number, number] => {
    if (!s.r) return [0, 0]
    if (!s.m) return [s.r[2], s.r[3]]
    if (s.ow !== undefined && s.oh !== undefined && s.ow > 0 && s.oh > 0) return [s.ow, s.oh]
    return untransformSize(s.r[2], s.r[3], s.m)
  }
  const borderOf = (s: St): [number, number] => (s.cs ? [parseFloat(s.cs[IX['border-left-width']]) || 0, parseFloat(s.cs[IX['border-top-width']]) || 0] : [0, 0])
  const placeOf = (s: St): { L: [number, number, number, number]; lm?: [number, number, number, number] } => {
    const [w0, h0] = size0(s)
    const cx = s.r![0] + s.r![2] / 2, cy = s.r![1] + s.r![3] / 2
    const P = s.fr ? undefined : st.get(s.p)
    if (!P || !P.r) return { L: [r2(cx - w0 / 2), r2(cy - h0 / 2), r2(w0), r2(h0)], lm: s.m && !isId(s.m) ? s.m.map(r4) as [number, number, number, number] : undefined }
    const [pw0, ph0] = size0(P)
    let dx = cx - (P.r[0] + P.r[2] / 2), dy = cy - (P.r[1] + P.r[3] / 2)
    let lm: number[] | undefined = s.m
    if (P.m) { const pi = inv(P.m); [dx, dy] = apply(pi, dx, dy); lm = s.m ? mul(pi, s.m) : pi }
    const [bl, bt] = borderOf(P)
    return { L: [r2(dx + pw0 / 2 - w0 / 2 - bl), r2(dy + ph0 / 2 - h0 / 2 - bt), r2(w0), r2(h0)], lm: lm && !isId(lm) ? lm.map(r4) as [number, number, number, number] : undefined }
  }

  /** 기하 측정(자체만). 크기가 변경되었거나 새로 표시된 경우 true(→ 텍스트 자식도 재측정한다) */
  function measure(s: St, myCtx: Ctx, parentCtx: Ctx, pass: Pass): boolean {
    const el = s.n as Element
    const cs = s.cs!
    pass.geom++
    const b = el.getBoundingClientRect()
    const contents = cs[IX.display] === 'contents'
    const nobox = contents || (b.width === 0 && b.height === 0 && !(el instanceof SVGSVGElement) && el.getClientRects().length === 0)
    if (nobox) {
      if (s.rec) { s.rec = false; unsend(s) }
      return false
    }
    let resized = false
    if (!s.rec) { s.rec = true; touch(s); resized = true }
    const r = rectOf(b.left, b.top, b.width, b.height, myCtx)
    if (!s.r || r[2] !== s.r[2] || r[3] !== s.r[3]) resized = true
    s.r = r
    const lm = parseM(cs[IX.transform])
    const macc = lm ? (parentCtx.m ? mul(parentCtx.m, lm) : lm) : parentCtx.m
    s.m = macc ? macc.map(r4) as [number, number, number, number] : undefined
    if (s.m && el instanceof HTMLElement) { s.ow = el.offsetWidth; s.oh = el.offsetHeight } else s.ow = s.oh = undefined
    const fr = cs[IX.position] === 'fixed'
    if (!!s.fr !== fr) { s.fr = fr; touch(s) }
    s.fv = myCtx.fv
    const pl = placeOf(s)
    if (!eqArr(pl.L, s.L) || !eqArr(pl.lm, s.lm)) { s.L = pl.L; s.lm = pl.lm; touch(s) }
    let sc: St['sc']
    const ox = cs[IX['overflow-x']], oy = cs[IX['overflow-y']]
    if (el !== scroller() && el !== document.body && (ox !== 'visible' || oy !== 'visible') && el instanceof HTMLElement) {
      if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1 || el.scrollLeft || el.scrollTop) sc = [el.scrollWidth, el.scrollHeight, r2(el.scrollLeft), r2(el.scrollTop)]
    }
    if (!eqArr(sc, s.sc)) { s.sc = sc; touch(s) }
    return resized
  }

  function measureText(s: St, c: Ctx, pass: Pass): void {
    const t = s.n as Text
    const pe = t.parentElement
    const ps = stOf(pe)
    const ws = ps?.cs ? ps.cs[IX['white-space']] : 'normal'
    const tx = textRuns(t, ws, c)
    pass.text++
    const rec = tx.length > 0
    if (rec !== s.rec) { s.rec = rec; if (rec) touch(s); else unsend(s) }
    if (!rec) { s.tx = undefined; s.txl = undefined; s.txj = undefined; return }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const q of tx) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0] + q[2]); y1 = Math.max(y1, q[1] + q[3]) }
    s.r = [r2(x0), r2(y0), r2(x1 - x0), r2(y1 - y0)]
    s.m = c.m ? c.m.map(r4) as [number, number, number, number] : undefined
    s.ow = s.oh = undefined
    s.tx = tx
    const pl = placeOf(s)
    const [w0, h0] = size0(s)
    const ccx = s.r[0] + s.r[2] / 2, ccy = s.r[1] + s.r[3] / 2
    const mi = s.m ? inv(s.m) : null
    const txl = tx.map(q => {
      if (!mi) return [r2(q[0] - s.r![0]), r2(q[1] - s.r![1]), q[2], q[3], q[4]] as [number, number, number, number, string]
      const [vx, vy] = apply(mi, q[0] + q[2] / 2 - ccx, q[1] + q[3] / 2 - ccy)
      const [rw, rh] = untransformSize(q[2], q[3], s.m!)
      return [r2(vx + w0 / 2 - rw / 2), r2(vy + h0 / 2 - rh / 2), r2(rw), r2(rh), q[4]] as [number, number, number, number, string]
    })
    const j = JSON.stringify([pl.L, pl.lm, txl])
    if (j !== s.txj) { s.L = pl.L; s.lm = pl.lm; s.txl = txl; s.txj = j; touch(s) }
  }

  /** 기하 서브트리 측정(스타일은 캐시). 텍스트는 부모 상자가 변경되었거나 표시된 경우에만 */
  function regeom(el: Element, c: Ctx, pass: Pass): void {
    const s = stOf(el)
    if (!s || s.hidden) return
    const myCtx = s.cs![IX.position] === 'fixed' ? { ...c, fv: true } : c
    const resized = measure(s, myCtx, c, pass)
    if (s.leaf) return
    const cc = childCtx(el, myCtx, s.cs)
    const textToo = resized || textDirty.has(el)
    for (let ch = el.firstChild; ch; ch = ch.nextSibling) {
      if (ch.nodeType === 1) { if (!SKIP.has((ch as Element).tagName)) regeom(ch as Element, cc, pass) } else if (ch.nodeType === 3 && textToo) {
        const ts = stOf(ch); if (ts) measureText(ts, cc, pass)
      }
    }
  }

  /** 부분 기하: 루트의 기록 부모를 먼저 측정하고(지역 배치의 기준) 루트 서브트리를 측정한다 */
  function regeomRoot(el: Element, pass: Pass): void {
    const s = stOf(el)
    if (!s) return
    const P = st.get(s.p)
    if (P && !P.text && P.n.isConnected && P.cs && !P.hidden) {
      const pe = P.n as Element
      const pc = ctxBelow(pe.parentElement)
      measure(P, P.cs[IX.position] === 'fixed' ? { ...pc, fv: true } : pc, pc, pass)
    }
    regeom(el, ctxBelow(el.parentElement), pass)
  }

  /** 스타일 서브트리(속성 변화·상속 변화) */
  function restyleDeep(el: Element, pass: Pass, deep: boolean, seen: Set<Element>): void {
    if (seen.has(el)) return
    seen.add(el)
    const s = stOf(el)
    if (!s) return
    const r = restyle(s, pass, false)
    if (r.layout) markGeom(el); else if (r.self) geomRoots.add(el)
    if (r.text) textDirty.add(el)
    if (s.hidden || s.leaf) return
    if (deep || r.inherited) for (let ch = el.firstElementChild; ch; ch = ch.nextElementSibling) if (!SKIP.has(ch.tagName)) restyleDeep(ch, pass, deep, seen)
  }

  // ── 틱 ──
  function docInfo(): TickResult['doc'] {
    const se = scroller() as HTMLElement
    const hb = getComputedStyle(document.documentElement).backgroundColor
    const bb = document.body ? getComputedStyle(document.body).backgroundColor : ''
    const transparent = (v: string) => !v || v === 'rgba(0, 0, 0, 0)' || v === 'transparent'
    return {
      cw: Math.max(se.scrollWidth, window.innerWidth), ch: Math.max(se.scrollHeight, window.innerHeight),
      vw: document.documentElement.clientWidth || window.innerWidth, vh: document.documentElement.clientHeight || window.innerHeight,
      sx: r2(window.scrollX), sy: r2(window.scrollY),
      url: location.href.slice(0, 4096), title: (document.title || '').slice(0, 300),
      bg: !transparent(hb) ? hb : !transparent(bb) ? bb : 'rgb(255, 255, 255)',
    }
  }

  function focusInfo(): TickResult['focus'] {
    const a = document.activeElement
    if (!a || a === document.body) return null
    const s = stOf(a)
    if (!s) return null
    if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) {
      const ty = a instanceof HTMLInputElement ? a.type : 'textarea'
      let ss = 0, se = 0
      try { ss = a.selectionStart ?? 0; se = a.selectionEnd ?? 0 } catch { /* number 등 */ }
      if (ty === 'password') return { id: s.id, wk: 'password', n: a.value.length, ss, se }
      if (['checkbox', 'radio', 'submit', 'button', 'range', 'file', 'image', 'reset', 'color'].includes(ty)) return { id: s.id, wk: ty, n: 0, ss: 0, se: 0 }
      return { id: s.id, wk: ty === 'textarea' ? 'textarea' : 'text', n: a.value.length, ss, se, v: a.value.slice(0, 10000) }
    }
    return { id: s.id, wk: a instanceof HTMLSelectElement ? 'select' : 'other', n: 0, ss: 0, se: 0 }
  }

  function emit(s: St): RawRec | null {
    if (!s.rec || !s.L) return null
    if (s.text) {
      if (!s.txl || !s.txl.length) return null
      const ps = stOf(s.n.parentElement)
      const rec: RawRec = { i: s.id, p: s.p, t: 'x', o: s.o, r: s.L, tx: s.txl, ps: ps ? ps.id : 0 }
      if (s.lm) rec.m = s.lm
      return rec
    }
    if (!s.cs) return null
    const rec: RawRec = { i: s.id, p: s.p, t: 'e', n: (s.n as Element).tagName.toLowerCase(), o: s.o, r: s.L, cs: s.cs }
    if (s.lm) rec.m = s.lm
    if (s.fr) rec.fr = 1
    if (s.sc) rec.sc = s.sc
    if (s.a) rec.a = s.a
    if (s.w) rec.w = s.w
    if (s.g) rec.g = s.g
    if (s.pb) rec.pb = s.pb
    if (s.pa) rec.pa = s.pa
    if (s.sh) rec.sh = 1
    return rec
  }

  const visitNew = (n: Node, pass: Pass) => {
    if (!n.isConnected) return
    const p = recParentOf(n)
    if (p === null) return
    const parent = n.parentNode
    const dp = parent ? idOf.get(parent) ?? 0 : 0
    const pc = parent && parent.nodeType === 1 ? ctxBelow(parent as Element) : ROOT_CTX
    build(n, p, dp, pc, pass, orderOf(n))
  }

  function tick(opts: { full?: boolean; paint?: boolean }): string {
    const t0 = performance.now()
    if (document.documentElement !== listenRoot) { listen(); needFull = true }
    const pass: Pass = { full: false, style: 0, geom: 0, text: 0 }
    onMut(mo.takeRecords())
    let verify = false
    let wasGeomAll = geomAll
    if (opts.full || needFull) {
      needFull = false
      pass.full = true
      wasGeomAll = true
      truncated = false
      for (const s of st.values()) s.sent = undefined
      st.clear(); domKids.clear(); removedIds.length = 0; dirty.clear()
      build(document.documentElement, 0, 0, ROOT_CTX, pass, 1)
    } else {
      // ① 구조 — 새 노드는 전체를, 자식 목록이 변경된 부모는 순서만 재조회
      for (const n of structDirty) {
        if (!n.isConnected) continue
        const s = stOf(n)
        if (!s) { visitNew(n, pass); continue }
        if (n.nodeType !== 1 || s.hidden || s.leaf) continue
        let i = 0
        for (let c = n.firstChild; c; c = c.nextSibling) {
          i++
          const cs = stOf(c)
          if (!cs) visitNew(c, pass)
          else if (cs.text) { if (cs.o !== i) { cs.o = i; touch(cs) } } else setOrder(cs, i)
        }
      }
      // ② 스타일
      const seen = new Set<Element>()
      for (const el of deepStyleDirty) if (el.isConnected) restyleDeep(el, pass, true, seen)
      for (const el of hot.keys()) { if (!el.isConnected) { hot.delete(el); continue } restyleDeep(el, pass, true, seen); geomRoots.add(el) }
      for (const el of styleDirty) if (el.isConnected) restyleDeep(el, pass, false, seen)
      for (const el of stateDirty) {
        if (seen.has(el) || !el.isConnected) continue
        const s = stOf(el)
        if (s) { const r = restyle(s, pass, true); if (r.layout) markGeom(el); else if (r.self) geomRoots.add(el) }
      }
      // 다시 표시된 요소(②에서 structDirty 에 추가됨) — 자식을 새로 생성
      for (const n of structDirty) {
        const s = stOf(n)
        if (s && !s.hidden && !s.leaf && n.nodeType === 1) for (let c = n.firstChild; c; c = c.nextSibling) if (!stOf(c)) visitNew(c, pass)
      }
      // ③ 기하 — 문서 전체 또는 흐름 밖 서브트리만
      if (geomAll) regeom(document.documentElement, ROOT_CTX, pass)
      else for (const r of geomRoots) if (r.isConnected) regeomRoot(r, pass)
      // ④ 텍스트 — 문자 변화, 텍스트 영향 스타일 변화, 자식 목록 변화
      for (const t of textDirty) {
        if (!t.isConnected) continue
        if (t.nodeType === 3) { const s = stOf(t); if (s) measureText(s, ctxBelow(t.parentElement), pass) } else if (t.nodeType === 1) {
          const ps = stOf(t)
          if (!ps || ps.hidden || ps.leaf) continue
          const c = ctxBelow(t as Element)
          for (let ch = t.firstChild; ch; ch = ch.nextSibling) if (ch.nodeType === 3) { const s = stOf(ch); if (s) measureText(s, c, pass) }
        }
      }
      // ⑤ 스크롤된 컨테이너 — sc 만 갱신(자손 좌표는 스크롤 불변이므로 유지)
      for (const el of scrollDirty) {
        const s = stOf(el)
        if (!s || !s.rec || !(el instanceof HTMLElement)) continue
        const sc: St['sc'] = [el.scrollWidth, el.scrollHeight, r2(el.scrollLeft), r2(el.scrollTop)]
        if (!eqArr(sc, s.sc)) { s.sc = sc; touch(s) }
      }
      if (docScrolled || scrollDirty.size) for (const el of stickies) if (el.isConnected) regeomRoot(el, pass)
      // ⑥ 검증 — 페인트는 있었으나 표시된 변경이 없음(:hover 류·컨테이너 쿼리·스크립트 없는 시각 변화): 뷰포트 내부만, 간헐적으로 수행
      const nothing = pass.style === 0 && pass.geom === 0 && pass.text === 0
      if (opts.paint) paintSinceVerify = true
      if (nothing && paintSinceVerify && t0 - lastVerify > cfg.verifyMs) {
        verify = true; lastVerify = t0; paintSinceVerify = false
        const vw = window.innerWidth, vh = window.innerHeight
        const seen2 = new Set<Element>()
        for (const s of Array.from(st.values())) {
          if (s.text || !s.rec || !s.n.isConnected) continue
          const b = (s.n as Element).getBoundingClientRect()
          if (b.bottom >= 0 && b.right >= 0 && b.top <= vh && b.left <= vw) restyleDeep(s.n as Element, pass, false, seen2)
        }
        if (geomAll) regeom(document.documentElement, ROOT_CTX, pass)
        else for (const r of geomRoots) if (r.isConnected) regeomRoot(r, pass)
      }
    }
    structDirty.clear(); deepStyleDirty.clear(); styleDirty.clear(); stateDirty.clear(); textDirty.clear(); geomRoots.clear(); scrollDirty.clear()
    geomAll = false; docScrolled = false
    // 부모 스타일이 변경된 텍스트도 전송한다(텍스트 스타일 = 부모 계산값 — 에이전트가 부모 cs 로 치환한다)
    const ids = Array.from(dirty)
    dirty.clear()
    const extra: number[] = []
    for (const id of ids) {
      const s = st.get(id)
      if (s && !s.text) { const ks = domKids.get(id); if (ks) for (const k of ks) { const kn = st.get(k); if (kn && kn.text) extra.push(k) } }
    }
    const recs: RawRec[] = []
    for (const id of ids.concat(extra)) {
      const s = st.get(id)
      if (!s) continue
      const rec = emit(s)
      if (!rec) continue
      const j = JSON.stringify(rec)
      if (j === s.sent) continue
      s.sent = j
      recs.push(rec)
    }
    const del = removedIds.splice(0)
    const res: TickResult = {
      full: pass.full, recs, del, doc: docInfo(), focus: focusInfo(), ms: Math.round((performance.now() - t0) * 100) / 100,
      nodes: st.size, work: { style: pass.style, geom: pass.geom, text: pass.text, verify, geomAll: wasGeomAll, recs: recs.length }, truncated,
    }
    return JSON.stringify(res)
  }

  /** 노드 id + 상대좌표 → 현재 뷰포트 좌표(입력용). 텍스트면 노드 상자 기준 */
  function pt(id: number, rx: number, ry: number): [number, number] | null {
    const s = st.get(id)
    if (!s || !s.n.isConnected) return null
    let b: DOMRect
    if (s.text) { range.selectNodeContents(s.n); b = range.getBoundingClientRect() } else b = (s.n as Element).getBoundingClientRect()
    const x = b.left + Math.max(0, Math.min(b.width, rx)), y = b.top + Math.max(0, Math.min(b.height, ry))
    return [Math.round(x * 100) / 100, Math.round(y * 100) / 100]
  }
  /** 노드의 현재 뷰포트 사각형(캡처용) */
  function vrect(id: number): [number, number, number, number] | null {
    const s = st.get(id)
    if (!s || !s.n.isConnected || s.text) return null
    const b = (s.n as Element).getBoundingClientRect()
    return [b.left, b.top, b.width, b.height]
  }
  /** 포인터 아래 체인이 변경되면(:hover) 변경된 요소만 스타일 변경 대상으로 표시 */
  let hoverChain: Element[] = []
  function pointer(x: number, y: number): void {
    const e = document.elementFromPoint(x, y)
    const chain: Element[] = []
    for (let a = e; a; a = a.parentElement) chain.push(a)
    const prev = new Set(hoverChain), now = new Set(chain)
    for (const a of hoverChain) if (!now.has(a)) styleDirty.add(a)
    for (const a of chain) if (!prev.has(a)) styleDirty.add(a)
    hoverChain = chain
  }
  /** :active·:focus — 누르기·떼기 시 체인 전체 */
  function active(): void { for (const a of hoverChain) styleDirty.add(a); chainDirty(document.activeElement) }
  function scrollNode(id: number, x: number, y: number): boolean {
    if (id === 0) { window.scrollTo(x, y); return true }
    const s = st.get(id)
    if (!s || s.text || !s.n.isConnected) return false
    const el = s.n as Element
    el.scrollLeft = x; el.scrollTop = y
    scrollDirty.add(el)
    return true
  }
  /** 원격의 현재 선택 텍스트(복사용) — 입력칸 선택(비밀번호 제외) 또는 문서 선택 */
  function selection(): string {
    const a = document.activeElement
    if ((a instanceof HTMLInputElement && a.type !== 'password') || a instanceof HTMLTextAreaElement) {
      try { const s = a.selectionStart ?? 0, e = a.selectionEnd ?? 0; if (e > s) return a.value.slice(s, e) } catch { /* 선택 없음 */ }
    }
    const sel = window.getSelection()
    return sel ? sel.toString().slice(0, 100000) : ''
  }
  function el(id: number): Node | null { return st.get(id)?.n ?? null }

  W.__jwm = { tick, pt, vrect, pointer, active, scrollNode, selection, el, v: 1 }
}
