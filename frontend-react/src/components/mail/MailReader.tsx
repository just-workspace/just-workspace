/**
 * 메일 읽기 — Vue 판 components/mail/MailReader.vue.
 * 데스크톱 오른쪽 판(variant="pane")과 모바일 /mail/:id 본문(variant="page")이 같은 컴포넌트.
 *  pane : 액션 줄 44(답장·전체 답장·전달 | 보관·삭제·안 읽음·더보기 … n / N) + 본문 카드 + 인라인 답장
 *  page : 상단 바는 페이지(LayoutMobileDetailBar)가, 하단 고정 답장·전체 답장·전달 줄은 여기서
 * 스레드: 본문 카드 위에 같은 대화의 첫 메일 한 줄(44) + "이전 메일 n개 더 보기"(28). 줄을 누르면 그 메일 본문을 펼친다.
 *   GET /messages/{id}/thread(보낸편지함 포함, 읽음 처리 안 함). 펼칠 때만 그 메일이 있는 메일함에서 본문을 받는다.
 * 라벨: 제목 옆 칩(색점 + 중립 테두리 22). 붙이기·떼기는 ⋯ "라벨"(서버가 키워드를 지원할 때만).
 *
 * ref: { reply, forward, archive, remove, markUnread, star, spam, onMore, mobileMoreItems }
 *   mobileMoreItems 는 모바일 상단 바 ⋯ 메뉴 항목 — 바뀌면 onMobileMoreItems 로도 알린다(React 는 ref 값 변경으로 다시 그리지 않으므로).
 */
import { Fragment, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { useI18n } from '~/i18n'
// Vue 의 class 묶음처럼 그냥 잇는다(tailwind-merge 를 쓰는 cn 은 leading-[1.35]+text-xl 같은 짝을 지워 Vue 와 달라진다)
import { clsx as cx } from 'clsx'
import { useMail, mailStore, mailIsPop3, type MessageDetail, type MessageSummary } from '~/composables/useMail'
import { useAuth } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { useUserPrefs } from '~/composables/useUserPrefs'
import { previewKind, formatBytes, formatMailDate, summarizeRecipients, threadLayout, labelTone } from '~/utils/mailQuery'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiButton } from '~/components/ui/Button'
import { UiModal } from '~/components/ui/Modal'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiInput } from '~/components/ui/Input'
import { MailBody } from '~/components/mail/MailBody'
import { MailComposer, type MailComposerHandle } from '~/components/mail/MailComposer'
import { MailAttachmentPreview } from '~/components/mail/MailAttachmentPreview'
import { MailAiDraft, MailAiSummary, type MailRef } from '~/components/mail/MailAiPanels'
import { AiInlineButton } from '~/components/aiInline/AiInlineParts'
import { useAiInline } from '~/composables/useAiInline'
import { openCompose as openComposeWindow } from '~/composables/useMailCompose'
import { plainBody } from '~/components/mail/composeText'

export interface MailReaderHandle {
  reply: (all?: boolean) => void
  forward: () => void
  archive: () => Promise<void>
  remove: () => Promise<void>
  markUnread: () => Promise<void>
  star: () => void
  spam: () => Promise<void>
  onMore: (key: string) => void
  /** 모바일 상단 바 ⋯ 메뉴 항목 */
  mobileMoreItems: UiMenuItem[]
}

export interface MailReaderProps {
  /** pane(데스크톱 오른쪽 판, 기본) · page(모바일 본문 페이지) */
  variant?: 'pane' | 'page'
  /** 보관함으로 옮김 */
  onArchived?: () => void
  /** 지움·스팸으로 옮김 */
  onDeleted?: () => void
  /** 모바일 ⋯ 항목이 바뀜(페이지 상단 바가 그린다) */
  onMobileMoreItems?: (items: UiMenuItem[]) => void
  /**
   * 보낸 사람(아바타+이름)을 눌렀을 때 — 주면 그 둘이 버튼이 된다.
   * pages/mail 이 보낸 사람 패널이 붙을 자리가 없을 때만 넘겨 패널을 오버레이로 연다.
   */
  onSenderClick?: () => void
  /** 보낸 사람 오버레이가 열려 있음(버튼 aria-expanded) */
  senderPanelOpen?: boolean
  /** { reply, forward, archive, remove, markUnread, star, spam, onMore, mobileMoreItems } */
  ref?: Ref<MailReaderHandle | null>
}

function fmtAddrs(l: readonly { name: string | null; email: string }[]) { return l.map(a => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ') }
function extOf(name: string | null, type: string | null) {
  const n = (name || '').split('.').pop() || ''
  if (n && n.length <= 4 && n !== name) return n.toUpperCase()
  return (type || '').split('/').pop()?.slice(0, 4).toUpperCase() || 'FILE'
}

/** 메일 읽기 판 */
export function MailReader({ variant = 'pane', onArchived, onDeleted, onMobileMoreItems, onSenderClick, senderPanelOpen, ref }: MailReaderProps) {
  const { t } = useI18n()
  const {
    selectedMessage, loadingMessage, messageError, selectedIndex, currentPage, limit, totalMessages,
    toggleStar, deleteMessage, setUnread, archiveMessages, archiveMailbox, markAsSpam,
    fetchRawHeaders, sendReadReceipt, openMessage, openCompose, attachmentUrl, downloadAttachment, downloadAllAttachments,
    selectedAccount, isPop3, messages, fetchThread, fetchMessageIn, labelInfo, updateLabels, selectedMailboxId,
  } = useMail()
  const { user } = useAuth()

  const msg = selectedMessage
  const isPage = variant === 'page'
  const myEmail = selectedAccount?.email || user?.primary_email || user?.email || ''

  // ─── 어둡게 보기 — 개인 설정(useUserPrefs.mailDarkView, 서버 동기화) ───
  const { mailDarkView, setMailDarkView, readReceiptDefault } = useUserPrefs()
  const paperDark = mailDarkView
  function togglePaper() { setMailDarkView(!mailDarkView) }

  // ─── 보낸 사람·받는 사람 ───
  const sender = msg?.from_?.[0] || null
  const senderName = sender?.name || sender?.email || t('mail.sender.none')
  const initial = (senderName.trim().charAt(0) || '?').toUpperCase()
  const recipients = [...(msg?.to || []), ...(msg?.cc || [])]
  const recipientSummary = summarizeRecipients(recipients, myEmail, 2, {
    me: t('mail.reader.me'),
    more: (names, n) => t('mail.reader.recipientsMore', { names, n }),
  })
  const [showDetails, setShowDetails] = useState(false)

  // ─── 원문 헤더 ───
  const [showHeaders, setShowHeaders] = useState(false)
  const [rawHeaders, setRawHeaders] = useState<string | null>(null)
  const [loadingHeaders, setLoadingHeaders] = useState(false)
  async function toggleHeaders() {
    if (showHeaders) { setShowHeaders(false); return }
    const m = mailStore.getState().selectedMessage
    if (!m) return
    setLoadingHeaders(true)
    setShowHeaders(true)
    setRawHeaders(await fetchRawHeaders(m.id))
    setLoadingHeaders(false)
  }

  // ─── 수신 확인 ─── 설정 › 메일 "읽음 확인 요청에 응답"(read_receipt_default): 매번 묻기 = 배너 · 항상 = 열면 자동 · 보내지 않기 = 배너 숨김
  const [mdnSending, setMdnSending] = useState(false)
  async function acceptMdn() {
    if (!msg) return
    setMdnSending(true)
    await sendReadReceipt(msg.id)
    setMdnSending(false)
  }
  const showMdnBanner = !!msg?.disposition_notification_to && !msg?.mdn_sent && readReceiptDefault === 'ask'
  const mdnAutoSent = useRef(new Set<string>())
  useEffect(() => {
    const m = mailStore.getState().selectedMessage
    if (!m || readReceiptDefault !== 'always' || !m.disposition_notification_to || m.mdn_sent || mdnAutoSent.current.has(m.id)) return
    mdnAutoSent.current.add(m.id)
    void sendReadReceipt(m.id)
  }, [msg?.id, readReceiptDefault, sendReadReceipt])

  // ─── 화면 안 AI: 요약 패널 · 답장 초안 ───
  const { status: aiStatus } = useAiInline()
  const [aiSumOpen, setAiSumOpen] = useState(false)
  const [aiDraftOpen, setAiDraftOpen] = useState(false)
  const aiMail: MailRef | null = msg ? { id: msg.id, mailboxId: msg.mailbox_ids?.[0] || selectedMailboxId || null, accountId: selectedAccount?.id || null } : null
  function applyAiDraft(draft: string) {
    setAiDraftOpen(false)
    openComposeWindow(replyMode, now(), null, { aiDraft: draft })
  }

  // ─── 인라인 답장(데스크톱) ───
  const [replyKey, setReplyKey] = useState(0)
  const [replyMode, setReplyMode] = useState<'reply' | 'replyAll'>('reply')
  const inlineRef = useRef<MailComposerHandle | null>(null)

  // ─── 스레드(접힌 대화) ───
  const [thread, setThread] = useState<MessageSummary[]>([])
  const [threadExpanded, setThreadExpanded] = useState(false)
  const [threadBodies, setThreadBodies] = useState<Record<string, MessageDetail | 'loading' | 'error'>>({})
  const threadSeq = useRef(0)
  // watch(msg.id) — 다른 메일을 열면 판 상태를 되돌리고 스레드를 다시 받는다
  const msgId = msg?.id
  const firstId = useRef(true)
  useEffect(() => {
    if (!firstId.current) {
      setShowHeaders(false); setRawHeaders(null); setShowDetails(false); setReplyKey(k => k + 1)
      setAiDraftOpen(false)
    }
    firstId.current = false
    setThread([])
    setThreadExpanded(false)
    setThreadBodies({})
    if (!msgId) return
    const seq = ++threadSeq.current
    void fetchThread(msgId).then((list) => {
      if (seq === threadSeq.current && list) setThread(list)
    })
  }, [msgId, fetchThread])
  const threadView = msg ? threadLayout(thread, msg.id, threadExpanded, msg.mailbox_ids?.[0] || selectedMailboxId) : { shown: [] as MessageSummary[], hidden: 0 }
  /** 펼친 본문의 열쇠 — 메일함:UID. UID 만 쓰면 받은편지함 7번과 보낸편지함 7번이 한 줄로 섞인다. */
  const tkey = (m: MessageSummary) => `${m.mailbox_ids?.[0] || ''}:${m.id}`
  function bodyOf(m: MessageSummary): MessageDetail | null {
    const v = threadBodies[tkey(m)]
    return v && v !== 'loading' && v !== 'error' ? v : null
  }
  const bodiesRef = useRef(threadBodies)
  bodiesRef.current = threadBodies
  async function toggleThreadItem(m: MessageSummary) {
    const k = tkey(m)
    const cur = bodiesRef.current[k]
    if (cur && cur !== 'error') {
      const next = { ...bodiesRef.current }
      delete next[k]
      bodiesRef.current = next
      setThreadBodies(next)
      return
    }
    bodiesRef.current = { ...bodiesRef.current, [k]: 'loading' }
    setThreadBodies(bodiesRef.current)
    const detail = await fetchMessageIn(m.id, m.mailbox_ids?.[0] || mailStore.getState().selectedMailboxId || 'INBOX')
    bodiesRef.current = { ...bodiesRef.current, [k]: detail || 'error' }
    setThreadBodies(bodiesRef.current)
  }
  function threadSender(m: MessageSummary) {
    const a = m.from_?.[0]
    if (a && myEmail && a.email.toLowerCase() === myEmail.toLowerCase()) return t('mail.reader.me')
    return a ? (a.name || a.email) : t('mail.sender.none')
  }

  // ─── 라벨 ───
  const labels: string[] = (() => {
    const id = msg?.id
    if (!id) return []
    const fromList = messages.find(m => m.id === id)?.labels
    const here = selectedMailboxId || ''
    const fromThread = thread.find(m => m.id === id && (m.mailbox_ids?.[0] || '') === here)?.labels
    return [...(fromList ?? fromThread ?? [])]
  })()
  const [labelsOpen, setLabelsOpen] = useState(false)
  const [labelDraft, setLabelDraft] = useState<Set<string>>(new Set())
  const [newLabel, setNewLabel] = useState('')
  const labelChoices = Array.from(new Set([...labelInfo.labels, ...labels, ...labelDraft]))
  function openLabels() {
    setLabelDraft(new Set(labels))
    setNewLabel('')
    setLabelsOpen(true)
  }
  function toggleDraft(l: string) {
    const s = new Set(labelDraft)
    if (s.has(l)) s.delete(l)
    else s.add(l)
    setLabelDraft(s)
  }
  /** 새 라벨을 초안에 넣은 집합(저장 때 같이 쓰려고 돌려준다) */
  function addNewLabel(): Set<string> {
    const v = newLabel.trim()
    if (!v) return labelDraft
    const s = new Set([...labelDraft, v])
    setLabelDraft(s)
    setNewLabel('')
    return s
  }
  async function saveLabels() {
    const cur = msg
    if (!cur) return
    let draft = labelDraft
    if (newLabel.trim()) draft = addNewLabel()
    const before = new Set(labels)
    const add = [...draft].filter(l => !before.has(l))
    const remove = [...before].filter(l => !draft.has(l))
    const ok = await updateLabels(cur.id, add, remove)
    if (!ok) { addToast('error', t('mail.labels.saveFailed')); return }
    // 목록에 없던 메일(모바일 본문 등)은 스레드 요약 쪽에 반영
    const here = mailStore.getState().selectedMailboxId || ''
    setThread(th => th.map(m => (m.id === cur.id && (m.mailbox_ids?.[0] || '') === here ? { ...m, labels: [...draft] } : m)))
    setLabelsOpen(false)
  }

  // ─── 행동 ───
  // 단축키·상단 바가 부르므로 "지금" 열린 메일을 store 에서 읽는다
  const now = () => mailStore.getState().selectedMessage
  async function archive() {
    const m = now()
    // POP3 는 서버 폴더가 없다 — 버튼·메뉴는 숨겼고 단축키(E)·모바일 상단 바로 들어와도 조용히 넘긴다
    if (!m || mailIsPop3()) return
    if (!mailStore.getState().mailboxes.find(x => x.role === 'archive')) { addToast('warning', t('mail.list.noArchive')); return }
    if (await archiveMessages([m.id])) { addToast('success', t('mail.reader.archived')); onArchived?.() }
    else addToast('error', t('mail.list.archiveFailed'))
  }
  async function remove() {
    const m = now()
    if (!m) return
    if (!await confirmBox(t('mail.view.deleteConfirm'), { title: t('mail.list.deleteTitle'), confirmLabel: t('common.delete'), danger: true })) return
    // 실패했는데 성공처럼 닫지 않는다(예전엔 서버 오류에도 목록으로 돌아갔다)
    if (await deleteMessage(m.id)) onDeleted?.()
    else addToast('error', t('mail.list.actionFailed'))
  }
  async function markUnread() {
    const m = now()
    if (!m) return
    if (await setUnread(m.id, true)) addToast('info', t('mail.reader.markedUnread'))
    else addToast('error', t('mail.list.actionFailed'))
  }
  async function spam() {
    const m = now()
    if (!m || mailIsPop3()) return
    if (await markAsSpam(m.id)) { addToast('info', t('mail.reader.movedToSpam')); onDeleted?.() }
    else addToast('error', t('mail.list.actionFailed'))
  }
  function star() {
    const m = now()
    if (m) void toggleStar(m.id).then((ok) => { if (!ok) addToast('error', t('mail.list.actionFailed')) })
  }
  function forward() { openCompose('forward', now()) }
  function resend() { openCompose('resend', now()) }

  function printMessage() {
    const m = now()
    if (!m) return
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0'
    document.body.appendChild(frame)
    const doc = frame.contentDocument
    if (!doc) { frame.remove(); return }
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    // text/plain 파트가 없는 메일(HTML 전용)은 HTML 에서 글자만 뽑는다 — 예전엔 제목만 인쇄됐다
    const plain = plainBody(m)
    const body = plain ? `<pre style="white-space:pre-wrap;font:inherit">${esc(plain)}</pre>` : ''
    doc.open()
    doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(m.subject || '')}</title></head><body style="font-family:sans-serif;font-size:13px">
    <h2>${esc(m.subject || '')}</h2><p>${esc(fmtAddrs(m.from_))}<br>${esc(fmtAddrs(m.to))}<br>${esc(m.received_at ? new Date(m.received_at).toLocaleString() : '')}</p><hr>${body}</body></html>`)
    doc.close()
    frame.contentWindow?.focus()
    frame.contentWindow?.print()
    setTimeout(() => frame.remove(), 1000)
  }

  const moreItems: UiMenuItem[] = [
    { key: 'star', label: msg?.is_flagged ? t('mail.reader.unstar') : t('mail.message.star'), icon: 'star', hint: 'S' },
    ...(labelInfo.supported ? [{ key: 'labels', label: t('mail.labels.edit'), icon: 'bookmark' }] : []),
    { key: 'resend', label: t('mail.compose.resend'), icon: 'send' },
    ...(isPop3 ? [] : [{ key: 'spam', label: t('mail.reader.toSpam'), icon: 'alert-triangle' }]),
    { key: 'headers', label: showHeaders ? t('mail.reader.closeHeaders') : t('mail.reader.viewSource'), icon: 'file-text' },
    { key: 'print', label: t('mail.reader.print'), icon: 'copy' },
  ]
  const mobileMoreItems: UiMenuItem[] = [
    { key: 'unread', label: t('mail.reader.markUnreadMenu'), icon: 'mail' },
    { key: 'resend', label: t('mail.compose.resend'), icon: 'send' },
    ...(labelInfo.supported ? [{ key: 'labels', label: t('mail.labels.edit'), icon: 'bookmark' }] : []),
    ...(isPop3 ? [] : [{ key: 'spam', label: t('mail.reader.toSpam'), icon: 'alert-triangle' }]),
    { key: 'delete', label: t('common.delete'), icon: 'trash', danger: true },
    { key: 'headers', label: showHeaders ? t('mail.reader.closeHeaders') : t('mail.reader.viewSource'), icon: 'file-text' },
  ]
  const mobileKey = JSON.stringify(mobileMoreItems)
  const onMobileRef = useRef(onMobileMoreItems)
  onMobileRef.current = onMobileMoreItems
  useEffect(() => { onMobileRef.current?.(JSON.parse(mobileKey)) }, [mobileKey])

  function onMore(key: string) {
    if (key === 'star') star()
    else if (key === 'spam') void spam()
    else if (key === 'headers') void toggleHeaders()
    else if (key === 'print') printMessage()
    else if (key === 'unread') void markUnread()
    else if (key === 'delete') void remove()
    else if (key === 'labels') openLabels()
    else if (key === 'resend') resend()
  }

  // ─── 첨부 ───
  const atts = msg?.attachments || []
  const images = atts.filter(a => previewKind(a.type) === 'image')
  const files = atts.filter(a => previewKind(a.type) !== 'image')
  const [preview, setPreview] = useState<{ name: string; size: number; kind: 'image' | 'pdf'; blobId: string } | null>(null)
  function openAttachment(a: { blob_id: string; name: string | null; type: string | null; size: number }) {
    const kind = previewKind(a.type)
    if (kind) setPreview({ name: a.name || t('mail.compose.attach'), size: a.size, kind, blobId: a.blob_id })
    else downloadAttachment(a.blob_id, a.name || 'attachment')
  }

  function reply(all = false) {
    if (isPage) { openCompose(all ? 'replyAll' : 'reply', now()); return }
    if (inlineRef.current) inlineRef.current.setReplyAll(all)
    else setReplyMode(all ? 'replyAll' : 'reply')
  }
  function onInlineDone() { setReplyMode('reply'); setReplyKey(k => k + 1) }

  const position = selectedIndex ? currentPage * limit + selectedIndex : 0

  const actions = [
    { key: 'reply', label: t('mail.reader.replyKey'), glyph: 'reply', run: () => reply(false) },
    { key: 'replyAll', label: t('mail.reader.replyAllKey'), glyph: 'reply-all', run: () => reply(true) },
    { key: 'forward', label: t('mail.reader.forwardKey'), glyph: 'forward', run: forward },
    null,
    ...(isPop3 ? [] : [{ key: 'archive', label: archiveMailbox ? t('mail.list.archiveKey') : t('mail.list.archiveKeyNone'), glyph: 'archive', run: archive, disabled: !archiveMailbox }]),
    { key: 'delete', label: t('mail.list.deleteKey'), glyph: 'trash', run: remove },
    { key: 'unread', label: t('mail.reader.unreadKey'), glyph: 'mail-unread', run: markUnread },
  ]

  // 모바일 상단 바(페이지 소유)의 보관·⋯ 와 데스크톱 단축키가 부른다
  useImperativeHandle(ref, () => ({ reply, forward, archive, remove, markUnread, star, spam, onMore, mobileMoreItems }))

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* 액션 줄 44 (pane) */}
      {!isPage && msg && (
        <div className="flex h-11 shrink-0 items-center gap-0.5 border-b border-border bg-card px-2.5 text-muted-foreground">
          {actions.map((a, i) => (a
            ? <UiIconButton key={a.key} label={a.label} disabled={a.disabled} onClick={() => { void a.run() }}><UiIcon name={a.glyph} /></UiIconButton>
            : <span key={`sep${i}`} className="mx-1.5 h-[18px] w-px bg-border" aria-hidden="true" />))}
          <UiMenu label={t('mail.reader.moreMenu')} items={moreItems} onSelect={onMore} />
          <span className="flex-1" />
          {!!position && <span className="font-mono text-[11px]">{position} / {totalMessages.toLocaleString()}</span>}
        </div>
      )}

      {/* 로딩 · 오류 · 빈 판 */}
      {loadingMessage && !msg
        ? <div className="flex-1 p-6"><UiSkeleton preset="text" rows={6} /></div>
        : messageError
          ? (
            <div className="grid flex-1 place-items-center p-6">
              <UiErrorTile placement="panel" title={t('mail.reader.openFailed')} detail={messageError} onRetry={() => { if (msg) void openMessage(msg.id) }} />
            </div>
          )
          : !msg
            ? (
              <div className="grid flex-1 place-items-center p-6">
                <UiEmptyState variant="panel" icon="mail" title={t('mail.reader.emptyPane')} />
              </div>
            )
            : (
              <div className="flex min-h-0 min-w-0 flex-1">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className={cx('min-h-0 flex-1 overflow-y-auto', isPage ? 'p-4' : 'px-7 pb-8 pt-5')}>
                  <div className={cx('mx-auto flex max-w-reading flex-col', isPage ? 'gap-0' : 'gap-3')}>
                    {/* 제목 + 별표 */}
                    <div className={cx('flex items-start', isPage ? 'gap-2' : 'gap-2.5')}>
                      <h1 className={cx('m-0 min-w-0 flex-1 font-bold leading-[1.35] [word-break:keep-all]', isPage ? 'text-[19px]' : 'text-xl')}>{msg.subject || t('mail.subject.none')}</h1>
                      {labels.length > 0 && (
                        <ul className={cx('flex shrink-0 flex-wrap items-center gap-1.5', isPage ? 'mt-0.5' : 'mt-1')} aria-label={t('mail.labels.title')}>
                          {labels.map(l => (
                            <li key={l} className="inline-flex h-[22px] items-center gap-1.5 rounded-[6px] border border-border px-2 text-xs">
                              <span className="h-2 w-2 rounded-full" style={{ background: `hsl(var(--${labelTone(l)}))` }} aria-hidden="true" />{l}
                            </li>
                          ))}
                        </ul>
                      )}
                      {!isPage && aiMail && (
                        <div className="-mt-0.5 flex shrink-0 items-center gap-1.5">
                          <AiInlineButton status={aiStatus} variant={aiSumOpen ? 'secondary' : 'outline'} size="sm" icon="sparkles" aria-pressed={aiSumOpen} onClick={() => setAiSumOpen(!aiSumOpen)}>{t('aiInline.mail.summarize')}</AiInlineButton>
                          <AiInlineButton status={aiStatus} variant="outline" size="sm" icon="reply" aria-pressed={aiDraftOpen} onClick={() => setAiDraftOpen(true)}>{t('aiInline.mail.replyDraft')}</AiInlineButton>
                        </div>
                      )}
                      <UiIconButton
                        label={t('mail.message.star')}
                        pressed={msg.is_flagged}
                        keys={isPage ? [] : ['S']}
                        size={isPage ? 'md' : 'sm'}
                        className={cx(msg.is_flagged ? 'text-warning hover:text-warning' : '', isPage ? '-mr-2 -mt-1.5' : '-mt-1')}
                        onClick={star}
                      ><UiIcon name="star" filled={msg.is_flagged} /></UiIconButton>
                    </div>

                    {/* 화면 안 AI — 모바일: 제목 아래 버튼 줄 + 요약 카드 */}
                    {isPage && aiMail && (
                      <div className="mt-2 flex items-center gap-1.5">
                        <AiInlineButton status={aiStatus} variant={aiSumOpen ? 'secondary' : 'outline'} size="sm" icon="sparkles" aria-pressed={aiSumOpen} onClick={() => setAiSumOpen(!aiSumOpen)}>{t('aiInline.mail.summarize')}</AiInlineButton>
                        <AiInlineButton status={aiStatus} variant="outline" size="sm" icon="reply" aria-pressed={aiDraftOpen} onClick={() => setAiDraftOpen(true)}>{t('aiInline.mail.replyDraft')}</AiInlineButton>
                      </div>
                    )}
                    {isPage && aiMail && aiSumOpen && <div className="mt-3"><MailAiSummary key={aiMail.id} mail={aiMail} status={aiStatus} variant="inline" onClose={() => setAiSumOpen(false)} /></div>}

                    {/* 수신 확인 요청 */}
                    {showMdnBanner && (
                      <div
                        role="status"
                        className={cx('flex items-center gap-3 rounded-md border border-primary/30 bg-primary/5 px-3.5 py-2', isPage ? 'mt-3' : '')}
                      >
                        <UiIcon name="check-circle" className="h-4 w-4 shrink-0 text-primary" />
                        <span className="flex-1 text-[13px]">{t('mail.view.mdnRequest')}</span>
                        <UiButton size="xs" disabled={mdnSending} onClick={acceptMdn}>{mdnSending ? t('common.sending') : t('common.confirm')}</UiButton>
                      </div>
                    )}

                    <article className={isPage ? 'mt-3.5' : 'overflow-hidden rounded-lg border border-border'}>
                      {/* 접힌 대화: 첫 메일 한 줄 44 + "이전 메일 n개 더 보기" 28 */}
                      {threadView.shown.length > 0 && (
                        <section aria-label={t('mail.thread.label')} className={isPage ? 'mb-3 overflow-hidden rounded-lg border border-border' : ''}>
                          {threadView.shown.map((tm, ti) => (
                            <Fragment key={`${tm.mailbox_ids?.[0] || ''}:${tm.id}`}>
                              <button
                                type="button"
                                aria-expanded={!!bodyOf(tm)}
                                className="flex h-11 w-full items-center gap-2.5 border-b border-border px-3.5 text-left text-[13px] text-muted-foreground hover:bg-accent/30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                                onClick={() => toggleThreadItem(tm)}
                              >
                                <span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-muted text-[10px] font-semibold text-foreground">{(threadSender(tm).trim().charAt(0) || '?').toUpperCase()}</span>
                                <b className="max-w-[40%] shrink-0 truncate font-semibold text-foreground">{threadSender(tm)}</b>
                                <span className="min-w-0 flex-1 truncate">{tm.preview || tm.subject || ''}</span>
                                <span className="shrink-0 font-mono text-[11px]">{formatMailDate(tm.received_at)}</span>
                              </button>
                              {threadBodies[tkey(tm)] && (
                                <div className="border-b border-border px-3.5 py-3">
                                  {threadBodies[tkey(tm)] === 'loading'
                                    ? <UiSkeleton preset="text" rows={3} delay={false} />
                                    : threadBodies[tkey(tm)] === 'error'
                                      ? <p role="alert" className="text-xs text-danger">{t('mail.thread.loadFailed')}</p>
                                      : bodyOf(tm) && <MailBody message={bodyOf(tm)!} dark={paperDark} />}
                                </div>
                              )}
                              {ti === 0 && threadView.hidden > 0 && (
                                <button
                                  type="button"
                                  className="flex h-7 w-full items-center justify-center border-b border-border text-xs font-semibold text-primary hover:bg-accent/30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                                  onClick={() => setThreadExpanded(true)}
                                >{t('mail.thread.showMore', { n: threadView.hidden })}</button>
                              )}
                            </Fragment>
                          ))}
                        </section>
                      )}
                      <div className={cx('flex flex-col gap-3', isPage ? '' : 'px-4 py-3.5')}>
                        {/* 보낸 사람 줄 */}
                        <div className="flex items-center gap-2.5">
                          {onSenderClick
                            ? (
                              // 아바타도 같은 동작(키보드·스크린리더는 이름 버튼 하나로 충분해 탭 순서에서 뺀다)
                              <button
                                type="button"
                                tabIndex={-1}
                                aria-hidden="true"
                                data-sender-trigger=""
                                className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-muted text-[13px] font-semibold"
                                onClick={onSenderClick}
                              >{initial}</button>
                            )
                            : <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-muted text-[13px] font-semibold">{initial}</span>}
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold">
                              {onSenderClick
                                ? (
                                  <button
                                    type="button"
                                    aria-expanded={!!senderPanelOpen}
                                    data-sender-trigger=""
                                    className="rounded-sm font-semibold hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                                    onClick={onSenderClick}
                                  >{senderName}</button>
                                )
                                : senderName}
                              {sender?.email && sender.email !== senderName && <>{' '}<span className={cx('font-normal text-muted-foreground', isPage ? '' : 'text-xs')}>{sender.email}</span></>}
                            </div>
                            <div className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
                              <span className="min-w-0 truncate">{isPage ? '' : t('mail.reader.toPrefix')}{recipientSummary}</span>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono">{formatMailDate(msg.received_at, !isPage)}</span>
                              <button
                                type="button"
                                aria-expanded={showDetails}
                                className="relative ml-1 font-semibold text-primary hover:underline before:absolute before:-inset-3 before:content-['']"
                                onClick={() => setShowDetails(!showDetails)}
                              >{showDetails ? t('mail.reader.collapse') : t('mail.reader.details')}</button>
                            </div>
                          </div>
                          {!isPage && (
                            <button
                              type="button"
                              aria-label={t('mail.reader.darkBodyLabel')}
                              aria-pressed={paperDark}
                              className={cx(
                                "relative inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm border px-2.5 text-xs before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-['']",
                                paperDark ? 'border-primary/50 bg-primary/[0.13] text-foreground' : 'border-border text-muted-foreground hover:text-foreground',
                              )}
                              onClick={togglePaper}
                            >{t('mail.reader.darkView')}</button>
                          )}
                        </div>

                        {/* 자세히: 전체 주소 */}
                        {showDetails && (
                          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-muted/40 px-3 py-2 text-xs">
                            <dt className="text-muted-foreground">{t('mail.reader.from')}</dt><dd className="min-w-0 break-all">{fmtAddrs(msg.from_)}</dd>
                            <dt className="text-muted-foreground">{t('mail.reader.to')}</dt><dd className="min-w-0 break-all">{fmtAddrs(msg.to)}</dd>
                            {msg.cc.length > 0 && <><dt className="text-muted-foreground">{t('mail.compose.cc')}</dt><dd className="min-w-0 break-all">{fmtAddrs(msg.cc)}</dd></>}
                            {msg.reply_to.length > 0 && <><dt className="text-muted-foreground">{t('mail.reader.replyTo')}</dt><dd className="min-w-0 break-all">{fmtAddrs(msg.reply_to)}</dd></>}
                            <dt className="text-muted-foreground">{t('mail.reader.date')}</dt><dd className="font-mono">{msg.received_at ? new Date(msg.received_at).toLocaleString() : ''}</dd>
                            {isPage && (
                              <>
                                <dt className="text-muted-foreground">{t('mail.reader.bodyLabel')}</dt>
                                <dd><button type="button" className="min-h-8 font-semibold text-primary" aria-pressed={paperDark} onClick={togglePaper}>{paperDark ? t('mail.reader.originalColors') : t('mail.reader.darkView')}</button></dd>
                              </>
                            )}
                          </dl>
                        )}

                        {/* 원문 헤더 */}
                        {showHeaders && (
                          <div className="rounded-md border border-border bg-muted/30 p-3">
                            <div className="mb-2 text-xs font-semibold text-muted-foreground">{t('mail.view.rawHeaders')}</div>
                            {loadingHeaders
                              ? <UiSkeleton preset="text" rows={3} delay={false} />
                              : <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">{rawHeaders}</pre>}
                          </div>
                        )}

                        {/* 본문 종이 */}
                        <MailBody message={msg} dark={paperDark} className={isPage ? 'mt-2' : ''} />

                        {/* 첨부: 이미지 썸네일 + 파일 카드 + 모두 다운로드 */}
                        {atts.length > 0 && (
                          <div className={cx('flex flex-wrap items-center gap-2.5', isPage ? 'mt-3 flex-col items-stretch' : '')}>
                            {images.map(a => (
                              <button
                                key={a.blob_id}
                                type="button"
                                aria-label={t('mail.attachment.previewLabel', { name: a.name || t('mail.editor.image') })}
                                className={cx('h-16 w-24 shrink-0 overflow-hidden rounded-sm bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring', isPage ? 'self-start' : '')}
                                onClick={() => openAttachment(a)}
                              ><img src={attachmentUrl(a.blob_id, { inline: true })} alt={a.name || ''} loading="lazy" className="h-full w-full object-cover" /></button>
                            ))}
                            {files.map(a => (
                              <button
                                key={a.blob_id}
                                type="button"
                                className={cx('flex items-center gap-2.5 rounded-md border border-border px-3 text-left hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring', isPage ? 'min-h-14 rounded-lg bg-card py-2.5' : 'h-16')}
                                onClick={() => openAttachment(a)}
                              >
                                <span
                                  className={cx('grid h-9 shrink-0 place-items-center rounded-sm text-[10px] font-bold', isPage ? 'w-9' : 'w-8', previewKind(a.type) === 'pdf' ? 'bg-danger/[0.12] text-danger' : 'bg-muted text-muted-foreground')}
                                >{extOf(a.name, a.type)}</span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-[13px] font-semibold">{a.name || 'attachment'}</span>
                                  <span className="font-mono text-[11px] text-muted-foreground">{formatBytes(a.size)}{!isPage && ` · ${previewKind(a.type) ? t('mail.reader.preview') : t('common.download')}`}</span>
                                </span>
                                {isPage && <span className="px-1.5 text-[13px] font-semibold text-primary">{previewKind(a.type) ? t('mail.reader.preview') : t('common.download')}</span>}
                              </button>
                            ))}
                            {(atts.length > 1 || !isPage) && (
                              <button
                                type="button"
                                className={cx("relative text-xs font-semibold text-primary hover:underline before:absolute before:-inset-3 before:content-['']", isPage ? 'self-end py-2' : 'ml-auto')}
                                title={t('mail.reader.downloadAllHint')}
                                onClick={() => downloadAllAttachments(msg.id)}
                              >{t('mail.reader.downloadAll')}</button>
                            )}
                          </div>
                        )}
                      </div>
                    </article>

                    {/* 화면 안 AI 답장 초안(본문 아래) */}
                    {aiMail && aiDraftOpen && (
                      <div className={isPage ? 'mt-4' : ''}>
                        <MailAiDraft mail={aiMail} onClose={() => setAiDraftOpen(false)} onUse={applyAiDraft} />
                      </div>
                    )}

                    {/* 인라인 답장(데스크톱) */}
                    {!isPage && (
                      <MailComposer
                        key={`${msg.id}:${replyKey}`}
                        ref={inlineRef}
                        variant="inline"
                        mode={replyMode}
                        msgId={msg.id}
                        original={msg}
                        onClose={onInlineDone}
                      />
                    )}
                  </div>
                </div>

                {/* 모바일 하단 고정: 답장 · 전체 답장 · 전달 */}
                {isPage && (
                  <div className="flex shrink-0 gap-2 border-t border-border bg-background px-3 pt-2" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
                    <UiButton className="h-11 flex-1 rounded-lg text-sm font-semibold" onClick={() => reply(false)}>{t('mail.compose.reply')}</UiButton>
                    <UiButton variant="outline" className="h-11 flex-1 rounded-lg text-sm font-normal" onClick={() => reply(true)}>{t('mail.compose.replyAll')}</UiButton>
                    <UiButton variant="outline" className="h-11 flex-1 rounded-lg text-sm font-normal" onClick={forward}>{t('mail.compose.forward')}</UiButton>
                  </div>
                )}
              </div>
              {/* 화면 안 AI 요약 패널 — 데스크톱 오른쪽 340 */}
              {!isPage && aiMail && aiSumOpen && <MailAiSummary key={aiMail.id} mail={aiMail} status={aiStatus} variant="aside" onClose={() => setAiSumOpen(false)} />}
              </div>
            )}

      {/* 라벨 붙이기·떼기(시안 그림 없음 — 체크 목록 + 새 라벨 입력) */}
      {labelsOpen && (
        <UiModal
          title={t('mail.labels.edit')}
          size="sm"
          onClose={() => setLabelsOpen(false)}
          footer={(
            <>
              <UiButton variant="outline" size="sm" onClick={() => setLabelsOpen(false)}>{t('common.cancel')}</UiButton>
              <UiButton size="sm" onClick={saveLabels}>{t('common.save')}</UiButton>
            </>
          )}
        >
          {labelChoices.length
            ? (
              <div className="flex flex-col gap-1">
                {labelChoices.map(l => (
                  <UiCheckbox
                    key={l}
                    modelValue={labelDraft.has(l)}
                    label={l}
                    onUpdateModelValue={() => toggleDraft(l)}
                  />
                ))}
              </div>
            )
            : <p className="text-xs text-muted-foreground">{t('mail.labels.none')}</p>}
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); addNewLabel() }}>
            <UiInput modelValue={newLabel} onUpdateModelValue={setNewLabel} label={t('mail.labels.new')} placeholder={t('mail.labels.newPlaceholder')} maxLength={60} className="min-w-0 flex-1" />
            <UiButton type="submit" variant="outline" size="sm" className="h-10" disabled={!newLabel.trim()}>{t('mail.labels.add')}</UiButton>
          </form>
        </UiModal>
      )}

      {preview && (
        <MailAttachmentPreview
          name={preview.name}
          size={preview.size}
          kind={preview.kind}
          src={attachmentUrl(preview.blobId, { inline: true })}
          onClose={() => setPreview(null)}
          onDownload={() => downloadAttachment(preview.blobId, preview.name)}
        />
      )}
    </div>
  )
}

export default MailReader
