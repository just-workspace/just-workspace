/**
 * 문서에 삽입되는 개체 — 메모 표시 마크, 도형, 차트.
 *
 * 서식 확장(docExtensions.ts)과 분리한 이유는 성격이 상이하기 때문이다. 서식 확장은 글자·문단에 적용하는
 * 속성이고, 본 모듈은 문서에 삽입하는 개체이다.
 */
import { Mark, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

/**
 * 메모(코멘트) 표시 마크.
 *
 * 메모 본문은 Y.Map('comments') 에 별도로 저장하고, 문서 본문에는 대상 구간(id)만 기록한다.
 * 문서 본문에 메모 내용까지 포함하면 docx 내보내기 시 메모가 본문에 섞여 출력된다.
 */
export const CommentMark = Mark.create({
  name: 'comment',
  inclusive: () => false,
  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-comment'),
        renderHTML: (a: any) => (a.commentId ? { 'data-comment': a.commentId } : {}),
      },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-comment]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'doc-comment' }), 0]
  },
  addCommands() {
    return {
      setComment: (id: string) => ({ commands }: any) => commands.setMark('comment', { commentId: id }),
      unsetComment: () => ({ commands }: any) => commands.unsetMark('comment'),
    } as any
  },
})

/**
 * 변경 내용 추적 — **새로 작성된 내용만** 표시한다.
 *
 * 삭제까지 추적하려면 삭제된 글을 문서에 남겨 두었다가(취소선) 이후 제거해야 하는데,
 * 이는 편집 중 트랜잭션을 롤백한 뒤 재적용하는 작업이므로 CRDT 동기화와 정면으로 충돌한다.
 * 두 사용자가 같은 위치를 수정하면 원본이 무엇이었는지 합의할 방법이 없다.
 * 따라서 본 모듈은 "누가 새로 쓴 부분" 만 표시하고, 삭제된 내용은 파일 버전 기록에 위임한다.
 */
export const trackState = { on: false }

export const TrackChanges = Mark.create({
  name: 'insertion',
  inclusive: () => true,
  addAttributes() {
    return {
      by: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-ins'),
        renderHTML: (a: any) => (a.by ? { 'data-ins': a.by } : {}),
      },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-ins]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'doc-ins' }), 0]
  },
  addCommands() {
    return {
      // 모두 적용: 표시만 제거하면 그대로 본문이 된다.
      acceptAllChanges: () => ({ tr, state, dispatch }: any) => {
        if (dispatch) {
          tr.removeMark(0, state.doc.content.size, state.schema.marks.insertion)
          dispatch(tr)
        }
        return true
      },
      // 모두 취소: 표시된 구간을 삭제한다. 뒤에서부터 삭제해야 앞쪽 위치가 변하지 않는다.
      rejectAllChanges: () => ({ tr, state, dispatch }: any) => {
        const ranges: { from: number; to: number }[] = []
        state.doc.descendants((node: any, pos: number) => {
          if (node.isText && node.marks.some((m: any) => m.type.name === 'insertion')) {
            ranges.push({ from: pos, to: pos + node.nodeSize })
          }
        })
        if (dispatch) {
          for (const r of ranges.reverse()) tr.delete(r.from, r.to)
          dispatch(tr)
        }
        return true
      },
    } as any
  },
  addProseMirrorPlugins() {
    const type = this.type
    return [
      new Plugin({
        key: new PluginKey('trackChanges'),
        appendTransaction(trs, _old, newState) {
          if (!trackState.on) return null
          let tr: any = null
          for (const t of trs) {
            if (!t.docChanged || t.getMeta('addToHistory') === false) continue
            t.steps.forEach((_step: any, i: number) => {
              t.mapping.maps[i].forEach((_os: number, _oe: number, ns: number, ne: number) => {
                if (ne <= ns) return
                tr = tr || newState.tr
                tr.addMark(ns, Math.min(ne, newState.doc.content.size), type.create())
              })
            })
          }
          return tr
        },
      }),
    ]
  },
})

// ── 수식 ────────────────────────────────────────────────
// 수식 편집기 전체를 구현하지 않고, 자주 사용하는 표기만 HTML 로 변환한다. sup/sub 은 이미
// 스키마에 있는 태그이므로 그대로 보존되며 docx 로도 변환된다. 이미지로 렌더링하지 않는 이유는
// 이후 글자 수정이 가능해야 하기 때문이다.

const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
  rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ',
  Psi: 'Ψ', Omega: 'Ω',
}

const OPS: Record<string, string> = {
  times: '×', div: '÷', pm: '±', mp: '∓', le: '≤', ge: '≥', ne: '≠', approx: '≈',
  equiv: '≡', sum: '∑', prod: '∏', int: '∫', infty: '∞', partial: '∂', nabla: '∇',
  cdot: '·', to: '→', gets: '←', Rightarrow: '⇒', Leftrightarrow: '⇔', in: '∈',
  notin: '∉', subset: '⊂', cup: '∪', cap: '∩', forall: '∀', exists: '∃', deg: '°',
}

function escHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 간단한 LaTeX 풍 표기를 HTML 로 변환.
 *   x^2, a_1, \frac{a}{b}, \sqrt{x}, \alpha, \times …
 */
export function formulaToHtml(src: string): string {
  let out = ''
  let i = 0
  const readGroup = (): string => {
    // {...} 이면 괄호 내부, 아니면 한 글자
    if (src[i] === '{') {
      let depth = 1
      let j = i + 1
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth++
        else if (src[j] === '}') depth--
        j++
      }
      const inner = src.slice(i + 1, j - 1)
      i = j
      return formulaToHtml(inner)
    }
    const ch = src[i] ?? ''
    i++
    return escHtml(ch)
  }

  while (i < src.length) {
    const ch = src[i]
    if (ch === '^') { i++; out += `<sup>${readGroup()}</sup>`; continue }
    if (ch === '_') { i++; out += `<sub>${readGroup()}</sub>`; continue }
    if (ch === '\\') {
      const m = /^[A-Za-z]+/.exec(src.slice(i + 1))
      const name = m ? m[0] : ''
      if (name === 'frac') {
        i += 1 + name.length
        const a = readGroup()
        const b = readGroup()
        out += `(${a})/(${b})`
        continue
      }
      if (name === 'sqrt') {
        i += 1 + name.length
        out += `&#8730;(${readGroup()})`
        continue
      }
      if (name && (GREEK[name] || OPS[name])) {
        i += 1 + name.length
        out += GREEK[name] || OPS[name]
        continue
      }
      i++
      continue
    }
    out += escHtml(ch)
    i++
  }
  return out
}

// ── 도형 · 차트 ─────────────────────────────────────────
// 둘 다 편집 가능한 개체가 아닌 **렌더링된 그림**으로 삽입한다. 부유 개체 레이어
// (위치·크기·앵커·핸들)를 구현하려면 편집기 구조 전체를 변경해야 하며, 도형 삽입만을
// 위한 비용으로는 과도하다. SVG 이므로 확대해도 품질이 유지되고 docx 로도 그대로 내보내진다.

export type ShapeKind = 'rect' | 'circle' | 'triangle' | 'arrow' | 'line' | 'star'

const SHAPE_BODY: Record<ShapeKind, string> = {
  rect: '<rect x="6" y="16" width="148" height="68" rx="6" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>',
  circle: '<ellipse cx="80" cy="50" rx="72" ry="40" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>',
  triangle: '<polygon points="80,10 152,90 8,90" fill="#fef9c3" stroke="#ca8a04" stroke-width="2"/>',
  arrow: '<path d="M8 50h108M96 30l24 20-24 20" fill="none" stroke="#dc2626" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  line: '<path d="M8 50h144" stroke="#374151" stroke-width="3" stroke-linecap="round"/>',
  star: '<polygon points="80,10 97,42 133,47 106,72 113,108 80,90 47,108 54,72 27,47 63,42" fill="#fae8ff" stroke="#a21caf" stroke-width="2"/>',
}

/** 도형 목록 — labelKey 는 이름 i18n 키 */
export const SHAPES: { kind: ShapeKind; labelKey: string }[] = [
  { kind: 'rect', labelKey: 'files.office.shape.rect' },
  { kind: 'circle', labelKey: 'files.office.shape.circle' },
  { kind: 'triangle', labelKey: 'files.office.shape.triangle' },
  { kind: 'arrow', labelKey: 'files.office.shape.arrow' },
  { kind: 'line', labelKey: 'files.office.shape.line' },
  { kind: 'star', labelKey: 'files.office.shape.star' },
]

function svgDataUri(svg: string): string {
  // base64 대신 URI 인코딩을 사용한다. 문서 HTML 안에서 사람이 읽을 수 있고, 동일한 그림이면
  // 문자열도 동일하여 CRDT 병합에서 불필요한 차이가 발생하지 않는다.
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
}

export function shapeDataUri(kind: ShapeKind): string {
  const body = SHAPE_BODY[kind] || SHAPE_BODY.rect
  return svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 118" width="160" height="118">${body}</svg>`,
  )
}

export interface ChartSpec {
  kind: 'bar' | 'line' | 'pie'
  labels: string[]
  values: number[]
  title?: string
}

const CHART_COLORS = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d']

function esc(t: string): string {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 값 배열로 SVG 차트를 생성한다. 차트 라이브러리를 문서 편집기에 도입하지 않기 위함이다. */
export function chartDataUri(spec: ChartSpec): string {
  const W = 460
  const H = 260
  const PAD = 34
  const vals = spec.values.map(v => (Number.isFinite(v) ? v : 0))
  const max = Math.max(1, ...vals)
  let body = ''

  if (spec.kind === 'pie') {
    const total = vals.reduce((a, b) => a + b, 0) || 1
    const cx = W / 2 - 40
    const cy = H / 2 + 6
    const r = 88
    let angle = -Math.PI / 2
    vals.forEach((v, i) => {
      const slice = (v / total) * Math.PI * 2
      const x1 = cx + r * Math.cos(angle)
      const y1 = cy + r * Math.sin(angle)
      angle += slice
      const x2 = cx + r * Math.cos(angle)
      const y2 = cy + r * Math.sin(angle)
      const large = slice > Math.PI ? 1 : 0
      body += `<path d="M${cx} ${cy}L${x1.toFixed(1)} ${y1.toFixed(1)}`
        + `A${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}Z" `
        + `fill="${CHART_COLORS[i % CHART_COLORS.length]}" stroke="#fff" stroke-width="1.5"/>`
    })
    spec.labels.forEach((l, i) => {
      body += `<rect x="${W - 126}" y="${34 + i * 19}" width="11" height="11" fill="${CHART_COLORS[i % CHART_COLORS.length]}"/>`
        + `<text x="${W - 108}" y="${44 + i * 19}" font-size="11" fill="#374151">${esc(l)}</text>`
    })
  } else {
    const plotW = W - PAD * 2
    const plotH = H - PAD * 2
    body += `<line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="#9ca3af"/>`
      + `<line x1="${PAD}" y1="${PAD}" x2="${PAD}" y2="${H - PAD}" stroke="#9ca3af"/>`

    const slot = plotW / Math.max(1, vals.length)
    if (spec.kind === 'bar') {
      vals.forEach((v, i) => {
        const h = (v / max) * plotH
        body += `<rect x="${(PAD + i * slot + slot * 0.18).toFixed(1)}" y="${(H - PAD - h).toFixed(1)}" `
          + `width="${(slot * 0.64).toFixed(1)}" height="${h.toFixed(1)}" `
          + `fill="${CHART_COLORS[i % CHART_COLORS.length]}"/>`
      })
    } else {
      const step = plotW / Math.max(1, vals.length - 1)
      const pts = vals
        .map((v, i) => `${(PAD + i * step).toFixed(1)},${(H - PAD - (v / max) * plotH).toFixed(1)}`)
        .join(' ')
      body += `<polyline points="${pts}" fill="none" stroke="${CHART_COLORS[0]}" stroke-width="2.5" stroke-linejoin="round"/>`
      vals.forEach((v, i) => {
        body += `<circle cx="${(PAD + i * step).toFixed(1)}" cy="${(H - PAD - (v / max) * plotH).toFixed(1)}" r="3.5" fill="${CHART_COLORS[0]}"/>`
      })
    }

    spec.labels.forEach((l, i) => {
      const x = spec.kind === 'bar'
        ? PAD + i * slot + slot / 2
        : PAD + i * (plotW / Math.max(1, vals.length - 1))
      body += `<text x="${x.toFixed(1)}" y="${H - PAD + 15}" font-size="10" fill="#4b5563" text-anchor="middle">${esc(l)}</text>`
    })
  }

  const title = spec.title
    ? `<text x="${W / 2}" y="20" font-size="13" font-weight="600" fill="#111827" text-anchor="middle">${esc(spec.title)}</text>`
    : ''
  return svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`
    + `<rect width="${W}" height="${H}" fill="#ffffff"/>${title}${body}</svg>`,
  )
}

/** "10, 20, 30" 또는 "1월=10, 2월=20" 을 라벨·값으로 분리한다. */
export function parseChartInput(raw: string): { labels: string[]; values: number[] } {
  const labels: string[] = []
  const values: number[] = []
  raw.split(/[,\n]/).forEach((part, i) => {
    const t = part.trim()
    if (!t) return
    const eq = t.indexOf('=')
    if (eq > 0) {
      labels.push(t.slice(0, eq).trim())
      values.push(parseFloat(t.slice(eq + 1)) || 0)
    } else {
      labels.push(String(i + 1))
      values.push(parseFloat(t) || 0)
    }
  })
  return { labels, values }
}
