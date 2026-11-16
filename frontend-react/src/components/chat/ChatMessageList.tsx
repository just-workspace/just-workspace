/**
 * 메시지 목록.
 * 하단 정렬(메시지가 적으면 컴포저 바로 위에 배치). 메시지 열은 대화 열 전체 폭.
 *  · 날짜 구분선: 1px + 가운데 12/600 칩(radius 8, 배경색) · 새 메시지 선: danger + 오른쪽 "새" 라벨 10 굵게
 *  · 위 띠 32(아래 모서리만 radius 8): "새 메시지 N개 · 시각부터 / 읽음으로 표시"
 *  · 하단 플로팅 바: "이전 메시지를 보고 있습니다 · 최근으로"(위로 한 화면 넘게 스크롤했거나 점프한 과거 창을 보는 중 — ChatJumpBar)
 *  · 그룹 = 같은 사용자 · 5분 · 사이에 날짜/새 메시지/시스템 줄 없음 · 답장은 항상 새 그룹(utils/chatGrouping)
 *  · 점프(useChatJump): 원문으로 스크롤 + 강조, 목록에 없으면 해당 위치의 창으로 교체하여 조회. 과거 창 아래 끝에 도달하면 이어서 조회.
 *  · 채널 소개(#empty)는 기록 최상단 · 연결이 끊긴 동안 보낸 메시지는 흐리게 + "전송 대기" · 전송 실패 메시지는 "보내지 못했습니다 · 다시 보내기 · 삭제"
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { useI18n } from '~/i18n'
import { authStore } from '~/composables/useAuth'
import { chatStore, discardOutbox, retryOutbox, selectSelectedChannel, setViewAtBottom, takeEntryUnread, type ChatMessage as ChatMessageT } from '~/composables/useChat'
import { chatClockAmPm, chatUiStore, setUnreadAnchor } from '~/composables/useChatUi'
import { ChatAiSummary } from './ChatAiSummary'
import { useChatDisplay } from '~/composables/useChatDisplay'
import { jumpToPresent, loadAfter, useChatJump } from '~/composables/useChatJump'
import { groupedFlags } from '~/utils/chatGrouping'
import { loadMemberGroups, loadMyChannelPerms, loadRoles } from '~/composables/useChatRoles'
import { UiIcon } from '~/components/ui/Icon'
import { ChatChannelIntro } from './ChatChannelIntro'
import { ChatSystemMessage } from './ChatSystemMessage'
import { ChatMessage } from './ChatMessage'
import { ChatJumpBar } from './ChatJumpBar'

export interface ChatMessageListProps {
  messages: ChatMessageT[]
  loading: boolean
  hasMore: boolean
  loadingMore: boolean
  /** 위 끝 근처까지 스크롤 — 이전 메시지 추가 조회 */
  onLoadMore?: () => void
  /** 스레드 열기 */
  onOpenThread?: (messageId: string) => void
}

function sameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

/** 날짜 구분선 텍스트 — 오늘 · 어제 · "2026년 10월 22일 목요일" */
export function dayLabel(iso: string, t: (k: string) => string, lang = 'ko-KR', now = new Date()): string {
  const d = new Date(iso)
  if (d.toDateString() === now.toDateString()) return t('common.today')
  const y = new Date(now); y.setDate(y.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return t('common.yesterday')
  return d.toLocaleDateString(lang, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
}

/** 채널 메시지 목록 */
export function ChatMessageList({ messages, loading, hasMore, loadingMore, onLoadMore, onOpenThread }: ChatMessageListProps) {
  const { t, locale } = useI18n()
  const lang = locale === 'en' ? 'en-US' : 'ko-KR'
  const user = useStore(authStore, s => s.user)
  const selectedChannel = useStore(chatStore, s => selectSelectedChannel(s))
  const selectedChannelId = useStore(chatStore, s => s.selectedChannelId)
  const newBelowCount = useStore(chatStore, s => s.newBelowCount)
  const outbox = useStore(chatStore, s => s.outbox)
  const unreadAnchor = useStore(chatUiStore, s => s.unreadAnchor)
  const { display } = useChatDisplay()

  // 연결이 끊긴 동안 보낸 메시지(전송 대기) — 현재 채널 분만, 맨 아래에 표시
  const pending = useMemo(() =>
    outbox
      .filter(o => o.channelId === selectedChannelId)
      .map(o => ({
        failed: !!o.failed,
        msg: {
          id: o.localId,
          channel_id: o.channelId,
          sender: user ? { id: user.id, username: user.username, display_name: user.display_name ?? null, avatar_url: (user as any).avatar_url ?? null } : null,
          content: o.content,
          message_type: 'text',
          file_meta: null,
          parent_id: null,
          reply_count: 0,
          is_edited: false,
          is_deleted: false,
          created_at: o.createdAt,
          updated_at: o.createdAt,
        } as ChatMessageT,
      })),
  [outbox, selectedChannelId, user])

  const listRef = useRef<HTMLDivElement | null>(null)
  const autoScroll = useRef(true)
  const [farFromBottom, setFarFromBottom] = useState(false)

  const { detached } = useChatJump({ listRef, onBeforeJump: () => { autoScroll.current = false }, t })

  // ─── "새 메시지" 구분선 — 채널 진입 시 unread 개수를 스냅샷으로 보관해 첫 안읽음 위치를 고정 ───
  const [firstUnreadId, setFirstUnreadId] = useState<string | null>(null)
  const [unreadSnapshot, setUnreadSnapshot] = useState(0)
  const [dividerAbove, setDividerAbove] = useState(false)

  const L = useRef({ messages, hasMore, loadingMore, onLoadMore, firstUnreadId, selectedChannel, selectedChannelId, detached })
  L.current = { messages, hasMore, loadingMore, onLoadMore, firstUnreadId, selectedChannel, selectedChannelId, detached }

  function updateDividerAbove(fid: string | null = L.current.firstUnreadId) {
    const el = listRef.current
    if (!el || !fid) { setDividerAbove(false); return }
    const div = el.querySelector<HTMLElement>('[data-unread-divider]')
    if (!div) { setDividerAbove(false); return }
    setDividerAbove(div.getBoundingClientRect().bottom < el.getBoundingClientRect().top + 4)
  }
  function jumpToUnread() {
    listRef.current?.querySelector<HTMLElement>('[data-unread-divider]')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
  function dismissUnread() {
    setFirstUnreadId(null)
    setUnreadSnapshot(0)
    setDividerAbove(false)
  }
  function captureUnread() {
    const { messages: list, selectedChannel: ch } = L.current
    const u = takeEntryUnread(ch?.id) ?? (ch?.unread_count || 0)
    const idx = list.length - u
    const fid = (u > 0 && idx >= 0) ? (list[idx]?.id || null) : null
    setFirstUnreadId(fid)
    setUnreadSnapshot(fid ? u : 0)
    return fid
  }

  // ─── 스크롤 ───
  function scrollToBottom() {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }
  function onScroll() {
    const el = listRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = dist < 100
    autoScroll.current = atBottom && !L.current.detached
    // 맨 아래를 보고 있는지 여부를 useChat 에 전달 — 읽음 처리 기준. 과거 창의 끝은 "맨 아래"로 보지 않음
    setViewAtBottom(atBottom && !L.current.detached)
    setFarFromBottom(dist > el.clientHeight)
    updateDividerAbove()
    const c = L.current
    if (el.scrollTop < 50 && c.hasMore && !c.loadingMore) c.onLoadMore?.()
    if (atBottom && c.detached) void loadAfter()
  }
  async function toPresent() {
    autoScroll.current = true
    if (L.current.detached) { await jumpToPresent(); return }
    scrollToBottom()
  }

  // 채널 변경 시 구분선 초기화(첫 실행 제외)
  const firstCh = useRef(true)
  useEffect(() => {
    if (firstCh.current) { firstCh.current = false; return }
    setFirstUnreadId(null); setUnreadSnapshot(0); setDividerAbove(false)
    autoScroll.current = true
  }, [selectedChannelId])

  // 로드 완료 시: 첫 안읽음 스냅샷 · 맨 아래로 스크롤 · 구분선 위치(첫 실행 제외)
  const firstLoad = useRef(true)
  useEffect(() => {
    if (firstLoad.current) { firstLoad.current = false; return }
    if (loading) return
    captureUnread()
    if (autoScroll.current) scrollToBottom()
    updateDividerAbove(null)
  }, [loading])

  // "읽지 않음으로 표시" — 구분선을 해당 메시지 위로 이동
  const [anchorTick, setAnchorTick] = useState(0)
  useEffect(() => {
    const a = unreadAnchor
    if (!a || a.channelId !== L.current.selectedChannelId) return
    const list = L.current.messages
    const idx = list.findIndex(m => m.id === a.messageId)
    if (idx < 0) return
    setFirstUnreadId(a.messageId)
    setUnreadSnapshot(list.length - idx)
    setUnreadAnchor(null)
    setAnchorTick(n => n + 1)
  }, [unreadAnchor])
  useEffect(() => {
    if (anchorTick) updateDividerAbove()
  }, [anchorTick])

  // 새 메시지 증가 시(맨 아래를 보고 있는 경우에만) 맨 아래로 스크롤
  const prevLen = useRef(messages.length)
  useEffect(() => {
    const o = prevLen.current
    prevLen.current = messages.length
    if (autoScroll.current && !L.current.detached && messages.length > o) scrollToBottom()
  }, [messages.length])
  const prevPending = useRef(pending.length)
  useEffect(() => {
    const o = prevPending.current
    prevPending.current = pending.length
    if (pending.length > o) scrollToBottom()
  }, [pending.length])
  // 이름 역할 색·@역할 칩·채널 권한은 멤버 열이 닫혀 있어도 필요 — 채널을 열 때 1회 조회
  useEffect(() => {
    if (!selectedChannelId) return
    void loadRoles()
    void loadMemberGroups(selectedChannelId)
    void loadMyChannelPerms(selectedChannelId)
  }, [selectedChannelId])
  useEffect(() => { scrollToBottom() }, [])
  // 컴포저 위 띠(답장·@everyone)·첨부 줄이 생겨 목록 영역이 줄어도, 맨 아래를 보고 있었으면 맨 아래 위치를 유지(디스코드)
  useEffect(() => {
    const el = listRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { if (autoScroll.current) scrollToBottom() })
    ro.observe(el)
    // 내부 콘텐츠도 관찰 — 링크 미리보기 카드·리액션 줄·이미지가 뒤늦게 커지면 마지막 메시지가 화면 아래로 밀리는 문제가 있었음
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [])

  // ─── 그룹·날짜 ───
  const grouped = useMemo(() => groupedFlags(messages, firstUnreadId), [messages, firstUnreadId])
  function showDayDivider(idx: number): boolean {
    if (idx === 0) return !hasMore
    return !sameDay(messages[idx].created_at, messages[idx - 1].created_at)
  }
  function isLastInGroup(idx: number): boolean {
    return idx >= messages.length - 1 || !grouped[idx + 1]
  }

  const showIntro = !!selectedChannel && selectedChannel.type !== 'dm' && !hasMore && !loading
  const firstUnreadMsg = firstUnreadId ? messages.find(m => m.id === firstUnreadId) : null
  const unreadSince = firstUnreadMsg
    ? `${dayLabel(firstUnreadMsg.created_at, t, lang)} ${chatClockAmPm(firstUnreadMsg.created_at, lang)}`
    : ''
  const showJumpBar = !loading && (detached || farFromBottom || newBelowCount > 0)
  const mx = display === 'mobile' ? 'mx-3' : 'mx-4'

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* 화면 내 AI 채팅방 요약 — 헤더 아래 카드 */}
      <ChatAiSummary channelId={selectedChannelId} firstUnreadId={firstUnreadId} unreadCount={unreadSnapshot} />
      <div ref={listRef} role="feed" aria-label={t('chat.msg.list.feed')} aria-busy={loading || loadingMore} className="flex-1 overflow-y-auto" onScroll={onScroll}>
        <div className="flex min-h-full flex-col justify-end pb-2 pt-2">
          {loadingMore && <div className="py-2 text-center text-xs text-muted-foreground">{t('chat.messages.loadingMore')}</div>}

          {loading
            ? (
              /* 로딩 중 — 아바타 40 + 줄 막대 */
              <div className="skeleton-delay flex flex-col gap-5 px-4" aria-busy="true" data-skeleton="">
                {[['w-3/4', 'w-1/2'], ['w-2/3'], ['w-1/2', 'w-2/5'], ['w-1/2']].map((rows, i) => (
                  <div key={i} className="flex gap-4">
                    <span className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
                    <div className="flex flex-1 flex-col gap-2 pt-1">
                      <span className="h-3.5 w-32 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                      {rows.map(w => <span key={w} className={`h-3.5 ${w} animate-pulse rounded bg-muted motion-reduce:animate-none`} />)}
                    </div>
                  </div>
                ))}
              </div>
            )
            : (
              <>
                {showIntro && selectedChannel && <ChatChannelIntro channel={selectedChannel} messageCount={messages.length} />}

                {messages.map((msg, idx) => (
                  <div key={msg.id}>
                    {showDayDivider(idx) && (
                      <div role="separator" aria-label={dayLabel(msg.created_at, t, lang)} className={`relative ${mx} mb-1 mt-5 flex select-none items-center justify-center`}>
                        <span className="absolute inset-x-0 top-1/2 h-px bg-border" aria-hidden="true" />
                        <span className="relative rounded-lg bg-background px-2 text-[12px] font-semibold text-muted-foreground">{dayLabel(msg.created_at, t, lang)}</span>
                      </div>
                    )}
                    {msg.id === firstUnreadId && (
                      <div data-unread-divider="" role="separator" aria-label={t('chat.messages.newMessagesHere')} className={`${mx} mt-3 flex select-none items-center`}>
                        <span className="h-px flex-1 bg-danger" aria-hidden="true" />
                        <span className="rounded-r bg-danger px-1 text-[10px] font-bold leading-[14px] text-background" aria-hidden="true">{t('chat.msg.list.newTag')}</span>
                      </div>
                    )}
                    {msg.message_type === 'system'
                      ? <ChatSystemMessage message={msg} display={display} />
                      : (
                        <ChatMessage
                          message={msg}
                          grouped={grouped[idx]}
                          isOwn={msg.sender?.id === user?.id}
                          isLastInGroup={isLastInGroup(idx)}
                          onOpenThread={onOpenThread}
                        />
                      )}
                  </div>
                ))}

                {/* 전송 대기 · 전송 실패 */}
                {pending.map(({ msg: p, failed }) => (
                  <ChatMessage
                    key={p.id}
                    message={p}
                    grouped={false}
                    isOwn
                    readonlyRow
                    dimBody={failed}
                    footer={failed
                      ? (
                        <p role="alert" className="mt-0.5 flex items-center gap-2 text-[13px] text-danger">
                          <UiIcon name="alert-circle" className="h-4 w-4" />
                          {t('chat.msg.list.failed')}
                          <button type="button" className="font-semibold underline" onClick={() => retryOutbox(p.id)}>{t('chat.msg.list.resend')}</button>
                          <button type="button" className="text-muted-foreground underline" onClick={() => discardOutbox(p.id)}>{t('common.delete')}</button>
                        </p>
                      )
                      : (
                        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <UiIcon name="clock" className="h-[13px] w-[13px]" />
                          <span>{t('chat.messages.pendingSend')}</span>
                        </div>
                      )}
                  />
                ))}

                {messages.length === 0 && pending.length === 0 && !showIntro && (
                  <p className="px-5 py-8 text-center text-sm text-muted-foreground">{t('chat.messages.empty')}</p>
                )}
              </>
            )}
        </div>
      </div>

      {/* 위 띠 32 — 새 메시지 N개 · 시각부터 / 읽음으로 표시 */}
      {dividerAbove && unreadSnapshot > 0 && (
        <div className="absolute inset-x-4 top-0 z-10 flex h-8 items-center gap-2 rounded-b-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground" data-unread-band="">
          <button type="button" className="min-w-0 flex-1 truncate text-left" aria-label={t('chat.messages.unreadPillJump', { n: unreadSnapshot })} onClick={jumpToUnread}>
            {t('chat.msg.list.unreadBand', { n: unreadSnapshot, since: unreadSince })}
          </button>
          <button type="button" className="flex shrink-0 items-center gap-1 font-semibold" onClick={dismissUnread}>
            {t('chat.messages.markRead')}<UiIcon name="check" className="h-4 w-4" />
          </button>
        </div>
      )}

      {showJumpBar && (
        <ChatJumpBar
          viewingDate={detached ? messages[Math.floor(messages.length / 2)]?.created_at ?? null : null}
          newCount={newBelowCount}
          onPresent={() => { void toPresent() }}
        />
      )}
    </div>
  )
}

export default ChatMessageList
