/**
 * 음성 채널 세션 — 앱 수준 싱글턴. 미니 통화 창(useMeetings 의 앱 수준 세션)과 동일한 원리:
 * 접속을 모듈 단위로 유지하여 화면(채팅 → 메일 → 파일) 전환 시에도 연결이 유지되며, 셸이 접속 바(VoiceConnectedBar)를 표시한다.
 *
 *  · 전송은 lib/voice/transport 의 VoiceTransport 로만 처리한다 — 음성·음악은 LiveKit(lib/voice/transports/livekit),
 *    무손실·하이레조는 등록(registerVoiceTransport) 시 자동으로 선택 가능 상태가 된다.
 *  · 동시 접속은 하나로 제한한다: 음성 채널 입장 시 미니 통화(회의)에서 퇴장하고, 회의 입장 시 음성 채널에서 퇴장한다(registerExternalCallLeaver).
 *  · 본인 상태(음소거·듣기 끔·단계)는 서버(POST …/voice/state)에 전달하여 다른 사용자의 사이드바에 즉시 반영한다.
 *  · 송신 설정은 로컬 prefs(lib/voice/prefs)에 둔다 — 사용자별·기기별.
 *  · 상태(답 "상태" 절): 연결 중 · 재연결(reconnectSince) · 무손실 중계 실패(prefs.tier=lossless, effectiveTier=music) ·
 *    하이레조 독점 확인(hiresPrompt — 데스크톱 앱, 3단계에서 호출) · 독점 실패(exclusiveError) · 권한 없음(listenOnly).
 *
 * React: const { channelId, connectionState, peers, muted, ... , join, leave, toggleMute } = useVoice()
 * 컴포넌트 외부: voiceStore.getState() / joinVoice(id) / leaveVoice() …
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

// 이번 단계의 전송 — 음성·음악. 무손실(lib/lossless)·하이레조는 각 모듈에서 registerVoiceTransport 로 등록한다.
registerVoiceTransport(['voice', 'music'], createLiveKitVoiceTransport)
// 무손실(Tier 3) — 자체 릴레이(WebTransport 기본·WebSocket 폴백) + LiveKit presence. import 만으로 등록된다.
import '~/lib/lossless/register'
// 하이레조(Tier 4) — 데스크톱 앱(window.jwNativeAudio)에서만 등록된다. import 만으로 등록(미존재 시 no-op).
import '~/lib/hires/register'
// 사용자별 음량 · 눌러서 말하기 — 하단(store 생성 이후)에서 install 로 구독을 등록한다(순환 import 회피)
import { installUserVolumeSync } from '~/lib/voice/userVolume'
import { installPushToTalk } from '~/lib/voice/ptt'

/** 하이레조 켜기 확인창(답 "상태 · 하이레조 켜기") — 데스크톱 앱이 장치 이름·형식을 전달하여 호출 */
export interface HiresPrompt {
  deviceName: string
  /** 형식 한 줄(mono) 예: 'PCM 32/192 · 비트퍼펙트 · 12.3 Mbps' */
  format: string
  resolve: (ok: boolean) => void
}

/** 하이레조 장치 독점 실패(답 "상태 · 장치 독점 실패") — 데스크톱 앱이 통지 */
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
  /** 현재 실제 송신 단계(강등 반영) */
  effectiveTier: VoiceTier
  stats: VoiceStats
  levels: VoiceLevels
  /** 화면 공유 소리(음악 공유) 송신 중 */
  screenAudio: boolean
  joinedAt: number | null
  busy: boolean
  /** 접속 바의 "증명" 패널 펼침 */
  statsOpen: boolean
  /** 음질 패널 열림 */
  qualityOpen: boolean
  /** 마이크 권한 부재로 수신 전용(join 은 완료) */
  listenOnly: boolean
  /** 재연결 시작 시각(접속 바 "다시 연결하는 중… N초") */
  reconnectSince: number | null
  /** 하이레조 켜기 확인창(데스크톱 앱) */
  hiresPrompt: HiresPrompt | null
  /** 하이레조 장치 독점 실패 */
  exclusiveError: ExclusiveError | null
  /** 접속 바를 렌더링 중인 사이드바 호스트 수 — 0 이면 셸 사이드바가 렌더링 */
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
 * 마이크 게이트(눌러서 말하기 — lib/voice/ptt). false 이면 사용자가 음소거를 해제한 상태에서도 실제 마이크를 차단한다.
 * 기본값은 상시 개방이다(음성 감지 모드).
 */
let _micGate: () => boolean = () => true
const sendMuted = () => S().muted || !_micGate()
/** PTT 가 게이트를 변경할 때 호출 — 현재 전송에 즉시 적용 */
export function setVoiceMicGate(gate: () => boolean) {
  _micGate = gate
  void applyMicGate()
}
export async function applyMicGate(): Promise<void> {
  if (S().listenOnly) return
  try { await _transport?.setMuted(sendMuted()) } catch { /* noop */ }
}

/** 송신 설정(prefs → 전송 전달 형태) — 고급(샘플레이트·비트심도·버퍼 목표) 항목도 함께 전달(무손실 전송이 참조) */
export function sendConfigOf(p: VoicePrefs): VoiceSendConfig & { speakerDeviceId?: string } {
  return {
    tier: p.tier, musicBitrate: p.musicBitrate, micDeviceId: p.micDeviceId, speakerDeviceId: p.speakerDeviceId,
    echoCancellation: p.echoCancellation, noiseSuppression: p.noiseSuppression, autoGainControl: p.autoGainControl,
    sampleRate: p.sampleRate, bitDepth: p.bitDepth, bufferTarget: p.bufferTarget,
  }
}

/** 해당 단계의 현재 선택 가능 여부(전송 등록 여부). 미등록 시 "준비 중". 하이레조는 데스크톱 앱 전용 */
export function tierAvailable(tier: VoiceTier): boolean {
  if (tier === 'hires' && !isDesktopShellNow()) return false
  return hasVoiceTransport(tier)
}

async function reportState() {
  const { channelId, identity, deafened, effectiveTier } = S()
  if (!channelId || !identity) return
  const muted = S().muted || S().listenOnly   // 마이크 부재(수신 전용) 시 방 외부 사용자에게도 발화 불가 상태로 표시
  try {
    const st = await $fetch<{ participants: VoicePresence[]; since: number | null }>(`/api/chat/channels/${encodeURIComponent(channelId)}/voice/state`, {
      method: 'POST', body: { identity, muted, deafened, tier: effectiveTier },
    })
    // 응답이 곧 해당 방의 상태 — 소켓 이벤트(voice_state)가 지연되거나 단절된 경우에도 본인 타일·사이드바에 즉시 반영
    if (st && Array.isArray(st.participants) && S().channelId === channelId) applyVoiceState(channelId, st)
  } catch { /* presence 는 서버 대조 루프에서 최종 정합 */ }
}

function startPolling() {
  stopPolling()
  _statsTimer = setInterval(async () => {
    const tr = _transport
    if (!tr || S().connectionState !== 'connected') return
    try {
      const stats = await tr.getStats()
      if (_transport === tr) set({ stats, effectiveTier: tr.effectiveTier() })   // 그 사이 퇴장한 경우 폐기
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
      // 재연결 시 시작 시각을 기록하여 접속 바가 "N초"를 계수한다. 재접속 완료 시 제거한다
      const reconnecting = s === 'reconnecting' || s === 'rejoining'
      set({ connectionState: s, reconnectSince: reconnecting ? (S().reconnectSince ?? Date.now()) : null })
    }),
    // 무손실 전송은 중계 연결·해제(강등·복귀) 시 peers 를 재통지한다 — effectiveTier 를 즉시 조회하므로 띠·배지가 1초 폴링을 대기하지 않는다
    // 음악 공유는 브라우저의 "공유 중지"로도 종료된다 — 본인 타일의 실제 상태를 따른다(활성화는 toggleScreenAudio 가 담당한다)
    tr.on('peers', (peers) => {
      if (seq !== _joinSeq) return
      const sharing = peers.some(p => p.isLocal && p.sharingAudio)
      set({ peers, listenOnly: tr.micState?.() === 'denied', effectiveTier: tr.effectiveTier(), ...(S().screenAudio && !sharing ? { screenAudio: false } : {}) })
    }),
    tr.on('ended', (reason) => {
      if (seq !== _joinSeq) return
      // 상대 측 종료(방 삭제·내보내짐) 또는 재접속 실패 — 세션 정리 후 통지
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
  // 하이레조 독점 확인창이 표시 중이면 취소로 닫는다 — 퇴장 이후 [독점하고 켜기]가 눌리면 장치를 점유하게 된다
  S().hiresPrompt?.resolve(false)
  // busy 는 여기서 변경하지 않는다(join/leave 의 finally 가 관리) — 채널 이동 도중 해제되면 연속 클릭이 이중 접속으로 이어진다
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

/** 음성 채널 입장(벨 없음). 이미 해당 채널이면 no-op. 다른 채널이면 이동 */
export async function joinVoice(channelId: string): Promise<void> {
  if (S().busy) return
  if (S().channelId === channelId && S().connectionState !== 'disconnected') return
  set({ busy: true })
  let seq = -1
  let tr: VoiceTransport | null = null
  try {
    if (S().channelId) await teardown()
    // 미니 통화(회의)와 동시에 두 방에 접속하지 않음
    if (meetingsStore.getState().inCall || meetingsStore.getState().currentRoom) await leaveMeetingRoom()
    const prefs = S().prefs
    const tier: VoiceTier = tierAvailable(prefs.tier) ? prefs.tier : 'voice'
    const factory = getVoiceTransportFactory(tier)
    if (!factory) throw new Error('no transport')
    seq = ++_joinSeq
    const tok = await $fetch<{ token: string; livekit_url: string; room: string; identity: string }>(
      `/api/chat/channels/${encodeURIComponent(channelId)}/voice/token`, { method: 'POST' },
    )
    if (seq !== _joinSeq) return   // 토큰 대기 중 퇴장(나가기·회의 입장)
    tr = factory()
    _transport = tr
    bindTransport(tr, seq)
    set({ channelId, identity: tok.identity, connectionState: 'connecting', joinedAt: Date.now(), effectiveTier: tier })
    await tr.join({ token: tok.token, url: tok.livekit_url, identity: tok.identity, channelId, muted: sendMuted(), send: { ...sendConfigOf(prefs), tier } })
    if (seq !== _joinSeq) { try { await tr.leave() } catch { /* noop */ } return }   // 그 사이 퇴장 — 방금 연결된 전송을 잔존시키지 않음
    tr.setDeafened(S().deafened)
    set({ connectionState: 'connected', peers: tr.peers(), effectiveTier: tr.effectiveTier(), listenOnly: tr.micState?.() === 'denied' })
    startPolling()
    void reportState()
  } catch (e: any) {
    // 무효화된 join 의 실패(퇴장 중 단절된 접속 등)는 새 세션에 영향을 주지 않는다 — 자체 전송만 정리한다
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
    if (S().busy) _joinSeq++   // 토큰 수신 중 — 해당 join 을 무효화
    return
  }
  set({ busy: true })
  try { await teardown() } finally { set({ busy: false }) }
}

export async function toggleVoiceMute(): Promise<void> {
  if (S().listenOnly) return   // 마이크 부재 — 버튼은 잠금 상태
  const next = !S().muted
  set({ muted: next })
  // 듣기 끔 상태에서 음소거 해제 시 듣기도 활성화(디스코드 규칙)
  if (!next && S().deafened) { set({ deafened: false }); _transport?.setDeafened(false) }
  try { await _transport?.setMuted(sendMuted()) } catch { /* noop */ }
  void reportState()
}

export async function toggleVoiceDeafen(): Promise<void> {
  const next = !S().deafened
  set({ deafened: next })
  _transport?.setDeafened(next)
  // 듣기 비활성화 시 송신도 차단(디스코드 규칙). 재활성화 시 음소거 해제는 사용자가 수행
  if (next && !S().muted) { set({ muted: true }); try { await _transport?.setMuted(true) } catch { /* noop */ } }
  void reportState()
}

/**
 * 하이레조 활성화 전 확인(데스크톱 앱, 최초 1회) — 3단계(네이티브 전송)가 장치 이름·형식을 전달하여 호출한다.
 * "다음부터 묻지 않기"가 활성화된 경우 즉시 true 를 반환한다. 사용자가 [독점하고 켜기]를 선택하면 true, [취소]를 선택하면 false 를 반환한다.
 */
export function confirmHiresExclusive(deviceName: string, format: string): Promise<boolean> {
  if (S().prefs.hiresAskSkip) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    set({ hiresPrompt: { deviceName, format, resolve: (ok) => { set({ hiresPrompt: null }); resolve(ok) } } })
  })
}

/** 하이레조 장치 독점 실패 통지(danger 띠). null 이면 띠 제거. [다시 시도]는 retryHires */
export function reportExclusiveError(err: ExclusiveError | null) {
  set({ exclusiveError: err })
}

/** 독점 실패 띠 [다시 시도] — 송신 설정 재적용(하이레조 전송이 장치를 재점유) */
export async function retryHires(): Promise<void> {
  set({ exclusiveError: null })
  await applySend(S().prefs)
}

/** 무손실 중계 실패 띠 [무손실 다시 시도] — 무손실 전송에 setSend 를 재전달하면 중계에 재연결 */
export async function retryLossless(): Promise<void> {
  const prefs = S().prefs
  if (prefs.tier !== 'lossless') return
  await applySend(prefs)
}

/** 권한 없음 띠 [다시 시도] — 마이크 재생성(권한 허용 시 즉시 발화 가능) */
export async function retryMic(): Promise<void> {
  const tr = _transport
  if (!tr) return
  await applySend(S().prefs)
  set({ listenOnly: tr.micState?.() === 'denied', peers: tr.peers() })
  void reportState()
}

/** 현재 전송에 송신 설정 적용(단계는 등록된 범위 내로) */
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

/** 송신 설정 변경 — 로컬에 저장하고, 접속 중이면 즉시 적용(단계·비트레이트는 트랙 재생성) */
export async function setVoicePrefs(patch: Partial<VoicePrefs>): Promise<void> {
  // 하이레조는 데스크톱 앱 전용 — 웹에서는 선택 불가(패널도 disabled)
  if (patch.tier === 'hires' && !isDesktopShellNow()) return
  const prefs: VoicePrefs = { ...S().prefs, ...patch }
  saveVoicePrefs(prefs)
  set({ prefs })
  const tr = _transport
  if (!tr || !S().channelId) return
  const wantTier: VoiceTier = tierAvailable(prefs.tier) ? prefs.tier : 'voice'
  const cur = tr.tiers
  if (!cur.includes(wantTier)) {
    // 다른 전송이 담당하는 단계 — 동일 채널에 재접속
    const ch = S().channelId
    await teardown()
    if (ch) await joinVoice(ch)
    return
  }
  const live = ['tier', 'musicBitrate', 'micDeviceId', 'speakerDeviceId', 'sampleRate', 'bitDepth', 'bufferTarget',
    'echoCancellation', 'noiseSuppression', 'autoGainControl'].some(k => k in patch)
  if (!live) return
  await applySend(prefs)
}

/** [안정화] — 버퍼 목표를 고정값으로 설정(자동 → 120, 고정이면 한 단계 상향) */
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

/** 음악 공유 띠 [공유 음량] — 해당 사용자의 수신 음량(0..1) */
export function setPeerVolume(identity: string, volume: number) {
  _transport?.setParticipantVolume?.(identity, volume)
}

/** 사용자별 음량(0..2) — lib/voice/userVolume 이 개인 설정(chatUserVolumes·chatUserMuted)을 접속자별로 적용 */
export function setPeerGain(identity: string, gain: number) {
  _transport?.setParticipantGain?.(identity, gain)
}

export const setVoiceStatsOpen = (v: boolean) => { set({ statsOpen: v, qualityOpen: v ? false : S().qualityOpen }); void setVoicePrefs({ statsOpen: v }) }
export const setVoiceQualityOpen = (v: boolean) => set({ qualityOpen: v, statsOpen: v ? false : S().statsOpen })

/** 사이드바(채팅 목록)가 접속 바를 렌더링하는 동안 셸 사이드바는 렌더링하지 않는다 — 마운트/언마운트에 맞춰 계수한다 */
export function registerVoiceBarHost(): () => void {
  set({ barHosts: S().barHosts + 1 })
  return () => set({ barHosts: Math.max(0, S().barHosts - 1) })
}

/** 해당 단계의 Opus(LiveKit) 단계 여부 — 배지·설명 분기용 */
export { isOpusTier }

installUserVolumeSync({ voiceStore, setPeerGain })
installPushToTalk({ voiceStore, setVoiceMicGate })

// 회의(useMeetings) 입장 시 음성 채널에서 퇴장
registerExternalCallLeaver(async () => { if (S().channelId || S().busy) await leaveVoice() })

// 창·탭 종료 시 서버에 퇴장을 통지한다(LiveKit 은 소켓 단절로 인지하나, 플래그는 제거해 둔다)
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    const { channelId, identity } = S()
    if (!channelId || !identity) return
    try {
      navigator.sendBeacon?.(`/api/chat/channels/${encodeURIComponent(channelId)}/voice/leave`, new Blob([JSON.stringify({ identity })], { type: 'application/json' }))
    } catch { /* noop */ }
  })
}

// 개발 서버 전용: 화면 상태 점검(재연결·독점 실패 등 드문 상태 재현)용 핸들. 운영 번들에는 포함되지 않음
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
