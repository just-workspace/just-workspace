/**
 * 관리 › 업데이트 — 서버(/api/admin/system/update) 호출과 화면이 공유하는 형(型)·순수 계산.
 * 업데이트는 설치 관리자가 수행한다. 본 모듈의 값은 전부 서버가 제공한 것이다(버전·용량·시간·구역을 화면에 하드코딩하지 않는다).
 * 계약: docs/update-api.md
 */
import { $fetch, apiRawFetch } from '~/lib/api'
import { apiUrl, bundledAuthHeaders } from '~/lib/runtimeConfig'

export type Channel = 'stable' | 'beta'
export type UpdateMode = 'manual' | 'auto'
export type StepStatus = 'pending' | 'running' | 'done' | 'failed'
export type JobKind = 'update' | 'rollback' | 'restore'
export type JobStatus = 'countdown' | 'running' | 'failed' | 'done' | 'cancelled'
export type JobAction = 'start_now' | 'cancel' | 'retry' | 'rollback'
export type Trigger = 'manual' | 'auto' | 'offline'
export type HistoryResult = 'success' | 'rolled_back' | 'rollback_failed' | 'restored' | 'restore_failed' | 'cancelled'
export type Localized = Record<string, string>

export interface UpdateWindow { start: string; end: string }
export interface UpdateSettings {
  mode: UpdateMode
  window: UpdateWindow
  channel: Channel
  min_age_days: number
  beta?: { since: string | null; restore_point: RestorePoint | null }
}
export interface PluginWarning { id: string; name: string; reason?: string }
export type Available =
  | { state: 'none' }
  | { state: 'wait'; channel_latest: string | null; resume_from: string | null }
  | { state: 'blocked'; version: string; reason?: { code?: string; vars?: Record<string, unknown> } }
  | {
    state: 'update'
    version: string
    channel: Channel
    published: string | null
    summary: string | null
    path: string[]
    download_bytes: number | null
    downtime_seconds: number | null
    zones: { id: string; name: Localized }[]
    plugin_warnings: PluginWarning[]
    changelog: string | null
    auto_eligible_at?: string | null
  }
export type AvailableUpdate = Extract<Available, { state: 'update' }>

export interface PullImage { name: string; status: 'pending' | 'pulling' | 'done' | 'failed'; percent: number | null }
export interface JobStep {
  id: string
  status: StepStatus
  started_at?: string | null
  finished_at?: string | null
  detail?: { images?: PullImage[]; percent?: number | null }
}
export interface UpdateJob {
  id: string
  kind: JobKind
  trigger: Trigger
  status: JobStatus
  from_version: string | null
  target_version: string | null
  path: string[]
  version_index: number
  countdown: { ends_at: string; seconds: number } | null
  steps: JobStep[]
  error: { step?: string; cause?: string; detail?: string; vars?: Record<string, unknown> } | null
  choices: JobAction[]
  rollback_job: string | null
  parent_job?: string | null
  restore: { point?: string; version?: string; reason?: 'manual' | 'beta' } | null
  expected_seconds: number | null
  started_at: string | null
  maintenance_started_at: string | null
  finished_at: string | null
}
export interface LastAuto {
  job: string
  result: HistoryResult
  version: string | null
  from_version: string | null
  finished_at: string | null
  downtime_seconds: number | null
  failed_step: string | null
}
export interface UpdateStatus {
  current: { version: string; channel: Channel; applied_at: string | null; previous_version: string | null }
  settings: UpdateSettings
  check: { state: 'idle' | 'checking'; last_at: string | null; ok: boolean | null; error: { code?: string; detail?: string } | null }
  available: Available
  job: UpdateJob | null
  auto: { paused: boolean; paused_at: string | null; reason: { job?: string; step?: string; version?: string } | null }
  last_auto: LastAuto | null
  server_time?: string
}
export interface SettingsReply {
  settings: UpdateSettings
  effect: { channel: null | 'to_beta' | 'to_stable_wait' | 'to_stable_restore'; wait: { channel_latest: string | null; resume_from: string | null } | null; job: UpdateJob | null }
}
export interface RestorePoint { id: string; kind?: 'pre-update' | 'pre-beta'; version: string; created_at: string; size_bytes: number | null }
export type BundleState = 'uploading' | 'verifying' | 'verified' | 'signature_mismatch' | 'version_too_low' | 'file_missing' | 'invalid'
export type ExtraImageState = 'present' | 'missing' | 'verifying' | 'hash_mismatch' | 'not_needed'
export interface OfflineBundle {
  source: 'upload' | 'path'
  filename: string | null
  size_bytes: number | null
  state: BundleState
  percent: number | null
  version: string | null
  current_version: string | null
  contains: { images?: boolean; apps?: string[] } | null
  downtime_seconds: number | null
  error: { code?: string; detail?: string } | null
}
export interface ExtraImage {
  id: string
  name: Localized
  reason: 'always' | 'zone'
  zone: { id: string; name: Localized } | null
  zone_enabled: boolean
  state: ExtraImageState
  command: string | null
  filename: string | null
}
export interface OfflineState {
  bundle: OfflineBundle | null
  images: ExtraImage[]
  download_url: string | null
  accept: string | null
  ready: boolean
  blockers: string[]
}
export interface HistoryItem {
  id: string
  kind: 'update' | 'restore'
  trigger: Trigger
  version: string
  from_version: string | null
  result: HistoryResult
  started_at: string | null
  finished_at: string | null
  duration_seconds: number | null
  downtime_seconds: number | null
  actor: { id?: string; name?: string } | null
}
export interface HistoryStep { id: string; status: StepStatus; duration_seconds: number | null; note: string | null }
export interface HistoryDetail extends HistoryItem {
  versions: { version: string; steps: HistoryStep[] }[]
  rollback: { result: string; steps: HistoryStep[] } | null
}
export interface AppFile { kind: string; version: string | null; filename: string; size_bytes: number | null; url: string | null }
export interface AppsReply { version: string; download_page: string | null; apps: AppFile[] }
export interface ReleaseNotes {
  version: string
  channel: Channel
  published: string | null
  changelog: string | null
  applied_at?: string | null
  trigger?: Trigger | null
  downtime_seconds?: number | null
  previous_version?: string | null
  disabled_plugins?: PluginWarning[]
}

export const UPDATE_BASE = '/admin/update'
/** 롤백이 중단되었을 때 참조할 문서(백업·복원 절차) */
export const UPDATE_DOCS_URL = 'https://github.com/just-workspace/just-workspace/blob/main/docs/data-safety.md'
const API = '/api/admin/system/update'

/** 파일을 본문 그대로 업로드한다(진행률 수신을 위해 XHR 사용). 실패 시 `{status, data}` 를 가진 오류 */
export function uploadFile(path: string, file: File, onProgress?: (percent: number) => void, signal?: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', apiUrl(path))
    xhr.withCredentials = true
    for (const [k, v] of Object.entries(bundledAuthHeaders())) xhr.setRequestHeader(k, v)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.setRequestHeader('X-JW-Filename', encodeURIComponent(file.name))
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total) onProgress?.(Math.round((e.loaded / e.total) * 100)) }
    const fail = (status: number, data: unknown) => reject(Object.assign(new Error(String(status)), { status, statusCode: status, data }))
    xhr.onload = () => {
      let data: unknown = null
      try { data = JSON.parse(xhr.responseText) } catch { /* 본문 없음 */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data)
      else fail(xhr.status, data)
    }
    xhr.onerror = () => fail(0, null)
    xhr.onabort = () => reject(Object.assign(new Error('aborted'), { aborted: true }))
    signal?.addEventListener('abort', () => xhr.abort())
    xhr.send(file)
  })
}

export const updateApi = {
  status: () => $fetch<UpdateStatus>(`${API}/status`),
  check: () => $fetch<UpdateStatus>(`${API}/check`, { method: 'POST' }),
  release: (version: string) => $fetch<ReleaseNotes>(`${API}/releases/${encodeURIComponent(version)}`),
  settings: () => $fetch<UpdateSettings>(`${API}/settings`),
  saveSettings: (body: Partial<Pick<UpdateSettings, 'mode' | 'window' | 'channel'>> & { stable_return?: 'wait' | 'restore' }) =>
    $fetch<SettingsReply>(`${API}/settings`, { method: 'PUT', body }),
  apply: (target: string, start: 'countdown' | 'now' = 'countdown') => $fetch<UpdateJob>(`${API}/apply`, { method: 'POST', body: { target, start } }),
  job: (id: string) => $fetch<UpdateJob>(`${API}/jobs/${id}`),
  jobAction: (id: string, action: JobAction) => $fetch<UpdateJob>(`${API}/jobs/${id}/action`, { method: 'POST', body: { action } }),
  jobLog: (id: string) => $fetch<{ lines: string[] }>(`${API}/jobs/${id}/log`, { query: { tail: 2000 } }),
  jobLogUrl: (id: string) => `${API}/jobs/${id}/log/download`,
  resumeAuto: () => $fetch<{ auto: UpdateStatus['auto']; window?: UpdateWindow }>(`${API}/auto/resume`, { method: 'POST' }),
  restorePoints: () => $fetch<{ points: RestorePoint[] }>(`${API}/restore-points`),
  restore: (point: string, start: 'countdown' | 'now' = 'countdown') => $fetch<UpdateJob>(`${API}/restore`, { method: 'POST', body: { point, start } }),
  offline: () => $fetch<OfflineState>(`${API}/offline`),
  offlineUpload: (file: File, onProgress?: (p: number) => void, signal?: AbortSignal) => updateUpload.send(`${API}/offline/bundle`, file, onProgress, signal) as Promise<OfflineState>,
  offlinePath: (path: string) => $fetch<OfflineState>(`${API}/offline/bundle-path`, { method: 'POST', body: { path } }),
  offlineClear: () => $fetch<OfflineState>(`${API}/offline/bundle`, { method: 'DELETE' }),
  offlineImage: (id: string, file: File, onProgress?: (p: number) => void) => updateUpload.send(`${API}/offline/images/${id}`, file, onProgress) as Promise<OfflineState>,
  offlineApply: (start: 'countdown' | 'now' = 'countdown') => $fetch<UpdateJob>(`${API}/offline/apply`, { method: 'POST', body: { start } }),
  history: () => $fetch<{ items: HistoryItem[]; retention_days: number; more: boolean }>(`${API}/history`, { query: { limit: 100 } }),
  historyEntry: (id: string) => $fetch<HistoryDetail>(`${API}/history/${id}`),
  apps: () => $fetch<AppsReply>(`${API}/apps`),
  contact: () => $fetch<{ contact: string | null }>(`${API}/contact`),
  saveContact: (contact: string | null) => $fetch<{ contact: string | null; synced: boolean }>(`${API}/contact`, { method: 'PUT', body: { contact } }),
}

/** 업로드 구현 — 테스트에서 교체한다 */
export const updateUpload = { send: uploadFile }

/** 기록을 파일로 다운로드한다 */
export async function downloadJobLog(id: string): Promise<void> {
  const r = await apiRawFetch(updateApi.jobLogUrl(id), { credentials: 'include' })
  if (!r.ok) throw new Error(String(r.status))
  const url = URL.createObjectURL(await r.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = `update-${id}.log`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** 서버 오류의 code(없으면 '') — 본문은 `{code, vars, detail}` */
export function errorCode(e: unknown): string {
  const code = (e as { data?: { code?: unknown } } | null)?.data?.code
  return typeof code === 'string' ? code : ''
}
/** `update_unavailable` 의 사유 — 설치 관리자 없음 / 미지원. 그 오류가 아니면 null */
export function unavailableReason(e: unknown): 'no_installer' | 'unsupported' | null {
  if (errorCode(e) !== 'update_unavailable') return null
  const reason = (e as { data?: { vars?: { reason?: unknown } } }).data?.vars?.reason
  return reason === 'unsupported' ? 'unsupported' : 'no_installer'
}

export function localized(text: Localized | undefined | null, locale: string): string {
  return text?.[locale] ?? text?.ko ?? text?.en ?? ''
}

/** 1288490188 → "1.2 GB" (값 미상이면 '') */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** 초 → {m, s} — 문구는 화면이 선택한다(1분 미만이면 m = 0) */
export function splitDuration(seconds: number | null | undefined): { m: number; s: number } | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null
  const total = Math.round(seconds)
  return { m: Math.floor(total / 60), s: total % 60 }
}

/** 남은 초 → "04:12" */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** ISO 시각 → 브라우저 시간대의 "2026-01-12 10:35" (파싱 실패 시 '') */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 변경 내용(마크다운) → 줄 목록. 글머리(-, *)와 제목(#) 표시는 제거한다 */
export function changelogLines(text: string | null | undefined): string[] {
  return (text ?? '').split(/\r?\n/).map(l => l.replace(/^\s*(?:[-*+]|#{1,6}|\d+\.)\s+/, '').trim()).filter(Boolean)
}

export const HOURS = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`)

/** 종료되지 않은 작업인지 여부(사전 공지·진행 중, 또는 관리자의 선택을 대기 중인 실패) */
export function isLive(job: UpdateJob | null | undefined): job is UpdateJob {
  if (!job) return false
  return job.status === 'countdown' || job.status === 'running' || (job.status === 'failed' && job.choices.length > 0)
}

/** 작업의 진행 화면 경로 — 업데이트는 적용 화면, 롤백·복원은 롤백 탭 */
export function jobPath(job: Pick<UpdateJob, 'id' | 'kind'>): string {
  return job.kind === 'update' ? `${UPDATE_BASE}/apply/${job.id}` : `${UPDATE_BASE}/rollback/${job.id}`
}

export type UpdateView = 'home' | 'notes' | 'apply' | 'changes' | 'settings' | 'rollback' | 'offline' | 'apps' | 'history'
const VIEWS: UpdateView[] = ['notes', 'apply', 'changes', 'settings', 'rollback', 'offline', 'apps', 'history']

/** /admin/update/<화면>/<인자> → {view, arg} */
export function viewFromPath(path: string): { view: UpdateView; arg: string | null } {
  const rest = path.startsWith(UPDATE_BASE) ? path.slice(UPDATE_BASE.length).replace(/^\/+|\/+$/g, '') : ''
  const [head, arg] = rest.split('/')
  const view = (VIEWS as string[]).includes(head) ? (head as UpdateView) : 'home'
  return { view, arg: view !== 'home' && arg ? decodeURIComponent(arg) : null }
}

/** 오프라인: 적용을 차단하는 사유(i18n 키의 마지막 조각). 차단하지 않으면 null */
export function offlineBlock(state: OfflineState | null, uploading: boolean): string | null {
  if (uploading) return 'uploading'
  const b = state?.bundle
  if (!b) return 'empty'
  if (b.state === 'uploading') return 'uploading'
  if (b.state === 'verifying') return 'verifying'
  if (b.state === 'signature_mismatch') return 'signature'
  if (b.state === 'version_too_low') return 'version'
  if (b.state === 'file_missing') return 'file_missing'
  if (b.state !== 'verified') return 'invalid'
  const needed = state!.images.filter(i => i.state !== 'not_needed')
  if (needed.some(i => i.state === 'hash_mismatch')) return 'image_mismatch'
  if (needed.some(i => i.state === 'verifying')) return 'image_verifying'
  if (needed.some(i => i.state === 'missing')) return 'image_missing'
  return state!.ready ? null : 'image_missing'
}
