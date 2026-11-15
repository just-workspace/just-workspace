/**
 * 메일 작성 글 도우미 — 순수 함수(주소·인용·전달·제목 접두).
 * React 컴포넌트 파일에 컴포넌트 아닌 export 를 섞지 않으려고 따로 둔다(동작·문자열 동일). 테스트: tests/mail/composeText.test.ts
 */
import type { EmailAddress, MessageDetail } from '~/composables/useMail'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * 쉼표로 이은 주소 문자열을 항목으로 자른다 — 큰따옴표·꺾쇠 안의 쉼표는 자르지 않는다.
 * 그냥 split(',') 하면 `"Kim, Minsu" <kim@x.com>` 이 "Kim"(잘못된 주소)과 "Minsu <…>" 로 갈라졌다.
 */
export function splitAddressList(raw: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  let angle = false
  for (const ch of raw || '') {
    if (ch === '"') quoted = !quoted
    else if (ch === '<' && !quoted) angle = true
    else if (ch === '>' && !quoted) angle = false
    if (ch === ',' && !quoted && !angle) { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out.map(s => s.trim()).filter(Boolean)
}

/** "이름 <a@b>, c@d" → 주소 목록(형식이 틀린 항목은 버린다) */
export function parseAddresses(raw: string): EmailAddress[] {
  if (!raw.trim()) return []
  return splitAddressList(raw).map((entry): EmailAddress | null => {
    const m = entry.match(/^(.*?)<([^>]+)>$/)
    const email = (m ? m[2] : entry).trim()
    if (!EMAIL_RE.test(email)) return null
    const name = m ? m[1].trim().replace(/^"|"$/g, '') : ''
    return { name: name || null, email }
  }).filter((a): a is EmailAddress => a !== null)
}

export function joinAddrs(list: readonly EmailAddress[]) {
  // 이름에 쉼표가 있으면 따옴표로 감싼다(주소 목록의 구분 쉼표와 헷갈리지 않게)
  const nm = (n: string) => (/[,"<>]/.test(n) ? `"${n.replace(/"/g, '')}"` : n)
  return list.map(a => (a.name ? `${nm(a.name)} <${a.email}>` : a.email)).join(', ')
}

// ─── 인용 ───
export function esc(s: string) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
export function textToHtml(t: string) { return t.split(/\r?\n/).map(l => `<p>${esc(l) || '<br>'}</p>`).join('') }
/** 대용량 첨부 — 파일함에 올리고 30일 다운로드 링크로 보내는 첨부 */
export interface LargeAttachment { name: string; size: number; url: string; path: string; expiresAt: string | null }

function fmtSize(n: number) {
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)}GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`
}

/** 본문 끝에 붙이는 대용량 첨부 목록(어느 메일 앱에서 열어도 보이게 표·인라인 스타일만) */
export function largeAttachmentBlock(list: readonly LargeAttachment[], labels: { title: string; until: (d: string) => string }) {
  if (!list.length) return { html: '', text: '' }
  const until = list.map(l => l.expiresAt).filter(Boolean).sort()[0]
  const d = until ? new Date(until).toLocaleDateString() : ''
  const rows = list.map(l => `<tr><td style="padding:4px 8px 4px 0"><a href="${esc(l.url)}">${esc(l.name)}</a></td><td style="padding:4px 0;color:#666;font-family:monospace">${fmtSize(l.size)}</td></tr>`).join('')
  const html = `<div style="margin-top:16px;padding:10px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px">`
    + `<div style="font-weight:600;margin-bottom:4px">${esc(labels.title)} (${list.length})</div>`
    + `<table style="border-collapse:collapse">${rows}</table>`
    + (d ? `<div style="margin-top:6px;color:#666;font-size:12px">${esc(labels.until(d))}</div>` : '')
    + `</div>`
  const text = `\n\n${labels.title} (${list.length})\n` + list.map(l => `- ${l.name} (${fmtSize(l.size)}): ${l.url}`).join('\n') + (d ? `\n${labels.until(d)}` : '')
  return { html, text }
}

function fmtDate(iso: string | null) { return iso ? new Date(iso).toLocaleString() : '' }

/** HTML → 줄바꿈을 살린 글자(스크립트 실행·이미지 로드 없음 — DOMParser 문서는 죽은 문서다) */
export function htmlToPlain(html: string): string {
  const doc = new DOMParser().parseFromString(html || '', 'text/html')
  doc.querySelectorAll('style,script,head,title,template').forEach(e => e.remove())
  doc.querySelectorAll('br').forEach(e => e.replaceWith('\n'))
  doc.querySelectorAll('p,div,tr,li,h1,h2,h3,h4,h5,h6,blockquote,table').forEach(e => e.append('\n'))
  return (doc.body?.textContent || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 인용·전달·인쇄에 쓸 본문 글자. text/plain 파트가 없는 메일(HTML 전용 — 국내 웹메일·그룹웨어에 흔하다)은
 * HTML 에서 뽑는다. 예전엔 text_body 만 봐서 그런 메일을 전달하면 본문이 통째로 빠졌다.
 */
export function plainBody(msg: { text_body?: string | null; html_body?: string | null }): string {
  if (msg.text_body && msg.text_body.trim()) return msg.text_body
  return msg.html_body ? htmlToPlain(msg.html_body) : ''
}

export function quoteOf(msg: Readonly<MessageDetail>) {
  const from = msg.from_.map(a => a.name || a.email).join(', ')
  const head = `${fmtDate(msg.received_at)}, ${from}:`
  const body = plainBody(msg)
  return {
    html: `<p>${esc(head)}</p><blockquote>${textToHtml(body)}</blockquote>`,
    text: `${head}\n> ${body.split('\n').join('\n> ')}`,
  }
}

export function forwardOf(msg: Readonly<MessageDetail>) {
  const addr = (l: readonly EmailAddress[]) => l.map(a => `${a.name || ''} <${a.email}>`.trim()).join(', ')
  const lines = [
    '---------- Forwarded message ----------',
    `From: ${addr(msg.from_)}`,
    `Date: ${fmtDate(msg.received_at)}`,
    `Subject: ${msg.subject || ''}`,
    `To: ${addr(msg.to)}`,
    '',
    plainBody(msg),
  ]
  return { html: textToHtml(lines.join('\n')), text: lines.join('\n') }
}

export function reSubject(s: string | null, prefix: 'Re:' | 'Fwd:') {
  const v = s || ''
  return v.toLowerCase().startsWith(prefix.toLowerCase()) ? v : `${prefix} ${v}`.trim()
}

/** 답장·전체 답장 받는 사람 — { to, cc } 문자열(전체 답장이면 나·이미 넣은 주소를 뺀 to+cc) */
export function replyRecipients(msg: Readonly<MessageDetail>, all: boolean, fromEmail: string): { to: string; cc: string; ccCount: number } {
  const replyTo = msg.reply_to.length > 0 ? msg.reply_to : msg.from_
  const to = joinAddrs(replyTo)
  if (!all) return { to, cc: '', ccCount: 0 }
  const me = fromEmail.toLowerCase()
  const seen = new Set(replyTo.map(a => a.email.toLowerCase()))
  const cc = [...msg.to, ...msg.cc].filter((a) => {
    const k = a.email.toLowerCase()
    if (k === me || seen.has(k)) return false
    seen.add(k)
    return true
  })
  return { to, cc: joinAddrs(cc), ccCount: cc.length }
}
