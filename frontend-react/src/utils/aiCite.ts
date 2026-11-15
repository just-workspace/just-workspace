// AI 답변 본문의 출처 표식 [n](S6a) — 그 답변의 출처 번호에 있는 n 만 버튼으로 바꾼다.
// 코드·코드펜스·링크 안의 글자는 건드리지 않는다(text 토큰만, 링크 안은 건너뜀).

const CITE_RE = /\[(\d{1,2})\]/g

export function aiCitePlugin(md: any, getNums: () => ReadonlySet<number>, label: (n: number) => string) {
  md.core.ruler.push('ai_cite', (state: any) => {
    const nums = getNums()
    if (!nums.size) return
    for (const blk of state.tokens) {
      if (blk.type !== 'inline' || !blk.children) continue
      const out: any[] = []
      let linkDepth = 0
      for (const tok of blk.children) {
        if (tok.type === 'link_open') linkDepth++
        else if (tok.type === 'link_close') linkDepth--
        if (tok.type !== 'text' || linkDepth > 0 || !tok.content.includes('[')) { out.push(tok); continue }
        let last = 0
        const text = tok.content
        CITE_RE.lastIndex = 0
        let m: RegExpExecArray | null
        let changed = false
        while ((m = CITE_RE.exec(text))) {
          const n = Number(m[1])
          if (!nums.has(n)) continue
          if (m.index > last) {
            const t = new state.Token('text', '', 0)
            t.content = text.slice(last, m.index)
            out.push(t)
          }
          const c = new state.Token('ai_cite', '', 0)
          c.meta = { n }
          out.push(c)
          last = m.index + m[0].length
          changed = true
        }
        if (!changed) { out.push(tok); continue }
        if (last < text.length) {
          const t = new state.Token('text', '', 0)
          t.content = text.slice(last)
          out.push(t)
        }
      }
      blk.children = out
    }
  })
  md.renderer.rules.ai_cite = (tokens: any[], idx: number) => {
    const n = Number(tokens[idx].meta?.n)
    return `<button type="button" class="ai-cite" data-cite="${n}" aria-label="${md.utils.escapeHtml(label(n))}">[${n}]</button>`
  }
}
