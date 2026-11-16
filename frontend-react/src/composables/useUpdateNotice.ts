/**
 * 업데이트 사전 공지(5분 카운트다운)와 점검 모드 — 앱 셸이 공유하는 싱글턴.
 *
 * 상태가 유입되는 경로는 세 가지이다.
 *  1. 실시간 소켓: `system.update_countdown` · `system.update_cancelled` · `system.maintenance`.
 *  2. 최초 마운트 시 `/api/system/update-notice` 1회 조회(새로 접속한 화면).
 *  3. API 호출 실패 시(lib/api 가 통지) 공개 점검 상태 `/maintenance/status` 조회 — 서버가 중지된 상태에서도 응답한다.
 *
 * 점검 중에는 5초마다 재조회한다. 점검이 종료되고 서버가 응답하면 화면을 다시 로드한다(새 버전의 화면 수신).
 * 계약: docs/update-api.md 7·8절
 *
 * React: useUpdateNoticeWatch(로그인했는가);  const { state, endsAt, … } = useUpdateNotice()
 */
import { useEffect } from 'react'
import { createStore, useStore } from 'zustand'
import { $fetch, API_DOWN_EVENT } from '~/lib/api'
import { apiUrl } from '~/lib/runtimeConfig'

export type NoticeState = 'none' | 'countdown' | 'maintenance'
export interface UpdateNoticeState {
  state: NoticeState
  job: string | null
  kind: string | null
  /** 카운트다운 종료 시각(ms) */
  endsAt: number | null
  /** 점검 시작 시각(ms) */
  startedAt: number | null
  expectedSeconds: number | null
  contact: string | null
  /** 점검 종료 후 서버 응답을 대기하는 중 */
  reconnecting: boolean
}

const EMPTY: UpdateNoticeState = { state: 'none', job: null, kind: null, endsAt: null, startedAt: null, expectedSeconds: null, contact: null, reconnecting: false }
export const updateNoticeStore = createStore<UpdateNoticeState>()(() => ({ ...EMPTY }))

export const updateNoticeTiming = { pollMs: 5000, checkGapMs: 5000 }
/** 화면 다시 로드 동작 — 테스트에서 교체한다 */
export const updateNoticeEnv = { reload: () => { if (typeof location !== 'undefined') location.reload() } }

const PUBLIC_STATUS = '/maintenance/status'

let watchers = 0
let timer: ReturnType<typeof setTimeout> | null = null
let listening = false
let unsubscribe: (() => void) | null = null
let lastCheck = 0
let confirmed = false      // 서버가 점검 중이라고 응답한 이력이 있음(카운트다운 종료에 따른 추정이 아님)
let ticking = false

const ms = (iso: unknown): number | null => {
  if (typeof iso !== 'string' || !iso) return null
  const v = Date.parse(iso)
  return Number.isNaN(v) ? null : v
}
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

interface PublicStatus { active?: boolean; phase?: string; kind?: string | null; started_at?: string | null; expected_seconds?: number | null; countdown_ends_at?: string | null; contact?: string | null }

/** 공개 점검 상태 — 서버가 중지된 상태에서도 nginx 가 설치 관리자로부터 받아 전달한다. 조회 불가 시 null */
async function publicStatus(): Promise<PublicStatus | null> {
  try {
    const r = await fetch(apiUrl(PUBLIC_STATUS), { cache: 'no-store', credentials: 'omit' })
    if (!r.ok) return null
    const data = await r.json()
    return data && typeof data === 'object' && typeof data.active === 'boolean' ? data : null
  } catch { return null }
}

async function serverUp(): Promise<boolean> {
  try {
    const r = await fetch(apiUrl('/api/health'), { cache: 'no-store', credentials: 'omit' })
    return r.ok
  } catch { return false }
}

function stopTimer() { if (timer) { clearTimeout(timer); timer = null } }
function schedule() {
  stopTimer()
  const s = updateNoticeStore.getState()
  if (!watchers || s.state === 'none') return
  // 카운트다운은 종료 시점에 1회, 점검은 5초마다 조회
  const wait = s.state === 'countdown' && s.endsAt ? Math.max(250, s.endsAt - Date.now()) : updateNoticeTiming.pollMs
  timer = setTimeout(() => { void tick() }, Math.min(wait, 2 ** 31 - 1))
}

function enterMaintenance(p: { kind?: string | null; startedAt?: number | null; expectedSeconds?: number | null; contact?: string | null }, sure: boolean) {
  const s = updateNoticeStore.getState()
  if (sure) confirmed = true
  updateNoticeStore.setState({
    state: 'maintenance', endsAt: null, reconnecting: false,
    kind: p.kind ?? s.kind,
    startedAt: p.startedAt ?? s.startedAt ?? s.endsAt ?? Date.now(),
    expectedSeconds: p.expectedSeconds ?? s.expectedSeconds,
    contact: p.contact !== undefined ? p.contact : s.contact,
  })
  schedule()
}

function clear() {
  confirmed = false
  updateNoticeStore.setState({ ...EMPTY, contact: updateNoticeStore.getState().contact })
  stopTimer()
}

/** 점검 종료 — 서버가 응답하면 화면을 다시 로드한다. 미응답이면 "다시 연결 중" 상태로 두고 조회를 계속한다 */
async function finish() {
  if (!confirmed) { clear(); return }      // 점검에 진입한 이력이 없음(취소 이벤트 누락) — 기존 화면 유지
  if (await serverUp()) { clear(); updateNoticeEnv.reload(); return }
  updateNoticeStore.setState({ reconnecting: true })
  schedule()
}

/** 현재 상태를 재조회한다 — 공개 점검 상태를 우선 조회하고, 조회 불가 시 서버의 사전 공지를 조회한다 */
export async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const s = updateNoticeStore.getState()
    if (s.state === 'countdown' && s.endsAt && Date.now() < s.endsAt) { schedule(); return }
    const live = await publicStatus()
    if (live) {
      if (live.active) enterMaintenance({ kind: live.kind, startedAt: ms(live.started_at), expectedSeconds: num(live.expected_seconds), contact: live.contact ?? null }, true)
      else if (live.phase === 'countdown' && ms(live.countdown_ends_at)) {
        updateNoticeStore.setState({ state: 'countdown', endsAt: ms(live.countdown_ends_at), kind: live.kind ?? s.kind, expectedSeconds: num(live.expected_seconds) ?? s.expectedSeconds })
        schedule()
      } else if (s.state !== 'none') await finish()
      return
    }
    try {
      const r = await $fetch<NoticeReply>('/api/system/update-notice')
      if (r?.state !== 'countdown' && r?.state !== 'maintenance' && s.state !== 'none') await finish()
      else applyNotice(r)
    } catch {
      // 모든 경로에서 조회 불가 — 카운트다운이 종료되었으면 점검이 시작된 것으로 간주한다
      if (s.state === 'countdown') enterMaintenance({}, false)
      else schedule()
    }
  } finally { ticking = false }
}

interface NoticeReply { state?: string; job?: string | null; kind?: string | null; ends_at?: string | null; started_at?: string | null; expected_seconds?: number | null; contact?: string | null }

function applyNotice(r: NoticeReply | null | undefined) {
  const contact = typeof r?.contact === 'string' && r.contact ? r.contact : null
  if (r?.state === 'countdown' && ms(r.ends_at)) {
    updateNoticeStore.setState({ ...EMPTY, state: 'countdown', job: r.job ?? null, kind: r.kind ?? null, endsAt: ms(r.ends_at), expectedSeconds: num(r.expected_seconds), contact })
    schedule()
  } else if (r?.state === 'maintenance') {
    updateNoticeStore.setState({ job: r.job ?? null, contact })
    enterMaintenance({ kind: r.kind, startedAt: ms(r.started_at), expectedSeconds: num(r.expected_seconds), contact }, true)
  } else {
    confirmed = false
    updateNoticeStore.setState({ ...EMPTY, contact })
    stopTimer()
  }
}

/** 최초 1회 — 새로 접속한 화면이 현재의 사전 공지·점검 상태를 확인한다 */
export async function loadUpdateNotice(): Promise<void> {
  try { applyNotice(await $fetch('/api/system/update-notice')) } catch { /* 서버 미응답 시 API 실패 신호가 처리한다 */ }
}

/** 실시간 소켓 이벤트 — 테스트에서도 직접 호출한다 */
export function handleUpdateEvent(d: any): void {
  if (!d || typeof d.type !== 'string') return
  if (d.type === 'system.update_countdown') {
    const endsAt = ms(d.ends_at)
    if (!endsAt) return
    updateNoticeStore.setState({ ...EMPTY, state: 'countdown', job: d.job ?? null, kind: d.kind ?? null, endsAt, expectedSeconds: num(d.expected_seconds), contact: updateNoticeStore.getState().contact })
    schedule()
  } else if (d.type === 'system.update_cancelled') {
    if (updateNoticeStore.getState().state === 'countdown') clear()
  } else if (d.type === 'system.maintenance') {
    if (d.active) enterMaintenance({ kind: d.kind, startedAt: ms(d.started_at), expectedSeconds: num(d.expected_seconds) }, true)
    else if (updateNoticeStore.getState().state !== 'none') { confirmed = true; void finish() }
  }
}

function onApiDown() {
  const now = Date.now()
  if (!watchers || now - lastCheck < updateNoticeTiming.checkGapMs) return
  lastCheck = now
  if (updateNoticeStore.getState().state === 'maintenance') return
  void (async () => {
    const live = await publicStatus()
    if (live?.active) enterMaintenance({ kind: live.kind, startedAt: ms(live.started_at), expectedSeconds: num(live.expected_seconds), contact: live.contact ?? null }, true)
  })()
}

/** "지금 다시 연결" */
export async function reconnectNow(): Promise<void> {
  stopTimer()
  await tick()
}

/** 본 컴포넌트가 마운트된 동안 사전 공지·점검을 감시한다 */
export function useUpdateNoticeWatch(enabled = true) {
  useEffect(() => {
    if (!enabled) return
    watchers += 1
    if (!listening && typeof window !== 'undefined') {
      listening = true
      window.addEventListener(API_DOWN_EVENT, onApiDown)
    }
    if (watchers === 1) {
      void loadUpdateNotice()
      void import('~/composables/useChat').then((m) => { if (watchers && !unsubscribe) unsubscribe = m.onChatEvent(handleUpdateEvent) }).catch(() => {})
    }
    return () => {
      watchers -= 1
      if (!watchers) { stopTimer(); unsubscribe?.(); unsubscribe = null }
    }
  }, [enabled])
}

export function useUpdateNotice() {
  return useStore(updateNoticeStore)
}

// ─── 점검 화면 표시 제외 화면 ───
// 관리자의 업데이트 진행 화면은 점검 중에도 표시되어야 한다 — 해당 화면이 마운트된 동안에는 점검 화면을 렌더링하지 않는다.
const exemptStore = createStore<{ count: number }>()(() => ({ count: 0 }))
export function useMaintenanceExempt(enabled = true) {
  useEffect(() => {
    if (!enabled) return
    exemptStore.setState(s => ({ count: s.count + 1 }))
    return () => { exemptStore.setState(s => ({ count: Math.max(0, s.count - 1) })) }
  }, [enabled])
}
export function useMaintenanceExempted(): boolean {
  return useStore(exemptStore, s => s.count > 0)
}

/** 테스트용 — 싱글턴을 초기 상태로 복원 */
export function _resetUpdateNotice() {
  stopTimer()
  unsubscribe?.(); unsubscribe = null
  watchers = 0; lastCheck = 0; confirmed = false; ticking = false
  updateNoticeStore.setState({ ...EMPTY })
  exemptStore.setState({ count: 0 })
}
