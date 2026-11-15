/**
 * 음성 채널 세션 — 앱 수준 싱글턴. 미니 통화 창(useMeetings 의 앱 수준 세션)과 같은 원리:
 * 접속은 모듈 단위로 올려 두어 화면(채팅 → 메일 → 파일)을 옮겨도 끊기지 않고, 셸이 접속 바(VoiceConnectedBar)를 띄운다.
 *
 *  · 전송은 lib/voice/transport 의 VoiceTransport 로만 다룬다 — 음성·음악은 LiveKit(lib/voice/transports/livekit),
 *    무손실·하이레조는 등록되면(registerVoiceTransport) 자동으로 선택 가능해진다.
 *  · 한 번에 하나만: 음성 채널에 들어가면 미니 통화(회의)는 나가고, 회의에 들어가면 음성 채널에서 나간다(registerExternalCallLeaver).
 *  · 내 상태(음소거·듣기 끔·단계)는 서버(POST …/voice/state)에 알려 다른 사람 사이드바에 바로 보인다.
 *  · 송신 설정은 로컬 prefs(lib/voice/prefs) — 사람마다, 기기마다.
 *  · 상태(답 "상태" 절): 연결 중 · 재연결(reconnectSince) · 무손실 중계 실패(prefs.tier=lossless, effectiveTier=music) ·
 *    하이레조 독점 확인(hiresPrompt — 데스크톱 앱, 3단계가 부른다) · 독점 실패(exclusiveError) · 권한 없음(listenOnly).
 *
 * React: const { channelId, connectionState, peers, muted, ... , join, leave, toggleMute } = useVoice()
 * 컴포넌트 밖: voiceStore.getState() / joinVoice(id) / leaveVoice() …
 */
import { createStore, useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { $fetch } from '~/lib/api'
import { i18n } from '~/i18n'
import { addToast } from '~/composables/useToast'
import { meetingsStore, leaveRoom as leaveMeetingRoom, registerExternalCallLeaver } from '~/composables/useMeetings'
import { applyVoiceState, fetchVoiceStates, type VoicePresence } from '~/composables/useChat'
import { isDesktopShellNow } from '~/composables/useDesktopShell'
import { isOpusTier } from '~/lib/voice/opus'
import { DEFAULT_VOICE_PREFS, loadVoicePrefs, saveVoicePrefs, type VoicePrefs } from '~/lib/voice/prefs'
import { EMPTY_STATS } from '~/lib/voice/stats'
import { stabilizeNext } from '~/lib/voice/ui'
import {
  getVoiceTransportFactory, hasVoiceTransport, registerVoiceTransport,
  type VoiceConnectionState, type VoiceLevels, type VoicePeer, type VoiceSendConfig, type VoiceStats, type VoiceTier, type VoiceTransport,
} from '~/lib/voice/transport'
import { createLiveKitVoiceTransport } from '~/lib/voice/transports/livekit'

// 이번 단계의 전송 — 음성·음악. 무손실(lib/lossless)·하이레조는 자기 모듈에서 registerVoiceTransport 로 붙인다.
registerVoiceTransport(['voice', 'music'], createLiveKitVoiceTransport)
// 무손실(Tier 3) — 자체 릴레이(WebTransport 기본·WebSocket 폴백) + LiveKit presence. import 만으로 등록된다.
import '~/lib/lossless/register'
// 하이레조(Tier 4) — 데스크톱 앱(window.jwNativeAudio)에서만 등록된다. import 만으로 등록(없으면 아무 일도 안 한다).
import '~/lib/hires/register'
// 사람별 음량 · 눌러서 말하기 — 아래(store 를 만든 뒤) install 로 구독을 건다(순환 import 피함)
import { installUserVolumeSync } from '~/lib/voice/userVolume'
import { installPushToTalk } from '~/lib/voice/ptt'

/** 하이레조 켜기 확인창(답 "상태 · 하이레조 켜기") — 데스크톱 앱이 장치 이름·형식을 넣어 부른다 */
export interface HiresPrompt {
  deviceName: string
  /** 형식 한 줄(mono) 예: 'PCM 32/192 · 비트퍼펙트 · 12.3 Mbps' */
  format: string
  resolve: (ok: boolean) => void
}

/** 하이레조 장치 독점 실패(답 "상태 · 장치 독점 실패") — 데스크톱 앱이 알린다 */
export interface ExclusiveError { app: string; device: string }

export interface VoiceState {
  /** 접속한(또는 접속 중인) 음성 채널. null = 없음 */
  channelId: string | null
  identity: string | null
  connectionState: VoiceConnectionState
  peers: VoicePeer[]
  muted: boolean
  deafened: boolean
  prefs: VoicePrefs
  /** 지금 실제로 보내는 단계(강등 반영) */
  effectiveTier: VoiceTier
  stats: VoiceStats
  levels: VoiceLevels
  /** 화면 공유 소리(음악 공유) 보내는 중 */
  screenAudio: boolean
  joinedAt: number | null
  busy: boolean
  /** 접속 바의 "증명" 패널 펼침 */
  statsOpen: boolean
  /** 음질 패널 열림 */
  qualityOpen: boolean
  /** 마이크 권한이 없어 듣기만(join 은 됐다) */
  listenOnly: boolean
  /** 재연결이 시작된 시각(접속 바 "다시 연결하는 중… N초") */
  reconnectSince: number | null
  /** 하이레조 켜기 확인창(데스크톱 앱) */
  hiresPrompt: HiresPrompt | null
  /** 하이레조 장치 독점 실패 */
  exclusiveError: ExclusiveError | null
  /** 접속 바를 그리고 있는 사이드바 호스트 수 — 0 이면 셸 사이드바가 그린다 */
  barHosts: number
}

export const voiceStore = createStore<VoiceState>()(() => ({
  channelId: null,
  identity: null,
  connectionState: 'disconnected',
  peers: [],
  muted: false,
  deafened: false,
  prefs: typeof localStorage !== 'undefined' ? loadVoicePrefs() : { ...DEFAULT_VOICE_PREFS },
  effectiveTier: 'voice',
  stats: { ...EMPTY_STATS },
  levels: { left: -100, right: -100 },
  screenAudio: false,
  joinedAt: null,
  busy: false,
  statsOpen: false,
  qualityOpen: false,
  listenOnly: false,
  reconnectSince: null,
  hiresPrompt: null,
  exclusiveError: null,
  barHosts: 0,
}))

const S = () => voiceStore.getState()
const set = (p: Partial<VoiceState>) => voiceStore.setState(p)
const t = (k: string, a?: Record<string, unknown>) => i18n.t(k, a)

let _transport: VoiceTransport | null = null
let _offs: Array<() => void> = []
let _statsTimer: ReturnType<typeof setInterval> | null = null
let _levelTimer: ReturnType<typeof setInterval> | null = null
let _joinSeq = 0
/**
 * 마이크 문(눌러서 말하기 — lib/voice/ptt). false 면 사용자가 음소거를 풀어 두어도 실제 마이크는 닫는다.
 * 기본은 늘 열림(음성 감지 모드).
 */
let _micGate: () => boolean = () => true
const sendMuted = () => S().muted || !_micGate()
/** PTT 가 문을 바꿀 때 — 지금 전송에 바로 적용 */
export function setVoiceMicGate(gate: () => boolean) {
  _micGate = gate
  void applyMicGate()
}
export async function applyMicGate(): Promise<void> {
  if (S().listenOnly) return
  try { await _transport?.setMuted(sendMuted()) } catch { /* noop */ }
}

/** 송신 설정(prefs → 전송에 주는 모양) — 고급(샘플레이트·비트심도·버퍼 목표)도 함께 넘긴다(무손실 전송이 읽는다) */
export function sendConfigOf(p: VoicePrefs): VoiceSendConfig & { speakerDeviceId?: string } {
  return {
    tier: p.tier, musicBitrate: p.musicBitrate, micDeviceId: p.micDeviceId, krisp: p.krisp, speakerDeviceId: p.speakerDeviceId,
    echoCancellation: p.echoCancellation, noiseSuppression: p.noiseSuppression, autoGainControl: p.autoGainControl,
    sampleRate: p.sampleRate, bitDepth: p.bitDepth, bufferTarget: p.bufferTarget,
  }
}

/** 이 단계를 지금 고를 수 있나(전송이 등록돼 있나). 없으면 "준비 중". 하이레조는 데스크톱 앱에서만 */
export function tierAvailable(tier: VoiceTier): boolean {
  if (tier === 'hires' && !isDesktopShellNow()) return false
  return hasVoiceTransport(tier)
}

async function reportState() {
  const { channelId, identity, deafened, effectiveTier } = S()
  if (!channelId || !identity) return
  const muted = S().muted || S().listenOnly   // 마이크가 없으면(듣기만) 방 밖 사람에게도 말 못 하는 걸로 보인다
  try {
    const st = await $fetch<{ participants: VoicePresence[]; since: number | null }>(`/api/chat/channels/${encodeURIComponent(channelId)}/voice/state`, {
      method: 'POST', body: { identity, muted, deafened, tier: effectiveTier },
    })
    // 응답이 곧 그 방의 상태 — 소켓 이벤트(voice_state)가 늦거나 끊겨 있어도 내 타일·사이드바가 바로 맞는다
    if (st && Array.isArray(st.participants) && S().channelId === channelId) applyVoiceState(channelId, st)
  } catch { /* presence 는 서버 대조 루프가 결국 맞춘다 */ }
}

function startPolling() {
  stopPolling()
  _statsTimer = setInterval(async () => {
    const tr = _transport
    if (!tr || S().connectionState !== 'connected') return
    try {
      const stats = await tr.getStats()
      if (_transport === tr) set({ stats, effectiveTier: tr.effectiveTier() })   // 그 사이 나갔으면 버린다
    } catch { /* noop */ }
  }, 1000)
  _levelTimer = setInterval(() => {
    const tr = _transport
    if (!tr) return
    try { set({ levels: tr.getLevels() }) } catch { /* noop */ }
  }, 120)
}
function stopPolling() {
  if (_statsTimer) { clearInterval(_statsTimer); _statsTimer = null }
  if (_levelTimer) { clearInterval(_levelTimer); _levelTimer = null }
}

function bindTransport(tr: VoiceTransport, seq: number) {
  _offs.forEach(f => f())
  _offs = [
    tr.on('state', (s) => {
      if (seq !== _joinSeq) return
      // 재연결은 시작 시각을 적어 두어 접속 바가 "N초"를 센다. 다시 붙으면 지운다
      const reconnecting = s === 'reconnecting' || s === 'rejoining'
      set({ connectionState: s, reconnectSince: reconnecting ? (S().reconnectSince ?? Date.now()) : null })
    }),
    // 무손실 전송은 중계가 붙거나 떨어질 때(강등·복귀) peers 를 다시 알린다 — effectiveTier 를 그 자리에서 읽어 띠·배지가 1초 폴링을 기다리지 않는다
    // 음악 공유는 브라우저의 "공유 중지"로도 끝난다 — 내 타일의 실제 상태를 따라간다(켜는 쪽은 toggleScreenAudio 가 맡는다)
    tr.on('peers', (peers) => {
      if (seq !== _joinSeq) return
      const sharing = peers.some(p => p.isLocal && p.sharingAudio)
      set({ peers, listenOnly: tr.micState?.() === 'denied', effectiveTier: tr.effectiveTier(), ...(S().screenAudio && !sharing ? { screenAudio: false } : {}) })
    }),
    tr.on('ended', (reason) => {
      if (seq !== _joinSeq) return
      // 상대가 끝냈다(방 삭제·내보내짐)·되붙기 실패 — 세션을 정리하고 알린다
      void teardown().then(() => {
        if (!/CLIENT_INITIATED|client/i.test(reason)) addToast('info', t('chat.voice.toast.ended'))
      })
    }),
  ]
}

async function teardown() {
  _joinSeq++
  stopPolling()
  _offs.forEach(f => f())
  _offs = []
  const tr = _transport
  _transport = null
  const { channelId, identity } = S()
  // 하이레조 독점 확인창이 떠 있으면 취소로 닫는다 — 나간 뒤에 [독점하고 켜기]가 눌리면 장치를 잡아 버린다
  S().hiresPrompt?.resolve(false)
  // busy 는 여기서 건드리지 않는다(join/leave 의 finally 가 관리) — 채널 이동 도중 풀리면 연속 클릭이 이중 접속이 된다
  set({
    channelId: null, identity: null, connectionState: 'disconnected', peers: [], screenAudio: false,
    joinedAt: null, stats: { ...EMPTY_STATS }, levels: { left: -100, right: -100 },
    listenOnly: false, reconnectSince: null, exclusiveError: null, statsOpen: false,
  })
  if (tr) { try { await tr.leave() } catch { /* noop */ } }
  if (channelId && identity) {
    try { await $fetch(`/api/chat/channels/${encodeURIComponent(channelId)}/voice/leave`, { method: 'POST', body: { identity } }) } catch { /* noop */ }
  }
  void fetchVoiceStates()
}

/** 음성 채널에 들어간다(벨 없음). 이미 그 채널이면 아무것도 안 한다. 다른 채널이면 옮긴다 */
export async function joinVoice(channelId: string): Promise<void> {
  if (S().busy) return
  if (S().channelId === channelId && S().connectionState !== 'disconnected') return
  set({ busy: true })
  let seq = -1
  let tr: VoiceTransport | null = null
  try {
    if (S().channelId) await teardown()
    // 미니 통화(회의)와 동시에 두 방에 붙지 않는다
    if (meetingsStore.getState().inCall || meetingsStore.getState().currentRoom) await leaveMeetingRoom()
    const prefs = S().prefs
    const tier: VoiceTier = tierAvailable(prefs.tier) ? prefs.tier : 'voice'
    const factory = getVoiceTransportFactory(tier)
    if (!factory) throw new Error('no transport')
    seq = ++_joinSeq
    const tok = await $fetch<{ token: string; livekit_url: string; room: string; identity: string }>(
      `/api/chat/channels/${encodeURIComponent(channelId)}/voice/token`, { method: 'POST' },
    )
    if (seq !== _joinSeq) return   // 토큰을 기다리는 사이 나갔다(나가기·회의 입장)
    tr = factory()
    _transport = tr
    bindTransport(tr, seq)
    set({ channelId, identity: tok.identity, connectionState: 'connecting', joinedAt: Date.now(), effectiveTier: tier })
    await tr.join({ token: tok.token, url: tok.livekit_url, identity: tok.identity, channelId, muted: sendMuted(), send: { ...sendConfigOf(prefs), tier } })
    if (seq !== _joinSeq) { try { await tr.leave() } catch { /* noop */ } return }   // 그 사이 나갔다 — 방금 붙은 전송을 남기지 않는다
    tr.setDeafened(S().deafened)
    set({ connectionState: 'connected', peers: tr.peers(), effectiveTier: tr.effectiveTier(), listenOnly: tr.micState?.() === 'denied' })
    startPolling()
    void reportState()
  } catch (e: any) {
    // 밀려난 join 의 실패(나가는 중에 끊긴 접속 등)는 새 세션을 건드리지 않는다 — 자기 전송만 치운다
    if (seq !== -1 && seq !== _joinSeq) { if (tr) { try { await tr.leave() } catch { /* noop */ } } return }
    const detail = e?.data?.detail
    await teardown()
    addToast('error', typeof detail === 'string' ? detail : t('chat.voice.toast.joinFail'))
    throw e
  } finally {
    set({ busy: false })
  }
}

/** 나가기 */
export async function leaveVoice(): Promise<void> {
  if (!S().channelId && !_transport) {
    if (S().busy) _joinSeq++   // 토큰을 받는 중 — 그 join 을 무효로 만든다
    return
  }
  set({ busy: true })
  try { await teardown() } finally { set({ busy: false }) }
}

export async function toggleVoiceMute(): Promise<void> {
  if (S().listenOnly) return   // 마이크가 없다 — 버튼은 잠겨 있다
  const next = !S().muted
  set({ muted: next })
  // 듣기 끔 상태에서 음소거를 풀면 듣기도 켠다(디스코드 규칙)
  if (!next && S().deafened) { set({ deafened: false }); _transport?.setDeafened(false) }
  try { await _transport?.setMuted(sendMuted()) } catch { /* noop */ }
  void reportState()
}

export async function toggleVoiceDeafen(): Promise<void> {
  const next = !S().deafened
  set({ deafened: next })
  _transport?.setDeafened(next)
  // 듣기를 끄면 말도 끊는다(디스코드 규칙). 다시 켤 때 음소거는 사용자가 푼다
  if (next && !S().muted) { set({ muted: true }); try { await _transport?.setMuted(true) } catch { /* noop */ } }
  void reportState()
}

/**
 * 하이레조 켜기 전 확인(데스크톱 앱, 처음 한 번) — 3단계(네이티브 전송)가 장치 이름·형식을 넣어 부른다.
 * "다음부터 묻지 않기"를 켰으면 바로 true. 사용자가 [독점하고 켜기]면 true, [취소]면 false.
 */
export function confirmHiresExclusive(deviceName: string, format: string): Promise<boolean> {
  if (S().prefs.hiresAskSkip) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    set({ hiresPrompt: { deviceName, format, resolve: (ok) => { set({ hiresPrompt: null }); resolve(ok) } } })
  })
}

/** 하이레조 장치 독점 실패를 알린다(danger 띠). null 이면 띠를 내린다. [다시 시도]는 retryHires */
export function reportExclusiveError(err: ExclusiveError | null) {
  set({ exclusiveError: err })
}

/** 독점 실패 띠 [다시 시도] — 송신 설정을 다시 적용한다(하이레조 전송이 장치를 다시 잡는다) */
export async function retryHires(): Promise<void> {
  set({ exclusiveError: null })
  await applySend(S().prefs)
}

/** 무손실 중계 실패 띠 [무손실 다시 시도] — 무손실 전송에 setSend 를 다시 주면 중계에 다시 붙는다 */
export async function retryLossless(): Promise<void> {
  const prefs = S().prefs
  if (prefs.tier !== 'lossless') return
  await applySend(prefs)
}

/** 권한 없음 띠 [다시 시도] — 마이크를 다시 만든다(권한을 허용했으면 바로 말할 수 있다) */
export async function retryMic(): Promise<void> {
  const tr = _transport
  if (!tr) return
  await applySend(S().prefs)
  set({ listenOnly: tr.micState?.() === 'denied', peers: tr.peers() })
  void reportState()
}

/** 지금 전송에 송신 설정을 적용한다(단계는 등록된 범위로) */
async function applySend(prefs: VoicePrefs): Promise<void> {
  const tr = _transport
  if (!tr || !S().channelId) return
  const wantTier: VoiceTier = tierAvailable(prefs.tier) ? prefs.tier : 'voice'
  try {
    await tr.setSend({ ...sendConfigOf(prefs), tier: wantTier })
    set({ effectiveTier: tr.effectiveTier(), stats: { ...EMPTY_STATS }, listenOnly: tr.micState?.() === 'denied' })
    void reportState()
  } catch (e) {
    console.warn('[voice] 송신 설정 적용 실패', e)
    addToast('error', t('chat.voice.toast.applyFail'))
  }
}

/** 송신 설정 바꾸기 — 로컬에 저장하고, 접속 중이면 바로 적용(단계·비트레이트는 트랙을 다시 만든다) */
export async function setVoicePrefs(patch: Partial<VoicePrefs>): Promise<void> {
  // 하이레조는 데스크톱 앱에서만 — 웹에선 고를 수 없다(패널도 disabled)
  if (patch.tier === 'hires' && !isDesktopShellNow()) return
  const prefs: VoicePrefs = { ...S().prefs, ...patch }
  saveVoicePrefs(prefs)
  set({ prefs })
  const tr = _transport
  if (!tr || !S().channelId) return
  const wantTier: VoiceTier = tierAvailable(prefs.tier) ? prefs.tier : 'voice'
  const cur = tr.tiers
  if (!cur.includes(wantTier)) {
    // 다른 전송이 맡는 단계 — 같은 채널에 다시 붙는다
    const ch = S().channelId
    await teardown()
    if (ch) await joinVoice(ch)
    return
  }
  const live = ['tier', 'musicBitrate', 'micDeviceId', 'krisp', 'speakerDeviceId', 'sampleRate', 'bitDepth', 'bufferTarget',
    'echoCancellation', 'noiseSuppression', 'autoGainControl'].some(k => k in patch)
  if (!live) return
  await applySend(prefs)
}

/** [안정화] — 버퍼 목표를 고정값으로(자동 → 120, 고정이면 한 단계 위) */
export async function stabilizeVoiceBuffer(): Promise<void> {
  await setVoicePrefs({ bufferTarget: stabilizeNext(S().prefs.bufferTarget) })
}

/** 화면 공유 소리(음악 공유) 켬/끔 */
export async function toggleScreenAudio(): Promise<void> {
  const tr = _transport
  if (!tr) return
  const next = !S().screenAudio
  const ok = await tr.setScreenAudio(next)
  if (next && !ok) { addToast('warning', t('chat.voice.toast.noShareAudio')); return }
  set({ screenAudio: next, stats: { ...EMPTY_STATS } })
}

/** 음악 공유 띠 [공유 음량] — 그 사람의 수신 음량(0..1) */
export function setPeerVolume(identity: string, volume: number) {
  _transport?.setParticipantVolume?.(identity, volume)
}

/** 사람별 음량(0..2) — lib/voice/userVolume 이 개인 설정(chatUserVolumes·chatUserMuted)을 접속자마다 적용한다 */
export function setPeerGain(identity: string, gain: number) {
  _transport?.setParticipantGain?.(identity, gain)
}

export const setVoiceStatsOpen = (v: boolean) => { set({ statsOpen: v, qualityOpen: v ? false : S().qualityOpen }); void setVoicePrefs({ statsOpen: v }) }
export const setVoiceQualityOpen = (v: boolean) => set({ qualityOpen: v, statsOpen: v ? false : S().statsOpen })

/** 사이드바(채팅 목록)가 접속 바를 그리는 동안 셸 사이드바는 그리지 않는다 — 마운트/언마운트에 맞춰 센다 */
export function registerVoiceBarHost(): () => void {
  set({ barHosts: S().barHosts + 1 })
  return () => set({ barHosts: Math.max(0, S().barHosts - 1) })
}

/** 이 단계가 Opus(LiveKit) 단계인가 — 배지·설명 분기용 */
export { isOpusTier }

installUserVolumeSync({ voiceStore, setPeerGain })
installPushToTalk({ voiceStore, setVoiceMicGate })

// 회의(useMeetings)에 들어가면 음성 채널에서 나간다
registerExternalCallLeaver(async () => { if (S().channelId || S().busy) await leaveVoice() })

// 창·탭을 닫으면 서버에 나갔다고 알린다(LiveKit 은 소켓이 끊기면 알지만, 깃발은 지워 둔다)
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    const { channelId, identity } = S()
    if (!channelId || !identity) return
    try {
      navigator.sendBeacon?.(`/api/chat/channels/${encodeURIComponent(channelId)}/voice/leave`, new Blob([JSON.stringify({ identity })], { type: 'application/json' }))
    } catch { /* noop */ }
  })
}

// 개발 서버에서만: 화면 상태 점검(재연결·독점 실패 같은 드문 상태를 흉내)용 손잡이. 운영 번들엔 들어가지 않는다
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __voice?: unknown }).__voice = { store: voiceStore, confirmHiresExclusive, reportExclusiveError }
}

export function useVoice() {
  const s = useStore(voiceStore, useShallow((x: VoiceState) => x))
  return {
    ...s,
    inVoice: !!s.channelId,
    join: joinVoice, leave: leaveVoice, toggleMute: toggleVoiceMute, toggleDeafen: toggleVoiceDeafen,
    setPrefs: setVoicePrefs, toggleScreenAudio, setStatsOpen: setVoiceStatsOpen, setQualityOpen: setVoiceQualityOpen,
    tierAvailable, retryMic, retryLossless, retryHires, stabilize: stabilizeVoiceBuffer, setPeerVolume,
  }
}
