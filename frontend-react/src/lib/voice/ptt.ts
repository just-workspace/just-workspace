/**
 * 눌러서 말하기(PTT, handover-22 Chat22 #ptt) — 개인 설정 chatVoiceMode='ptt' · chatPttKey(KeyboardEvent.code) · chatPttReleaseMs.
 *  · 음성 채널에 접속해 있고 PTT 모드면, 그 키를 누르고 있는 동안만 마이크를 연다(LiveKit setMuted). 떼면 releaseMs 뒤 닫는다.
 *  · 음소거(사용자 버튼)·듣기 끔이면 키를 눌러도 열지 않는다(디스코드와 같다). 표시용 "말하는 중"은 talking.
 *  · 키는 이 창에 포커스가 있을 때만 받는다 — 데스크톱 앱 전역 단축키는 범위 밖.
 *  · 글 입력 칸(input·textarea·contenteditable)에 포커스가 있으면 글자 키는 PTT 로 쓰지 않는다(` 를 쳐야 할 때 막히지 않게).
 *    수정 키·기능 키(F1… · 마우스 아님)는 입력 칸에서도 받는다.
 *  · 창이 포커스를 잃으면 뗀 것으로 본다(키업을 못 받아 마이크가 열린 채 남지 않게).
 * 화면: usePushToTalk() → { enabled, talking, keyLabel }.
 */
import { createStore, useStore, type StoreApi } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { userPrefsStore } from '~/composables/useUserPrefs'

interface PttState {
  /** PTT 모드이고 음성 채널에 접속해 있다 */
  enabled: boolean
  /** 키를 누르고 있다(떼고 releaseMs 동안도 true) */
  held: boolean
}
export const pttStore = createStore<PttState>()(() => ({ enabled: false, held: false }))

/** KeyboardEvent.code → 화면 글자. Backquote → `, KeyV → V, Digit1 → 1, Space → Space */
export function pttKeyLabel(code: string): string {
  if (!code) return ''
  if (code === 'Backquote') return '`'
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`
  const map: Record<string, string> = {
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
    Comma: ',', Period: '.', Slash: '/', ControlLeft: 'Ctrl', ControlRight: 'Ctrl', ShiftLeft: 'Shift', ShiftRight: 'Shift',
    AltLeft: 'Alt', AltRight: 'Alt', CapsLock: 'Caps Lock',
  }
  return map[code] ?? code
}

/** 글자를 넣는 키인가(입력 칸에서는 PTT 로 쓰지 않는다) */
export function isCharacterKey(code: string): boolean {
  return /^(Key[A-Z]|Digit\d|Numpad\d|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Space)$/.test(code)
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || !el.tagName) return false
  if (el.isContentEditable) return true
  const tag = el.tagName.toLowerCase()
  if (tag === 'textarea') return true
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type
    return !['checkbox', 'radio', 'button', 'range', 'submit', 'reset'].includes(type)
  }
  return false
}

/** 지금 마이크 문을 열어도 되나 — PTT 가 아니면 늘 열림 */
export function pttGateOpen(s: PttState = pttStore.getState()): boolean {
  return !s.enabled || s.held
}

interface VoiceLike { channelId: string | null; muted: boolean; deafened: boolean }
interface Deps { voiceStore: StoreApi<VoiceLike>; setVoiceMicGate: (gate: () => boolean) => void }

let _installed = false
export function installPushToTalk({ voiceStore, setVoiceMicGate }: Deps) {
  if (_installed || typeof window === 'undefined') return
  _installed = true
  let releaseTimer: ReturnType<typeof setTimeout> | null = null
  const set = (p: Partial<PttState>) => {
    const before = pttGateOpen()
    pttStore.setState(p)
    if (pttGateOpen() !== before) setVoiceMicGate(() => pttGateOpen())
  }
  const recompute = () => {
    const enabled = userPrefsStore.getState().prefs.chatVoiceMode === 'ptt' && !!voiceStore.getState().channelId
    if (enabled !== pttStore.getState().enabled) set({ enabled, held: enabled ? pttStore.getState().held : false })
  }
  setVoiceMicGate(() => pttGateOpen())
  recompute()
  voiceStore.subscribe((s, p) => { if (s.channelId !== p.channelId) recompute() })
  userPrefsStore.subscribe((s, p) => { if (s.prefs.chatVoiceMode !== p.prefs.chatVoiceMode) recompute() })

  const release = () => {
    if (releaseTimer) clearTimeout(releaseTimer)
    const ms = userPrefsStore.getState().prefs.chatPttReleaseMs ?? 200
    releaseTimer = setTimeout(() => { releaseTimer = null; set({ held: false }) }, Math.max(0, ms))
  }
  window.addEventListener('keydown', (e) => {
    if (!pttStore.getState().enabled) return
    const code = userPrefsStore.getState().prefs.chatPttKey
    if (e.code !== code) return
    if (isCharacterKey(code) && isEditable(e.target)) return
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null }
    if (e.repeat && pttStore.getState().held) return
    const v = voiceStore.getState()
    if (v.muted || v.deafened) return
    set({ held: true })
  }, true)
  window.addEventListener('keyup', (e) => {
    if (!pttStore.getState().held) return
    if (e.code !== userPrefsStore.getState().prefs.chatPttKey) return
    release()
  }, true)
  window.addEventListener('blur', () => { if (pttStore.getState().held) { if (releaseTimer) clearTimeout(releaseTimer); releaseTimer = null; set({ held: false }) } })
}

/** 화면용 — PTT 켬 · 말하는 중 · 키 글자 */
export function usePushToTalk(): { enabled: boolean; talking: boolean; keyLabel: string } {
  const s = useStore(pttStore, useShallow((x: PttState) => x))
  const code = useStore(userPrefsStore, x => x.prefs.chatPttKey)
  return { enabled: s.enabled, talking: s.enabled && s.held, keyLabel: pttKeyLabel(code) }
}
