// AI 화면 순수 함수 — 대화 날짜 묶음 · 도구 묶음 · SSE 조각 해석 · 내보내기(테스트: tests/utils/aiAssist.test.ts).
// 모델·도구 이름은 전부 서버 응답에서 수신한다. 본 모듈에는 이름을 하드코딩하지 않는다.

export type AiConvGroup = 'today' | 'week' | 'earlier'

const WEEK_MS = 7 * 24 * 3600 * 1000

/** 대화 목록 묶음(오늘 · 이번 주 · 이전). 시각이 없으면 이전으로 분류 */
import type { ApprovalRequest } from '~/utils/approvals'
import type { AiArtifactPayload } from '~/utils/aiArtifacts'
export function aiConvGroup(updatedAt: string | null | undefined, now: Date = new Date()): AiConvGroup {
  if (!updatedAt) return 'earlier'
  const d = new Date(updatedAt)
  if (Number.isNaN(d.getTime())) return 'earlier'
  if (d.toDateString() === now.toDateString()) return 'today'
  return now.getTime() - d.getTime() < WEEK_MS ? 'week' : 'earlier'
}

/** 도구 이름의 묶음 키 — 접두사(mail_search → mail). 접두사가 없으면 이름 그대로 */
export function aiToolGroupKey(name: string): string {
  const i = name.indexOf('_')
  return i > 0 ? name.slice(0, i) : name
}

/** 도구 이름 목록 → 묶음(서버가 준 순서 유지, 같은 접두사끼리) */
export function aiToolGroups(names: string[]): { key: string; tools: string[] }[] {
  const out: { key: string; tools: string[] }[] = []
  for (const n of names) {
    const k = aiToolGroupKey(n)
    const g = out.find(x => x.key === k)
    if (g) g.tools.push(n)
    else out.push({ key: k, tools: [n] })
  }
  return out
}

export interface AiSseEvent { event: string; data: any; id?: string }

/**
 * SSE 버퍼에서 완료된 이벤트(빈 줄로 끝난 블록)를 추출한다. 미완료 잔여분은 rest 로 반환한다.
 * data 가 JSON 이 아니면 빈 객체. `id:` (서버 Redis stream id — 재연결 after)가 있으면 id 로 설정한다.
 * 주석만 있는 블록(": ping" — 유휴 연결 유지)은 건너뛴다.
 */
export function aiParseSse(buf: string): { events: AiSseEvent[]; rest: string } {
  const events: AiSseEvent[] = []
  let idx: number
  let rest = buf
  while ((idx = rest.indexOf('\n\n')) >= 0) {
    const chunk = rest.slice(0, idx)
    rest = rest.slice(idx + 2)
    let ev = 'message'
    let data = ''
    let id: string | undefined
    let fields = 0
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) { ev = line.slice(6).trim(); fields++ }
      else if (line.startsWith('data:')) { data += line.slice(5).trim(); fields++ }
      else if (line.startsWith('id:')) { id = line.slice(3).trim(); fields++ }
    }
    if (!fields) continue
    let payload: any
    try { payload = data ? JSON.parse(data) : {} } catch { payload = {} }
    events.push(id ? { event: ev, data: payload, id } : { event: ev, data: payload })
  }
  return { events, rest }
}

/** 대화 내보내기(마크다운). 이름표는 호출자가 번역하여 전달한다 */
export function aiExportMarkdown(
  title: string,
  messages: { role: string; content: string }[],
  labels: { user: string; assistant: string },
): string {
  const parts = [`# ${title}`, '']
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    parts.push(`## ${m.role === 'user' ? labels.user : labels.assistant}`, '', m.content.trim(), '')
  }
  return parts.join('\n')
}

/** 내보내기 파일 이름 — 경로·예약 문자 제거 */
export function aiExportFileName(title: string): string {
  const base = title.replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').trim().slice(0, 80) || 'conversation'
  return `${base}.md`
}

/** GET /api/ai/status */
export interface AiStatus {
  module_enabled: boolean
  configured: boolean
  provider_kind: string
  model: string
  external: boolean
  is_admin: boolean
  allow_user_keys: boolean
  external_allow_data: boolean
  needs_consent: boolean
  using_personal?: boolean
  /** 워크스페이스 제공 모델 이름(개인 키로 동작 중이어도) */
  workspace_model?: string
  /** 이 사용자의 AI 가 사용 가능한 도구 이름 */
  tools?: string[]
  /** 현재 모델의 이미지 첨부 판독 가능 여부 */
  vision?: boolean
  /** 첨부 한 개 최대 바이트(30MB) */
  attachment_max_bytes?: number
}

export interface AiConv {
  id: string
  title: string
  tools_enabled: boolean
  system_prompt?: string
  updated_at?: string | null
  /** 마지막 메시지 앞부분 */
  preview?: string
  /** 임시 대화(기록·메모리·프로젝트 지식 미사용, 이탈 시 삭제) */
  temporary?: boolean
  /** 연결된 프로젝트 */
  project_id?: string | null
}

/** 도구 호출 칩: ok 가 undefined 면 진행 중 */
export interface AiToolRun { name: string; ok?: boolean }

export interface AiMsg {
  id?: string
  role: string
  content: string
  created_at?: string | null
  streaming?: boolean
  tools?: AiToolRun[]
  /** 응답한 모델 이름(저장된 기록에도 포함. 이전 기록에는 없음) */
  model?: string | null
  /** AI 생성 답변(AI 기본법 표시) */
  ai_generated?: boolean
  /** 답변 상태 — complete · interrupted(끊김) · stopped(멈춤). 수신 중에는 streaming 플래그 */
  status?: 'complete' | 'interrupted' | 'stopped'
  /** 진행 단계(SSE step) */
  steps?: AiStep[]
  /** 출처(SSE citation) */
  citations?: AiCitation[]
  /** 답변 시작·끝 시각(단계 요약 "18초") */
  started_at?: string | null
  ended_at?: string | null
  /** 스트림 오류(본문과 별도로 오류 타일에 표시) */
  feedback?: AiFeedback | null
  /** 사용자에 의한 중지 */
  error?: string
  /** 이 응답 중 AI 가 요청한 쓰기(스트림 write_request — 채팅 승인 카드). 저장된 기록에는 없음 */
  stopped?: boolean
  /** 동일 질문의 버전 목록(사용자 메시지) + 현재 표시 중인 번호(1부터) */
  writes?: ApprovalRequest[]
  /** 같은 질문의 버전들(사용자 메시지) + 지금 보이는 번호(1부터) */
  versions?: { id: string; created_at?: string | null }[]
  active_version?: number
  /** 이 답변 중 메모리에 저장한 항목(스트림 memory_saved). 저장된 기록에는 없음 */
  attachments?: AiAttachment[]
  /** 생성한 결과물(스트림 artifact · 저장된 기록 meta.artifacts) */
  memories?: AiMemorySaved[]
  /** 만든 결과물(스트림 artifact · 저장된 기록 meta.artifacts) */
  artifacts?: AiArtifactPayload[]
  /** AI 질문 카드(ask_user · plan_exit — Claude Code AskUserQuestion · ExitPlanMode). 스트림 question · meta.questions */
  questions?: AiQuestion[]
}

export interface AiQuestionOption { label: string; description?: string }
export interface AiQuestionItem { question: string; header?: string; multiSelect?: boolean; options: AiQuestionOption[] }
export interface AiQuestionAnswer { question: string; selected: string[]; other: string | null }
export interface AiQuestion {
  id: string
  kind: 'ask' | 'plan'
  status: 'pending' | 'answered' | 'skipped' | 'canceled' | 'expired'
  questions?: AiQuestionItem[]
  plan?: string
  answer?: { answers?: AiQuestionAnswer[]; choice?: 'acceptEdits' | 'default' | 'keep_planning'; feedback?: string | null } | null
  created_at?: number
  expires_at?: number
}

/** 화면 전용 — 업로드 중 행의 키 */
export type AiAttachStage = 'uploading' | 'converting' | 'ready' | 'failed'
export type AiAttachErrorCode = 'encrypted' | 'distribution' | 'corrupt' | 'too_large' | 'unsupported_version' | 'unsupported'
export const AI_ATTACH_ERROR_CODES: AiAttachErrorCode[] = ['encrypted', 'distribution', 'corrupt', 'too_large', 'unsupported_version', 'unsupported']
export interface AiAttachment {
  id: string | null
  name: string
  size: number
  mime?: string
  kind?: 'document' | 'image'
  status: AiAttachStage
  chars?: number | null
  note?: string | null
  error_code?: AiAttachErrorCode | string
  error?: string
  /** 화면 전용 — 올리는 중 행 열쇠 */
  key?: string
  /** 서버 원본 보존 여부(7일 보관) — 전송된 첨부 칩의 미리보기·내려받기 */
  preview?: string
  /** 서버에 원본이 아직 있나(7일 보관) — 보낸 첨부 칩의 미리보기·내려받기 */
  has_file?: boolean
}

/** 현재 조회자의 읽기 가능 여부(읽기 불가 시 답변에서 제외). 목록 응답에는 없음 */
export interface AiModelChoice {
  key: 'workspace' | 'workspace_advanced' | 'personal'
  available: boolean
  model: string
  vision: boolean
  current: boolean
}

export interface AiMemorySaved { id: string; kind: 'preference' | 'work' | 'person'; text: string; cancelled?: boolean }

export interface AiMemoryItem {
  id: string
  kind: 'preference' | 'work' | 'person'
  text: string
  source_conversation_id?: string | null
  source_title?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export interface AiProjectFile {
  id: string; name: string; path: string; size?: number | null
  /** 공유 대상 그룹(소유자 = 전부, 구성원 = 본인이 속한 그룹만) */
  readable?: boolean
}
export interface AiProject {
  id: string
  name: string
  instructions: string
  role: 'owner' | 'member'
  editable: boolean
  shared: boolean
  share_group_id?: string | null
  share_group_name?: string | null
  /** 공유한 사용자(소유자) 이름 — 구성원 머리 "김하나 님이 인프라팀에 공유" */
  share_group_ids?: string[]
  share_groups?: { id: string; name: string }[]
  /** 본인이 읽을 수 없는 지식 파일 수(상세 응답만) */
  owner_name?: string | null
  /** 첨부 한도(서버 기본값과 동일하게 유지) */
  unreadable_files?: number
  conversation_count: number
  files?: AiProjectFile[]
  files_size?: number
  updated_at?: string | null
}

export interface AiSearchResult {
  id: string
  title: string
  snippet: string
  match: 'title' | 'message'
  message_id?: string | null
  project_id?: string | null
  updated_at?: string | null
}

/** 첨부 한도(서버 기본과 같게) */
export const AI_ATTACH_MAX = 30 * 1024 * 1024

/** 바이트 → "212 KB" · "1.9 MB" */
export function aiFormatBytes(n: number | null | undefined): string {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB`
  return `${(v / (1024 * 1024)).toFixed(1)} MB`
}

/** 첨부 실패 코드 → i18n 키(알 수 없는 코드는 unsupported) */
export function aiFileIcon(name: string, kind?: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (kind === 'image' || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'file-image'
  if (['xlsx', 'xlsm', 'csv', 'tsv'].includes(ext)) return 'file-sheet'
  if (ext === 'pptx') return 'file-slide'
  if (ext === 'pdf') return 'file-pdf'
  return 'file-doc'
}

/** 첨부 실패 코드 → i18n 키(모르는 코드는 unsupported) */
export function aiAttachErrorKey(code: string | undefined): string {
  return `ai.attach.err.${code === 'network' || AI_ATTACH_ERROR_CODES.includes(code as AiAttachErrorCode) ? code : 'unsupported'}`
}

/** 문구 강조용 — 검색어 위치로 [앞, 일치, 뒤] 조각(대소문자 무시). 없으면 [text] */
export function aiHighlightParts(text: string, q: string): string[] {
  const s = text || ''
  const needle = (q || '').trim()
  if (!needle) return [s]
  const i = s.toLowerCase().indexOf(needle.toLowerCase())
  if (i < 0) return [s]
  return [s.slice(0, i), s.slice(i, i + needle.length), s.slice(i + needle.length)]
}

/** 진행 단계(SSE step) — 같은 id 가 running → done/failed 로 갱신된다 */
export interface AiStep {
  id: string
  kind: 'search' | 'read' | 'tool' | 'write' | 'think' | 'ask'
  label: string
  status: 'running' | 'done' | 'failed'
  detail?: string
  started_at?: string | null
  ended_at?: string | null
}

/** 단계 목록에 갱신을 적용한다(동일 id 는 교체, 새 id 는 뒤에 추가) */
export interface AiCitation {
  n: number
  kind: 'mail' | 'file' | 'wiki' | 'board' | 'chat' | 'event' | 'web'
  id: string
  title: string
  url: string | null
  snippet?: string
  author?: string
  date?: string
}

export type AiFeedbackReason = 'inaccurate' | 'wrong_source' | 'ignored_instructions' | 'too_long'
export const AI_FEEDBACK_REASONS: AiFeedbackReason[] = ['inaccurate', 'wrong_source', 'ignored_instructions', 'too_long']

export interface AiFeedback {
  rating: 'up' | 'down'
  reasons: string[]
  comment?: string
  include_conversation?: boolean
}

/** 출처 목록에 추가한다(동일 n 은 교체), n 순 정렬 */
export function aiApplyStep(list: AiStep[] | undefined, step: AiStep): AiStep[] {
  const cur = list ?? []
  const at = cur.findIndex(s => s.id === step.id)
  if (at < 0) return [...cur, step]
  const next = [...cur]
  next[at] = { ...cur[at], ...step }
  return next
}

/** 단계 요약 — 총 단계·실패 수·진행 중 단계·소요 초(시작~끝, 없으면 단계 시각) */
export function aiApplyCitation(list: AiCitation[] | undefined, c: AiCitation): AiCitation[] {
  const cur = (list ?? []).filter(x => x.n !== c.n)
  return [...cur, c].sort((a, b) => a.n - b.n)
}

/** 한 단계의 소요 시간(초, 소수 한 자리). 진행 중이면 현재까지 */
export function aiStepsSummary(steps: AiStep[], startedAt?: string | null, endedAt?: string | null, now: number = Date.now()) {
  const total = steps.length
  const failed = steps.filter(s => s.status === 'failed').length
  const running = steps.find(s => s.status === 'running') || null
  const doneCount = steps.filter(s => s.status !== 'running').length
  const t0 = Date.parse(startedAt || steps[0]?.started_at || '')
  const endCandidates = [endedAt, ...steps.map(s => s.ended_at)].map(v => Date.parse(v || '')).filter(v => !Number.isNaN(v))
  const t1 = running ? now : (endCandidates.length ? Math.max(...endCandidates) : NaN)
  const secs = !Number.isNaN(t0) && !Number.isNaN(t1) ? Math.max(0, Math.round((t1 - t0) / 1000)) : null
  return { total, failed, running, doneCount, secs }
}

/** 한 단계가 걸린 시간(초, 소수 한 자리). 진행 중이면 지금까지 */
export function aiStepSecs(step: AiStep, now: number = Date.now()): string | null {
  const a = Date.parse(step.started_at || '')
  if (Number.isNaN(a)) return null
  const b = step.ended_at ? Date.parse(step.ended_at) : (step.status === 'running' ? now : NaN)
  if (Number.isNaN(b)) return null
  return `${Math.max(0, (b - a) / 1000).toFixed(1)}s`
}
