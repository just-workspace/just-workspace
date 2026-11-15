/**
 * 컴포저.
 * Vue 원본: frontend/components/chat/ChatInput.vue → 디스코드식 한 줄 카드로 바꿨다.
 *
 * 데스크톱: 한 줄 카드 56(입력 16/22, 위아래 17) · 좌우 인셋 8 · radius 8 · 1px · 최대 50vh 후 스크롤.
 *   왼쪽 ⊕(첨부 메뉴) · 오른쪽 버튼 32 간격 8(Aa · 이모지) · 전송 버튼 없음(Enter).
 *   카드 위 띠 32(답장 · 수정 · @everyone 확인 — ChatComposerBars)가 붙으면 카드는 아래 모서리만 둥글다.
 *   카드 안 위쪽: 첨부 줄(스포일러 · ALT · ✕) → Aa 서식줄(ChatFormatBar). 아래 24 = 입력 중 표시 예약 자리(typing prop).
 * 모바일: ⊕ 44 + 둥근 입력 44(이모지 안쪽) + 글을 쓰면 전송 버튼 44.
 * 자동완성 `:`(2글자부터) · `@`(사람 · 역할 · @here/@everyone) — ChatAutocomplete. 이모지 피커 — ChatEmojiPicker(Ctrl+E).
 * @silent: 입력 앞 `@silent ` 는 접두 칩(muted 600)으로 바뀌고 오른쪽에 "알림 없이 보냅니다". 보낼 때 silent=true, 본문에서 뗀다.
 * @everyone/@here: 권한이 있으면 첫 Enter 는 확인 띠만, 두 번째 Enter 에 보낸다. 권한이 없으면 아래 info 한 줄(글자로만 감).
 * 답장: useChatUi.replyTo(같은 채널·같은 스레드) → 보낼 때 reply_to_id/reply_ping. @ 스위치 값은 사람마다 기억(setChatReplyPing).
 * 수정: useChatUi.editRequest(행 "수정" · 빈 입력 ↑)를 이 컴포저가 받아 띠 + 본문을 채운다. Enter 저장 · Esc 취소.
 * 첨부: 트레이(useChatAttachments)에 모았다가 보내기 = 메시지 하나(chatApi22.postAttachments, 최대 10). 붙여넣기·끌어 놓기 유지.
 * 스레드 패널도 같은 컴포저(mode="thread"): 임시글은 (채널, 루트) 단위.
 */
import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useStore } from 'zustand'
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { authStore } from '~/composables/useAuth'
import {
  chatStore, clearDraft, draftFor, editMessage, flushDraft, setDraft, useChat, type SendOptions,
} from '~/composables/useChat'
import { chatUiStore, setEditingMessageId, setEditRequest, setReplyTo } from '~/composables/useChatUi'
import { MAX_ATTACHMENTS, useChatAttachments, type ChatAttachment } from '~/composables/useChatAttachments'
import { pushChatEmojiRecent, setChatReplyPing, userPrefsStore } from '~/composables/useUserPrefs'
import { PERM, canInChannel, chatRolesStore, loadMyChannelPerms, loadRoles, rolesOfUser, userRoleColor } from '~/composables/useChatRoles'
import { addToast } from '~/composables/useToast'
import { useIsMobile } from '~/composables/useIsMobile'
import { useUiMentionList } from '~/components/ui/MentionList'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiMenu } from '~/components/ui/Menu'
import { UiModal } from '~/components/ui/Modal'
import { UiTextarea } from '~/components/ui/Textarea'
import { UiButton } from '~/components/ui/Button'
import { ChatAutocomplete, emojiCandidates, findTrigger, mentionCandidates, type AcItem, type AcTrigger } from './ChatAutocomplete'
import { ChatComposerBar, type ComposerBand } from './ChatComposerBars'
import { ChatFormatBar, applyFormat, formatForShortcut, type FormatKind } from './ChatFormatBar'
import { closeEmojiPicker, openComposeEmojiPicker } from './ChatEmojiPicker'

export interface ChatInputProps {
  /** channel(기본) · thread(스레드 패널 답글) */
  mode?: 'channel' | 'thread'
  /** 스레드 루트 id(mode=thread) */
  parentId?: string | null
  /** 자리표시 글자. 없으면 "#채널에 메시지 보내기" */
  placeholder?: string
  /** 스레드: "채널에도 보내기" — 첨부 답글에도 같은 값을 쓴다 */
  alsoToChannel?: boolean
  /** 보내기(본문, 종류, 파일 메타, 옵션 — 답장·@silent) */
  onSend?: (content: string, messageType?: string, fileMeta?: string | null, opts?: SendOptions) => void
  /** 입력 중(채널 컴포저만) */
  onTyping?: () => void
  /** 스레드 첨부를 보냈다(부모가 "채널에도 보내기"를 되돌리게) */
  onFilesSent?: () => void
  /** 아래 24 예약 자리(입력 중 표시) — 데스크톱 채널 컴포저 */
  typing?: ReactNode
}

// ─── 순수 도우미(테스트 대상) ───

const SILENT_RE = /^@silent(?:\s+|$)/
/** 입력 앞 @silent → { silent, body } */
export function splitSilent(text: string): { silent: boolean; body: string } {
  return SILENT_RE.test(text) ? { silent: true, body: text.replace(SILENT_RE, '') } : { silent: false, body: text }
}
/** 본문의 @everyone / @here(코드 안은 빼고). 둘 다면 everyone */
export function detectEveryone(text: string): 'everyone' | 'here' | null {
  const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
  if (/(^|[^\w@])@everyone\b/.test(plain)) return 'everyone'
  if (/(^|[^\w@])@here\b/.test(plain)) return 'here'
  return null
}
/** Enter 를 눌렀을 때: 'arm' = 확인 띠만 · 'send' = 보내기 */
export function enterAction(o: { text: string; silent: boolean; canEveryone: boolean; armed: boolean }): 'arm' | 'send' {
  if (o.silent || !o.canEveryone || o.armed) return 'send'
  return detectEveryone(o.text) ? 'arm' : 'send'
}
/** 보내기 옵션 */
export function buildSendOptions(o: { silent: boolean; reply: { messageId: string; ping: boolean } | null }): SendOptions {
  const out: SendOptions = {}
  if (o.reply) { out.reply_to_id = o.reply.messageId; out.reply_ping = o.reply.ping }
  if (o.silent) out.silent = true
  return out
}

function hasFiles(e: DragEvent) {
  return Array.from(e.dataTransfer?.types || []).includes('Files')
}

/** 메시지 작성 상자 */
export function ChatInput({ mode = 'channel', parentId = null, placeholder, alsoToChannel = false, onSend, onTyping, onFilesSent, typing }: ChatInputProps) {
  const { t } = useI18n()
  const chat = useChat()
  const members = chat.members
  const selectedChannel = chat.selectedChannel
  const selectedChannelId = chat.selectedChannelId
  const myId = useStore(authStore, s => s.user?.id)
  const allUsers = useStore(chatStore, s => s.allUsers)
  const filePickerTick = useStore(chatUiStore, s => s.filePickerTick)
  const isThread = mode === 'thread'
  const parent = isThread ? parentId : null
  const mobile = useIsMobile()

  // 첨부 트레이
  const attachmentsApi = useChatAttachments()
  const tray = attachmentsApi.forChannel(selectedChannelId, parent)
  const hasTooLarge = tray.some(a => a.tooLarge)

  const [content, setContentState] = useState('')
  const contentRef = useRef('')
  function setContent(v: string) { contentRef.current = v; setContentState(v) }
  const [silent, setSilentState] = useState(false)
  const silentRef = useRef(false)
  function setSilent(v: boolean) { silentRef.current = v; setSilentState(v) }
  const fileInput = useRef<HTMLInputElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [showFormat, setShowFormat] = useState(false)
  const [armed, setArmed] = useState<'everyone' | 'here' | null>(null)
  const [editing, setEditing] = useState<{ id: string; saved: string; savedSilent: boolean } | null>(null)
  const editingRef = useRef(editing)
  editingRef.current = editing
  const [altFor, setAltFor] = useState<ChatAttachment | null>(null)
  const [altText, setAltText] = useState('')
  const pickerOpen = useStore(chatUiStore, s => s.emojiPicker?.mode === 'compose')

  // Vue nextTick — 다음 렌더가 DOM 에 반영된 뒤 실행할 일
  const afterRender = useRef<Array<() => void>>([])
  const [, bump] = useState(0)
  function nextTick(fn: () => void) { afterRender.current.push(fn); bump(n => n + 1) }
  useEffect(() => {
    if (!afterRender.current.length) return
    const q = afterRender.current
    afterRender.current = []
    for (const fn of q) fn()
  })

  const placeholderText = (() => {
    if (placeholder) return placeholder
    const ch = selectedChannel
    if (!ch) return t('chat.input.placeholder')
    return t('chat.input.placeholderIn', { channel: ch.type === 'dm' ? chat.getDMDisplayName(ch) : `#${ch.name}` })
  })()

  // 권한(@everyone) — 채널 권한을 읽어 둔다(어댑터, 실패하면 기본값)
  const myPerms = useStore(chatRolesStore, s => (selectedChannelId ? s.myChannelPerms[selectedChannelId] : undefined))
  const roles = useStore(chatRolesStore, s => s.roles)
  useStore(chatRolesStore, s => s.catalog)
  useEffect(() => {
    void loadRoles()
    if (selectedChannelId) void loadMyChannelPerms(selectedChannelId)
  }, [selectedChannelId])
  const canEveryone = (void myPerms, canInChannel(selectedChannelId, PERM.MENTION_EVERYONE))
  const memberCount = members.length
  const onlineCount = members.filter(m => m.is_online).length

  // 답장(이 컴포저 자리만)
  const replyRaw = useStore(chatUiStore, s => s.replyTo)
  const reply = replyRaw && replyRaw.channelId === selectedChannelId && (replyRaw.parentId || null) === (parent || null) ? replyRaw : null
  useEffect(() => { if (reply) textareaRef.current?.focus() }, [reply?.messageId])  // eslint-disable-line react-hooks/exhaustive-deps

  // 자동 높이(최대 50vh — 넘으면 스크롤)
  function autoGrow() {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const max = Math.round((typeof window !== 'undefined' ? window.innerHeight : 800) * 0.5)
    el.style.height = Math.min(el.scrollHeight, max) + 'px'
  }

  /** @silent 접두를 칩으로 */
  function applyText(v: string) {
    const s = splitSilent(v)
    if (s.silent && !silentRef.current) { setSilent(true); setContent(s.body); return true }
    setContent(v)
    return false
  }

  // 커서 위치에 삽입
  function insertAtCursor(text: string) {
    const el = textareaRef.current
    const cur = contentRef.current
    const start = el?.selectionStart ?? cur.length
    const end = el?.selectionEnd ?? cur.length
    setContent(cur.slice(0, start) + text + cur.slice(end))
    nextTick(() => {
      if (el) { const p = start + text.length; el.selectionStart = el.selectionEnd = p; el.focus() }
      autoGrow()
    })
  }

  function doFormat(kind: FormatKind) {
    const el = textareaRef.current
    const cur = contentRef.current
    const r = applyFormat(kind, cur, el?.selectionStart ?? cur.length, el?.selectionEnd ?? cur.length)
    setContent(r.text)
    nextTick(() => { if (el) { el.focus(); el.selectionStart = r.start; el.selectionEnd = r.end } autoGrow() })
  }

  function toggleEmoji() {
    if (pickerOpen) { closeEmojiPicker(); return }
    openComposeEmojiPicker(cardRef.current, insertAtCursor)
  }

  // 임시글 — 서버 저장(useChat 이 1초 디바운스로 PUT). 채널 입력창은 (채널), 스레드 입력창은 (채널, 루트) 단위.
  const scopeReady = (id: string | null, pid: string | null) => !!id && (!isThread || !!pid)
  const scopeRef = useRef<[string | null, string | null]>([selectedChannelId, parent])
  scopeRef.current = [selectedChannelId, parent]
  const fullText = (silent ? '@silent ' : '') + content

  const firstContent = useRef(true)
  useEffect(() => {
    if (firstContent.current) { firstContent.current = false; return }
    if (editingRef.current) return   // 수정 중인 글은 임시글이 아니다
    const [id, pid] = scopeRef.current
    if (!scopeReady(id, pid) || fullText === draftFor(id!, pid)) return
    setDraft(id!, pid, fullText)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullText])

  // 자리 바뀜 — 떠나는 곳은 바로 저장, 새 자리의 임시글로 채운다
  const prevScope = useRef<[string | null, string | null] | null>(null)
  useEffect(() => {
    const prev = prevScope.current
    prevScope.current = [selectedChannelId, parent]
    if (prev && scopeReady(prev[0], prev[1])) void flushDraft(prev[0]!, prev[1])
    if (editingRef.current) { setEditing(null); setEditingMessageId(null) }
    setArmed(null)
    setSilent(false)
    applyText(scopeReady(selectedChannelId, parent) ? draftFor(selectedChannelId!, parent) : '')
    nextTick(autoGrow)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChannelId, parent])

  // 임시글 목록이 늦게 도착하거나 다른 기기에서 바뀐 경우 — 지금 입력 중인 글은 덮지 않는다
  useStore(chatStore, s => s.drafts)
  const scopeDraft = scopeReady(selectedChannelId, parent) ? draftFor(selectedChannelId!, parent) : ''
  const firstScopeDraft = useRef(true)
  useEffect(() => {
    if (firstScopeDraft.current) { firstScopeDraft.current = false; return }
    if (!contentRef.current && !silentRef.current && !editingRef.current && scopeDraft) { applyText(scopeDraft); nextTick(autoGrow) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeDraft])

  // 채널 소개 "파일 올리기" · Ctrl+U — 채널 컴포저만 응답
  const firstTick = useRef(true)
  useEffect(() => {
    if (firstTick.current) { firstTick.current = false; return }
    if (!isThread) triggerFileUpload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePickerTick])

  // 수정 요청 — 이 컴포저 자리의 메시지면 받는다(스레드 안 메시지는 스레드 컴포저)
  const editRequest = useStore(chatUiStore, s => s.editRequest)
  useEffect(() => {
    if (!editRequest) return
    const st = chatStore.getState()
    const inThread = st.threadMessages.find(m => m.id === editRequest)
    const msg = isThread ? inThread : (inThread ? null : st.messages.find(m => m.id === editRequest))
    // 스레드 안 메시지는 스레드 컴포저 몫 — 그 밖에 못 찾은 요청은 지운다(안 지우면 같은 메시지를 다시 "수정"해도 반응이 없다)
    if (!isThread && inThread) return
    if (!msg || msg.sender?.id !== myId) { setEditRequest(null); return }
    setEditRequest(null)
    setEditing({ id: msg.id, saved: contentRef.current, savedSilent: silentRef.current })
    setEditingMessageId(msg.id)
    setSilent(false)
    setArmed(null)
    setContent(msg.content || '')
    nextTick(() => { const el = textareaRef.current; if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length } autoGrow() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRequest])
  function endEdit() {
    const e = editingRef.current
    if (!e) return
    setEditing(null)
    setEditingMessageId(null)
    setContent(e.saved)
    setSilent(e.savedSilent)
    nextTick(autoGrow)
  }
  async function saveEdit() {
    const e = editingRef.current
    if (!e) return
    const text = contentRef.current.trim()
    const orig = chatStore.getState().messages.find(m => m.id === e.id) || chatStore.getState().threadMessages.find(m => m.id === e.id)
    if (!text || text === (orig?.content || '').trim()) { endEdit(); return }
    // 성공한 뒤에 닫는다 — 먼저 닫으면 실패했을 때 고친 글이 사라진다
    try { await editMessage(e.id, text); if (editingRef.current?.id === e.id) endEdit() } catch (err) {
      console.error('editMessage error:', err)
      addToast('error', t('chat.compose.edit.failed'))
    }
  }

  // ─── 자동완성 ───
  const [trigger, setTrigger] = useState<AcTrigger | null>(null)
  const [acDismissedAt, setAcDismissedAt] = useState<number | null>(null)
  const skin = useStore(userPrefsStore, s => s.prefs.chatEmojiSkin)
  const acItems: AcItem[] = (() => {
    if (!trigger || acDismissedAt === trigger.start) return []
    if (trigger.kind === 'emoji') return emojiCandidates(trigger.query, skin, t)
    return mentionCandidates(trigger.query, {
      members, users: allUsers, roles, canEveryone, memberCount, onlineCount, myId, t,
      roleNameOf: uid => rolesOfUser(uid).find(r => !r.is_default)?.name ?? null,
      roleColorOf: uid => userRoleColor(uid),
    })
  })()
  const acOpen = !!trigger && acItems.length > 0
  const ac = useUiMentionList({
    count: acItems.length,
    open: acOpen,
    onPick: i => pickAc(acItems[i]),
    onClose: () => { if (trigger) setAcDismissedAt(trigger.start) },
    idPrefix: 'chat-ac',
    isDisabled: i => !!acItems[i]?.disabled,
  })
  function checkTrigger() {
    const el = textareaRef.current
    if (!el) return
    const tr = findTrigger(contentRef.current, el.selectionStart ?? 0)
    setTrigger(tr)
    if (!tr) setAcDismissedAt(null)
  }
  function pickAc(it: AcItem | undefined) {
    if (!it || it.disabled || !trigger) return
    const cur = contentRef.current
    const before = cur.slice(0, trigger.start)
    const after = cur.slice(trigger.end)
    const ins = it.insert + (after.startsWith(' ') ? '' : ' ')
    setContent(before + ins + after)
    if (it.recentKey) pushChatEmojiRecent(it.recentKey)
    setTrigger(null)
    nextTick(() => { const el = textareaRef.current; if (el) { const p = before.length + ins.length; el.selectionStart = el.selectionEnd = p; el.focus() } autoGrow() })
  }

  // ─── 보내기 ───
  const enterMode = useStore(userPrefsStore, s => s.prefs.chatEnterKey)
  const canSend = !editing && (content.trim().length > 0 || tray.length > 0) && !hasTooLarge && tray.length <= MAX_ATTACHMENTS
  const detected = !silent ? detectEveryone(content) : null

  function submit() {
    if (editingRef.current) { void saveEdit(); return }
    const text = contentRef.current.trim()
    if (!text && tray.length === 0) return
    if (hasTooLarge) { addToast('error', t('chat.compose.attach.tooLargeSend')); return }
    if (enterAction({ text, silent: silentRef.current, canEveryone, armed: !!armed }) === 'arm') { setArmed(detectEveryone(text)); return }
    const opts = buildSendOptions({ silent: silentRef.current, reply: reply ? { messageId: reply.messageId, ping: reply.ping } : null })
    if (tray.length && selectedChannelId) {
      attachmentsApi.sendAttachments(selectedChannelId, tray.map(a => a.id), {
        content: text, ...opts, parent_id: parent, ...(isThread ? { also_to_channel: alsoToChannel } : {}),
      })
      if (isThread) onFilesSent?.()
    } else {
      onSend?.(text, 'text', null, opts)
    }
    setContent('')
    setSilent(false)
    setArmed(null)
    if (reply) setReplyTo(null)
    if (selectedChannelId) void clearDraft(selectedChannelId, parent, { remote: false })
    setTrigger(null)
    nextTick(autoGrow)
  }

  function onKeydown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // 한글 조합 중의 키는 IME 것 — 여기서 Enter 를 보내기로 처리하면 마지막 글자가 남거나 한 번 더 전송된다
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    // 자동완성(↑↓ · Enter/Tab · Esc)
    if (ac.onKeyDown(e)) return

    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase()
      if (k === 'e' && !e.shiftKey) { e.preventDefault(); toggleEmoji(); return }
      if (k === 'u' && !e.shiftKey) { e.preventDefault(); triggerFileUpload(); return }
      const f = formatForShortcut(e.key, e.shiftKey)
      if (f) { e.preventDefault(); doFormat(f); return }
    }

    if (e.key === 'Escape') {
      if (armed) { e.preventDefault(); e.stopPropagation(); setArmed(null); return }
      if (editingRef.current) { e.preventDefault(); e.stopPropagation(); endEdit(); return }
      if (reply) { e.preventDefault(); e.stopPropagation(); setReplyTo(null); return }
      return
    }

    // @silent 칩 지우기 — 맨 앞에서 Backspace 면 글자로 되돌린다
    if (e.key === 'Backspace' && silentRef.current) {
      const el = e.currentTarget
      if (el.selectionStart === 0 && el.selectionEnd === 0) {
        e.preventDefault()
        setSilent(false)
        setContent('@silent' + contentRef.current)
        nextTick(() => { el.selectionStart = el.selectionEnd = 7 })
        return
      }
    }

    // 빈 입력창에서 ↑ — 마지막 내 메시지 수정
    if (e.key === 'ArrowUp' && !contentRef.current && !editingRef.current && !e.shiftKey) {
      const list = isThread ? chatStore.getState().threadMessages : chatStore.getState().messages
      const mine = [...list].reverse().find(m => m.sender?.id === myId && m.message_type === 'text' && !m._upload && !m.is_deleted)
      if (mine) { e.preventDefault(); setEditRequest(mine.id) }
      return
    }

    // Enter: send = Enter 보내기·Shift+Enter 줄바꿈, newline = Enter 줄바꿈·Ctrl(⌘)+Enter 보내기. 터치 키보드는 줄바꿈(보내기는 버튼).
    if (e.key === 'Enter' && !e.shiftKey) {
      const touch = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches
      const mod = e.ctrlKey || e.metaKey
      if (touch && !mod) return
      if (enterMode === 'newline' && !mod && !editingRef.current) return
      e.preventDefault()
      submit()
    }
  }

  function onChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const converted = applyText(e.target.value)
    if (armed && !detectEveryone(converted ? splitSilent(e.target.value).body : e.target.value)) setArmed(null)
    if (!isThread && !editingRef.current) onTyping?.()
    nextTick(() => { checkTrigger(); autoGrow() })
  }

  function triggerFileUpload() {
    fileInput.current?.click()
  }

  function addToTray(files: FileList | File[] | null | undefined, fromPaste = false) {
    if (!files || files.length === 0 || !selectedChannelId) return
    if (isThread && !parent) return
    attachmentsApi.addFiles(selectedChannelId, files, { fromPaste, parentId: parent })
  }

  function onFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const target = e.target
    addToTray(target.files)
    target.value = ''
  }

  // 붙여넣기 — 클립보드에 파일(스크린샷 등)이 있으면 텍스트 대신 첨부로
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = e.clipboardData?.files
    if (!files || files.length === 0) return
    e.preventDefault()
    addToTray(files, true)
  }

  // 컴포저 자체 드롭(대화 영역 오버레이가 먼저 받지만, 단독 사용 대비)
  const [dragOverComposer, setDragOverComposer] = useState(false)
  function onDragOver(e: DragEvent) {
    if (!hasFiles(e)) return
    e.preventDefault()
    setDragOverComposer(true)
  }
  function onDragLeave() { setDragOverComposer(false) }
  function onDrop(e: DragEvent) {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.stopPropagation()   // 부모(ChatConversation 오버레이)의 drop 과 이중 추가 방지
    setDragOverComposer(false)
    addToTray(e.dataTransfer?.files)
  }

  // ─── 띠 ───
  let band: ComposerBand | null = null
  if (editing) band = { kind: 'edit', onClose: endEdit }
  else if (armed && canEveryone) band = { kind: 'everyone', which: armed, count: armed === 'here' ? onlineCount : memberCount, onClose: () => setArmed(null) }
  else if (reply) {
    band = {
      kind: 'reply', name: reply.senderName, ping: reply.ping,
      onTogglePing: () => { const v = !reply.ping; setReplyTo({ ...reply, ping: v }); setChatReplyPing(v) },
      onClose: () => setReplyTo(null),
    }
  }
  const hint = detected && !canEveryone && !editing ? t('chat.compose.everyone.noPerm', { which: `@${detected}` }) : ''

  const attachItems = [
    { key: 'upload', label: t('chat.compose.attach.upload'), icon: 'upload', hint: 'Ctrl+U' },
    { key: 'files', label: t('chat.input.attachFromFiles'), icon: 'folder', disabled: true, hint: t('chat.input.soon') },
  ]
  const canAttach = (!isThread || !!parentId) && !editing

  const attachRow = tray.length > 0 && !editing && (
    <div className="flex gap-3 overflow-x-auto border-b border-border p-3" role="list" aria-label={t('chat.input.tray.label')}>
      {tray.map(a => (
        <AttachTile
          key={a.id}
          a={a}
          onSpoiler={() => attachmentsApi.setSpoiler(a.id, !a.spoiler)}
          onAlt={() => { setAltFor(a); setAltText(a.alt || '') }}
          onRemove={() => attachmentsApi.remove(a.id)}
          formatSize={attachmentsApi.formatSize}
        />
      ))}
    </div>
  )

  const fileInputEl = <input ref={fileInput} type="file" multiple className="hidden" onChange={onFileSelected} />

  const attachMenu = (big: boolean) => (
    <UiMenu
      items={attachItems}
      label={t('chat.compose.attach.menu')}
      align="start"
      side="top"
      width={240}
      onSelect={(k) => { if (k === 'upload') triggerFileUpload() }}
      trigger={({ toggle, open, controls }) => (
        <button
          type="button"
          aria-label={t('chat.compose.attach.menu')}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={controls}
          disabled={!selectedChannelId || !canAttach}
          className={cn(
            'flex shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground disabled:opacity-50',
            big ? 'h-11 w-11' : 'mt-3 h-8 w-8 hover:bg-overlay-hover',
          )}
          onClick={toggle}
        ><UiIcon name="plus-circle" className="h-[22px] w-[22px]" /></button>
      )}
    />
  )

  const textarea = (
    <textarea
      ref={textareaRef}
      value={content}
      autoComplete="off"
      rows={1}
      placeholder={editing ? t('chat.compose.edit.placeholder') : placeholderText}
      aria-label={editing ? t('chat.compose.edit.title') : placeholderText}
      {...ac.inputProps}
      className={cn(
        'block min-w-0 flex-1 resize-none overflow-y-auto bg-transparent text-[16px] leading-[22px] text-foreground placeholder:text-muted-foreground focus:outline-hidden',
        mobile ? 'max-h-[40dvh] py-[11px]' : 'max-h-[50vh] px-1 py-[17px]',
      )}
      onKeyDown={onKeydown}
      onChange={onChange}
      onPaste={onPaste}
      onClick={checkTrigger}
      onKeyUp={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') checkTrigger() }}
      onBlur={() => setTrigger(null)}
    />
  )

  const silentChip = silent && (
    <span className={cn('shrink-0 font-semibold text-muted-foreground', mobile ? 'self-center' : 'self-start pt-[17px] text-[16px] leading-[22px]')} aria-label={t('chat.compose.silent.chipAria')}>@silent</span>
  )
  const silentHint = silent && (
    <span className="flex shrink-0 items-center gap-1 self-center text-[12px] text-muted-foreground" role="status">
      <UiIcon name="bell-off" className="h-4 w-4" />{!mobile && t('chat.compose.silent.hint')}
    </span>
  )

  const autocomplete = acOpen && trigger && (
    <ChatAutocomplete id={ac.id} trigger={trigger} items={acItems} activeIndex={ac.active} onActiveChange={ac.setActive} onPick={i => pickAc(acItems[i])} />
  )

  const altModal = altFor && (
    <UiModal
      size="sm"
      title={t('chat.compose.attach.altTitle')}
      onClose={() => setAltFor(null)}
      footer={(
        <>
          <UiButton variant="ghost" onClick={() => setAltFor(null)}>{t('common.cancel')}</UiButton>
          <UiButton onClick={() => { attachmentsApi.setAlt(altFor.id, altText); setAltFor(null); textareaRef.current?.focus() }}>{t('common.save')}</UiButton>
        </>
      )}
    >
      <p className="mb-2 truncate text-[13px] text-muted-foreground">{altFor.name}</p>
      <UiTextarea modelValue={altText} onUpdateModelValue={setAltText} rows={3} maxLength={1024} placeholder={t('chat.compose.attach.altPh')} data-autofocus="" />
      <p className="mt-1 text-[12px] text-muted-foreground">{t('chat.compose.attach.altHint')}</p>
    </UiModal>
  )

  // ─── 모바일 ───
  if (mobile) {
    const showSend = canSend || !!editing
    return (
      <div className="relative shrink-0 bg-background px-2 pb-[calc(12px+env(safe-area-inset-bottom))] pt-1" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        {autocomplete}
        {band && <ChatComposerBar band={band} mobile />}
        {tray.length > 0 && !editing && <div className="mx-1 mb-1 overflow-hidden rounded-lg border border-border bg-card">{attachRow}</div>}
        <div className="flex items-end gap-1">
          {canAttach && attachMenu(true)}
          {fileInputEl}
          <div ref={cardRef} className={cn('flex min-h-11 min-w-0 flex-1 items-center gap-1 rounded-[22px] border bg-card pl-4 pr-1', dragOverComposer ? 'border-primary' : 'border-border')}>
            {silentChip}
            {textarea}
            {silentHint}
            <UiIconButton icon="smile" label={t('chat.compose.emoji.button')} data-emoji-toggle="" aria-expanded={pickerOpen} className="h-10 w-10 shrink-0 self-end" onClick={toggleEmoji} />
          </div>
          {showSend && (
            <UiIconButton icon="send" variant="solid" label={editing ? t('chat.compose.edit.save') : t('chat.input.send')} className="h-11 w-11 shrink-0 rounded-full" onMouseDown={e => e.preventDefault()} onClick={submit} />
          )}
        </div>
        {hint && <p className="mt-1 flex items-center gap-1.5 px-1 text-[12px] text-muted-foreground"><UiIcon name="info" className="h-3.5 w-3.5 shrink-0" />{hint}</p>}
        {altModal}
      </div>
    )
  }

  // ─── 데스크톱 ───
  return (
    <div
      className={cn('relative shrink-0 bg-background', isThread ? '' : 'px-4 pb-6')}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {autocomplete}
      {band && <ChatComposerBar band={band} />}
      <div
        ref={cardRef}
        className={cn(
          'border bg-card transition-[border-color]',
          band ? 'rounded-b-lg' : 'rounded-lg',
          dragOverComposer ? 'border-primary' : 'border-border',
        )}
      >
        {attachRow}
        {showFormat && !editing && <ChatFormatBar onFormat={doFormat} />}
        <div className="flex items-start gap-1 px-2">
          {canAttach && attachMenu(false)}
          {fileInputEl}
          {silentChip}
          {textarea}
          {silentHint}
          <div className="mt-3 flex shrink-0 items-center gap-2">
            <button
              type="button"
              aria-label={t('chat.compose.format.toggle')}
              aria-pressed={showFormat}
              title={t('chat.compose.format.toggle')}
              className={cn('flex h-8 w-8 items-center justify-center rounded-md text-[14px] font-semibold hover:bg-overlay-hover', showFormat ? 'bg-overlay-selected text-foreground' : 'text-muted-foreground hover:text-foreground')}
              onMouseDown={e => e.preventDefault()}
              onClick={() => setShowFormat(v => !v)}
            >Aa</button>
            <button
              type="button"
              data-emoji-toggle=""
              aria-label={t('chat.compose.emoji.buttonKeys')}
              aria-expanded={pickerOpen}
              title={t('chat.compose.emoji.buttonKeys')}
              className={cn('flex h-8 w-8 items-center justify-center rounded-md hover:bg-overlay-hover', pickerOpen ? 'bg-overlay-selected text-foreground' : 'text-muted-foreground hover:text-foreground')}
              onMouseDown={e => e.preventDefault()}
              onClick={toggleEmoji}
            ><UiIcon name="smile" className="h-5 w-5" /></button>
          </div>
        </div>
      </div>
      {hint && <p className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground"><UiIcon name="info" className="h-3.5 w-3.5 shrink-0" />{hint}</p>}
      {!isThread && <div className="absolute inset-x-4 bottom-0 flex h-6 items-center">{typing}</div>}
      {altModal}
    </div>
  )
}

/** 첨부 줄 항목 — 오른쪽 위 스포일러(eye-off) · ALT · ✕(danger) */
function AttachTile({ a, onSpoiler, onAlt, onRemove, formatSize }: {
  a: ChatAttachment; onSpoiler: () => void; onAlt: () => void; onRemove: () => void; formatSize: (n: number) => string
}) {
  const { t } = useI18n()
  const btn = 'flex h-6 items-center justify-center rounded-md border border-border bg-popover hover:bg-overlay-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring'
  return (
    <div role="listitem" aria-label={a.name} className="relative shrink-0">
      {a.isImage && a.previewUrl
        ? (
          <div className={cn('relative flex h-24 w-40 items-end overflow-hidden rounded-lg bg-muted p-2', a.tooLarge ? 'ring-2 ring-danger' : '')}>
            <img src={a.previewUrl} alt={a.alt || ''} className={cn('absolute inset-0 h-full w-full object-cover', a.spoiler ? 'blur-md' : '')} />
            {a.spoiler && <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-background/80 px-2 text-[11px] font-semibold">{t('chat.compose.attach.spoilerPill')}</span>}
            <span className="relative truncate rounded bg-background/70 px-1 font-mono text-[11px] text-muted-foreground">{a.name}</span>
          </div>
        )
        : (
          <div className={cn('relative flex h-24 w-52 flex-col justify-center gap-1 rounded-lg border px-4', a.tooLarge ? 'border-danger' : 'border-border')}>
            <UiIcon name={a.mimeType === 'application/pdf' || /\.pdf$/i.test(a.name) ? 'file-pdf' : 'file'} className={cn('h-6 w-6', /\.pdf$/i.test(a.name) ? 'text-danger' : 'text-muted-foreground')} />
            <span className="truncate text-[13px] font-medium">{a.name}</span>
            <span className="font-mono text-[11px] text-muted-foreground">{formatSize(a.size)}{a.spoiler ? ` · ${t('chat.compose.attach.spoilerPill')}` : ''}</span>
          </div>
        )}
      {a.tooLarge && <p className="mt-1 w-40 text-[11px] font-semibold text-danger" role="alert">{t('chat.compose.attach.tooLarge')}</p>}
      <div className="absolute -right-2 -top-2 flex gap-1">
        <button type="button" aria-label={t('chat.compose.attach.spoiler')} aria-pressed={a.spoiler} title={t('chat.compose.attach.spoiler')} className={cn(btn, 'w-6', a.spoiler ? 'bg-overlay-selected text-foreground' : 'text-muted-foreground')} onClick={onSpoiler}>
          <UiIcon name="eye-off" className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label={t('chat.compose.attach.alt')} aria-pressed={!!a.alt} title={a.alt || t('chat.compose.attach.alt')} className={cn(btn, 'px-1 font-mono text-[10px] font-bold', a.alt ? 'text-primary' : 'text-muted-foreground')} onClick={onAlt}>ALT</button>
        <button type="button" aria-label={t('chat.compose.attach.remove')} title={t('chat.compose.attach.remove')} className={cn(btn, 'w-6 text-danger')} onClick={onRemove}>
          <UiIcon name="close" className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

export default ChatInput
