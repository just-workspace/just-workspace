/**
 * 메시지 호버 바(디스코드 수치).
 *  모양: 1px · radius 8 · 안쪽 2 · 버튼 32(radius 6) · 아이콘 20 · 구분선 1×24 · 줄 위 −16. 아이콘 호버 1.1배(reduce-motion 제외).
 *  구성: 최근 리액션 3(개인 설정 chatEmojiRecent 앞 3, 없으면 시안 👍 👀 🎉) | 리액션 추가(피커) · 답장 · 스레드로 답장 · 저장 · ⋯
 *  Shift 를 누르고 있으면 고정 · 삭제(danger)가 ⋯ 앞에 바로 보인다(디스코드).
 *  ⋯ = 수정 · 답장 · 스레드 만들기(이름 붙여 시작) · 고정 · 안 읽음으로 표시 · 링크 복사 · 텍스트 복사 · (다운로드) · 삭제.
 * 동작 실행은 useMessageActionRunner 한 곳 — 모바일 시트(ChatMessageSheet)도 같은 것을 쓴다.
 */
import { useEffect, useRef, useState } from 'react'
import { createStore, useStore } from 'zustand'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { addToast } from '~/composables/useToast'
import { confirmBox, promptBox } from '~/composables/useDialog'
import {
  chatStore, deleteMessage, dismissLinkPreview, isSaved, markUnread, toggleReaction, togglePin, toggleSave, type ChatMessage,
} from '~/composables/useChat'
import { anchorOf, setEmojiPicker, setReplyTo, setUnreadAnchor } from '~/composables/useChatUi'
import { canInChannel, PERM } from '~/composables/useChatRoles'
import { pushChatEmojiRecent, userPrefsStore } from '~/composables/useUserPrefs'
import { startThread } from '~/composables/chatApi22'
import { stripChatMarkdown } from '~/utils/chatMarkdown'
import { writeClipboard } from '~/lib/clipboard'
import { UiIcon } from '~/components/ui/Icon'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { UiTooltip } from '~/components/ui/Tooltip'
import { ReactionGlyph } from './ChatReactions'
import { requestChatAiSummary } from './ChatAiSummary'
import { aiInlineStore, buttonState } from '~/composables/useAiInline'

/** 최근 리액션이 없을 때 */
export const DEFAULT_QUICK = ['👍', '👀', '🎉', '✅', '❤️', '😂']
export function quickReactions(recent: readonly string[] | null | undefined, n = 3): string[] {
  const out = [...(recent || [])].filter(Boolean).slice(0, n)
  for (const e of DEFAULT_QUICK) { if (out.length >= n) break; if (!out.includes(e)) out.push(e) }
  return out
}

// ─── Shift 누르고 있음(전역 하나) ───
const shiftStore = createStore<{ held: boolean }>()(() => ({ held: false }))
let _shiftHooked = false
function hookShift() {
  if (_shiftHooked || typeof window === 'undefined') return
  _shiftHooked = true
  const on = (e: KeyboardEvent) => { if (e.key === 'Shift') shiftStore.setState({ held: e.type === 'keydown' }) }
  window.addEventListener('keydown', on)
  window.addEventListener('keyup', on)
  window.addEventListener('blur', () => shiftStore.setState({ held: false }))
}
export function useShiftHeld(): boolean {
  useEffect(hookShift, [])
  return useStore(shiftStore, s => s.held)
}

export type MessageActionKey =
  | 'reply' | 'threadReply' | 'startThread' | 'save' | 'pin' | 'unread' | 'link' | 'copyText' | 'edit' | 'delete' | 'download' | 'dismissPreview'
  | 'aiSummary'

export interface ActionRunnerOpts {
  message: ChatMessage
  isOwn: boolean
  inThread?: boolean
  onOpenThread?: (messageId: string) => void
  onEdit?: () => void
  onDownload?: () => void
}

/** 메시지 동작 실행기(바 · ⋯ 메뉴 · 모바일 시트 · 단축키 공용) */
export function useMessageActionRunner(o: ActionRunnerOpts) {
  const { t } = useI18n()
  const L = useRef(o)
  L.current = o
  const canManage = canInChannel(o.message.channel_id, PERM.MANAGE_MESSAGES)
  const canPin = canInChannel(o.message.channel_id, PERM.PIN_MESSAGES)
  const canDelete = o.isOwn || canManage

  function react(emoji: string) {
    toggleReaction(L.current.message.id, emoji)
    pushChatEmojiRecent(emoji)
  }
  async function run(key: MessageActionKey) {
    const { message: m, isOwn, onOpenThread, onEdit, onDownload } = L.current
    try {
      switch (key) {
        case 'reply': {
          const name = m.sender?.display_name || m.sender?.username || ''
          setReplyTo({ channelId: m.channel_id, parentId: m.parent_id ?? null, messageId: m.id, senderId: m.sender?.id ?? null, senderName: name, ping: !isOwn && userPrefsStore.getState().prefs.chatReplyPing })
          break
        }
        case 'threadReply': onOpenThread?.(m.id); break
        case 'startThread': {
          const def = stripChatMarkdown(m.content).slice(0, 40)
          const name = await promptBox(t('chat.msg.actions.threadNamePrompt'), { title: t('chat.msg.actions.startThread'), defaultValue: def, confirmLabel: t('chat.msg.actions.startThreadOk') })
          if (name === null) return
          await startThread(m.id, name.trim() || null)
          onOpenThread?.(m.id)
          break
        }
        case 'save': await toggleSave(m.id); break
        case 'pin': await togglePin(m.id); break
        case 'edit': onEdit?.(); break
        case 'download': onDownload?.(); break
        case 'dismissPreview': await dismissLinkPreview(m.id); break
        case 'copyText':
          await writeClipboard(m.content || '')
          addToast('success', t('chat.message.textCopied'))
          break
        case 'link': {
          const q = new URLSearchParams({ channel: m.channel_id })
          if (m.parent_id) q.set('thread', m.parent_id)
          q.set('message', m.id)
          await writeClipboard(`${location.origin}/chat?${q.toString()}`)
          addToast('success', t('chat.message.linkCopied'))
          break
        }
        case 'unread': await markUnreadHere(m, t); break
        // 화면 안 AI — 이 메시지부터 끝까지 요약(목록 위 카드)
        case 'aiSummary': requestChatAiSummary(m.channel_id, m.id); break
        case 'delete': {
          if (!await confirmBox(t('chat.message.deleteConfirm'), { danger: true })) return
          await deleteMessage(m.id)
          break
        }
      }
    } catch (e: any) {
      console.error('message action error:', key, e)
      addToast('error', e?.data?.detail?.message || e?.data?.detail || t('error.genericError'))
    }
  }
  return { run, react, canDelete, canPin }
}

/** 여기부터 안 읽음(⋯ · 시트 · Alt+클릭) — 새 메시지 선이 그 줄 위로, 토스트 */
export async function markUnreadHere(m: Pick<ChatMessage, 'id' | 'channel_id'>, t: (k: string) => string) {
  await markUnread(m.channel_id, m.id)
  setUnreadAnchor({ channelId: m.channel_id, messageId: m.id })
  addToast('success', t('chat.msg.actions.markedUnread'))
}

export interface ChatMessageActionsProps {
  message: ChatMessage
  isOwn: boolean
  /** 보이기(호버·포커스 중) */
  visible?: boolean
  /** 내 메시지면 "수정" 항목 */
  canEdit?: boolean
  /** "다운로드" 항목 */
  canDownload?: boolean
  /** 스레드 패널 안 — "스레드로 답장"·안 읽음 표시를 뺀다 */
  inThread?: boolean
  onOpenThread?: (messageId: string) => void
  onEdit?: () => void
  onDownload?: () => void
  /** 메뉴가 열려 있는 동안 바를 붙잡아 두라는 신호 */
  onHold?: (held: boolean) => void
}

const BAR_BTN = 'flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-overlay-hover hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&>svg]:h-5 [&>svg]:w-5 [&>*]:transition-transform [&>*]:duration-200 hover:[&>*]:scale-110 motion-reduce:[&>*]:transition-none motion-reduce:hover:[&>*]:scale-100'

/** 데스크톱 호버 바 */
export function ChatMessageActions({
  message, isOwn, visible = false, canEdit = false, canDownload = false, inThread = false, onOpenThread, onEdit, onDownload, onHold,
}: ChatMessageActionsProps) {
  const { t } = useI18n()
  const saved = useStore(chatStore, s => isSaved(message.id, s))
  const recent = useStore(userPrefsStore, s => s.prefs.chatEmojiRecent)
  const shift = useShiftHeld()
  const pinned = !!message.pinned_at
  const { run, react, canDelete, canPin } = useMessageActionRunner({ message, isOwn, inThread, onOpenThread, onEdit, onDownload })
  // 화면 안 AI 를 쓸 수 있을 때만 "여기부터 요약"(상태는 목록 위 카드가 받아 둔 값)
  const aiReady = useStore(aiInlineStore, s => buttonState(s.status) === 'ready')

  const [menuOpen, setMenuOpen] = useState(false)
  const holdCb = useRef(onHold)
  holdCb.current = onHold
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    holdCb.current?.(menuOpen)
  }, [menuOpen])

  const moreItems: UiMenuItem[] = []
  if (isOwn && canEdit) moreItems.push({ key: 'edit', label: t('common.edit'), icon: 'edit-3', hint: 'E' })
  moreItems.push({ key: 'reply', label: t('chat.msg.actions.reply'), icon: 'reply', hint: 'R' })
  if (!inThread) {
    moreItems.push({ key: 'threadReply', label: t('chat.message.threadReply'), icon: 'threads', hint: 'T' })
    if (!message.thread && !(message.reply_count > 0)) moreItems.push({ key: 'startThread', label: t('chat.msg.actions.startThread'), icon: 'messages-square' })
  }
  if (canPin) moreItems.push({ key: 'pin', label: pinned ? t('chat.message.unpin') : t('chat.message.pin'), icon: 'pin' })
  if (!inThread) moreItems.push({ key: 'unread', label: t('chat.message.markUnread'), icon: 'mail-unread', hint: t('chat.msg.actions.altClick') })
  if (!inThread && aiReady) moreItems.push({ key: 'aiSummary', label: t('aiInline.chat.fromHere'), icon: 'sparkles' })
  moreItems.push({ key: 'link', label: t('chat.message.copyLink'), icon: 'link', separated: true })
  moreItems.push({ key: 'copyText', label: t('chat.message.copyText'), icon: 'copy' })
  if (canDownload) moreItems.push({ key: 'download', label: t('common.download'), icon: 'download' })
  if (canDelete) moreItems.push({ key: 'delete', label: t('common.delete'), icon: 'trash', danger: true, separated: true })

  const shown = visible || menuOpen
  const btn = (key: string, label: string, icon: string, onClick: (e: React.MouseEvent<HTMLButtonElement>) => void, extra?: { keys?: string[]; danger?: boolean; pressed?: boolean; filled?: boolean }) => (
    <UiTooltip key={key} text={label} keys={extra?.keys}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={extra?.pressed}
        className={cn(BAR_BTN, extra?.danger ? 'text-danger hover:text-danger' : '', extra?.pressed ? 'text-primary hover:text-primary' : '')}
        onClick={onClick}
      ><UiIcon name={icon} filled={extra?.filled} /></button>
    </UiTooltip>
  )

  return (
    <div
      role="toolbar"
      aria-label={t('chat.message.actions')}
      data-hover-bar=""
      className={cn(
        'absolute right-4 z-10 hidden items-center rounded-lg border border-border bg-popover shadow-md md:flex',
        shown ? '' : 'md:pointer-events-none md:opacity-0 md:focus-within:pointer-events-auto md:focus-within:opacity-100',
      )}
      style={{ top: -16, padding: 2 }}
    >
      {quickReactions(recent).map(e => (
        <UiTooltip key={'q' + e} text={t('chat.message.quickReact', { emoji: e })}>
          <button type="button" aria-label={t('chat.message.quickReact', { emoji: e })} className={cn(BAR_BTN, 'text-[18px]')} onClick={() => react(e)}>
            <ReactionGlyph emoji={e} className="inline-block" />
          </button>
        </UiTooltip>
      ))}
      <span className="mx-0.5 h-6 w-px bg-border" aria-hidden="true" />
      {btn('react', t('chat.message.addReaction'), 'smile-plus', e => setEmojiPicker({ mode: 'react', messageId: message.id, anchor: anchorOf(e.currentTarget) }))}
      {btn('reply', t('chat.msg.actions.reply'), 'reply', () => { void run('reply') }, { keys: ['R'] })}
      {!inThread && btn('thread', t('chat.message.threadReply'), 'threads', () => { void run('threadReply') }, { keys: ['T'] })}
      {btn('save', saved ? t('chat.message.unsave') : t('chat.message.save'), 'bookmark', () => { void run('save') }, { keys: ['S'], pressed: saved, filled: saved })}
      {shift && canPin && btn('pin', pinned ? t('chat.message.unpin') : t('chat.message.pin'), 'pin', () => { void run('pin') }, { pressed: pinned })}
      {shift && canDelete && btn('delete', t('common.delete'), 'trash', () => { void run('delete') }, { danger: true })}
      <UiMenu
        items={moreItems}
        label={t('chat.message.more')}
        width={224}
        sheet={false}
        onSelect={(k) => { void run(k as MessageActionKey) }}
        onOpen={() => setMenuOpen(true)}
        onClose={() => setMenuOpen(false)}
        trigger={({ toggle, open, controls }) => (
          <UiTooltip text={t('chat.message.more')}>
            <button type="button" aria-label={t('chat.message.more')} aria-haspopup="menu" aria-expanded={open} aria-controls={controls} className={BAR_BTN} onClick={toggle}>
              <UiIcon name="more-horizontal" />
            </button>
          </UiTooltip>
        )}
      />
    </div>
  )
}

export default ChatMessageActions
