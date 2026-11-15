/**
 * 회의(LiveKit) — 방 목록 REST + 앱 수준 통화 세션. Vue 판 composables/useMeetings.ts 그대로.
 *
 * Vue 판은 모든 상태가 Nuxt useState('meetings-*') 였다(앱 전역). React 판은 그 키들을 meetingsStore 한 곳에 모았다.
 * 접속 정보·재입장 타이머·화면 꺼짐 방지·문서 리스너는 모듈 수준(Vue 판과 같음) — 회의 화면을 떠나도(미니 창) 통화가 계속 돈다.
 *
 * React: const { rooms, participants, connectionState, joinRoom, leaveRoom, toggleMic, ... } = useMeetings()
 *   - 멤버 이름은 Vue 판과 같다. 값은 .value 없이(렌더 시점 값). 읽은 필드만 구독한다(useTrackedStore).
 *   - Vue 에서 바깥이 대입하던 상태: setIsHost(v)(회의 화면), setMeetingsError(v). 그 밖은 setMeetingsState({ … }).
 * 컴포넌트 밖: meetingsStore.getState() / joinRoom()·leaveRoom() 등 export 함수
 */
// livekit-client 는 무거워서(메인 번들의 1/3) 통화를 시작할 때 지연 로드한다(Vue 판은 Nuxt 가 청크를 나눠
// 메인에 없었다). 타입만 정적으로 가져오고, 값은 loadLivekit() 뒤에 lk() 로 쓴다. 방(Room)이 있는 경로는
// 반드시 connectToRoom 을 거쳤으므로 lk() 가 이미 채워져 있다.
import type { DisconnectReason, Participant, Room } from 'livekit-client'
import { createStore } from 'zustand'
import { $fetch } from '~/lib/api'
import { i18n } from '~/i18n'
import { addToast } from '~/composables/useToast'
import { markActionDone } from '~/composables/useNotifications'
import { mediaDevicesApi } from '~/composables/useMediaDevices'
import { nativeMeetingApi, type NativeMeetingEvent } from '~/composables/useNativeMeeting'
import { createWakeLock, type WakeLockHandle } from '~/composables/useWakeLock'
import { useTrackedStore } from '~/composables/useTrackedStore'

export interface MeetingRoomInfo {
  name: string
  num_participants: number
  max_participants: number
  creation_time: number
  share_token: string
  is_host: boolean
  pending_count: number
  has_password?: boolean
  /** 목록 "호스트 이름"·예정/진행 중/지난 묶기(시안 MT1) */
  host_name?: string
  scheduled_at?: string | null
  duration_minutes?: number | null
  // ── DB 회의 저장소(예약 회의) — 예전 Redis 전용 방·채널 통화는 meeting_id 가 없다 ──
  meeting_id?: string | null
  /** live | scheduled | ended | cancelled */
  status?: string
  title?: string
  description?: string | null
  waiting_room?: boolean
  /** 초대받은 사람으로서 내 응답(pending/accepted/declined/tentative). 호스트·초대 아님이면 null */
  my_response?: string | null
  invitee_count?: number
  accepted_count?: number
  started_at?: string | null
  ended_at?: string | null
}
type RoomInfo = MeetingRoomInfo

export interface MeetingInviteeInfo {
  id: string
  user_id: string | null
  email: string | null
  display_name: string
  response: string
  responded_at: string | null
}

export interface MeetingDetail extends MeetingRoomInfo {
  invitees: MeetingInviteeInfo[]
  join_url: string
}

export type MeetingRsvp = 'accepted' | 'declined' | 'tentative'

/** PATCH /rooms/{name} — 보낸 필드만 바뀐다 */
export interface MeetingUpdate {
  title?: string
  description?: string | null
  scheduled_at?: string | null
  duration_minutes?: number
  /** "" = 비밀번호 해제 */
  password?: string
  waiting_room?: boolean
  max_participants?: number
  add_invitees?: Array<{ type: string; user_id?: string; username?: string; display_name?: string; email?: string }>
  remove_invitee_ids?: string[]
}

type LivekitModule = typeof import('livekit-client')
let _lk: LivekitModule | null = null
let _lkLoading: Promise<LivekitModule> | null = null

/** livekit-client 지연 로드(한 번만). 통화 시작·회의 화면 진입 때 부른다 */
export function loadLivekit(): Promise<LivekitModule> {
  if (_lk) return Promise.resolve(_lk)
  _lkLoading ??= import('livekit-client').then((m) => { _lk = m; return m }, (e) => { _lkLoading = null; throw e })
  return _lkLoading
}

/** 이미 로드된 livekit-client(방이 있는 경로 전용) */
function lk(): LivekitModule {
  if (!_lk) throw new Error('livekit-client not loaded')
  return _lk
}

export interface ParticipantTrack {
  identity: string
  name: string
  videoTrack: any | null
  audioTrack: any | null
  screenTrack: any | null
  isMuted: boolean
  isLocal: boolean
  isSpeaking: boolean
  connectionQuality: string   // excellent | good | poor | lost | unknown
}

export interface PendingReq {
  id: string
  nickname: string
  created_at: number
}

export interface MeetingChatMessage {
  id: string
  type: 'chat'
  sender: string
  text: string
  ts: number
  isLocal: boolean
}

export type MeetingConnectionState = 'connected' | 'reconnecting' | 'rejoining' | 'disconnected'

export interface MeetingsState {
  rooms: RoomInfo[]
  loading: boolean
  error: string | null
  currentRoom: Room | null
  currentRoomName: string | null
  isHost: boolean
  connected: boolean
  /** connected 하나로는 '끊겼다'와 '다시 붙는 중'을 구분할 수 없었다. */
  connectionState: MeetingConnectionState
  rejoinAttempt: number
  /** 통화 등으로 마이크 트랙이 끊겼을 때 */
  micInterrupted: boolean
  /**
   * 저쪽에서 끝났다(호스트가 회의를 종료했거나 나를 내보냄). 되붙을 수 없는 끊김이라 "연결이 끊겼습니다 · 재시도"가
   * 아니라 종료 화면으로 가야 한다 — 회의 화면이 이 값을 보고 넘긴다. leaveRoom·새 접속이 지운다.
   */
  remoteEnded: boolean
  participants: ParticipantTrack[]
  cameraEnabled: boolean
  micEnabled: boolean
  screenShareEnabled: boolean
  blurEnabled: boolean
  /** 가상배경(이미지) */
  vbgEnabled: boolean
  /** 배경 처리 중(공용) */
  blurBusy: boolean
  /** Krisp 노이즈 제거 — 기본 켬. 미지원 브라우저면 접속 시 자동으로 꺼진다. */
  noiseEnabled: boolean
  noiseBusy: boolean
  noiseSupported: boolean
  /** Egress 녹화 중 */
  recording: boolean
  recordingBusy: boolean
  /**
   * 앱 수준 통화 세션 — 접속에 성공한 순간 켜지고, 직접 나가거나 방이 끝나면(되붙지 않는 끊김) 꺼진다.
   * 재입장 중·재입장 실패(연결 끊김)도 "통화 중"으로 본다 — 미니 창에서 회의 화면으로 돌아가 다시 시도할 수 있게.
   */
  inCall: boolean
  callStartedAt: number | null
  /** 호스트: 대기 중인 참가 신청 */
  pendingRequests: PendingReq[]
  // 채팅
  chatMessages: MeetingChatMessage[]
  unreadChat: number
}

/** Vue 판 useState('meetings-*') 들 */
/** 이 탭에서 Krisp 가 이미 실패했나(_markKrispUnavailable) — 스토어 초기값보다 먼저 정의 */
const KRISP_OFF_KEY = 'meet.krisp.unavailable'
function _krispKnownUnavailable(): boolean {
  try { return sessionStorage.getItem(KRISP_OFF_KEY) === '1' } catch { return false }
}

export const meetingsStore = createStore<MeetingsState>()(() => ({
  rooms: [],
  loading: false,
  error: null,
  currentRoom: null,
  currentRoomName: null,
  isHost: false,
  connected: false,
  connectionState: 'disconnected',
  rejoinAttempt: 0,
  micInterrupted: false,
  remoteEnded: false,
  participants: [],
  cameraEnabled: true,
  micEnabled: true,
  screenShareEnabled: false,
  blurEnabled: false,
  vbgEnabled: false,
  blurBusy: false,
  noiseEnabled: !_krispKnownUnavailable(),
  noiseBusy: false,
  noiseSupported: !_krispKnownUnavailable(),
  recording: false,
  recordingBusy: false,
  inCall: false,
  callStartedAt: null,
  pendingRequests: [],
  chatMessages: [],
  unreadChat: 0,
}))

const S = () => meetingsStore.getState()
const set = (p: Partial<MeetingsState>) => meetingsStore.setState(p)

/** Vue 에서 바깥이 `x.value = v` 하던 자리(Nuxt useState 는 어디서나 쓸 수 있었다) */
export const setMeetingsState = (p: Partial<MeetingsState>) => set(p)
export const setIsHost = (v: boolean) => set({ isHost: v })
export const setMeetingsError = (v: string | null) => set({ error: v })

// ─── 앱 수준 통화 세션(미니 통화 창 P-8) ───
// 예전엔 접속 정보·재입장 타이머·화면 꺼짐 방지가 useMeetings() 를 부른 컴포넌트(회의 화면)에 묶여 있어서
// 화면을 떠나면 같이 사라졌다. 통화는 한 번에 하나뿐이므로 모듈 단위로 올려, 회의 화면을 떠나
// 다른 화면으로 가도(미니 창) 끊김 재입장·화면 꺼짐 방지·창 닫기 퇴장이 계속 돈다.
export interface ConnectOptions {
  cameraEnabled?: boolean
  micEnabled?: boolean
  selectedCameraId?: string
  selectedMicId?: string
  selectedSpeakerId?: string
}
// 끊겼을 때 되붙기 위한 마지막 접속 정보. leaveRoom 이 비우므로 의도적 퇴장에서는 재입장이 돌지 않는다.
let _lastConn: { wsUrl: string; token: string; opts?: ConnectOptions } | null = null
let _rejoinTimer: ReturnType<typeof setTimeout> | null = null
// 접속 세대 번호 — 새 입장·재입장 시도·퇴장·취소가 올린다. 진행 중이던 접속은 기다림(토큰·connect)에서 돌아와
// 세대가 바뀌어 있으면 스스로 접는다. 이게 없던 동안엔 [참여하기] 연속 클릭이 방 두 개에 붙어 하나가 화면 없이
// 마이크·카메라를 내보냈고, 접속 도중 취소·나가기를 해도 접속이 뒤늦게 완료돼 통화가 붙었다.
let _connSeq = 0
// 사용자가 시작한 입장(joinRoom·joinRoomWithToken)이 진행 중인 수 — 화면을 떠날 때 그것만 취소한다(자동 재입장은 그대로)
let _userJoins = 0

/** 접속이 취소됨(더 새 시도·퇴장·화면 이탈). 실패가 아니므로 호출부는 오류 안내를 띄우지 않는다 */
export class JoinCancelledError extends Error {
  cancelled = true
  constructor() { super('join cancelled') }
}
export const isJoinCancelled = (e: unknown): boolean => !!(e && typeof e === 'object' && (e as { cancelled?: boolean }).cancelled === true)

/** 회의·초대 입장 화면이 내려갈 때: 아직 접속 중인 입장을 접는다(접속이 끝난 통화는 건드리지 않는다) */
export function cancelPendingJoin() {
  if (_userJoins > 0) _connSeq++
}
let _vbgImageUrl = ''  // 현재 가상배경 이미지 URL(object URL)
// 화면 꺼짐 방지 — 컴포넌트 수명에 두면 회의 화면이 내려갈 때 풀려 버린다. 앱 수준으로 한 번만 만든다.
let _wakeLock: WakeLockHandle | null = null
function _sessionWakeLock() {
  if (!_wakeLock) _wakeLock = createWakeLock()
  return _wakeLock
}
// 문서 전역 리스너(탭 복귀 재시도·창 닫기 퇴장)는 한 번만 단다.
let _sessionOps: { onVisible: () => void; onUnload: () => void } | null = null
let _docListeners = false
function _bindDocListeners() {
  if (_docListeners) return
  _docListeners = true
  document.addEventListener('visibilitychange', () => _sessionOps?.onVisible())
  window.addEventListener('beforeunload', () => _sessionOps?.onUnload())
}

// 장치 목록(정규화·중복제거) — 회의 중 핫플러그 갱신에도 쓴다
const deviceList = mediaDevicesApi()
// 모바일 앱에서만: 회의를 OS 통화로 등록(전화 수신 시 보류/복귀, 백그라운드 유지)
const nativeMeeting = nativeMeetingApi
const t = (key: string, a?: Record<string, unknown>) => i18n.t(key, a)

// ─── Room 목록 (인증 사용자) ───

export const fetchRooms = async () => {
  set({ loading: true, error: null })
  try {
    const data = await $fetch<{ rooms: RoomInfo[] }>('/api/meetings/rooms', {
      credentials: 'include',
    })
    set({ rooms: data.rooms })
  } catch (e: any) {
    set({ error: e?.data?.detail || t('meetings.fetchRoomsError') })
  } finally {
    set({ loading: false })
  }
}

export const createRoom = async (
  name: string,
  opts?: {
    invitees?: Array<{ type: string; user_id?: string; username?: string; display_name?: string; email?: string }>
    scheduled_at?: string | null
    duration_minutes?: number
    password?: string | null
    waiting_room?: boolean
    description?: string | null
    add_to_calendar?: boolean
  },
): Promise<RoomInfo> => {
  const data = await $fetch<RoomInfo>('/api/meetings/rooms', {
    method: 'POST',
    body: {
      name,
      max_participants: 10,
      invitees: opts?.invitees || [],
      scheduled_at: opts?.scheduled_at || null,
      duration_minutes: opts?.duration_minutes || 60,
      password: opts?.password || null,
      // 서버 기본값(대기실 켬 · 예약이면 내 캘린더에 추가)과 같게
      waiting_room: opts?.waiting_room ?? true,
      description: opts?.description || null,
      add_to_calendar: opts?.add_to_calendar ?? true,
    },
    credentials: 'include',
  })
  await fetchRooms()
  return data
}

/** 회의 상세(호스트·초대받은 사람) — 초대 대상과 각자의 응답 */
export const getMeeting = (meetingId: string) =>
  $fetch<MeetingDetail>(`/api/meetings/by-id/${encodeURIComponent(meetingId)}`, { credentials: 'include' })

/** 회의 종료 화면 "이번 회의" 카드의 서버 쪽 값(GET /rooms/{name}/summary — 볼 수 없으면 404) */
export interface MeetingSummaryInfo {
  name: string
  title: string
  host_name: string
  is_host: boolean
  chat_channel_id: string | null
  channel_name: string | null
  calendar_event_id: string | null
  scheduled_at: string | null
  started_at: string | null
  ended_at: string | null
}

export const getMeetingSummary = (name: string) =>
  $fetch<MeetingSummaryInfo>(`/api/meetings/rooms/${encodeURIComponent(name)}/summary`, { credentials: 'include' })

/** 회의 수정(호스트) */
export const updateRoom = async (name: string, patch: MeetingUpdate): Promise<MeetingDetail> => {
  const d = await $fetch<MeetingDetail>(`/api/meetings/rooms/${encodeURIComponent(name)}`, {
    method: 'PATCH', body: patch, credentials: 'include',
  })
  await fetchRooms()
  return d
}

/** 회의 종료(호스트) — 모두 내보내고 지난 회의로 */
export const endRoom = async (name: string) => {
  await $fetch(`/api/meetings/rooms/${encodeURIComponent(name)}/end`, { method: 'POST', credentials: 'include' })
  await fetchRooms()
}

/** 내 응답(초대받은 사람). 목록 행을 바로 고치고, 같은 회의 초대 알림은 읽음 처리 */
export const rsvpMeeting = async (meetingId: string, response: MeetingRsvp) => {
  await $fetch(`/api/meetings/by-id/${encodeURIComponent(meetingId)}/rsvp`, {
    method: 'POST', body: { response }, credentials: 'include',
  })
  set({
    rooms: S().rooms.map((r) => {
      if (r.meeting_id !== meetingId) return r
      const was = r.my_response === 'accepted'
      const now = response === 'accepted'
      return { ...r, my_response: response, accepted_count: Math.max(0, (r.accepted_count || 0) + (now ? 1 : 0) - (was ? 1 : 0)) }
    }),
  })
  markActionDone(`/api/meetings/by-id/${meetingId}/rsvp`).catch(() => {})
}

export const deleteRoom = async (name: string, meetingId?: string | null) => {
  // 같은 방 이름이 여러 번 끝났을 수 있다 — 지난 회의 행은 meeting_id 로 그 행만 지운다
  await $fetch(`/api/meetings/rooms/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    credentials: 'include',
    ...(meetingId ? { query: { meeting_id: meetingId } } : {}),
  })
  await fetchRooms()
}

// ─── LiveKit 연결 (공통) ───

function buildParticipantTrack(p: Participant, isLocal: boolean): ParticipantTrack {
  let videoTrack: any = null
  let audioTrack: any = null
  let screenTrack: any = null
  let isMuted = true

  p.trackPublications.forEach((pub) => {
    if (!pub.track) return
    if (pub.source === lk().Track.Source.Camera) videoTrack = pub.track
    else if (pub.source === lk().Track.Source.Microphone) {
      audioTrack = pub.track
      isMuted = pub.isMuted
    } else if (pub.source === lk().Track.Source.ScreenShare) screenTrack = pub.track
  })

  return { identity: p.identity, name: p.name || p.identity, videoTrack, audioTrack, screenTrack, isMuted, isLocal, isSpeaking: !!p.isSpeaking, connectionQuality: p.connectionQuality || 'unknown' }
}

function refreshParticipants() {
  const room = S().currentRoom
  if (!room) { set({ participants: [] }); return }
  const list: ParticipantTrack[] = []
  list.push(buildParticipantTrack(room.localParticipant, true))
  room.remoteParticipants.forEach((p) => {
    // 녹화(Egress)·에이전트 등 비-사람 참가자는 타일에 표시하지 않음(녹화 시 유령 참가자 방지)
    if (p.kind === lk().ParticipantKind.EGRESS || p.kind === lk().ParticipantKind.AGENT) return
    if ((p.identity || '').startsWith('EG_')) return
    list.push(buildParticipantTrack(p, false))
  })
  set({ participants: list })
  // 브라우저의 "공유 중지"로 끝내면 SDK 가 트랙만 내린다 — 버튼 상태를 실제 송출에 맞춘다
  // (예전엔 버튼이 "공유 중"으로 남아 다시 공유하려면 두 번 눌러야 했다).
  const sharing = !!room.localParticipant.isScreenShareEnabled
  if (S().screenShareEnabled !== sharing) set({ screenShareEnabled: sharing })
}

// 채팅 DataChannel 설정
function setupChat(room: Room) {
  const decoder = new TextDecoder()
  room.on(lk().RoomEvent.DataReceived, (payload: Uint8Array, participant?: Participant) => {
    try {
      const data = JSON.parse(decoder.decode(payload))
      const msg = data?.type === 'chat' ? chatMessageFrom(data, participant, room.localParticipant.identity) : null
      if (msg) {
        set({ chatMessages: [...S().chatMessages, msg] })
        if (!msg.isLocal) {
          set({ unreadChat: S().unreadChat + 1 })
        }
      }
    } catch { /* ignore non-chat data */ }
  })
}

let _chatSeq = 0
/**
 * 받은 채팅 데이터 → 화면에 그릴 메시지. 보낸 사람은 payload 가 아니라 LiveKit 이 알려 준 참가자에서 읽는다 —
 * payload 의 sender 를 믿으면 손님이 호스트 이름으로 말할 수 있다. 글은 문자열로 굳히고 길이를 자른다
 * (객체가 오면 React 가 그리다 죽어 채팅을 연 모든 참가자의 화면이 내려갔다). 못 쓰는 데이터면 null.
 */
export function chatMessageFrom(
  data: { text?: unknown; ts?: unknown },
  participant: { identity?: string; name?: string } | undefined,
  localIdentity: string,
): MeetingChatMessage | null {
  if (!participant?.identity) return null   // 서버 API 가 보낸 데이터 등 — 누가 말했는지 모르는 글은 싣지 않는다
  if (typeof data.text !== 'string') return null
  const text = data.text.slice(0, 500)
  if (!text.trim()) return null
  const ts = typeof data.ts === 'number' && Number.isFinite(data.ts) ? data.ts : Date.now()
  return {
    id: `${ts}-${participant.identity}-${++_chatSeq}`,
    type: 'chat',
    sender: String(participant.name || participant.identity).slice(0, 60),
    text,
    ts,
    isLocal: participant.identity === localIdentity,
  }
}

export function sendChatMessage(text: string) {
  const room = S().currentRoom
  if (!room || !text.trim()) return
  const encoder = new TextEncoder()
  const msg = {
    type: 'chat' as const,
    sender: room.localParticipant.name || room.localParticipant.identity,
    text: text.trim(),
    ts: Date.now(),
  }
  room.localParticipant.publishData(encoder.encode(JSON.stringify(msg)), { reliable: true })
  // 로컬 메시지 즉시 추가
  set({
    chatMessages: [...S().chatMessages, {
      id: `${msg.ts}-local`,
      ...msg,
      isLocal: true,
    }],
  })
}

export function clearUnreadChat() {
  set({ unreadChat: 0 })
}

// 오디오 상한. 요청대로 320k 를 넣지만 실효는 그보다 훨씬 낮다:
//  (a) echoCancellation 을 켜면 크롬이 모노로 다운믹스하고 Krisp 도 모노다.
//      모노 Opus 는 128k 근처에서 이미 투명해서 320k 는 헤드룸일 뿐이고,
//      크롬이 SDP maxaveragebitrate 로 다시 클램프한다.
//  (b) RED 를 켜면 이전 패킷을 함께 실어 업링크가 사실상 2배가 된다.
//      10인 회의면 다운링크가 ~6Mbps 까지 간다. 현실적 상한은 128~192k.
const AUDIO_MAX_BITRATE = 320_000

const REJOIN_BACKOFF = [1_000, 2_000, 4_000, 8_000, 16_000]

async function _onNativeEvent(ev: NativeMeetingEvent) {
  const room = S().currentRoom
  if (ev.type === 'hold') {
    // 일반 전화가 왔다. OS 가 마이크를 가져가므로 송출을 멈추고, 끝나면 unhold 로 되살린다.
    // micEnabled 는 그대로 둔다 — 사용자가 끈 게 아니다.
    set({ micInterrupted: true })
    if (room && S().micEnabled) {
      try { await room.localParticipant.setMicrophoneEnabled(false) } catch { /* noop */ }
    }
  } else if (ev.type === 'unhold') {
    await reacquireMic()
  } else if (ev.type === 'disconnect' || ev.type === 'leave') {
    // 블루투스 헤드셋 통화 종료 버튼, 알림의 "나가기"
    await leaveRoom()
  }
}

/** 같은 identity 로 곧장 되붙으면 서버가 이전 세션을 정리하는 동안 DUPLICATE_IDENTITY 가 올 수 있다 */
function finalReasons(): Set<number> {
  const { DisconnectReason: R } = lk()
  return new Set<number>([R.CLIENT_INITIATED, R.ROOM_DELETED, R.PARTICIPANT_REMOVED])
}

function _cancelRejoin() {
  if (_rejoinTimer) { clearTimeout(_rejoinTimer); _rejoinTimer = null }
}

async function _tryRejoin() {
  if (!_lastConn) { set({ connectionState: 'disconnected' }); return }
  const n = S().rejoinAttempt
  if (n >= REJOIN_BACKOFF.length) {
    set({ connectionState: 'disconnected' })
    return
  }
  set({ connectionState: 'rejoining', rejoinAttempt: n + 1 })
  _cancelRejoin()
  _rejoinTimer = setTimeout(async () => {
    const c = _lastConn
    if (!c) { set({ connectionState: 'disconnected' }); return }
    try {
      // 마이크·카메라는 입장 때 값이 아니라 "지금" 값으로 — 회의 중 음소거한 사람이 재입장으로 다시 송출되면 안 된다.
      // (회의 중 바꾼 장치는 switchActiveDevice 가 c.opts 에 적어 둔다)
      const opts = { ...c.opts, cameraEnabled: S().cameraEnabled, micEnabled: S().micEnabled }
      await connectToRoom(c.wsUrl, c.token, opts, ++_connSeq)
      set({ rejoinAttempt: 0 })
    } catch (e) {
      // 취소(나가기·더 새 시도)는 실패가 아니다 — 다시 붙지 않는다
      if (!isJoinCancelled(e)) void _tryRejoin()
    }
  }, REJOIN_BACKOFF[n])
}

/** 탭이 다시 보이면 기다리지 말고 한 번 바로 시도한다 */
function _onVisibleRetry() {
  if (document.visibilityState !== 'visible') return
  // 리스너는 문서에 하나만 달려 있고(_bindDocListeners), 접속 중일 때만 손댄다.
  if (!_lastConn) return
  if (S().connectionState === 'rejoining') {
    set({ rejoinAttempt: 0 })
    _cancelRejoin()
    void _tryRejoin()
  }
  if (S().micInterrupted) {
    setTimeout(() => { void reacquireMic() }, 1_000)
  }
}
/** 창·탭을 닫으면 퇴장(회의 화면이든 미니 창이든) */
function _onUnloadLeave() {
  if (S().connected) void leaveRoom()
}

/**
 * Krisp(@livekit/krisp-noise-filter)는 LiveKit Cloud 전용 — 접속한 서버의 /settings 로 인증·모델 주소를 받는다.
 * 셀프호스팅 livekit-server 엔 그게 없어 늘 실패한다(404). 예전엔 실패를 삼켜 버튼이 계속 살아 있고,
 * 입장마다 기본 켬으로 같은 실패를 반복했으며, 브라우저 잡음 억제까지 꺼 둔 채였다.
 * 한 번 실패하면 이 탭(세션) 동안 "쓸 수 없음"으로 두고 브라우저 기본 잡음 억제로 돌린다.
 */
function _markKrispUnavailable(track: any) {
  const first = S().noiseSupported !== false
  try { sessionStorage.setItem(KRISP_OFF_KEY, '1') } catch { /* 저장소 막힘 — 이번 화면만 */ }
  set({ noiseSupported: false, noiseEnabled: false })
  // Krisp 를 전제로 꺼 둔 브라우저 잡음 억제를 다시 켠다
  try { void track?.mediaStreamTrack?.applyConstraints?.({ noiseSuppression: true }) } catch { /* noop */ }
  if (first) addToast('info', t('meetings.controls.noiseUnsupported'))
}

/** Krisp 노이즈 필터를 현재 마이크 트랙에 건다. 성공 여부를 돌려준다. */
async function _applyKrisp(): Promise<boolean> {
  if (S().noiseSupported === false) return false
  let track: any = null
  try {
    track = await _localMicTrack()
    if (!track) return false
    const { KrispNoiseFilter, isKrispNoiseFilterSupported } = await import('@livekit/krisp-noise-filter')
    if (!isKrispNoiseFilterSupported()) {
      _markKrispUnavailable(track)
      return false
    }
    await track.setProcessor(KrispNoiseFilter())
    return true
  } catch (e) {
    console.warn('[meet] Krisp 적용 실패', e)
    _markKrispUnavailable(track)
    return false
  }
}

async function connectToRoom(wsUrl: string, token: string, opts: ConnectOptions | undefined, my: number) {
  const { Room, RoomEvent, VideoPresets } = await loadLivekit()
  if (my !== _connSeq) throw new JoinCancelledError()
  const wakeLock = _sessionWakeLock()
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    videoCaptureDefaults: {
      // ICE-TCP(서버가 Docker Desktop UDP 이슈로 TCP 강제) 환경에선 고해상도/고비트레이트
      // 영상이 TCP head-of-line 블로킹으로 연결을 끊어버림 → 720p/저비트레이트로 안정화.
      resolution: VideoPresets.h720.resolution,
      facingMode: 'user',
      ...(opts?.selectedCameraId ? { deviceId: opts.selectedCameraId } : {}),
    },
    audioCaptureDefaults: {
      ...(opts?.selectedMicId ? { deviceId: opts.selectedMicId } : {}),
      echoCancellation: true,
      autoGainControl: true,
      // Krisp 가 붙으면 브라우저 NS 는 이중 처리라 끈다. 못 쓰는 브라우저면 폴백.
      noiseSuppression: !S().noiseSupported,
    },
    // 장치 설정에서 고른 스피커. 예전엔 emit 까지 왔다가 여기서 버려졌다.
    ...(opts?.selectedSpeakerId ? { audioOutput: { deviceId: opts.selectedSpeakerId } } : {}),
    publishDefaults: {
      audioPreset: { maxBitrate: AUDIO_MAX_BITRATE },
      // RED: 앞 패킷을 겹쳐 보내 한두 패킷 손실을 덮는다(대역폭 2배). 서버 codecs 에 audio/red 등록돼 있음.
      red: true,
      // DTX 는 무음 구간 비트레이트를 떨어뜨리는데, 말 시작 앞부분이 씹히는 원인이라 끈다.
      dtx: false,
      videoEncoding: {
        maxBitrate: 1_200_000,
        maxFramerate: 24,
      },
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
      screenShareEncoding: {
        maxBitrate: 2_500_000,
        maxFramerate: 15,
      },
      // VP9 SVC. VP8 을 쓰던 이유는 TCP 단일연결(ICE-TCP 강제) 시절의
      // head-of-line 블로킹이었는데, UDP 가 살아났고 TURN 까지 붙어 전제가 바뀌었다.
      videoCodec: 'vp9',
      // VP9 을 못 받는 구독자(구형 iOS 등)에게는 VP8 로 따로 실어 준다
      backupCodec: { codec: 'vp8', encoding: { maxBitrate: 800_000, maxFramerate: 20 } },
    },
  })

  room.on(RoomEvent.TrackSubscribed, () => refreshParticipants())
  room.on(RoomEvent.TrackUnsubscribed, () => refreshParticipants())
  room.on(RoomEvent.TrackMuted, () => refreshParticipants())
  room.on(RoomEvent.TrackUnmuted, () => refreshParticipants())
  room.on(RoomEvent.ParticipantConnected, () => refreshParticipants())
  room.on(RoomEvent.ParticipantDisconnected, () => refreshParticipants())
  room.on(RoomEvent.ActiveSpeakersChanged, () => refreshParticipants())
  room.on(RoomEvent.ConnectionQualityChanged, () => refreshParticipants())
  room.on(RoomEvent.LocalTrackPublished, () => refreshParticipants())
  // 장치 핫플러그(헤드셋 연결/해제) → 목록 갱신
  room.on(RoomEvent.MediaDevicesChanged, () => { void deviceList.refresh() })
  room.on(RoomEvent.LocalTrackUnpublished, () => refreshParticipants())
  // 일시적 시그널 끊김(RR_SIGNAL_DISCONNECTED) → SDK가 자동 재접속하는 동안 UI 유지.
  // 아래 세 핸들러는 "지금 세션의 방"일 때만 상태를 건드린다 — 접다 만 접속(취소·중복)의 방이 내는 이벤트가
  // 살아 있는 세션의 상태를 지우면 안 된다.
  const mine = () => S().currentRoom === room
  room.on(RoomEvent.Reconnecting, () => { if (mine()) set({ connectionState: 'reconnecting' }) })
  room.on(RoomEvent.Reconnected, () => {
    if (!mine()) return
    set({ connected: true, connectionState: 'connected' })
    refreshParticipants()
  })
  room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
    if (!mine()) return
    set({ connected: false, currentRoom: null, participants: [] })
    // 내가 나간 것도, 방이 사라진 것도 아니면 되붙는다.
    if (_lastConn && (reason === undefined || !finalReasons().has(reason))) {
      void _tryRejoin()
    } else {
      // _lastConn 이 남아 있으면 내가 나간 게 아니라 저쪽에서 끝난 것(방 종료·내보내짐) — 회의 화면이 종료 화면으로 넘긴다
      const remote = !!_lastConn
      _lastConn = null
      set({ connectionState: 'disconnected', currentRoomName: null, inCall: false, callStartedAt: null, ...(remote ? { remoteEnded: true } : {}) })
      void wakeLock.release()
      void nativeMeeting.stop()
    }
  })
  // 장치 오류(권한 회수, 장치 사라짐)도 마이크 중단으로 본다
  room.on(RoomEvent.MediaDevicesError, () => { set({ micInterrupted: true }) })

  setupChat(room)

  // peerConnectionTimeout/websocketTimeout 확대 — TCP 경로가 느릴 때 너무 일찍 실패 처리 방지
  await room.connect(wsUrl, token, {
    autoSubscribe: true,
    peerConnectionTimeout: 30_000,
    websocketTimeout: 30_000,
  })
  if (my !== _connSeq) {
    // 기다리는 사이 취소됐거나(나가기·화면 이탈) 더 새 접속이 시작됐다 — 이 방은 버린다.
    // 아직 세션의 방이 아니라서(mine() 거짓) 위 핸들러는 상태를 건드리지 않는다.
    try { await room.disconnect() } catch { /* noop */ }
    throw new JoinCancelledError()
  }

  set({ currentRoom: room, connected: true, connectionState: 'connected', remoteEnded: false })
  _lastConn = { wsUrl, token, opts }
  // 재입장으로 다시 불려도 통화 시작 시각은 그대로(미니 창 "12:43")
  if (!S().inCall) set({ inCall: true, callStartedAt: Date.now() })
  _sessionOps = { onVisible: _onVisibleRetry, onUnload: _onUnloadLeave }
  _bindDocListeners()
  void wakeLock.request()

  // 장치 테스트에서 선택한 on/off 상태 반영
  const wantCamera = opts?.cameraEnabled ?? true
  // 재입장(_tryRejoin)에서 다시 불려도 네이티브 쪽이 기존 통화를 재사용한다
  void nativeMeeting.start(S().currentRoomName || t('nav.meetings'), wantCamera, _onNativeEvent)
  const wantMic = opts?.micEnabled ?? true

  if (wantCamera || wantMic) {
    try {
      if (wantCamera && wantMic) {
        await room.localParticipant.enableCameraAndMicrophone()
      } else if (wantCamera) {
        await room.localParticipant.setCameraEnabled(true)
      } else {
        await room.localParticipant.setMicrophoneEnabled(true)
      }
      set({ cameraEnabled: wantCamera, micEnabled: wantMic })
      // 한쪽만 켜야 하는 경우 나머지 끄기
      if (wantCamera && !wantMic) {
        await room.localParticipant.setMicrophoneEnabled(false)
        set({ micEnabled: false })
      } else if (!wantCamera && wantMic) {
        await room.localParticipant.setCameraEnabled(false)
        set({ cameraEnabled: false })
      }
    } catch {
      set({ cameraEnabled: false, micEnabled: false })
    }
  } else {
    set({ cameraEnabled: false, micEnabled: false })
  }
  // 장치를 켜는 사이 나갔으면(leaveRoom 이 이 방을 이미 끊었다) 여기서 멈춘다
  if (S().currentRoom !== room) return

  // 배경 흐림·가상 배경은 카메라 트랙에 붙는다. 재입장으로 트랙이 새로 생겼으니 다시 건다
  // (카메라가 꺼져 있으면 켤 때 toggleCamera 가 건다).
  if (S().cameraEnabled) await _restoreBg()

  // 마이크가 켜져 있으면 노이즈 제거를 바로 건다(기본 켬). 실패하면 조용히 끈다.
  if (S().micEnabled && S().noiseEnabled) {
    set({ noiseBusy: true })
    try {
      const ok = await _applyKrisp()
      if (!ok) set({ noiseEnabled: false })
    } finally {
      set({ noiseBusy: false })
    }
  }

  set({ screenShareEnabled: false, micInterrupted: false })
  if (S().micEnabled) void _watchMicTrack()
  void deviceList.refresh()
  refreshParticipants()
}

// ─── 마이크 중단(전화 수신 등) 감지·복구 ───

/**
 * 전화가 오면 OS 가 마이크를 가져간다. iOS 는 보통 mediaStreamTrack 이 mute 되고,
 * 안드로이드는 트랙이 ended 로 죽는 쪽이 흔하다. 둘 다 본다.
 */
async function _watchMicTrack() {
  const track = await _localMicTrack()
  const mst = track?.mediaStreamTrack
  if (!track || !mst) return
  track.off?.(lk().TrackEvent.Ended, _onMicEnded)
  track.on?.(lk().TrackEvent.Ended, _onMicEnded)
  mst.onmute = () => { set({ micInterrupted: true }) }
  mst.onunmute = () => { void reacquireMic() }
}

function _onMicEnded() {
  set({ micInterrupted: true })
}

/** 끊긴 마이크를 다시 잡는다. 배너 버튼과 unmute·복귀 이벤트가 호출한다. */
export const reacquireMic = async () => {
  const room = S().currentRoom
  if (!room || !S().micEnabled) return
  try {
    const track = await _localMicTrack()
    const mst = track?.mediaStreamTrack
    if (track && (mst?.readyState === 'ended' || mst?.muted)) {
      await track.restartTrack()
    } else {
      await room.localParticipant.setMicrophoneEnabled(false)
      await room.localParticipant.setMicrophoneEnabled(true)
    }
    if (S().noiseEnabled) { try { await _applyKrisp() } catch { /* noop */ } }
    await _watchMicTrack()
    set({ micInterrupted: false })
    refreshParticipants()
  } catch (e) {
    console.warn('[meet] 마이크 재연결 실패', e)
  }
}

/**
 * 회의 중 장치 전환. LiveKit 이 트랙을 새로 잡아 publish 까지 해 준다.
 * 마이크를 바꾸면 트랙이 갈리므로 Krisp 를 다시 건다.
 */
export const switchActiveDevice = async (kind: MediaDeviceKind, deviceId: string) => {
  const room = S().currentRoom
  if (!room || !deviceId) return
  await (room as any).switchActiveDevice(kind, deviceId)
  // 끊겨서 재입장할 때도 지금 고른 장치로 붙게 적어 둔다
  if (_lastConn) {
    const key = kind === 'videoinput' ? 'selectedCameraId' : kind === 'audioinput' ? 'selectedMicId' : 'selectedSpeakerId'
    _lastConn = { ..._lastConn, opts: { ..._lastConn.opts, [key]: deviceId } }
  }
  if (kind === 'audioinput') {
    if (S().noiseEnabled && S().micEnabled) {
      try { await _applyKrisp() } catch { /* noop */ }
    }
    await _watchMicTrack()
  }
  if (kind === 'videoinput') await _restoreBg()
  refreshParticipants()
}

export const getActiveDevice = (kind: MediaDeviceKind): string => {
  const room = S().currentRoom
  if (!room) return ''
  try { return (room as any).getActiveDevice(kind) || '' } catch { return '' }
}

// ─── 인증 사용자 참여 ───

export const getToken = async (roomName: string) => {
  return await $fetch<{ token: string; livekit_url: string; is_host: boolean }>(
    '/api/meetings/token',
    { method: 'POST', body: { room: roomName }, credentials: 'include' },
  )
}

/** 다른 회의에 들어가려는데 아직 통화 중이면(미니 창으로 내려 둔 통화) 먼저 나간다 — 방 두 개에 동시에 붙지 않게 */
// 음성 채널(useVoice) 같은 다른 통화 세션 — 회의에 들어갈 때 먼저 나가게 한다(한 번에 한 방). 그쪽이 등록한다.
let _externalLeaver: (() => Promise<void>) | null = null
export function registerExternalCallLeaver(fn: () => Promise<void>) { _externalLeaver = fn }

async function _leaveOtherCall(roomName: string) {
  // 세대 번호를 올리지 않는 퇴장 — 지금 진행 중인 이 입장까지 취소하면 안 된다
  if (S().currentRoom || (S().inCall && S().currentRoomName !== roomName)) await _leave()
  if (_externalLeaver) { try { await _externalLeaver() } catch { /* noop */ } }
}

export const joinRoom = async (roomName: string, opts?: ConnectOptions) => {
  const my = ++_connSeq
  _userJoins++
  try {
    const tokenData = await getToken(roomName)
    if (my !== _connSeq) throw new JoinCancelledError()
    await _leaveOtherCall(roomName)
    if (my !== _connSeq) throw new JoinCancelledError()
    // 룸 페이지는 fetchRooms 를 부르지 않으므로 rooms 목록으로 판정하면 늘 false 였다.
    // 토큰을 발급한 백엔드가 호스트 여부를 같이 알려준다.
    set({ currentRoomName: roomName, isHost: tokenData.is_host ?? false })
    await connectToRoom(tokenData.livekit_url, tokenData.token, opts, my)
  } finally {
    _userJoins--
  }
}

// ─── 외부인 (토큰 직접) ───

export const joinRoomWithToken = async (wsUrl: string, token: string, roomName: string, opts?: ConnectOptions) => {
  const my = ++_connSeq
  _userJoins++
  try {
    await _leaveOtherCall(roomName)
    if (my !== _connSeq) throw new JoinCancelledError()
    set({ currentRoomName: roomName, isHost: false })
    await connectToRoom(wsUrl, token, opts, my)
  } finally {
    _userJoins--
  }
}

// ─── 퇴장 ───

export const leaveRoom = async () => {
  // 진행 중인 접속(입장·재입장)이 있으면 접는다 — 나간 뒤에 접속이 완료돼 통화가 붙지 않게
  _connSeq++
  await _leave()
}

async function _leave() {
  const wakeLock = _sessionWakeLock()
  // beforeunload/Disconnected 핸들러가 되붙지 않도록 먼저 지운다
  _lastConn = null
  _cancelRejoin()
  set({ rejoinAttempt: 0, connectionState: 'disconnected', micInterrupted: false, inCall: false, callStartedAt: null, remoteEnded: false })
  void wakeLock.release()
  void nativeMeeting.stop()
  const room = S().currentRoom
  if (room) await room.disconnect()
  set({
    currentRoom: null,
    currentRoomName: null,
    connected: false,
    participants: [],
    isHost: false,
    pendingRequests: [],
    chatMessages: [],
    unreadChat: 0,
    cameraEnabled: true,
    micEnabled: true,
    screenShareEnabled: false,
    // 트랙에 붙어 있던 효과·방에 묶인 상태 — 다음 회의에 "켜짐"으로 넘어가면 실제와 어긋난다
    blurEnabled: false,
    vbgEnabled: false,
    recording: false,
  })
  if (_vbgImageUrl) { URL.revokeObjectURL(_vbgImageUrl); _vbgImageUrl = '' }
}

// ─── 미디어 토글 ───

// ─── 배경 블러(호스트 클라이언트에서 처리, GPU 우선 / CPU 폴백) ───
// @livekit/track-processors = MediaPipe Selfie Segmentation. WebGL(GPU) delegate 우선,
// 실패 시 WASM(CPU) 폴백. 서버(SFU)는 관여 안 함 — 블러된 프레임을 인코딩해 송출.
async function _localCameraTrack(): Promise<any | null> {
  const room = S().currentRoom
  if (!room) return null
  const pub = room.localParticipant.getTrackPublication(lk().Track.Source.Camera)
  return (pub?.track as any) || null
}

// GPU(WebGL) delegate 우선 → 실패 시 CPU(WASM) 폴백으로 프로세서 적용
async function _applyVideoProcessor(makeProc: (delegate: 'GPU' | 'CPU') => any): Promise<boolean> {
  const track = await _localCameraTrack()
  if (!track) return false
  try {
    await track.setProcessor(makeProc('GPU'))
  } catch (e) {
    console.warn('[meet] 배경효과 GPU 실패 → CPU 폴백', e)
    await track.setProcessor(makeProc('CPU'))
  }
  return true
}

async function _applyBlur(): Promise<boolean> {
  const { BackgroundBlur } = await import('@livekit/track-processors')
  return _applyVideoProcessor(d => BackgroundBlur(12, { delegate: d }))
}

async function _applyVbg(url: string): Promise<boolean> {
  const { VirtualBackground } = await import('@livekit/track-processors')
  return _applyVideoProcessor(d => VirtualBackground(url, { delegate: d }))
}

async function _removeBg() {
  const track = await _localCameraTrack()
  if (track) { try { await track.stopProcessor() } catch { /* noop */ } }
}

/**
 * 켜 둔 배경 효과를 새 카메라 트랙에 다시 건다(재입장·카메라 다시 켬·카메라 바꿈). 못 걸면 버튼을 내린다 —
 * "켜짐"으로 보이는데 배경이 그대로 나가는 일이 없게.
 */
async function _restoreBg() {
  if (!S().blurEnabled && !S().vbgEnabled) return
  const ok = await _reapplyBg().catch(() => false)
  if (!ok) set({ blurEnabled: false, vbgEnabled: false })
}

// 카메라 재활성 등에서 현재 배경 상태를 다시 적용. 걸렸으면 true(켜 둔 효과가 없어도 true)
async function _reapplyBg(): Promise<boolean> {
  if (S().blurEnabled) return _applyBlur()
  if (S().vbgEnabled) return _vbgImageUrl ? _applyVbg(_vbgImageUrl) : false
  return true
}

export const toggleBackgroundBlur = async () => {
  if (S().blurBusy) return
  const next = !S().blurEnabled
  set({ blurBusy: true })
  try {
    if (next) {
      const ok = await _applyBlur()
      if (!ok) return   // 카메라 꺼져 있으면 상태 변경 안 함
      set({ vbgEnabled: false })   // 블러↔이미지 상호배타
    } else {
      await _removeBg()
    }
    set({ blurEnabled: next })
  } catch (e) {
    console.error('[meet] 배경블러 토글 실패', e)
  } finally {
    set({ blurBusy: false })
    refreshParticipants()
  }
}

// 가상배경: 이미지 파일 선택 → object URL → VirtualBackground. 다시 부르면 해제.
export const setVirtualBackground = async (file: File | null) => {
  if (S().blurBusy) return
  set({ blurBusy: true })
  try {
    if (!file) {   // 해제
      await _removeBg()
      set({ vbgEnabled: false })
      if (_vbgImageUrl) { URL.revokeObjectURL(_vbgImageUrl); _vbgImageUrl = '' }
      return
    }
    if (_vbgImageUrl) URL.revokeObjectURL(_vbgImageUrl)
    _vbgImageUrl = URL.createObjectURL(file)
    const ok = await _applyVbg(_vbgImageUrl)
    if (!ok) return
    set({ vbgEnabled: true, blurEnabled: false })   // 상호배타
  } catch (e) {
    console.error('[meet] 가상배경 적용 실패', e)
  } finally {
    set({ blurBusy: false })
    refreshParticipants()
  }
}

// ─── 노이즈 제거(Krisp, 마이크 트랙 오디오 프로세서, WASM) ───
async function _localMicTrack(): Promise<any | null> {
  const room = S().currentRoom
  if (!room) return null
  const pub = room.localParticipant.getTrackPublication(lk().Track.Source.Microphone)
  return (pub?.track as any) || null
}

// ─── 회의 녹화(Egress, 호스트 전용) ───
export const toggleRecording = async () => {
  if (S().recordingBusy) return
  const name = S().currentRoomName
  if (!name) return
  set({ recordingBusy: true })
  try {
    const ep = S().recording ? 'stop' : 'start'
    const r = await $fetch<{ recording: boolean }>(
      `/api/meetings/rooms/${encodeURIComponent(name)}/recording/${ep}`, { method: 'POST' })
    set({ recording: r.recording })
  } catch (e: any) {
    // 회의 화면은 store.error 를 그리지 않는다 — 실패 이유를 토스트로 바로 보여 준다(예전엔 23초 돌다 말없이 원복)
    const msg = e?.data?.detail || t('meetings.recordError')
    set({ error: msg })
    addToast('error', msg)
    // 서버 상태가 화면과 달라서 실패했을 수 있다(이미 끝난 녹화를 멈추려 함 등) — 버튼을 서버 값에 맞춘다
    void fetchRecordingStatus()
  } finally {
    set({ recordingBusy: false })
  }
}

export const fetchRecordingStatus = async () => {
  const name = S().currentRoomName
  if (!name) return
  try {
    const r = await $fetch<{ recording: boolean }>(
      `/api/meetings/rooms/${encodeURIComponent(name)}/recording`)
    set({ recording: r.recording })
  } catch { /* noop */ }
}

export const toggleNoiseCancellation = async () => {
  if (S().noiseBusy) return
  const next = !S().noiseEnabled
  set({ noiseBusy: true })
  try {
    if (next) {
      const ok = await _applyKrisp()
      if (!ok) return
    } else {
      const track = await _localMicTrack()
      if (!track) return
      try { await track.stopProcessor() } catch { /* noop */ }
    }
    set({ noiseEnabled: next })
  } catch (e) {
    console.error('[meet] 노이즈 제거 토글 실패', e)
  } finally {
    set({ noiseBusy: false })
  }
}

export const toggleCamera = async () => {
  const room = S().currentRoom
  if (!room) return
  const enabled = !S().cameraEnabled
  await room.localParticipant.setCameraEnabled(enabled)
  set({ cameraEnabled: enabled })
  // 카메라를 다시 켜면 트랙이 새로 생기므로 배경효과(블러/이미지)가 켜져 있었으면 재적용
  if (enabled) await _restoreBg()
  refreshParticipants()
}

export const toggleMic = async () => {
  const room = S().currentRoom
  if (!room) return
  const enabled = !S().micEnabled
  await room.localParticipant.setMicrophoneEnabled(enabled)
  set({ micEnabled: enabled })
  // 마이크 재활성 시 노이즈 필터 재적용
  if (enabled) {
    if (S().noiseEnabled) { try { await _applyKrisp() } catch { /* noop */ } }
    await _watchMicTrack()
    set({ micInterrupted: false })
  }
  refreshParticipants()
}

export const toggleScreenShare = async () => {
  const room = S().currentRoom
  if (!room) return
  const enabled = !S().screenShareEnabled
  if (enabled) {
    await room.localParticipant.setScreenShareEnabled(true, {
      contentHint: 'detail',
      resolution: { width: 1920, height: 1080 },
    })
  } else {
    await room.localParticipant.setScreenShareEnabled(false)
  }
  set({ screenShareEnabled: enabled })
  refreshParticipants()
}

/**
 * 컨트롤 바의 마이크·카메라·화면 공유 버튼. 토글이 던지면(권한 거부·장치 없음·다른 앱이 사용 중) 이유를 토스트로 알린다 —
 * 예전엔 호출부가 버려서 버튼을 눌러도 아무 반응이 없었다. 화면 공유 선택 창을 그냥 닫은 것은 실패가 아니다.
 */
export const runMediaToggle = async (kind: 'mic' | 'camera' | 'screen') => {
  try {
    await (kind === 'mic' ? toggleMic() : kind === 'camera' ? toggleCamera() : toggleScreenShare())
  } catch (e: any) {
    console.warn('[meet] 토글 실패', kind, e)
    const denied = e?.name === 'NotAllowedError' || e?.name === 'SecurityError'
    if (kind === 'screen') {
      if (denied || e?.name === 'AbortError') return
      addToast('error', t('meetings.controls.screenFail'))
    } else if (kind === 'mic') {
      addToast('error', denied
        ? t('meetings.controls.micDenied')
        : t('meetings.controls.micFail'))
    } else {
      addToast('error', denied
        ? t('meetings.controls.cameraDenied')
        : t('meetings.controls.cameraFail'))
    }
    refreshParticipants()
  }
}

// ─── 호스트: 참가 신청 관리 ───

export const fetchPendingRequests = async () => {
  const name = S().currentRoomName
  if (!name || !S().isHost) return
  try {
    const data = await $fetch<PendingReq[]>(
      `/api/meetings/rooms/${encodeURIComponent(name)}/requests`,
      { credentials: 'include' },
    )
    set({ pendingRequests: data })
  } catch { /* ignore */ }
}

export const approveRequest = async (reqId: string) => {
  const name = S().currentRoomName
  if (!name) return
  await $fetch(
    `/api/meetings/rooms/${encodeURIComponent(name)}/requests/${reqId}/approve`,
    { method: 'POST', credentials: 'include' },
  )
  await fetchPendingRequests()
}

export const denyRequest = async (reqId: string) => {
  const name = S().currentRoomName
  if (!name) return
  await $fetch(
    `/api/meetings/rooms/${encodeURIComponent(name)}/requests/${reqId}/deny`,
    { method: 'POST', credentials: 'include' },
  )
  await fetchPendingRequests()
}

export const useMeetings = () => {
  const { track } = useTrackedStore(meetingsStore)
  return {
    get rooms() { return track('rooms') },
    get loading() { return track('loading') },
    get error() { return track('error') },
    get currentRoom() { return track('currentRoom') },
    get currentRoomName() { return track('currentRoomName') },
    get isHost() { return track('isHost') },
    get connected() { return track('connected') },
    get inCall() { return track('inCall') },
    get callStartedAt() { return track('callStartedAt') },
    get connectionState() { return track('connectionState') },
    get rejoinAttempt() { return track('rejoinAttempt') },
    get micInterrupted() { return track('micInterrupted') },
    get remoteEnded() { return track('remoteEnded') },
    reacquireMic,
    get participants() { return track('participants') },
    get cameraEnabled() { return track('cameraEnabled') },
    get micEnabled() { return track('micEnabled') },
    get screenShareEnabled() { return track('screenShareEnabled') },
    get blurEnabled() { return track('blurEnabled') },
    get vbgEnabled() { return track('vbgEnabled') },
    get blurBusy() { return track('blurBusy') },
    get noiseEnabled() { return track('noiseEnabled') },
    get noiseBusy() { return track('noiseBusy') },
    get noiseSupported() { return track('noiseSupported') },
    get recording() { return track('recording') },
    get recordingBusy() { return track('recordingBusy') },
    get pendingRequests() { return track('pendingRequests') },
    get chatMessages() { return track('chatMessages') },
    get unreadChat() { return track('unreadChat') },
    setIsHost, setMeetingsError, setMeetingsState,
    fetchRooms, createRoom, deleteRoom,
    getMeeting, updateRoom, endRoom, rsvpMeeting,
    getToken, joinRoom, joinRoomWithToken, leaveRoom,
    toggleCamera, toggleMic, toggleScreenShare,
    toggleBackgroundBlur, setVirtualBackground, toggleNoiseCancellation,
    switchActiveDevice, getActiveDevice,
    toggleRecording, fetchRecordingStatus,
    sendChatMessage, clearUnreadChat,
    fetchPendingRequests, approveRequest, denyRequest,
  }
}
