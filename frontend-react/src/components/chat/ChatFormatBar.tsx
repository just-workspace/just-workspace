/**
 * 컴포저 Aa 서식줄. Aa 토글 하나로 펴고 접는다(10-4 원칙).
 * 순서: 굵게 · 기울임 · 밑줄 · 취소 · 링크 | 헤더(H) · 목록 · 번호 목록 · 인용 | 인라인 코드 · 코드 블록 · 스포일러.
 * 모양: 높이 36, 아래 1px, 버튼 28(radius 4) 아이콘 16, 묶음 사이 1×20 구분선.
 * 동작은 순수 함수 applyFormat(종류, 글, 선택 시작, 끝) → { text, start, end } — 선택 영역을 마크다운 기호로 감싸고
 *   이미 감싸져 있으면 벗긴다. 줄 단위(헤더·목록·번호·인용)는 선택이 걸친 줄 전부. 헤더는 # → ## → ### → 없음 순환.
 */
import { useI18n } from '~/i18n'
import { UiIcon } from '~/components/ui/Icon'

export type FormatKind = 'bold' | 'italic' | 'underline' | 'strike' | 'link' | 'heading' | 'list' | 'ordered' | 'quote' | 'code' | 'codeblock' | 'spoiler'

export interface FormatResult { text: string; start: number; end: number }

const WRAP: Partial<Record<FormatKind, [string, string]>> = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  underline: ['__', '__'],
  strike: ['~~', '~~'],
  code: ['`', '`'],
  spoiler: ['||', '||'],
  codeblock: ['```\n', '\n```'],
}

function wrap(text: string, start: number, end: number, open: string, close: string): FormatResult {
  const sel = text.slice(start, end)
  // 선택 바깥이 이미 같은 기호면 벗긴다
  if (text.slice(start - open.length, start) === open && text.slice(end, end + close.length) === close
    // 굵게(**) 안의 기울임(*) 오판 방지: 기울임은 바깥 글자가 * 가 아닐 때만
    && !(open === '*' && (text[start - 2] === '*' || text[end + 1] === '*'))) {
    return { text: text.slice(0, start - open.length) + sel + text.slice(end + close.length), start: start - open.length, end: end - open.length }
  }
  // 선택 자체가 기호로 감싸져 있으면 벗긴다
  if (sel.length >= open.length + close.length && sel.startsWith(open) && sel.endsWith(close)) {
    const inner = sel.slice(open.length, sel.length - close.length)
    return { text: text.slice(0, start) + inner + text.slice(end), start, end: start + inner.length }
  }
  return { text: text.slice(0, start) + open + sel + close + text.slice(end), start: start + open.length, end: end + open.length }
}

/** 선택이 걸친 줄 범위 */
function lineRange(text: string, start: number, end: number): [number, number] {
  const ls = text.lastIndexOf('\n', start - 1) + 1
  let le = text.indexOf('\n', Math.max(end - (end > start && text[end - 1] === '\n' ? 1 : 0), start))
  if (le === -1) le = text.length
  return [ls, le]
}

function mapLines(text: string, start: number, end: number, fn: (lines: string[]) => string[]): FormatResult {
  const [ls, le] = lineRange(text, start, end)
  const block = text.slice(ls, le)
  const next = fn(block.split('\n')).join('\n')
  const out = text.slice(0, ls) + next + text.slice(le)
  // 커서: 한 줄이고 선택이 없으면 줄 끝, 아니면 바뀐 블록 전체 선택
  if (start === end && !block.includes('\n')) { const p = ls + next.length; return { text: out, start: p, end: p } }
  return { text: out, start: ls, end: ls + next.length }
}

export function applyFormat(kind: FormatKind, text: string, start: number, end: number): FormatResult {
  const w = WRAP[kind]
  if (w) return wrap(text, start, end, w[0], w[1])
  if (kind === 'link') {
    const sel = text.slice(start, end)
    const label = sel || 'text'
    const out = text.slice(0, start) + `[${label}](url)` + text.slice(end)
    const us = start + label.length + 3   // "[label](" 다음 — url 을 선택해 바로 바꿔 쓰게
    return { text: out, start: us, end: us + 3 }
  }
  if (kind === 'heading') {
    return mapLines(text, start, end, lines => lines.map((l) => {
      const m = /^(#{1,3}) /.exec(l)
      if (!m) return '# ' + l
      if (m[1].length >= 3) return l.slice(4)
      return '#' + l
    }))
  }
  if (kind === 'list') {
    return mapLines(text, start, end, lines => (lines.every(l => /^- /.test(l)) ? lines.map(l => l.slice(2)) : lines.map(l => '- ' + l.replace(/^(- |\d+\. )/, ''))))
  }
  if (kind === 'ordered') {
    return mapLines(text, start, end, lines => (lines.every(l => /^\d+\. /.test(l)) ? lines.map(l => l.replace(/^\d+\. /, '')) : lines.map((l, i) => `${i + 1}. ` + l.replace(/^(- |\d+\. )/, ''))))
  }
  if (kind === 'quote') {
    return mapLines(text, start, end, lines => (lines.every(l => /^> /.test(l)) ? lines.map(l => l.slice(2)) : lines.map(l => '> ' + l)))
  }
  return { text, start, end }
}

/** 단축키(Ctrl/⌘ + 키) → 서식 */
export function formatForShortcut(key: string, shift: boolean): FormatKind | null {
  const k = key.toLowerCase()
  if (k === 'b' && !shift) return 'bold'
  if (k === 'i' && !shift) return 'italic'
  if (k === 'x' && shift) return 'strike'
  return null
}

const BUTTONS: Array<{ kind: FormatKind; icon?: string; text?: string; sep?: boolean; keys?: string }> = [
  { kind: 'bold', icon: 'bold', keys: 'Ctrl+B' },
  { kind: 'italic', icon: 'italic', keys: 'Ctrl+I' },
  { kind: 'underline', icon: 'underline' },
  { kind: 'strike', icon: 'strike', keys: 'Ctrl+Shift+X' },
  { kind: 'link', icon: 'link' },
  { kind: 'heading', text: 'H', sep: true },
  { kind: 'list', icon: 'list-bullet' },
  { kind: 'ordered', icon: 'list-ordered' },
  { kind: 'quote', icon: 'quote' },
  { kind: 'code', icon: 'code', sep: true },
  { kind: 'codeblock', icon: 'terminal' },
  { kind: 'spoiler', icon: 'eye-off' },
]

export interface ChatFormatBarProps {
  onFormat: (kind: FormatKind) => void
}

/** 서식줄(role=toolbar). 버튼을 눌러도 입력칸 포커스·선택이 그대로 남게 mousedown 기본 동작을 막는다 */
export function ChatFormatBar({ onFormat }: ChatFormatBarProps) {
  const { t } = useI18n()
  return (
    <div role="toolbar" aria-label={t('chat.compose.format.label')} className="flex h-9 items-center gap-0.5 overflow-x-auto border-b border-border px-1.5">
      {BUTTONS.map(b => {
        const label = t(`chat.compose.format.${b.kind}`)
        return (
          <span key={b.kind} className="flex shrink-0 items-center">
            {b.sep && <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />}
            <button
              type="button"
              aria-label={label}
              title={b.keys ? `${label} (${b.keys})` : label}
              className="flex h-7 min-w-7 items-center justify-center rounded px-1 text-[12px] font-semibold text-muted-foreground hover:bg-overlay-hover hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              onMouseDown={e => e.preventDefault()}
              onClick={() => onFormat(b.kind)}
            >
              {b.icon ? <UiIcon name={b.icon} className="h-4 w-4" /> : <span aria-hidden="true">{b.text}</span>}
            </button>
          </span>
        )
      })}
    </div>
  )
}

export default ChatFormatBar
