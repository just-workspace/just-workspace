/**
 * 내장 AI 답변 스트림 — 페이지 밖 전역 저장소(zustand).
 *
 * 서버는 답변 생성을 브라우저 연결과 분리하여 끝까지 수행한다(backend app/ai/runs.py). 화면은 해당 Redis Stream 을
 * 구독할 뿐이므로, 스트림 상태를 페이지 컴포넌트에 종속시키면 다른 화면으로 이동할 때 구독이 끊기고 복귀해도 재개되지 않았다.
 * 본 모듈이 상태를 보유하면 SPA 내 어느 화면으로 이동해도 수신이 유지된다.
 *
 * - startAiRun: POST(/chat·/regenerate·/continue·/messages/{id}/edit)를 열고 끝까지 수신한다. 이벤트마다 `id:`
 *   (Redis stream id)를 기록하여, 연결 단절 시 지수 백오프로 GET /api/ai/messages/{id}/stream?after= 에 재연결한다.
 * - resumeAiRun: 대화를 열었을 때 마지막 답변이 streaming 이면 처음부터(after=0) 이어서 수신한다 — 새로고침·다른 탭·다른 기기.
 * - stopAiRun: [멈춤]만 연결을 종료한다(+ stop API). 페이지를 벗어나도 종료하지 않는다.
 * - 종료 시점에 AI 화면(해당 대화)을 보고 있지 않으면 토스트 "AI 답변이 완료됐습니다 · [대화로 가기]" 를 표시한다.
 * - 이벤트 종류를 필터링하지 않는다 — 미지의 이벤트는 무시하고(lastId 는 갱신), 알려진 이벤트만 메시지에 반영한다.
 */
import { createStore, useStore } from 'zustand'
import { i18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { navigateTo } from '~/lib/router'
import { addToast, toast } from '~/composables/useToast'
import type { AiMsg } from '~/utils/aiAssist'
import { aiApplyCitation, aiApplyStep, aiParseSse } from '~/utils/aiAssist'
import type { ApprovalRequest } from '~/utils/approvals'
import type { AiQuestion } from '~/utils/aiAssist'

export type AiRunMsg = AiMsg & { _uid?: number; trimmed?: { dropped: number; window: number } }

export interface AiRun {
  /** 로컬 키 */
  key: string
  convId: string
  /** 서버 답변 id(meta 수신 이후) */
  msgId?: string
  msg: AiRunMsg
  /** 마지막으로 수신한 Redis stream id — 재연결 시 after 값 */
  lastId: string
  active: boolean
}

interface State {
  runs: Record<string, AiRun>
  /** AI 화면이 마운트되어 있고 표시 중인 대화(없으면 null) — 완료 토스트 판단용 */
  view: { mounted: boolean; convId: string | null }
  /** 토스트 [대화로 가기] — AI 화면이 열리면 해당 대화를 연다 */
  pendingOpen: string | null
}

export const aiStreamStore = createStore<State>()(() => ({
  runs: {},
  view: { mounted: false, convId: null },
  pendingOpen: null,
}))

/** 재연결 지연(ms) — 1·2·4·8·16·30·30… (테스트에서 축소할 수 있도록 객체로 둠) */
export const aiReconnect = { base: 1000, max: 30_000, tries: 10 }
export function aiBackoff(attempt: number): number {
  return Math.min(aiReconnect.max, aiReconnect.base * 2 ** Math.max(0, attempt))
}

let keySeq = 0
let uidSeq = 100_000
const ctls = new Map<string, AbortController>()
const stopped = new Set<string>()

function setRun(key: string, patch: Partial<AiRun>) {
  const cur = aiStreamStore.getState().runs[key]
  if (!cur) return
  aiStreamStore.setState(s => ({ runs: { ...s.runs, [key]: { ...cur, ...patch } } }))
}
function dropRun(key: string) {
  aiStreamStore.setState((s) => {
    const { [key]: _gone, ...rest } = s.runs
    return { runs: rest }
  })
  ctls.delete(key)
  stopped.delete(key)
}

/** 메시지에 반영할 이벤트 하나 — 새 메시지 객체를 반환한다. 미지의 이벤트는 그대로 둔다. */
export function aiApplyEvent(prev: AiRunMsg, ev: string, payload: any): { msg: AiRunMsg; parentId?: string; fallback?: boolean } {
  const msg: AiRunMsg = { ...prev, tools: prev.tools ? prev.tools.map(x => ({ ...x })) : [], writes: prev.writes ? [...prev.writes] : prev.writes, memories: prev.memories ? [...prev.memories] : prev.memories }
  let parentId: string | undefined
  let fallback = false
  if (ev === 'token') msg.content = (msg.content || '') + (payload.text || '')
  // 답변 메타(저장될 메시지 id·모델·AI 생성 표시)
  else if (ev === 'meta') {
    if (payload.message_id) msg.id = payload.message_id
    if (payload.parent_id) parentId = payload.parent_id
    if (payload.model) msg.model = payload.model
    msg.ai_generated = payload.ai_generated !== false
  }
  // 진행 단계 — 같은 id 가 running → done/failed
  else if (ev === 'step' && payload?.id) msg.steps = aiApplyStep(msg.steps, payload)
  else if (ev === 'citation' && payload?.n) msg.citations = aiApplyCitation(msg.citations, payload)
  // 메모리에 저장함 [취소]
  else if (ev === 'memory_saved' && payload?.id) msg.memories = [...(msg.memories ?? []), { id: payload.id, kind: payload.kind, text: payload.text }]
  // 이어 받기: 서버에 저장된 수신분(화면보다 많을 수 있다)
  else if (ev === 'partial') msg.content = payload.text || ''
  // 생성된 결과물(문서·묶음) → 결과물 카드
  else if (ev === 'artifact' && (payload?.artifact?.id || payload?.job?.id)) msg.artifacts = [...((msg as any).artifacts ?? []), payload]
  // 모델 창 초과로 앞부분을 이번 답변에서 제외함(화면이 대화 최상단에 안내)
  else if (ev === 'context_trimmed' && payload?.dropped) msg.trimmed = { dropped: Number(payload.dropped) || 0, window: Number(payload.window) || 0 }
  // 제공자가 이어 쓰기를 수용하지 못함 → 처음부터 재생성
  else if (ev === 'continue_fallback') {
    msg.content = ''; msg.steps = []; msg.citations = []; msg.started_at = new Date().toISOString()
    fallback = true
  }
  else if (ev === 'done') {
    msg.status = payload.status === 'interrupted' ? 'interrupted' : payload.status === 'stopped' ? 'stopped' : 'complete'
    if (msg.status === 'stopped') msg.stopped = true
    msg.ended_at = new Date().toISOString()
    // 스트림 만료로 서버가 DB 최종본을 함께 송신함
    const fin = payload.final
    if (fin && typeof fin === 'object') {
      msg.content = fin.content ?? msg.content
      if (Array.isArray(fin.steps)) msg.steps = fin.steps
      if (Array.isArray(fin.citations)) msg.citations = fin.citations
      if (fin.model) msg.model = fin.model
      if (fin.ended_at) msg.ended_at = fin.ended_at
    }
    if (payload.message_id === null && !msg.content) msg.id = undefined
    msg.streaming = false
  }
  else if (ev === 'tool_call') {
    if (!msg.tools!.some(x => x.name === payload.name)) msg.tools!.push({ name: payload.name })
  }
  // 도구 성공·실패 표시
  else if (ev === 'tool_result') {
    const x = msg.tools!.find(y => y.name === payload.name)
    if (x) x.ok = !!payload.ok
    else msg.tools!.push({ name: payload.name, ok: !!payload.ok })
  }
  // 쓰기 도구 — 실행하지 않고 승인 요청을 수신함
  else if (ev === 'write_request' && payload?.id) {
    const list = msg.writes ?? (msg.writes = [])
    const at = list.findIndex(w => w.id === payload.id)
    // 재연결로 이전 이벤트가 재수신되어도 이미 처리된 카드를 '대기'로 되돌리지 않는다
    if (at >= 0) { if (!(list[at].status !== 'pending' && payload.status === 'pending')) list[at] = payload as ApprovalRequest }
    else list.push(payload as ApprovalRequest)
  }
  // ask_user · plan_exit 질문 카드 — 동일 id 는 덮어쓰되, 이미 답변한 카드를 재생된 '대기'로 되돌리지 않는다
  else if (ev === 'question' && payload?.id) {
    const list = [...(msg.questions ?? [])]
    const at = list.findIndex(q => q.id === payload.id)
    if (at >= 0) { if (!(list[at].status !== 'pending' && payload.status === 'pending')) list[at] = payload as AiQuestion }
    else list.push(payload as AiQuestion)
    msg.questions = list
  }
  else if (ev === 'error') {
    msg.error = payload.message || i18n.t('ai.errors.generic')
    if (payload.partial_saved) msg.status = 'interrupted'
  }
  else return { msg: prev }
  return { msg, parentId, fallback }
}

export interface StartAiRunOpts {
  convId: string
  url: string
  body: any | null
  msg: AiRunMsg
  /** 방금 전송한 질문에 서버 id 를 부여한다(meta.parent_id) */
  onParentId?: (id: string) => void
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** 연결 1회를 읽는다. 종료 사유: done | ended(done 없이 닫힘) | aborted | error */
async function readOnce(key: string, res: Response, onParentId?: (id: string) => void): Promise<'done' | 'ended'> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let gotDone = false
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const { events, rest } = aiParseSse(buf)
    buf = rest
    for (const e of events) {
      const run = aiStreamStore.getState().runs[key]
      if (!run) {
        // 화면이 이 실행을 이미 제거했더라도, 멈춤을 누른 실행이면 답변 id 수신 즉시 서버에 전달한다(전달하지 않으면 끝까지 생성한다)
        if (stopped.has(key) && e.event === 'meta' && e.data?.message_id) { sendStop(e.data.message_id); ctls.get(key)?.abort() }
        return 'done'
      }
      if (stopped.has(key)) {
        // 답변 id(meta) 수신 전에 멈춤을 누른 경우 — 서버에 멈춤을 전달할 id 가 없어 연결을 유지한 채 대기했다.
        // id 수신 즉시 멈춤을 송신하고 연결을 종료한다. 그 사이 수신한 조각은 화면에 반영하지 않는다.
        const id = run.msgId || (e.event === 'meta' ? e.data?.message_id : undefined)
        if (!id) continue
        sendStop(id)
        ctls.get(key)?.abort()
        return 'done'
      }
      const patch: Partial<AiRun> = {}
      if (e.id) patch.lastId = e.id
      const r = aiApplyEvent(run.msg, e.event, e.data)
      if (r.msg !== run.msg) patch.msg = r.msg
      if (r.msg.id && !run.msgId) patch.msgId = r.msg.id
      if (r.parentId) onParentId?.(r.parentId)
      if (r.fallback) addToast('info', i18n.t('ai.message.continueFallback'))
      if (e.event === 'done') gotDone = true
      if (Object.keys(patch).length) setRun(key, patch)
    }
  }
  return gotDone ? 'done' : 'ended'
}

function finish(key: string, status: number) {
  const run = aiStreamStore.getState().runs[key]
  if (!run) return status
  const msg = { ...run.msg, streaming: false }
  setRun(key, { msg, active: false })
  const v = aiStreamStore.getState().view
  const watching = v.mounted && v.convId === run.convId
  if (!watching && !stopped.has(key) && msg.status !== 'stopped' && msg.status !== 'interrupted' && !msg.error && status !== 0 && status < 400) {
    const convId = run.convId
    toast({
      type: 'success',
      title: i18n.t('ai.run.doneToast'),
      action: { label: i18n.t('ai.run.goto'), onClick: () => openAiConversation(convId) },
    })
  }
  dropRun(key)
  return status
}

/** 연결 단절 후(또는 대화를 열어) 이어서 수신 — after = 마지막으로 수신한 id(최초이면 0 = 처음부터 재생) */
async function followLoop(key: string, immediate: boolean): Promise<number> {
  for (let attempt = 0; attempt < aiReconnect.tries; attempt++) {
    if (stopped.has(key) || !aiStreamStore.getState().runs[key]) return 0
    if (!(immediate && attempt === 0)) await sleep(aiBackoff(immediate ? attempt - 1 : attempt))
    if (stopped.has(key) || !aiStreamStore.getState().runs[key]) return 0
    const cur = aiStreamStore.getState().runs[key]!
    const ctl = new AbortController()
    ctls.set(key, ctl)
    try {
      const res = await fetch(`/api/ai/messages/${encodeURIComponent(cur.msgId!)}/stream?after=${encodeURIComponent(cur.lastId)}`, {
        method: 'GET', credentials: 'include', signal: ctl.signal, headers: { Accept: 'text/event-stream' },
      })
      if (res.status === 404) {
        setRun(key, { msg: { ...cur.msg, error: i18n.t('ai.run.lost'), status: cur.msg.content ? 'interrupted' : undefined } })
        return 404
      }
      if (!res.ok || !res.body) continue
      // 처음부터 재생 — 저장된 진행분은 재생(meta·partial·token…)으로 다시 채워진다
      if (cur.lastId === '0') setRun(key, { msg: { ...cur.msg, content: '', steps: [], citations: [], tools: [] } })
      const why = await readOnce(key, res)
      if (why === 'done') return 200
      attempt = -1 // 수신 중 단절 — 최초 간격부터 재시작
      immediate = false
    } catch (e: any) {
      if (e?.name === 'AbortError' || stopped.has(key)) return 0
    }
  }
  const run = aiStreamStore.getState().runs[key]
  if (run) setRun(key, { msg: { ...run.msg, error: i18n.t('ai.run.lost'), status: run.msg.content ? 'interrupted' : undefined } })
  return 0
}

/** 답변 수신 시작 — 종료(완료·멈춤·실패) 시점까지 대기하는 Promise(HTTP 상태, 단절·멈춤은 0) */
export async function startAiRun(opts: StartAiRunOpts): Promise<number> {
  const key = `r${++keySeq}`
  const ctl = new AbortController()
  ctls.set(key, ctl)
  aiStreamStore.setState(s => ({ runs: { ...s.runs, [key]: { key, convId: opts.convId, msg: { ...opts.msg, streaming: true }, lastId: '0', active: true } } }))
  let status = 0
  try {
    const res = await fetch(opts.url, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined, signal: ctl.signal,
    })
    status = res.status
    if (!res.ok || !res.body) {
      let detail = `HTTP ${res.status}`
      try { detail = (await res.json())?.detail || detail } catch { /* 본문 없음 */ }
      const run = aiStreamStore.getState().runs[key]
      if (run) setRun(key, { msg: { ...run.msg, error: detail, streaming: false } })
      return finish(key, res.status)
    }
    const why = await readOnce(key, res, opts.onParentId)
    if (why === 'ended' && aiStreamStore.getState().runs[key]?.msgId && !stopped.has(key)) {
      const code = await followLoop(key, false)
      if (code !== 200) status = code
    }
    return finish(key, status)
  } catch (e: any) {
    if (e?.name === 'AbortError' || stopped.has(key)) return finish(key, 0)
    const run = aiStreamStore.getState().runs[key]
    if (run?.msgId) {
      // 네트워크 단절 — 서버는 생성을 계속한다. 마지막 수신 위치부터 재연결한다
      const code = await followLoop(key, false)
      return finish(key, code === 200 ? status : code)
    }
    if (run) {
      const msg: AiRunMsg = { ...run.msg, error: e?.message || String(e), ended_at: new Date().toISOString() }
      if (msg.content) msg.status = 'interrupted'
      setRun(key, { msg })
    }
    return finish(key, 0)
  }
}

/** 대화를 열었을 때 마지막 답변이 생성 중인 경우 — 이어서 수신한다(이미 수신 중이면 해당 run). 화면에 표시할 메시지를 반환한다. */
export function resumeAiRun(convId: string, msg: AiRunMsg): AiRunMsg {
  const existing = Object.values(aiStreamStore.getState().runs).find(r => r.msgId === msg.id)
  if (existing) return existing.msg
  const key = `r${++keySeq}`
  // 첫 이벤트 수신 전까지는 저장된 진행분을 표시한다
  const start: AiRunMsg = { ...msg, streaming: true, status: undefined, _uid: msg._uid ?? ++uidSeq }
  aiStreamStore.setState(s => ({ runs: { ...s.runs, [key]: { key, convId, msgId: msg.id, msg: start, lastId: '0', active: true } } }))
  void followLoop(key, true).then(code => finish(key, code))
  return start
}

function sendStop(msgId: string) {
  void $fetch(`/api/ai/messages/${encodeURIComponent(msgId)}/stop`, { method: 'POST', credentials: 'include' }).catch(() => {})
}

/**
 * [멈춤] — 연결을 종료하고 서버에 멈춤을 기록한다(서버 작업도 중지된다).
 * 서버 생성은 연결과 분리되어 수행되므로, 연결만 종료하면 끝까지 생성한다. 전송 직후(답변 id 수신 전) 멈추면 멈춤을 전달할
 * id 가 없으므로 연결을 유지한 채 화면만 멈춤으로 전환하고, 첫 이벤트(meta)에서 id 를 수신하는 즉시 멈춤을 송신한다(readOnce).
 */
export function stopAiRun(key: string) {
  const run = aiStreamStore.getState().runs[key]
  stopped.add(key)
  if (!run) { ctls.get(key)?.abort(); return }
  // active 를 해제하여 입력창을 즉시 활성화한다(멈춤이 아직 전달되지 않은 동안의 새 질문은 서버가 409 로 거부한다)
  setRun(key, { active: false, msg: { ...run.msg, stopped: true, status: 'stopped', streaming: false, ended_at: new Date().toISOString() } })
  if (!run.msgId) return
  ctls.get(key)?.abort()
  sendStop(run.msgId)
}

/** 이 대화에서 수신 중인 run */
export function aiActiveRunFor(convId: string | null | undefined): AiRun | undefined {
  if (!convId) return undefined
  return Object.values(aiStreamStore.getState().runs).find(r => r.active && r.convId === convId)
}

/** 화면 메시지 목록에 run 의 최신 메시지를 덮어쓴다(_uid 또는 서버 id 로 탐색) */
export function aiMergeRuns<T extends AiRunMsg>(list: T[], runs: Record<string, AiRun>): T[] {
  const all = Object.values(runs)
  if (!all.length) return list
  let changed = false
  const next = list.map((m) => {
    if (m.role !== 'assistant') return m
    const r = all.find(x => (m._uid != null && x.msg._uid === m._uid) || (!!m.id && x.msgId === m.id))
    if (!r || r.msg === (m as AiRunMsg)) return m
    changed = true
    return { ...r.msg, writes: keepDecided(r.msg.writes, m.writes), questions: keepDecided(r.msg.questions, m.questions), _uid: m._uid ?? r.msg._uid } as T
  })
  return changed ? next : list
}

/** run 사본의 카드가 아직 '대기'인데 화면 측은 이미 처리된 경우 화면 측 값을 사용한다(실행한 카드가 다시 나타나는 것 방지) */
function keepDecided<X extends { id: string; status: string }>(runW?: X[], listW?: X[]): X[] | undefined {
  if (!runW || !listW?.length) return runW
  const seen = new Map(listW.map(w => [w.id, w] as const))
  return runW.map((w) => {
    const o = seen.get(w.id)
    return o && w.status === 'pending' && o.status !== 'pending' ? o : w
  })
}

/** 질문 카드에 답변하면 수신 중인 run 사본에도 반영한다 */
export function aiPatchRunQuestion(q: AiQuestion) {
  const runs = aiStreamStore.getState().runs
  let hit = false
  const next: Record<string, AiRun> = {}
  for (const [k, r] of Object.entries(runs)) {
    if (r.msg.questions?.some(x => x.id === q.id)) {
      hit = true
      next[k] = { ...r, msg: { ...r.msg, questions: r.msg.questions.map(x => (x.id === q.id ? q : x)) } }
    } else next[k] = r
  }
  if (hit) aiStreamStore.setState({ runs: next })
}

/** 승인 카드 변경 시(실행·취소·수정) 수신 중인 run 사본에도 반영한다 — 다음 토큰에서 이전 상태로 덮이는 것 방지 */
export function aiPatchRunWrite(req: ApprovalRequest) {
  const runs = aiStreamStore.getState().runs
  let hit = false
  const next: Record<string, AiRun> = {}
  for (const [k, r] of Object.entries(runs)) {
    if (r.msg.writes?.some(w => w.id === req.id)) {
      hit = true
      next[k] = { ...r, msg: { ...r.msg, writes: r.msg.writes.map(w => (w.id === req.id ? req : w)) } }
    } else next[k] = r
  }
  if (hit) aiStreamStore.setState({ runs: next })
}

/** AI 화면 마운트 여부/표시 중인 대화 */
export function setAiView(mounted: boolean, convId: string | null) {
  const v = aiStreamStore.getState().view
  if (v.mounted === mounted && v.convId === convId) return
  aiStreamStore.setState({ view: { mounted, convId } })
}

/** [대화로 가기] — AI 화면으로 이동하여 해당 대화를 연다 */
export function openAiConversation(convId: string) {
  aiStreamStore.setState({ pendingOpen: convId })
  if (!aiStreamStore.getState().view.mounted) void navigateTo('/ai')
}

export function takeAiPendingOpen(): string | null {
  const id = aiStreamStore.getState().pendingOpen
  if (id) aiStreamStore.setState({ pendingOpen: null })
  return id
}

/** 레일·상단 표시 — 답변 생성 중인 run 존재 여부 */
export function useAiGenerating(): boolean {
  return useStore(aiStreamStore, s => Object.values(s.runs).some(r => r.active))
}

export function useAiRuns() {
  return useStore(aiStreamStore, s => s.runs)
}

/** 테스트용 */
export function resetAiStreams() {
  for (const c of ctls.values()) c.abort()
  ctls.clear()
  stopped.clear()
  aiStreamStore.setState({ runs: {}, view: { mounted: false, convId: null }, pendingOpen: null })
}
