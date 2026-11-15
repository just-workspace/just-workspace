/**
 * 채널 스레드 목록 — 오른쪽 자리 400(handover-22 "스레드 목록" · 시안 Side22 threads / threads-arch / threads-empty · Chat22 #threads*
 * · Mob22 #m-threads 전체 화면). 여는 곳: 헤더 스레드 버튼 → useChatUi.setThreadListOpen(true) (자리 배치는 SHELL).
 *
 * 머리 48+1: (모바일 ‹ 44) threads 20 · "스레드 · #채널" 16/600 · 닫기 32.
 * 세그먼트 줄: 활성 N / 보관됨(grow) + "최근 활동순" 12 muted.
 * 행 카드(rounded-lg 1px bg-card p-3, 호버 bg-overlay-hover): 안 읽음 점 8 danger · 이름 15(안 읽음 600 / 아니면 500, 이름 없으면 “원문 첫 40자” 기울임)
 *   · 보관됨 배지 11 · 팔로우 bell(누르면 토글 — 팔로우 중 primary, 아니면 호버·포커스 때만 muted, 터치는 늘)
 *   → 마지막 답글 한 줄 13 muted → 참여 아바타 20 겹침(-6, ring 2 card) · "답글 N개"(600 foreground) · 시각 12.
 * 아래 줄 44: clock 14 · "활동이 없으면 자동 보관" · UiSelect sm(1시간·24시간·3일·1주) — MANAGE_THREADS 없으면 잠김(툴팁 이유).
 * 보관 탭: 목록 아래 안내 한 줄(archive 14). 빈 상태 = 아이콘 원 48 + 15/600 + 13 설명. 불러오는 중 = 스켈레톤 4.
 * 행 누르기 = 기존 openThread(원문은 목록 응답의 root 로 채운다). 카드 전체가 버튼이고 bell 은 그 위에 따로(겹친 버튼 없음).
 */
import { useEffect } from 'react'
import { useStore } from 'zustand'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { useIsMobile } from '~/composables/useIsMobile'
import { addToast } from '~/composables/useToast'
import { chatStore, getDMDisplayName, openThread, selectSelectedChannel } from '~/composables/useChat'
import { setThreadListOpen, initialOf } from '~/composables/useChatUi'
import { canInChannel, loadMyChannelPerms, PERM, useChatRoles } from '~/composables/useChatRoles'
import { THREAD_AUTO_ARCHIVE, type ThreadAutoArchive, type ThreadListItem } from '~/composables/chatApi22'
import {
  AUTO_ARCHIVE_LABEL, changeAutoArchive, ensureThreadListSubscribed, isThreadArchived, loadMoreThreads, loadThreads,
  plainLine, setThreadTab, threadAgo, threadTitle, toggleThreadRowFollow, useThreadList, type ThreadTab,
} from '~/composables/useChatThreadList'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiSegment } from '~/components/ui/Segment'
import { UiSelect } from '~/components/ui/Select'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiTooltip } from '~/components/ui/Tooltip'

/** 채널 이름 표시(#이름 · 비공개는 이름 · DM 은 상대) */
function useChannelLabel(): { id: string | null; label: string } {
  const ch = useStore(chatStore, s => selectSelectedChannel(s))
  useStore(chatStore, s => s.allUsers)
  if (!ch) return { id: null, label: '' }
  return { id: ch.id, label: ch.type === 'dm' ? getDMDisplayName(ch) : ch.type === 'private' ? ch.name : `#${ch.name}` }
}

export interface ChatThreadRowProps {
  item: ThreadListItem
  /** 보관 탭 — 배지 */
  archivedTab: boolean
  mobile: boolean
  onOpen: (item: ThreadListItem) => void
  onToggleFollow: (item: ThreadListItem) => void
}

/** 스레드 행 카드 */
export function ChatThreadRow({ item, archivedTab, mobile, onOpen, onToggleFollow }: ChatThreadRowProps) {
  const { t } = useI18n()
  const title = threadTitle(item.thread, item.root)
  const archived = archivedTab || isThreadArchived(item)
  const n = item.thread?.reply_count ?? item.root?.reply_count ?? 0
  const lr = item.last_reply
  const lastName = lr?.sender ? (lr.sender.display_name || lr.sender.username) : ''
  const lastLine = lr ? `${lastName ? `${lastName}: ` : ''}${plainLine(lr.content) || t('chat.right.threads.attachment')}` : t('chat.right.threads.noReplies')
  const at = threadAgo(item.thread?.last_reply_at || lr?.created_at || item.root?.created_at)
  const followLabel = item.followed ? t('chat.right.threads.unfollow') : t('chat.right.threads.follow')
  return (
    <li className="group relative flex flex-col gap-1 rounded-lg border border-border bg-card p-3 hover:bg-overlay-hover">
      {/* 카드 전체 = 열기 버튼(아래 bell 은 그 위에 따로) */}
      <button
        type="button"
        aria-label={t('chat.right.threads.open', { name: title.text })}
        className="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => onOpen(item)}
      />
      <div className="pointer-events-none relative flex items-center gap-2">
        {item.unread && <span aria-label={t('chat.right.threads.unread')} role="img" className="h-2 w-2 shrink-0 rounded-full bg-danger" />}
        <p className={cn('min-w-0 flex-1 truncate text-[15px]', item.unread ? 'font-semibold text-foreground' : 'font-medium', title.unnamed && 'italic')}>{title.text}</p>
        {archived && <span className="shrink-0 rounded-sm bg-muted px-1.5 text-[11px] font-medium text-muted-foreground">{t('chat.right.threads.archivedBadge')}</span>}
        <button
          type="button"
          aria-pressed={item.followed}
          aria-label={followLabel}
          title={followLabel}
          className={cn(
            'pointer-events-auto relative -my-1 -mr-1 flex shrink-0 items-center justify-center rounded-md outline-none hover:bg-overlay-hover focus-visible:ring-2 focus-visible:ring-ring',
            mobile ? 'h-11 w-11 -my-3 -mr-3' : 'h-6 w-6',
            item.followed ? 'text-primary' : cn('text-muted-foreground', !mobile && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'),
          )}
          onClick={(e) => { e.stopPropagation(); onToggleFollow(item) }}
        >
          <UiIcon name={item.followed ? 'bell' : 'bell-off'} className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="pointer-events-none relative truncate text-[13px] text-muted-foreground">{lastLine}</p>
      <div className="pointer-events-none relative flex items-center gap-2">
        {item.participants?.length > 0 && (
          <span className="flex -space-x-1.5" aria-hidden="true">
            {item.participants.slice(0, 5).map(p => (
              <span key={p.id} className="rounded-full ring-2 ring-card">
                <UiAvatar src={p.avatar_url} fallback={initialOf(p.display_name || p.username)} textSize={9} className="h-5 w-5" />
              </span>
            ))}
          </span>
        )}
        <span className="text-[12px] text-muted-foreground">
          <b className="font-semibold text-foreground">{t('chat.right.threads.repliesN', { n })}</b>{at ? ` · ${at}` : ''}
        </span>
      </div>
    </li>
  )
}

/** 스레드 목록(오른쪽 자리 400 / 모바일 전체 화면) */
export function ChatThreadList() {
  const { t } = useI18n()
  const mobile = useIsMobile()
  const { id: channelId, label } = useChannelLabel()
  const { tab, items, hasMore, loading, loadingMore, error, activeCount, autoArchive, channelId: listCh } = useThreadList()
  // 권한(r24): MANAGE_THREADS — 채널 권한을 아직 못 읽었으면 읽는다
  const canManage = useChatRoles(s => canInChannel(channelId, PERM.MANAGE_THREADS, s))
  useEffect(() => { if (channelId) void loadMyChannelPerms(channelId) }, [channelId])

  useEffect(() => {
    ensureThreadListSubscribed()
    if (channelId) void loadThreads(channelId, 'active')
  }, [channelId])

  function close() { setThreadListOpen(false) }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="dialog"]')) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  async function onOpen(it: ThreadListItem) {
    close()
    const p = openThread(it.root.id)
    // 타임라인에 없는 오래된 원문 — 목록 응답의 root 로 패널 위 원문을 채운다
    if (!chatStore.getState().threadParent) chatStore.setState({ threadParent: { ...it.root, thread: it.thread } })
    await p
  }
  async function onToggleFollow(it: ThreadListItem) {
    try { await toggleThreadRowFollow(it.root.id) }
    catch (e: any) { addToast('error', e?.data?.detail?.message || e?.data?.detail || t('error.genericError')) }
  }
  async function onAutoArchive(v: string | number | null) {
    const n = Number(v) as ThreadAutoArchive
    if (!(THREAD_AUTO_ARCHIVE as readonly number[]).includes(n)) return
    try { await changeAutoArchive(n) }
    catch (e: any) { addToast('error', e?.data?.detail?.message || e?.data?.detail || t('error.genericError')) }
  }

  const archivedTab = tab === 'archived'
  const shown = listCh === channelId ? items : []
  const period = t(`chat.right.threads.opt.${AUTO_ARCHIVE_LABEL[autoArchive]}`)
  const tabs = [
    // 개수는 활성 탭을 읽었을 때 정해진다(더 있으면 "25+")
    { value: 'active', label: activeCount == null ? t('chat.right.threads.active') : t('chat.right.threads.activeN', { n: hasMore && !archivedTab ? `${activeCount}+` : activeCount }) },
    { value: 'archived', label: t('chat.right.threads.archived') },
  ]
  const archOpts = THREAD_AUTO_ARCHIVE.map(m => ({ value: m, label: t(`chat.right.threads.opt.${AUTO_ARCHIVE_LABEL[m]}`) }))
  const select = (
    <UiSelect
      aria-label={t('chat.right.threads.autoArchiveLabel')}
      size="sm"
      options={archOpts}
      modelValue={autoArchive}
      disabled={!canManage}
      onUpdateModelValue={(v) => { void onAutoArchive(v) }}
      className="w-24 shrink-0"
    />
  )

  return (
    <aside aria-label={t('chat.right.threads.title', { channel: label })} className="flex h-full w-full shrink-0 flex-col border-border bg-background md:w-[400px] md:border-l">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 max-md:h-14 max-md:px-1">
        {mobile && <UiIconButton label={t('chat.right.back')} icon="chevron-left" size="lg" noTooltip onClick={close} />}
        <UiIcon name="threads" className="h-5 w-5 shrink-0 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-[16px] font-semibold">{t('chat.right.threads.title', { channel: label })}</h2>
        {!mobile && <UiIconButton label={t('common.close')} icon="close" keys={['Esc']} onClick={close} />}
      </header>

      <div className="flex shrink-0 items-center gap-2 px-3 py-2.5">
        <UiSegment
          ariaLabel={t('chat.right.threads.tabsLabel')}
          size={mobile ? 'lg' : 'sm'}
          grow
          className="max-w-[240px]"
          items={tabs}
          modelValue={tab}
          onUpdateModelValue={(v) => setThreadTab(v as ThreadTab)}
        />
        <span className="flex-1" />
        <span className="shrink-0 text-[12px] text-muted-foreground">{t('chat.right.threads.sortHint')}</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3">
        {loading && shown.length === 0
          ? (
            <div aria-busy="true" className="flex flex-col gap-4 px-2 pt-2">
              {[1, 2, 3, 4].map(k => (
                <div key={k} className="flex gap-3">
                  <span className="h-8 w-8 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
                  <div className="flex flex-1 flex-col gap-2">
                    <span className="h-3 w-24 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
                    <span className="h-3 w-full animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
                  </div>
                </div>
              ))}
            </div>
          )
          : error && shown.length === 0
            ? (
              <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted"><UiIcon name="alert-circle" className="h-6 w-6 text-muted-foreground" /></span>
                <p className="text-[15px] font-semibold">{t('chat.right.threads.loadError')}</p>
                <p className="text-[13px] text-muted-foreground">{error}</p>
                <button type="button" className="mt-1 h-8 rounded-md px-3 text-[13px] font-semibold text-primary hover:bg-overlay-hover max-md:h-11" onClick={() => { if (channelId) void loadThreads(channelId, tab) }}>{t('chat.right.retry')}</button>
              </div>
            )
            : shown.length === 0
              ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted"><UiIcon name={archivedTab ? 'archive' : 'threads'} className="h-6 w-6 text-muted-foreground" /></span>
                  <p className="text-[15px] font-semibold">{archivedTab ? t('chat.right.threads.archEmptyTitle') : t('chat.right.threads.emptyTitle')}</p>
                  <p className="text-[13px] leading-relaxed text-muted-foreground">{archivedTab ? t('chat.right.threads.archEmptyDesc', { period }) : t('chat.right.threads.emptyDesc', { period })}</p>
                </div>
              )
              : (
                <ul className="flex flex-col gap-1">
                  {shown.map(it => (
                    <ChatThreadRow key={it.root.id} item={it} archivedTab={archivedTab} mobile={mobile} onOpen={(x) => { void onOpen(x) }} onToggleFollow={(x) => { void onToggleFollow(x) }} />
                  ))}
                </ul>
              )}
        {hasMore && shown.length > 0 && (
          <button type="button" disabled={loadingMore} className="mx-auto mt-2 h-8 rounded-md px-3 text-[13px] font-semibold text-primary hover:bg-overlay-hover disabled:opacity-50 max-md:h-11" onClick={() => { void loadMoreThreads() }}>
            {t('chat.right.threads.more')}
          </button>
        )}
        {archivedTab && (
          <p className="flex items-start gap-1.5 px-2 pt-2 text-[12px] text-muted-foreground">
            <UiIcon name="archive" className="mt-px h-3.5 w-3.5 shrink-0" />{t('chat.right.threads.archNote')}
          </p>
        )}
      </div>

      <div className="flex h-11 shrink-0 items-center gap-2 border-t border-border px-3 text-[12px] text-muted-foreground max-md:h-14">
        <UiIcon name="clock" className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">{t('chat.right.threads.autoArchive')}</span>
        {canManage
          ? select
          : <UiTooltip text={t('chat.right.threads.autoArchiveLocked')}><span className="inline-flex">{select}</span></UiTooltip>}
      </div>
    </aside>
  )
}

export default ChatThreadList
