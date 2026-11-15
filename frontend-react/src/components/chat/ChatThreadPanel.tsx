/**
 * 스레드 패널(D4·M3, 2-1). Vue 원본: frontend/components/chat/ChatThreadPanel.vue
 * 데스크톱 400(넓게 = 대화 영역의 50% 까지, 대화 폭 480 보장), 모바일 전체 화면.
 * 머리: [따라가는 중] 알약 토글 · 넓게 · 새 창 · 닫기(Esc). 모바일: ‹ #채널로 돌아가기 · 알약 · ⋯.
 * 컴포저는 본 컴포저와 같은 도구 + "#채널에도 보내기"(기본 꺼짐, 보낸 뒤 다시 꺼짐 — 2-1-2).
 * handover-22 §5.2(혼합형): 머리 = threads 20 · 스레드 이름 15/600(없으면 “원문 첫 40자” 기울임) + 채널 11
 *   · 이름 바꾸기(edit-2 → 그 자리 입력, Enter 저장 · Esc 취소) · 보관/보관 해제(archive, aria-pressed) — 루트 작성자 또는 MANAGE_THREADS.
 *   머리 48+1(디스코드 49). 보관된 스레드는 컴포저 위 안내 한 줄. 스레드 안 인라인 답장은 컴포저(ChatInput mode=thread · parentId)가 받는다.
 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
// Vue :class 처럼 이어 붙이기만 한다(tailwind-merge 없이 — 원본과 같은 CSS 순서 규칙)
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { authStore } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import { closeThread, ingestThreadReply, sendThreadReply, toggleThreadFollow, useChat, type ChatMessage as ChatMessageT, type SendOptions } from '~/composables/useChat'
import { chatUiStore, setThreadWide } from '~/composables/useChatUi'
import { startThread } from '~/composables/chatApi22'
import { canInChannel, loadMyChannelPerms, PERM, useChatRoles } from '~/composables/useChatRoles'
import { applyThreadMeta, patchThread, threadTitle } from '~/composables/useChatThreadList'
import type { ThreadMeta } from '~/composables/useChat'
import { onThreadFileSent } from '~/composables/useChatAttachments'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiIcon } from '~/components/ui/Icon'
import { UiMenu } from '~/components/ui/Menu'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { ChatMessage } from './ChatMessage'
import { ChatFileMessage } from './ChatFileMessage'
import { ChatInput } from './ChatInput'
import { UiTrans } from '~/components/ui/Trans'
import { writeClipboard } from '~/lib/clipboard'

/** 스레드 패널 */
export function ChatThreadPanel() {
  const { t } = useI18n()
  const chat = useChat()
  const { activeThreadId, threadMessages, threadParent, loadingThread, activeThreadState, selectedChannel } = chat
  const user = useStore(authStore, s => s.user)
  const threadWide = useStore(chatUiStore, s => s.threadWide)

  const channelLabel = !selectedChannel ? ''
    : selectedChannel.type === 'dm' ? chat.getDMDisplayName(selectedChannel) : `#${selectedChannel.name}`
  const following = !!activeThreadState?.followed
  const replyCount = threadMessages.length || threadParent?.reply_count || 0

  const [alsoToChannel, setAlsoToChannel] = useState(false)
  const firstThread = useRef(true)
  useEffect(() => {
    if (firstThread.current) { firstThread.current = false; return }
    setAlsoToChannel(false)
  }, [activeThreadId])

  // 본문 스크롤 — 열면 최근 답글(맨 아래)로, 새 답글은 맨 아래 근처를 보고 있거나 내가 쓴 것일 때 따라 내려간다
  // (예전엔 처리가 없어 원문 자리에 멈춰 있고, 새 답글이 화면 밖에 쌓였다)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const nearBottom = useRef(true)
  const threadLen = threadMessages.length
  const lastMine = threadMessages[threadLen - 1]?.sender?.id === user?.id
  useEffect(() => {
    const el = bodyRef.current
    if (!el || loadingThread) return
    if (nearBottom.current || lastMine) el.scrollTop = el.scrollHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadLen, loadingThread])
  useEffect(() => { nearBottom.current = true }, [activeThreadId])

  function onSend(content: string, _type?: string, _meta?: string | null, opts?: SendOptions) {
    if (!activeThreadId) return
    sendThreadReply(content, activeThreadId, alsoToChannel, opts)
    setAlsoToChannel(false)
  }

  // 스레드 첨부 답글 — 실시간 이벤트가 끊겨 있어도 응답 메시지로 패널에 바로 보이게
  useEffect(() => onThreadFileSent((msg: ChatMessageT) => ingestThreadReply(msg)), [])

  // ── 스레드 이름 · 보관(handover-22 §5.2 혼합형) ──
  // 메타는 원문 메시지(thread)에서, 이 패널에서 바꾼 값은 스레드별로 덮어 둔다
  const [metaOverride, setMetaOverride] = useState<Record<string, ThreadMeta>>({})
  const meta: ThreadMeta | null = (activeThreadId && metaOverride[activeThreadId]) || threadParent?.thread || null
  const title = threadParent || meta ? threadTitle(meta, threadParent) : { text: t('chat.thread.title'), unnamed: false }
  const archived = !!meta?.archived
  // 권한: 루트 작성자 또는 MANAGE_THREADS(r24 — 채널 권한을 아직 못 읽었으면 읽는다)
  const channelId = selectedChannel?.id ?? null
  const canManageThreads = useChatRoles(s => canInChannel(channelId, PERM.MANAGE_THREADS, s))
  const isRootAuthor = !!threadParent?.sender && threadParent.sender.id === user?.id
  const canEditThread = !!threadParent && (isRootAuthor || canManageThreads)
  useEffect(() => { if (channelId) void loadMyChannelPerms(channelId) }, [channelId])

  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [savingMeta, setSavingMeta] = useState(false)
  const nameRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => { setRenaming(false) }, [activeThreadId])
  useEffect(() => { if (renaming) requestAnimationFrame(() => { nameRef.current?.focus(); nameRef.current?.select() }) }, [renaming])

  function keepMeta(id: string, m: ThreadMeta | null | undefined) {
    if (!m) return
    setMetaOverride(o => ({ ...o, [id]: m }))
    applyThreadMeta(id, m)
  }
  function metaError(e: any) {
    const d = e?.data?.detail
    addToast('error', (typeof d === 'string' ? d : d?.message) || t('error.genericError'))
  }
  function startRename() {
    setNameDraft(meta?.name || '')
    setRenaming(true)
  }
  async function saveName() {
    if (!activeThreadId || savingMeta) return
    const name = nameDraft.trim() || null
    if (name === (meta?.name || null)) { setRenaming(false); return }
    setSavingMeta(true)
    try {
      // 아직 스레드가 시작되지 않은 메시지(답글 없음)면 이름 붙여 시작
      const m = meta ? await patchThread(activeThreadId, { name }) : await startThread(activeThreadId, name)
      keepMeta(activeThreadId, m)
      setRenaming(false)
    } catch (e) { metaError(e) } finally { setSavingMeta(false) }
  }
  async function toggleArchive() {
    if (!activeThreadId || !meta || savingMeta) return
    setSavingMeta(true)
    try { keepMeta(activeThreadId, await patchThread(activeThreadId, { archived: !archived })) }
    catch (e) { metaError(e) } finally { setSavingMeta(false) }
  }
  // 보관된 스레드에 답글이 오면 서버가 보관을 푼다 — 패널도 맞춘다
  const lastReplyId = threadMessages[threadMessages.length - 1]?.id
  useEffect(() => {
    if (!activeThreadId || !archived || !lastReplyId) return
    const m = metaOverride[activeThreadId] || threadParent?.thread
    if (m?.archived && m.last_reply_at && threadMessages[threadMessages.length - 1].created_at > m.last_reply_at) {
      setMetaOverride(o => ({ ...o, [activeThreadId]: { ...m, archived: false } }))
    }
  }, [lastReplyId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function onToggleFollow() {
    if (!activeThreadId) return
    try { await toggleThreadFollow(activeThreadId) }
    catch (e: any) { addToast('error', e?.data?.detail || t('error.genericError')) }
  }

  function threadUrl() {
    const c = selectedChannel
    if (!c || !activeThreadId) return ''
    return `/chat?${new URLSearchParams({ channel: c.id, thread: activeThreadId }).toString()}`
  }
  function openNewWindow() {
    const url = threadUrl()
    if (url) window.open(url, `jw-thread-${activeThreadId}`, 'noopener,width=520,height=760')
  }

  const menuItems = [
    { key: 'follow', label: following ? t('chat.thread.unfollow') : t('chat.thread.follow') },
    ...(canEditThread ? [{ key: 'rename', label: t('chat.right.thread.rename') }] : []),
    ...(canEditThread && meta ? [{ key: 'archive', label: archived ? t('chat.right.thread.unarchive') : t('chat.right.thread.archive') }] : []),
    { key: 'link', label: t('chat.message.copyLink') },
  ]
  async function onMenu(id: string) {
    if (id === 'follow') void onToggleFollow()
    else if (id === 'rename') startRename()
    else if (id === 'archive') void toggleArchive()
    else if (id === 'link') {
      await writeClipboard(location.origin + threadUrl())
      addToast('success', t('chat.message.linkCopied'))
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="dialog"]')) closeThread()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 넓게: 400 ↔ 대화 영역의 50%(대화 폭 480 이상 보장). 부모 flex 행 기준 % 라 대화 영역이 곧 기준이다.
  const widthStyle = threadWide ? { width: 'max(400px, min(50%, calc(100% - 480px)))' } : undefined

  // 스레드 이름(없으면 “원문 첫 40자” 기울임) — 이름 바꾸는 중이면 입력칸
  const titleEl = (cls: string) => (renaming
    ? (
      <input
        ref={nameRef}
        value={nameDraft}
        maxLength={100}
        disabled={savingMeta}
        aria-label={t('chat.right.thread.namePlaceholder')}
        placeholder={t('chat.right.thread.namePlaceholder')}
        className="h-8 w-full rounded-md border-2 border-ring bg-card px-2 text-[14px] outline-none max-md:h-11 max-md:text-base"
        onChange={(e) => setNameDraft(e.target.value)}
        onBlur={() => { void saveName() }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void saveName() }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenaming(false) }
        }}
      />
    )
    : <h2 className={cn(cls, 'truncate text-foreground', title.unnamed && 'italic')} title={title.text}>{title.text}</h2>)

  const metaButtons = canEditThread && !renaming && (
    <>
      <UiIconButton label={t('chat.right.thread.rename')} icon="edit-2" className="rounded-[10px]" onClick={startRename} />
      {meta && (
        <UiIconButton
          label={archived ? t('chat.right.thread.unarchive') : t('chat.right.thread.archive')}
          icon="archive"
          pressed={archived}
          disabled={savingMeta}
          className="rounded-[10px]"
          onClick={() => { void toggleArchive() }}
        />
      )}
    </>
  )

  const followPill = (cls: string, hover: string) => (
    <button
      type="button"
      className={cn(cls, following ? 'border-primary/50 bg-primary/[0.12] text-primary' : `border-border text-muted-foreground${hover}`)}
      aria-pressed={following}
      onClick={() => { void onToggleFollow() }}
    >
      {following && <UiIcon name="check" className="h-3 w-3" strokeWidth={3} />}
      {following ? t('chat.thread.following') : t('chat.thread.follow')}
    </button>
  )

  return (
    <aside
      aria-label={`${t('chat.thread.title')} · ${title.text}`}
      className="flex h-full w-full shrink-0 flex-col bg-background md:w-[400px] md:border-l md:border-border md:bg-card"
      style={widthStyle}
    >
      {/* 머리 — 모바일 */}
      <header className="flex h-14 shrink-0 items-center gap-0.5 border-b border-border px-1 md:hidden">
        <UiIconButton
          label={t('chat.thread.backTo', { channel: channelLabel })}
          icon="chevron-left"
          size="lg"
          noTooltip
          className="text-foreground [&>svg]:h-6 [&>svg]:w-6"
          onClick={closeThread}
        />
        <div className="min-w-0 flex-1">
          {titleEl('text-base font-semibold')}
          {!renaming && <p className="truncate text-xs text-muted-foreground">{t('chat.thread.title')} · {channelLabel}</p>}
        </div>
        {followPill('mr-1 inline-flex h-8 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs font-semibold', '')}
        <UiMenu items={menuItems} label={t('chat.thread.menu')} triggerSize="lg" onSelect={(k) => { void onMenu(k) }} />
      </header>

      {/* 머리 — 데스크톱 */}
      <header className="hidden h-[49px] shrink-0 items-center gap-0.5 border-b border-border pl-4 pr-2 md:flex">
        <UiIcon name="threads" className="mr-2 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          {titleEl('text-[15px] font-semibold leading-5')}
          {!renaming && <p className="truncate text-[11px] leading-4 text-muted-foreground">{channelLabel}</p>}
        </div>
        {metaButtons}
        {followPill('mr-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs font-semibold transition-colors', ' hover:text-foreground')}
        <UiIconButton
          label={threadWide ? t('chat.thread.narrow') : t('chat.thread.wide')}
          pressed={threadWide}
          className="rounded-[10px]"
          onClick={() => setThreadWide(!threadWide)}
        >
          <UiIcon name={threadWide ? 'minimize-2' : 'maximize-2'} className="h-[15px] w-[15px]" />
        </UiIconButton>
        <UiIconButton label={t('chat.thread.newWindow')} icon="external-link" className="rounded-[10px]" onClick={openNewWindow} />
        <UiIconButton label={t('common.close')} icon="close" keys={['Esc']} className="rounded-[10px]" onClick={closeThread} />
      </header>

      {/* 본문 */}
      <div
        ref={bodyRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => { const el = e.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120 }}
      >
        {threadParent && (
          <div className="border-b border-border bg-card md:border-b-0 md:bg-transparent">
            <ChatMessage message={threadParent} grouped={false} isOwn={threadParent.sender?.id === user?.id} inThread root />
          </div>
        )}
        <div className="flex items-center gap-2.5 px-4 pb-1.5 pt-2.5 md:pt-0.5">
          <span className="text-xs font-semibold text-muted-foreground">
            <UiTrans k="chat.thread.repliesN" as="span" slots={{ n: <span className="font-mono">{replyCount}</span> }} />
          </span>
          <div className="hidden h-px flex-1 bg-border md:block" />
        </div>

        {loadingThread
          ? (
            <div className="skeleton-delay space-y-3 px-4 py-2" aria-busy="true">
              {[1, 2, 3].map(i => (
                <div key={i} className="flex gap-2.5">
                  <div className="h-7 w-7 shrink-0 rounded-full bg-muted" />
                  <div className="flex-1 space-y-1.5"><div className="h-3 w-20 rounded bg-muted" /><div className="h-4 w-2/3 rounded bg-muted" /></div>
                </div>
              ))}
            </div>
          )
          : threadMessages.length === 0
            ? <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">{t('chat.thread.noReplies')}</p>
            : threadMessages.map(msg => (msg.message_type === 'file'
              ? <ChatFileMessage key={msg.id} message={msg} grouped={false} isOwn={msg.sender?.id === user?.id} />
              : <ChatMessage key={msg.id} message={msg} grouped={false} isOwn={msg.sender?.id === user?.id} inThread />))}
      </div>

      {/* 보관된 스레드 — 답글을 쓰면 다시 활성(서버) */}
      {archived && (
        <p className="flex shrink-0 items-center gap-1.5 border-t border-border px-4 py-2 text-[12px] text-muted-foreground">
          <UiIcon name="archive" className="h-3.5 w-3.5 shrink-0" />{t('chat.right.thread.archivedBanner')}
        </p>
      )}

      {/* 답글 컴포저 */}
      <div className="shrink-0 border-t border-border px-2 pb-[calc(28px+env(safe-area-inset-bottom))] pt-1.5 md:border-t-0 md:px-4 md:pb-3.5 md:pt-2">
        <ChatInput mode="thread" parentId={activeThreadId} placeholder={t('chat.thread.replyPlaceholder')} onSend={onSend} alsoToChannel={alsoToChannel} onFilesSent={() => setAlsoToChannel(false)} />
        <UiCheckbox modelValue={alsoToChannel} onUpdateModelValue={setAlsoToChannel} className="mt-0 min-h-11 px-1.5 text-sm md:mt-2 md:min-h-0 md:px-0 md:text-[13px]">
          <UiTrans k="chat.thread.alsoToChannel" as="span" slots={{ channel: <b className="font-semibold">{channelLabel}</b> }} />
        </UiCheckbox>
      </div>
    </aside>
  )
}

export default ChatThreadPanel
