/**
 * 채팅 본문 마크다운 렌더링.
 * 파싱은 utils/chatMarkdown.parseChatMarkdown(AST) — 본 모듈은 React 요소로만 렌더링한다(innerHTML 없음 → XSS 경로 없음, 링크는 http(s) 만).
 *  · h1 24/700 · h2 20/700 · h3 16/700 · `-#` 13 muted · 목록 들여쓰기 20(• ◦ ▪ / 1.)
 *  · 마스크 링크 [글](주소): primary 밑줄 + 호버·포커스 툴팁에 실제 주소(mono 12). 다른 출처이면 최초 1회 확인(도메인 기억 = 개인 localStorage)
 *  · 스포일러 ||글||: 가림 = bg-foreground 커버 버튼(aria-expanded) / 펼침 = foreground/20
 *  · 코드 블록: 헤더 32(언어 · 복사) · 13/20 mono · 가로 스크롤 · 20줄 초과 시 접고 "N줄 더 보기"
 *    구문 색: 키워드 cat-5 · 문자열 cat-2 · 함수 cat-1 · 주석 muted — 먼저 소형 토크나이저로 처리하고, shiki(css-variables 테마) 로드 후 교체
 *  · 인용 > / >>> : 4px 막대 · 인라인 코드 · 굵게 · 기울임 · 밑줄 · 취소
 *  · 멘션 칩: @사용자·#채널 primary/15 + primary 500 · @역할 role 칩 + "역할 · N명" · 볼 수 없는 채널 muted "# 볼 수 없는 채널"
 *    · @here·@everyone warning/15 + 대상 인원 툴팁
 *  · 커스텀 이모지 :이름: → 이미지 22(본문이 이모지뿐이면 48 jumbo — 디스코드)
 */
import { Fragment, memo, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useStore } from 'zustand'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { apiUrl } from '~/lib/runtimeConfig'
import { writeClipboard } from '~/lib/clipboard'
import { confirmBox } from '~/composables/useDialog'
import { addToast } from '~/composables/useToast'
import { chatStore, selectChannel, selectSelectedChannel } from '~/composables/useChat'
import { anchorOf, setProfilePopout } from '~/composables/useChatUi'
import { chatRolesStore, roleChipClass } from '~/composables/useChatRoles'
import { chatEmojiStore, loadCustomEmojis } from '~/composables/useChatEmoji'
import { UiIcon } from '~/components/ui/Icon'
import { UiTooltip } from '~/components/ui/Tooltip'
import {
  CODE_FOLD_LINES, isEmojiOnly, isSafeHref, parseChatMarkdown,
  type MdBlock, type MdInline, type MdListItem,
} from '~/utils/chatMarkdown'

// ─── 외부 링크 확인(최초 1회) — 도메인 기억은 해당 사용자의 해당 브라우저(localStorage) 단위 ───
const LS_TRUSTED = 'jw-chat-trusted-domains'
function trustedDomains(): string[] {
  try { const v = JSON.parse(localStorage.getItem(LS_TRUSTED) || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}
export function isTrustedDomain(host: string): boolean {
  return trustedDomains().includes(host.toLowerCase())
}
export function rememberDomain(host: string) {
  const list = trustedDomains()
  if (list.includes(host.toLowerCase())) return
  try { localStorage.setItem(LS_TRUSTED, JSON.stringify([...list, host.toLowerCase()].slice(-200))) } catch { /* 저장 실패 시 다음에 다시 확인 */ }
}
function hostOf(href: string): string | null {
  try { return new URL(href).host } catch { return null }
}
function isExternal(href: string): boolean {
  try { return new URL(href).origin !== location.origin } catch { return true }
}

// ─── 구문 색 ───
export type CodeTok = { v: string; k: '' | 'kw' | 'str' | 'fn' | 'cm' }
const TOK_CLS: Record<CodeTok['k'], string> = { '': '', kw: 'text-cat-5', str: 'text-cat-2', fn: 'text-cat-1', cm: 'text-muted-foreground' }
const KEYWORDS = new Set(('abstract as async await break case catch class const continue def default del delete do elif else enum except export extends false '
  + 'finally fn for from func function go if impl import in instanceof interface is let match mod mut new nil none null of package pass private protected '
  + 'pub public raise return self static struct super switch this throw true try type typeof undefined use var void while with yield lambda not and or '
  + 'select where insert update into values create table drop alter echo then fi done esac').split(' '))
const HASH_COMMENT = new Set(['py', 'python', 'sh', 'bash', 'shell', 'zsh', 'yaml', 'yml', 'toml', 'ini', 'rb', 'ruby', 'r', 'dockerfile', 'conf', 'powershell', 'ps1'])

/** 소형 토크나이저 — 한 줄 단위(여러 줄 주석은 줄마다 재판정). shiki 로드 전·미지원 언어에 사용 */
export function tokenizeLine(line: string, lang = ''): CodeTok[] {
  const out: CodeTok[] = []
  const hash = HASH_COMMENT.has(lang.toLowerCase())
  const re = hash
    ? /(#.*$)|("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/g
    : /(\/\/.*$|\/\*.*?(?:\*\/|$)|--\s.*$)|("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/g
  let last = 0
  let m: RegExpExecArray | null
  const plain = (s: string) => { if (!s) return; const p = out[out.length - 1]; if (p && p.k === '') p.v += s; else out.push({ v: s, k: '' }) }
  while ((m = re.exec(line))) {
    plain(line.slice(last, m.index))
    if (m[1]) out.push({ v: m[1], k: 'cm' })
    else if (m[2]) out.push({ v: m[2], k: 'str' })
    else if (m[3]) out.push({ v: m[3], k: KEYWORDS.has(m[3]) ? 'kw' : 'fn' })
    else if (m[4]) { if (KEYWORDS.has(m[4])) out.push({ v: m[4], k: 'kw' }); else plain(m[4]) }
    last = m.index + m[0].length
  }
  plain(line.slice(last))
  return out
}

// shiki css-variables 토큰 색 → 본 프로젝트 토큰
function shikiKind(color: string | undefined): CodeTok['k'] {
  if (!color) return ''
  if (color.includes('token-comment')) return 'cm'
  if (color.includes('token-string')) return 'str'
  if (color.includes('token-keyword')) return 'kw'
  if (color.includes('token-function')) return 'fn'
  return ''
}
let _cssTheme: unknown = null
async function shikiLines(code: string, lang: string): Promise<CodeTok[][] | null> {
  try {
    const shiki = await import('shiki')
    _cssTheme ??= shiki.createCssVariablesTheme({ name: 'jw-chat', variablePrefix: '--shiki-' })
    const res = await shiki.codeToTokens(code, { lang: lang as never, theme: _cssTheme as never })
    return res.tokens.map(row => row.map(tk => ({ v: tk.content, k: shikiKind(tk.color) })))
  } catch { return null }
}

/** 코드 블록 */
const CodeBlock = memo(function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const { t } = useI18n()
  const lines = useMemo(() => code.split('\n'), [code])
  const [open, setOpen] = useState(false)
  const [hl, setHl] = useState<CodeTok[][] | null>(null)
  useEffect(() => {
    setHl(null)
    if (!lang || typeof window === 'undefined' || import.meta.env?.MODE === 'test') return
    let alive = true
    void shikiLines(code, lang.toLowerCase()).then((r) => { if (alive && r) setHl(r) })
    return () => { alive = false }
  }, [code, lang])
  const folded = lines.length > CODE_FOLD_LINES && !open
  const shown = folded ? lines.slice(0, CODE_FOLD_LINES) : lines
  async function copy() {
    try { await writeClipboard(code); addToast('success', t('chat.msg.md.copied')) } catch { addToast('error', t('error.genericError')) }
  }
  return (
    <div className="my-0.5 max-w-[640px] overflow-hidden rounded-lg border border-border bg-card" data-md="code">
      <div className="flex h-8 items-center gap-2 border-b border-border px-3 text-[12px]">
        <span className="font-mono font-semibold text-muted-foreground">{lang || t('chat.msg.md.code')}</span>
        <span className="flex-1" />
        <button type="button" aria-label={t('chat.msg.md.copyCode')} className="flex items-center gap-1 rounded text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" onClick={() => { void copy() }}>
          <UiIcon name="copy" className="h-3.5 w-3.5" />{t('chat.msg.md.copy')}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[13px] leading-5" tabIndex={0}>
        {shown.map((ln, i) => (
          <div key={i} className="whitespace-pre">
            {(hl?.[i] ?? tokenizeLine(ln, lang)).map((tk, j) => tk.k ? <span key={j} className={TOK_CLS[tk.k]}>{tk.v}</span> : <Fragment key={j}>{tk.v}</Fragment>)}
            {ln === '' && '​'}
          </div>
        ))}
      </pre>
      {lines.length > CODE_FOLD_LINES && (
        <button type="button" aria-expanded={open} className="flex h-7 w-full items-center justify-center gap-1 border-t border-border text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setOpen(v => !v)}>
          <UiIcon name={open ? 'chevron-up' : 'chevron-down'} className="h-3.5 w-3.5" />
          {open ? t('chat.msg.md.fold') : t('chat.msg.md.moreLines', { n: lines.length - CODE_FOLD_LINES })}
        </button>
      )}
    </div>
  )
})

/** 스포일러 — 클릭 시 펼침(다시 클릭해도 유지 — 디스코드) */
function Spoiler({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  if (open) return <span className="rounded bg-foreground/20 px-1">{children}</span>
  return (
    <button
      type="button"
      aria-expanded={false}
      aria-label={t('chat.msg.md.spoiler')}
      className="rounded bg-foreground px-1 text-foreground [&_*]:invisible focus-visible:outline-2 focus-visible:outline-ring"
      onClick={(e) => { e.stopPropagation(); setOpen(true) }}
    ><span aria-hidden="true">{children}</span></button>
  )
}

/** 마스크 링크(툴팁에 실제 주소) · 일반 링크 */
function MdLink({ href, masked, children }: { href: string; masked: boolean; children: ReactNode }) {
  const { t } = useI18n()
  if (!isSafeHref(href)) return <>{children}</>
  async function onClick(e: MouseEvent<HTMLAnchorElement>) {
    if (!masked || !isExternal(href)) return
    const host = hostOf(href)
    if (!host || isTrustedDomain(host)) return
    e.preventDefault()
    const ok = await confirmBox(t('chat.msg.md.leaveBody', { url: href }), { title: t('chat.msg.md.leaveTitle'), confirmLabel: t('chat.msg.md.leaveOk') })
    if (!ok) return
    rememberDomain(host)
    window.open(href, '_blank', 'noopener,noreferrer')
  }
  return (
    // 주소 툴팁은 UiTooltip(body 포털) 사용 — 이전에는 메시지 목록(overflow) 내부에 absolute 로 렌더링하여 마지막 줄에서 잘리고 가로 스크롤이 발생했음
    <UiTooltip text={href} disabled={!masked} side="bottom">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="text-primary underline underline-offset-2 hover:decoration-2"
        onClick={(e) => { void onClick(e) }}
      >{children}</a>
    </UiTooltip>
  )
}

const CHIP = 'rounded px-0.5 font-medium'

/** @이름 칩 — 역할 · 그룹(@here/@everyone) · 사용자 */
function AtChip({ name, group }: { name: string; group: boolean }) {
  const { t } = useI18n()
  const roles = useStore(chatRolesStore, s => s.roles)
  const allUsers = useStore(chatStore, s => s.allUsers)
  const members = useStore(chatStore, s => s.members)
  const memberCount = useStore(chatStore, s => selectSelectedChannel(s)?.member_count ?? s.members.length)
  if (group) {
    const lower = name.toLowerCase()
    const here = lower === 'here'
    const tip = here
      ? t('chat.msg.mention.hereTip', { n: members.filter(m => m.is_online).length })
      : t('chat.msg.mention.everyoneTip', { n: memberCount })
    return <UiTooltip text={tip}><span className={cn(CHIP, 'bg-warning/15 text-warning')} title={tip}>@{name}</span></UiTooltip>
  }
  const role = roles.find(r => r.mention && r.mention.toLowerCase() === name.toLowerCase())
  if (role) {
    const tip = t('chat.msg.mention.roleTip', { n: role.member_count ?? 0 })
    return <UiTooltip text={tip}><span className={cn(CHIP, roleChipClass(role.color))} title={tip}>@{role.name}</span></UiTooltip>
  }
  const u = allUsers.find(x => x.username === name)
  return (
    <span
      role="button"
      tabIndex={0}
      className={cn(CHIP, 'cursor-pointer bg-primary/15 text-primary hover:bg-primary/30')}
      title={u ? '@' + u.username : undefined}
      onClick={(e) => { e.stopPropagation(); if (u) setProfilePopout({ userId: u.id, anchor: anchorOf(e.currentTarget) }) }}
      onKeyDown={(e) => { if (u && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setProfilePopout({ userId: u.id, anchor: anchorOf(e.currentTarget) }) } }}
    >@{u?.display_name || name}</span>
  )
}

/** #채널 칩 — 볼 수 없는(목록에 없는) <#id> 는 muted "# 볼 수 없는 채널", 이름이 일치하는 채널이 없는 #글자 는 그대로 표시 */
function ChannelChip({ refName, byId }: { refName: string; byId: boolean }) {
  const { t } = useI18n()
  const ch = useStore(chatStore, s => s.channels.find(c => (byId ? c.id === refName : c.name === refName) && c.type !== 'dm') || null)
  if (!ch) {
    if (!byId) return <>#{refName}</>
    const tip = t('chat.msg.mention.goneTip')
    return <UiTooltip text={tip}><span className="rounded bg-muted px-0.5 text-muted-foreground" title={tip}>{t('chat.msg.mention.goneChannel')}</span></UiTooltip>
  }
  return (
    <span
      role="link"
      tabIndex={0}
      className={cn(CHIP, 'cursor-pointer bg-primary/15 text-primary hover:bg-primary/30')}
      onClick={(e) => { e.stopPropagation(); void selectChannel(ch.id) }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void selectChannel(ch.id) } }}
    >#{ch.name}</span>
  )
}

interface Ctx { emojiUrl: (name: string) => string | null; jumbo: boolean }

function CustomEmojiImg({ name, url, jumbo }: { name: string; url: string; jumbo: boolean }) {
  return (
    <img
      src={apiUrl(url)}
      alt={`:${name}:`}
      title={`:${name}:`}
      draggable={false}
      loading="lazy"
      className={cn('inline-block object-contain', jumbo ? 'h-12 w-12 align-bottom' : 'h-[22px] w-[22px] align-[-5px]')}
    />
  )
}

function renderInline(c: MdInline[], ctx: Ctx, kp = ''): ReactNode[] {
  return c.map((n, i) => {
    const k = kp + i
    switch (n.t) {
      case 'text': return <Fragment key={k}>{n.v}</Fragment>
      case 'br': return <br key={k} />
      case 'b': return <strong key={k} className="font-bold">{renderInline(n.c, ctx, k + '.')}</strong>
      case 'i': return <em key={k} className="italic">{renderInline(n.c, ctx, k + '.')}</em>
      case 'u': return <span key={k} className="underline underline-offset-2">{renderInline(n.c, ctx, k + '.')}</span>
      case 's': return <del key={k} className="line-through">{renderInline(n.c, ctx, k + '.')}</del>
      case 'spoiler': return <Spoiler key={k}>{renderInline(n.c, ctx, k + '.')}</Spoiler>
      case 'code': return <code key={k} className="rounded bg-muted px-1 font-mono text-[14px]">{n.v}</code>
      case 'link': return <MdLink key={k} href={n.href} masked={n.masked}>{renderInline(n.c, ctx, k + '.')}</MdLink>
      case 'at': return <AtChip key={k} name={n.name} group={n.group} />
      case 'channel': return <ChannelChip key={k} refName={n.ref} byId={n.byId} />
      case 'emoji': {
        const url = ctx.emojiUrl(n.name)
        return url ? <CustomEmojiImg key={k} name={n.name} url={url} jumbo={ctx.jumbo} /> : <Fragment key={k}>:{n.name}:</Fragment>
      }
      default: return null
    }
  })
}

const BULLETS = ['•', '◦', '▪']

function ListBlock({ items, ctx }: { items: MdListItem[]; ctx: Ctx }) {
  return (
    <ul className="flex flex-col text-[16px] leading-[22px]" data-md="list">
      {items.map((it, i) => (
        <li key={i} className="flex" style={{ paddingLeft: it.depth * 20 }}>
          <span className="w-5 shrink-0 text-muted-foreground" aria-hidden="true">{it.ordered ? `${it.n}.` : BULLETS[it.depth] || '•'}</span>
          <span className="min-w-0 break-words">{renderInline(it.c, ctx, i + ':')}</span>
        </li>
      ))}
    </ul>
  )
}

function Blocks({ blocks, ctx, lead, tail }: { blocks: MdBlock[]; ctx: Ctx; lead?: ReactNode; tail?: ReactNode }) {
  const firstP = blocks[0]?.t === 'p'
  return (
    <>
      {lead && !firstP && <div>{lead}</div>}
      {blocks.map((b, i) => {
        const isLast = i === blocks.length - 1
        const end = isLast && tail ? <>{' '}{tail}</> : null
        switch (b.t) {
          case 'p':
            return (
              <p key={i} className={cn('whitespace-pre-wrap break-words', ctx.jumbo ? 'text-[48px] leading-[56px]' : '')}>
                {i === 0 && lead}{renderInline(b.c, ctx, i + ':')}{end}
              </p>
            )
          case 'h': {
            const cls = b.level === 1 ? 'mt-1 text-[24px] font-bold leading-[30px]' : b.level === 2 ? 'mt-1 text-[20px] font-bold leading-7' : 'text-[16px] font-bold leading-[22px]'
            return <p key={i} role="heading" aria-level={b.level + 2} className={cn('break-words', cls)}>{renderInline(b.c, ctx, i + ':')}{end}</p>
          }
          case 'sub': return <p key={i} className="break-words text-[13px] leading-tight text-muted-foreground" data-md="sub">{renderInline(b.c, ctx, i + ':')}{end}</p>
          case 'list': return <Fragment key={i}><ListBlock items={b.items} ctx={ctx} />{end}</Fragment>
          case 'quote':
            return (
              <blockquote key={i} className="flex gap-2 text-[16px] leading-[22px]">
                <span className="w-1 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden="true" />
                <div className="flex min-w-0 flex-col"><Blocks blocks={b.c} ctx={ctx} />{end}</div>
              </blockquote>
            )
          case 'code': return <Fragment key={i}><CodeBlock lang={b.lang} code={b.code} />{end}</Fragment>
          default: return null
        }
      })}
    </>
  )
}

export interface ChatMarkdownProps {
  content: string
  /** 첫 문단 맨 앞에 추가할 요소(compact 의 이름) */
  lead?: ReactNode
  /** 마지막에 추가할 요소("(수정됨)") */
  tail?: ReactNode
  className?: string
}

/** 커스텀 이모지 목록 — 최초 사용처에서 조회를 시작한다(구버전 서버이면 빈 목록) */
export function useCustomEmojiUrl(): (name: string) => string | null {
  const custom = useStore(chatEmojiStore, s => s.custom)
  const loaded = useRef(false)
  useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    void loadCustomEmojis().catch(() => {})
  }, [])
  return useMemo(() => {
    const m = new Map(custom.map(c => [c.name, c.url]))
    return (name: string) => m.get(name) ?? null
  }, [custom])
}

/** 메시지 본문 */
export const ChatMarkdown = memo(function ChatMarkdown({ content, lead, tail, className }: ChatMarkdownProps) {
  const blocks = useMemo(() => parseChatMarkdown(content), [content])
  const emojiUrl = useCustomEmojiUrl()
  const jumbo = isEmojiOnly(blocks, n => !!emojiUrl(n))
  const ctx: Ctx = { emojiUrl, jumbo }
  if (!blocks.length) return lead || tail ? <p className={className}>{lead}{tail}</p> : null
  return (
    <div className={cn('chat-md flex min-w-0 flex-col text-[16px] leading-[22px]', className)} data-jumbo={jumbo || undefined}>
      <Blocks blocks={blocks} ctx={ctx} lead={lead} tail={tail} />
    </div>
  )
})

export default ChatMarkdown
