/**
 * 결과물 묶음 작업 — 실시간 진행 상태 싱글턴 + 완료 토스트.
 *
 * 서버가 작업을 진행하며 사용자 소켓으로 {type:"ai.artifact_job", job, finished} 를 송신한다(알림과 동일한 /ws/chat 채널).
 *  - 카드(AiArtifacts)는 jobsStore 의 최신 값을 렌더링한다(소켓 단절 시에는 카드가 직접 조회한다).
 *  - 종료되었으나(finished) 해당 작업의 카드가 화면에 없으면(다른 화면·다른 대화) 완료 토스트를 표시한다.
 *
 * 셸(DefaultLayout)에서 ensureAiArtifacts() 를 1회 호출한다. 토스트는 <AiArtifactToasts /> 가 렌더링한다.
 */
import { createStore, useStore } from 'zustand'
import { onChatEvent } from '~/composables/useChat'
import type { AiArtifactJob } from '~/utils/aiArtifacts'

export const AI_ARTIFACT_EVENT = 'ai.artifact_job'
/** 다른 화면에서 [대화로 가기] — AI 화면이 해당 대화를 연다(detail: conversation id) */
export const AI_OPEN_CONVERSATION_EVENT = 'jw:ai-open-conversation'
const TOAST_MS = 8000

export const aiJobsStore = createStore<{ jobs: Record<string, AiArtifactJob> }>()(() => ({ jobs: {} }))
export const aiArtifactToastStore = createStore<{ toasts: AiArtifactJob[] }>()(() => ({ toasts: [] }))

const _mounted = new Map<string, number>()
const _timers = new Map<string, ReturnType<typeof setTimeout>>()

/** 카드가 화면에 있는 동안 등록한다(해당 작업의 완료 토스트는 표시하지 않는다). 해제 함수를 반환한다 */
export function registerJobCard(id: string): () => void {
  _mounted.set(id, (_mounted.get(id) ?? 0) + 1)
  return () => {
    const n = (_mounted.get(id) ?? 1) - 1
    if (n <= 0) _mounted.delete(id)
    else _mounted.set(id, n)
  }
}

export function putJob(job: AiArtifactJob) {
  if (!job?.id) return
  aiJobsStore.setState(s => ({ jobs: { ...s.jobs, [job.id]: job } }))
}

export function dismissArtifactToast(id: string) {
  aiArtifactToastStore.setState(s => ({ toasts: s.toasts.filter(t => t.id !== id) }))
  const tm = _timers.get(id)
  if (tm) { clearTimeout(tm); _timers.delete(id) }
}

function showToast(job: AiArtifactJob) {
  aiArtifactToastStore.setState(s => ({ toasts: [...s.toasts.filter(t => t.id !== job.id), job].slice(-3) }))
  const old = _timers.get(job.id)
  if (old) clearTimeout(old)
  _timers.set(job.id, setTimeout(() => dismissArtifactToast(job.id), TOAST_MS))
}

/** 소켓 이벤트 처리(테스트에서도 직접 호출) */
export function handleArtifactEvent(data: any) {
  if (data?.type !== AI_ARTIFACT_EVENT || !data.job?.id) return
  const job = data.job as AiArtifactJob
  putJob(job)
  if (data.finished && job.status !== 'running' && !_mounted.has(job.id)) showToast(job)
}

let _unsub: (() => void) | null = null
export function ensureAiArtifacts() {
  if (_unsub) return
  _unsub = onChatEvent(handleArtifactEvent)
}

export function _resetAiArtifacts() {
  _unsub?.()
  _unsub = null
  _mounted.clear()
  for (const tm of _timers.values()) clearTimeout(tm)
  _timers.clear()
  aiJobsStore.setState({ jobs: {} })
  aiArtifactToastStore.setState({ toasts: [] })
}

export function useAiJob(id: string | undefined): AiArtifactJob | undefined {
  return useStore(aiJobsStore, s => (id ? s.jobs[id] : undefined))
}

export function useAiArtifactToasts(): AiArtifactJob[] {
  return useStore(aiArtifactToastStore, s => s.toasts)
}

/** 대화 열기 — AI 화면이면 현재 화면에서, 아니면 /ai?c= 로 이동 */
export function openAiConversation(id: string, navigate: (to: string) => unknown, onAiPage: boolean) {
  if (onAiPage && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AI_OPEN_CONVERSATION_EVENT, { detail: id }))
    return
  }
  void navigate(`/ai?c=${encodeURIComponent(id)}`)
}
