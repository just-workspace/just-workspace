/**
 * 메일(모듈 싱글턴 상태 + 동작). 요청 주소·순서·본문·로그 문구 동일.
 *
 * React: const { messages, selectedMessage, selectMailbox, openMessage, ... } = useMail()
 *   외부에서 변경하는 상태는 setter 를 함께 제공한다:
 *     selectedAccountId → setSelectedAccountId(v) · selectedIds → setSelectedIds(v) · quickFilters → setQuickFilters(v)
 *   (searchQuery 는 setSearchQuery(q))
 * 컴포넌트 외부: mailStore.getState(), 또는 아래 동작 함수를 직접 import.
 * 단일 필드만 참조하는 컴포넌트는 useStore(mailStore, s => s.field) 로 구독하면 재렌더가 감소한다.
 *
 * 목록 행·메일함 객체는 직접 수정하지 않고 동일 값의 새 객체로 교체한다.
 */
import { createStore, useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { $fetch } from '~/lib/api'
import { apiUrl, isBundledApp } from '~/lib/runtimeConfig'
import { downloadApi } from '~/utils/apiDownload'
import { applyLabelChange } from '~/utils/mailQuery'
import { openCompose as openComposeWindow } from '~/composables/useMailCompose'

export interface EmailAddress {
  name: string | null
  email: string
}

export interface Mailbox {
  id: string
  name: string
  role: string | null
  unread_count: number
  total_count: number
  sort_order: number
}

export interface MessageSummary {
  id: string
  thread_id: string | null
  mailbox_ids: string[]
  from_: EmailAddress[]
  to: EmailAddress[]
  subject: string | null
  preview: string | null
  received_at: string | null
  is_unread: boolean
  is_flagged: boolean
  has_attachment: boolean
  /** IMAP 키워드 라벨(POP3 는 항상 빈 배열) */
  labels?: string[]
  /** 서버 THREAD 지원 시 이 메일함 내 동일 대화 메일 수 */
  thread_count?: number | null
}

/** 예약 보내기 한 건(GET /api/mail/scheduled) */
export interface ScheduledMail {
  id: string
  account_id: string | null
  subject: string | null
  to: EmailAddress[]
  send_at: string
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled'
  error: string | null
  created_at: string
  sent_at: string | null
}

export interface Attachment {
  blob_id: string
  name: string | null
  type: string | null
  size: number
}

export interface MessageDetail {
  id: string
  thread_id: string | null
  mailbox_ids: string[]
  from_: EmailAddress[]
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  reply_to: EmailAddress[]
  subject: string | null
  text_body: string | null
  html_body: string | null
  preview: string | null
  received_at: string | null
  is_unread: boolean
  is_flagged: boolean
  attachments: Attachment[]
  disposition_notification_to: string | null
  mdn_sent: boolean
}

export interface UploadedAttachment {
  blobId: string
  type: string
  name: string
  size: number
}

export interface MailAccountInfo {
  id: string
  display_name: string
  email: string
  imap_host: string
  imap_port: number
  imap_security: string
  smtp_host: string
  smtp_port: number
  smtp_security: string
  username: string
  is_default: boolean
  is_builtin: boolean
  last_sync_at: string | null
  sync_error: string | null
  protocol?: 'imap' | 'pop3'
  archive_enabled?: boolean
}

export interface SendResult {
  ok: boolean
  /** 예약 발송으로 접수된 경우 true(id·send_at 포함) */
  scheduled?: boolean
  id?: string
  send_at?: string
}

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward' | 'resend' | 'draft'

export interface MailQuickFilters { unread: boolean; starred: boolean; attachment: boolean }

export interface SendMessageData {
  from_name?: string
  account_id?: string | null
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  subject: string
  text_body: string
  html_body?: string | null
  in_reply_to?: string | null
  references?: string[]
  attachments?: UploadedAttachment[]
  request_read_receipt?: boolean
  /** ISO — 미래 시각이면 서버가 예약 발송으로 접수한다 */
  send_at?: string | null
  /** 서버가 서명을 정확히 1개만 추가한다(본문에는 포함하지 않음) */
  signature_id?: string | null
  /** 답장 원문이 위치한 메일함 — 서버가 원문 Message-ID·References 를 조회한다 */
  reply_mailbox_id?: string | null
  /** 화면 내 AI 답장 초안으로 작성한 메일 — 서버가 X-AI-Generated 를 추가한다 */
  ai_generated?: boolean
}

export interface MailState {
  accounts: MailAccountInfo[]
  selectedAccountId: string | null
  mailboxes: Mailbox[]
  selectedMailboxId: string | null
  /** 다계정 트리: 계정별 메일함 캐시(지연 조회 — IMAP 왕복 비용) */
  mailboxesByAccount: Record<string, Mailbox[]>
  loadingAccountId: string | null
  messages: MessageSummary[]
  selectedMessage: MessageDetail | null
  currentPage: number
  totalMessages: number
  limit: number
  loadingMailboxes: boolean
  loadingMessages: boolean
  loadingMessage: boolean
  sending: boolean
  searchQuery: string
  selectedIds: Set<string>
  /** 실패가 "비어 있음" 으로 표시되지 않도록 — 목록·본문 각각 오류를 보유하고 UiErrorTile 로 표시한다. */
  listError: string | null
  /** 계정·메일함 조회 실패 — 빈 상태("메일이 없습니다")와 구분하여 오류 타일로 표시한다 */
  accountsError: string | null
  mailboxesError: string | null
  messageError: string | null
  /** 빠른 칩(안 읽음·별표·첨부) — 서버 필터(unread·flagged·has_attachment)로 전달한다. */
  quickFilters: MailQuickFilters
  /** 라벨(IMAP 키워드) — 사이드바 "라벨" 에서 선택하면 서버 label 필터를 적용한다. supported=false(POP3·키워드 미지원 서버)이면 UI 를 숨긴다. */
  labelFilter: string | null
  labelInfo: { labels: string[]; supported: boolean }
  /** 예약함(보내기 ▾ "예약 보내기"로 등록한 메일) — 사이드바 항목 선택 시 목록 영역에 예약 목록을 표시한다. */
  scheduledView: boolean
  scheduled: ScheduledMail[]
  loadingScheduled: boolean
}

function initialState(): MailState {
  return {
    accounts: [],
    selectedAccountId: null,
    mailboxes: [],
    selectedMailboxId: null,
    mailboxesByAccount: {},
    loadingAccountId: null,
    messages: [],
    selectedMessage: null,
    currentPage: 0,
    totalMessages: 0,
    limit: 50,
    loadingMailboxes: false,
    loadingMessages: false,
    loadingMessage: false,
    sending: false,
    searchQuery: '',
    selectedIds: new Set(),
    listError: null,
    accountsError: null,
    mailboxesError: null,
    messageError: null,
    quickFilters: { unread: false, starred: false, attachment: false },
    labelFilter: null,
    labelInfo: { labels: [], supported: false },
    scheduledView: false,
    scheduled: [],
    loadingScheduled: false,
  }
}

export const mailStore = createStore<MailState>()(() => initialState())

const get = () => mailStore.getState()
const set = (p: Partial<MailState>) => mailStore.setState(p)

// 마지막으로 서버에 전송한 필터 조합 — 칩 watch 가 동일 조합으로 재호출하지 않도록
let lastFilterKey = ''
let listSeq = 0
// 본문 열기 순번 — 지연 도착한 응답이 현재 화면(다른 메일·다른 폴더)을 덮어쓰지 않도록. 폴더·계정 변경 시 증가시킨다.
let openSeq = 0

/** 테스트용: 초기 상태로 복원 */
export function _resetMailStore() {
  lastFilterKey = ''
  listSeq = 0
  openSeq = 0
  mailStore.setState(initialState(), true)
}

// ─── 외부에서 변경하는 상태의 setter ───

export function setSelectedAccountId(id: string | null) { set({ selectedAccountId: id }) }
export function setSelectedIds(ids: Set<string>) { set({ selectedIds: ids }) }
export function setQuickFilters(f: MailQuickFilters) { set({ quickFilters: f }) }

// ─── Computed(상태 → 값) ───

export function mailTotalPages(s: MailState = get()) { return Math.ceil(s.totalMessages / s.limit) }
export function mailHasNextPage(s: MailState = get()) { return s.currentPage < mailTotalPages(s) - 1 }
export function mailHasPrevPage(s: MailState = get()) { return s.currentPage > 0 }
export function mailTotalUnread(s: MailState = get()) {
  return s.mailboxes
    .filter(m => m.role === 'inbox')
    .reduce((sum, m) => sum + m.unread_count, 0)
}
export function mailSelectedMailbox(s: MailState = get()) {
  return s.mailboxes.find(m => m.id === s.selectedMailboxId) || null
}
export function mailSelectedAccount(s: MailState = get()) {
  return s.accounts.find(a => a.id === s.selectedAccountId) || null
}
/**
 * 현재 계정의 POP3 여부. POP3 는 서버에 폴더가 없어(받은편지함 하나) 이동·보관·스팸·폴더 관리가 불가하다 —
 * 화면은 이 값으로 해당 버튼·메뉴·스와이프·단축키를 숨긴다(읽음·별표·삭제는 그대로 가능).
 */
export function mailIsPop3(s: MailState = get()) {
  return mailSelectedAccount(s)?.protocol === 'pop3'
}
/** 보관함(role=archive). 미제공 서버이면 보관 동작을 비활성으로 표시한다. */
export function mailArchiveMailbox(s: MailState = get()) {
  return s.mailboxes.find(m => m.role === 'archive') || null
}
/** 열린 메일의 목록 안 순번(1부터) — 본문 헤더 "3 / 24". 목록에 없으면 0. */
export function mailSelectedIndex(s: MailState = get()) {
  const id = s.selectedMessage?.id
  if (!id) return 0
  const i = s.messages.findIndex(m => m.id === id)
  return i < 0 ? 0 : i + 1
}

// ─── 내부 도우미 ───

/**
 * 메시지 단위 API(PATCH·DELETE·bulk)에 해당 UID 가 속한 폴더·계정을 전달한다.
 * 이전에는 누락되어 서버 기본값(INBOX·기본 계정)으로 처리되었고, 다른 폴더·계정에서 읽음·별표·이동·삭제가 무관한 메일에 적용되었다.
 */
function scopeParams(): Record<string, string> {
  const s = get()
  const p: Record<string, string> = { mailbox_id: s.selectedMailboxId || 'INBOX' }
  if (s.selectedAccountId) p.account_id = s.selectedAccountId
  return p
}

function filterKey() {
  const s = get()
  const f = s.quickFilters
  return `${f.unread ? 1 : 0}${f.starred ? 1 : 0}${f.attachment ? 1 : 0}|${s.labelFilter || ''}`
}

/** 오류 보조 문구: 서버 detail 우선, 없으면 "응답 502" */
function errorDetail(e: any): string {
  const d = e?.data?.detail
  if (typeof d === 'string' && d) return d
  const st = e?.statusCode ?? e?.status ?? e?.response?.status
  return st ? `HTTP ${st}` : (e?.message || '')
}

/** 목록 행 하나를 갱신한다(새 객체로 교체) */
function patchMessageRow(id: string, patch: Partial<MessageSummary>) {
  set({ messages: get().messages.map(m => (m.id === id ? { ...m, ...patch } : m)) })
}

/** 현재 메일함의 unread_count 를 갱신한다 */
function patchSelectedMailboxUnread(fn: (n: number) => number) {
  const s = get()
  // mailboxes 와 mailboxesByAccount[계정] 은 별개의 배열이다 — 다계정 트리의 수치도 함께 감소하도록 양쪽 모두 갱신한다
  const mailboxes = s.mailboxes.map(m => (m.id === s.selectedMailboxId ? { ...m, unread_count: fn(m.unread_count) } : m))
  const acc = s.selectedAccountId
  set(acc && s.mailboxesByAccount[acc]
    ? { mailboxes, mailboxesByAccount: { ...s.mailboxesByAccount, [acc]: mailboxes } }
    : { mailboxes })
}

// ─── Account actions ───

export async function fetchAccounts() {
  try {
    const data = await $fetch<MailAccountInfo[]>('/api/mail/accounts')
    set({ accountsError: null, accounts: data })
    if (!get().selectedAccountId && data.length > 0) {
      const def = data.find(a => a.is_default) || data[0]
      set({ selectedAccountId: def.id })
    }
  } catch (e: any) {
    console.error('fetchAccounts error:', e)
    set({ accountsError: errorDetail(e) })
  }
}

export async function selectAccount(id: string) {
  openSeq++
  set({ selectedAccountId: id, selectedMailboxId: null, selectedMessage: null, loadingMessage: false, currentPage: 0, searchQuery: '' })
  await fetchMailboxes()
}

// ─── Actions ───

export async function fetchMailboxes() {
  set({ loadingMailboxes: true, mailboxesError: null })
  try {
    const params: Record<string, any> = {}
    const acc = get().selectedAccountId
    if (acc) params.account_id = acc
    const data = await $fetch<{ mailboxes: Mailbox[] }>('/api/mail/mailboxes', { params })
    // 다계정 트리는 mailboxesByAccount 를 렌더링한다 — 함께 갱신하지 않으면 삭제·이동·새로고침 후에도 안 읽음 수가 이전 값으로 남는다
    if (acc) set({ mailboxesByAccount: { ...get().mailboxesByAccount, [acc]: data.mailboxes } })
    // 수신 중 계정이 변경된 경우 평면 목록은 변경하지 않는다(캐시만 갱신)
    if ((get().selectedAccountId || null) !== (acc || null)) return
    set({ mailboxes: data.mailboxes })
    // Auto-select inbox if nothing selected
    if (!get().selectedMailboxId) {
      const inbox = data.mailboxes.find(m => m.role === 'inbox')
      if (inbox) {
        set({ selectedMailboxId: inbox.id })
      } else if (data.mailboxes.length > 0) {
        set({ selectedMailboxId: data.mailboxes[0].id })
      }
    }
  } catch (e: any) {
    console.error('fetchMailboxes error:', e)
    set({ mailboxes: [], mailboxesError: errorDetail(e) })
  } finally {
    set({ loadingMailboxes: false })
  }
}

/** 계정별 메일함 지연 조회(트리 펼침 시). 캐시가 있으면 재사용. */
export async function fetchMailboxesFor(accountId: string): Promise<Mailbox[]> {
  const cached = get().mailboxesByAccount[accountId]
  if (cached) return cached
  set({ loadingAccountId: accountId })
  try {
    const data = await $fetch<{ mailboxes: Mailbox[] }>('/api/mail/mailboxes', { params: { account_id: accountId } })
    set({ mailboxesByAccount: { ...get().mailboxesByAccount, [accountId]: data.mailboxes } })
    // 현재 선택 계정이면 평면 목록도 동기화
    if (accountId === get().selectedAccountId) set({ mailboxes: data.mailboxes })
    return data.mailboxes
  } catch (e: any) {
    console.error('fetchMailboxesFor error:', e)
    return []
  } finally {
    set({ loadingAccountId: null })
  }
}

/** 트리에서 폴더 클릭 — 계정과 메일함을 함께 전환(메시지까지 로드) */
export async function selectAccountMailbox(accountId: string, mailboxId: string) {
  if (get().selectedAccountId !== accountId) {
    set({ selectedAccountId: accountId, mailboxes: get().mailboxesByAccount[accountId] || [], searchQuery: '' })
  }
  await selectMailbox(mailboxId)
}

export async function selectMailbox(id: string) {
  // 칩·라벨은 현재 폴더 범위 — 폴더 변경 시 해제한다(목록 수신 전에)
  openSeq++ // 이전 폴더에서 열던 메일의 응답은 폐기한다(해당 메일이 표시되어 이 폴더의 동일 번호 메일에 동작이 적용되는 문제 방지)
  set({
    quickFilters: { unread: false, starred: false, attachment: false },
    labelFilter: null,
    scheduledView: false,
    selectedMailboxId: id,
    selectedMessage: null,
    loadingMessage: false,
    selectedIds: new Set(),
    currentPage: 0,
    searchQuery: '',
  })
  await fetchMessages()
}

export async function fetchMessages() {
  const s = get()
  if (!s.selectedMailboxId) return
  const seq = ++listSeq
  set({ loadingMessages: true, listError: null })
  lastFilterKey = filterKey()
  try {
    const params: Record<string, any> = {
      mailbox_id: s.selectedMailboxId,
      page: s.currentPage,
      limit: s.limit,
    }
    if (s.selectedAccountId) params.account_id = s.selectedAccountId
    if (s.searchQuery.trim()) {
      params.q = s.searchQuery.trim()
    }
    // 빠른 칩·라벨은 서버에서 필터링한다(페이지 수·전체 개수도 필터링 결과 기준)
    if (s.quickFilters.unread) params.unread = true
    if (s.quickFilters.starred) params.flagged = true
    if (s.quickFilters.attachment) params.has_attachment = true
    if (s.labelFilter) params.label = s.labelFilter
    const data = await $fetch<{
      messages: MessageSummary[]
      total: number
      page: number
      limit: number
    }>('/api/mail/messages', { params })
    if (seq !== listSeq) return // 칩을 연속 조작하여 나중에 보낸 요청이 먼저 완료된 경우
    set({ messages: data.messages, totalMessages: data.total })
  } catch (e: any) {
    if (seq !== listSeq) return
    console.error('fetchMessages error:', e)
    set({ messages: [], listError: e?.data?.detail || e?.message || 'fetch failed' })
  } finally {
    if (seq === listSeq) set({ loadingMessages: false })
  }
}

/** 칩·라벨 변경 시 — 직전과 동일한 조합이면 재조회하지 않는다. 첫 페이지부터 조회한다. */
export async function applyFilters() {
  if (filterKey() === lastFilterKey) return
  set({ currentPage: 0 })
  await fetchMessages()
}

/** 사이드바 라벨 선택(재선택 시 해제) */
export async function setLabelFilter(label: string | null) {
  set({ scheduledView: false, labelFilter: get().labelFilter === label ? null : label })
  await applyFilters()
}

/** 현재 폴더의 라벨 목록과 서버 지원 여부. 실패 시 라벨 UI 를 숨긴다. */
export async function fetchLabels() {
  const s = get()
  const acct = s.accounts.find(a => a.id === s.selectedAccountId)
  if (!s.selectedMailboxId || acct?.protocol === 'pop3') { set({ labelInfo: { labels: [], supported: false } }); return }
  try {
    const data = await $fetch<{ labels: string[]; supported: boolean }>('/api/mail/labels', { params: scopeParams() })
    set({ labelInfo: { labels: data.labels || [], supported: !!data.supported } })
  } catch {
    set({ labelInfo: { labels: [], supported: false } })
  }
}

/** 라벨 추가·제거(PATCH add_labels/remove_labels). 목록의 labels·사이드바 라벨 목록도 갱신한다. */
export async function updateLabels(id: string, add: string[], remove: string[]): Promise<boolean> {
  if (!add.length && !remove.length) return true
  try {
    await $fetch(`/api/mail/messages/${id}`, {
      method: 'PATCH',
      body: { add_labels: add.length ? add : null, remove_labels: remove.length ? remove : null },
      params: scopeParams(),
    })
    const msg = get().messages.find(m => m.id === id)
    if (msg) patchMessageRow(id, { labels: applyLabelChange(msg.labels, add, remove) })
    const info = get().labelInfo
    const known = new Set(info.labels)
    const fresh = add.filter(l => !known.has(l))
    if (fresh.length) set({ labelInfo: { ...info, labels: [...info.labels, ...fresh] } })
    return true
  } catch (e: any) {
    console.error('updateLabels error:', e)
    return false
  }
}

/** 이 메일이 속한 대화(오래된 순, 보낸편지함 포함). 읽음 처리하지 않음. 실패 시 null. */
export async function fetchThread(id: string): Promise<MessageSummary[] | null> {
  try {
    const data = await $fetch<{ thread_id: string | null; messages: MessageSummary[] }>(`/api/mail/messages/${encodeURIComponent(id)}/thread`, {
      params: { ...scopeParams(), include_sent: true },
    })
    return data.messages || []
  } catch {
    return null
  }
}

/** 다른 메일함(보낸편지함 등)에 있을 수 있는 대화 메일 본문 — 스레드의 접힌 행을 펼칠 때 사용 */
export async function fetchMessageIn(id: string, mailboxId: string): Promise<MessageDetail | null> {
  try {
    const params: Record<string, string> = { mailbox_id: mailboxId }
    const acc = get().selectedAccountId
    if (acc) params.account_id = acc
    return await $fetch<MessageDetail>(`/api/mail/messages/${encodeURIComponent(id)}`, { params })
  } catch {
    return null
  }
}

// ─── 예약 보내기 ───

export async function fetchScheduled() {
  set({ loadingScheduled: true })
  try {
    set({ scheduled: await $fetch<ScheduledMail[]>('/api/mail/scheduled') })
  } catch (e: any) {
    console.error('fetchScheduled error:', e)
  } finally {
    set({ loadingScheduled: false })
  }
}

/** 사이드바 "예약함" — 목록 영역에 예약 목록 표시 */
export function openScheduled() {
  openSeq++
  set({ scheduledView: true, selectedMessage: null, loadingMessage: false, selectedIds: new Set() })
  void fetchScheduled()
}

/** 예약 시각 변경 — 실패(409 발송 중 등)는 호출자에게 예외로 전달한다 */
export async function rescheduleMail(id: string, sendAt: string) {
  const row = await $fetch<ScheduledMail>(`/api/mail/scheduled/${encodeURIComponent(id)}`, { method: 'PATCH', body: { send_at: sendAt } })
  set({ scheduled: get().scheduled.map(s => (s.id === id ? row : s)).sort((a, b) => a.send_at.localeCompare(b.send_at)) })
  return row
}

/** 예약 취소 — 실패(409 발송 중 등)는 호출자에게 예외로 전달한다 */
export async function cancelScheduled(id: string) {
  await $fetch(`/api/mail/scheduled/${encodeURIComponent(id)}`, { method: 'DELETE' })
  set({ scheduled: get().scheduled.filter(s => s.id !== id) })
}

export function setSearchQuery(q: string) {
  set({ searchQuery: q, currentPage: 0 })
  fetchMessages()
}

export async function openMessage(id: string) {
  const seq = ++openSeq
  set({ loadingMessage: true, messageError: null })
  try {
    const s = get()
    const params: Record<string, any> = { mailbox_id: s.selectedMailboxId || 'INBOX' }
    if (s.selectedAccountId) params.account_id = s.selectedAccountId
    const detail = await $fetch<MessageDetail>(`/api/mail/messages/${id}`, { params })
    if (seq !== openSeq) return // 그사이 다른 메일이 열렸거나 폴더가 변경됨
    set({ selectedMessage: detail })
    // Update unread status in list
    const msg = get().messages.find(m => m.id === id)
    if (msg && msg.is_unread) {
      patchMessageRow(id, { is_unread: false })
      // Update mailbox unread count
      const mb = mailSelectedMailbox()
      if (mb && mb.unread_count > 0) patchSelectedMailboxUnread(n => n - 1)
    }
  } catch (e: any) {
    if (seq !== openSeq) return
    console.error('openMessage error:', e)
    set({ messageError: e?.data?.detail || e?.message || 'open failed' })
  } finally {
    if (seq === openSeq) set({ loadingMessage: false })
  }
}

/**
 * 딥링크(`/mail/:id`, 모바일 본문 페이지)용 — 계정·폴더 범위를 먼저 맞춘 후 연다.
 * 목록이 없으면(새로고침 직후) 폴더 목록만 조회한 후 본문을 연다. 목록은 뒤로 이동 시 재조회한다.
 */
export async function openMessageAt(id: string, mailboxId?: string | null, accountId?: string | null) {
  if (get().accounts.length === 0) await fetchAccounts()
  if (accountId && accountId !== get().selectedAccountId) {
    set({ selectedAccountId: accountId, mailboxes: get().mailboxesByAccount[accountId] || [] })
  }
  if (get().mailboxes.length === 0) await fetchMailboxes()
  if (mailboxId && mailboxId !== get().selectedMailboxId) {
    set({ selectedMailboxId: mailboxId, messages: [], currentPage: 0 })
  }
  await openMessage(id)
}

/**
 * 읽음/안 읽음을 명시적으로 설정한다 — 본문 헤더 "안 읽음으로(U)", 스와이프 "읽음 전환" 모두 이 함수를 사용한다.
 * 성공(또는 이미 해당 상태)이면 true. 실패는 false — 호출자가 안내한다(이전에는 오류를 무시하여 성공 토스트가 표시되었다).
 */
export async function setUnread(id: string, unread: boolean): Promise<boolean> {
  const s = get()
  const msg = s.messages.find(m => m.id === id)
  const current = msg ? msg.is_unread : s.selectedMessage?.id === id ? s.selectedMessage.is_unread : null
  if (current === unread) return true
  try {
    await $fetch(`/api/mail/messages/${id}`, {
      method: 'PATCH',
      body: { is_unread: unread },
      params: scopeParams(),
    })
    if (msg) patchMessageRow(id, { is_unread: unread })
    const sel = get().selectedMessage
    if (sel?.id === id) set({ selectedMessage: { ...sel, is_unread: unread } })
    const mb = mailSelectedMailbox()
    if (mb) patchSelectedMailboxUnread(n => Math.max(0, n + (unread ? 1 : -1)))
    return true
  } catch (e: any) {
    console.error('setUnread error:', e)
    return false
  }
}

export async function toggleRead(id: string): Promise<boolean> {
  const msg = get().messages.find(m => m.id === id)
  if (!msg) return true
  return setUnread(id, !msg.is_unread)
}

export async function toggleStar(id: string): Promise<boolean> {
  const s = get()
  const msg = s.messages.find(m => m.id === id)
  // 모바일 본문(/mail/:id)은 목록 없이 열릴 수 있다 — 열린 메일 기준으로도 토글한다
  const current = msg ? msg.is_flagged : s.selectedMessage?.id === id ? s.selectedMessage.is_flagged : null
  if (current === null) return true
  const newFlagged = !current
  try {
    await $fetch(`/api/mail/messages/${id}`, {
      method: 'PATCH',
      body: { is_flagged: newFlagged },
      params: scopeParams(),
    })
    if (msg) patchMessageRow(id, { is_flagged: newFlagged })
    const sel = get().selectedMessage
    if (sel?.id === id) {
      set({ selectedMessage: { ...sel, is_flagged: newFlagged } })
    }
    return true
  } catch (e: any) {
    console.error('toggleStar error:', e)
    return false
  }
}

/**
 * 목록에서 메일이 제외된 후(삭제·이동·스팸) — 해당 위치를 다음 메일로 채운다.
 * 이전에는 제외만 수행하여 한 페이지를 모두 삭제하면 이후 메일이 남아 있어도 "메일이 없습니다"가 표시되었다.
 * 마지막 페이지가 비면 이전 페이지로 이동한다.
 */
async function refillAfterRemove() {
  try {
    await fetchMessages()
    const s = get()
    if (!s.messages?.length && s.currentPage > 0 && !s.listError) {
      set({ currentPage: s.currentPage - 1 })
      await fetchMessages()
    }
  } catch (e: any) {
    // 재조회가 실패해도 이미 완료된 삭제·이동을 "실패"로 처리하지 않는다
    console.error('refillAfterRemove error:', e)
  }
}

/** 삭제(휴지통으로 이동). 성공 시 true — 실패는 false 로 반환한다. */
export async function deleteMessage(id: string): Promise<boolean> {
  try {
    await $fetch(`/api/mail/messages/${id}`, { method: 'DELETE', params: scopeParams() })
    set({ messages: get().messages.filter(m => m.id !== id) })
    if (get().selectedMessage?.id === id) {
      set({ selectedMessage: null })
    }
    // Refresh mailboxes for count update
    await Promise.all([fetchMailboxes(), refillAfterRemove()])
    return true
  } catch (e: any) {
    console.error('deleteMessage error:', e)
    return false
  }
}

export async function moveMessage(id: string, mailboxId: string): Promise<boolean> {
  try {
    await $fetch(`/api/mail/messages/${id}`, {
      method: 'PATCH',
      body: { mailbox_ids: [mailboxId] },
      params: scopeParams(),
    })
    set({ messages: get().messages.filter(m => m.id !== id) })
    if (get().selectedMessage?.id === id) {
      set({ selectedMessage: null })
    }
    await Promise.all([fetchMailboxes(), refillAfterRemove()])
    return true
  } catch (e: any) {
    console.error('moveMessage error:', e)
    return false
  }
}

/**
 * 보관(E) — 보관함(role=archive)으로 이동. 서버에 보관함이 없으면 false 를 반환하고 호출자가 안내한다.
 */
export async function archiveMessages(ids: string[]): Promise<boolean> {
  const target = mailArchiveMailbox()
  if (!target || ids.length === 0) return false
  return bulkOn(ids, 'move', target.id)
}

export async function uploadAttachment(file: File): Promise<UploadedAttachment> {
  const formData = new FormData()
  formData.append('file', file)
  return await $fetch<UploadedAttachment>('/api/mail/upload', {
    method: 'POST',
    body: formData,
  })
}

export async function sendMessage(data: SendMessageData): Promise<SendResult> {
  set({ sending: true })
  try {
    const res = await $fetch<SendResult>('/api/mail/send', {
      method: 'POST',
      // account_id 미지정 시 선택계정(default=주사용) 사용 → From이 주사용 메일주소가 됨
      body: { account_id: get().selectedAccountId, ...data },
    })
    if (res?.scheduled) {
      // 예약 — 보낸편지함은 유지하고 예약함만 재조회한다
      void fetchScheduled()
      return res
    }
    // Refresh if in sent folder
    await fetchMessages()
    await fetchMailboxes()
    return res
  } catch (e: any) {
    console.error('sendMessage error:', e)
    throw e
  } finally {
    set({ sending: false })
  }
}

export function toggleSelect(id: string) {
  const s = new Set(get().selectedIds)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  set({ selectedIds: s })
}

export function selectAll() {
  set({ selectedIds: new Set(get().messages.map(m => m.id)) })
}

export function deselectAll() {
  set({ selectedIds: new Set() })
}

/**
 * 다중 메일 일괄 처리 — read·unread·star·unstar·delete·spam·move. 성공 시 true.
 * 목록에서 먼저 제외하고(낙관적) 실패 시 재조회한다.
 */
export async function bulkOn(ids: string[], action: string, mailboxId?: string): Promise<boolean> {
  if (ids.length === 0) return false
  const removes = action === 'delete' || action === 'spam' || action === 'move'
  try {
    await $fetch('/api/mail/bulk', {
      method: 'POST',
      body: { message_ids: ids, action, mailbox_id: mailboxId || null, account_id: get().selectedAccountId },
      params: { mailbox_id: get().selectedMailboxId || 'INBOX' },
    })
    const idSet = new Set(ids)
    if (removes) {
      const s = get()
      set({
        messages: s.messages.filter(m => !idSet.has(m.id)),
        totalMessages: Math.max(0, s.totalMessages - ids.length),
      })
      const sel = get().selectedMessage
      if (sel && idSet.has(sel.id)) set({ selectedMessage: null })
    } else {
      set({
        messages: get().messages.map((m) => {
          if (!idSet.has(m.id)) return m
          if (action === 'read') return { ...m, is_unread: false }
          else if (action === 'unread') return { ...m, is_unread: true }
          else if (action === 'star') return { ...m, is_flagged: true }
          else if (action === 'unstar') return { ...m, is_flagged: false }
          return m
        }),
      })
    }
    if (get().selectedIds.size) {
      const s = new Set(get().selectedIds)
      ids.forEach(id => s.delete(id))
      set({ selectedIds: s })
    }
    await Promise.all([fetchMailboxes(), removes ? refillAfterRemove() : Promise.resolve()])
    return true
  } catch (e: any) {
    console.error('bulkOn error:', e)
    await fetchMessages()
    return false
  }
}

/** 선택된 메일 전체에 적용 — 선택 바. */
export async function bulkAction(action: string, mailboxId?: string): Promise<boolean> {
  return bulkOn(Array.from(get().selectedIds), action, mailboxId)
}

/**
 * 작성 진입: 데스크톱은 앱 내 플로팅 작성 창, 모바일은 전체 화면 페이지.
 * 팝업(window.open 900×720)은 폐지. 실제 분기는 useMailCompose.open 이 수행한다.
 */
export function openCompose(mode: ComposeMode = 'new', msg?: Readonly<MessageDetail> | null, draftId?: string) {
  openComposeWindow(mode, msg, draftId)
}

export function clearSelectedMessage() {
  openSeq++
  set({ selectedMessage: null, messageError: null, loadingMessage: false })
}

/** 목록 내 이전/다음 메일(j/k·모바일 본문 ‹ ›). 목록 끝이면 no-op. */
export async function openAdjacent(delta: 1 | -1) {
  const i = mailSelectedIndex()
  if (!i) return
  const next = get().messages[i - 1 + delta]
  if (next) await openMessage(next.id)
}

export async function nextPage() {
  if (mailHasNextPage()) {
    set({ currentPage: get().currentPage + 1 })
    await fetchMessages()
  }
}

export async function prevPage() {
  if (mailHasPrevPage()) {
    set({ currentPage: get().currentPage - 1 })
    await fetchMessages()
  }
}

/** 첨부 API 경로(상대) — 주소 결합 전 */
function attachmentPath(blobId: string, opts: { inline?: boolean } = {}) {
  const s = get()
  let url = `/api/mail/attachments/${encodeURIComponent(blobId)}?mailbox_id=${encodeURIComponent(s.selectedMailboxId || 'INBOX')}`
  if (s.selectedAccountId) url += `&account_id=${encodeURIComponent(s.selectedAccountId)}`
  if (opts.inline) url += '&inline=1'
  return url
}

/**
 * 첨부 URL. inline=true 이면 브라우저가 직접 표시한다(이미지 썸네일·PDF 미리보기).
 * 웹은 상대 주소, 번들 앱은 apiBase 를 결합한다.
 */
export function attachmentUrl(blobId: string, opts: { inline?: boolean } = {}) {
  return apiUrl(attachmentPath(blobId, opts))
}

export function downloadAttachment(blobId: string, name: string) {
  // 번들 앱: 교차 출처 <a download> 에는 파일명·인증(Bearer)이 적용되지 않는다 → $fetch(blob) 로 수신한다
  if (isBundledApp()) { void downloadApi(attachmentPath(blobId), name).catch(() => {}); return }
  // window.open 은 팝업 차단 대상이며 "모두 다운로드" 에서 다중 열기가 불가하다 → 숨김 <a download> 사용.
  const a = document.createElement('a')
  a.href = attachmentUrl(blobId)
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** "모두 다운로드" — 서버가 이 메일의 첨부를 zip 하나로 묶어 반환한다(GET /messages/{id}/attachments.zip). */
function attachmentsZipPath(messageId: string) {
  const s = get()
  let url = `/api/mail/messages/${encodeURIComponent(messageId)}/attachments.zip?mailbox_id=${encodeURIComponent(s.selectedMailboxId || 'INBOX')}`
  if (s.selectedAccountId) url += `&account_id=${encodeURIComponent(s.selectedAccountId)}`
  return url
}

export function attachmentsZipUrl(messageId: string) {
  return apiUrl(attachmentsZipPath(messageId))
}

export function downloadAllAttachments(messageId: string) {
  if (isBundledApp()) { void downloadApi(attachmentsZipPath(messageId), 'attachments.zip').catch(() => {}); return }
  const a = document.createElement('a')
  a.href = attachmentsZipUrl(messageId)
  a.download = 'attachments.zip'
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export async function markAsSpam(id: string): Promise<boolean> {
  try {
    await $fetch('/api/mail/bulk', {
      method: 'POST',
      body: { message_ids: [id], action: 'spam', account_id: get().selectedAccountId },
      params: { mailbox_id: get().selectedMailboxId || 'INBOX' },
    })
    set({ messages: get().messages.filter(m => m.id !== id) })
    if (get().selectedMessage?.id === id) {
      set({ selectedMessage: null })
    }
    await Promise.all([fetchMailboxes(), refillAfterRemove()])
    return true
  } catch (e: any) {
    console.error('markAsSpam error:', e)
    return false
  }
}

export async function fetchRawHeaders(id: string): Promise<string | null> {
  try {
    const s = get()
    const params: Record<string, any> = { mailbox_id: s.selectedMailboxId || 'INBOX' }
    if (s.selectedAccountId) params.account_id = s.selectedAccountId
    const data = await $fetch<{ headers: string }>(`/api/mail/messages/${id}/headers`, { params })
    return data.headers
  } catch (e: any) {
    console.error('fetchRawHeaders error:', e)
    return null
  }
}

export async function sendReadReceipt(id: string) {
  try {
    const s = get()
    const params: Record<string, any> = { mailbox_id: s.selectedMailboxId || 'INBOX' }
    if (s.selectedAccountId) params.account_id = s.selectedAccountId
    await $fetch(`/api/mail/messages/${id}/read-receipt`, { method: 'POST', params })
    const sel = get().selectedMessage
    if (sel?.id === id) {
      set({ selectedMessage: { ...sel, mdn_sent: true } })
    }
  } catch (e: any) {
    console.error('sendReadReceipt error:', e)
  }
}

export async function createMailbox(name: string) {
  try {
    const params: Record<string, any> = {}
    const acc = get().selectedAccountId
    if (acc) params.account_id = acc
    await $fetch('/api/mail/mailboxes', {
      method: 'POST',
      body: { name },
      params,
    })
    await fetchMailboxes()
  } catch (e: any) {
    console.error('createMailbox error:', e)
    throw e
  }
}

export async function renameMailbox(oldName: string, newName: string) {
  try {
    const params: Record<string, any> = {}
    const acc = get().selectedAccountId
    if (acc) params.account_id = acc
    await $fetch('/api/mail/mailboxes', {
      method: 'PATCH',
      body: { old_name: oldName, new_name: newName },
      params,
    })
    await fetchMailboxes()
  } catch (e: any) {
    console.error('renameMailbox error:', e)
    throw e
  }
}

export async function deleteMailbox(name: string) {
  try {
    const params: Record<string, any> = {}
    const acc = get().selectedAccountId
    if (acc) params.account_id = acc
    await $fetch(`/api/mail/mailboxes/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      params,
    })
    if (get().selectedMailboxId === name) {
      set({ selectedMailboxId: null, selectedMessage: null })
    }
    await fetchMailboxes()
  } catch (e: any) {
    console.error('deleteMailbox error:', e)
    throw e
  }
}

export async function refresh() {
  await Promise.all([fetchMailboxes(), fetchMessages()])
}

/** hook 이 반환하는 동작 — 모듈 함수 그대로(참조 고정) */
const actions = {
  setSelectedAccountId,
  setSelectedIds,
  setQuickFilters,
  fetchMailboxesFor,
  selectAccountMailbox,
  fetchAccounts,
  selectAccount,
  fetchMailboxes,
  selectMailbox,
  fetchMessages,
  openMessage,
  openMessageAt,
  openAdjacent,
  toggleRead,
  setUnread,
  toggleStar,
  deleteMessage,
  moveMessage,
  archiveMessages,
  bulkOn,
  sendMessage,
  uploadAttachment,
  toggleSelect,
  selectAll,
  deselectAll,
  bulkAction,
  openCompose,
  clearSelectedMessage,
  nextPage,
  prevPage,
  setSearchQuery,
  attachmentUrl,
  downloadAttachment,
  downloadAllAttachments,
  attachmentsZipUrl,
  applyFilters,
  setLabelFilter,
  fetchLabels,
  updateLabels,
  fetchThread,
  fetchMessageIn,
  fetchScheduled,
  openScheduled,
  rescheduleMail,
  cancelScheduled,
  refresh,
  markAsSpam,
  fetchRawHeaders,
  sendReadReceipt,
  createMailbox,
  renameMailbox,
  deleteMailbox,
}

/**
 * 상태 + 동작. 상태 전체를 얕게 구독한다(어느 필드가 변경되어도 재렌더).
 * 상태 + computed(totalPages·hasNextPage·hasPrevPage·totalUnread·selectedMailbox·selectedAccount·isPop3·archiveMailbox·selectedIndex) + 동작.
 */
export function useMail() {
  const s = useStore(mailStore, useShallow((st: MailState) => st))
  return {
    ...s,
    totalPages: mailTotalPages(s),
    hasNextPage: mailHasNextPage(s),
    hasPrevPage: mailHasPrevPage(s),
    totalUnread: mailTotalUnread(s),
    selectedMailbox: mailSelectedMailbox(s),
    selectedAccount: mailSelectedAccount(s),
    isPop3: mailIsPop3(s),
    archiveMailbox: mailArchiveMailbox(s),
    selectedIndex: mailSelectedIndex(s),
    ...actions,
  }
}
