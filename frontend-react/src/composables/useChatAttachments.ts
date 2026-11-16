/**
 * 채팅 첨부 트레이 + 묶음 전송.
 *
 * 여러 첨부를 **메시지 하나로**(디스코드식, 최대 10개 · 파일당 50MB) 전송한다.
 *  - 트레이 추가 시에는 대기('queued')만 한다(채널·스레드 동일). 항목별 스포일러(spoiler) · 대체 텍스트(alt).
 *  - 전송(sendAttachments) = 낙관적 메시지 한 줄(id 'local-up-…', ChatMessage._upload)을 목록 끝에 추가하고
 *    chatApi22.postAttachments(본문 · reply_to_id · reply_ping · silent · parent_id · also_to_channel 포함)로 업로드한다.
 *    진행률은 해당 줄의 _upload.progress(0–1). 성공 시 서버 메시지로 교체하고, 실패 = state 'failed'(retryUpload),
 *    크기 초과(파일 > 50MB 또는 413) = 'too_large'(재시도 불가, discardUpload 로 삭제만 가능).
 *  - 구 서버(/attachments 가 404·405)에서는 이전 경로(POST /channels/{id}/upload 파일마다)로 fallback 한다 — 본문은 별도 전송한다.
 *
 * React: const { forChannel, addFiles, remove, setSpoiler, setAlt, ... } = useChatAttachments()
 * 컴포넌트 외부: chatAttachmentsStore · addFiles · remove · clear · setSpoiler · setAlt · sendAttachments · retryUpload · discardUpload
 * 이전 API(buildFileMeta · sendThreadFiles · onThreadFileSent · retry)는 하위 호환을 위해 유지한다.
 */
import { createStore, useStore } from 'zustand'
import { i18n } from '~/i18n'
import { apiBaseUrl } from '~/lib/runtimeConfig'
import { authStore } from '~/composables/useAuth'
import { addToast } from '~/composables/useToast'
import { chatStore, sendMessage, type ChatAttachment as MsgAttachment, type ChatMessage } from '~/composables/useChat'
import { postAttachments, type AttachmentUpload, type SendExtra } from '~/composables/chatApi22'

export type ChatAttachmentStatus = 'queued' | 'uploading' | 'done' | 'error'

/** 한 메시지 첨부 최대 개수 · 파일당 최대 크기(디스코드 · 서버 계약) */
export const MAX_ATTACHMENTS = 10
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

export interface ChatAttachmentResult {
  path: string
  name: string
  size: number
}

export interface ChatAttachment {
  id: string
  channelId: string
  /** 스레드 답글 첨부이면 루트 메시지 id — 채널 트레이와 별도로 관리 */
  parentId: string | null
  /** 스레드 첨부 전송 시 "채널에도 보내기" 값(전송 시점에 결정) */
  alsoToChannel: boolean
  file: File
  name: string
  size: number
  mimeType: string
  isImage: boolean
  /** 이미지 썸네일용 object URL (삭제 시 revoke) */
  previewUrl: string | null
  status: ChatAttachmentStatus
  /** 0~100 */
  progress: number
  error: string | null
  result: ChatAttachmentResult | null
  /** 스포일러로 숨김 처리 */
  spoiler: boolean
  /** 대체 텍스트 */
  alt: string | null
  /** 50MB 초과 — 전송 불가 */
  tooLarge: boolean
}

// 모듈 싱글톤 — 채널 전환 시에도 트레이가 유지되도록 전체 채널을 단일 목록에 보관
export const chatAttachmentsStore = createStore<{ attachments: ChatAttachment[] }>()(() => ({ attachments: [] }))
const A = () => chatAttachmentsStore.getState().attachments
const setA = (attachments: ChatAttachment[]) => chatAttachmentsStore.setState({ attachments })

const _xhrs = new Map<string, XMLHttpRequest>()
const _threadSentListeners = new Set<(msg: any) => void>()
let _seq = 0

function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true
  return /\.(jpg|jpeg|png|webp|gif|svg|bmp|avif)$/i.test(file.name)
}

/** 붙여넣은 이미지는 이름이 모두 image.png 이므로 시각으로 구분되는 이름을 부여한다 */
export function normalizeName(file: File, fromPaste: boolean): string {
  if (!fromPaste || !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) return file.name
  const ext = file.name.split('.').pop() || 'png'
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `paste-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`
}

export function formatChatFileSize(bytes: number): string {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${(bytes / 1073741824).toFixed(2)} GB`
}

function patch(id: string, p: Partial<ChatAttachment>) {
  const list = A()
  const idx = list.findIndex(a => a.id === id)
  if (idx === -1) return
  const next = list.slice()
  next[idx] = { ...list[idx], ...p }
  setA(next)
}

/** 백엔드 주소·토큰 — lib/api.ts 와 동일 규칙 */
function resolveUpload(url: string): { url: string; token: string | null } {
  const base = apiBaseUrl()
  if (!base) return { url, token: null }
  let token: string | null = null
  try { token = localStorage.getItem('ws_token') } catch { /* ignore */ }
  return { url: base + url, token }
}

/**
 * 트레이에 파일을 추가한다(대기). 한 위치(채널 또는 스레드)당 최대 10개 — 초과 파일은 추가하지 않고 통지한다.
 */
export function addFiles(channelId: string, files: FileList | File[], opts: { fromPaste?: boolean; parentId?: string | null } = {}) {
  const list = Array.from(files).filter(f => f && f.size >= 0)
  if (!channelId || list.length === 0) return []
  const pid = opts.parentId || null
  const room = MAX_ATTACHMENTS - selectTray(A(), channelId, pid).length
  if (list.length > room) {
    addToast('warning', i18n.t('chat.compose.attach.tooMany', { n: MAX_ATTACHMENTS }))
    list.splice(Math.max(0, room))
  }
  const added: ChatAttachment[] = []
  for (const file of list) {
    const isImage = isImageFile(file)
    const a: ChatAttachment = {
      id: `att-${Date.now()}-${++_seq}`,
      channelId,
      parentId: pid,
      alsoToChannel: false,
      file,
      name: normalizeName(file, !!opts.fromPaste),
      size: file.size,
      mimeType: file.type || '',
      isImage,
      previewUrl: isImage ? URL.createObjectURL(file) : null,
      status: 'queued',
      progress: 0,
      error: null,
      result: null,
      spoiler: false,
      alt: null,
      tooLarge: file.size > MAX_ATTACHMENT_BYTES,
    }
    setA([...A(), a])
    added.push(a)
  }
  return added
}

export function setSpoiler(id: string, v: boolean) { patch(id, { spoiler: v }) }
export function setAlt(id: string, alt: string | null) { patch(id, { alt: alt && alt.trim() ? alt.trim().slice(0, 1024) : null }) }

/** 업로드 중이면 취소하고 트레이에서 제거 */
export function remove(id: string) {
  const xhr = _xhrs.get(id)
  if (xhr) { try { xhr.abort() } catch { /* noop */ } _xhrs.delete(id) }
  const a = A().find(x => x.id === id)
  if (a?.previewUrl) { try { URL.revokeObjectURL(a.previewUrl) } catch { /* noop */ } }
  setA(A().filter(x => x.id !== id))
}

/** 트레이 항목만 제거(미리보기 URL 도 해제) */
export function clear(ids: string[], opts: { keepPreview?: boolean } = {}) {
  if (!opts.keepPreview) {
    for (const id of ids) {
      const a = A().find(x => x.id === id)
      if (a?.previewUrl) { try { URL.revokeObjectURL(a.previewUrl) } catch { /* noop */ } }
    }
  }
  const set = new Set(ids)
  setA(A().filter(x => !set.has(x.id)))
}

/** 채널(스레드이면 해당 루트)의 첨부만 반환 */
export function selectTray(list: ChatAttachment[], channelId: string | null | undefined, parentId?: string | null): ChatAttachment[] {
  const pid = parentId || null
  return channelId ? list.filter(a => a.channelId === channelId && a.parentId === pid) : []
}

// ─── 묶음 전송(낙관적 메시지) ───

export type UploadState = 'uploading' | 'failed' | 'too_large'
export interface SendAttachmentsOpts extends SendExtra { content?: string }
interface PendingUpload {
  localId: string
  channelId: string
  parentId: string | null
  items: Array<AttachmentUpload & { previewUrl: string | null; mimeType: string; size: number; name: string }>
  opts: SendAttachmentsOpts
  ctrl: AbortController | null
}
const _pending = new Map<string, PendingUpload>()

function listKey(parentId: string | null): 'messages' | 'threadMessages' {
  return parentId ? 'threadMessages' : 'messages'
}
function patchLocal(p: PendingUpload, fn: (m: ChatMessage) => ChatMessage | null) {
  const key = listKey(p.parentId)
  const list = chatStore.getState()[key] as ChatMessage[]
  const next: ChatMessage[] = []
  for (const m of list) {
    if (m.id !== p.localId) { next.push(m); continue }
    const r = fn(m)
    if (r) next.push(r)
  }
  chatStore.setState({ [key]: next } as Partial<ReturnType<typeof chatStore.getState>>)
}
function setUpload(p: PendingUpload, u: Partial<NonNullable<ChatMessage['_upload']>>) {
  patchLocal(p, m => ({ ...m, _upload: { ...(m._upload as NonNullable<ChatMessage['_upload']>), ...u } }))
}

function localMessage(p: PendingUpload): ChatMessage {
  const me = authStore.getState().user
  const now = new Date().toISOString()
  const attachments: MsgAttachment[] = p.items.map((it, i) => ({
    id: `local-${i}`, filename: it.name, size: it.size, mime_type: it.mimeType, url: it.previewUrl || '', spoiler: !!it.spoiler, alt: it.alt || null,
  }))
  return {
    id: p.localId,
    channel_id: p.channelId,
    sender: me ? { id: me.id, username: me.username, display_name: (me as { display_name?: string | null }).display_name ?? null, avatar_url: (me as { avatar_url?: string | null }).avatar_url ?? null } : null,
    content: p.opts.content || '',
    message_type: 'file',
    file_meta: null,
    parent_id: p.parentId,
    reply_count: 0,
    is_edited: false,
    is_deleted: false,
    created_at: now,
    updated_at: now,
    reactions: [],
    reply_to_id: p.opts.reply_to_id ?? null,
    reply_ping: p.opts.reply_ping,
    silent: !!p.opts.silent,
    attachments,
    _upload: { localId: p.localId, state: 'uploading', progress: 0, error: null },
  }
}

function finish(p: PendingUpload, msg: ChatMessage | null) {
  _pending.delete(p.localId)
  const key = listKey(p.parentId)
  const list = chatStore.getState()[key] as ChatMessage[]
  const already = msg && list.some(m => m.id === msg.id)
  patchLocal(p, () => (msg && !already ? msg : null))
  for (const it of p.items) if (it.previewUrl) { try { URL.revokeObjectURL(it.previewUrl) } catch { /* noop */ } }
  if (msg && p.parentId) for (const cb of _threadSentListeners) cb(msg)
}

/** 구 서버: 파일마다 채팅 업로드(답글이면 parent_id) — 본문은 텍스트 메시지로 먼저 전송 */
function legacyUploadOne(p: PendingUpload, it: PendingUpload['items'][number], onProgress: (r: number) => void): Promise<ChatMessage> {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams()
    if (p.parentId) { q.set('parent_id', p.parentId); q.set('also_to_channel', String(!!p.opts.also_to_channel)) }
    const { url, token } = resolveUpload(`/api/chat/channels/${encodeURIComponent(p.channelId)}/upload${q.toString() ? `?${q}` : ''}`)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.withCredentials = true
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    const fd = new FormData()
    fd.append('file', it.file, it.name)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
    xhr.onload = () => {
      let body: unknown = null
      try { body = JSON.parse(xhr.responseText) } catch { /* 본문 없음 */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as ChatMessage)
      else reject(Object.assign(new Error(`upload ${xhr.status}`), { status: xhr.status, data: body }))
    }
    xhr.onerror = () => reject(Object.assign(new Error('network'), { status: 0 }))
    p.ctrl?.signal.addEventListener('abort', () => xhr.abort())
    xhr.send(fd)
  })
}

async function run(p: PendingUpload) {
  if (p.items.some(it => it.size > MAX_ATTACHMENT_BYTES)) { setUpload(p, { state: 'too_large', progress: 0 }); return }
  p.ctrl = new AbortController()
  setUpload(p, { state: 'uploading', progress: 0, error: null })
  const items = p.items.map(({ file, spoiler, alt }) => ({ file, spoiler, alt }))
  try {
    const msg = await postAttachments(p.channelId, items, {
      ...p.opts,
      parent_id: p.parentId,
      signal: p.ctrl.signal,
      onProgress: r => setUpload(p, { progress: Math.min(0.99, r) }),
    })
    finish(p, msg && (msg as ChatMessage).id ? msg : null)
  } catch (e) {
    const status = (e as { status?: number }).status
    if (p.ctrl?.signal.aborted) return
    if (status === 413) { setUpload(p, { state: 'too_large' }); return }
    if (status === 404 || status === 405) {
      // 구 서버 — 본문 별도 전송 + 파일별 업로드
      try {
        if (p.opts.content && !p.parentId) sendMessage(p.opts.content)
        const total = p.items.reduce((s, it) => s + it.size, 0) || 1
        let done = 0
        let last: ChatMessage | null = null
        for (const it of p.items) {
          last = await legacyUploadOne(p, it, r => setUpload(p, { progress: Math.min(0.99, (done + r * it.size) / total) }))
          done += it.size
        }
        finish(p, p.items.length === 1 ? last : null)
      } catch (e2) {
        if ((e2 as { status?: number }).status === 413) setUpload(p, { state: 'too_large' })
        else setUpload(p, { state: 'failed', error: (e2 as Error)?.message || null })
      }
      return
    }
    const detail = (e as { data?: { detail?: unknown } }).data?.detail
    const msg = typeof detail === 'string' ? detail : (detail as { message?: string } | undefined)?.message
    if ((detail as { code?: string } | undefined)?.code === 'too_large') { setUpload(p, { state: 'too_large' }); return }
    setUpload(p, { state: 'failed', error: msg || (status === 0 ? i18n.t('chat.input.tray.networkError') : `HTTP ${status}`) })
  }
}

/**
 * 트레이 첨부(ids)를 메시지 하나로 전송한다. 낙관적 줄을 즉시 추가하고 localId 를 반환한다.
 * 전송 불가(첨부 없음 · 11개 이상)이면 null 을 반환한다.
 */
export function sendAttachments(channelId: string, ids: string[], opts: SendAttachmentsOpts = {}): string | null {
  const tray = ids.map(id => A().find(a => a.id === id)).filter((a): a is ChatAttachment => !!a)
  if (!tray.length || tray.length > MAX_ATTACHMENTS) return null
  const parentId = opts.parent_id || tray[0].parentId || null
  const localId = `local-up-${Date.now()}-${++_seq}`
  const p: PendingUpload = {
    localId, channelId, parentId,
    items: tray.map(a => ({ file: a.file, spoiler: a.spoiler, alt: a.alt, previewUrl: a.previewUrl, mimeType: a.mimeType, size: a.size, name: a.name })),
    opts: { ...opts, parent_id: parentId },
    ctrl: null,
  }
  _pending.set(localId, p)
  clear(tray.map(a => a.id), { keepPreview: true })
  const key = listKey(parentId)
  chatStore.setState({ [key]: [...(chatStore.getState()[key] as ChatMessage[]), localMessage(p)] } as Partial<ReturnType<typeof chatStore.getState>>)
  void run(p)
  return localId
}

/** 실패한 낙관적 줄 재전송(크기 초과는 불가) */
export function retryUpload(localId: string) {
  const p = _pending.get(localId)
  if (!p) return
  if (p.items.some(it => it.size > MAX_ATTACHMENT_BYTES)) return
  void run(p)
}
/** 낙관적 줄 삭제(업로드 중이면 취소) */
export function discardUpload(localId: string) {
  const p = _pending.get(localId)
  if (!p) return
  try { p.ctrl?.abort() } catch { /* noop */ }
  finish(p, null)
}
/** 테스트용 — 진행 중 목록 */
export function pendingUploadIds(): string[] { return [..._pending.keys()] }

// ─── 하위 호환(이전 개별 업로드 흐름) ───

function startLegacyThreadUpload(a: ChatAttachment) {
  patch(a.id, { status: 'uploading', progress: 0, error: null, result: null })
  const xhr = new XMLHttpRequest()
  _xhrs.set(a.id, xhr)
  const form = new FormData()
  form.append('file', a.file, a.name)
  const target = `/api/chat/channels/${encodeURIComponent(a.channelId)}/upload?${new URLSearchParams({ parent_id: a.parentId || '', also_to_channel: String(!!a.alsoToChannel) }).toString()}`
  const { url, token } = resolveUpload(target)
  xhr.open('POST', url)
  xhr.withCredentials = true
  if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) patch(a.id, { progress: Math.min(99, Math.floor((e.loaded / e.total) * 100)) }) }
  xhr.onload = () => {
    _xhrs.delete(a.id)
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        const msg = JSON.parse(xhr.responseText)
        clear([a.id])
        for (const cb of _threadSentListeners) cb(msg)
      } catch { patch(a.id, { status: 'error', error: i18n.t('chat.input.tray.invalidResponse') }) }
    } else patch(a.id, { status: 'error', error: `HTTP ${xhr.status}` })
  }
  xhr.onerror = () => { _xhrs.delete(a.id); patch(a.id, { status: 'error', error: i18n.t('chat.input.tray.networkError') }) }
  xhr.onabort = () => { _xhrs.delete(a.id) }
  xhr.send(form)
}

/** (하위 호환) 실패한 트레이 항목 재시도 — 현재 흐름에서는 트레이에 실패 항목이 없음 */
export function retry(id: string) {
  const a = A().find(x => x.id === id)
  if (!a || a.status === 'uploading' || !a.parentId) return
  startLegacyThreadUpload(a)
}

/** (하위 호환) 스레드 트레이의 대기 첨부를 하나씩 답글로 업로드 */
export async function sendThreadFiles(ids: string[], alsoToChannel: boolean) {
  for (const id of ids) {
    const a = A().find(x => x.id === id)
    if (!a || !a.parentId || a.status !== 'queued') continue
    patch(id, { alsoToChannel })
    const cur = A().find(x => x.id === id)!
    await new Promise<void>((resolve) => {
      startLegacyThreadUpload(cur)
      const xhr = _xhrs.get(id)
      if (!xhr) { resolve(); return }
      xhr.addEventListener('loadend', () => resolve())
    })
  }
}

/** 스레드 첨부가 답글 메시지로 생성된 시점(응답 메시지) — 실시간 이벤트보다 먼저 도착할 수 있다. 해제 함수를 반환한다. */
export function onThreadFileSent(cb: (msg: any) => void): () => void {
  _threadSentListeners.add(cb)
  return () => { _threadSentListeners.delete(cb) }
}

/** (하위 호환) 파일 메시지 file_meta (ChatFileMessage 가 읽는 형태와 동일) */
export function buildFileMeta(a: ChatAttachment): string | null {
  if (!a.result) return null
  return JSON.stringify({
    path: a.result.path,
    name: a.result.name,
    size: a.result.size,
    mime_type: a.mimeType || null,
  })
}

export function useChatAttachments() {
  const attachments = useStore(chatAttachmentsStore, s => s.attachments)
  return {
    attachments,
    /** 현재 채널(스레드이면 해당 루트)의 첨부만 — 렌더 시점 목록 */
    forChannel: (channelId: string | null | undefined, parentId?: string | null) => selectTray(attachments, channelId, parentId),
    addFiles,
    remove,
    clear,
    setSpoiler,
    setAlt,
    sendAttachments,
    retryUpload,
    discardUpload,
    // 하위 호환
    sendThreadFiles,
    onThreadFileSent,
    retry,
    buildFileMeta,
    formatSize: formatChatFileSize,
  }
}
