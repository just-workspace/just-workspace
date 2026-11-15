/**
 * 받는 사람 칩 + 자동완성 — Vue 판 components/mail/MailRecipientField.vue.
 * Outlook식 수신자 칩 + 자동완성. modelValue 는 콤마 구분 문자열(기존 compose 로직 무수정 호환).
 * 데스크톱(받는이 칩 26 · 아바타 18 · ✕ 18) / 모바일(칩 32 · ✕ 28). ✕ 는 시각 크기 유지, 히트 영역만 40.
 * 워크스페이스 사람(내 도메인 주소·자동완성 출처 user)은 primary/13 채움 + 이니셜, 바깥 주소는 테두리.
 */
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useI18n } from '~/i18n'
// Vue 의 class 묶음처럼 그냥 잇는다(tailwind-merge 를 쓰는 cn 은 leading-[1.35]+text-xl 같은 짝을 지워 Vue 와 달라진다)
import { clsx as cx } from 'clsx'
import { $fetch } from '~/lib/api'
import { UiIcon } from '~/components/ui/Icon'
import { UiBadge } from '~/components/ui/Badge'
import { splitAddressList } from '~/components/mail/composeText'

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// 자동완성 — 서버(최근 수신인 + 내부 사용자 + 주소록)를 먼저 보고,
// 응답이 없거나 오프라인이면 localStorage 기록으로 버틴다.
// 예전에는 localStorage 만 봐서 기기를 바꾸면 목록이 통째로 사라졌다.
interface Recent { name: string; email: string; sources?: string[]; organization?: string }

export function parseEntry(raw: string): { name: string; email: string } {
  const m = raw.match(/^(.*?)<(.+?)>$/)
  // 쉼표가 든 이름은 따옴표로 감싸 둔다(joinAddrs) — 보여 줄 때는 뗀다
  return m ? { name: m[1].trim().replace(/^"|"$/g, ''), email: m[2].trim() } : { name: '', email: raw.trim() }
}
function chipLabel(c: string): string { const p = parseEntry(c); return p.name || p.email }
function chipValid(c: string): boolean { return emailRe.test(parseEntry(c).email) }

function loadRecents(): Recent[] {
  try { return JSON.parse(localStorage.getItem('mail-recent-recipients') || '[]') } catch { return [] }
}
function pushRecent(e: Recent) {
  if (!e.email || !emailRe.test(e.email)) return
  try {
    const list = loadRecents().filter(r => r.email.toLowerCase() !== e.email.toLowerCase())
    list.unshift({ name: e.name, email: e.email })
    localStorage.setItem('mail-recent-recipients', JSON.stringify(list.slice(0, 50)))
  } catch { /* ignore */ }
}

export interface MailRecipientFieldProps {
  /** 콤마 구분 주소 문자열(Vue v-model) */
  modelValue: string
  /** 주소 바뀜 */
  onUpdateModelValue?: (v: string) => void
  /** 왼쪽 라벨(받는이·참조·숨은참조) */
  label: string
  placeholder?: string
  /** 주소 블록 안에서 자기 테두리를 끈다 */
  borderless?: boolean
  /** md 데스크톱 작성 창 · lg 모바일 전체 화면 */
  size?: 'md' | 'lg'
  /** 내 메일 도메인 — 같으면 워크스페이스 사람으로 본다 */
  ownDomain?: string
  /** 받는 사람 줄 오른쪽(참조·숨은참조 링크 등, Vue #actions 슬롯) */
  actions?: ReactNode
}

/** 받는 사람 칩 입력 */
export function MailRecipientField({ modelValue, onUpdateModelValue, label, placeholder, borderless, size = 'md', ownDomain = '', actions }: MailRecipientFieldProps) {
  const { t } = useI18n()
  const [uid] = useState(() => `mail-rcpt-${Math.random().toString(36).slice(2, 8)}`)
  const internalEmails = useRef(new Set<string>())

  const [input, setInput] = useState('')
  const [showSug, setShowSug] = useState(false)
  const [sugIndex, setSugIndex] = useState(0)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const chips = useMemo(() => splitAddressList(modelValue || ''), [modelValue])
  // 이벤트 처리기(blur 뒤 타이머 등)에서 "지금" 값을 읽는다
  const latest = useRef({ chips, input, modelValue })
  latest.current = { chips, input, modelValue }
  function setChips(arr: string[]) {
    // 같은 틱에 여러 번 바뀌면(붙여넣기) 앞의 결과 위에 쌓는다
    latest.current = { ...latest.current, chips: arr, modelValue: arr.join(', ') }
    onUpdateModelValue?.(arr.join(', '))
  }

  const [remote, setRemote] = useState<Recent[]>([])
  const sugSeq = useRef(0)

  async function fetchSuggestions(q: string) {
    const seq = ++sugSeq.current
    try {
      const data = await $fetch<Recent[]>('/api/contacts/suggest', { params: { q, limit: 8 } })
      if (seq !== sugSeq.current) return // 늦게 온 응답이 최신 입력을 덮지 않게
      setRemote(data || [])
    } catch {
      if (seq === sugSeq.current) setRemote([])
    }
  }

  // watch(input) — 첫 실행 건너뜀
  const firstInput = useRef(true)
  useEffect(() => {
    if (firstInput.current) { firstInput.current = false; return }
    const q = input.trim()
    if (!q) { setRemote([]); return }
    const tm = setTimeout(() => fetchSuggestions(q), 150)
    return () => clearTimeout(tm)
  }, [input])

  const suggestions = useMemo<Recent[]>(() => {
    const q = input.trim().toLowerCase()
    if (!q) return []
    const have = new Set(chips.map(c => parseEntry(c).email.toLowerCase()))
    const out: Recent[] = []
    const seen = new Set<string>()
    for (const r of [...remote, ...loadRecents()]) {
      const key = (r.email || '').toLowerCase()
      if (!key || have.has(key) || seen.has(key)) continue
      if (!key.includes(q) && !(r.name || '').toLowerCase().includes(q)) continue
      seen.add(key)
      out.push(r)
      if (out.length >= 8) break
    }
    return out
  }, [input, chips, remote])

  function sourceLabel(r: Recent): string {
    const s = r.sources || []
    if (s.includes('user')) return t('mail.recipient.sourceWorkspace')
    if (s.includes('contact')) return t('mail.recipient.sourceContacts')
    if (s.includes('recent')) return t('mail.recipient.sourceRecent')
    return ''
  }

  function addRaw(raw: string) {
    const v = raw.replace(/[,;]+$/, '').trim()
    if (!v) return
    const cur = latest.current.chips
    if (!cur.includes(v)) setChips([...cur, v])
    pushRecent(parseEntry(v))
  }
  function commitInput() {
    const cur = latest.current.input
    if (cur.trim()) { addRaw(cur); setInput(''); latest.current = { ...latest.current, input: '' } }
    setShowSug(false)
  }
  function isInternal(c: string): boolean {
    const email = parseEntry(c).email.toLowerCase()
    if (internalEmails.current.has(email)) return true
    const dom = ownDomain.toLowerCase()
    return !!dom && email.endsWith(`@${dom}`)
  }
  function initial(c: string): string { return (chipLabel(c).trim().charAt(0) || '?').toUpperCase() }
  function addSuggestion(r: Recent) {
    if ((r.sources || []).includes('user')) internalEmails.current.add(r.email.toLowerCase())
    addRaw(r.name ? `${r.name} <${r.email}>` : r.email)
    setInput(''); latest.current = { ...latest.current, input: '' }; setShowSug(false)
  }
  function remove(i: number) { const a = [...latest.current.chips]; a.splice(i, 1); setChips(a) }

  function onKeydown(e: KeyboardEvent<HTMLInputElement>) {
    // 한글 조합 중 Enter/Tab 은 조합 확정용이다 — 여기서 칩을 만들면 마지막 글자가 입력 칸에 한 번 더 남는다
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    // Ctrl+Enter = 보내기(작성기가 받는다) — 치던 주소를 먼저 칩으로 확정해 두고 넘긴다(제안 항목을 고르지 않는다)
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { commitInput(); return }
    if (showSug && suggestions.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSugIndex((sugIndex + 1) % suggestions.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSugIndex((sugIndex - 1 + suggestions.length) % suggestions.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); addSuggestion(suggestions[sugIndex]); return }
    }
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') { e.preventDefault(); commitInput() }
    else if (e.key === 'Tab' && input.trim()) { e.preventDefault(); commitInput() }
    else if (e.key === 'Backspace' && !input && chips.length) { remove(chips.length - 1) }
  }
  function onInput() { setShowSug(true); setSugIndex(0) }
  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const txt = e.clipboardData?.getData('text') || ''
    if (/[,;\n]/.test(txt)) { e.preventDefault(); txt.split(/[;\n]+/).flatMap(splitAddressList).forEach(p => addRaw(p)); setInput(''); latest.current = { ...latest.current, input: '' } }
  }
  // 바로 확정한다 — 예전엔 120ms 뒤라 주소를 치고 곧장 "보내기"를 누르면 그 주소가 빠진 채 나갔다.
  // (제안 항목은 onMouseDown 에서 preventDefault 하므로 눌러도 blur 가 나지 않는다 — 기다릴 이유가 없다)
  function onBlur() { commitInput() }

  return (
    <div className={cx('flex min-w-0 items-start gap-2.5', size === 'lg' ? 'text-[15px]' : 'text-[13px]')}>
      <label
        htmlFor={uid}
        className={cx('shrink-0 text-muted-foreground', size === 'lg' ? 'w-14 pt-2.5 text-sm' : 'w-[52px] pt-2')}
      >{label}</label>
      <div ref={wrapRef} className="relative min-w-0 flex-1">
        <div
          className={cx(
            'flex flex-wrap items-center gap-1.5',
            size === 'lg' ? 'min-h-10' : 'min-h-8',
            borderless ? (actions ? 'pr-28' : '') : 'rounded-md border border-input bg-background px-1.5 py-1 focus-within:ring-2 focus-within:ring-ring',
          )}
        >
          {chips.map((c, i) => (
            <span
              key={i}
              className={cx(
                'inline-flex max-w-full items-center gap-1.5 rounded-full',
                size === 'lg' ? 'h-8 pl-2.5 pr-1 text-sm' : 'h-[26px] pr-1',
                !chipValid(c) ? 'border border-danger/50 bg-danger/10 pl-2.5 text-danger'
                  : isInternal(c) ? cx('bg-primary/[0.13]', size === 'lg' ? '' : 'pl-1') : cx('border border-border', size === 'lg' ? '' : 'pl-2.5'),
              )}
              title={parseEntry(c).email}
            >
              {size !== 'lg' && chipValid(c) && isInternal(c) && (
                <span
                  aria-hidden="true"
                  className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-muted text-[9px] font-semibold text-foreground"
                >{initial(c)}</span>
              )}
              <span className="truncate">{chipLabel(c)}</span>
              <button
                type="button"
                aria-label={t('mail.recipient.remove', { name: chipLabel(c) })}
                className={cx(
                  "relative grid shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring before:absolute before:left-1/2 before:top-1/2 before:h-10 before:w-10 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']",
                  size === 'lg' ? 'h-7 w-7' : 'h-[18px] w-[18px]',
                )}
                onClick={() => remove(i)}
              ><UiIcon name="close" className={size === 'lg' ? 'h-3.5 w-3.5' : 'h-3 w-3'} strokeWidth={2.4} /></button>
            </span>
          ))}
          <input
            id={uid}
            value={input}
            onChange={(e) => { setInput(e.target.value); onInput() }}
            autoComplete="off"
            type="text"
            placeholder={chips.length ? '' : (placeholder || '')}
            className="min-w-[8ch] flex-1 bg-transparent px-1 py-1 outline-hidden placeholder:text-muted-foreground"
            onKeyDown={onKeydown}
            onPaste={onPaste}
            onBlur={onBlur}
          />
        </div>

        {/* 참조·숨은참조 링크 등을 받는 사람 줄 오른쪽에 */}
        {actions && (
          <div className={cx('absolute right-0 flex items-center gap-2.5', size === 'lg' ? 'top-1.5' : 'top-0.5')}>
            {actions}
          </div>
        )}

        {/* 자동완성 */}
        {showSug && suggestions.length > 0 && (
          <div
            role="listbox"
            className="absolute left-0 right-0 top-full z-dropdown mt-1 max-h-52 overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-md"
          >
            {suggestions.map((r, idx) => (
              <button
                key={r.email}
                type="button"
                role="option"
                aria-selected={idx === sugIndex}
                className={cx('flex min-h-9 w-full items-center gap-2 px-3 text-left text-[13px]', idx === sugIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50')}
                onMouseDown={(e) => { e.preventDefault(); addSuggestion(r) }}
              >
                {r.name && <span className="truncate font-medium">{r.name}</span>}
                <span className="truncate font-mono text-xs text-muted-foreground">{r.email}</span>
                {sourceLabel(r) && <UiBadge tone="neutral" tint size={18} className="ml-auto shrink-0">{sourceLabel(r)}</UiBadge>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default MailRecipientField
