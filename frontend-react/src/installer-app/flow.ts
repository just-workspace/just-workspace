/**
 * 단계 목록 규칙 — 표시할 화면과 그 순서는 전부 여기서 결정한다(화면은 이 결과만 따른다).
 *
 * 새로 설치 · 빠른 설치
 *  - 기본 골격(상시 포함): 사전 점검 → 시작 방식 → 접속 주소와 연결 → 파일 저장 위치 → 구역 선택 → 관리자 계정 → 요약 → 적용
 *  - 연결에 종속된 단계는 해당 항목을 선택한 경우에만 삽입된다: 프록시 주소(기존 프록시 뒤) · 인증서 올리기(가진 인증서) · 포트 포워딩 안내(공유기 뒤)
 *  - 구역에 종속된 단계(메일 · 회의 · AI 도우미 · 코드 저장소)는 항상 목록에 포함되며, 해당 구역을 선택하지 않은 경우 "건너뜀"으로 처리한다
 *  - 빠른 설치는 파일 저장 위치와 구역 선택을 묻지 않는다(건너뜀)
 * 백업에서 복원
 *  - 사전 점검 → 시작 방식 → 백업 파일 올리기 → 내용 확인 → 적용
 */
import type { CertMode, Mode, Network } from './api/types'

export type StepId =
  | 'check' | 'start' | 'domain' | 'proxy' | 'cert' | 'storage' | 'zones' | 'ports'
  | 'mail' | 'meet' | 'ai' | 'git' | 'admin' | 'summary' | 'apply' | 'file' | 'review'

/** 단계 목록에는 없으나 주소를 가진 화면 */
export type ExtraRoute = 'advanced' | 'done'
export type RouteId = StepId | ExtraRoute

export const ROUTES: RouteId[] = [
  'check', 'start', 'domain', 'proxy', 'cert', 'storage', 'zones', 'ports', 'mail', 'meet', 'ai', 'git',
  'admin', 'summary', 'apply', 'file', 'review', 'advanced', 'done',
]

/** 구역 id → 해당 구역 선택 시 거치는 단계 */
export const ZONE_STEPS: Record<string, StepId> = { mail: 'mail', meetings: 'meet', ai: 'ai', git: 'git' }
const ZONE_STEP_ORDER: StepId[] = ['mail', 'meet', 'ai', 'git']

export interface FlowInput {
  mode: Mode
  network: Network
  cert: CertMode
  /** 활성화할 구역 id(프리셋을 전개한 결과). 빠른 설치에서는 서버 메모리에 맞춘 프리셋의 구역 */
  zones: string[]
}

export interface FlowStep { id: StepId; skipped: boolean }

export function flow(input: FlowInput): FlowStep[] {
  const live = (id: StepId): FlowStep => ({ id, skipped: false })
  const skip = (id: StepId): FlowStep => ({ id, skipped: true })
  if (input.mode === 'restore') return (['check', 'start', 'file', 'review', 'apply'] as StepId[]).map(live)

  const quick = input.mode === 'quick'
  const stepsOn = new Set(input.zones.map(z => ZONE_STEPS[z]).filter(Boolean))
  const out: FlowStep[] = [live('check'), live('start'), live('domain')]
  if (input.network === 'proxy') out.push(live('proxy'))
  else if (input.cert === 'upload') out.push(live('cert'))
  out.push(quick ? skip('storage') : live('storage'), quick ? skip('zones') : live('zones'))
  if (input.network === 'router') out.push(live('ports'))
  for (const id of ZONE_STEP_ORDER) out.push(stepsOn.has(id) ? live(id) : skip(id))
  out.push(live('admin'), live('summary'), live('apply'))
  return out
}

/** 건너뛰지 않는 단계만 반환(순서 유지) */
export function liveSteps(steps: FlowStep[]): StepId[] {
  return steps.filter(s => !s.skipped).map(s => s.id)
}

export function isLive(steps: FlowStep[], id: StepId): boolean {
  return steps.some(s => s.id === id && !s.skipped)
}

/** 다음 단계. 마지막이거나 목록에 없으면 null */
export function nextStep(steps: FlowStep[], current: StepId): StepId | null {
  const live = liveSteps(steps)
  const i = live.indexOf(current)
  return i >= 0 && i < live.length - 1 ? live[i + 1] : null
}

/** 흐름상 직전 단계. 처음이거나 목록에 없으면 null */
export function prevStep(steps: FlowStep[], current: StepId): StepId | null {
  const live = liveSteps(steps)
  const i = live.indexOf(current)
  return i > 0 ? live[i - 1] : null
}

export type StepState = 'done' | 'current' | 'todo' | 'skipped'

/** 단계 목록에 표시할 상태 — current 가 목록에 없으면(잘못된 주소) 전부 남음 */
export function stepStates(steps: FlowStep[], current: StepId): Array<{ id: StepId; state: StepState }> {
  const live = liveSteps(steps)
  const ci = live.indexOf(current)
  return steps.map(s => {
    if (s.skipped) return { id: s.id, state: 'skipped' as const }
    const i = live.indexOf(s.id)
    return { id: s.id, state: i < ci ? 'done' as const : (i === ci ? 'current' as const : 'todo' as const) }
  })
}

/** 진행 위치(0~100) — 이어 하기 화면의 막대 */
export function progressOf(steps: FlowStep[], current: StepId): number {
  const live = liveSteps(steps)
  const i = live.indexOf(current)
  if (i < 0 || live.length === 0) return 0
  return Math.round((i / live.length) * 100)
}

/** 주소에 지정된 단계가 현재 흐름에 없을 때의 대체 이동 대상 — 그 이전에서 가장 가까운 유효 단계 */
export function nearestLive(steps: FlowStep[], wanted: StepId): StepId {
  const live = liveSteps(steps)
  if (live.includes(wanted)) return wanted
  const order = steps.map(s => s.id)
  const at = order.indexOf(wanted)
  if (at < 0) return live[0]
  for (let i = at - 1; i >= 0; i--) if (!steps[i].skipped) return steps[i].id
  return live[0]
}

/** 답변 오류의 항목 경로('access.cert') → 수정 대상 단계 */
export function stepForField(field: string): StepId {
  const head = field.split('.')[0]
  const second = field.split('.')[1] ?? ''
  if (head === 'access') {
    if (second === 'proxy_addresses') return 'proxy'
    return 'domain'
  }
  if (head === 'storage') return 'storage'
  if (head === 'zones' || head === 'addons' || head === 'preset') return 'zones'
  if (head === 'mail') return 'mail'
  if (head === 'meetings') return 'meet'
  if (head === 'ai') return 'ai'
  if (head === 'git') return 'git'
  if (head === 'admin') return 'admin'
  if (head === 'mode') return 'start'
  return 'summary'
}
