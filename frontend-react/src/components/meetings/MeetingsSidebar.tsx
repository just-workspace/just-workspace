/**
 * 회의 사이드바 — 참가자 · 대기실(호스트 승인/거절) · 채팅(DataChannel) 탭. 모바일은 영상 위에 오버레이, md↑ 는 오른쪽 288.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useMeetings } from '~/composables/useMeetings'
import { UiIcon } from '~/components/ui/Icon'
import type { MeetingsSidebarTab } from '~/components/meetings/MeetingsControls'

export interface MeetingsSidebarProps {
  /** 현재 탭(v-model:activeTab) */
  activeTab: MeetingsSidebarTab
  onUpdateActiveTab?: (tab: MeetingsSidebarTab) => void
  /** 닫기(✕) */
  onClose?: () => void
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
}

const tabBtn = 'min-w-0 flex-1 whitespace-nowrap py-2.5 text-xs font-medium text-center transition-colors border-b-2'
const tabOn = 'border-primary text-foreground'
const tabOff = 'border-transparent text-muted-foreground hover:text-foreground'

/** 회의 사이드바 */
export function MeetingsSidebar({ activeTab, onUpdateActiveTab, onClose }: MeetingsSidebarProps) {
  const { t } = useI18n()
  const {
    participants, isHost, pendingRequests, chatMessages, unreadChat,
    fetchPendingRequests, approveRequest, denyRequest, sendChatMessage, clearUnreadChat,
  } = useMeetings()

  const [chatInput, setChatInput] = useState('')
  const chatListEl = useRef<HTMLDivElement | null>(null)

  // 대기실 폴링은 룸 페이지(room/[name])가 수행한다 — 사이드바가 닫힌 상태에서도
  // 컨트롤 바 배지가 갱신되어야 하기 때문이다.
  useEffect(() => {
    if (isHost) void fetchPendingRequests()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 채팅 탭이 표시되는 동안은 읽음으로 간주한다 — 최초부터 채팅 탭으로 열린 경우와 열어 둔 동안 새 메시지가 수신된 경우에도 초기화한다.
  // (과거에는 탭 "전환 시"에만 초기화하여, 채팅 버튼으로 열어 읽고 닫아도 배지가 유지되었다)
  useEffect(() => {
    if (activeTab === 'chat' && unreadChat > 0) clearUnreadChat()
  }, [activeTab, unreadChat, clearUnreadChat])

  // 채팅 자동 스크롤(최초에는 미수행)
  const firstMsgs = useRef(true)
  useEffect(() => {
    if (firstMsgs.current) { firstMsgs.current = false; return }
    const el = chatListEl.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatMessages])

  function handleSendChat(e: FormEvent) {
    e.preventDefault()
    if (!chatInput.trim()) return
    sendChatMessage(chatInput)
    setChatInput('')
  }

  const setTab = (tab: MeetingsSidebarTab) => onUpdateActiveTab?.(tab)

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden border-l border-border bg-card shrink-0 absolute inset-0 z-drawer w-full md:static md:inset-auto md:z-auto md:w-72">
      {/* 탭 헤더 */}
      <div className="flex border-b shrink-0">
        <button onClick={() => setTab('participants')} className={cn(tabBtn, activeTab === 'participants' ? tabOn : tabOff)}>
          {t('meetings.sidebar.participants', { n: participants.length })}
        </button>
        <button onClick={() => setTab('waitingRoom')} className={cn(tabBtn, 'relative', activeTab === 'waitingRoom' ? tabOn : tabOff)}>
          {t('meetings.sidebar.waitingRoom')}
          {pendingRequests.length > 0 && (
            <span className="absolute top-1.5 ml-0.5 inline-flex items-center justify-center h-4 min-w-[1rem] px-1 text-[11px] font-bold rounded-full bg-warning text-background">
              {pendingRequests.length}
            </span>
          )}
        </button>
        <button onClick={() => setTab('chat')} className={cn(tabBtn, 'relative', activeTab === 'chat' ? tabOn : tabOff)}>
          {t('meetings.sidebar.chat')}
          {unreadChat > 0 && activeTab !== 'chat' && (
            <span className="absolute top-1.5 ml-0.5 inline-flex items-center justify-center h-4 min-w-[1rem] px-1 text-[11px] font-bold rounded-full bg-primary text-primary-foreground">
              {unreadChat > 99 ? '99+' : unreadChat}
            </span>
          )}
        </button>
        <button
          onClick={() => onClose?.()}
          className="shrink-0 px-2 text-muted-foreground hover:text-foreground transition-colors"
          title={t('common.close')}
        >
          <UiIcon name="close" className="h-4 w-4" />
        </button>
      </div>

      {/* 참여자 탭 */}
      {activeTab === 'participants' && (
        <div className="flex-1 overflow-y-auto">
          <div className="divide-y">
            {participants.map(p => (
              <div key={p.identity} className="flex items-center gap-3 px-3 py-2.5">
                <div className="h-8 w-8 rounded-full bg-primary/15 flex items-center justify-center text-sm font-semibold text-primary shrink-0">
                  {p.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">
                    {p.name}
                    {p.isLocal && <span className="text-muted-foreground font-normal">{' ' + t('meetings.participant.me')}</span>}
                  </p>
                </div>
                <div className="shrink-0">
                  {p.isMuted
                    ? <UiIcon name="mic-off" className="h-4 w-4 text-danger" />
                    : <UiIcon name="mic-on" className="h-4 w-4 text-success" />}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 대기실 탭 */}
      {activeTab === 'waitingRoom' && (
        <div className="flex-1 overflow-y-auto">
          {isHost
            ? (pendingRequests.length === 0
              ? (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {t('meetings.sidebar.noWaiting')}
                </div>
              )
              : (
                <div className="divide-y">
                  {pendingRequests.map(req => (
                    <div key={req.id} className="flex items-center justify-between px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{req.nickname}</p>
                        <p className="text-[11px] text-muted-foreground">{t('meetings.sidebar.joinRequest')}</p>
                      </div>
                      <div className="flex gap-1 shrink-0 ml-2">
                        <button
                          onClick={() => void approveRequest(req.id)}
                          className="px-2.5 py-1 text-xs font-medium rounded bg-success text-background hover:bg-success/90 transition-colors"
                        >
                          {t('meetings.sidebar.approve')}
                        </button>
                        <button
                          onClick={() => void denyRequest(req.id)}
                          className="px-2.5 py-1 text-xs font-medium rounded border border-border text-destructive hover:bg-destructive/10 transition-colors"
                        >
                          {t('meetings.sidebar.deny')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ))
            : (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                {t('meetings.sidebar.hostOnly')}
              </div>
            )}
        </div>
      )}

      {/* 채팅 탭 */}
      {activeTab === 'chat' && (
        <>
          <div ref={chatListEl} className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
            {chatMessages.length === 0 && (
              <div className="text-center text-sm text-muted-foreground py-8">
                {t('meetings.sidebar.noMessages')}
              </div>
            )}
            {chatMessages.map(msg => (
              <div key={msg.id} className="group">
                <div className="flex min-w-0 items-baseline gap-1.5">
                  <span className={cn('min-w-0 truncate text-xs font-semibold', msg.isLocal ? 'text-primary' : 'text-foreground')}>
                    {msg.sender}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{formatTime(msg.ts)}</span>
                </div>
                <p className="text-sm mt-0.5 break-words [overflow-wrap:anywhere]">{msg.text}</p>
              </div>
            ))}
          </div>

          {/* 채팅 입력 */}
          <div className="border-t px-3 py-2 shrink-0">
            <form onSubmit={handleSendChat} className="flex gap-2">
              <input
                autoComplete="off"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                type="text"
                placeholder={t('meetings.sidebar.chatPlaceholder')}
                maxLength={500}
                className="min-w-0 flex-1 text-sm px-3 py-1.5 rounded-md border border-border bg-background focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              <button
                type="submit"
                disabled={!chatInput.trim()}
                className="shrink-0 whitespace-nowrap px-3 py-1.5 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {t('common.send')}
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  )
}

export default MeetingsSidebar
