/**
 * 사이드바 고정 항목의 모아보기 — 스레드 · 임시 저장 · 저장한 메시지. 대화 영역 자리에 뜬다.
 * 시안에는 빈 상태만 있고 목록 화면이 없어 목록 행(2줄, min-h-row-2) 규격으로 구성했다.
 * 표시 규칙: 새 답글 = 굵게, 개수는 글자로.
 */
import { useEffect } from 'react'
import { useStore } from 'zustand'
// class 를 이어 붙이기만 한다(tailwind-merge 없이 — 뒤에 온 클래스를 지우지 않는다)
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { authStore } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import { clearDraft, fetchSaved, fetchThreads, openThread, selectChannel, unsaveMessage, useChat } from '~/composables/useChat'
import { chatListTime, type ChatCollection } from '~/composables/useChatUi'
import { renderChatMarkdown } from '~/utils/chatMarkdown'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiIcon } from '~/components/ui/Icon'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiBadge } from '~/components/ui/Badge'
import { UiKeycap } from '~/components/ui/Keycap'
import { UiTrans } from '~/components/ui/Trans'

export interface ChatCollectionViewProps {
  /** threads(스레드) · drafts(임시 저장) · saved(저장한 메시지) */
  kind: ChatCollection
  /** 모바일 ‹ 뒤로 */
  onBack?: () => void
}

function oneLine(s: string) { return (s || '').replace(/\s+/g, ' ').trim() }

async function go(channelId: string, threadRootId?: string | null) {
  await selectChannel(channelId)
  if (threadRootId) void openThread(threadRootId)
}

/** 모아보기(스레드 · 임시 저장 · 저장한 메시지) */
export function ChatCollectionView({ kind, onBack }: ChatCollectionViewProps) {
  const { t } = useI18n()
  const myUsername = useStore(authStore, s => s.user?.username)
  const chat = useChat()
  const { threads, loadingThreads, drafts, savedMessages, loadingSaved, channels } = chat

  const title = { threads: t('chat.sidebar.threads'), drafts: t('chat.sidebar.drafts'), saved: t('chat.sidebar.saved') }[kind]

  function channelLabel(id: string, fallbackName?: string, type?: string): string {
    const c = channels.find(x => x.id === id)
    if (c) return c.type === 'dm' ? chat.getDMDisplayName(c) : `#${c.name}`
    if (fallbackName) return type === 'dm' ? fallbackName : `#${fallbackName}`
    return ''
  }

  const draftList = Object.values(drafts)
    .filter(d => d.content.trim())
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))

  const loading = (kind === 'threads' && loadingThreads && threads.length === 0)
    || (kind === 'saved' && loadingSaved && savedMessages.length === 0)
  const empty = !loading && (
    kind === 'threads' ? threads.length === 0
      : kind === 'drafts' ? draftList.length === 0
        : savedMessages.length === 0)

  async function onUnsave(id: string) {
    try { await unsaveMessage(id) } catch (e: any) { addToast('error', e?.data?.detail || t('error.genericError')) }
  }
  function onDiscard(channelId: string, parentId: string | null) { void clearDraft(channelId, parentId) }

  useEffect(() => {
    if (kind === 'threads') void fetchThreads()
    else if (kind === 'saved') void fetchSaved()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-1 md:h-auto md:px-5 md:py-2.5">
        <UiIconButton label={t('chat.header.backToList')} icon="chevron-left" size="lg" noTooltip className="text-foreground md:hidden [&>svg]:h-6 [&>svg]:w-6" onClick={() => onBack?.()} />
        {kind === 'threads'
          ? <UiIcon name="threads" className="hidden h-4 w-4 text-muted-foreground md:block" />
          : kind === 'drafts'
            ? <UiIcon name="edit" className="hidden h-4 w-4 text-muted-foreground md:block" />
            : <UiIcon name="bookmark" className="hidden h-4 w-4 text-muted-foreground md:block" />}
        <h3 className="text-base font-semibold text-foreground md:text-sm">{title}</h3>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading
          ? <UiSkeleton preset="list" rows={5} className="p-4" />
          : empty
            ? (
              /* 빈 상태 */
              kind === 'threads'
                ? (
                  <UiEmptyState
                    title={t('chat.thread.emptyTitle')}
                    description={t('chat.thread.emptyDesc')}
                    iconSlot={<span className="grid h-10 w-10 place-items-center rounded-[10px] bg-muted text-muted-foreground"><UiIcon name="threads" className="h-5 w-5" /></span>}
                  />
                )
                : kind === 'drafts'
                  ? <UiEmptyState icon="edit" title={t('chat.drafts.emptyTitle')} description={t('chat.drafts.emptyDesc')} />
                  : (
                    <UiEmptyState
                      title={t('chat.saved.emptyTitle')}
                      iconSlot={<span className="grid h-10 w-10 place-items-center rounded-[10px] bg-muted text-muted-foreground"><UiIcon name="bookmark" className="h-5 w-5" /></span>}
                      extra={<UiTrans k="chat.saved.emptyDesc" as="p" className="text-[13px] leading-relaxed text-muted-foreground [word-break:keep-all]" slots={{ key: <UiKeycap size={20}>S</UiKeycap> }} />}
                    />
                  )
            )
            : kind === 'threads'
              ? (
                /* 스레드 */
                <ul className="divide-y divide-border">
                  {threads.map(th => (
                    <li key={th.id}>
                      <button type="button" className="flex min-h-row-2 w-full flex-col gap-0.5 px-5 py-3 text-left hover:bg-accent/30" onClick={() => { void go(th.channel_id, th.id) }}>
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="truncate font-medium">{channelLabel(th.channel_id, th.channel_name, th.channel_type)}</span>
                          <span className="ml-auto shrink-0 font-mono text-[11px]">{chatListTime(th.last_reply?.created_at || th.created_at, t)}</span>
                        </span>
                        <span className={cn('truncate text-sm', th.unread_replies > 0 ? 'font-semibold text-foreground' : 'text-foreground/85')}>
                          {th.sender_name}: {oneLine(th.content)}
                        </span>
                        <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
                          {th.last_reply
                            ? <span className="min-w-0 flex-1 truncate">↳ {th.last_reply.sender_name}: {oneLine(th.last_reply.content)}</span>
                            : <span className="flex-1">{t('chat.thread.noReplies')}</span>}
                          {th.unread_replies > 0
                            ? <span className="shrink-0 text-xs font-semibold text-primary">{t('chat.thread.unreadN', { n: th.unread_replies })}</span>
                            : <span className="shrink-0 text-xs">{t('chat.message.repliesN', { n: th.reply_count })}</span>}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
              : kind === 'drafts'
                ? (
                  /* 임시 저장 */
                  <ul className="divide-y divide-border">
                    {draftList.map(d => (
                      <li key={`${d.channel_id}:${d.parent_id || ''}`} className="group relative">
                        <button type="button" className="flex min-h-row-2 w-full flex-col gap-0.5 px-5 py-3 pr-14 text-left hover:bg-accent/30" onClick={() => { void go(d.channel_id, d.parent_id) }}>
                          <span className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span className="truncate font-medium">{channelLabel(d.channel_id)}</span>
                            {d.parent_id && <UiBadge tone="neutral" tint size={18}>{t('chat.drafts.inThread')}</UiBadge>}
                            <span className="ml-auto shrink-0 font-mono text-[11px]">{chatListTime(d.updated_at, t)}</span>
                          </span>
                          <span className="truncate text-sm text-foreground">{oneLine(d.content)}</span>
                        </button>
                        <UiIconButton
                          label={t('chat.drafts.discard')}
                          icon="trash"
                          className="absolute right-3 top-1/2 -translate-y-1/2 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                          onClick={() => onDiscard(d.channel_id, d.parent_id)}
                        />
                      </li>
                    ))}
                  </ul>
                )
                : (
                  /* 저장한 메시지 */
                  <ul className="divide-y divide-border">
                    {savedMessages.map(m => (
                      <li key={m.id} className="group relative">
                        <button type="button" className="flex w-full gap-2.5 px-5 py-3 pr-14 text-left hover:bg-accent/30" onClick={() => { void go(m.channel_id, m.parent_id) }}>
                          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold" aria-hidden="true">
                            {(m.sender?.display_name || m.sender?.username || '?').charAt(0).toUpperCase()}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline gap-2">
                              <span className="text-[13px] font-semibold text-foreground">{m.sender?.display_name || m.sender?.username}</span>
                              <span className="truncate text-xs text-muted-foreground">{channelLabel(m.channel_id)}</span>
                              <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">{chatListTime(m.created_at, t)}</span>
                            </span>
                            <span className="chat-body line-clamp-3 block text-sm text-foreground" dangerouslySetInnerHTML={{ __html: renderChatMarkdown(m.content, { me: myUsername }) }} />
                          </span>
                        </button>
                        <UiIconButton
                          label={t('chat.message.unsave')}
                          pressed
                          className="absolute right-3 top-3 text-primary hover:text-primary"
                          onClick={() => { void onUnsave(m.id) }}
                        >
                          <UiIcon name="bookmark" filled className="h-4 w-4" />
                        </UiIconButton>
                      </li>
                    ))}
                  </ul>
                )}
      </div>
    </div>
  )
}

export default ChatCollectionView
