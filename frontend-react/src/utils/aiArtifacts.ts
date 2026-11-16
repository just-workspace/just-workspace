/**
 * 결과물(AI 가 생성한 문서·묶음·파일 압축) — 타입·API·표시 도우미.
 * 서버: app/ai/artifacts.py · artifacts_router.py(/api/ai/artifacts). 채팅 SSE `artifact` 이벤트와
 * 메시지 기록(messages[].artifacts)은 동일한 형태 {type:'file', artifact} | {type:'bundle', job} 이다.
 */
import { $fetch } from '~/lib/api'
import type { ApprovalRequest } from '~/utils/approvals'

export type AiArtifactFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'zip'
export type AiArtifactStatus = 'ready' | 'failed' | 'expired'

export interface AiArtifact {
  id: string
  format: AiArtifactFormat
  name: string
  label?: string
  mime?: string
  size: number
  status: AiArtifactStatus
  error?: string | null
  pages?: number | null
  sheets?: number | null
  slides?: number | null
  files?: number | null
  conversation_id?: string | null
  job_id?: string | null
  can_rebuild?: boolean
  download_url: string | null
  expires_at: string
  created_at?: string | null
  saved_path?: string | null
  saved_folder?: string | null
  saved_label?: string | null
}

export type AiJobItemStatus = 'pending' | 'running' | 'ready' | 'failed' | 'forbidden' | 'deduped'
export interface AiArtifactJobItem {
  index: number
  name: string
  format?: string
  path?: string
  arc?: string
  status: AiJobItemStatus
  artifact_id?: string | null
  size?: number
  error?: string | null
  same_as?: string | null
  download_url?: string | null
}

export interface AiArtifactJob {
  id: string
  kind: 'docs' | 'files_zip'
  name: string
  status: 'running' | 'done' | 'partial' | 'failed'
  link_status?: AiArtifactStatus | null
  total: number
  done: number
  ok: number
  failed: number
  size: number
  items: AiArtifactJobItem[]
  items_more?: number
  zip: AiArtifact | null
  conversation_id?: string | null
  conversation_title?: string | null
  saved_folder?: string | null
  saved_label?: string | null
  skipped?: number
  finished_at?: string | null
}

export type AiArtifactPayload =
  | { type: 'file'; artifact: AiArtifact }
  | { type: 'bundle'; job: AiArtifactJob }

export interface AiArtifactPreview {
  format: string
  title: string
  subtitle?: string
  blocks?: { type: string; text?: string; level?: number; items?: string[]; ordered?: boolean; header?: string[]; rows?: string[][]; more_rows?: number }[]
  sheets?: { name: string; header: string[]; rows: unknown[][]; more_rows?: number }[]
  slides?: { title: string; bullets: { text: string; level: number }[]; notes?: string; table?: { header: string[]; rows: string[][] } | null }[]
}

/** 저장 결과(POST …/save) */
export interface AiArtifactSaveResult {
  folder: string
  folder_label?: string
  files: { artifact_id: string; path: string; name: string }[]
  artifact?: AiArtifact
  job?: AiArtifactJob
}

const base = '/api/ai/artifacts'
export const aiArtifactsApi = {
  get: (id: string) => $fetch<AiArtifact>(`${base}/${encodeURIComponent(id)}`),
  preview: (id: string) => $fetch<{ artifact: AiArtifact; preview: AiArtifactPreview | null }>(`${base}/${encodeURIComponent(id)}/preview`),
  save: (id: string) => $fetch<AiArtifactSaveResult>(`${base}/${encodeURIComponent(id)}/save`, { method: 'POST' }),
  rebuild: (id: string) => $fetch<AiArtifact>(`${base}/${encodeURIComponent(id)}/rebuild`, { method: 'POST' }),
  job: (id: string) => $fetch<AiArtifactJob>(`${base}/jobs/${encodeURIComponent(id)}`),
  retryItem: (id: string, index: number) => $fetch<AiArtifactJob>(`${base}/jobs/${encodeURIComponent(id)}/items/${index}/retry`, { method: 'POST' }),
  rebuildJob: (id: string) => $fetch<AiArtifactJob>(`${base}/jobs/${encodeURIComponent(id)}/rebuild`, { method: 'POST' }),
  saveJob: (id: string) => $fetch<AiArtifactSaveResult>(`${base}/jobs/${encodeURIComponent(id)}/save`, { method: 'POST' }),
  /** 파일 화면 [압축해서 내려받기] — files_zip 과 동일한 작업 */
  zip: (body: { paths?: string[]; folder?: string; query?: string; path?: string; zip_name?: string }) =>
    $fetch<AiArtifactJob>(`${base}/zip`, { method: 'POST', body }),
}

/** 남은 시간(시간 단위, 올림). 경과 시 0 */
export function aiHoursLeft(expiresAt: string | null | undefined, now: number = Date.now()): number {
  const t = Date.parse(expiresAt || '')
  if (Number.isNaN(t)) return 0
  return Math.max(0, Math.ceil((t - now) / 3_600_000))
}

/** 형식 → 아이콘 */
export function aiArtifactIcon(format: string | undefined): string {
  switch (format) {
    case 'xlsx': return 'file-sheet'
    case 'pptx': return 'file-slide'
    case 'pdf': return 'file-pdf'
    case 'zip': return 'file-zip'
    default: return 'file-doc'
  }
}

/** 쪽·시트·슬라이드 수 → i18n 키와 값(없으면 null) */
export function aiArtifactUnit(a: Pick<AiArtifact, 'pages' | 'sheets' | 'slides' | 'files'>): { key: string; n: number } | null {
  if (a.slides) return { key: 'ai.artifact.unit.slides', n: a.slides }
  if (a.sheets) return { key: 'ai.artifact.unit.sheets', n: a.sheets }
  if (a.pages) return { key: 'ai.artifact.unit.pages', n: a.pages }
  if (a.files) return { key: 'ai.artifact.unit.files', n: a.files }
  return null
}

/** 저장 폴더 가상경로 → 파일 화면 주소 */
export function aiFolderHref(folder: string | null | undefined): string {
  return folder ? `/files?path=${encodeURIComponent(folder)}` : '/files'
}

/** 서버 오류 → {code, message, room_bytes} */
export function aiArtifactError(e: any): { code: string; message: string; room?: number | null } {
  const d = e?.data?.detail
  if (d && typeof d === 'object') return { code: String(d.code || 'failed'), message: String(d.message || ''), room: d.room_bytes ?? null }
  const status = e?.status ?? e?.statusCode ?? e?.response?.status
  return { code: status === 413 ? 'quota' : 'failed', message: typeof d === 'string' ? d : (e?.message || '') }
}

/** 실행된 files_zip 쓰기(내장 AI 승인 카드로 실행)도 묶음 카드로 표시한다 */
export function aiArtifactsFromWrites(writes: ApprovalRequest[] | undefined): AiArtifactPayload[] {
  const out: AiArtifactPayload[] = []
  for (const w of writes ?? []) {
    const job = (w as any)?.result?.job
    if (w.tool === 'files_zip' && w.status === 'executed' && job?.id) out.push({ type: 'bundle', job })
  }
  return out
}

/** 동일 대상(파일 id·작업 id)은 하나로 병합 — 나중 항목 우선 */
export function aiMergeArtifacts(list: AiArtifactPayload[]): AiArtifactPayload[] {
  const seen = new Map<string, AiArtifactPayload>()
  for (const p of list) {
    const k = p.type === 'file' ? `f:${p.artifact?.id}` : `b:${p.job?.id}`
    if (k.endsWith(':undefined')) continue
    seen.set(k, p)
  }
  return [...seen.values()]
}

/**
 * 파일 화면 [압축해서 내려받기] — 서버 압축 작업(files_zip 과 동일한 API)을 시작하고, 전송 패널에 진행률을 표시한 뒤
 * 완료 시 zip 을 내려받는다. zip 은 내 파일 › AI 결과물 에도 보존된다. 결과 작업을 반환한다(실패 시 throw).
 */
export async function aiZipAndDownload(
  body: { paths?: string[]; query?: string; path?: string; zip_name?: string },
  label: string,
  deps: {
    addTransfer: (name: string, dir: 'up' | 'down', total?: number) => { id: string }
    updateProgress: (id: string, loaded: number, total?: number) => void
    finishTransfer: (id: string, status: any, error?: string) => void
    sleep?: (ms: number) => Promise<void>
  },
): Promise<AiArtifactJob> {
  const tr = deps.addTransfer(label, 'down')
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  try {
    let job = await aiArtifactsApi.zip(body)
    while (job.status === 'running') {
      deps.updateProgress(tr.id, job.done, job.total)
      await sleep(1500)
      job = await aiArtifactsApi.job(job.id)
    }
    const url = job.zip?.download_url
    if (!url) throw new Error(job.zip?.error || job.items.find(x => x.error)?.error || 'zip failed')
    deps.finishTransfer(tr.id, 'done')
    if (typeof document !== 'undefined') {
      const a = document.createElement('a')
      a.href = url
      a.download = job.zip?.name || 'files.zip'
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
    }
    return job
  } catch (e: any) {
    deps.finishTransfer(tr.id, 'error', aiArtifactError(e).message || e?.message)
    throw e
  }
}
