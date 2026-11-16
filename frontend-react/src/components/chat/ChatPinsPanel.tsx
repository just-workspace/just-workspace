/**
 * 고정 메시지 패널 — 채널 ⋯ "고정 메시지"에서 진입한다.
 * 시안에 해당 화면이 없어 스레드 패널(400, 헤더 53) 골격과 빈 상태(EmptyState panel) 규격으로 구성한다.
 */
import { useEffect } from 'react'
import { useStore } from 'zustand'
import { useI18n } from '~/i18n'
import { authStore } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import { fetchPins, openThread, setShowPinsPanel, unpinMessage, useChat } from '~/composables/useChat'
import { chatListTime, jumpTo } from '~/composables/useChatUi'
import { useIsMobile } from '~/composables/useIsMobile'
import { renderChatMarkdown } from '~/utils/chatMarkdown'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiIcon } from '~/components/ui/Icon'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEmptyState } from '~/components/ui/EmptyState'

/** 고정 메시지 패널 */
export function ChatPinsPanel() {
  const { t } = useI18n()
  const chat = useChat()
  const { pins, loadingPins, selectedChannel } = chat
  const myUsername = useStore(authStore, s => s.user?.username)
  const isMobile = useIsMobile()

  const channelLabel = !selectedChannel ? ''
    : selectedChannel.type === 'dm' ? chat.getDMDisplayName(selectedChannel) : `#${selectedChannel.name}`

  function close() { setShowPinsPanel(false) }

  async function onUnpin(id: string) {
    try { await unpinMessage(id) }
    catch (e: any) { addToast('error', e?.data?.detail || t('error.genericError')) }
  }

  // 고정 대상이 답글이면 스레드를 열어 해당 답글로, 원 메시지이면 대화의 해당 행으로 이동한다(강조 2초 + "최근으로" 바).
  // 모바일은 대화가 보이도록 패널을 닫는다(데스크톱은 패널을 유지한 채 이동).
  function onOpen(m: { id: string; channel_id: string; parent_id: string | null; thread_broadcast?: boolean }) {
    if (m.parent_id && !m.thread_broadcast) { close(); void openThread(m.parent_id).then(() => jumpTo(m.channel_id, m.id)); return }
    if (isMobile) close()
    jumpTo(m.channel_id, m.id)
  }

  // 열 때마다 재조회. 고정 직후 응답으로 먼저 반영된 항목에는 "고정한 사람" 이름 누락
  useEffect(() => { void fetchPins() }, [])

  return (
    <aside aria-label={t('chat.pins.title')} className="flex h-full w-full shrink-0 flex-col bg-background md:w-[400px] md:border-l md:border-border md:bg-card">
      <header className="flex h-14 shrink-0 items-center gap-0.5 border-b border-border px-1 md:h-[53px] md:pl-4 md:pr-2">
        <UiIconButton label={t('common.back')} icon="chevron-left" size="lg" noTooltip className="text-foreground md:hidden [&>svg]:h-6 [&>svg]:w-6" onClick={close} />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground md:text-[13px]">{t('chat.pins.title')}</h2>
          <p className="truncate text-xs text-muted-foreground md:text-[11px]">{channelLabel}</p>
        </div>
        <UiIconButton label={t('common.close')} icon="close" keys={['Esc']} className="hidden rounded-[10px] md:inline-flex" onClick={close} />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loadingPins && pins.length === 0
          ? <UiSkeleton preset="list" rows={3} className="p-4" />
          : pins.length === 0
            ? (
              <UiEmptyState
                variant="panel"
                title={t('chat.pins.emptyTitle')}
                description={t('chat.pins.emptyDesc')}
                iconSlot={<span className="grid h-8 w-8 place-items-center rounded-sm bg-muted text-muted-foreground"><UiIcon name="pin" className="h-4 w-4" /></span>}
              />
            )
            : (
              <ul className="divide-y divide-border">
                {pins.map(m => (
                  <li key={m.id} className="group relative">
                    <button type="button" className="flex w-full gap-2.5 px-4 py-3 text-left hover:bg-accent/30" onClick={() => onOpen(m)}>
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold" aria-hidden="true">
                        {(m.sender?.display_name || m.sender?.username || '?').charAt(0).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="text-[13px] font-semibold text-foreground">{m.sender?.display_name || m.sender?.username}</span>
                          <span className="font-mono text-[11px] text-muted-foreground">{chatListTime(m.created_at, t)}</span>
                        </span>
                        <span className="chat-body line-clamp-3 block text-sm text-foreground" dangerouslySetInnerHTML={{ __html: renderChatMarkdown(m.content, { me: myUsername }) }} />
                        {m.pinned_by_name && (
                          <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                            <UiIcon name="pin" className="h-3 w-3" />{t('chat.pins.pinnedBy', { name: m.pinned_by_name })}
                          </span>
                        )}
                      </span>
                    </button>
                    <UiIconButton
                      label={t('chat.message.unpin')}
                      icon="close"
                      className="absolute right-2 top-2 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                      onClick={() => { void onUnpin(m.id) }}
                    />
                  </li>
                ))}
              </ul>
            )}
      </div>
    </aside>
  )
}

export default ChatPinsPanel
