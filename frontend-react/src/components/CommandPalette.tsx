/**
 * Ctrl+K 전환기: 폭 640, 헤더 52(검색 아이콘 + "이동하거나 검색 — > 명령 · @ 사람 · # 채널" + Esc 키캡),
 * 첫 화면 = 최근 6(종류 혼합) + 명령 3. 입력 시 채널·사람·문서(모듈/설정)·명령 섹션 + 최하단 "전체 검색에서 '…' 찾기".
 * `>` 명령 모드 · `@` 사람(DM) · `#` 채널. 행 40, 선택 행 primary/13 + ↵ 키캡, 푸터 40(↑↓ 이동 · ↵ 열기 · Ctrl ↵ 새 탭).
 * 전체 검색은 기존 /api/search(통합 검색)를 사용한다 — 검색 전용 페이지가 아직 없어 결과를 팰릿 내부 "검색 결과" 섹션에 표시한다.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { navigateTo, useRouter } from '~/lib/router'
import { useRecents } from '~/composables/useRecents'
import { useCommands, type Command } from '~/composables/useCommands'
import { useNav } from '~/composables/useNav'
import { useChat } from '~/composables/useChat'
import { useSettingsNav } from '~/composables/useSettingsNav'
import { useAuth } from '~/composables/useAuth'
import { usePlatform } from '~/composables/usePlatform'
import { UiIcon } from '~/components/ui/Icon'
import { UiKeycap } from '~/components/ui/Keycap'
import { UiEmptyState } from '~/components/ui/EmptyState'

interface SearchResult { type: string; id: string; title: string; snippet: string; url: string }
interface Row { key: string; name: string; kind: string; icon: string; to?: string; run?: () => unknown; keys?: string[]; snippet?: string }
interface Section { title: string; rows: Row[] }

export interface CommandPaletteProps {
  /** 닫힘 시 호출(Esc·바깥 클릭·항목 실행) */
  onClose?: () => void
}

const TYPE_ICON: Record<string, string> = { post: 'clipboard-list', contact: 'user', message: 'chat', file: 'file-text', task: 'check-square', wiki: 'book-open', event: 'calendar' }

export function CommandPalette({ onClose }: CommandPaletteProps) {
  const emitClose = () => onClose?.()
  const { t } = useI18n()
  const router = useRouter()
  const { recent } = useRecents()
  const { primary: primaryCommands, search: searchCommands } = useCommands()
  const { home, flat: navItems } = useNav()
  const { channels, allUsers, openDM } = useChat()
  const { flat: settingsItems } = useSettingsNav('settings')
  const { user } = useAuth()
  const { isModuleEnabled } = usePlatform()

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 입력 글자를 드래그 선택하다 스크림에서 버튼을 놓으면 click 이 스크림에서 발생한다 — 이는 바깥 클릭으로 처리하지 않는다
  const downInside = useRef(false)
  // 지연 도착한 검색 응답이 최신 결과를 덮어쓰지 않도록 함(요청 순번)
  const searchSeq = useRef(0)

  const mode: 'default' | 'command' | 'person' | 'channel' =
    query.startsWith('>') ? 'command' : query.startsWith('@') ? 'person' : query.startsWith('#') ? 'channel' : 'default'
  const term = (mode === 'default' ? query : query.slice(1)).trim().toLowerCase()
  const match = (s: string | null | undefined) => !!s && s.toLowerCase().includes(term)

  const channelRows: Row[] = channels
    .filter(c => c.type !== 'dm' && (!term || match(c.name)))
    .slice(0, 6)
    .map(c => ({ key: `ch:${c.id}`, name: `#${c.name}`, kind: t('shell.palette.kindChannel'), icon: 'hash', to: `/chat?channel=${c.id}` }))
  const peopleRows: Row[] = allUsers
    .filter(u => u.username !== user?.username && (!term || match(u.display_name) || match(u.username)))
    .slice(0, 6)
    // 사람 = DM 열기: 채팅으로 이동한 후 useChat().openDM 호출(셸 연결부 — 채팅 내부는 별도 작업)
    .map(u => ({ key: `u:${u.username}`, name: u.display_name || u.username, kind: 'DM', icon: 'user', run: async () => { await navigateTo('/chat'); await openDM(u.id) } }))
  const placeRows: Row[] = (() => {
    const mods: Row[] = [home, ...navItems].filter(i => match(i.name)).map(i => ({ key: i.route, name: i.name, kind: t('shell.kind.module'), icon: i.icon || 'dot', to: i.route }))
    const sets: Row[] = settingsItems.filter(i => match(i.label) || i.keywords?.some(match)).map(i => ({ key: i.to, name: i.label, kind: t('shell.palette.kindSetting', { group: i.group }), icon: 'settings', to: i.to }))
    return [...mods, ...sets].slice(0, 6)
  })()
  const commandRows = (list: Command[]): Row[] => list.map(c => ({ key: `cmd:${c.id}`, name: c.label, kind: t('shell.palette.kindCommand'), icon: c.icon, run: c.run, keys: c.keys }))
  const searchRows: Row[] = results.map(r => ({ key: `s:${r.type}:${r.id}`, name: r.title, kind: t(`commandPalette.types.${r.type}`), icon: TYPE_ICON[r.type] || 'search', to: r.url, snippet: r.snippet }))

  const sections: Section[] = (() => {
    if (mode === 'command') return [{ title: t('shell.palette.secCommands'), rows: commandRows(searchCommands(term)) }]
    if (mode === 'person') return [{ title: t('shell.palette.secPeople'), rows: peopleRows }]
    if (mode === 'channel') return [{ title: t('shell.palette.secChannels'), rows: channelRows }]
    if (!term) {
      const r: Row[] = recent.slice(0, 6).map(x => ({ key: x.key, name: x.name, kind: x.kind, icon: x.icon, to: x.to }))
      return [
        ...(r.length ? [{ title: t('shell.palette.secRecent'), rows: r }] : []),
        { title: t('shell.palette.secCommands'), rows: commandRows(primaryCommands) },
      ]
    }
    const out: Section[] = []
    if (isModuleEnabled('chat') && channelRows.length) out.push({ title: t('shell.palette.secChannels'), rows: channelRows })
    if (isModuleEnabled('chat') && peopleRows.length) out.push({ title: t('shell.palette.secPeople'), rows: peopleRows })
    if (placeRows.length) out.push({ title: t('shell.palette.secPlaces'), rows: placeRows })
    const cmds = commandRows(searchCommands(term))
    if (cmds.length) out.push({ title: t('shell.palette.secCommands'), rows: cmds })
    if (searchRows.length) out.push({ title: t('shell.palette.secResults'), rows: searchRows })
    return out
  })()
  const flatRows = sections.flatMap(s => s.rows)
  const showSearchFooter = mode === 'default' && !!term

  // 디바운스 타이머·Enter 가 호출하는 검색은 현재 입력값을 참조한다
  const live = useRef({ mode, term })
  live.current = { mode, term }
  async function doSearch() {
    const { mode: m, term: q } = live.current
    const seq = ++searchSeq.current
    if (m !== 'default' || q.length < 1) { setResults([]); setLoading(false); return }
    setLoading(true)
    try {
      const data = await $fetch<{ results: SearchResult[]; total: number }>('/api/search', { params: { q, limit: 20 } })
      if (seq === searchSeq.current) setResults(data.results)
    } catch { if (seq === searchSeq.current) setResults([]) } finally { if (seq === searchSeq.current) setLoading(false) }
  }
  // watch(query) — 첫 실행 없음
  const firstQuery = useRef(true)
  useEffect(() => {
    if (firstQuery.current) { firstQuery.current = false; return }
    setActiveIndex(0)
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(doSearch, 300)
  }, [query])

  function open(row: Row, newTab = false) {
    if (row.run) { emitClose(); row.run(); return }
    if (!row.to) return
    emitClose()
    if (newTab) window.open(router.resolve(row.to).href, '_blank')
    else void router.push(row.to)
  }
  function scrollActive() {
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }))
  }
  function onKeydown(e: KeyboardEvent) {
    const len = flatRows.length
    if (e.key === 'ArrowDown' && len) { e.preventDefault(); setActiveIndex((activeIndex + 1) % len); scrollActive() }
    else if (e.key === 'ArrowUp' && len) { e.preventDefault(); setActiveIndex((activeIndex - 1 + len) % len); scrollActive() }
    else if (e.key === 'Enter') {
      // 한글 조합 중 Enter 는 글자 확정이므로 행을 열지 않는다. 버튼에 포커스가 있으면 해당 버튼의 클릭 처리에 위임한다
      if (e.nativeEvent.isComposing || (e.target instanceof HTMLButtonElement)) return
      e.preventDefault()
      const row = flatRows[activeIndex]
      if (row) open(row, e.ctrlKey || e.metaKey)
      else if (showSearchFooter) void doSearch()
    } else if (e.key === 'Escape') { emitClose() }
  }
  useEffect(() => {
    inputRef.current?.focus()
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current) }
  }, [])

  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-start justify-center bg-scrim px-4 pt-[12vh] sm:pt-24"
      onMouseDown={(e) => { downInside.current = e.target !== e.currentTarget }}
      onClick={(e) => {
        const dragged = downInside.current
        downInside.current = false
        if (e.target === e.currentTarget && !dragged) emitClose()
      }}
    >
      {/* 키 처리는 입력 칸이 아닌 대화상자에서 수행 — 행·"전체 검색" 버튼을 마우스로 클릭해 포커스가 이동해도 Esc·↑↓·Enter 가 동작한다 */}
      <div
        role="dialog"
        aria-label={t('shell.palette.dialogLabel')}
        className="flex max-h-[76dvh] w-full max-w-[640px] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
        onKeyDown={onKeydown}
      >
        {/* 헤더 52 */}
        <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-border px-4">
          <UiIcon name="search" className="h-[18px] w-[18px] shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('shell.palette.placeholder')}
            aria-label={t('shell.palette.inputLabel')}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-hidden placeholder:text-muted-foreground"
          />
          {loading
            ? <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-foreground" aria-hidden="true" />
            : <UiKeycap>Esc</UiKeycap>}
        </div>

        {/* 목록 */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-2">
          {flatRows.length ? (
            sections.map(s => (
              <section key={s.title}>
                <div className="px-4 pb-1 pt-1.5 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{s.title}</div>
                {s.rows.map(row => {
                  const on = flatRows.indexOf(row) === activeIndex
                  return (
                    <button
                      key={row.key}
                      type="button"
                      role="option"
                      aria-selected={on}
                      className={cn('mx-2 flex h-10 w-[calc(100%-16px)] items-center gap-3 rounded-sm px-2.5 text-left text-sm', on ? 'bg-primary/[0.13]' : 'hover:bg-accent/40')}
                      onClick={() => open(row)}
                      onMouseEnter={() => setActiveIndex(flatRows.indexOf(row))}
                    >
                      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-[6px] bg-muted text-muted-foreground">
                        {row.key.startsWith('cmd:')
                          ? <span className="font-mono text-xs font-bold">&gt;</span>
                          : <UiIcon name={row.icon} className="h-[13px] w-[13px]" strokeWidth={2.2} />}
                      </span>
                      <span className={cn('min-w-0 flex-1 truncate', on ? 'font-semibold text-foreground' : 'text-foreground')}>
                        {row.name}{row.snippet && <span className="ml-2 text-xs text-muted-foreground">{row.snippet}</span>}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{row.kind}</span>
                      {row.keys?.length
                        ? <span className="flex gap-0.5">{row.keys.map(k => <UiKeycap key={k}>{k}</UiKeycap>)}</span>
                        : on ? <UiKeycap>↵</UiKeycap> : null}
                    </button>
                  )
                })}
              </section>
            ))
          ) : (
            <UiEmptyState
              variant="panel"
              icon="search"
              title={term ? (loading ? t('shell.palette.searching') : t('commandPalette.noResults')) : t('shell.palette.emptyTitle')}
              description={term ? '' : t('shell.palette.emptyDesc')}
            />
          )}
          {/* 전체 검색 */}
          {showSearchFooter && (
            <button
              type="button"
              className="mx-2 mt-1 flex h-10 w-[calc(100%-16px)] items-center gap-3 rounded-sm border-t border-border px-2.5 text-left text-sm text-muted-foreground hover:bg-accent/40"
              onClick={() => { void doSearch(); inputRef.current?.focus() }}
            >
              <UiIcon name="search" className="h-3.5 w-3.5" />
              {t('shell.palette.searchAll', { term })}
              {results.length > 0 && <span className="ml-auto font-mono text-xs">{results.length}</span>}
            </button>
          )}
        </div>

        {/* 푸터 40 */}
        <div className="hidden h-10 shrink-0 items-center gap-3.5 border-t border-border px-4 text-xs text-muted-foreground sm:flex">
          <span>{t('shell.palette.footNavigate')}</span><span>{t('shell.palette.footOpen')}</span><span>{t('shell.palette.footNewTab')}</span>
          <span className="ml-auto">{t('shell.palette.modesHint')}</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export default CommandPalette
