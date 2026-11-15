// Vue 원본: frontend/utils/chatMarkdown.ts (내용 그대로)
// 채팅 본문 mrkdwn 렌더 (Slack식): **굵게** *기울임* ~~취소선~~ `코드` ```블록``` > 인용 링크 @멘션
// 코드영역을 먼저 추출(placeholder) → 나머지 포맷 적용 → 복원. 최종 DOMPurify 새니타이즈.
import DOMPurify from 'dompurify'

// 채널 전원을 부르는 말. 백엔드 app/chat/service.py GROUP_MENTIONS 와 같아야 한다.
export const GROUP_MENTIONS = new Set(['channel', 'all', 'here', 'everyone', '채널', '전체', '모두'])

/** 이 본문이 나(username)·채널 전원·내 역할(roleKeys = 내 역할의 mention 키)을 불렀나 — 메시지 행 강조. */
export function mentionsMe(raw: string, me?: string | null, roleKeys?: readonly string[] | null): boolean {
  if (!raw) return false
  const re = /(^|\s)@([\p{L}\p{N}_](?:[\p{L}\p{N}_.-]*[\p{L}\p{N}_])?)/gu   // 서버 MENTION_RE 와 같게: 한글 이름 + 사이의 . - (first-last), 끝의 . - 는 문장부호
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const name = m[2]
    if (GROUP_MENTIONS.has(name.toLowerCase()) || (me && name === me)) return true
    if (roleKeys?.length && roleKeys.includes(name.toLowerCase())) return true
  }
  return false
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderChatMarkdown(raw: string, opts: { me?: string | null } = {}): string {
  if (!raw) return ''
  const codeBlocks: string[] = []
  const inlineCodes: string[] = []

  // 1) 펜스 코드블록 ```...```
  let text = raw.replace(/```([\s\S]*?)```/g, (_m, code: string) => {
    codeBlocks.push(`<pre class="chat-code"><code>${escapeHtml(code.replace(/^\n/, '').replace(/\n$/, ''))}</code></pre>`)
    return `\uE000CB${codeBlocks.length - 1}\uE000`
  })
  // 2) 인라인 코드 `...`
  text = text.replace(/`([^`\n]+?)`/g, (_m, code: string) => {
    inlineCodes.push(`<code class="chat-inline-code">${escapeHtml(code)}</code>`)
    return `\uE000IC${inlineCodes.length - 1}\uE000`
  })
  // 3) 나머지 이스케이프
  text = escapeHtml(text)
  // 4) 링크
  text = text.replace(/\b(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer" class="chat-link">$1</a>')
  // 5) 굵게
  text = text.replace(/\*\*([^\n*]+?)\*\*/g, '<strong>$1</strong>')
  // 6) 취소선
  text = text.replace(/~~([^\n~]+?)~~/g, '<del>$1</del>')
  // 7) 기울임 *..* / _.._
  text = text.replace(/(^|[^*\w])\*([^\s*][^*\n]*?)\*(?!\*)/g, '$1<em>$2</em>')
  text = text.replace(/(^|[^_\w])_([^\s_][^_\n]*?)_(?![_\w])/g, '$1<em>$2</em>')
  // 8) @멘션 — 나·채널 전원은 강조 칩, 다른 사람은 일반(채팅 시안)
  text = text.replace(/(^|\s)@([\p{L}\p{N}_](?:[\p{L}\p{N}_.-]*[\p{L}\p{N}_])?)/gu, (_m, pre: string, name: string) => {
    const cls = GROUP_MENTIONS.has(name.toLowerCase())
      ? 'chat-mention chat-mention-group'
      : (opts.me && name === opts.me ? 'chat-mention chat-mention-me' : 'chat-mention')
    return `${pre}<span class="${cls}">@${name}</span>`
  })
  // 9) 줄단위 인용(> )
  text = text.split('\n').map((line) =>
    /^&gt;\s?/.test(line)
      ? `<blockquote class="chat-quote">${line.replace(/^&gt;\s?/, '')}</blockquote>`
      : line
  ).join('\n')
  // 10) 줄바꿈
  text = text.replace(/\n/g, '<br>')
  // 11) 코드 복원
  text = text.replace(/\uE000IC(\d+)\uE000/g, (_m, i: string) => inlineCodes[+i])
  text = text.replace(/\uE000CB(\d+)\uE000/g, (_m, i: string) => codeBlocks[+i])
  // 블록요소 주변 <br> 정리
  text = text.replace(/<br>\s*(<pre|<blockquote)/g, '$1').replace(/(<\/pre>|<\/blockquote>)\s*<br>/g, '$1')

  return DOMPurify.sanitize(text, { ADD_ATTR: ['target', 'rel'] })
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// 마크다운 — 구조 파서(AST). 그리기는 components/chat/ChatMarkdown.tsx(React 가 글자를 이스케이프 →
// innerHTML 을 쓰지 않으니 XSS 경로가 없다. 링크 주소는 http(s) 만). renderChatMarkdown(HTML 문자열)은 다른 화면(고정 목록 ·
// 모아보기 · 음성 글 채팅)이 그대로 쓰므로 남겨 둔다.
//  블록: # h1 · ## h2 · ### h3 · -# 작은 글 · - / * / 1. 목록(앞 공백 2칸 = 한 단계) · > 인용 · >>> 여러 줄 인용 · ```lang 코드```
//  글줄: ***굵은 기울임*** · **굵게** · __밑줄__ · *기울임* / _기울임_ · ~~취소~~ · `코드` · ||스포일러|| · [글](주소) ·
//        주소 자동 링크 · <주소>(미리보기 없는 링크) · @멘션 · #채널 / <#채널id> · :커스텀_이모지: · \ 이스케이프
// ════════════════════════════════════════════════════════════════════════════════════════════

export type MdInline =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: 'b' | 'i' | 'u' | 's' | 'spoiler'; c: MdInline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: MdInline[]; masked: boolean }
  /** @이름 — group = @here/@everyone 등. 사람/역할 구분은 그릴 때(역할 목록) */
  | { t: 'at'; name: string; group: boolean }
  /** #이름(byId=false) · <#id>(byId=true) — 그릴 때 채널 목록으로 푼다(이름이 없으면 글자 그대로) */
  | { t: 'channel'; ref: string; byId: boolean }
  /** :이름: — 그릴 때 커스텀 이모지 목록으로 푼다(없으면 글자 그대로) */
  | { t: 'emoji'; name: string }

export interface MdListItem { depth: number; ordered: boolean; n: number; c: MdInline[] }
export type MdBlock =
  | { t: 'p'; c: MdInline[] }
  | { t: 'h'; level: 1 | 2 | 3; c: MdInline[] }
  | { t: 'sub'; c: MdInline[] }
  | { t: 'list'; items: MdListItem[] }
  | { t: 'quote'; c: MdBlock[] }
  | { t: 'code'; lang: string; code: string }

/** 코드 블록이 이 줄 수를 넘으면 접는다("20줄 넘으면 접힘") */
export const CODE_FOLD_LINES = 20

const NAME_RE = /[\p{L}\p{N}_](?:[\p{L}\p{N}_.-]*[\p{L}\p{N}_])?/uy
const CHANNEL_NAME_RE = /[\p{L}\p{N}_](?:[\p{L}\p{N}_-]*[\p{L}\p{N}_])?/uy
const URL_RE = /https?:\/\/[^\s<>|]+/y
const ESCAPABLE = new Set(['\\', '*', '_', '~', '`', '|', '>', '#', '-', '[', ']', '(', ')', ':', '@', '<'])

function at(re: RegExp, s: string, i: number): RegExpExecArray | null {
  re.lastIndex = i
  return re.exec(s)
}
/** 주소 끝의 문장부호는 떼어 낸다(괄호는 짝이 맞을 때만 남김) */
function trimUrl(u: string): string {
  let url = u
  for (;;) {
    const last = url[url.length - 1]
    if (/[.,;:!?'"]/.test(last)) { url = url.slice(0, -1); continue }
    if (last === ')' && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) { url = url.slice(0, -1); continue }
    break
  }
  return url
}
export function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href)
}

// 짝 맞는 강조 — [여는 기호, 정규식(y), 종류]. 앞에 있을수록 먼저 본다(*** > ** > __ > * > _ > ~~ > ||)
const EMPH: [string, RegExp, 'bi' | 'b' | 'u' | 'i' | 's' | 'spoiler'][] = [
  ['***', /\*\*\*(?!\s)([\s\S]+?)\*\*\*/y, 'bi'],
  ['**', /\*\*(?!\s)([\s\S]+?)\*\*(?!\*)/y, 'b'],
  ['__', /__(?!\s)([\s\S]+?)__(?!_)/y, 'u'],
  ['*', /\*(?![\s*])([^*\n]+?)\*(?!\*)/y, 'i'],
  ['_', /_(?![\s_])([^_\n]+?)_(?![\p{L}\p{N}_])/uy, 'i'],
  ['~~', /~~(?!\s)([\s\S]+?)~~/y, 's'],
  ['||', /\|\|([\s\S]+?)\|\|/y, 'spoiler'],
]

/** 한 덩어리 글을 글줄 노드로(줄바꿈은 br) */
export function parseInline(src: string, opts: { links?: boolean } = {}): MdInline[] {
  const links = opts.links !== false
  const out: MdInline[] = []
  let buf = ''
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = '' } }
  const push = (n: MdInline) => { flush(); out.push(n) }
  const prevIsBoundary = (i: number) => i === 0 || /[\s([{"“‘]/u.test(src[i - 1])
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    // 이스케이프
    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.has(src[i + 1])) { buf += src[i + 1]; i += 2; continue }
    if (ch === '\n') { push({ t: 'br' }); i++; continue }
    // 인라인 코드(`` `` 두 겹도)
    if (ch === '`') {
      const m = at(/(`{1,2})([^`]|[^`][\s\S]*?[^`])\1(?!`)/y, src, i)
      if (m) { push({ t: 'code', v: m[2] }); i += m[0].length; continue }
    }
    // 마스크 링크 [글](주소)
    if (ch === '[' && links) {
      const m = at(/\[([^\]\n]+)\]\(<?(https?:\/\/[^\s)>]+)>?\)/y, src, i)
      if (m) { push({ t: 'link', href: m[2], masked: true, c: parseInline(m[1], { links: false }) }); i += m[0].length; continue }
    }
    // <주소>(미리보기 없는 링크) · <#채널id>
    if (ch === '<') {
      const ch2 = at(/<#([A-Za-z0-9_-]{1,64})>/y, src, i)
      if (ch2) { push({ t: 'channel', ref: ch2[1], byId: true }); i += ch2[0].length; continue }
      const m = links ? at(/<(https?:\/\/[^\s>]+)>/y, src, i) : null
      if (m) { push({ t: 'link', href: m[1], masked: false, c: [{ t: 'text', v: m[1] }] }); i += m[0].length; continue }
    }
    // 주소 자동 링크
    if (links && (ch === 'h' || ch === 'H') && prevIsBoundary(i)) {
      const m = at(URL_RE, src, i)
      if (m) {
        const url = trimUrl(m[0])
        if (url.length > 8) { push({ t: 'link', href: url, masked: false, c: [{ t: 'text', v: url }] }); i += url.length; continue }
      }
    }
    // 강조
    if (ch === '*' || ch === '_' || ch === '~' || ch === '|') {
      let hit = false
      for (const [open, re, kind] of EMPH) {
        if (!src.startsWith(open, i)) continue
        if (open === '_' && i > 0 && /[\p{L}\p{N}]/u.test(src[i - 1])) continue   // snake_case 안의 _ 는 글자
        const m = at(re, src, i)
        if (!m) continue
        const inner = parseInline(m[1], { links })
        if (kind === 'bi') push({ t: 'b', c: [{ t: 'i', c: inner }] })
        else push({ t: kind, c: inner })
        i += m[0].length
        hit = true
        break
      }
      if (hit) continue
    }
    // @멘션(앞이 공백·줄 처음일 때만 — 메일 주소 제외)
    if (ch === '@' && prevIsBoundary(i)) {
      const m = at(NAME_RE, src, i + 1)
      if (m) { push({ t: 'at', name: m[0], group: GROUP_MENTIONS.has(m[0].toLowerCase()) }); i += 1 + m[0].length; continue }
    }
    // #채널(앞이 공백·줄 처음, 숫자만은 이슈 번호라 글자)
    if (ch === '#' && prevIsBoundary(i)) {
      const m = at(CHANNEL_NAME_RE, src, i + 1)
      if (m && !/^\d+$/.test(m[0])) { push({ t: 'channel', ref: m[0], byId: false }); i += 1 + m[0].length; continue }
    }
    // :커스텀_이모지:
    if (ch === ':') {
      const m = at(/:([a-z0-9_]{2,32}):/y, src, i)
      if (m) { push({ t: 'emoji', name: m[1] }); i += m[0].length; continue }
    }
    buf += ch
    i++
  }
  flush()
  return out
}

const LIST_RE = /^(\s*)([-*•]|(\d{1,3})[.)])\s+(.*)$/
const HEAD_RE = /^(#{1,3})\s+(.+)$/
const SUB_RE = /^-#\s+(.+)$/

function parseLines(lines: string[], allowQuote: boolean): MdBlock[] {
  const out: MdBlock[] = []
  let para: string[] = []
  const flushPara = () => {
    while (para.length && !para[0].trim()) para.shift()
    while (para.length && !para[para.length - 1].trim()) para.pop()
    if (para.length) out.push({ t: 'p', c: parseInline(para.join('\n')) })
    para = []
  }
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]
    if (allowQuote && /^>>>\s?/.test(line)) {
      flushPara()
      const rest = [line.replace(/^>>>\s?/, ''), ...lines.slice(k + 1)]
      out.push({ t: 'quote', c: parseLines(rest, false) })
      return out
    }
    if (allowQuote && /^>\s/.test(line)) {
      flushPara()
      const q: string[] = []
      while (k < lines.length && /^>\s/.test(lines[k])) { q.push(lines[k].replace(/^>\s/, '')); k++ }
      k--
      out.push({ t: 'quote', c: parseLines(q, false) })
      continue
    }
    const h = HEAD_RE.exec(line)
    if (h) { flushPara(); out.push({ t: 'h', level: h[1].length as 1 | 2 | 3, c: parseInline(h[2]) }); continue }
    const sb = SUB_RE.exec(line)
    if (sb) { flushPara(); out.push({ t: 'sub', c: parseInline(sb[1]) }); continue }
    if (LIST_RE.test(line)) {
      flushPara()
      const items: MdListItem[] = []
      while (k < lines.length) {
        const m = LIST_RE.exec(lines[k])
        if (!m) break
        const indent = m[1].replace(/\t/g, '  ').length
        items.push({ depth: Math.min(2, Math.floor(indent / 2)), ordered: !!m[3], n: m[3] ? Number(m[3]) : 0, c: parseInline(m[4]) })
        k++
      }
      k--
      out.push({ t: 'list', items })
      continue
    }
    para.push(line)
  }
  flushPara()
  return out
}

/** 본문 → 블록 목록 */
export function parseChatMarkdown(raw: string | null | undefined): MdBlock[] {
  if (!raw) return []
  const out: MdBlock[] = []
  const re = /```([^\n`]*)\n?([\s\S]*?)```/g
  let last = 0
  let m: RegExpExecArray | null
  const text = (s: string) => { if (s.trim()) out.push(...parseLines(s.replace(/^\n|\n$/g, '').split('\n'), true)) }
  while ((m = re.exec(raw))) {
    text(raw.slice(last, m.index))
    // ```ts\n…``` 이면 첫 줄이 언어, 줄바꿈이 없으면(```한 줄```) 모두 코드
    const hasNl = m[0].slice(3).includes('\n')
    const langOk = hasNl && /^[\w+#.-]{0,20}$/.test(m[1].trim())
    const lang = langOk ? m[1].trim() : ''
    const code = langOk ? m[2] : (m[1] + (hasNl ? '\n' : '') + m[2])
    out.push({ t: 'code', lang, code: code.replace(/\n$/, '') })
    last = m.index + m[0].length
  }
  text(raw.slice(last))
  return out
}

/** 글줄 노드 → 맨 글자(답장 요약 · 알림). 스포일러는 가린다 */
export function inlineToText(c: MdInline[], spoilerMask = '▮▮▮'): string {
  return c.map((n) => {
    switch (n.t) {
      case 'text': return n.v
      case 'br': return ' '
      case 'code': return n.v
      case 'spoiler': return spoilerMask
      case 'b': case 'i': case 'u': case 's': return inlineToText(n.c, spoilerMask)
      case 'link': return inlineToText(n.c, spoilerMask)
      case 'at': return '@' + n.name
      case 'channel': return '#' + n.ref
      case 'emoji': return ':' + n.name + ':'
      default: return ''
    }
  }).join('')
}

/** 마크다운을 벗긴 한 줄 요약(답장 미리보기 — 14 muted 말줄임) */
export function stripChatMarkdown(raw: string | null | undefined): string {
  const parts: string[] = []
  const walk = (bs: MdBlock[]) => {
    for (const b of bs) {
      if (b.t === 'code') parts.push(b.code.split('\n').find(l => l.trim()) || '')
      else if (b.t === 'quote') walk(b.c)
      else if (b.t === 'list') b.items.forEach(it => parts.push(inlineToText(it.c)))
      else parts.push(inlineToText(b.c))
    }
  }
  walk(parseChatMarkdown(raw))
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}

// 유니코드 이모지 한 글자(피부색·ZWJ 묶음·국기·키캡 포함)
const EMOJI_UNIT = /(?:\p{Extended_Pictographic}(?:️|[\u{1F3FB}-\u{1F3FF}])?(?:‍\p{Extended_Pictographic}(?:️|[\u{1F3FB}-\u{1F3FF}])?)*|[\u{1F1E6}-\u{1F1FF}]{2}|[#*0-9]️⃣)/gu
/** 디스코드 jumbo 한도 */
export const JUMBO_MAX = 27

/**
 * 본문이 이모지만인가(공백 제외) → 이모지를 48 로 크게(디스코드 jumbo). isCustom = 그릴 수 있는 커스텀 이모지 이름인지.
 * 커스텀 :이름: 이 목록에 없으면 글자라서 jumbo 가 아니다.
 */
export function isEmojiOnly(blocks: MdBlock[], isCustom: (name: string) => boolean): boolean {
  if (blocks.length !== 1 || blocks[0].t !== 'p') return false
  let count = 0
  for (const n of blocks[0].c) {
    if (n.t === 'emoji') { if (!isCustom(n.name)) return false; count++; continue }
    if (n.t === 'br') continue
    if (n.t !== 'text') return false
    const s = n.v.replace(/\s+/g, '')
    if (!s) continue
    const units = s.match(EMOJI_UNIT)
    if (!units || units.join('') !== s) return false
    count += units.length
  }
  return count > 0 && count <= JUMBO_MAX
}
