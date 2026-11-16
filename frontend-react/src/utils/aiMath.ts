// AI 답변 수식 — markdown-it 규칙: 인라인 $…$ · 블록 $$…$$ 를 KaTeX(MIT)로 렌더링한다.
// 인라인 규칙이므로 코드(`…`)·코드펜스 내부에는 적용되지 않는다. 금액 표기("$5 와 $10")는 수식으로 간주하지 않는다:
//  여는 $ 뒤가 공백이면 불가하며, 닫는 $ 앞이 공백이거나 뒤가 숫자이면 닫는 $ 가 아니다(pandoc 규칙).
// KaTeX 는 최초 필요 시점에 로드한다(getAiKatex) — 로드 전에는 원문을 코드 형태로 표시한다.

type Katex = { renderToString: (tex: string, opts?: Record<string, unknown>) => string }

let _p: Promise<Katex> | null = null
let _k: Katex | null = null

/** KaTeX(+ CSS) 1회만 로드 */
export function getAiKatex(): Promise<Katex> {
  if (!_p) {
    _p = Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([m]) => {
      _k = ((m as any).default ?? m) as Katex
      return _k
    })
  }
  return _p
}

/** 이미 로드된 KaTeX(없으면 null) */
export function aiKatexLoaded(): Katex | null { return _k }

/** 본문에 수식 표식이 있을 가능성 여부(없으면 KaTeX 를 로드하지 않는다) */
export function aiHasMath(src: string): boolean {
  return /\$[^\s$][^$]*\$|\$\$/.test(src || '')
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderMath(tex: string, display: boolean, getKatex: () => Katex | null): string {
  const k = getKatex()
  if (!k) {
    const src = display ? `$$${tex}$$` : `$${tex}$`
    return display ? `<pre class="ai-math-src"><code>${escapeHtml(src)}</code></pre>` : `<code class="ai-math-src">${escapeHtml(src)}</code>`
  }
  try {
    const html = k.renderToString(tex, { displayMode: display, throwOnError: false, output: 'htmlAndMathml', strict: 'ignore', trust: false })
    return display ? `<div class="ai-math-block" role="math" aria-label="${escapeHtml(tex)}">${html}</div>` : html
  } catch {
    return `<code class="ai-math-src">${escapeHtml(display ? `$$${tex}$$` : `$${tex}$`)}</code>`
  }
}

function isWs(code: number) { return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d }
function isDigit(code: number) { return code >= 0x30 && code <= 0x39 }

/** markdown-it 플러그인. getKatex 가 null 을 반환하면 원문을 코드 형태로 출력한다 */
export function aiMathPlugin(md: any, getKatex: () => Katex | null = aiKatexLoaded) {
  // 인라인 $…$ (그리고 한 줄 안의 $$…$$ = 가운데 정렬 아님, 인라인 디스플레이)
  md.inline.ruler.after('escape', 'ai_math_inline', (state: any, silent: boolean) => {
    const src = state.src
    const start = state.pos
    if (src.charCodeAt(start) !== 0x24 /* $ */) return false
    const dbl = src.charCodeAt(start + 1) === 0x24
    const open = dbl ? 2 : 1
    const first = src.charCodeAt(start + open)
    if (Number.isNaN(first) || isWs(first) || first === 0x24) return false
    let pos = start + open
    while (pos < state.posMax) {
      const c = src.charCodeAt(pos)
      if (c === 0x5c /* \ */) { pos += 2; continue }
      if (c === 0x24) {
        if (dbl) {
          if (src.charCodeAt(pos + 1) === 0x24) break
        } else if (!isWs(src.charCodeAt(pos - 1)) && !isDigit(src.charCodeAt(pos + 1))) break
      }
      pos++
    }
    if (pos >= state.posMax) return false
    const content = src.slice(start + open, pos)
    if (!content.trim()) return false
    if (!silent) {
      const tok = state.push('ai_math_inline', 'math', 0)
      tok.content = content
      tok.markup = dbl ? '$$' : '$'
    }
    state.pos = pos + open
    return true
  })

  // 블록 $$ … $$ (여러 줄 또는 한 줄 "$$x$$")
  md.block.ruler.after('blockquote', 'ai_math_block', (state: any, startLine: number, endLine: number, silent: boolean) => {
    let pos = state.bMarks[startLine] + state.tShift[startLine]
    let max = state.eMarks[startLine]
    if (state.sCount[startLine] - state.blkIndent >= 4) return false
    if (pos + 2 > max || state.src.slice(pos, pos + 2) !== '$$') return false
    pos += 2
    let firstLine = state.src.slice(pos, max)
    let lastLine = ''
    let next = startLine
    let found = false
    if (firstLine.trim().endsWith('$$')) {
      // 한 줄 $$…$$
      firstLine = firstLine.trim().slice(0, -2)
      found = true
    }
    if (silent) return true
    while (!found) {
      next++
      if (next >= endLine) break
      pos = state.bMarks[next] + state.tShift[next]
      max = state.eMarks[next]
      if (pos < max && state.tShift[next] < state.blkIndent) break
      const line = state.src.slice(pos, max)
      if (line.trim().endsWith('$$')) {
        lastLine = line.trim().slice(0, -2)
        found = true
      }
    }
    if (!found) return false
    state.line = next + 1
    const tok = state.push('ai_math_block', 'math', 0)
    tok.block = true
    tok.content = [firstLine, next > startLine + 1 ? state.getLines(startLine + 1, next, state.tShift[startLine], true) : '', lastLine]
      .filter(s => s.trim()).join('\n')
    tok.map = [startLine, state.line]
    tok.markup = '$$'
    return true
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })

  md.renderer.rules.ai_math_inline = (tokens: any[], idx: number) => renderMath(tokens[idx].content, false, getKatex)
  md.renderer.rules.ai_math_block = (tokens: any[], idx: number) => `${renderMath(tokens[idx].content, true, getKatex)}\n`
}
