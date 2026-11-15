/**
 * vue-i18n 메시지 문법 해석기 — 기존 `frontend/i18n/locales/*.json` 을 글자 그대로 쓰기 위한 어댑터.
 *
 * 지원(vue-i18n v9+ 기본 문법과 같은 결과):
 * - 이름 보간 `{name}` · 목록 보간 `{0}` · 리터럴 `{'@'}` `{'|'}` `{'{'}`
 * - 복수형 `단수 | 복수`, `없음 | 하나 | 여럿` (기본 규칙 = vue-i18n pluralDefault)
 * - 연결 `@:key` · `@:(key)` · `@.lower:key` / `@.upper:` / `@.capitalize:`
 * 값이 없는 보간은 빈 문자열(vue-i18n 과 같음).
 */

export type Named = Record<string, unknown>
export type Resolver = (key: string) => unknown

type Tok =
  | { k: 'text'; v: string }
  | { k: 'named'; v: string }
  | { k: 'list'; v: number }
  | { k: 'literal'; v: string }
  | { k: 'link'; key: string; mod?: string }

const cache = new Map<string, Tok[][]>()

/** vue-i18n 기본 복수형 규칙 */
export function pluralDefault(choice: number, choicesLength: number): number {
  choice = Math.abs(choice)
  if (choicesLength === 2) return choice ? (choice > 1 ? 1 : 0) : 1
  return choice ? Math.min(choice, 2) : 0
}

function findClose(src: string, open: number): number {
  let inQuote = false
  for (let j = open + 1; j < src.length; j++) {
    const c = src[j]
    if (c === '\\' && inQuote) { j++; continue }
    if (c === "'") inQuote = !inQuote
    else if (c === '}' && !inQuote) return j
    else if (c === '{' && !inQuote) return -1
  }
  return -1
}

const LINK_RE = /^@(?:\.([a-zA-Z]+))?:(?:\(([^)]+)\)|([\w\-.]*[\w-]))/

function parseChoice(src: string): Tok[] {
  const out: Tok[] = []
  let buf = ''
  const flush = () => { if (buf) { out.push({ k: 'text', v: buf }); buf = '' } }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '{') {
      const end = findClose(src, i)
      if (end < 0) { buf += c; i++; continue }
      const inner = src.slice(i + 1, end).trim()
      flush()
      const lit = /^'((?:[^'\\]|\\.)*)'$/.exec(inner)
      if (lit) out.push({ k: 'literal', v: lit[1].replace(/\\(.)/g, '$1') })
      else if (/^\d+$/.test(inner)) out.push({ k: 'list', v: Number(inner) })
      else out.push({ k: 'named', v: inner })
      i = end + 1
      continue
    }
    if (c === '@') {
      const m = LINK_RE.exec(src.slice(i))
      if (m) {
        flush()
        out.push({ k: 'link', key: (m[2] ?? m[3]).trim(), mod: m[1] })
        i += m[0].length
        continue
      }
    }
    buf += c
    i++
  }
  flush()
  return out
}

/** `|` 로 복수형 선택지를 나눈다(중괄호 안의 `{'|'}` 는 제외) */
function splitChoices(src: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inQuote = false
  let cur = ''
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (depth > 0) {
      if (c === "'") inQuote = !inQuote
      else if (c === '}' && !inQuote) depth--
      cur += c
      continue
    }
    if (c === '{') { depth++; cur += c; continue }
    if (c === '|') { parts.push(cur); cur = ''; continue }
    cur += c
  }
  parts.push(cur)
  return parts.length > 1 ? parts.map(p => p.trim()) : parts
}

export function parse(src: string): Tok[][] {
  let hit = cache.get(src)
  if (!hit) {
    hit = splitChoices(src).map(parseChoice)
    cache.set(src, hit)
  }
  return hit
}

const MODS: Record<string, (s: string) => string> = {
  lower: s => s.toLowerCase(),
  upper: s => s.toUpperCase(),
  capitalize: s => (s ? s[0].toUpperCase() + s.slice(1) : s),
}

export interface FormatOptions {
  named?: Named
  list?: unknown[]
  /** 복수형 선택 수. 생략하면 vue-i18n 과 같이 -1 */
  plural?: number
  resolve: Resolver
  /** 연결 메시지 깊이(순환 방지) */
  depth?: number
}

const display = (v: unknown): string =>
  v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)

export function format(src: string, opts: FormatOptions): string {
  const choices = parse(src)
  const pluralIndex = opts.plural ?? -1
  const toks = choices.length > 1 ? choices[pluralDefault(pluralIndex, choices.length)] : choices[0]
  const named: Named = { ...(opts.named || {}) }
  if (opts.plural != null) {
    if (!('count' in named)) named.count = opts.plural
    if (!('n' in named)) named.n = opts.plural
  }
  let out = ''
  for (const t of toks) {
    switch (t.k) {
      case 'text': out += t.v; break
      case 'literal': out += t.v; break
      case 'named': out += display(named[t.v]); break
      case 'list': out += display(opts.list?.[t.v] ?? named[String(t.v)]); break
      case 'link': {
        const depth = (opts.depth ?? 0) + 1
        const raw = opts.resolve(t.key)
        let s = typeof raw === 'string' && depth < 10 ? format(raw, { ...opts, depth }) : t.key
        if (t.mod && MODS[t.mod]) s = MODS[t.mod](s)
        out += s
        break
      }
    }
  }
  return out
}
