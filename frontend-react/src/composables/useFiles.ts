/**
 * 파일(모듈 싱글턴 상태 + 동작). 요청 주소·순서·본문·동시 업로드 3개·폴링 600ms 동일.
 *
 * React: const { items, sortedItems, breadcrumbs, fetchFiles, uploadFiles, navigateTo, ... } = useFiles()
 *   바깥에서 바꾸는 상태는 setter 를 같이 낸다:
 *     viewMode → setViewMode(v) · selectedItems → setSelectedItems(v) · inlineEdit → setInlineEdit(v)
 *   hook 멤버 `navigateTo` 는 폴더 이동. 모듈 수준 이름은 라우터 navigateTo 와 겹치지 않게 navigateToPath.
 * 컴포넌트 밖(채팅 등): import { uploadFiles } from '~/composables/useFiles'
 *
 * 전송 행(useTransfers)은 객체를 손에 들고 고치지 않고 patchTransfer/getTransfer 로 다룬다(그쪽 주석 참고).
 * 내려받기·업로드는 $fetch 가 아닌 fetch/XHR 를 쓴다. 웹은 '/api/…' 그대로, 번들 앱(VITE_API_BASE)은
 * apiBase + Bearer(apiRawFetch·apiUrl·bundledAuthHeaders).
 */
import { useMemo } from 'react'
import { createStore, useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { $fetch, apiRawFetch, notifyStorageDown } from '~/lib/api'
import { apiUrl, bundledAuthHeaders } from '~/lib/runtimeConfig'
import { i18n, useI18n } from '~/i18n'
import { formatSize } from '~/lib/files'
import {
  addTransfer, startTransfer, updateProgress, updateDisk, finishTransfer, patchTransfer, getTransfer,
  type Transfer,
} from '~/composables/useTransfers'

export interface FileItem {
  name: string
  path: string
  is_dir: boolean
  size: number
  modified_at: string | null
  mime_type: string | null
  /** 소유자(my/=나, users/<id>=그 사용자, shared/=처음 올린 사람 — 모르면 null) */
  owner?: { id: string | null; name: string } | null
  /** 내 즐겨찾기 */
  is_starred?: boolean
  /** 공유받은 항목(shared-with-me/..)이면 그 항목에 대한 내 권한 */
  role?: ShareRole
}

/** 공유 권한 4단계("보기 · 댓글 · 편집 · 공동 소유") */
export type ShareRole = 'view' | 'comment' | 'edit' | 'owner'

/** 최근·즐겨찾기 행(GET /recent · /stars) */
export interface QuickItem extends FileItem {
  accessed_at?: string
  starred_at?: string
  /** 즐겨찾기 원본이 없어졌으면 false */
  exists?: boolean
}

/** 파일 활동 기록 한 줄(GET /activity) */
export interface FileActivityEntry {
  id: string
  action: string
  user: { id: string | null; name: string } | null
  detail: Record<string, any> | null
  sub_path: string | null
  created_at: string
}

export interface FileListResponse {
  path: string
  items: FileItem[]
}

export interface StorageInfo {
  personal_used: number
  shared_used: number
  total_available: number
  total_capacity: number
  disk_used: number
}

export interface ShareLinkItem {
  id: string
  token: string
  display_name: string
  file_path: string
  expires_at: string | null
  max_downloads: number | null
  download_count: number
  created_at: string
}

export interface ShareLinkResponse {
  token: string
  url: string
  display_name: string
  expires_at: string | null
  max_downloads: number | null
  created_at: string
  id?: string
  has_password?: boolean
  allow_download?: boolean
  item_count?: number
  /** 폴더 하나짜리 링크 — 손님 화면에서 안을 둘러본다 */
  is_folder?: boolean
}

export interface ShareLinkListEntry extends ShareLinkItem {
  /** 백엔드가 내려주기 시작한 필드(구버전 서버면 없음 → 내려받기 링크로 간주) */
  can_edit?: boolean
  has_password?: boolean
  allow_download?: boolean
  /** 묶음 링크의 항목들(하나짜리면 [file_path]) */
  paths?: string[]
  /** 이메일로 보낸 받는 사람 수(성공만) */
  email_count?: number
  /** 폴더 하나짜리 링크 */
  is_folder?: boolean
  /** false = "다운로드 막음"으로 바꿀 수 없다(파일 하나짜리 링크인데 미리보기가 안 되는 형식 — 서버 판정) */
  can_block_download?: boolean
}

/** 공유 링크 이메일 발송 기록 한 줄(GET /share/{id}/emails) */
export interface ShareLinkEmailEntry {
  id: string
  email: string
  /** 워크스페이스 사용자면 그 id */
  user_id: string | null
  /** 워크스페이스 밖 주소 */
  external: boolean
  ok: boolean
  sent_by: string
  sent_by_name: string | null
  created_at: string | null
}

/** 발송 제한 — 한 번에 per_send 명, 1시간에 per_hour 명(remaining = 이번 시간 남은 수) */
export interface ShareLinkEmailLimits { per_send: number; per_hour: number; remaining: number }

export interface ShareLinkEmailResult {
  ok: boolean
  sent: number
  failed: number
  results: { email: string; ok: boolean; external: boolean; user_id: string | null }[]
  items: ShareLinkEmailEntry[]
  limits: ShareLinkEmailLimits
}

/** PATCH /share/{id} — 비밀번호("" = 해제)·내려받기·만료·횟수 */
export interface ShareLinkPatch {
  password?: string
  allow_download?: boolean
  expires_in?: string
  max_downloads?: number
}

export interface TrashEntry {
  name: string
  original_path: string
  size: number
  trashed_at: string | null
  trash_name: string
}

export interface VersionEntry {
  version: string
  size: number
  created_at: string
  /** 그 내용을 쓴 사람(활동 기록 이전 버전은 null) */
  author?: { id: string; name: string } | null
  download_url?: string
}

/** 공유 받는 쪽 한 행 — 사람(user_id) 또는 채널(channel_id·이름·멤버 수) */
export interface UserShareEntry {
  id: string
  user_id: string | null
  channel_id?: string | null
  channel_name?: string | null
  member_count?: number
  /** 공유가 생긴 까닭 — "channel_folder" = 채널 폴더 연결이 만든 것(연결을 풀면 회수), null = 사람이 건 공유 */
  origin?: string | null
  can_write: boolean
  /** 권한. 예전 서버면 없음 → can_write 로 */
  role?: ShareRole
  /** 만든 사람(비었으면 원 소유자) */
  created_by?: string | null
  /** 내가 바꾸거나 해제할 수 있나 — 공동 소유자는 원 소유자가 만든 공유·공동 소유를 못 건드린다 */
  can_manage?: boolean
}
/** GET /share-user/list 전체 — 원 소유자(공동 소유자 화면의 "소유자" 줄)와 내 권한 */
export interface UserShareInfo {
  shares: UserShareEntry[]
  owner: { id: string; username: string; display_name: string; email?: string | null; avatar_url?: string | null } | null
  my_role: ShareRole
}
export interface DirectoryUser { id: string; username: string; display_name: string; email?: string; avatar_url?: string | null; is_self?: boolean }

export interface SharedWithMeEntry {
  share_id: string
  name: string
  owner_path: string
  owner: { id: string; display_name: string }
  can_write: boolean
  /** 내 권한 */
  role?: ShareRole
  /** 채널로 받은 공유면 그 채널 */
  via_channel?: { id: string; name: string } | null
  is_dir: boolean
  size: number
  modified_at: string | null
  /** 받은 날(공유가 만들어진 때) */
  shared_at?: string | null
}

/** 사이드바 뷰. files = 폴더 탐색(my/shared/users) */
export type FilesView = 'files' | 'shared-with-me' | 'recent' | 'starred' | 'links' | 'trash'

export type ViewMode = 'list' | 'grid'
export type SortField = 'name' | 'modified_at' | 'size'
export type SortDir = 'asc' | 'desc'

export type FilesInlineEdit = { kind: 'new-folder' } | { kind: 'rename'; path: string } | null

export interface SharedBrowse {
  shareId: string
  rootName: string
  path: string
  sub: string
  owner: string
  canWrite: boolean
  role: ShareRole
  items: FileItem[]
}

export interface FilesState {
  currentPath: string
  items: FileItem[]
  loading: boolean
  viewMode: ViewMode
  sortField: SortField
  sortDir: SortDir
  selectedItems: Set<string>
  storageInfo: StorageInfo | null
  shareLinks: ShareLinkListEntry[]
  // Explorer-style in-panel search (recursive under the currently-viewed dir)
  searchActive: boolean
  searchQuery: string
  searchResults: FileItem[]
  // 뷰·휴지통·공유 표시
  view: FilesView
  trashItems: TrashEntry[]
  trashRetentionDays: number | null
  sharedWithMe: SharedWithMeEntry[]
  /** 현재 폴더 항목별 공유 상태(이름 → 사람 수·링크 유무). 행 "공유됨" 칩 */
  shareCounts: Record<string, { users: number; link: boolean }>
  /** 목록 맨 위 인라인 편집 행(새 폴더) / 행 안 이름 바꾸기 */
  inlineEdit: FilesInlineEdit
  // 최근·즐겨찾기 뷰(/recent · /stars)
  recentItems: QuickItem[]
  starredItems: QuickItem[]
  /** 공유받은 폴더 안 탐색 — null 이면 공유받음 첫 목록 */
  sharedBrowse: SharedBrowse | null
  /** 폴더 목록을 못 읽었다(권한·없음·네트워크) — 그 폴더 경로와 서버 문구. 빈 폴더와 구분해 다시 시도 타일을 띄운다 */
  listError: { path: string; message: string; status?: number } | null
}

// 목록/그리드 보기는 기기에 기억한다 — 예전엔 새로고침하면 늘 목록으로 돌아갔다
const VIEW_MODE_KEY = 'files.viewMode'
function savedViewMode(): ViewMode {
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY)
    if (v === 'list' || v === 'grid') return v
  } catch { /* 저장소 막힘 */ }
  return 'list'
}

function initialState(): FilesState {
  return {
    currentPath: 'my',
    items: [],
    loading: false,
    viewMode: savedViewMode(),
    sortField: 'name',
    sortDir: 'asc',
    selectedItems: new Set(),
    storageInfo: null,
    shareLinks: [],
    searchActive: false,
    searchQuery: '',
    searchResults: [],
    view: 'files',
    trashItems: [],
    trashRetentionDays: null,
    sharedWithMe: [],
    shareCounts: {},
    inlineEdit: null,
    recentItems: [],
    starredItems: [],
    sharedBrowse: null,
    listError: null,
  }
}

export const filesStore = createStore<FilesState>()(() => initialState())

const get = () => filesStore.getState()
const set = (p: Partial<FilesState>) => filesStore.setState(p)
const tr = (key: string, a?: Record<string, unknown>) => i18n.t(key, a)

/** 테스트용: 처음 상태로 */
export function _resetFilesStore() {
  filesStore.setState(initialState(), true)
}

/** 루트 이름 i18n 키 */
const ROOT_LABELS: Record<string, string> = { my: 'files.sidebar.myFiles', shared: 'files.sidebar.sharedFiles', users: 'files.sidebar.allUsers' }

// ─── 바깥에서 바꾸는 상태의 setter ───

export function setViewMode(v: ViewMode) {
  set({ viewMode: v })
  try { localStorage.setItem(VIEW_MODE_KEY, v) } catch { /* 저장소 막힘 — 이번 화면만 */ }
}
export function setSelectedItems(v: Set<string>) { set({ selectedItems: v }) }
export function setInlineEdit(v: FilesInlineEdit) { set({ inlineEdit: v }) }

// ─── 목록 ───

// 요청 순번 — 폴더를 빠르게 옮기면 늦게 온 앞 응답이 화면을 덮었다(A 클릭 → B 클릭 → A 가 늦게 와 A 로 되돌아감).
// 가장 최근 요청의 응답만 반영한다. 검색·공유받은 폴더도 같은 규칙.
let listSeq = 0
let listPending = 0
let searchSeq = 0
let sharedSeq = 0

export async function fetchFiles(path?: string) {
  const p = path ?? get().currentPath
  const seq = ++listSeq
  listPending++
  set({ loading: true })
  try {
    const data = await $fetch<FileListResponse>('/api/files/list', {
      params: { path: p },
    })
    if (seq !== listSeq) return
    set({ currentPath: data.path, items: data.items, selectedItems: new Set(), listError: null })
    fetchShareCounts(data.path)   // 행 "공유됨" 칩 — 기다리지 않는다
  } catch (e: any) {
    if (seq !== listSeq) return
    console.error('fetchFiles error:', e)
    // 예전엔 items 를 비워 403·404·네트워크 오류가 "이 폴더는 비어 있습니다"로 보였다.
    // 보던 목록은 그대로 두고(경로도 안 바뀐다) 못 읽었다는 것을 따로 알린다.
    const detail = typeof e?.data?.detail === 'string' ? e.data.detail : ''
    set({ listError: { path: p, message: detail, status: e?.statusCode ?? e?.status } })
  } finally {
    listPending--
    if (seq === listSeq) set({ loading: false })
  }
}

/** 목록 읽기 실패 뒤 다시 시도 — 실패한 그 폴더를 다시 읽는다 */
export function retryList() {
  const err = get().listError
  return fetchFiles(err?.path)
}
/** 실패 표시 닫기(보던 폴더로 돌아가기) */
export function dismissListError() { set({ listError: null }) }

export async function fetchStorageInfo() {
  try {
    set({ storageInfo: await $fetch<StorageInfo>('/api/files/info') })
  } catch { /* ignore */ }
}

// XHR 기반 업로드 — upload.onprogress=네트워크 진행률 + 서버 디스크 기록 진행률 폴링(Steam식 병기).
// existing: 대기열에서 차례가 온 전송 행(또는 다시 시도) — 없으면 새 행을 만든다.
function xhrUpload(file: File, path: string, existing?: Transfer): Promise<{ name: string; ok: boolean; error?: string }> {
  const t = existing ?? addTransfer(file.name, 'up', file.size)
  const tid = t.id
  if (existing) startTransfer(existing.id)
  patchTransfer(tid, { folder: path, retry: undefined })
  const uploadId = `${Date.now()}-${Math.round(Math.random() * 1e9)}`
  // 서버가 실제 디스크에 쓴 바이트를 주기적으로 폴링 → 디스크 기록 바
  let poll: ReturnType<typeof setInterval> | null = setInterval(async () => {
    try {
      const p = await $fetch<{ written: number; total: number; done: boolean }>(`/api/files/upload-progress/${uploadId}`)
      updateDisk(tid, p.written, p.total)
    } catch { /* ignore */ }
  }, 600)
  const stopPoll = () => { if (poll) { clearInterval(poll); poll = null } }
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    const form = new FormData()
    form.append('file', file)
    xhr.open('POST', apiUrl(`/api/files/upload?path=${encodeURIComponent(path)}&upload_id=${uploadId}&size=${file.size}`))
    xhr.withCredentials = true
    for (const [k, v] of Object.entries(bundledAuthHeaders())) xhr.setRequestHeader(k, v)
    // e.total 은 multipart 본문 크기(경계·머리 포함)라 파일 크기와 다르다 — 6 B 파일이 "완료 · 191 B".
    // 진행 비율만 받아 파일 크기에 맞춘다.
    xhr.upload.onprogress = (e) => {
      const ratio = e.total ? Math.min(1, e.loaded / e.total) : 0
      updateProgress(tid, Math.round(file.size * ratio), file.size)
    }
    // 실패하면 같은 파일·폴더로 다시 시도(시안 전송 패널 [다시 시도])
    const armRetry = () => { patchTransfer(tid, { retry: () => { retryUpload(file, path, t) } }) }
    xhr.onload = () => {
      stopPoll()
      if (xhr.status >= 200 && xhr.status < 300) {
        finishTransfer(tid, 'done')
        resolve({ name: file.name, ok: true })
      } else {
        let detail: any = `HTTP ${xhr.status}`
        try {
          const parsed = JSON.parse(xhr.responseText)
          detail = parsed?.detail || detail
          notifyStorageDown(xhr.status, parsed)      // 저장소가 끊겨 거부된 올리기 — 파일 탭이 끊김 안내로 바뀐다
        } catch { /* noop */ }
        if (xhr.status === 413) {
          // 서버 상한(general.upload_max_size_mb) — "File exceeds 2048MB limit" 에서 숫자를 읽어 "파일당 2 GB까지"
          const mb = Number(/(\d+)\s*MB/i.exec(String(detail))?.[1] || 0)
          detail = mb ? tr('files.transfer.tooLargeLimit', { limit: formatSize(mb * 1024 * 1024) }) : tr('files.transfer.tooLarge')
        }
        if (typeof detail !== 'string') detail = `HTTP ${xhr.status}`
        finishTransfer(tid, 'error', detail)
        armRetry()
        resolve({ name: file.name, ok: false, error: detail })
      }
    }
    xhr.onerror = () => { stopPoll(); finishTransfer(tid, 'error', tr('files.transfer.networkError')); armRetry(); resolve({ name: file.name, ok: false, error: tr('files.transfer.networkError') }) }
    xhr.onabort = () => { stopPoll(); finishTransfer(tid, 'canceled'); resolve({ name: file.name, ok: false, error: tr('files.transfer.canceled') }) }
    patchTransfer(tid, { _abort: () => { stopPoll(); xhr.abort() } })
    xhr.send(form)
  })
}

async function retryUpload(file: File, path: string, t: Transfer) {
  await xhrUpload(file, path, t)
  if (get().currentPath === path) await fetchFiles()
  await fetchStorageInfo()
}

// 동시에 3개까지 올리고 나머지는 "대기 중"(시안 전송 패널). 대기 중 취소는 차례가 와도 건너뛴다.
const UPLOAD_CONCURRENCY = 3
export async function uploadFiles(files: File[], targetPath?: string) {
  const base = targetPath ?? get().currentPath
  // 폴더 업로드: webkitRelativePath("folder/sub/file")가 있으면 하위경로 보존(백엔드가 subdir 자동 생성).
  const jobs = files.map((f) => {
    const rel = (f as any).webkitRelativePath as string | undefined
    let dir = base
    if (rel && rel.includes('/')) dir = `${base}/${rel.substring(0, rel.lastIndexOf('/'))}`
    const t = addTransfer(f.name, 'up', f.size, 'queued')
    patchTransfer(t.id, {
      folder: dir,
      _abort: () => { if (getTransfer(t.id)?.status === 'queued') finishTransfer(t.id, 'canceled') },
    })
    return { file: f, dir, t }
  })
  const results: { name: string; ok: boolean; error?: string }[] = []
  let next = 0
  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++]
      // 지금 상태로 판정(목록에서 지워진 행은 취소·실패 뒤에만 지울 수 있다 → 건너뜀)
      if (getTransfer(job.t.id)?.status !== 'queued') { results.push({ name: job.file.name, ok: false, error: tr('files.transfer.canceled') }); continue }
      results.push(await xhrUpload(job.file, job.dir, job.t))
    }
  }
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, jobs.length) }, worker))
  await fetchFiles()
  await fetchStorageInfo()
  return results
}

/** 응답 본문을 읽으며 진행률을 올리고 Blob 으로 */
async function readWithProgress(res: Response, tid: string, total: number): Promise<Blob> {
  const reader = res.body?.getReader()
  if (!reader) return await res.blob()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    loaded += value.length
    updateProgress(tid, loaded, total)
  }
  return new Blob(chunks as BlobPart[])
}

// 선택 항목을 zip 하나로 스트리밍 다운로드(전송 패널에 진행률).
export async function downloadMultiple(paths: string[]) {
  const t = addTransfer(tr('files.transfer.selectionZip', { n: paths.length }), 'down')
  const controller = new AbortController()
  patchTransfer(t.id, { _abort: () => controller.abort() })
  try {
    const res = await apiRawFetch('/api/files/download-multi', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
      signal: controller.signal,
    })
    if (!res.ok) { finishTransfer(t.id, 'error', tr('files.transfer.downloadFailed')); return }
    let filename = 'files.zip'
    const disp = res.headers.get('content-disposition')
    const m = disp?.match(/filename="?([^";\n]+)"?/)
    if (m) filename = m[1]
    const total = Number(res.headers.get('content-length') || 0)
    const blob = await readWithProgress(res, t.id, total)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(a.href)
    finishTransfer(t.id, 'done')
  } catch (e: any) {
    finishTransfer(t.id, e?.name === 'AbortError' ? 'canceled' : 'error', tr('files.transfer.downloadError'))
  }
}

export async function createFolder(name: string) {
  const cp = get().currentPath
  const fullPath = cp ? `${cp}/${name}` : name
  await $fetch('/api/files/mkdir', {
    method: 'POST',
    body: { path: fullPath },
  })
  await fetchFiles()
}

/** 여러 개 삭제에서 일부가 실패했을 때 던지는 오류 — failed = 못 지운 경로, deleted = 지운 수 */
export interface DeleteItemsError extends Error {
  data: { detail?: string }
  failed: string[]
  deleted: number
}

/** 검색 결과에서 사라진 경로(와 그 아래)를 뺀다 — 색인은 조금 늦게 따라와 다시 검색해도 남아 있을 수 있다 */
function dropFromSearch(paths: string[]) {
  const s = get()
  if (!s.searchActive || !paths.length) return
  set({ searchResults: s.searchResults.filter(i => !paths.some(p => i.path === p || i.path.startsWith(`${p}/`))) })
}
/** 검색 결과의 경로를 새 경로로(이름 바꾸기·이동) */
function repathInSearch(oldPath: string, newPath: string) {
  const s = get()
  if (!s.searchActive || !newPath || oldPath === newPath) return
  set({
    searchResults: s.searchResults.map((i) => {
      if (i.path === oldPath) return { ...i, path: newPath, name: newPath.split('/').pop() || i.name }
      if (i.path.startsWith(`${oldPath}/`)) return { ...i, path: newPath + i.path.slice(oldPath.length) }
      return i
    }),
  })
}

export async function deleteItems(paths: string[]) {
  // 예전엔 첫 실패에서 빠져나가 — 앞의 것은 이미 지워졌는데 화면에 남고, 뒤의 것은 시도도 안 했다.
  const failed: string[] = []
  const done: string[] = []
  let detail: string | undefined
  for (const p of paths) {
    try {
      await $fetch('/api/files/delete', {
        method: 'DELETE',
        params: { path: p },
      })
      done.push(p)
    } catch (e: any) {
      failed.push(p)
      if (!detail && typeof e?.data?.detail === 'string') detail = e.data.detail
    }
  }
  dropFromSearch(done)
  await fetchFiles()
  await fetchStorageInfo()
  if (failed.length) {
    throw Object.assign(new Error('delete failed'), { data: { detail }, failed, deleted: done.length }) as DeleteItemsError
  }
}

export async function renameItem(path: string, newName: string) {
  const r = await $fetch<{ path?: string }>('/api/files/rename', {
    method: 'PATCH',
    body: { path, new_name: newName },
  })
  if (r?.path) repathInSearch(path, r.path)
  await fetchFiles()
}

export async function moveItem(src: string, dst: string, copy = false) {
  await $fetch('/api/files/move', {
    method: 'PATCH',
    body: { src, dst, copy },
  })
  await fetchFiles()
}

export async function downloadFile(path: string, isDir = false) {
  const endpoint = isDir ? '/api/files/download-zip' : '/api/files/download'
  const url = `${endpoint}?path=${encodeURIComponent(path)}`
  const fallbackName = isDir ? `${path.split('/').pop() || 'download'}.zip` : path.split('/').pop() || 'download'
  const t = addTransfer(fallbackName, 'down')
  const controller = new AbortController()
  patchTransfer(t.id, { _abort: () => controller.abort() })
  try {
    const res = await apiRawFetch(url, { credentials: 'include', signal: controller.signal })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: tr('files.transfer.downloadFailed') }))
      finishTransfer(t.id, 'error', err.detail || tr('files.transfer.downloadFailed'))
      return
    }
    // 파일명(Content-Disposition)
    let filename = fallbackName
    const disposition = res.headers.get('content-disposition')
    if (disposition) {
      const star = disposition.match(/filename\*=UTF-8''([^;\n]+)/i)
      const plain = disposition.match(/filename="?([^";\n]+)"?/)
      if (star) filename = decodeURIComponent(star[1])
      else if (plain) filename = plain[1]
    }
    // 스트리밍으로 읽으며 진행률 갱신
    const total = Number(res.headers.get('content-length') || 0)
    if (total) updateProgress(t.id, 0, total)
    const blob = await readWithProgress(res, t.id, total)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(a.href)
    finishTransfer(t.id, 'done')
  } catch (e: any) {
    if (e?.name === 'AbortError') finishTransfer(t.id, 'canceled')
    else finishTransfer(t.id, 'error', tr('files.transfer.downloadErrorDuring'))
  }
}

export function getPreviewUrl(path: string) {
  return apiUrl(`/api/files/preview?path=${encodeURIComponent(path)}`)
}

// Share links
export async function createShareLink(path: string, expiresIn?: string, oneTime = false, canEdit = false) {
  const data = await $fetch<ShareLinkResponse>('/api/files/share', {
    method: 'POST',
    // can_edit 이 켜지면 서버가 내려받기 주소 대신 편집기 주소(/s/<token>)를 준다.
    body: { path, expires_in: expiresIn || null, one_time: oneTime, can_edit: canEdit },
  })
  return data
}

export async function fetchShareLinks() {
  try {
    set({ shareLinks: await $fetch<ShareLinkListEntry[]>('/api/files/share/list') })
  } catch { /* ignore */ }
}

export async function deleteShareLink(id: string) {
  await $fetch(`/api/files/share/${id}`, { method: 'DELETE' })
  await fetchShareLinks()
}

// Explorer-style search: recursively find files+folders under current path
export async function searchFiles(query: string) {
  set({ searchQuery: query })
  const q = query.trim()
  if (!q) {
    exitSearch()
    return
  }
  const seq = ++searchSeq
  set({ searchActive: true, loading: true })
  try {
    const data = await $fetch<FileListResponse>('/api/files/search', {
      params: { path: get().currentPath, q },
    })
    if (seq !== searchSeq) return        // 그새 다른 검색어를 쳤거나 검색을 닫았다
    set({ searchResults: data.items, selectedItems: new Set() })
  } catch (e: any) {
    if (seq !== searchSeq) return
    console.error('searchFiles error:', e)
    set({ searchResults: [] })
  } finally {
    // 목록을 읽는 중이면(검색을 닫고 폴더를 옮김) 그쪽이 로딩을 끈다
    if (seq === searchSeq && !listPending) set({ loading: false })
  }
}

export function exitSearch() {
  searchSeq++      // 떠 있는 검색 응답은 버린다
  set({ searchActive: false, searchQuery: '', searchResults: [] })
  if (!listPending) set({ loading: false })   // 버려진 검색이 켜 둔 로딩
}

// Containing folder of a result item (virtual path minus the last segment)
function containingFolder(item: FileItem): string {
  return item.path.split('/').slice(0, -1).join('/')
}

// Human-readable location (containing folder) for a search result row
export function itemLocation(item: FileItem): string {
  const parts = item.path.split('/').slice(0, -1)
  if (parts.length === 0) return ''
  return parts.map((p, i) => (i === 0 && ROOT_LABELS[p] ? tr(ROOT_LABELS[p]) : p)).join(' / ')
}

// Explorer "open file location": go to the file's folder and highlight it
export async function openFileLocation(item: FileItem) {
  const folder = containingFolder(item)
  exitSearch()
  set({ view: 'files' })
  await fetchFiles(folder)
  set({ selectedItems: new Set([item.path]) })
}

// Enter a folder result
export function enterFolder(item: FileItem) {
  exitSearch()
  fetchFiles(item.path)
}

/** 정렬된 목록(검색 중이면 검색 결과) */
export function filesSortedItems(s: Pick<FilesState, 'searchActive' | 'searchResults' | 'items' | 'sortField' | 'sortDir'> = get()): FileItem[] {
  const source = s.searchActive ? s.searchResults : s.items
  const arr = [...source]
  arr.sort((a, b) => {
    // Directories first
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1

    let cmp = 0
    if (s.sortField === 'name') {
      cmp = a.name.localeCompare(b.name, 'ko')
    } else if (s.sortField === 'size') {
      cmp = a.size - b.size
    } else if (s.sortField === 'modified_at') {
      const ta = a.modified_at ? new Date(a.modified_at).getTime() : 0
      const tb = b.modified_at ? new Date(b.modified_at).getTime() : 0
      cmp = ta - tb
    }

    return s.sortDir === 'asc' ? cmp : -cmp
  })
  return arr
}

export function toggleSort(field: SortField) {
  const s = get()
  if (s.sortField === field) {
    set({ sortDir: s.sortDir === 'asc' ? 'desc' : 'asc' })
  } else {
    set({ sortField: field, sortDir: 'asc' })
  }
}

/** 경로 조각(루트는 i18n 이름) */
export function filesBreadcrumbs(currentPath: string = get().currentPath, t: (k: string) => string = k => tr(k)) {
  const parts = currentPath.split('/').filter(Boolean)
  const crumbs: { label: string; path: string }[] = []

  let accumulated = ''
  for (const part of parts) {
    accumulated = accumulated ? `${accumulated}/${part}` : part
    crumbs.push({
      label: ROOT_LABELS[accumulated] ? t(ROOT_LABELS[accumulated]) : part,
      path: accumulated,
    })
  }
  return crumbs
}

// Navigation (hook 멤버 이름은 navigateTo)
export function navigateToPath(path: string) {
  // 검색 중에 경로 바·사이드바·셸(?path=)로 옮기면 검색을 닫는다 — 안 닫으면 경로만 바뀌고 목록은 옛 검색 결과였다
  if (get().searchActive) exitSearch()
  set({ view: 'files', inlineEdit: null })
  fetchFiles(path)
}

// ─── 뷰·휴지통·버전·사람 공유·이동 ───

export function setView(v: FilesView) {
  set({ view: v, inlineEdit: null, selectedItems: new Set(), listError: null })
  if (get().searchActive) exitSearch()
  if (v === 'trash') fetchTrash().catch(() => {})
  else if (v === 'links') fetchShareLinks()
  else if (v === 'shared-with-me') { set({ sharedBrowse: null }); fetchSharedWithMe().catch(() => {}) }
  else if (v === 'recent') fetchRecent().catch(() => {})
  else if (v === 'starred') fetchStars().catch(() => {})
}

// ─── 최근·즐겨찾기·활동 ───

/** 파일을 열었음을 기록(미리보기·편집기·내려받기로 열 때). 실패해도 여는 동작엔 영향 없음. */
export function markRecent(path: string) {
  if (!/^(my|shared|shared-with-me|users)\//.test(path || '')) return
  $fetch('/api/files/recent', { method: 'POST', body: { path } }).catch(() => {})
}

export async function fetchRecent() {
  set({ loading: true })
  try {
    const r = await $fetch<{ items: QuickItem[] }>('/api/files/recent', { params: { limit: 50 } })
    set({ recentItems: r.items })
  } catch (e) {
    set({ recentItems: [] })
    throw e
  } finally {
    set({ loading: false })
  }
}

export async function fetchStars() {
  set({ loading: true })
  try {
    const r = await $fetch<{ items: QuickItem[] }>('/api/files/stars')
    set({ starredItems: r.items })
  } catch (e) {
    set({ starredItems: [] })
    throw e
  } finally {
    set({ loading: false })
  }
}

/** 즐겨찾기 켜기/끄기 — 목록·검색 결과·즐겨찾기 뷰를 함께 맞춘다. */
export async function setStar(path: string, on: boolean) {
  if (on) await $fetch('/api/files/stars', { method: 'POST', body: { path } })
  else await $fetch('/api/files/stars', { method: 'DELETE', params: { path } })
  const patch = (list: FileItem[]) => list.map(i => (i.path === path ? { ...i, is_starred: on } : i))
  const s = get()
  set({ items: patch(s.items), searchResults: patch(s.searchResults) })
  if (!on) set({ starredItems: get().starredItems.filter(i => i.path !== path) })
  else if (get().view === 'starred') fetchStars().catch(() => {})
}

export async function fetchActivity(path: string, includeChildren = false) {
  const r = await $fetch<{ items: FileActivityEntry[] }>('/api/files/activity', { params: { path, include_children: includeChildren, limit: 50 } })
  return r.items
}

// ─── 공유 링크 확장·채널·휴지통 단건 ───

/** 링크 만들기 — 하나(paths 1개) 또는 묶음(paths 2+ → 받는 쪽은 zip 하나). 비밀번호·내려받기 막음 포함. */
export async function createLink(opts: { paths: string[]; isDir?: boolean; expiresIn?: string; oneTime?: boolean; canEdit?: boolean; password?: string; allowDownload?: boolean }) {
  // 폴더 하나는 paths 로 보낸다(서버: path 는 파일만, 폴더 하나 = 둘러보는 폴더 링크)
  const multi = opts.paths.length > 1 || !!opts.isDir
  return await $fetch<ShareLinkResponse>('/api/files/share', {
    method: 'POST',
    body: {
      path: multi ? '' : opts.paths[0],
      paths: multi ? opts.paths : null,
      expires_in: opts.expiresIn || null,
      one_time: !!opts.oneTime,
      can_edit: !!opts.canEdit,
      password: opts.password || null,
      allow_download: opts.allowDownload !== false,
    },
  })
}

/**
 * 이 파일을 손님 화면에서 미리 볼 수 있나(GET /share/preview-kind) — 판정은 서버가 손님 화면과 같은 함수로 한다.
 * 'image'|'pdf'|'text' = 미리보기 됨, null = 안 됨("다운로드 막음" 불가), undefined = 모름(구버전 서버·오류 → 막지 않고 서버 400 에 맡긴다).
 */
export async function fetchLinkPreviewKind(path: string): Promise<string | null | undefined> {
  try {
    const r = await $fetch<{ preview?: string | null }>('/api/files/share/preview-kind', { params: { path } })
    return r && typeof r === 'object' && 'preview' in r ? r.preview : undefined
  } catch { return undefined }
}

export async function updateShareLink(id: string, patch: ShareLinkPatch) {
  const row = await $fetch<ShareLinkListEntry>(`/api/files/share/${id}`, { method: 'PATCH', body: patch })
  set({ shareLinks: get().shareLinks.map(l => (l.id === id ? { ...l, ...row } : l)) })
  return row
}

/** 공유 링크를 이메일로 보내기 — 시스템 메일. 메일 언어 = 지금 화면 언어, 만료 시각 = 이 브라우저 시간대. */
export async function emailShareLink(id: string, emails: string[], message?: string) {
  let tz: string | undefined
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone } catch { tz = undefined }
  const r = await $fetch<ShareLinkEmailResult>(`/api/files/share/${id}/email`, {
    method: 'POST',
    body: { emails, message: message || null, locale: i18n.locale || null, tz: tz || null },
  })
  const okCount = r.results.filter(x => x.ok).length
  if (okCount) set({ shareLinks: get().shareLinks.map(l => (l.id === id ? { ...l, email_count: ((l as ShareLinkListEntry).email_count ?? 0) + okCount } : l)) })
  return r
}

/** 이 링크의 이메일 발송 기록(최신순) + 남은 발송 수 */
export async function fetchShareLinkEmails(id: string) {
  return await $fetch<{ items: ShareLinkEmailEntry[]; limits: ShareLinkEmailLimits }>(`/api/files/share/${id}/emails`)
}

/** 채팅 채널에 파일 메시지로 보내기(파일만, 10개·50MB 까지 — 서버 규칙) */
export async function shareToChannel(channelId: string, paths: string[], message?: string) {
  return await $fetch<{ ok: boolean }>('/api/files/share-channel', { method: 'POST', body: { channel_id: channelId, paths, message: message || null } })
}

export async function deleteTrashItem(trashName: string) {
  await $fetch(`/api/files/trash/${encodeURIComponent(trashName)}`, { method: 'DELETE' })
  set({ trashItems: get().trashItems.filter(t => t.trash_name !== trashName) })
  fetchStorageInfo()
}

// ─── 공유받은 폴더 안 ───

export async function openSharedFolder(entry: { share_id: string; name: string; owner: { display_name: string } }, sub = '') {
  const seq = ++sharedSeq
  set({ loading: true })
  try {
    const r = await $fetch<{ path: string; share_id: string; can_write: boolean; role?: ShareRole; owner: { id: string; name: string }; items: FileItem[] }>(
      `/api/files/shared-with-me/${entry.share_id}/list`, { params: { path: sub } })
    if (seq !== sharedSeq) return      // 그새 다른 폴더를 눌렀거나 목록으로 돌아갔다
    const role: ShareRole = r.role ?? (r.can_write ? 'edit' : 'view')
    set({ sharedBrowse: { shareId: entry.share_id, rootName: entry.name, path: r.path, sub, owner: r.owner?.name || entry.owner.display_name, canWrite: r.can_write, role, items: r.items.map(i => ({ ...i, role })) } })
  } catch (e) {
    if (seq !== sharedSeq) return      // 밀려난 요청의 실패는 알리지 않는다
    throw e
  } finally {
    if (seq === sharedSeq) set({ loading: false })
  }
}
export function closeSharedFolder() { sharedSeq++; set({ sharedBrowse: null }) }
/** 공유받음 화면 다시 읽기(공동 소유자가 이름 변경·이동·삭제한 뒤) — 폴더 안이면 그 폴더, 아니면 첫 목록 */
export async function refreshSharedView() {
  const b = get().sharedBrowse
  if (!b) { await fetchSharedWithMe(); return }
  try {
    await openSharedFolder({ share_id: b.shareId, name: b.rootName, owner: { display_name: b.owner } }, b.sub)
  } catch {
    // 지금 폴더가 사라졌으면(삭제·이동) 공유 루트로, 루트도 없으면 첫 목록으로
    try { await openSharedFolder({ share_id: b.shareId, name: b.rootName, owner: { display_name: b.owner } }, '') } catch { set({ sharedBrowse: null }); await fetchSharedWithMe() }
  }
}

export async function fetchShareCounts(path: string) {
  // 공유 집계는 소유자 기준(my/)만 의미가 있다.
  if (!path.startsWith('my')) { set({ shareCounts: {} }); return }
  try {
    const r = await $fetch<{ items: Record<string, { users: number; link: boolean }> }>('/api/files/share-user/counts', { params: { path } })
    if (get().currentPath === path) set({ shareCounts: r.items || {} })
  } catch { set({ shareCounts: {} }) }
}

export function isShared(item: FileItem): boolean {
  const s = get()
  const parent = item.path.split('/').slice(0, -1).join('/')
  if (parent !== s.currentPath) return false
  const c = s.shareCounts[item.name]
  return !!c && (c.users > 0 || c.link)
}

export async function fetchTrash() {
  set({ loading: true })
  try {
    const r = await $fetch<{ items: TrashEntry[]; retention_days?: number | null }>('/api/files/trash')
    set({ trashItems: r.items, trashRetentionDays: r.retention_days ?? null })
  } catch (e) {
    console.error('fetchTrash error:', e)
    set({ trashItems: [] })
    throw e
  } finally {
    set({ loading: false })
  }
}

export async function restoreTrash(trashName: string) {
  const r = await $fetch<{ ok: boolean; restored_path: string }>('/api/files/restore', { method: 'POST', body: { trash_name: trashName } })
  set({ trashItems: get().trashItems.filter(t => t.trash_name !== trashName) })
  fetchStorageInfo()
  return r
}

export async function emptyTrash() {
  await $fetch('/api/files/trash/empty', { method: 'DELETE' })
  set({ trashItems: [] })
  fetchStorageInfo()
}

export async function fetchVersions(path: string) {
  const r = await $fetch<{ versions: VersionEntry[]; count: number }>('/api/files/versions', { params: { path } })
  return r.versions
}

/** 버전 목록 + 현재본 작성자 */
export async function fetchVersionInfo(path: string) {
  const r = await $fetch<{ versions: VersionEntry[]; count: number; current_author?: { id: string; name: string } | null }>('/api/files/versions', { params: { path } })
  return { versions: r.versions, currentAuthor: r.current_author ?? null }
}

export async function restoreVersion(path: string, version: string) {
  await $fetch('/api/files/versions/restore', { method: 'POST', body: { path, version } })
  await fetchFiles()
}

export async function fetchUserShares(path: string) {
  return (await fetchShareInfo(path)).shares
}
/** 공유 목록 + 원 소유자 + 내 권한. path 는 my/.. 또는 공동 소유로 받은 shared-with-me/.. */
export async function fetchShareInfo(path: string): Promise<UserShareInfo> {
  const r = await $fetch<Partial<UserShareInfo> & { shares: UserShareEntry[] }>('/api/files/share-user/list', { params: { path } })
  return { shares: r.shares, owner: r.owner ?? null, my_role: r.my_role ?? 'owner' }
}

/** 사람·채널에 공유(채널 = 멤버 전원). notify 면 채팅으로 알린다(사람 DM · 채널 메시지 + message). */
export async function shareWithUsers(
  path: string, userIds: string[], role: ShareRole,
  opts: { channelIds?: string[]; notify?: boolean; message?: string } = {},
) {
  const r = await $fetch<{ ok: boolean; created: number; notified: number }>('/api/files/share-user', {
    method: 'POST',
    body: { path, user_ids: userIds, channel_ids: opts.channelIds ?? [], role, can_write: role === 'edit' || role === 'owner', notify: !!opts.notify, message: opts.message ?? null },
  })
  fetchShareCounts(get().currentPath)
  return r
}

/** 공유 한 줄 권한 바꾸기 */
export async function updateUserShare(id: string, role: ShareRole) {
  await $fetch(`/api/files/share-user/${id}`, { method: 'PATCH', body: { role } })
}

export async function deleteUserShare(id: string) {
  await $fetch(`/api/files/share-user/${id}`, { method: 'DELETE' })
  fetchShareCounts(get().currentPath)
}

export async function searchUsers(q: string) {
  return await $fetch<DirectoryUser[]>('/api/auth/users', { params: { q } })
}

export async function fetchSharedWithMe() {
  set({ loading: true })
  try {
    const r = await $fetch<{ items: SharedWithMeEntry[] }>('/api/files/shared-with-me')
    set({ sharedWithMe: r.items })
  } catch (e) {
    console.error('fetchSharedWithMe error:', e)
    set({ sharedWithMe: [] })
    throw e
  } finally {
    set({ loading: false })
  }
}

/**
 * 나에게 공유된 파일 내려받기 — 경로가 아니라 공유 id 로 받는다(전송 패널에 진행률).
 * sub 를 주면 공유받은 폴더 안의 그 파일.
 */
export async function downloadSharedWithMe(entry: Pick<SharedWithMeEntry, 'share_id' | 'name' | 'size'>, sub?: string) {
  const t = addTransfer(entry.name, 'down', entry.size)
  const controller = new AbortController()
  patchTransfer(t.id, { _abort: () => controller.abort() })
  markRecent(`shared-with-me/${entry.share_id}${sub ? `/${sub}` : ''}`)
  try {
    const q = sub ? `?path=${encodeURIComponent(sub)}` : ''
    const res = await apiRawFetch(`/api/files/shared-with-me/${entry.share_id}/download${q}`, { credentials: 'include', signal: controller.signal })
    if (!res.ok) { finishTransfer(t.id, 'error', tr('files.transfer.downloadFailed')); return }
    const total = Number(res.headers.get('content-length') || 0)
    const blob = await readWithProgress(res, t.id, total)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = entry.name
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(a.href)
    finishTransfer(t.id, 'done')
  } catch (e: any) {
    finishTransfer(t.id, e?.name === 'AbortError' ? 'canceled' : 'error', tr('files.transfer.downloadError'))
  }
}

/** 임의 경로에 폴더 만들기(이동 다이얼로그 "+ 새 폴더"). 현재 폴더면 목록 갱신. */
export async function mkdirAt(path: string) {
  await $fetch('/api/files/mkdir', { method: 'POST', body: { path } })
  const parent = path.split('/').slice(0, -1).join('/')
  if (parent === get().currentPath) await fetchFiles()
}

/** 하위 폴더만(이동 트리). */
export async function listFolders(path: string): Promise<FileItem[]> {
  const data = await $fetch<FileListResponse>('/api/files/list', { params: { path } })
  return data.items.filter(i => i.is_dir)
}

/** 여러 항목 이동·복사 — 하나씩 보내고 목록은 마지막에 한 번. 실패한 이름을 돌려준다. */
export async function moveItems(paths: string[], dst: string, copy = false): Promise<string[]> {
  const failed: string[] = []
  for (const src of paths) {
    try {
      const r = await $fetch<{ path?: string }>('/api/files/move', { method: 'PATCH', body: { src, dst, copy } })
      if (!copy && r?.path) repathInSearch(src, r.path)
    } catch {
      failed.push(src.split('/').pop() || src)
    }
  }
  await fetchFiles()
  await fetchStorageInfo()
  return failed
}

// Selection
export function toggleSelect(path: string) {
  const s = new Set(get().selectedItems)
  if (s.has(path)) {
    s.delete(path)
  } else {
    s.add(path)
  }
  set({ selectedItems: s })
}

export function selectAll() {
  const s = get()
  const source = s.searchActive ? s.searchResults : s.items
  if (s.selectedItems.size === source.length) {
    set({ selectedItems: new Set() })
  } else {
    set({ selectedItems: new Set(source.map(i => i.path)) })
  }
}

export function isOfficeFile(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  return ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp'].includes(ext)
}

const actions = {
  setViewMode,
  setSelectedItems,
  setInlineEdit,
  searchFiles,
  exitSearch,
  itemLocation,
  openFileLocation,
  enterFolder,
  fetchFiles,
  retryList,
  dismissListError,
  fetchStorageInfo,
  uploadFiles,
  createFolder,
  deleteItems,
  renameItem,
  moveItem,
  downloadFile,
  downloadMultiple,
  getPreviewUrl,
  createShareLink,
  fetchShareLinks,
  deleteShareLink,
  toggleSort,
  navigateTo: navigateToPath,
  toggleSelect,
  selectAll,
  isOfficeFile,
  setView,
  isShared,
  fetchShareCounts,
  fetchTrash,
  restoreTrash,
  emptyTrash,
  fetchVersions,
  restoreVersion,
  fetchUserShares,
  fetchShareInfo,
  shareWithUsers,
  updateUserShare,
  deleteUserShare,
  refreshSharedView,
  searchUsers,
  fetchSharedWithMe,
  downloadSharedWithMe,
  markRecent,
  fetchRecent,
  fetchStars,
  setStar,
  fetchActivity,
  createLink,
  updateShareLink,
  emailShareLink,
  fetchShareLinkEmails,
  shareToChannel,
  deleteTrashItem,
  openSharedFolder,
  closeSharedFolder,
  fetchVersionInfo,
  mkdirAt,
  listFolders,
  moveItems,
}

/**
 * 상태 + 동작. 내부 상태(searchResults·shareCounts)는 hook 으로 내보내지 않는다.
 * isShared 는 shareCounts·currentPath 를 읽으므로 그 둘도 구독해 둔다(바뀌면 다시 그림).
 */
export function useFiles() {
  const { t } = useI18n()
  const s = useStore(filesStore, useShallow((st: FilesState) => st))
  const sortedItems = useMemo(
    () => filesSortedItems(s),
    [s.searchActive, s.searchResults, s.items, s.sortField, s.sortDir], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const breadcrumbs = useMemo(() => filesBreadcrumbs(s.currentPath, t), [s.currentPath, t])
  return {
    currentPath: s.currentPath,
    items: s.items,
    loading: s.loading,
    viewMode: s.viewMode,
    sortField: s.sortField,
    sortDir: s.sortDir,
    selectedItems: s.selectedItems,
    storageInfo: s.storageInfo,
    shareLinks: s.shareLinks,
    searchActive: s.searchActive,
    searchQuery: s.searchQuery,
    sortedItems,
    breadcrumbs,
    // 뷰·휴지통·공유
    view: s.view,
    trashItems: s.trashItems,
    trashRetentionDays: s.trashRetentionDays,
    sharedWithMe: s.sharedWithMe,
    inlineEdit: s.inlineEdit,
    // 최근·즐겨찾기·공유 확장
    recentItems: s.recentItems,
    starredItems: s.starredItems,
    sharedBrowse: s.sharedBrowse,
    listError: s.listError,
    ...actions,
  }
}
