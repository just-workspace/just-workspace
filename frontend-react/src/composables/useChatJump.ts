/**
 * 원문으로 점프.
 * useChatUi.jumpTo(channelId, messageId) 의 호출 주체와 무관하게(답장 미리보기 · 고정 줄 · 검색 결과 · 고정 목록) 메시지 목록이 이 훅으로 처리한다.
 *  1) 다른 채널이면 해당 채널을 연다.
 *  2) 원문이 현재 목록에 있으면 해당 줄로 스크롤 + 강조.
 *  3) 없으면 GET ?around= 로 해당 위치를 중심으로 재조회해 목록을 교체하고(useChat.replaceMessagesWindow) 점프 → 아래 "이전 메시지를 보고 있습니다 · 최근으로" 바.
 *     스레드 내 원문이면(thread_root_id) 스레드를 연다.
 *  · 하단 끝에 도달하면 fetchMessagesAfter 로 이어 붙인다(최신까지 도달하면 실시간으로 복귀한다).
 *  · 최근으로 = 원래 최신 목록 재조회(fetchMessages).  · 이전 위치를 열람 중에 본인이 전송하면 최근으로 이동.
 * 강조: bg-overlay-jump 2초 유지 → 1초 사라짐(reduce-motion 이면 2초 후 즉시 제거). 상태는 chatJumpStore(행이 조회한다).
 */
import { useEffect, useRef, type RefObject } from 'react'
import { createStore, useStore } from 'zustand'
import { authStore } from '~/composables/useAuth'
import {
  appendMessagesAfter, chatStore, fetchMessages, onChatEvent, openThread, replaceMessagesWindow, selectChannel, type ChatMessage,
} from '~/composables/useChat'
import { chatUiStore, clearJump } from '~/composables/useChatUi'
import { fetchMessagesAfter, fetchMessagesAround } from '~/composables/chatApi22'
import { addToast } from '~/composables/useToast'

export const JUMP_HOLD_MS = 2000
export const JUMP_FADE_MS = 1000

export const chatJumpStore = createStore<{ id: string | null; phase: 'on' | 'fade' | null; loadingAfter: boolean }>()(() => ({ id: null, phase: null, loadingAfter: false }))
let _timers: ReturnType<typeof setTimeout>[] = []

function reduceMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}
/** 줄 강조 시작(2초 유지 → 1초 사라짐) */
export function flashMessage(id: string) {
  _timers.forEach(clearTimeout)
  _timers = []
  chatJumpStore.setState({ id, phase: 'on' })
  if (reduceMotion()) {
    _timers.push(setTimeout(() => chatJumpStore.setState({ id: null, phase: null }), JUMP_HOLD_MS))
    return
  }
  _timers.push(setTimeout(() => chatJumpStore.setState({ phase: 'fade' }), JUMP_HOLD_MS))
  _timers.push(setTimeout(() => chatJumpStore.setState({ id: null, phase: null }), JUMP_HOLD_MS + JUMP_FADE_MS))
}

/** 목록 내 해당 줄로 스크롤 + 강조. 줄이 아직 없으면 false */
export function scrollToMessage(root: HTMLElement | null, id: string): boolean {
  const el = root?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
  if (!el) return false
  el.scrollIntoView?.({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' })
  flashMessage(id)
  return true
}

export type JumpPlan =
  | { kind: 'inList' }
  | { kind: 'window'; messages: ChatMessage[]; hasMore: boolean; hasMoreAfter: boolean }
  | { kind: 'thread'; rootId: string }
  | { kind: 'missing' }

/** 점프 계획(순수 판단 + 필요 시 around 조회) — 테스트 */
export async function planJump(
  channelId: string,
  messageId: string,
  current: Pick<ChatMessage, 'id'>[],
  fetchAround: typeof fetchMessagesAround = fetchMessagesAround,
): Promise<JumpPlan> {
  if (current.some(m => m.id === messageId)) return { kind: 'inList' }
  const page = await fetchAround(channelId, messageId, 50)
  if (page?.thread_root_id) return { kind: 'thread', rootId: page.thread_root_id }
  const list = Array.isArray(page?.messages) ? page.messages : []
  if (!list.some(m => m.id === messageId)) return { kind: 'missing' }
  return { kind: 'window', messages: list, hasMore: !!page.has_more, hasMoreAfter: !!page.has_more_after }
}

export interface UseChatJumpOpts {
  listRef: RefObject<HTMLElement | null>
  /** 점프 직전 — 목록의 자동 최하단 스크롤을 비활성화 */
  onBeforeJump?: () => void
  /** 실패 문구 */
  t: (k: string) => string
}

/** 메시지 목록에서 1회 사용 */
export function useChatJump({ listRef, onBeforeJump, t }: UseChatJumpOpts) {
  const jumpTarget = useStore(chatUiStore, s => s.jumpTarget)
  const detached = useStore(chatStore, s => s.hasMoreAfter)
  const pendingScroll = useRef<string | null>(null)
  const messagesRef = useStore(chatStore, s => s.messages)
  const L = useRef({ onBeforeJump, t })
  L.current = { onBeforeJump, t }


  // jumpTo 처리
  useEffect(() => {
    const jt = jumpTarget
    if (!jt) return
    let alive = true
    void (async () => {
      try {
        if (chatStore.getState().selectedChannelId !== jt.channelId) await selectChannel(jt.channelId)
        if (!alive) return
        L.current.onBeforeJump?.()
        const plan = await planJump(jt.channelId, jt.messageId, chatStore.getState().messages)
        if (!alive) return
        if (plan.kind === 'inList') { if (!scrollToMessage(listRef.current, jt.messageId)) pendingScroll.current = jt.messageId }
        else if (plan.kind === 'thread') void openThread(plan.rootId)
        else if (plan.kind === 'window') {
          pendingScroll.current = jt.messageId
          replaceMessagesWindow(plan.messages, plan.hasMore, plan.hasMoreAfter)
        } else addToast('error', L.current.t('chat.msg.jump.missing'))
      } catch {
        if (alive) addToast('error', L.current.t('chat.msg.jump.failed'))
      } finally {
        clearJump()
      }
    })()
    return () => { alive = false }
  }, [jumpTarget, listRef])

  // 창 교체 렌더 후 해당 줄로 스크롤
  useEffect(() => {
    const id = pendingScroll.current
    if (!id) return
    if (scrollToMessage(listRef.current, id)) pendingScroll.current = null
  }, [messagesRef, listRef])

  // 이전 위치를 열람 중에 본인이 전송 → 최근으로 이동
  useEffect(() => onChatEvent((data) => {
    if (data?.type !== 'new_message' || !chatStore.getState().hasMoreAfter) return
    const msg = data.message as ChatMessage | undefined
    if (msg && !msg.parent_id && msg.channel_id === chatStore.getState().selectedChannelId && msg.sender?.id === authStore.getState().user?.id) void jumpToPresent()
  }), [])

  return { detached, jumpToPresent, loadAfter }
}

/** 최근으로 — 원래 최신 목록 */
export async function jumpToPresent() {
  await fetchMessages()
}

/** 하단 끝 도달 — 이전 위치를 열람 중이면 다음 페이지를 추가 */
export async function loadAfter() {
  const s = chatStore.getState()
  if (!s.hasMoreAfter || chatJumpStore.getState().loadingAfter || !s.selectedChannelId) return
  const last = s.messages[s.messages.length - 1]
  if (!last?.seq) { await jumpToPresent(); return }
  chatJumpStore.setState({ loadingAfter: true })
  try {
    const page = await fetchMessagesAfter(s.selectedChannelId, last.seq, 50)
    if (chatStore.getState().selectedChannelId !== s.selectedChannelId) return
    const list = Array.isArray(page?.messages) ? page.messages : []
    appendMessagesAfter(list, !!page?.has_more_after && list.length > 0)
  } catch {
    // 이어서 조회하지 못하면 최신으로 복귀(구 서버 — after_seq 미지원)
    await jumpToPresent()
  } finally {
    chatJumpStore.setState({ loadingAfter: false })
  }
}
