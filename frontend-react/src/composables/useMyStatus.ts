/**
 * 내 상태(사용자 메뉴 S1 · 11-B3) — 상단바 아바타 점·사용자 메뉴·Ctrl+K 명령이 같은 값을 본다.
 * Vue 판 composables/useMyStatus.ts 그대로.
 *
 * 기준은 서버(GET/PUT /api/chat/me/status — useChat 이 앱 시작 때 받아 둔다).
 *  - 상태 3칸: 온라인(auto) · 자리 비움(away) · 방해 금지(dnd)
 *  - 오프라인으로 표시: mode=invisible(남에게 offline)
 *  - 방해 금지 시간: dnd_until(지금부터 N분). 반복 일정은 설정 › 알림(dnd-schedule)
 *  - 상태 메시지: custom_text/emoji/expires_at
 * 채팅 모듈이 꺼져 있거나 아직 못 받았으면 예전처럼 기기 저장(useUserPrefs)으로 동작한다.
 *
 * React: const { server, presence, dot, invisible, dndUntil, message, setPresence, ... } = useMyStatus()  (값은 .value 없이)
 * 컴포넌트 밖: myStatusSnapshot() 으로 같은 계산 값, set* 함수는 그대로 import
 */
import { createStore, useStore } from 'zustand'
import { platformStore, isModuleEnabled, moduleEnabledIn } from '~/composables/usePlatform'
import { chatStore, updateMyStatus } from '~/composables/useChat'
import { ensureUserPrefs, userPrefsStore, setPresence as setPrefsPresence, setStatusMessage as setPrefsStatusMessage, useUserPrefs } from '~/composables/useUserPrefs'
import type { Presence } from '~/composables/useUserPrefs'
import type { MyStatus } from '~/lib/chatEvents'
import { menuPresence } from '~/utils/myStatus'

// 만료(상태 메시지·방해 금지 기한)를 화면에서 넘기도록 30초마다 갱신하는 공용 시계
const statusClockStore = createStore<{ now: number }>()(() => ({ now: Date.now() }))
let nowTimer: ReturnType<typeof setInterval> | null = null
function statusClock() {
  if (!nowTimer) nowTimer = setInterval(() => { statusClockStore.setState({ now: Date.now() }) }, 30_000)
}

export interface MyStatusMessage { text: string; emoji: string | null; expiresAt: Date | null }

export interface MyStatusView {
  server: boolean
  presence: Presence | null
  dot: string
  invisible: boolean
  dndUntil: Date | null
  message: MyStatusMessage
}

/** Vue 판 computed 들을 한 번에 — 입력(채팅 모듈 켜짐·내 상태·기기 설정·시계)이 같으면 같은 결과 */
function computeView(chatEnabled: boolean, myStatus: MyStatus | null, prefsPresence: Presence, prefsMessage: string, now: number): MyStatusView {
  const server = chatEnabled && !!myStatus
  const invisible = server && myStatus!.mode === 'invisible'
  /** dnd_until 이 미래면 그 시각 */
  let dndUntil: Date | null = null
  const u = server ? myStatus!.dnd_until : null
  if (u) {
    const d = new Date(u)
    dndUntil = d.getTime() > now ? d : null
  }
  /** 상태 3칸에서 고른 값. 오프라인 표시 중이면 null(아무 칸도 안 켜짐) */
  const presence: Presence | null = !server ? prefsPresence : menuPresence(myStatus!, now)
  /** 아바타 점 — 오프라인 표시 중이면 offline */
  const dot = presence ?? 'offline'
  let message: MyStatusMessage
  if (!server) {
    message = { text: prefsMessage, emoji: null, expiresAt: null }
  } else {
    const s = myStatus!
    const exp = s.custom_expires_at ? new Date(s.custom_expires_at) : null
    message = exp && exp.getTime() <= now
      ? { text: '', emoji: null, expiresAt: null }
      : { text: s.custom_text || '', emoji: s.custom_emoji || null, expiresAt: exp }
  }
  return { server, presence, dot, invisible, dndUntil, message }
}

const chatEnabledNow = () => isModuleEnabled('chat')

/** 컴포넌트 밖에서 지금 값 */
export function myStatusSnapshot(): MyStatusView {
  ensureUserPrefs()
  const p = userPrefsStore.getState().prefs
  return computeView(chatEnabledNow(), chatStore.getState().myStatus, p.presence, p.statusMessage, Date.now())
}

const isServer = () => chatEnabledNow() && !!chatStore.getState().myStatus
const myStatusNow = () => chatStore.getState().myStatus!

export async function setPresence(p: Presence) {
  ensureUserPrefs()
  if (!isServer()) { setPrefsPresence(p); return }
  // 칸을 바꾸면 기한 있는 방해 금지·오프라인 표시도 같이 풀린다
  await updateMyStatus({ mode: p === 'online' ? 'auto' : p, dnd_until: null })
  setPrefsPresence(p)
}

export async function setInvisible(on: boolean) {
  if (!isServer()) return
  await updateMyStatus({ mode: on ? 'invisible' : 'auto' })
}

/** 지금부터 minutes 분 방해 금지. null 이면 끈다 */
export async function setDndFor(minutes: number | null) {
  ensureUserPrefs()
  if (!isServer()) { setPrefsPresence(minutes === null ? 'online' : 'dnd'); return }
  if (minutes === null) {
    await updateMyStatus({ mode: myStatusNow().mode === 'dnd' ? 'auto' : myStatusNow().mode, dnd_until: null })
    return
  }
  const until = new Date(Date.now() + minutes * 60_000).toISOString()
  await updateMyStatus({ dnd_until: until, ...(myStatusNow().mode === 'invisible' ? {} : { mode: 'dnd' }) })
}

export async function setMessage(text: string) {
  ensureUserPrefs()
  if (!isServer()) { setPrefsStatusMessage(text); return }
  await updateMyStatus({ custom_text: text || null })
}

/** 상태 메시지 펼침 패널 [저장] — 문구·이모지·지울 시각(null = 지우지 않음)을 한 번에 */
export async function saveMessage(text: string, emoji: string | null, expiresAt: Date | null) {
  ensureUserPrefs()
  if (!isServer()) { setPrefsStatusMessage(text); return }
  if (!text) { await clearMessage(); return }
  await updateMyStatus({ custom_text: text, custom_emoji: emoji || null, custom_expires_at: expiresAt ? expiresAt.toISOString() : null })
}

export async function clearMessage() {
  ensureUserPrefs()
  if (!isServer()) { setPrefsStatusMessage(''); return }
  await updateMyStatus({ custom_text: null, custom_emoji: null, custom_expires_at: null })
}

export function useMyStatus() {
  statusClock()
  const prefs = useUserPrefs()
  const chatEnabled = useStore(platformStore, s => moduleEnabledIn(s.modules, s.loaded, 'chat'))
  const myStatus = useStore(chatStore, s => s.myStatus)
  const now = useStore(statusClockStore, s => s.now)
  const v = computeView(chatEnabled, myStatus, prefs.presence, prefs.statusMessage, now)
  return { ...v, setPresence, setInvisible, setDndFor, setMessage, saveMessage, clearMessage }
}
