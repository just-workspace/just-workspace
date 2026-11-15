// Vue 원본: frontend/utils/aiAssist.ts (내용 그대로)
// AI 화면 순수 함수 — 대화 날짜 묶음 · 도구 묶음 · SSE 조각 해석 · 내보내기(테스트: tests/utils/aiAssist.test.ts).
// 모델·도구 이름은 전부 서버 응답에서 온다. 여기에는 이름을 박아 두지 않는다.

export type AiConvGroup = 'today' | 'week' | 'earlier'

const WEEK_MS = 7 * 24 * 3600 * 1000

/** 대화 목록 묶음(시안 AI 3: 오늘 · 이번 주 · 이전). 시각이 없으면 이전 */
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
 * SSE 버퍼에서 끝난 이벤트(빈 줄로 끝난 덩어리)를 꺼낸다. 남은 반쪽은 rest 로 돌려준다.
 * data 가 JSON 이 아니면 빈 객체. `id:` (서버 Redis stream id — 재연결 after)가 있으면 id 로.
 * 주석만 있는 덩어리(": ping" — 유휴 연결 유지)는 건너뛴다.
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

/** 대화 내보내기(마크다운). 이름표는 호출 쪽이 번역해서 넘긴다 */
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
  /** 이 사용자 AI 가 쓸 수 있는 도구 이름 */
  tools?: string[]
  /** S6b — 지금 모델이 이미지 첨부를 읽는지 */
  vision?: boolean
  /** S6b — 첨부 한 개 최대 바이트(30MB) */
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
  /** S6b — 임시 대화(기록·메모리·프로젝트 지식 안 씀, 나가면 삭제) */
  temporary?: boolean
  /** S6b — 묶인 프로젝트 */
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
  /** 답한 모델 이름(S6a 부터 저장된 기록에도 있다. 그 전 기록은 없음) */
  model?: string | null
  /** AI 생성 답변(AI 기본법 표시) */
  ai_generated?: boolean
  /** 답변 상태 — complete · interrupted(끊김) · stopped(멈춤). 받는 중엔 streaming 플래그 */
  status?: 'complete' | 'interrupted' | 'stopped'
  /** 진행 단계(SSE step) */
  steps?: AiStep[]
  /** 출처(SSE citation) */
  citations?: AiCitation[]
  /** 답변 시작·끝 시각(단계 요약 "18초") */
  started_at?: string | null
  ended_at?: string | null
  /** 내 피드백 */
  feedback?: AiFeedback | null
  /** 스트림 오류(본문과 따로 오류 타일로 보인다) */
  error?: string
  /** 사용자가 멈춤 */
  stopped?: boolean
  /** 이 응답 중 AI 가 요청한 쓰기(스트림 write_request — 채팅 승인 카드, 시안 A1·A2). 저장된 기록엔 없다 */
  writes?: ApprovalRequest[]
  /** S6b — 같은 질문의 버전들(사용자 메시지) + 지금 보이는 번호(1부터) */
  versions?: { id: string; created_at?: string | null }[]
  active_version?: number
  /** S6b — 사용자 메시지 첨부 */
  attachments?: AiAttachment[]
  /** S6b — 이 답변 중 메모리에 저장한 것(스트림 memory_saved). 저장된 기록엔 없다 */
  memories?: AiMemorySaved[]
  /** S4 — 만든 결과물(스트림 artifact · 저장된 기록 meta.artifacts) */
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

/** S6b 첨부(서버 POST /api/ai/attachments 결과 + 화면 진행 상태) */
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
  /** 화면 전용 — 입력창 이미지 썸네일(로컬 object URL) */
  preview?: string
  /** 서버에 원본이 아직 있나(7일 보관) — 보낸 첨부 칩의 미리보기·내려받기 */
  has_file?: boolean
}

/** 설정 › AI 기본 모델 선택지(GET /api/ai/model-choices) */
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
  /** 지금 보는 사람이 읽을 수 있나(못 읽으면 답변에서 빠짐 — 시안 J2-3). 목록 응답엔 없다 */
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
  /** 공유 대상 그룹(주인 = 전부, 구성원 = 자기가 속한 그룹만) */
  share_group_ids?: string[]
  share_groups?: { id: string; name: string }[]
  /** 공유한 사람(주인) 이름 — 구성원 머리 "김하나 님이 인프라팀에 공유" */
  owner_name?: string | null
  /** 내가 못 읽는 지식 파일 수(상세 응답만) */
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

/** 파일 이름 → 아이콘 이름 */
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

/** 출처(SSE citation). url 은 앱 안 링크(웹은 원래 주소), 깊은 링크가 없으면 null */
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

/** 단계 목록에 갱신을 넣는다(같은 id 는 바꿔 끼움, 새 id 는 뒤에) */
export function aiApplyStep(list: AiStep[] | undefined, step: AiStep): AiStep[] {
  const cur = list ?? []
  const at = cur.findIndex(s => s.id === step.id)
  if (at < 0) return [...cur, step]
  const next = [...cur]
  next[at] = { ...cur[at], ...step }
  return next
}

/** 출처 목록에 더한다(같은 n 은 바꿔 끼움), n 순 */
export function aiApplyCitation(list: AiCitation[] | undefined, c: AiCitation): AiCitation[] {
  const cur = (list ?? []).filter(x => x.n !== c.n)
  return [...cur, c].sort((a, b) => a.n - b.n)
}

/** 단계 요약 — 총 단계·실패 수·진행 중 단계·걸린 초(시작~끝, 없으면 단계 시각) */
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
