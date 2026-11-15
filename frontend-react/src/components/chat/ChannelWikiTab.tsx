/**
 * 채널 탭 — 위키. Vue 원본: frontend/components/chat/ChannelWikiTab.vue (ChatChannelWikiTab)
 *  왼쪽 300 = 머리 h-11 "연결된 위키 · {스페이스}" + [+](이 채널에 새 페이지) · 페이지 행 h-12(제목 13 · 작성자 · 날짜 11 muted), 고른 행 bg-accent + 600.
 *  오른쪽 = 읽기 전용 본문(px-10 py-8, 최대 680): 제목 2xl bold + [위키에서 열기](outline xs) · 작성자 · 시각 mono · v버전 · "채널 탭에서는 읽기만".
 * [+]: 누르면 pressed, 목록 위에 UiInput "새 페이지 제목" + 안내 11 muted
 *  ("Enter 만들고 위키 편집으로 · Esc 취소 · {스페이스} 맨 아래에 생깁니다", 키 이름 mono), 목록은 border-t pt-1 로 갈린다.
 *  Enter = 그 스페이스 최상위 맨 아래(sort_order 최대+1)에 만들고 위키 편집으로. Esc 또는 [+] 다시 = 취소.
 * 연결이 없으면 빈 상태 + (관리자) 탭 관리. 모바일(<md)은 목록 → 본문(‹ 목록으로) 한 단계씩,
 *  모바일 [+] 도 같은 입력 줄을 목록 맨 위에 연다.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import DOMPurify from 'dompurify'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { navigateTo } from '~/lib/router'
import { addToast } from '~/composables/useToast'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiButton } from '~/components/ui/Button'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiIcon } from '~/components/ui/Icon'
import { UiInput } from '~/components/ui/Input'

export interface ChatChannelWikiTabProps {
  /** 연결된 스페이스(없으면 null) */
  space: { id: string; name: string } | null
  /** 예전 페이지 연결 — 처음 고를 페이지 */
  initialPageId?: string | null
  /** 탭 관리 권한 */
  canManage: boolean
  /** 탭 관리 열기 */
  onManage?: () => void
  /** 페이지를 만들었다(탭 숫자 갱신) */
  onChanged?: () => void
}

interface PageRow {
  id: string
  title: string
  parent_id: string | null
  sort_order: number
  version: number
  author?: { username?: string | null; display_name?: string | null }
  updated_at: string
}
interface PageDetail { id: string; title: string; content?: string; version?: number; updated_at?: string; author?: { display_name?: string | null; username?: string | null } }

const p2 = (n: number) => String(n).padStart(2, '0')
const md = (iso: string) => { const d = new Date(iso); return isNaN(d.getTime()) ? '' : `${p2(d.getMonth() + 1)}/${p2(d.getDate())}` }
const mdhm = (iso: string) => { const d = new Date(iso); return isNaN(d.getTime()) ? '' : `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}` }
const who = (a?: { display_name?: string | null; username?: string | null }) => a?.display_name || a?.username || ''
function slugOf(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-|-$/g, '') || 'untitled'
}

/** 채널 위키 탭 — 연결된 스페이스의 페이지 목록 + 읽기 전용 본문 */
export function ChatChannelWikiTab({ space, initialPageId, canManage, onManage, onChanged }: ChatChannelWikiTabProps) {
  const { t } = useI18n()
  const spaceId = space?.id

  const [pages, setPages] = useState<PageRow[]>([])
  const [listState, setListState] = useState<'loading' | 'ok' | 'denied' | 'fail'>('loading')
  const [sel, setSel] = useState<string | null>(initialPageId ?? null)
  const [mobileRead, setMobileRead] = useState(false)

  const loadList = useCallback(async () => {
    if (!spaceId) return
    setListState('loading')
    try {
      const r = await $fetch<PageRow[]>(`/api/wiki/spaces/${encodeURIComponent(spaceId)}/pages`)
      setPages(r)
      setListState('ok')
    } catch (e: any) {
      setListState((e?.status ?? e?.statusCode) === 403 ? 'denied' : 'fail')
    }
  }, [spaceId])
  useEffect(() => { void loadList() }, [loadList])

  // 최근 수정 순(시안 목록)
  const sorted = useMemo(() => [...pages].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')), [pages])
  const current = sel && pages.some(p => p.id === sel) ? sel : sorted[0]?.id ?? null

  // ── 본문 ──
  const [page, setPage] = useState<PageDetail | null>(null)
  const [html, setHtml] = useState('')
  const [pageState, setPageState] = useState<'idle' | 'loading' | 'ok' | 'fail'>('idle')
  const loadPage = useCallback(async (id: string) => {
    setPageState('loading')
    try {
      const p = await $fetch<PageDetail>(`/api/wiki/pages/${encodeURIComponent(id)}`)
      setPage(p)
      setHtml(DOMPurify.sanitize(p.content || ''))
      setPageState('ok')
    } catch { setPageState('fail') }
  }, [])
  useEffect(() => { if (current) void loadPage(current); else { setPage(null); setPageState('idle') } }, [current, loadPage])

  // ── 새 페이지 ──
  const [drafting, setDrafting] = useState(false)
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState(false)
  function cancelDraft() { setDrafting(false); setDraft('') }
  async function createPage() {
    const title = draft.trim()
    if (!title || !spaceId || creating) return
    setCreating(true)
    try {
      const top = pages.filter(p => !p.parent_id)
      const sort = top.length ? Math.max(...top.map(p => p.sort_order)) + 1 : 0
      const created = await $fetch<{ id: string }>(`/api/wiki/spaces/${encodeURIComponent(spaceId)}/pages`, {
        method: 'POST', body: { title, slug: slugOf(title), sort_order: sort },
      })
      setDraft(''); setDrafting(false)
      onChanged?.()
      void navigateTo(`/wiki?space=${encodeURIComponent(spaceId)}&page=${encodeURIComponent(created.id)}`)
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('chat.tabs.newPageFailed'))
    } finally { setCreating(false) }
  }

  if (!space) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <UiEmptyState
          variant="panel"
          icon="book-open"
          title={t('chat.tabs.noWikiSpace')}
          description={t('chat.tabs.noWikiSpaceHint')}
          actionLabel={canManage ? t('chat.tabs.manage') : undefined}
          onAction={() => onManage?.()}
        />
      </div>
    )
  }

  const wikiHref = current ? `/wiki?space=${encodeURIComponent(space.id)}&page=${encodeURIComponent(current)}` : `/wiki?space=${encodeURIComponent(space.id)}`

  return (
    <div className="flex min-h-0 flex-1">
      <div className={cn('flex w-full shrink-0 flex-col overflow-y-auto border-r border-border md:w-[300px]', mobileRead && 'hidden md:flex')}>
        <div className="flex h-11 shrink-0 items-center gap-2 px-3">
          <span className="min-w-0 truncate text-xs font-semibold text-muted-foreground">{t('chat.tabs.wikiHeader', { space: space.name })}</span>
          <span className="flex-1" />
          <UiIconButton icon="plus" label={t('chat.tabs.newPageHere')} pressed={drafting} onClick={() => { if (drafting) cancelDraft(); else setDrafting(true) }} />
        </div>
        {drafting && (
          <form className="flex flex-col gap-1 px-2 pb-2" onSubmit={(e) => { e.preventDefault(); void createPage() }}>
            <UiInput
              autoFocus
              modelValue={draft}
              onUpdateModelValue={setDraft}
              placeholder={t('chat.tabs.newPageTitle')}
              aria-label={t('chat.tabs.newPageTitle')}
              disabled={creating}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancelDraft() } }}
            />
            <p className="px-1 text-[11px] text-muted-foreground">
              <span className="font-mono">Enter</span> {t('chat.tabs.newPageEnter')} · <span className="font-mono">Esc</span> {t('chat.tabs.newPageEsc')} · {t('chat.tabs.newPageWhere', { space: space.name })}
            </p>
          </form>
        )}
        <div className={cn(drafting && 'border-t border-border pt-1')}>
          {listState === 'loading'
            ? <UiSkeleton preset="list" rows={5} className="px-3" />
            : listState === 'denied'
              ? <UiEmptyState variant="inline" icon="lock" title={t('chat.tabs.wikiSpaceDenied')} />
              : listState === 'fail'
                ? <UiErrorTile placement="panel" title={t('chat.tabs.listFailed')} onRetry={() => { void loadList() }} />
                : !sorted.length
                  ? <UiEmptyState variant="inline" icon="file-text" title={t('chat.tabs.noPages')} />
                  : (
                    <ul aria-label={t('chat.tabs.pageList')}>
                      {sorted.map(p => {
                        const on = p.id === current
                        return (
                          <li key={p.id}>
                            <button
                              type="button"
                              aria-current={on || undefined}
                              className={cn('mx-2 flex h-12 w-[calc(100%-1rem)] flex-col justify-center rounded-sm px-3 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', on ? 'bg-accent' : 'hover:bg-accent/50')}
                              onClick={() => { setSel(p.id); setMobileRead(true) }}
                            >
                              <span className={cn('w-full truncate text-[13px]', on && 'font-semibold')}>{p.title}</span>
                              <span className="text-[11px] text-muted-foreground">{[who(p.author), md(p.updated_at)].filter(Boolean).join(' · ')}</span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
        </div>
      </div>
      <article className={cn('min-w-0 flex-1 overflow-y-auto px-4 py-6 md:px-10 md:py-8', !mobileRead && 'hidden md:block')}>
        <div style={{ maxWidth: 680 }}>
          <button type="button" className="mb-3 inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground md:hidden" onClick={() => setMobileRead(false)}>
            <UiIcon name="chevron-left" className="h-3.5 w-3.5" />{t('chat.tabs.pageList')}
          </button>
          {pageState === 'loading'
            ? <UiSkeleton preset="text" rows={6} />
            : pageState === 'fail'
              ? <UiErrorTile placement="panel" title={t('chat.tabs.wikiFailed')} onRetry={() => { if (current) void loadPage(current) }} />
              : page && (
                <>
                  <div className="flex items-start gap-3">
                    <h1 className="flex-1 text-2xl font-bold tracking-tight">{page.title}</h1>
                    <UiButton variant="outline" size="xs" icon="external-link" onClick={() => { void navigateTo(wikiHref) }}>
                      {t('chat.tabs.openWiki')}
                    </UiButton>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {who(page.author)}{page.updated_at ? <> · <span className="font-mono">{mdhm(page.updated_at)}</span></> : null}
                    {page.version ? ` · v${page.version}` : ''} · {t('chat.tabs.wikiReadOnly')}
                  </p>
                  <div className="mt-6">
                    {html
                      ? <div className="wiki-body prose max-w-none break-words text-[15px] leading-[1.75] dark:prose-invert" dangerouslySetInnerHTML={{ __html: html }} />
                      : <UiEmptyState variant="inline" icon="file-text" title={t('wiki.emptyPage')} />}
                  </div>
                </>
              )}
        </div>
      </article>
    </div>
  )
}

export default ChatChannelWikiTab
