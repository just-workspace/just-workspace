/**
 * 메일 작성 본체. 세 위치에서 동일한 로직을 사용한다.
 *  variant="window" : 데스크톱 플로팅 작성 창 580×640 내부(제목 줄은 MailComposeWindow 가 렌더링)
 *  variant="page"   : 모바일 전체 화면 /mail/compose
 *  variant="inline" : 읽기 화면 본문 아래 인라인 답장
 *
 * 기능: 보낸 계정·이름, 받는이 칩·참조·숨은참조, 서명, 첨부 15MB(초과 시 대용량 첨부 = 파일함 + 30일 링크), 30초 임시 저장(/api/mail/drafts), 읽음 확인 요청,
 * 답장·전체 답장·전달 인용, 임시 보관 메일 이어 쓰기. 닫기 = 임시보관함에 저장(확인 절차 없음), 버리기는 휴지통 버튼(확인 절차 있음).
 * 서명 이중 부착 방지: 본문에는 서명을 포함하지 않고 signature_id 만 전송한다(서버가 본문 내 기존 서명 블록을 제거하고 정확히 1개만 삽입).
 *   초안도 signature_id 로 저장하며, 이어 쓸 때는 body_*_without_signature 를 사용한다.
 * 답장은 reply_mailbox_id(원문이 위치한 메일함)를 함께 전송하며, 서버가 원문 Message-ID·References 로 대화를 연결한다.
 * 예약 보내기: 작성 창 "보내기 ▾" 메뉴 → 시각 선택(MailScheduleDialog) → send_at. 예약함은 사이드바에 위치한다.
 *
 * ref: { close, send, saveDraft, setReplyAll, focus }
 */
import { useEffect, useImperativeHandle, useRef, useState, type DragEvent, type KeyboardEvent, type Ref } from 'react'
import DOMPurify from 'dompurify'
import { useI18n } from '~/i18n'
// class 를 단순 연결(tailwind-merge 를 사용하는 cn 은 leading-[1.35]+text-xl 같은 조합을 제거함)
import { clsx as cx } from 'clsx'
import { $fetch } from '~/lib/api'
import { useAuth } from '~/composables/useAuth'
import { useMail, mailStore, fetchAccounts, sendMessage, uploadAttachment, type UploadedAttachment, type ComposeMode, type MessageDetail } from '~/composables/useMail'
import { useMailSignature, mailSignatureStore, fetchSignatures, getDefaultSignature } from '~/composables/useMailSignature'
import { addToast } from '~/composables/useToast'
import { bumpMailDrafts } from '~/composables/useMailCompose'
import { confirmBox } from '~/composables/useDialog'
import { formatMailDate } from '~/utils/mailQuery'
import { parseAddresses, joinAddrs, textToHtml, quoteOf, forwardOf, reSubject, replyRecipients, largeAttachmentBlock, type LargeAttachment } from '~/components/mail/composeText'
import { NuxtLink } from '~/components/NuxtLink'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiButton } from '~/components/ui/Button'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { MailComposeEditor, type MailComposeEditorHandle } from '~/components/mail/MailComposeEditor'
import { MailRecipientField } from '~/components/mail/MailRecipientField'
import { MailComposeAttachment } from '~/components/mail/MailComposeAttachment'
import { MailComposeQuota } from '~/components/mail/MailComposeQuota'
import { MailSignaturePicker } from '~/components/mail/MailSignaturePicker'
import { MailScheduleDialog } from '~/components/mail/MailScheduleDialog'

/** 일반 첨부 합계 한도 — 초과 파일은 대용량 첨부(파일함 + 30일 링크)로 전환 */
const MAX_BYTES = 15 * 1024 * 1024
const LARGE_FOLDER = '메일 대용량 첨부'

export interface MailComposerHandle {
  /** 닫기(= 작성 내용이 있으면 임시보관함에 저장) */
  close: () => Promise<void>
  /** 보내기 */
  send: () => Promise<void>
  /** 임시 저장 */
  saveDraft: () => Promise<boolean>
  /** 인라인 답장: 답장 ↔ 전체 답장 */
  setReplyAll: (all: boolean) => void
  /** 본문에 포커스 */
  focus: () => void
}

export interface MailComposerProps {
  /** window(플로팅 창) · page(모바일 전체 화면) · inline(본문 아래 인라인 답장) */
  variant: 'window' | 'page' | 'inline'
  /** 새 메일·답장·전체 답장·전달·임시 보관 이어 쓰기 */
  mode: ComposeMode
  /** 답장·전달 원문 id */
  msgId?: string | null
  /** 이어 쓸 임시 보관 메일 id */
  draftId?: string | null
  /** 목록에서 열려 있던 원문(없으면 msgId 로 조회) */
  original?: Readonly<MessageDetail> | null
  /** 새 메일 받는 사람 사전 입력(연락처 "메일 쓰기" 등) */
  to?: string | null
  /** 화면 내 AI 답장 초안 — 답장 본문 최상단에 삽입. 해당 초안으로 발송 시 서버가 X-AI-Generated 를 부착 */
  aiDraft?: string | null
  /** 닫힘(발송·폐기·저장 후) */
  onClose?: () => void
  /** 발송 완료 */
  onSent?: () => void
  /** 제목 줄 문구(제목 입력 또는 모드 이름) */
  onTitle?: (title: string) => void
  /** 인라인 답장의 답장 ↔ 전체 답장 전환 */
  onUpdateMode?: (mode: ComposeMode) => void
  /** false 이면 숨김(인스턴스는 유지 — 최소화한 작성 창) */
  show?: boolean
  /** { close, send, saveDraft, setReplyAll, focus } */
  ref?: Ref<MailComposerHandle | null>
}

/** 메일 작성 본체 */
export function MailComposer({
  variant, mode: modeProp, msgId = null, draftId: draftIdProp = null, original: originalProp = null, to = null, aiDraft = null,
  onClose, onSent, onTitle, onUpdateMode, show = true, ref,
}: MailComposerProps) {
  const { t } = useI18n()
  const { user } = useAuth()
  const { accounts } = useMail()
  const { signatures } = useMailSignature()

  const [mode, setMode] = useState<ComposeMode>(modeProp)
  const [draftId, setDraftId] = useState<string | null>(draftIdProp)
  const [accountId, setAccountId] = useState<string | null>(null)
  const [fromName, setFromName] = useState('')
  const [toField, setToField] = useState('')
  const [ccField, setCcField] = useState('')
  const [bccField, setBccField] = useState('')
  const [showCc, setShowCc] = useState(false)
  const [showBcc, setShowBcc] = useState(false)
  const [subject, setSubject] = useState('')
  const [bodyHtml, setBodyHtml] = useState<string | null>(null)
  const [bodyText, setBodyText] = useState('')
  const [initialContent, setInitialContent] = useState('')
  /** 인라인 답장은 인용을 본문에 포함하지 않고 발송 시 부착(시안에 인용 미표시) */
  const hiddenQuote = useRef<{ html: string; text: string } | null>(null)
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([])
  const [largeFiles, setLargeFiles] = useState<LargeAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [sending, setSending] = useState(false)
  const [ready, setReady] = useState(false)
  // 메일 계정 없음 — 작성이 불가하며, 임시 저장해도 다시 열 화면이 없음(온보딩만 표시). 작성 화면 대신 연결 안내 표시.
  const [noAccount, setNoAccount] = useState(false)
  const [error, setError] = useState('')
  const [requestReadReceipt, setRequestReadReceipt] = useState(false)
  const [signatureId, setSignatureId] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const original = useRef<Readonly<MessageDetail> | null>(originalProp)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const editorRef = useRef<MailComposeEditorHandle | null>(null)
  const [sendMenu, setSendMenu] = useState(false)
  /** 예약 보내기 시각 선택 */
  const [scheduleOpen, setScheduleOpen] = useState(false)
  /** 답장 원문이 위치한 메일함(창을 연 후 폴더를 이동해도 유지) */
  const replyMailboxId = useRef<string | null>(null)
  /** 인라인 답장 Aa — 서식 툴바 표시 */
  const [showFormat, setShowFormat] = useState(false)

  const isPage = variant === 'page'
  const isInline = variant === 'inline'

  const account = accounts.find(a => a.id === accountId) || null
  const fromEmail = account?.email || user?.primary_email || user?.email || ''
  const ownDomain = (fromEmail.split('@')[1] || '').toLowerCase()
  const totalSize = attachments.reduce((s, a) => s + a.size, 0)
  const signature = signatures.find(s => s.id === signatureId) || null
  const signatureHtml = signature ? DOMPurify.sanitize(signature.html_content) : ''
  const savedLabel = savedAt
    ? savedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
    : ''

  const modeTitle = (() => {
    switch (mode) {
      case 'reply': return t('mail.compose.reply')
      case 'replyAll': return t('mail.compose.replyAll')
      case 'forward': return t('mail.compose.forward')
      case 'resend': return t('mail.compose.resend')
      case 'draft': return t('mail.compose.draftTitle')
      default: return t('mail.compose.new')
    }
  })()
  const titleText = subject.trim() || modeTitle
  const onTitleRef = useRef(onTitle)
  onTitleRef.current = onTitle
  useEffect(() => { onTitleRef.current?.(titleText) }, [titleText])

  const dirty = !!(toField.trim() || subject.trim() || bodyText.trim() || attachments.length || largeFiles.length)

  // 타이머·언마운트·비동기 처리기가 최신 값을 읽는 참조
  const cur = useRef({ toField, ccField, bccField, subject, bodyHtml, bodyText, signatureId, draftId, attachments, largeFiles, dirty, ready, fromEmail, mode, accountId, fromName, requestReadReceipt, uploading, scheduleOpen })
  cur.current = { toField, ccField, bccField, subject, bodyHtml, bodyText, signatureId, draftId, attachments, largeFiles, dirty, ready, fromEmail, mode, accountId, fromName, requestReadReceipt, uploading, scheduleOpen }
  const cb = useRef({ onClose, onSent, onUpdateMode })
  cb.current = { onClose, onSent, onUpdateMode }

  /** 답장·전체 답장 받는 사람(인라인 답장의 "전체 답장으로" 전환에도 사용) */
  function applyReplyRecipients(msg: Readonly<MessageDetail>, all: boolean, from = cur.current.fromEmail) {
    const r = replyRecipients(msg, all, from)
    setToField(r.to)
    if (all) {
      setCcField(r.cc)
      setShowCc(r.ccCount > 0)
    } else {
      setCcField('')
      setShowCc(false)
    }
  }

  async function loadOriginal(): Promise<Readonly<MessageDetail> | null> {
    if (original.current) return original.current
    if (!msgId) return null
    try {
      const s = mailStore.getState()
      const params: Record<string, string> = { mailbox_id: s.selectedMailboxId || 'INBOX' }
      if (s.selectedAccountId) params.account_id = s.selectedAccountId
      original.current = await $fetch<MessageDetail>(`/api/mail/messages/${msgId}`, { params })
      return original.current
    } catch {
      return null
    }
  }

  /** 원본 메일의 첨부를 발송용으로 복사해 첨부(전달·다시 보내기) */
  async function reuseAttachments(msg: Readonly<MessageDetail>) {
    if (!msg.attachments?.length || !msgId) return
    try {
      const s = mailStore.getState()
      const params: Record<string, string> = { mailbox_id: s.selectedMailboxId || msg.mailbox_ids?.[0] || 'INBOX' }
      if (s.selectedAccountId) params.account_id = s.selectedAccountId
      const r = await $fetch<{ attachments: UploadedAttachment[] }>(`/api/mail/messages/${msgId}/attachments/reuse`, { method: 'POST', params })
      if (r.attachments.length) setAttachments(a => [...a, ...r.attachments])
    } catch {
      setError(t('mail.compose.attachCopyFailed'))
    }
  }

  // ─── 임시 저장 ───
  const autoSaveTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastSaved = useRef('')
  function snapshot() {
    const c = cur.current
    return JSON.stringify([c.toField, c.ccField, c.bccField, c.subject, c.bodyHtml, c.bodyText, c.signatureId, c.largeFiles.map(l => l.url)])
  }

  async function saveDraft(): Promise<boolean> {
    const snap = snapshot()
    if (snap === lastSaved.current) return true
    const c = cur.current
    if (!c.toField.trim() && !c.subject.trim() && !c.bodyText.trim()) return true
    try {
      const result = await $fetch<{ id: string }>('/api/mail/drafts', {
        method: 'POST',
        body: {
          id: c.draftId,
          subject: c.subject || null,
          to: parseAddresses(c.toField),
          cc: parseAddresses(c.ccField),
          bcc: parseAddresses(c.bccField),
          // 대용량 첨부 링크는 임시 저장본 본문 끝에 포함(다시 열어도 링크 유지)
          body_html: c.largeFiles.length ? `${c.bodyHtml || ''}${largeBlock(c.largeFiles).html}` : c.bodyHtml,
          body_text: ((c.bodyText || '') + largeBlock(c.largeFiles).text) || null,
          // 서명은 본문에 포함하지 않고 id 로만 저장(""=서명 없음으로 저장)
          signature_id: c.signatureId || '',
        },
      })
      cur.current = { ...cur.current, draftId: result.id }
      setDraftId(result.id)
      lastSaved.current = snap
      setSavedAt(new Date())
      bumpMailDrafts()
      return true
    } catch {
      return false
    }
  }

  async function deleteDraft() {
    const id = cur.current.draftId
    if (!id) return
    try { await $fetch(`/api/mail/drafts/${id}`, { method: 'DELETE' }) } catch { /* 이미 없음 */ }
    bumpMailDrafts()
  }

  // ─── 초기화 ───
  /** 발송 또는 폐기 완료 시 true — 화면 이탈 시 재저장하지 않음 */
  const finished = useRef(false)
  useEffect(() => {
    let alive = true
    void (async () => {
      setFromName(user?.display_name || user?.username || '')
      if (mailStore.getState().accounts.length === 0) await fetchAccounts()
      const ms = mailStore.getState()
      if (!ms.accountsError && ms.accounts.length === 0) {
        finished.current = true   // 임시 저장을 수행하지 않음
        if (alive) setNoAccount(true)
        return
      }
      const accId = ms.selectedAccountId || ms.accounts.find(a => a.is_default)?.id || ms.accounts[0]?.id || null
      setAccountId(accId)
      const accEmail = ms.accounts.find(a => a.id === accId)?.email || user?.primary_email || user?.email || ''
      // 서명 목록은 싱글턴 — 메일을 열 때마다(인라인 답장) 재조회하지 않음
      if (mailSignatureStore.getState().signatures.length === 0) await fetchSignatures().catch(() => {})

      if (modeProp === 'new' && to) setToField(to)

      /** 초안에 저장돼 있던 서명(있으면 기본 서명보다 우선) */
      let draftSignature: string | null = null
      if (modeProp === 'draft' && draftIdProp) {
        try {
          const d = await $fetch<any>(`/api/mail/drafts/${draftIdProp}`)
          setToField(joinAddrs(d.to || []))
          setCcField(joinAddrs(d.cc || []))
          setBccField(joinAddrs(d.bcc || []))
          setShowCc((d.cc || []).length > 0)
          setShowBcc((d.bcc || []).length > 0)
          setSubject(d.subject || '')
          // 서명을 제외한 본문으로 이어 씀(기존 초안 본문에 포함된 서명 + 발송 시 부착되는 서명 = 이중 서명 방지)
          const html = d.body_html_without_signature ?? d.body_html
          const text = d.body_text_without_signature ?? d.body_text
          setInitialContent(html || textToHtml(text || ''))
          draftSignature = d.signature_id || null
          // AI 가 초안에 첨부한 워크스페이스 파일(서버가 열람 시 임시 첨부로 변환)
          if (Array.isArray(d.attachments) && d.attachments.length) setAttachments(d.attachments)
          if (d.attachment_error) addToast('warning', d.attachment_error)
        } catch { /* 삭제된 초안 — 빈 창 표시 */ }
      } else if (modeProp !== 'new') {
        const msg = await loadOriginal()
        if (msg) {
          replyMailboxId.current = msg.mailbox_ids?.[0] || mailStore.getState().selectedMailboxId || null
          if (modeProp === 'forward') {
            setSubject(reSubject(msg.subject, 'Fwd:'))
            const f = forwardOf(msg)
            setInitialContent(`<p></p>${f.html}`)
            await reuseAttachments(msg)
          } else if (modeProp === 'resend') {
            // 다시 보내기 — 받는 사람·제목·본문·첨부를 그대로 사용(원본 본문에 서명이 이미 포함되어 서명은 부착하지 않음)
            setToField(joinAddrs(msg.to))
            setCcField(joinAddrs(msg.cc))
            setBccField(joinAddrs(msg.bcc))
            setShowCc(msg.cc.length > 0)
            setShowBcc(msg.bcc.length > 0)
            setSubject(msg.subject || '')
            setInitialContent(msg.html_body || textToHtml(msg.text_body || ''))
            await reuseAttachments(msg)
          } else {
            setSubject(reSubject(msg.subject, 'Re:'))
            applyReplyRecipients(msg, modeProp === 'replyAll', accEmail)
            const q = quoteOf(msg)
            const lead = aiDraft ? `${textToHtml(aiDraft)}<p></p>` : '<p></p>'
            if (variant === 'inline') {
              hiddenQuote.current = q
              if (aiDraft) setInitialContent(textToHtml(aiDraft))
            } else setInitialContent(`${lead}${q.html}`)
          }
        }
      }

      const sigs = mailSignatureStore.getState().signatures
      if (modeProp === 'resend') { if (alive) setReady(true); return }
      const localDefault = sigs.find(s => s.is_default)
      if (draftSignature && sigs.some(s => s.id === draftSignature)) setSignatureId(draftSignature)
      else if (localDefault) setSignatureId(localDefault.id)
      else if (sigs.length === 0) {
        try {
          const def = await getDefaultSignature()
          if (def) setSignatureId(def.id)
        } catch { /* 서명 없음 */ }
      }

      if (alive) setReady(true)
    })()
    return () => { alive = false }
    // 마운트 시 1회 실행
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ready 직후(다음 렌더 뒤 lastSaved·타이머·포커스)
  useEffect(() => {
    if (!ready) return
    lastSaved.current = snapshot()
    autoSaveTimer.current = setInterval(() => { void saveDraft() }, 30000)
    // 플로팅 창만 즉시 입력 가능하도록 포커스 — 인라인 답장은 메일을 열 때마다 포커스를 가져가면 J/K 단축키가 차단됨
    if (variant === 'window') editorRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  useEffect(() => () => {
    if (autoSaveTimer.current) clearInterval(autoSaveTimer.current)
    // 인라인 답장 작성 중 다른 메일을 열거나 창이 화면과 함께 제거될 때 작성 내용을 임시 저장으로 보존한다.
    // 인라인 답장은 본문 작성 내용이 있을 때만 저장한다: 받는 사람이 항상 입력되어 있어 "전체 답장"·서명만 변경하고 이동해도 빈 초안이 누적되었다.
    if (!finished.current && cur.current.ready && cur.current.dirty && (variant !== 'inline' || cur.current.bodyText.trim())) void saveDraft()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 인라인 답장 "전체 답장으로" ↔ "답장만"
  function toggleReplyAll() {
    const next: ComposeMode = cur.current.mode === 'replyAll' ? 'reply' : 'replyAll'
    cur.current = { ...cur.current, mode: next }
    setMode(next)
    if (original.current) applyReplyRecipients(original.current, next === 'replyAll')
    cb.current.onUpdateMode?.(next)
  }

  // ─── 첨부 ───
  function largeBlock(list: readonly LargeAttachment[]) {
    return largeAttachmentBlock(list, { title: t('mail.compose.largeTitle'), until: d => t('mail.compose.largeUntil', { date: d }) })
  }
  /** 대용량 첨부 — 사용자 파일함(메일 대용량 첨부/<시각>)에 업로드하고 30일 다운로드 링크를 생성한다. 폴더를 매번 새로 생성하여
   *  동일 이름 파일이 덮어쓰여 기존 링크가 새 파일을 가리키는 문제를 방지한다. */
  async function uploadLarge(file: File) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const form = new FormData()
    form.append('file', file)
    const up = await $fetch<{ name: string; size: number; path: string }>('/api/files/upload', {
      method: 'POST', body: form, params: { path: `my/${LARGE_FOLDER}/${stamp}-${Math.random().toString(36).slice(2, 6)}`, size: file.size },
    })
    const link = await $fetch<{ url: string; expires_at: string | null }>('/api/files/share', { method: 'POST', body: { path: up.path, expires_in: '30d' } })
    const item: LargeAttachment = { name: up.name, size: up.size, url: link.url, path: up.path, expiresAt: link.expires_at }
    cur.current = { ...cur.current, largeFiles: [...cur.current.largeFiles, item] }
    setLargeFiles(l => [...l, item])
  }
  async function handleFiles(files: FileList | File[] | null) {
    if (!files) return
    let total = cur.current.attachments.reduce((s, a) => s + a.size, 0)
    for (const file of Array.from(files)) {
      if (total + file.size > MAX_BYTES) {
        setUploading(true)
        try {
          await uploadLarge(file)
          addToast('info', t('mail.compose.largeConverted', { name: file.name }))
        } catch (e: any) {
          setError(e?.data?.detail || t('mail.compose.uploadFailed'))
        } finally {
          setUploading(false)
        }
        continue
      }
      setUploading(true)
      try {
        const up = await uploadAttachment(file)
        cur.current = { ...cur.current, attachments: [...cur.current.attachments, up] }
        setAttachments(a => [...a, up])
        total += up.size
      } catch (e: any) {
        setError(e?.data?.detail || t('mail.compose.uploadFailed'))
      } finally {
        setUploading(false)
      }
    }
  }
  function pickFiles() { fileInput.current?.click() }
  function onDrop(e: DragEvent) { e.preventDefault(); void handleFiles(e.dataTransfer?.files || null) }
  function removeAttachment(i: number) { setAttachments(a => a.filter((_, j) => j !== i)) }
  // 목록에서만 제외 — 업로드한 파일·링크는 사용자 파일함에 유지됨(삭제는 파일함에서 수행)
  function removeLarge(i: number) { setLargeFiles(l => l.filter((_, j) => j !== i)) }

  // ─── 보내기 ───
  /** 발송 중 — state(sending)는 다음 렌더링에서야 갱신되어 Ctrl+Enter 연속 입력을 차단하지 못함 */
  const sendingRef = useRef(false)
  async function send(sendAt: string | null = null) {
    if (sendingRef.current) return
    const c = cur.current
    // 업로드 중인 첨부가 누락된 채 발송되는 것을 방지
    if (c.uploading) { setError(t('mail.compose.uploadingWait', '첨부를 올리는 중입니다. 다 올라간 뒤에 보내 주세요.')); setScheduleOpen(false); return }
    const toList = parseAddresses(c.toField)
    if (toList.length === 0) { setError(t('mail.compose.recipientRequired')); setScheduleOpen(false); return }
    sendingRef.current = true
    setError('')
    setSending(true)
    setSendMenu(false)
    let html = c.bodyHtml || (c.bodyText ? textToHtml(c.bodyText) : '')
    let text = c.bodyText
    if (c.largeFiles.length) {
      const b = largeBlock(c.largeFiles)
      html += b.html
      text += b.text
    }
    // 서명은 서버가 signature_id 로 부착(인용 바로 앞, 없으면 끝) — 여기서 삽입하면 이중 서명 발생
    if (hiddenQuote.current) {
      html += `<br>${hiddenQuote.current.html}`
      text += `\n\n${hiddenQuote.current.text}`
    }
    try {
      const res = await sendMessage({
        from_name: c.fromName || undefined,
        account_id: c.accountId || undefined,
        to: toList,
        cc: parseAddresses(c.ccField),
        bcc: parseAddresses(c.bccField),
        subject: c.subject,
        text_body: text,
        html_body: html || null,
        in_reply_to: c.mode === 'reply' || c.mode === 'replyAll' || c.mode === 'forward' ? (msgId || original.current?.id || null) : null,
        references: [],
        attachments: c.attachments.length ? c.attachments : undefined,
        request_read_receipt: c.requestReadReceipt,
        signature_id: c.signatureId || null,
        reply_mailbox_id: replyMailboxId.current,
        send_at: sendAt,
        // AI 초안으로 시작한 답장 — 사용자가 수정 후 발송해도 AI 기본법 표시를 부착(서버 X-AI-Generated)
        ...(aiDraft ? { ai_generated: true } : {}),
      })
      finished.current = true
      setScheduleOpen(false)
      await deleteDraft()
      if (autoSaveTimer.current) { clearInterval(autoSaveTimer.current); autoSaveTimer.current = null }
      if (res?.scheduled && res.send_at) addToast('success', t('mail.compose.scheduled', { when: formatMailDate(res.send_at, true) }))
      else addToast('success', t('mail.compose.sent'))
      cb.current.onSent?.()
      cb.current.onClose?.()
    } catch (e: any) {
      setError(e?.data?.detail || t('mail.compose.sendFailed'))
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  // ─── 닫기(= 임시보관함에 저장) · 버리기 ───
  async function close() {
    finished.current = true
    if (cur.current.dirty) {
      const ok = await saveDraft()
      // 초안은 첨부를 포함하지 않음(업로드 blob 은 짧은 TTL 의 임시 보관) — 첨부가 있으면 해당 사실을 안내
      if (ok && cur.current.draftId) {
        if (cur.current.attachments.length) addToast('warning', t('mail.compose.savedToDraftsNoAttachments'))
        else addToast('info', t('mail.compose.savedToDrafts'))
      }
      else if (!ok) addToast('warning', t('mail.compose.draftSaveFailed'))
    }
    cb.current.onClose?.()
  }
  async function discard() {
    if (cur.current.dirty && !await confirmBox(t('mail.compose.discardConfirm'), { title: t('mail.compose.discardTitle'), confirmLabel: t('mail.compose.discard'), danger: true })) return
    finished.current = true
    await deleteDraft()
    if (autoSaveTimer.current) { clearInterval(autoSaveTimer.current); autoSaveTimer.current = null }
    cb.current.onClose?.()
  }

  function onKeydown(e: KeyboardEvent) {
    if (!(e.ctrlKey || e.metaKey) || e.key !== 'Enter') return
    e.preventDefault()
    // 예약 시각 선택 중에는 즉시 발송으로 이어지지 않도록 차단(대화상자는 포털이지만 React 이벤트는 여기까지 전파됨)
    if (cur.current.scheduleOpen) return
    // 받는 사람 칸에서 입력한 경우 방금 확정한 칩이 다음 렌더링에 반영됨 — 그 이후에 발송
    setTimeout(() => { void send() }, 0)
  }
  function openSchedule() {
    setSendMenu(false)
    setScheduleOpen(true)
  }

  /** 인라인 답장: 단축키 R/A 로 답장·전체 답장 선택 */
  function setReplyAll(all: boolean) {
    if ((cur.current.mode === 'replyAll') !== all) toggleReplyAll()
    editorRef.current?.focus()
  }
  useImperativeHandle(ref, () => ({ close, send: () => send(), saveDraft, setReplyAll, focus: () => editorRef.current?.focus() }))

  const accountOptions = accounts.map(a => ({ value: a.id, label: a.email }))
  function closeMenuSoon() { setTimeout(() => { setSendMenu(false) }, 150) }

  const fileInputEl = <input ref={fileInput} type="file" multiple className="hidden" onChange={e => { void handleFiles(e.target.files) }} />

  // ─────────── 인라인 답장 ───────────
  if (isInline) {
    return (
      <section
        aria-label={t('mail.compose.inlineReply')}
        className="rounded-lg border border-ring bg-card shadow-[0_0_0_2px_hsl(var(--ring)/0.3)]"
        onKeyDown={onKeydown}
        onDrop={onDrop}
        onDragOver={e => e.preventDefault()}
      >
        <div className="flex flex-wrap items-center gap-x-2 px-3.5 pt-2.5 text-xs text-muted-foreground">
          <b className="font-semibold text-foreground">{mode === 'replyAll' ? t('mail.compose.replyAll') : t('mail.compose.reply')}</b>
          <span className="min-w-0 truncate">{toField ? parseAddresses(toField).map(a => a.name || a.email).join(', ') : ''}</span>
          <span aria-hidden="true">·</span>
          <button type="button" className="relative font-semibold text-primary hover:underline before:absolute before:-inset-y-3 before:inset-x-0 before:content-['']" onClick={toggleReplyAll}>
            {mode === 'replyAll' ? t('mail.compose.toReply') : t('mail.compose.toReplyAll')}
          </button>
        </div>
        <MailComposeEditor
          ref={editorRef}
          onUpdateHtml={setBodyHtml}
          onUpdateText={setBodyText}
          initialContent={initialContent}
          toolbar={showFormat ? 'desktop' : 'none'}
          placeholder={t('mail.compose.replyPlaceholder')}
          bodyClass="min-h-[40px] max-h-[320px] px-3.5 py-2 text-[14px] leading-[1.7]"
        />
        {signatureHtml && <div className="px-3.5 pb-2 text-[13px] text-muted-foreground [&_p]:m-0" aria-label={t('mail.compose.signature')}>— <span dangerouslySetInnerHTML={{ __html: signatureHtml }} /></div>}
        {(attachments.length > 0 || largeFiles.length > 0 || uploading) && (
          <div className="flex flex-wrap items-center gap-2 px-3.5 pb-2.5">
            {attachments.map((att, i) => <MailComposeAttachment key={att.blobId} att={att} onRemove={() => removeAttachment(i)} />)}
            {largeFiles.map((l, i) => <MailComposeAttachment key={l.path} att={{ blobId: l.path, name: l.name, size: l.size, type: '' }} badge={t('mail.compose.largeBadge')} onRemove={() => removeLarge(i)} />)}
            <MailComposeQuota used={totalSize} max={MAX_BYTES} uploading={uploading} />
          </div>
        )}
        {aiDraft && <p className="flex items-center gap-1.5 px-3.5 pb-2 text-xs text-muted-foreground"><UiIcon name="sparkles" className="h-3.5 w-3.5 text-primary" />{t('aiInline.mail.composeNote')}</p>}
        {error && <p role="alert" className="px-3.5 pb-2 text-xs text-danger">{error}</p>}
        <div className="flex items-center gap-0.5 border-t border-border px-2 py-1.5 text-muted-foreground">
          <UiIconButton label={t('mail.compose.format')} pressed={showFormat} onClick={() => setShowFormat(!showFormat)}><span className="text-[13px] font-semibold">Aa</span></UiIconButton>
          <UiIconButton label={t('mail.compose.attach')} disabled={uploading} onClick={pickFiles}><UiIcon name="paperclip" /></UiIconButton>
          <MailSignaturePicker modelValue={signatureId} onUpdateModelValue={setSignatureId} signatures={signatures} className="ml-1.5" />
          <span className="flex-1" />
          {savedLabel && <span className="mr-2 text-[11px]">{`${t('mail.compose.autoSaved')} `}<span className="font-mono">{savedLabel}</span></span>}
          <UiButton size="xs" className="rounded-md px-3.5 font-semibold" disabled={sending || uploading || !ready} onClick={() => send()}>{sending ? t('mail.compose.sending') : t('common.send')}</UiButton>
        </div>
        {fileInputEl}
      </section>
    )
  }

  // ─────────── 계정 없음: 작성 화면 대신 연결 안내 ───────────
  if (noAccount) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-card" style={show ? undefined : { display: 'none' }}>
        {isPage && (
          <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border bg-background px-1">
            <UiIconButton label={t('common.close')} icon="close" size="lg" className="text-foreground" onClick={() => cb.current.onClose?.()} />
            <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold">{modeTitle}</h1>
          </header>
        )}
        <div className="flex flex-1 items-center justify-center p-6">
          <UiEmptyState
            title={t('mail.onboarding.title')}
            description={t('mail.onboarding.desc')}
            actionLabel={t('mail.onboarding.connect')}
            actionTo="/mail/accounts?add=1"
          />
        </div>
      </div>
    )
  }

  // ─────────── 작성 창(데스크톱) · 전체 화면(모바일) ───────────
  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-card"
      style={show ? undefined : { display: 'none' }}
      onKeyDown={onKeydown}
      onDrop={onDrop}
      onDragOver={e => e.preventDefault()}
    >
      {/* 모바일 상단 56: 닫기 · 제목 · 첨부 · 보내기 */}
      {isPage && (
        <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border bg-background px-1">
          <UiIconButton label={t('mail.window.closeSave')} icon="close" size="lg" className="text-foreground" onClick={close} />
          <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold">{modeTitle}</h1>
          <UiIconButton label={t('mail.compose.attach')} size="lg" disabled={uploading} onClick={pickFiles}><UiIcon name="paperclip" /></UiIconButton>
          <UiButton size="sm" className="mr-1.5 rounded-md px-4 text-sm font-semibold" disabled={sending || uploading || !ready} onClick={() => send()}>{sending ? t('mail.compose.sending') : t('common.send')}</UiButton>
        </header>
      )}

      {!ready
        ? <div className="flex-1 p-4"><UiSkeleton preset="text" rows={4} /></div>
        : (
          <>
            <div className={cx('shrink-0', isPage ? 'bg-background' : '')}>
              {/* 보낸이 */}
              <div
                className={cx('flex items-center gap-2.5 border-b border-border px-4', isPage ? 'min-h-14 py-1.5 text-[15px]' : 'min-h-11 text-[13px]')}
              >
                <span className={cx('shrink-0 text-muted-foreground', isPage ? 'w-14 text-sm' : 'w-[52px]')}>{t('mail.compose.fromLabel')}</span>
                <div className={cx('flex min-w-0 flex-1', isPage ? 'flex-col' : 'items-baseline gap-1.5')}>
                  <input
                    value={fromName}
                    onChange={e => setFromName(e.target.value)}
                    aria-label={t('mail.compose.fromName')}
                    autoComplete="off"
                    className={cx('min-w-0 bg-transparent outline-hidden', isPage ? 'w-full' : 'w-auto max-w-[45%]')}
                    size={Math.max(4, fromName.length + 1)}
                  />
                  <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{fromEmail}</span>
                </div>
                {accountOptions.length > 1 && (
                  <label className="relative grid h-10 w-10 shrink-0 place-items-center text-muted-foreground">
                    <span className="sr-only">{t('mail.compose.fromAccount')}</span>
                    <UiIcon name="chevron-down" className="h-4 w-4" />
                    <select value={accountId ?? ''} onChange={e => setAccountId(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" aria-label={t('mail.compose.fromAccount')}>
                      {accountOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </label>
                )}
              </div>

              {/* 받는이 · 참조 · 숨은참조 */}
              <div className={cx('border-b border-border px-4', isPage ? 'py-2' : 'py-1.5')}>
                <MailRecipientField
                  modelValue={toField}
                  onUpdateModelValue={setToField}
                  borderless
                  size={isPage ? 'lg' : 'md'}
                  ownDomain={ownDomain}
                  label={t('mail.compose.toLabel')}
                  placeholder={t('mail.compose.recipientPlaceholder')}
                  actions={(!showCc || !showBcc)
                    ? (
                      <button
                        type="button"
                        className={cx("relative font-semibold text-primary hover:underline before:absolute before:-inset-y-3 before:inset-x-0 before:content-['']", isPage ? 'text-[13px]' : 'text-xs')}
                        onClick={() => { setShowCc(true); setShowBcc(!isPage || showBcc) }}
                      >{isPage ? t('mail.compose.cc') : t('mail.compose.ccBcc')}</button>
                    )
                    : undefined}
                />
              </div>
              {showCc && (
                <div className={cx('border-b border-border px-4', isPage ? 'py-2' : 'py-1.5')}>
                  <MailRecipientField modelValue={ccField} onUpdateModelValue={setCcField} borderless size={isPage ? 'lg' : 'md'} ownDomain={ownDomain} label={t('mail.compose.cc')} />
                </div>
              )}
              {showBcc && (
                <div className={cx('border-b border-border px-4', isPage ? 'py-2' : 'py-1.5')}>
                  <MailRecipientField modelValue={bccField} onUpdateModelValue={setBccField} borderless size={isPage ? 'lg' : 'md'} ownDomain={ownDomain} label={t('mail.compose.bcc')} />
                </div>
              )}
              {isPage && showCc && !showBcc && (
                <div className="border-b border-border px-4 py-1">
                  <button type="button" className="min-h-10 text-[13px] font-semibold text-primary" onClick={() => setShowBcc(true)}>{t('mail.compose.addBcc')}</button>
                </div>
              )}

              {/* 제목 */}
              <div className={cx('flex items-center border-b border-border px-4', isPage ? 'min-h-[52px]' : 'h-11')}>
                <input
                  value={subject}
                  onChange={e => setSubject(e.target.value)}
                  aria-label={t('mail.compose.subject')}
                  placeholder={t('mail.compose.subject')}
                  autoComplete="off"
                  className={cx('w-full bg-transparent font-semibold outline-hidden placeholder:font-normal placeholder:text-muted-foreground', isPage ? 'text-base' : 'text-[15px]')}
                />
              </div>
            </div>

            {/* 본문(+ 서명·첨부). 모바일은 서식 줄이 맨 아래 48 */}
            <MailComposeEditor
              ref={editorRef}
              onUpdateHtml={setBodyHtml}
              onUpdateText={setBodyText}
              initialContent={initialContent}
              toolbar={isPage ? 'mobile' : 'desktop'}
              className="min-h-0 flex-1"
              bodyClass={isPage ? 'px-4 py-3.5 text-[15px] leading-[1.65]' : 'px-4 py-3.5 text-[14px] leading-[1.7]'}
              below={(
                <>
                  {signatureHtml && <div className={cx('shrink-0 px-4 pb-2.5 text-muted-foreground [&_p]:m-0', isPage ? 'text-sm' : 'text-[13px]')} aria-label={t('mail.compose.signature')}>— <span dangerouslySetInnerHTML={{ __html: signatureHtml }} /></div>}
                  {(attachments.length > 0 || largeFiles.length > 0 || uploading) && (
                    <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-2.5">
                      {attachments.map((att, i) => <MailComposeAttachment key={att.blobId} att={att} size={isPage ? 'lg' : 'md'} onRemove={() => removeAttachment(i)} />)}
                      {largeFiles.map((l, i) => <MailComposeAttachment key={l.path} att={{ blobId: l.path, name: l.name, size: l.size, type: '' }} size={isPage ? 'lg' : 'md'} badge={t('mail.compose.largeBadge')} onRemove={() => removeLarge(i)} />)}
                      <MailComposeQuota used={totalSize} max={MAX_BYTES} uploading={uploading} />
                    </div>
                  )}
                  {aiDraft && <p className="flex shrink-0 items-center gap-1.5 px-4 pb-2 text-xs text-muted-foreground"><UiIcon name="sparkles" className="h-3.5 w-3.5 text-primary" />{t('aiInline.mail.composeNote')}</p>}
                  {error && <p role="alert" className="shrink-0 px-4 pb-2 text-xs text-danger">{error}</p>}
                </>
              )}
              toolbarEnd={<MailSignaturePicker modelValue={signatureId} onUpdateModelValue={setSignatureId} signatures={signatures} className="pr-2 text-[13px]" />}
            />

            {/* 데스크톱 작성 창 하단 56 */}
            {!isPage && (
              <footer className="flex h-14 shrink-0 items-center gap-1.5 border-t border-border px-3">
                <div className="relative inline-flex h-9 shrink-0 items-stretch overflow-visible rounded-md bg-primary text-[13px] font-semibold text-primary-foreground">
                  <button type="button" className="rounded-l-md px-3.5 hover:bg-primary/90 disabled:opacity-60" disabled={sending || uploading} onClick={() => send()}>{sending ? t('mail.compose.sending') : t('common.send')}</button>
                  <button
                    type="button"
                    aria-label={t('mail.compose.schedule')}
                    aria-haspopup="menu"
                    aria-expanded={sendMenu}
                    className="grid place-items-center rounded-r-md border-l border-primary-foreground/30 px-2.5 hover:bg-primary/90"
                    onClick={() => setSendMenu(!sendMenu)}
                    onBlur={closeMenuSoon}
                  ><UiIcon name="chevron-down" className="h-3.5 w-3.5" strokeWidth={2.4} /></button>
                  {sendMenu && (
                    <div role="menu" className="absolute bottom-full left-0 z-dropdown mb-1.5 w-56 rounded-lg border border-border bg-popover py-1 text-[13px] font-normal text-foreground shadow-md" onMouseDown={e => e.preventDefault()}>
                      <button type="button" role="menuitem" className="flex min-h-9 w-full items-center gap-2 px-3 text-left hover:bg-accent disabled:opacity-60" disabled={sending || uploading || !ready} onClick={openSchedule}>
                        <UiIcon name="clock" className="h-4 w-4 text-muted-foreground" />{` ${t('mail.compose.schedule')}…`}
                      </button>
                      <button type="button" role="menuitemcheckbox" aria-checked={requestReadReceipt} className="flex min-h-9 w-full items-center gap-2 px-3 text-left hover:bg-accent" onClick={() => setRequestReadReceipt(!requestReadReceipt)}>
                        <UiIcon name="eye" className="h-4 w-4 text-muted-foreground" />{` ${t('mail.compose.requestReceipt')}`}
                        {requestReadReceipt && <UiIcon name="check" className="ml-auto h-4 w-4 text-primary" />}
                      </button>
                    </div>
                  )}
                </div>
                <UiIconButton label={t('mail.compose.attachFile')} size="md" disabled={uploading} className="h-9 w-9" onClick={pickFiles}><UiIcon name="paperclip" /></UiIconButton>
                <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                  <MailSignaturePicker modelValue={signatureId} onUpdateModelValue={setSignatureId} signatures={signatures} />
                  <span aria-hidden="true">·</span>
                  <NuxtLink to="/settings/mail?tab=signatures" className="font-semibold text-primary hover:underline">{t('common.edit')}</NuxtLink>
                </span>
                <span className="flex-1" />
                {savedLabel && <span className="shrink-0 text-[11px] text-muted-foreground">{`${t('mail.compose.autoSaved')} `}<span className="font-mono">{savedLabel}</span></span>}
                <UiIconButton label={t('common.delete')} icon="trash" size="md" className="h-9 w-9" onClick={discard} />
              </footer>
            )}
          </>
        )}

      {fileInputEl}

      {scheduleOpen && (
        <MailScheduleDialog
          title={t('mail.compose.schedule')}
          confirmLabel={t('mail.schedule.confirm')}
          busy={sending}
          onClose={() => setScheduleOpen(false)}
          onConfirm={iso => { void send(iso) }}
        />
      )}
    </div>
  )
}

export default MailComposer
