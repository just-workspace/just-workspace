/**
 * 위키 버전 비교: 옛 버전과 지금 버전의 HTML 을 클라이언트에서 비교해
 * 추가는 <ins>(success 밑줄) · 삭제는 <del>(danger 취소선) 로 표시한 HTML 을 만든다.
 *
 * 방식 — 블록(문단·제목·목록 항목 …) 단위로 먼저 맞추고, 바뀐 블록 쌍은 단어 단위로 다시 비교한다.
 * 바뀐 블록의 안쪽 서식(굵게·링크)은 글자만 남긴다 — 비교 표시가 목적이라 감수한다.
 * 백엔드에 diff 가 없어(REVIEW 9-c) 여기서 계산한다. DOMParser 가 있어야 한다(브라우저·happy-dom).
 */

export type DiffOp<T> = { type: 'equal' | 'delete' | 'insert'; a?: T; b?: T }

/** 두 수열의 LCS 기반 편집 목록. 수천 토큰까지는 충분히 빠르다. */
export function diffSeq<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean = (x, y) => x === y): DiffOp<T>[] {
  const n = a.length, m = b.length
  // dp[i][j] = a[i..], b[j..] 의 LCS 길이
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = eq(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops: DiffOp<T>[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (eq(a[i], b[j])) { ops.push({ type: 'equal', a: a[i], b: b[j] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'delete', a: a[i] }); i++ }
    else { ops.push({ type: 'insert', b: b[j] }); j++ }
  }
  while (i < n) ops.push({ type: 'delete', a: a[i++] })
  while (j < m) ops.push({ type: 'insert', b: b[j++] })
  return ops
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 단어·공백 토큰(공백도 토큰으로 남겨 원문 간격을 보존) */
export function tokenizeWords(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? []
}

interface Block { tag: string; html: string; text: string }

function parseBlocks(html: string): Block[] {
  if (typeof DOMParser === 'undefined') return [{ tag: 'div', html, text: html }]
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const out: Block[] = []
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase()
      // 목록·인용은 항목 단위로 들어가 본다(항목 하나 바뀐 것을 목록 전체 교체로 보지 않게)
      if ((tag === 'ul' || tag === 'ol' || tag === 'blockquote') && child.children.length) {
        out.push({ tag: `${tag}:open`, html: `<${tag}>`, text: `<${tag}>` })
        walk(child)
        out.push({ tag: `${tag}:close`, html: `</${tag}>`, text: `</${tag}>` })
      } else {
        out.push({ tag, html: child.outerHTML, text: (child.textContent ?? '').trim() })
      }
    }
  }
  walk(doc.body)
  return out
}

/** 단어 단위 비교 결과를 HTML 조각으로. 반환 added/removed 는 단어 수. */
export function diffWordsHtml(oldText: string, newText: string): { html: string; added: number; removed: number } {
  const ops = diffSeq(tokenizeWords(oldText), tokenizeWords(newText))
  // 바뀐 단어 사이에 낀 공백(equal)은 같은 쪽으로 흡수 — "<ins>사내</ins> <ins>Git</ins>" 대신 "<ins>사내 Git</ins>"
  for (let k = 1; k < ops.length - 1; k++) {
    const cur = ops[k], prev = ops[k - 1], next = ops[k + 1]
    if (cur.type === 'equal' && !cur.a!.trim() && prev.type !== 'equal' && prev.type === next.type) {
      ops[k] = prev.type === 'insert' ? { type: 'insert', b: cur.b } : { type: 'delete', a: cur.a }
    }
  }
  let html = '', added = 0, removed = 0
  // 연속된 같은 종류 토큰은 한 태그로 묶는다
  let run: { type: DiffOp<string>['type']; text: string } | null = null
  const flush = () => {
    if (!run) return
    const t = escapeHtml(run.text)
    html += run.type === 'equal' ? t : run.type === 'delete' ? `<del>${t}</del>` : `<ins>${t}</ins>`
    run = null
  }
  for (const op of ops) {
    const text = op.type === 'insert' ? op.b! : op.a!
    if (op.type !== 'equal' && text.trim()) { if (op.type === 'insert') added++; else removed++ }
    if (run && run.type === op.type) run.text += text
    else { flush(); run = { type: op.type, text } }
  }
  flush()
  return { html, added, removed }
}

export interface HtmlDiffResult { html: string; added: number; removed: number }

/**
 * 옛 HTML → 새 HTML 비교 표시. 블록이 통째로 바뀌면 블록 전체를 del/ins 로,
 * 삭제 바로 뒤에 삽입이 오면(= 수정된 문단) 단어 단위로 안쪽을 비교한다.
 */
export function diffHtml(oldHtml: string, newHtml: string): HtmlDiffResult {
  const a = parseBlocks(oldHtml || '')
  const b = parseBlocks(newHtml || '')
  const ops = diffSeq(a, b, (x, y) => x.tag === y.tag && x.text === y.text)
  let html = '', added = 0, removed = 0
  const wrapBlock = (blk: Block, kind: 'del' | 'ins'): string => {
    if (blk.tag.includes(':')) return blk.html   // 목록 여닫는 태그는 그대로
    const inner = `<${kind}>${escapeHtml(blk.text)}</${kind}>`
    const t = blk.tag === 'li' ? 'li' : /^h[1-6]$/.test(blk.tag) ? blk.tag : 'p'
    return `<${t}>${inner}</${t}>`
  }
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k]
    if (op.type === 'equal') { html += op.b!.html; continue }
    const next = ops[k + 1]
    if (op.type === 'delete' && next?.type === 'insert' && !op.a!.tag.includes(':') && !next.b!.tag.includes(':')) {
      const w = diffWordsHtml(op.a!.text, next.b!.text)
      const t = next.b!.tag === 'li' ? 'li' : /^h[1-6]$/.test(next.b!.tag) ? next.b!.tag : 'p'
      html += `<${t}>${w.html}</${t}>`
      added += w.added; removed += w.removed
      k++
      continue
    }
    if (op.type === 'delete') { html += wrapBlock(op.a!, 'del'); removed += tokenizeWords(op.a!.text).filter(t => t.trim()).length }
    else { html += wrapBlock(op.b!, 'ins'); added += tokenizeWords(op.b!.text).filter(t => t.trim()).length }
  }
  return { html, added, removed }
}

/** 버전 패널의 "+3 −1" — 단어 수 기준 */
export function diffStats(oldHtml: string, newHtml: string): { added: number; removed: number } {
  const r = diffHtml(oldHtml, newHtml)
  return { added: r.added, removed: r.removed }
}
