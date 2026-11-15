/**
 * 이모지 피커.
 * 데스크톱 팝오버 420×440 · 모바일 아래 시트 560(8열 · 칸 44). chat.tsx 에 <ChatEmojiPicker /> 하나만 두고
 * useChatUi.emojiPicker 상태로 스스로 뜬다:
 *  - 컴포저: openComposeEmojiPicker(기준 요소, insert) — 고른 글리프(피부색 적용) 또는 ':name: ' 을 insert 로 넘긴다
 *  - 리액션: setEmojiPicker({ mode: 'react', messageId, anchor: anchorOf(el) }) — toggleReaction(messageId, 글리프 | ':name:')
 * 위에서부터: 검색 36 + 피부색 버튼(펼치면 6칸 radiogroup) → 분류 탭 10(tablist) → 섹션 제목 12/600 + 격자(UiEmojiGrid, role=grid)
 *  → 아래 미리보기 줄 48(28 이모지 · `:이름:` mono · 설명, 데스크톱만). 커스텀 칸 primary/10 · 움직이면 "GIF".
 * 키보드: 검색에서 ↓ = 격자 첫 칸, Enter = 첫 결과. 격자 첫 줄 ↑ = 앞 섹션(맨 앞이면 검색), 마지막 줄 ↓ = 다음 섹션. Esc 닫기(포커스 되돌림).
 * 고른 이모지는 pushChatEmojiRecent(기본 글리프 또는 ':name:') — "자주 쓴" 첫 섹션.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from 'zustand'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { chatStore, toggleReaction } from '~/composables/useChat'
import { anchorOf, chatUiStore, setEmojiPicker } from '~/composables/useChatUi'
import { pushChatEmojiRecent, setChatEmojiSkin } from '~/composables/useUserPrefs'
import { siteConfigStore } from '~/composables/useSiteConfig'
import { useIsMobile } from '~/composables/useIsMobile'
import { toCssRect, viewportCss } from '~/composables/useViewport'
import {
  DEFAULT_FREQUENT, EMOJI_CATEGORIES, SKIN_MODIFIERS, applySkin, emojiEntry, emojisInCategory, parseCustomToken, searchEmoji, useChatEmoji,
  type EmojiCategoryKey,
} from '~/composables/useChatEmoji'
import type { CustomEmoji } from '~/composables/chatApi22'
import { UiEmojiGrid, type UiEmojiGridHandle, type UiEmojiItem } from '~/components/ui/EmojiGrid'
import { UiIcon } from '~/components/ui/Icon'

export const PICKER_W = 420
export const PICKER_H = 440
export const PICKER_SHEET_H = 560

let _composeInsert: ((text: string) => void) | null = null
/** 컴포저 이모지 버튼 · Ctrl+E — el 은 팝오버 기준(컴포저 카드) */
export function openComposeEmojiPicker(el: Element | null, insert: (text: string) => void) {
  _composeInsert = insert
  setEmojiPicker({ mode: 'compose', anchor: anchorOf(el) })
}
export function closeEmojiPicker() { setEmojiPicker(null) }

/** 팝오버 자리 — 기준의 오른쪽 끝에 맞추고 위(자리 없으면 아래). 화면 안으로 */
export function placePicker(a: { x: number; y: number; w: number; h: number } | undefined, vw: number, vh: number, w = PICKER_W, h = PICKER_H) {
  if (!a || (!a.w && !a.h)) return { left: Math.max(8, vw - w - 16), top: Math.max(8, vh - h - 96) }
  const left = Math.max(8, Math.min(a.x + a.w - w, vw - w - 8))
  let top = a.y - h - 4
  if (top < 8) top = a.y + a.h + 4
  top = Math.max(8, Math.min(top, vh - h - 8))
  return { left, top }
}

interface Section { key: string; title: string; items: UiEmojiItem[]; cat?: EmojiCategoryKey }

const SKIN_LABEL_KEYS = ['skin0', 'skin1', 'skin2', 'skin3', 'skin4', 'skin5']

export function ChatEmojiPicker() {
  const st = useStore(chatUiStore, s => s.emojiPicker)
  if (!st) return null
  return <PickerPanel key={`${st.mode}:${st.messageId ?? ''}`} mode={st.mode} messageId={st.messageId} anchor={st.anchor} />
}

function PickerPanel({ mode, messageId, anchor }: { mode: 'compose' | 'react'; messageId?: string; anchor?: { x: number; y: number; w: number; h: number } }) {
  const { t } = useI18n()
  const mobile = useIsMobile()
  const { ready, custom, recent, skin } = useChatEmoji()
  const appName = useStore(siteConfigStore, s => s.appName)
  const [q, setQ] = useState('')
  const [skinOpen, setSkinOpen] = useState(false)
  const [active, setActive] = useState<{ sec: string; item: UiEmojiItem } | null>(null)
  const [tab, setTab] = useState<EmojiCategoryKey>('recent')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const gridRefs = useRef<Record<string, UiEmojiGridHandle | null>>({})
  const secRefs = useRef<Record<string, HTMLElement | null>>({})
  const opener = useRef<Element | null>(typeof document !== 'undefined' ? document.activeElement : null)
  const cols = mobile ? 8 : 9

  // 리액션 대상 이름
  const targetName = useStore(chatStore, (s) => {
    if (mode !== 'react' || !messageId) return ''
    const m = s.messages.find(x => x.id === messageId) || s.threadMessages.find(x => x.id === messageId)
    return m?.sender?.display_name || m?.sender?.username || ''
  })

  const customItem = (c: CustomEmoji): UiEmojiItem => ({ key: `:${c.name}:`, imageUrl: c.url, label: `:${c.name}:`, custom: true, animated: !!c.animated })
  const uniItem = (glyph: string): UiEmojiItem => {
    const e = emojiEntry(glyph)
    return { key: e?.glyph ?? glyph, glyph: applySkin(glyph, skin), label: e ? `:${e.name}: ${e.label}` : glyph }
  }

  const sections: Section[] = useMemo(() => {
    const query = q.trim()
    if (query) {
      const hits = searchEmoji(query)
      if (!hits.length) return []
      return [{ key: 'search', title: t('chat.compose.emoji.results', { n: hits.length }), items: hits.map(h => (h.kind === 'custom' ? customItem(h.custom) : uniItem(h.entry.glyph))) }]
    }
    const out: Section[] = []
    const rec = (recent.length ? recent : DEFAULT_FREQUENT).map((k) => {
      const name = parseCustomToken(k)
      if (name) { const c = custom.find(x => x.name === name); return c ? customItem(c) : null }
      return uniItem(k)
    }).filter((x): x is UiEmojiItem => !!x)
    out.push({ key: 'recent', cat: 'recent', title: t('chat.compose.emoji.cat.recent'), items: rec })
    if (custom.length) out.push({ key: 'custom', cat: 'custom', title: t('chat.compose.emoji.customTitle', { name: appName || t('chat.compose.ac.workspace'), n: custom.length }), items: custom.map(customItem) })
    if (ready) {
      for (const c of EMOJI_CATEGORIES) {
        if (!c.groups.length) continue
        out.push({ key: c.key, cat: c.key, title: t(`chat.compose.emoji.cat.${c.key}`), items: emojisInCategory(c.key).map(e => uniItem(e.glyph)) })
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, ready, custom, recent, skin, appName, t])

  const searching = !!q.trim()
  const none = searching && sections.length === 0
  const preview = active?.item ?? sections[0]?.items[0] ?? null

  // 처음 — 검색칸 포커스(모바일은 키보드가 시트를 가리니 하지 않는다)

  function close(restore = true) {
    setEmojiPicker(null)
    if (restore && opener.current instanceof HTMLElement) { try { opener.current.focus() } catch { /* 사라졌으면 그만 */ } }
  }
  // 바깥 누르기 · Esc
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = rootRef.current
      const tg = e.target as Element | null
      // 여는 버튼(data-emoji-toggle)은 자기 클릭으로 닫는다 — 여기서 닫으면 곧바로 다시 열린다
      if (el && !el.contains(tg) && !tg?.closest?.('[data-emoji-toggle]')) close(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  function pick(item: UiEmojiItem) {
    const base = item.key
    const value = item.custom ? base : (item.glyph ?? base)
    pushChatEmojiRecent(base)
    if (mode === 'react') { if (messageId) toggleReaction(messageId, value); close() }
    else {
      const ins = _composeInsert
      close()
      ins?.(item.custom ? `${value} ` : value)
    }
  }

  function onKey(e: ReactKeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation()
      if (skinOpen) setSkinOpen(false)
      else close()
    }
  }
  function onSearchKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' && sections[0]) { e.preventDefault(); gridRefs.current[sections[0].key]?.focus(0) }
    else if (e.key === 'Enter' && sections[0]?.items[0]) { e.preventDefault(); pick(active?.item ?? sections[0].items[0]) }
  }
  function onExit(i: number, dir: 'up' | 'down', col: number) {
    if (dir === 'up') {
      if (i === 0) { searchRef.current?.focus(); return }
      const prev = sections[i - 1]
      const lastRow = Math.floor((prev.items.length - 1) / cols) * cols
      gridRefs.current[prev.key]?.focus(Math.min(prev.items.length - 1, lastRow + col))
    } else if (sections[i + 1]) gridRefs.current[sections[i + 1].key]?.focus(col)
  }

  // 탭 — 그 섹션으로 스크롤 / 스크롤하면 탭 표시가 따라온다
  function goTab(key: EmojiCategoryKey) {
    setQ('')
    setTab(key)
    requestAnimationFrame(() => {
      const box = scrollRef.current, el = secRefs.current[key]
      if (box && el) box.scrollTop = el.offsetTop - box.offsetTop
    })
  }
  function onScroll() {
    if (searching) return
    const box = scrollRef.current
    if (!box) return
    let cur: EmojiCategoryKey = 'recent'
    for (const s of sections) {
      const el = secRefs.current[s.key]
      if (el && s.cat && el.offsetTop - box.offsetTop <= box.scrollTop + 8) cur = s.cat
    }
    if (cur !== tab) setTab(cur)
  }

  // 자리(데스크톱)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (mobile) return
    const place = () => {
      const { vw, vh } = viewportCss()
      const r = anchor ? toCssRect({ left: anchor.x, top: anchor.y, width: anchor.w, height: anchor.h }) : null
      setPos(placePicker(r ? { x: r.left, y: r.top, w: r.width, h: r.height } : undefined, vw, vh))
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor, mobile])

  // 자리를 잡아 보이게 된 뒤에 검색칸으로(visibility:hidden 인 동안은 focus 가 먹지 않는다)
  const placed = !!pos
  useEffect(() => { if (!mobile && placed) searchRef.current?.focus() }, [mobile, placed])

  const skinGlyph = (i: number) => (i ? '👍' + SKIN_MODIFIERS[i - 1] : '👍')
  const title = mode === 'react' ? t('chat.compose.emoji.reactTitle') : t('chat.compose.emoji.title')

  const panel = (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={title}
      onKeyDown={onKey}
      className={cn(
        'flex flex-col overflow-hidden border-border bg-popover text-foreground shadow-xl',
        mobile ? 'fixed inset-x-0 bottom-0 z-modal rounded-t-2xl border-t' : 'fixed z-overlay rounded-lg border',
      )}
      style={mobile
        ? { height: `min(${PICKER_SHEET_H}px, 85dvh)`, paddingBottom: 'env(safe-area-inset-bottom)' }
        : { width: PICKER_W, height: PICKER_H, left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {mobile && <span aria-hidden="true" className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/40" />}
      {mode === 'react' && (
        <p className="px-3 pt-2.5 text-[12px] font-semibold text-muted-foreground">
          {targetName ? t('chat.compose.emoji.reactFor', { name: targetName }) : t('chat.compose.emoji.reactTitle')}
        </p>
      )}
      <div className="flex items-center gap-2 p-2.5">
        <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md bg-muted px-2.5 text-[14px] focus-within:ring-2 focus-within:ring-ring">
          <UiIcon name="search" className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-label={t('chat.compose.emoji.searchAria')}
            placeholder={t('chat.compose.emoji.searchPh')}
            value={q}
            onChange={e => { setQ(e.target.value); setActive(null) }}
            onKeyDown={onSearchKey}
            className="min-w-0 flex-1 bg-transparent outline-hidden placeholder:text-muted-foreground"
          />
          {q && (
            <button type="button" aria-label={t('chat.compose.emoji.clear')} className="rounded text-muted-foreground hover:text-foreground" onClick={() => { setQ(''); searchRef.current?.focus() }}>
              <UiIcon name="close" className="h-4 w-4" />
            </button>
          )}
        </label>
        <button
          type="button"
          aria-label={t('chat.compose.emoji.skinPick')}
          aria-expanded={skinOpen}
          className={cn('flex shrink-0 items-center justify-center rounded-md text-[20px] hover:bg-overlay-hover', mobile ? 'h-11 w-11' : 'h-9 w-9', skinOpen ? 'bg-overlay-selected' : '')}
          onClick={() => setSkinOpen(v => !v)}
        >{skinGlyph(skin)}</button>
      </div>
      {skinOpen && (
        <SkinRadios
          value={skin}
          mobile={mobile}
          labels={SKIN_LABEL_KEYS.map(k => t(`chat.compose.emoji.${k}`))}
          glyph={skinGlyph}
          onPick={(i) => { setChatEmojiSkin(i); setSkinOpen(false) }}
          ariaLabel={t('chat.compose.emoji.skin')}
        />
      )}
      <div role="tablist" aria-label={t('chat.compose.emoji.cats')} className="flex shrink-0 items-center justify-between border-b border-border px-2 pb-1.5">
        {EMOJI_CATEGORIES.filter(c => c.key !== 'custom' || custom.length).map((c) => {
          const on = !searching && tab === c.key
          const label = c.key === 'custom' ? (appName || t('chat.compose.emoji.cat.custom')) : t(`chat.compose.emoji.cat.${c.key}`)
          return (
            <button
              key={c.key}
              type="button"
              role="tab"
              aria-selected={on}
              aria-label={label}
              title={label}
              className={cn('flex items-center justify-center rounded-md text-[17px] hover:bg-overlay-hover', mobile ? 'h-11 w-9' : 'h-8 w-8', on ? 'bg-overlay-selected' : 'opacity-70 hover:opacity-100')}
              onClick={() => goTab(c.key)}
            >
              {c.key === 'custom' && custom[0] ? <img src={custom[0].url} alt="" className="h-5 w-5 object-contain" /> : <span aria-hidden="true">{c.glyph}</span>}
            </button>
          )
        })}
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pt-2" onScroll={onScroll}>
        {none && (
          <div className="flex h-full flex-col items-center justify-center gap-2 pb-6 text-center">
            <span aria-hidden="true" className="text-3xl">🔍</span>
            <p className="text-[15px] font-semibold">{t('chat.compose.emoji.noneTitle', { q: q.trim() })}</p>
            <p className="text-[13px] text-muted-foreground">{t('chat.compose.emoji.noneHint')}</p>
          </div>
        )}
        {!none && !ready && !searching && sections.length <= 2 && (
          <p className="px-1 py-2 text-[12px] text-muted-foreground" aria-live="polite">{t('chat.compose.emoji.loading')}</p>
        )}
        {sections.map((s, i) => (
          <section key={s.key} ref={(el) => { secRefs.current[s.key] = el }} aria-label={s.title}>
            <p className="px-1 pb-1 pt-1 text-[12px] font-semibold text-muted-foreground">{s.title}</p>
            <UiEmojiGrid
              ariaLabel={s.title}
              items={s.items}
              columns={cols}
              size={mobile ? 'touch' : 'md'}
              className="pb-2"
              activeKey={active?.sec === s.key ? active.item.key : null}
              onActive={(it) => { if (it) setActive({ sec: s.key, item: it }) }}
              onPick={it => pick(it)}
              onExit={(d, col) => onExit(i, d, col)}
              handleRef={(h) => { gridRefs.current[s.key] = h }}
            />
          </section>
        ))}
      </div>
      {!mobile && (
        <div className="flex h-12 shrink-0 items-center gap-3 border-t border-border bg-card px-3">
          {preview && (
            <>
              <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center text-[28px] leading-none">
                {preview.imageUrl ? <img src={preview.imageUrl} alt="" className="h-7 w-7 object-contain" /> : preview.glyph}
              </span>
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate font-mono text-[13px] font-semibold">{previewName(preview)}</p>
                <p className="truncate text-[12px] text-muted-foreground">{previewDesc(preview, active?.sec ?? sections[0]?.key, sections, skin, t, appName)}</p>
              </div>
            </>
          )}
          <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">↑↓←→ · Enter</span>
        </div>
      )}
    </div>
  )

  return createPortal(
    mobile
      ? <><div aria-hidden="true" className="fixed inset-0 z-modal bg-black/50" onMouseDown={() => close(false)} />{panel}</>
      : panel,
    document.body,
  )
}

function previewName(it: UiEmojiItem): string {
  if (it.custom) return it.key
  const e = emojiEntry(it.key)
  return e ? `:${e.name}:` : it.key
}
function previewDesc(it: UiEmojiItem, secKey: string | undefined, sections: Section[], skin: number, t: (k: string, p?: Record<string, unknown>) => string, appName: string): string {
  const sec = sections.find(s => s.key === secKey)
  const secName = sec?.key === 'search' ? '' : sec?.title ?? ''
  if (it.custom) return [appName || t('chat.compose.ac.workspace'), t('chat.compose.ac.custom'), it.animated ? 'GIF' : ''].filter(Boolean).join(' · ')
  const e = emojiEntry(it.key)
  const parts = [e?.label ?? '', secName]
  if (e?.skins && skin) parts.push(t(`chat.compose.emoji.skin${skin}`))
  return parts.filter(Boolean).join(' · ')
}

function SkinRadios({ value, onPick, labels, glyph, ariaLabel, mobile }: {
  value: number; onPick: (i: number) => void; labels: string[]; glyph: (i: number) => string; ariaLabel: string; mobile: boolean
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  useEffect(() => { refs.current[value]?.focus() }, [value])
  function onKey(e: ReactKeyboardEvent, i: number) {
    let j = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % 6
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i + 5) % 6
    else if (e.key === 'Home') j = 0
    else if (e.key === 'End') j = 5
    if (j >= 0) { e.preventDefault(); refs.current[j]?.focus() }
  }
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="absolute right-2.5 z-10 flex gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-lg" style={{ top: mobile ? 64 : 52 }}>
      {labels.map((l, i) => (
        <button
          key={i}
          ref={(el) => { refs.current[i] = el }}
          type="button"
          role="radio"
          aria-checked={i === value}
          aria-label={l}
          tabIndex={i === value ? 0 : -1}
          className={cn('flex items-center justify-center rounded-md text-[20px] hover:bg-overlay-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring', mobile ? 'h-11 w-11' : 'h-8 w-8', i === value ? 'bg-overlay-selected' : '')}
          onKeyDown={e => onKey(e, i)}
          onClick={() => onPick(i)}
        >{glyph(i)}</button>
      ))}
    </div>
  )
}

export default ChatEmojiPicker
