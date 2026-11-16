/**
 * 채팅 헤더 검색란 + 필터 안내 드롭다운 + 날짜.
 * 배치 위치(헤더 오른쪽 끝)는 SHELL — `<ChatSearchBox />`. 모바일 결과 화면 안에서는 `<ChatSearchBox variant="mobile" />`.
 *
 * 접힘: 160×32 bg-muted rounded-md · search 16 · "검색" 13 muted · "Ctrl F"(맥 "⌘F") mono 11.
 * 펼침(포커스 상태이거나 칩·입력 문자가 있는 경우): 360 · border-2 ring · bg-card. role=combobox + aria-expanded + aria-controls.
 *   필터 칩 h-24 rounded bg-primary/15 · 키 = primary 600 mono · 값 12. 값 선택 중인 칩(대기)은 값 없이 키만 표시.
 * 드롭다운(포털 · fixed · 360 · bg-popover p-2 shadow-xl · 검색란 오른쪽 끝에 맞춘 아래):
 *   필터 목록 = "필터" 12/600 → 행 36(키 mono 13/600 + 설명 13 muted, 선택한 행 bg-overlay-selected) → 아래 안내 12.
 *   값 제안 = from/mentions 사용자(아바타 20 · 이름 · @아이디) · in 채널 · has 6개 · 날짜는 7열 미니 달력(UiMiniCalendar · KIT).
 * 키보드: 입력 중 `from:` 등 → 칩 · ↑↓ 선택 · Enter(선택한 행이 있으면 삽입, 없으면 검색) · Tab 값 삽입 · Backspace(빈 입력란) 칩 삭제 · Esc 닫기.
 * Ctrl+F(맥 ⌘F, 디스코드 실측): 채팅 화면(본 검색란이 렌더링된 동안)에서만 브라우저 기본 찾기 대신 본 검색란에 포커스한다.
 *   대화 상자(설정 전체 화면 등)가 열려 있으면 가로채지 않는다. Ctrl+K 는 전역 명령 팔레트로 유지한다(가로채지 않음).
 * Enter → useChatSearch.runSearch → 오른쪽 영역(chatStore.showSearchPanel)에 ChatSearchResults.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from 'zustand'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { toCssRect, viewportCss } from '~/composables/useViewport'
import { chatStore, getDMDisplayName, searchUsers, type Channel, type WorkspaceUser } from '~/composables/useChat'
import { initialOf } from '~/composables/useChatUi'
import {
  addSearchChip, chatSearchStore, chipLabel, DATE_KEYS, filterToken, FILTER_ORDER, HAS_VALUES, hasLabel, isYmd, liveConvert,
  MOBILE_FILTER_KEYS, normalizeHas, parseSearchText, PERSON_KEYS, removeSearchChip, runSearch, selectSearchExpanded,
  setSearchFocused, setSearchPending, setSearchText, clearSearchBox, type FilterKey, type SearchChip,
} from '~/composables/useChatSearch'
import { UiIcon } from '~/components/ui/Icon'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiMiniCalendar } from '~/components/ui/DatePopover'

const MAX_SUGGEST = 8
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** 채팅 검색 단축키 — Ctrl+F(맥 ⌘F). 한글 입력기에서도 인식되도록 e.code 도 확인 */
export function isSearchShortcut(e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'key' | 'code'>, mac = IS_MAC): boolean {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  return mod && !e.shiftKey && !e.altKey && (e.key.toLowerCase() === 'f' || e.code === 'KeyF')
}

interface Suggestion {
  id: string
  chip: SearchChip
  label: string
  secondary?: string
  lead?: ReactNode
}

function channelLabel(c: Channel): string {
  return c.type === 'dm' ? getDMDisplayName(c) : c.type === 'private' ? c.name : `#${c.name}`
}
function userName(u: { display_name: string | null; username: string }) { return u.display_name || u.username }

/** 사용자·채널 이름 → 칩 값(붙여 넣은 "from:이도윤" 처리) */
function resolvers() {
  const s = chatStore.getState()
  return {
    user: (q: string) => {
      const l = q.toLowerCase()
      const u = s.allUsers.find(x => x.username.toLowerCase() === l) || s.allUsers.find(x => (x.display_name || '').toLowerCase() === l)
      return u ? { value: u.username, label: userName(u) } : null
    },
    channel: (q: string) => {
      const l = q.toLowerCase()
      const c = s.channels.find(x => x.id === q) || s.channels.find(x => x.type !== 'dm' && x.name.toLowerCase() === l)
      return c ? { value: c.id, label: channelLabel(c) } : null
    },
  }
}

export interface ChatSearchBoxProps {
  /** header = 채팅 헤더(160 → 360 + 드롭다운 포털) · mobile = 결과 화면 위 전체 폭(44, 제안은 바로 아래에 표시) */
  variant?: 'header' | 'mobile'
  /** 렌더링 즉시 입력에 포커스(모바일 결과 화면 최초 진입 시) */
  autoFocus?: boolean
  className?: string
}

/** 검색란 */
export function ChatSearchBox({ variant = 'header', autoFocus = false, className }: ChatSearchBoxProps) {
  const { t } = useI18n()
  const mobile = variant === 'mobile'
  const chips = useStore(chatSearchStore, s => s.chips)
  const text = useStore(chatSearchStore, s => s.text)
  const pending = useStore(chatSearchStore, s => s.pending)
  const focused = useStore(chatSearchStore, s => s.focused)
  const expanded = useStore(chatSearchStore, selectSearchExpanded)
  const allUsers = useStore(chatStore, s => s.allUsers)
  const channels = useStore(chatStore, s => s.channels)

  const [valueQ, setValueQ] = useState('')
  const [active, setActive] = useState(-1)
  const [open, setOpen] = useState(false)
  const [remoteUsers, setRemoteUsers] = useState<WorkspaceUser[]>([])
  const inputRef = useRef<HTMLInputElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const dropRef = useRef<HTMLDivElement | null>(null)
  const listId = useMemo(() => `chat-search-${Math.random().toString(36).slice(2, 8)}`, [])

  const dateMode = !!pending && DATE_KEYS.includes(pending)

  // ── 필터 목록(대기 칩 없음): 입력이 비어 있으면 전체, 마지막 단어가 키의 접두부이면 해당 키만 ──
  const lastWord = text.endsWith(' ') ? '' : (text.split(' ').pop() || '').toLowerCase()
  const filterRows = useMemo(() => {
    if (pending) return []
    if (!lastWord) return text.trim() ? [] : FILTER_ORDER
    return FILTER_ORDER.filter(k => filterToken(k).startsWith(lastWord) && filterToken(k) !== lastWord)
  }, [pending, lastWord, text])

  // 사용자 — 로드된 전체 사용자에서 필터링하고, 없으면 서버 검색(150ms)
  useEffect(() => {
    if (!pending || !PERSON_KEYS.includes(pending) || allUsers.length || !valueQ.trim()) { setRemoteUsers([]); return }
    const h = setTimeout(() => { searchUsers(valueQ).then(r => setRemoteUsers(r as WorkspaceUser[])).catch(() => setRemoteUsers([])) }, 150)
    return () => clearTimeout(h)
  }, [pending, valueQ, allUsers.length])

  const valueRows: Suggestion[] = useMemo(() => {
    if (!pending || dateMode) return []
    const q = valueQ.trim().toLowerCase()
    if (PERSON_KEYS.includes(pending)) {
      const src = allUsers.length ? allUsers : remoteUsers
      return src
        .filter(u => !q || u.username.toLowerCase().includes(q) || (u.display_name || '').toLowerCase().includes(q))
        .slice(0, MAX_SUGGEST)
        .map(u => ({
          id: u.id, chip: { key: pending, value: u.username, label: userName(u) }, label: userName(u), secondary: `@${u.username}`,
          lead: <UiAvatar src={u.avatar_url} fallback={initialOf(userName(u))} textSize={9} className="h-5 w-5" />,
        }))
    }
    if (pending === 'in') {
      return channels
        .filter(c => !c.is_voice && (!q || channelLabel(c).toLowerCase().includes(q)))
        .slice(0, MAX_SUGGEST)
        .map(c => ({
          id: c.id, chip: { key: 'in' as FilterKey, value: c.id, label: channelLabel(c) }, label: channelLabel(c).replace(/^#/, ''),
          lead: <UiIcon name={c.type === 'dm' ? 'user' : c.type === 'private' ? 'lock' : 'hash'} className="h-4 w-4 text-muted-foreground" />,
        }))
    }
    if (pending === 'has') {
      return HAS_VALUES
        .filter(h => !chips.some(c => c.key === 'has' && c.value === h))
        .filter(h => !q || h.startsWith(q) || hasLabel(h).toLowerCase().startsWith(q))
        .map(h => ({ id: h, chip: { key: 'has' as FilterKey, value: h }, label: hasLabel(h), secondary: h }))
    }
    return []
  }, [pending, dateMode, valueQ, allUsers, remoteUsers, channels, chips])

  const rowsCount = pending ? valueRows.length : filterRows.length
  const showDrop = open && (dateMode || rowsCount > 0 || (!!pending && !dateMode))

  // 목록 변경 시 선택 행을 재설정한다(값 제안은 첫 행, 필터 목록은 ↑↓ 입력 전까지 선택 없음 — 시안의 첫 행 강조는 포커스 상태 표현)
  const [prevKey, setPrevKey] = useState('')
  const rowsKey = `${pending}|${rowsCount}|${valueQ}`
  if (rowsKey !== prevKey) { setPrevKey(rowsKey); setActive(pending ? (rowsCount ? 0 : -1) : -1) }

  // ── 동작 ──
  function focusInput() { requestAnimationFrame(() => inputRef.current?.focus()) }
  function pickFilter(k: FilterKey) {
    // 입력 중이던 "fr" 같은 접두부는 제거
    const base = lastWord && filterToken(k).startsWith(lastWord) ? text.slice(0, text.length - lastWord.length) : text
    setSearchText(base)
    if (k === 'pinned') addSearchChip({ key: 'pinned', value: '' })
    else setSearchPending(k)
    setValueQ('')
    setOpen(true)
    focusInput()
  }
  function pickValue(chip: SearchChip) {
    addSearchChip(chip)
    setValueQ('')
    focusInput()
  }
  function commitRaw(raw: string = valueQ): boolean {
    if (!pending) return false
    const v = raw.trim()
    if (!v) return false
    if (pending === 'has') { const h = normalizeHas(v); if (!h) return false; pickValue({ key: 'has', value: h }); return true }
    if (DATE_KEYS.includes(pending)) { if (!isYmd(v)) return false; pickValue({ key: pending, value: v }); return true }
    const r = pending === 'in' ? resolvers().channel(v.replace(/^#/, '')) : resolvers().user(v.replace(/^@/, ''))
    pickValue(r ? { key: pending, ...r } : { key: pending, value: v })
    return true
  }
  async function submit() {
    // 입력 완료된 "from:a has:link" 문자열도 칩으로 변환
    const parsed = parseSearchText(chatSearchStore.getState().text, resolvers())
    for (const c of parsed.chips) addSearchChip(c)
    setSearchText(parsed.text)
    setOpen(false)
    const ok = await runSearch()
    if (ok && !mobile) inputRef.current?.blur()
  }

  function onChange(v: string) {
    setOpen(true)
    if (pending) {
      // 값 뒤 공백 = 해당 값으로 칩 생성(사용자·채널은 첫 제안)
      if (v.endsWith(' ') && v.trim()) {
        if (valueRows[0] && !dateMode) pickValue(valueRows[0].chip)
        else if (!commitRaw(v)) setValueQ(v.trim())
        return
      }
      setValueQ(v)
      return
    }
    const conv = liveConvert(v)
    if (conv?.pending) { setSearchText(conv.text); setSearchPending(conv.pending); setValueQ(''); return }
    if (conv?.chip) { addSearchChip(conv.chip); setSearchText(conv.text); return }
    setSearchText(v)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const n = rowsCount
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!n) return
      e.preventDefault()
      setOpen(true)
      setActive(a => (e.key === 'ArrowDown' ? (a + 1) % n : (a <= 0 ? n - 1 : a - 1)))
      return
    }
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (pending) {
        if (!dateMode && valueRows[active]) pickValue(valueRows[active].chip)
        else if (!commitRaw() && !valueQ.trim()) { setSearchPending(null); void submit() }
        return
      }
      if (active >= 0 && filterRows[active]) { pickFilter(filterRows[active]); return }
      void submit()
      return
    }
    if (e.key === 'Tab' && pending && !dateMode && valueRows[active]) {
      e.preventDefault()
      pickValue(valueRows[active].chip)
      return
    }
    if (e.key === 'Backspace') {
      const el = e.currentTarget
      if (el.selectionStart === 0 && el.selectionEnd === 0) {
        if (pending) { e.preventDefault(); setSearchPending(null); setValueQ(''); return }
        const cs = chatSearchStore.getState().chips
        if (cs.length) { e.preventDefault(); removeSearchChip(cs.length - 1) }
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (pending) { setSearchPending(null); setValueQ(''); return }
      if (open) { setOpen(false); return }
      inputRef.current?.blur()
    }
  }

  function onFocus() { setSearchFocused(true); setOpen(true) }
  function onBlurWithin(next: EventTarget | null) {
    const n = next as Node | null
    if (n && (boxRef.current?.contains(n) || dropRef.current?.contains(n))) return
    setSearchFocused(false)
    setOpen(false)
    if (chatSearchStore.getState().pending && !valueQ.trim()) setSearchPending(null)
  }

  useEffect(() => { if (autoFocus) focusInput() }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Ctrl+F / ⌘F(채팅 화면에서만 — 브라우저 찾기 대체) ──
  useEffect(() => {
    if (mobile) return
    function onKey(e: globalThis.KeyboardEvent) {
      if (!isSearchShortcut(e)) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      if (!inputRef.current || !inputRef.current.isConnected || inputRef.current.offsetParent === null) return
      e.preventDefault()
      inputRef.current.focus()
      inputRef.current.select()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [mobile])

  // ── 드롭다운 위치(포털 · 검색란 오른쪽 끝 아래) ──
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (mobile || !showDrop) return
    function place() {
      const box = boxRef.current
      if (!box) return
      const r = toCssRect(box.getBoundingClientRect())
      const { vw } = viewportCss()
      const w = 360
      setPos({ left: Math.max(8, Math.min(r.right - w, vw - w - 8)), top: r.bottom + 6 })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [mobile, showDrop, expanded])

  const inputValue = pending ? valueQ : text
  const activeId = active >= 0 ? `${listId}-${active}` : undefined

  // ── 제안 내용(데스크톱 드롭다운 · 모바일 아래 목록 공용) ──
  const suggestions = (
    <>
      {dateMode && pending && (
        <div className="flex flex-col gap-2 p-1">
          <p className="text-[14px] font-semibold">{t('chat.right.search.dateTitle', { key: filterToken(pending) })}</p>
          <UiMiniCalendar
            value={isYmd(valueQ) ? valueQ : null}
            onPick={(ymd) => pickValue({ key: pending, value: ymd })}
            ariaLabel={t('chat.right.search.dateTitle', { key: filterToken(pending) })}
          />
          <p className="text-[12px] text-muted-foreground">{t('chat.right.search.dateHint')}</p>
        </div>
      )}
      {!pending && filterRows.length > 0 && (
        <>
          <p className="px-2 pb-1 text-[12px] font-semibold text-muted-foreground">{t('chat.right.search.filtersTitle')}</p>
          <div role="listbox" id={listId} aria-label={t('chat.right.search.filtersLabel')}>
            {filterRows.map((k, i) => (
              <div
                key={k}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={cn('flex cursor-pointer items-center gap-3 rounded-md px-2', mobile ? 'h-11' : 'h-9', i === active ? 'bg-overlay-selected' : 'hover:bg-overlay-hover')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickFilter(k)}
              >
                <b className="font-mono text-[13px] font-semibold">{filterToken(k)}</b>
                <span className="flex-1 text-[13px] text-muted-foreground">{t(`chat.right.search.f.${k}`)}</span>
              </div>
            ))}
          </div>
          <p className="mt-1 border-t border-border px-2 pt-2 text-[12px] text-muted-foreground">{t('chat.right.search.filtersHint')}</p>
        </>
      )}
      {pending && !dateMode && (
        <>
          <p className="px-2 pb-1 text-[12px] font-semibold text-muted-foreground">{filterToken(pending)} {t(`chat.right.search.f.${pending}`)}</p>
          {valueRows.length > 0
            ? (
              <div role="listbox" id={listId} aria-label={t(`chat.right.search.f.${pending}`)}>
                {valueRows.map((r, i) => (
                  <div
                    key={r.id}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className={cn('flex cursor-pointer items-center gap-2 rounded-md px-2', mobile ? 'h-11' : 'h-9', i === active ? 'bg-overlay-selected' : 'hover:bg-overlay-hover')}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickValue(r.chip)}
                  >
                    {r.lead && <span className="flex w-5 shrink-0 justify-center">{r.lead}</span>}
                    <span className="min-w-0 truncate text-[14px] font-medium">{r.label}</span>
                    {r.secondary && <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">{r.secondary}</span>}
                  </div>
                ))}
              </div>
            )
            : <p className="px-2 py-2 text-[13px] text-muted-foreground">{PERSON_KEYS.includes(pending) ? t('chat.right.search.noUsers') : pending === 'in' ? t('chat.right.search.noChannels') : t('chat.right.search.noValues')}</p>}
          <p className="mt-1 border-t border-border px-2 pt-2 text-[12px] text-muted-foreground">{t('chat.right.search.valueHint')}</p>
        </>
      )}
    </>
  )

  const chipEls = (
    <>
      {chips.map((c, i) => (
        <span key={`${c.key}-${c.value}-${i}`} className={cn('flex shrink-0 items-center gap-1 rounded-sm bg-primary/15 px-1.5', mobile ? 'h-7 text-[13px]' : 'h-6 text-[12px]')}>
          <b className="font-mono font-semibold text-primary">{filterToken(c.key)}</b>{chipLabel(c)}
          <button
            type="button"
            tabIndex={-1}
            aria-label={t('chat.right.search.removeChip', { chip: filterToken(c.key) + chipLabel(c) })}
            className="-mr-1 flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { removeSearchChip(i); focusInput() }}
          >
            <UiIcon name="close" className="h-3 w-3" />
          </button>
        </span>
      ))}
      {pending && (
        <span className={cn('flex shrink-0 items-center rounded-sm bg-primary/15 px-1.5', mobile ? 'h-7 text-[13px]' : 'h-6 text-[12px]')}>
          <b className="font-mono font-semibold text-primary">{filterToken(pending)}</b>
        </span>
      )}
    </>
  )

  const input = (
    <input
      ref={inputRef}
      type="text"
      role="combobox"
      aria-expanded={showDrop}
      aria-controls={showDrop && !dateMode ? listId : undefined}
      aria-activedescendant={activeId}
      aria-autocomplete="list"
      aria-label={t('chat.right.search.label')}
      autoComplete="off"
      spellCheck={false}
      enterKeyHint="search"
      value={inputValue}
      placeholder={expanded || mobile ? (chips.length || pending ? '' : t('chat.right.search.placeholder')) : t('chat.right.search.box')}
      className={cn(
        'min-w-[48px] flex-1 bg-transparent outline-none placeholder:text-muted-foreground',
        mobile ? 'h-full text-[16px]' : 'h-full text-[13px]',
      )}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    />
  )

  if (mobile) {
    return (
      <div ref={boxRef} className={cn('flex flex-col gap-2', className)} onBlur={(e) => onBlurWithin(e.relatedTarget)}>
        <div className="flex h-11 items-center gap-1.5 overflow-x-auto rounded-lg border-2 border-ring bg-card px-2">
          <UiIcon name="search" className="h-4 w-4 shrink-0 text-muted-foreground" />
          {chipEls}
          {input}
          {(chips.length > 0 || inputValue) && (
            <button type="button" aria-label={t('chat.right.search.clear')} className="-mr-1 flex h-11 w-11 shrink-0 items-center justify-center text-muted-foreground" onMouseDown={(e) => e.preventDefault()} onClick={() => { clearSearchBox(); setValueQ(''); focusInput() }}>
              <UiIcon name="close" className="h-4 w-4" />
            </button>
          )}
        </div>
        {/* 모바일 필터 칩 행 — 누르면 해당 키로 값 선택 */}
        <div className="flex gap-1.5 overflow-x-auto">
          {MOBILE_FILTER_KEYS.map(k => (
            <button
              key={k}
              type="button"
              className="flex h-9 shrink-0 items-center rounded-full border border-border px-3 font-mono text-[13px] hover:bg-overlay-hover"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pickFilter(k)}
            >
              {filterToken(k)}
            </button>
          ))}
        </div>
        {focused && (pending || filterRows.length > 0) && <div className="rounded-lg border border-border bg-popover p-2">{suggestions}</div>}
      </div>
    )
  }

  return (
    <div ref={boxRef} className={cn('relative shrink-0', className)} onBlur={(e) => onBlurWithin(e.relatedTarget)}>
      <div
        className={cn(
          'flex h-8 items-center overflow-hidden rounded-md text-[13px] transition-[width] duration-150 motion-reduce:transition-none',
          expanded ? 'w-[360px] max-w-[min(360px,40vw)] gap-1 border-2 border-ring bg-card px-1.5' : 'w-40 cursor-text gap-1.5 bg-muted px-2 text-muted-foreground',
        )}
        onMouseDown={(e) => { if (e.target !== inputRef.current && !(e.target as HTMLElement).closest('button')) { e.preventDefault(); inputRef.current?.focus() } }}
      >
        <UiIcon name="search" className={cn('h-4 w-4 shrink-0', expanded && 'text-muted-foreground')} />
        {(chips.length > 0 || pending) && <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden">{chipEls}</span>}
        {input}
        {expanded && (chips.length > 0 || inputValue) && (
          <button type="button" aria-label={t('chat.right.search.clear')} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-overlay-hover hover:text-foreground" onMouseDown={(e) => e.preventDefault()} onClick={() => { clearSearchBox(); setValueQ(''); focusInput() }}>
            <UiIcon name="close" className="h-3.5 w-3.5" />
          </button>
        )}
        {!expanded && <span className="shrink-0 font-mono text-[11px]" aria-hidden="true">{IS_MAC ? '⌘F' : 'Ctrl F'}</span>}
      </div>
      {showDrop && pos && createPortal(
        <div
          ref={dropRef}
          className="fixed z-overlay flex max-h-[min(480px,70dvh)] flex-col overflow-y-auto rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xl"
          style={{ left: pos.left, top: pos.top, width: 360 }}
          onBlur={(e) => onBlurWithin(e.relatedTarget)}
        >
          {suggestions}
        </div>,
        document.body,
      )}
    </div>
  )
}

export default ChatSearchBox
