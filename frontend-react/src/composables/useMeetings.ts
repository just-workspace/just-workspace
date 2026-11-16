/**
 * 회의(LiveKit) — 방 목록 REST + 앱 수준 통화 세션.
 *
 * 모든 상태는 앱 전역 — meetingsStore 한 곳에 통합했다.
 * 접속 정보·재입장 타이머·화면 꺼짐 방지·문서 리스너는 모듈 수준 — 회의 화면을 벗어나도(미니 창) 통화가 유지된다.
 *
 * React: const { rooms, participants, connectionState, joinRoom, leaveRoom, toggleMic, ... } = useMeetings()
 *   - 값은 렌더 시점 값. 참조한 필드만 구독한다(useTrackedStore).
 *   - 외부에서 변경하는 상태: setIsHost(v)(회의 화면), setMeetingsError(v). 그 외는 setMeetingsState({ … }).
 * 컴포넌트 외부: meetingsStore.getState() / joinRoom()·leaveRoom() 등 export 함수
 */
// livekit-client 는 용량이 커서(메인 번들의 1/3) 통화 시작 시 지연 로드한다.
// 타입만 정적으로 import 하고, 값은 loadLivekit() 이후 lk() 로 사용한다. 방(Room)이 있는 경로는
// 반드시 connectToRoom 을 거치므로 lk() 가 이미 채워져 있다.
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
  /** 목록 "호스트 이름"·예정/진행 중/지난 회의 분류 */
  host_name?: string
  scheduled_at?: string | null
  duration_minutes?: number | null
  // ── DB 회의 저장소(예약 회의) — 이전 Redis 전용 방·채널 통화에는 meeting_id 가 없다 ──
  meeting_id?: string | null
  /** live | scheduled | ended | cancelled */
  status?: string
  title?: string
  description?: string | null
  waiting_room?: boolean
  /** 초대 대상자로서의 본인 응답(pending/accepted/declined/tentative). 호스트이거나 초대 대상이 아니면 null */
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

/** PATCH /rooms/{name} — 전송한 필드만 변경된다 */
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

/** livekit-client 지연 로드(1회만). 통화 시작·회의 화면 진입 시 호출한다 */
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
  /** connected 단독으로는 '끊겼다'와 '다시 붙는 중'을 구분할 수 없었다. */
  connectionState: MeetingConnectionState
  rejoinAttempt: number
  /** 통화 등으로 마이크 트랙이 중단된 경우 */
  micInterrupted: boolean
  /**
   * 상대 측에서 종료됨(호스트가 회의를 종료했거나 본인을 내보냄). 재접속이 불가한 끊김이므로 "연결이 끊겼습니다 · 재시도"가
   * 아닌 종료 화면으로 이동해야 한다 — 회의 화면이 이 값을 확인하여 전환한다. leaveRoom·새 접속 시 초기화된다.
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
  /** 잡음 제거 — 브라우저 기본 잡음 억제(noiseSuppression)를 활성화/비활성화한다. 기본값은 활성. */
  noiseEnabled: boolean
  noiseBusy: boolean
  /** Egress 녹화 중 */
  recording: boolean
  recordingBusy: boolean
  /**
   * 앱 수준 통화 세션 — 접속 성공 시점에 활성화되고, 직접 퇴장하거나 방이 종료되면(재접속하지 않는 끊김) 비활성화된다.
   * 재입장 중·재입장 실패(연결 끊김)도 "통화 중"으로 간주한다 — 미니 창에서 회의 화면으로 복귀하여 재시도할 수 있도록.
   */
  inCall: boolean
  callStartedAt: number | null
  /** 호스트: 대기 중인 참가 신청 */
  pendingRequests: PendingReq[]
  // 채팅
  chatMessages: MeetingChatMessage[]
  unreadChat: number
}

/** 앱 전역 회의 상태 */
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
  noiseEnabled: true,
  noiseBusy: false,
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

/** 외부에서 상태를 변경하는 진입점 */
export const setMeetingsState = (p: Partial<MeetingsState>) => set(p)
export const setIsHost = (v: boolean) => set({ isHost: v })
export const setMeetingsError = (v: string | null) => set({ error: v })

// ─── 앱 수준 통화 세션(미니 통화 창) ───
// 이전에는 접속 정보·재입장 타이머·화면 꺼짐 방지가 useMeetings() 를 호출한 컴포넌트(회의 화면)에 종속되어
// 화면을 벗어나면 함께 소멸했다. 통화는 동시에 1개뿐이므로 모듈 단위로 이전하여, 회의 화면을 벗어나
// 다른 화면으로 이동해도(미니 창) 끊김 재입장·화면 꺼짐 방지·창 닫기 퇴장이 계속 동작한다.
export interface ConnectOptions {
  cameraEnabled?: boolean
  micEnabled?: boolean
  selectedCameraId?: string
  selectedMicId?: string
  selectedSpeakerId?: string
}
// 끊김 시 재접속을 위한 마지막 접속 정보. leaveRoom 이 비우므로 의도적 퇴장에서는 재입장이 실행되지 않는다.
let _lastConn: { wsUrl: string; token: string; opts?: ConnectOptions } | null = null
let _rejoinTimer: ReturnType<typeof setTimeout> | null = null
// 접속 세대 번호 — 새 입장·재입장 시도·퇴장·취소 시 증가한다. 진행 중이던 접속은 대기(토큰·connect)에서 복귀했을 때
// 세대가 변경되어 있으면 자체 중단한다. 도입 이전에는 [참여하기] 연속 클릭으로 방 2개에 접속되어 한쪽이 화면 없이
// 마이크·카메라를 송출했고, 접속 도중 취소·나가기를 해도 접속이 뒤늦게 완료되어 통화가 연결되었다.
let _connSeq = 0
// 사용자가 시작한 입장(joinRoom·joinRoomWithToken) 중 진행 중인 건수 — 화면 이탈 시 해당 건만 취소한다(자동 재입장은 유지)
let _userJoins = 0

/** 접속 취소됨(더 최근 시도·퇴장·화면 이탈). 실패가 아니므로 호출부는 오류 안내를 표시하지 않는다 */
export class JoinCancelledError extends Error {
  cancelled = true
  constructor() { super('join cancelled') }
}
export const isJoinCancelled = (e: unknown): boolean => !!(e && typeof e === 'object' && (e as { cancelled?: boolean }).cancelled === true)

/** 회의·초대 입장 화면 언마운트 시: 접속 진행 중인 입장을 취소한다(접속이 완료된 통화는 변경하지 않는다) */
export function cancelPendingJoin() {
  if (_userJoins > 0) _connSeq++
}
let _vbgImageUrl = ''  // 현재 가상배경 이미지 URL(object URL)
// 화면 꺼짐 방지 — 컴포넌트 수명에 종속시키면 회의 화면 언마운트 시 해제된다. 앱 수준으로 1회만 생성한다.
let _wakeLock: WakeLockHandle | null = null
function _sessionWakeLock() {
  if (!_wakeLock) _wakeLock = createWakeLock()
  return _wakeLock
}
// 문서 전역 리스너(탭 복귀 재시도·창 닫기 퇴장)는 1회만 등록한다.
let _sessionOps: { onVisible: () => void; onUnload: () => void } | null = null
let _docListeners = false
function _bindDocListeners() {
  if (_docListeners) return
  _docListeners = true
  document.addEventListener('visibilitychange', () => _sessionOps?.onVisible())
  window.addEventListener('beforeunload', () => _sessionOps?.onUnload())
}

// 장치 목록(정규화·중복 제거) — 회의 중 핫플러그 갱신에도 사용한다
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
      // 서버 기본값(대기실 켬 · 예약이면 내 캘린더에 추가)과 동일하게 설정
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

/** 회의 종료 화면 "이번 회의" 카드의 서버 측 값(GET /rooms/{name}/summary — 조회 권한이 없으면 404) */
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

/** 회의 종료(호스트) — 전원 퇴장 처리 후 지난 회의로 전환 */
export const endRoom = async (name: string) => {
  await $fetch(`/api/meetings/rooms/${encodeURIComponent(name)}/end`, { method: 'POST', credentials: 'include' })
  await fetchRooms()
}

/** 본인 응답(초대 대상자). 목록 행을 즉시 갱신하고, 동일 회의의 초대 알림은 읽음 처리한다 */
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
  // 동일한 방 이름으로 여러 차례 종료되었을 수 있다 — 지난 회의 행은 meeting_id 로 해당 행만 삭제한다
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
  // 브라우저의 "공유 중지"로 종료하면 SDK 가 트랙만 해제한다 — 버튼 상태를 실제 송출 상태에 맞춘다
  // (이전에는 버튼이 "공유 중"으로 남아 재공유 시 두 번 눌러야 했다).
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
 * 수신한 채팅 데이터 → 화면에 표시할 메시지. 발신자는 payload 가 아니라 LiveKit 이 제공한 참가자 정보에서 읽는다 —
 * payload 의 sender 를 신뢰하면 손님이 호스트 이름을 사칭할 수 있다. 본문은 문자열로 강제 변환하고 길이를 제한한다
 * (객체가 수신되면 React 렌더링이 실패하여 채팅을 연 모든 참가자의 화면이 중단되었다). 사용할 수 없는 데이터이면 null.
 */
export function chatMessageFrom(
  data: { text?: unknown; ts?: unknown },
  participant: { identity?: string; name?: string } | undefined,
  localIdentity: string,
): MeetingChatMessage | null {
  if (!participant?.identity) return null   // 서버 API 가 송신한 데이터 등 — 발신자를 알 수 없는 메시지는 포함하지 않는다
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

// 오디오 상한. 요청에 따라 320k 를 설정하나 실효값은 그보다 훨씬 낮다:
//  (a) echoCancellation 활성화 시 크롬이 모노로 다운믹스한다.
//      모노 Opus 는 128k 근처에서 이미 투명하므로 320k 는 헤드룸에 불과하며,
//      크롬이 SDP maxaveragebitrate 로 재차 클램프한다.
//  (b) RED 활성화 시 이전 패킷을 함께 전송하여 업링크가 사실상 2배가 된다.
//      10인 회의에서는 다운링크가 ~6Mbps 에 이른다. 현실적 상한은 128~192k.
const AUDIO_MAX_BITRATE = 320_000

const REJOIN_BACKOFF = [1_000, 2_000, 4_000, 8_000, 16_000]

async function _onNativeEvent(ev: NativeMeetingEvent) {
  const room = S().currentRoom
  if (ev.type === 'hold') {
    // 일반 전화 수신. OS 가 마이크를 점유하므로 송출을 중지하고, 종료 후 unhold 로 복원한다.
    // micEnabled 는 유지한다 — 사용자가 비활성화한 것이 아니다.
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

/** 동일 identity 로 즉시 재접속하면 서버가 이전 세션을 정리하는 동안 DUPLICATE_IDENTITY 가 수신될 수 있다 */
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
      // 마이크·카메라는 입장 시점 값이 아닌 "지금" 값을 사용한다 — 회의 중 음소거한 사용자가 재입장으로 다시 송출되어서는 안 된다.
      // (회의 중 변경한 장치는 switchActiveDevice 가 c.opts 에 기록한다)
      const opts = { ...c.opts, cameraEnabled: S().cameraEnabled, micEnabled: S().micEnabled }
      await connectToRoom(c.wsUrl, c.token, opts, ++_connSeq)
      set({ rejoinAttempt: 0 })
    } catch (e) {
      // 취소(나가기·더 최근 시도)는 실패가 아니다 — 재접속하지 않는다
      if (!isJoinCancelled(e)) void _tryRejoin()
    }
  }, REJOIN_BACKOFF[n])
}

/** 탭이 다시 표시되면 대기 없이 즉시 1회 시도한다 */
function _onVisibleRetry() {
  if (document.visibilityState !== 'visible') return
  // 리스너는 문서에 1개만 등록되어 있으며(_bindDocListeners), 접속 중일 때만 동작한다.
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
/** 창·탭을 닫으면 퇴장(회의 화면·미니 창 모두 해당) */
function _onUnloadLeave() {
  if (S().connected) void leaveRoom()
}

async function connectToRoom(wsUrl: string, token: string, opts: ConnectOptions | undefined, my: number) {
  const { Room, RoomEvent, VideoPresets } = await loadLivekit()
  if (my !== _connSeq) throw new JoinCancelledError()
  const wakeLock = _sessionWakeLock()
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    videoCaptureDefaults: {
      // ICE-TCP(서버가 Docker Desktop UDP 이슈로 TCP 강제) 환경에서는 고해상도/고비트레이트
      // 영상이 TCP head-of-line 블로킹으로 연결을 끊는다 → 720p/저비트레이트로 안정화.
      resolution: VideoPresets.h720.resolution,
      facingMode: 'user',
      ...(opts?.selectedCameraId ? { deviceId: opts.selectedCameraId } : {}),
    },
    audioCaptureDefaults: {
      ...(opts?.selectedMicId ? { deviceId: opts.selectedMicId } : {}),
      echoCancellation: true,
      autoGainControl: true,
      // 잡음 제거는 브라우저 기본 억제를 사용한다 — 컨트롤 바의 토글로 활성화/비활성화한다(toggleNoiseCancellation)
      noiseSuppression: S().noiseEnabled,
    },
    // 장치 설정에서 선택한 스피커. 이전에는 emit 까지 전달된 후 이 지점에서 누락되었다.
    ...(opts?.selectedSpeakerId ? { audioOutput: { deviceId: opts.selectedSpeakerId } } : {}),
    publishDefaults: {
      audioPreset: { maxBitrate: AUDIO_MAX_BITRATE },
      // RED: 이전 패킷을 중복 전송하여 한두 패킷 손실을 보완한다(대역폭 2배). 서버 codecs 에 audio/red 등록되어 있음.
      red: true,
      // DTX 는 무음 구간 비트레이트를 낮추지만, 발화 시작부가 누락되는 원인이므로 비활성화한다.
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
      // VP9 SVC. VP8 을 사용하던 이유는 TCP 단일연결(ICE-TCP 강제) 시절의
      // head-of-line 블로킹이었으나, UDP 가 복구되고 TURN 까지 추가되어 전제가 변경되었다.
      videoCodec: 'vp9',
      // VP9 을 수신하지 못하는 구독자(구형 iOS 등)에게는 VP8 로 별도 전송한다
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
  // 아래 세 핸들러는 "지금 세션의 방"일 때만 상태를 변경한다 — 중단된 접속(취소·중복)의 방이 발생시킨 이벤트가
  // 유효한 세션의 상태를 지워서는 안 된다.
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
    // 본인 퇴장도, 방 소멸도 아니면 재접속한다.
    if (_lastConn && (reason === undefined || !finalReasons().has(reason))) {
      void _tryRejoin()
    } else {
      // _lastConn 이 남아 있으면 본인 퇴장이 아니라 상대 측에서 종료된 것(방 종료·내보내짐) — 회의 화면이 종료 화면으로 전환한다
      const remote = !!_lastConn
      _lastConn = null
      set({ connectionState: 'disconnected', currentRoomName: null, inCall: false, callStartedAt: null, ...(remote ? { remoteEnded: true } : {}) })
      void wakeLock.release()
      void nativeMeeting.stop()
    }
  })
  // 장치 오류(권한 회수, 장치 제거)도 마이크 중단으로 간주한다
  room.on(RoomEvent.MediaDevicesError, () => { set({ micInterrupted: true }) })

  setupChat(room)

  // peerConnectionTimeout/websocketTimeout 확대 — TCP 경로가 느릴 때 조기 실패 처리 방지
  await room.connect(wsUrl, token, {
    autoSubscribe: true,
    peerConnectionTimeout: 30_000,
    websocketTimeout: 30_000,
  })
  if (my !== _connSeq) {
    // 대기 중 취소되었거나(나가기·화면 이탈) 더 최근 접속이 시작되었다 — 이 방은 폐기한다.
    // 아직 세션의 방이 아니므로(mine() 거짓) 위 핸들러는 상태를 변경하지 않는다.
    try { await room.disconnect() } catch { /* noop */ }
    throw new JoinCancelledError()
  }

  set({ currentRoom: room, connected: true, connectionState: 'connected', remoteEnded: false })
  _lastConn = { wsUrl, token, opts }
  // 재입장으로 재호출되어도 통화 시작 시각은 유지한다(미니 창 "12:43")
  if (!S().inCall) set({ inCall: true, callStartedAt: Date.now() })
  _sessionOps = { onVisible: _onVisibleRetry, onUnload: _onUnloadLeave }
  _bindDocListeners()
  void wakeLock.request()

  // 장치 테스트에서 선택한 on/off 상태 반영
  const wantCamera = opts?.cameraEnabled ?? true
  // 재입장(_tryRejoin)으로 재호출되어도 네이티브 측이 기존 통화를 재사용한다
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
      // 한쪽만 활성화해야 하는 경우 나머지를 비활성화
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
  // 장치 활성화 도중 퇴장했으면(leaveRoom 이 이 방을 이미 끊음) 여기서 중단한다
  if (S().currentRoom !== room) return

  // 배경 흐림·가상 배경은 카메라 트랙에 적용된다. 재입장으로 트랙이 새로 생성되었으므로 재적용한다
  // (카메라가 꺼져 있으면 켤 때 toggleCamera 가 적용한다).
  if (S().cameraEnabled) await _restoreBg()

  set({ screenShareEnabled: false, micInterrupted: false })
  if (S().micEnabled) void _watchMicTrack()
  void deviceList.refresh()
  refreshParticipants()
}

// ─── 마이크 중단(전화 수신 등) 감지·복구 ───

/**
 * 전화 수신 시 OS 가 마이크를 점유한다. iOS 는 대체로 mediaStreamTrack 이 mute 되고,
 * 안드로이드는 트랙이 ended 로 종료되는 경우가 많다. 두 경우 모두 감시한다.
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

/** 중단된 마이크를 재획득한다. 배너 버튼과 unmute·복귀 이벤트가 호출한다. */
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
    await _watchMicTrack()
    set({ micInterrupted: false })
    refreshParticipants()
  } catch (e) {
    console.warn('[meet] 마이크 재연결 실패', e)
  }
}

/**
 * 회의 중 장치 전환. LiveKit 이 트랙을 새로 획득하여 publish 까지 수행한다.
 */
export const switchActiveDevice = async (kind: MediaDeviceKind, deviceId: string) => {
  const room = S().currentRoom
  if (!room || !deviceId) return
  await (room as any).switchActiveDevice(kind, deviceId)
  // 끊김으로 재입장할 때도 현재 선택한 장치로 접속하도록 기록한다
  if (_lastConn) {
    const key = kind === 'videoinput' ? 'selectedCameraId' : kind === 'audioinput' ? 'selectedMicId' : 'selectedSpeakerId'
    _lastConn = { ..._lastConn, opts: { ..._lastConn.opts, [key]: deviceId } }
  }
  if (kind === 'audioinput') await _watchMicTrack()
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

/** 다른 회의에 입장할 때 아직 통화 중이면(미니 창으로 전환해 둔 통화) 먼저 퇴장한다 — 방 2개 동시 접속 방지 */
// 음성 채널(useVoice) 등 다른 통화 세션 — 회의 입장 시 먼저 퇴장시킨다(동시에 1개 방). 해당 모듈이 등록한다.
let _externalLeaver: (() => Promise<void>) | null = null
export function registerExternalCallLeaver(fn: () => Promise<void>) { _externalLeaver = fn }

async function _leaveOtherCall(roomName: string) {
  // 세대 번호를 증가시키지 않는 퇴장 — 현재 진행 중인 이 입장까지 취소해서는 안 된다
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
    // 룸 페이지는 fetchRooms 를 호출하지 않으므로 rooms 목록으로 판정하면 항상 false 였다.
    // 토큰을 발급한 백엔드가 호스트 여부를 함께 반환한다.
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
  // 진행 중인 접속(입장·재입장)이 있으면 취소한다 — 퇴장 후 접속이 완료되어 통화가 연결되지 않도록
  _connSeq++
  await _leave()
}

async function _leave() {
  const wakeLock = _sessionWakeLock()
  // beforeunload/Disconnected 핸들러가 재접속하지 않도록 먼저 초기화한다
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
    // 트랙에 적용된 효과·방에 종속된 상태 — 다음 회의에 "켜짐"으로 이월되면 실제와 불일치한다
    blurEnabled: false,
    vbgEnabled: false,
    recording: false,
  })
  if (_vbgImageUrl) { URL.revokeObjectURL(_vbgImageUrl); _vbgImageUrl = '' }
}

// ─── 미디어 토글 ───

// ─── 배경 블러(호스트 클라이언트에서 처리, GPU 우선 / CPU 폴백) ───
// @livekit/track-processors = MediaPipe Selfie Segmentation. WebGL(GPU) delegate 우선,
// 실패 시 WASM(CPU) 폴백. 서버(SFU)는 관여하지 않음 — 블러 처리된 프레임을 인코딩하여 송출.
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
 * 활성화된 배경 효과를 새 카메라 트랙에 재적용한다(재입장·카메라 재활성화·카메라 변경). 적용 실패 시 버튼을 비활성 표시로 되돌린다 —
 * "켜짐"으로 표시되면서 배경이 그대로 송출되는 상황을 방지한다.
 */
async function _restoreBg() {
  if (!S().blurEnabled && !S().vbgEnabled) return
  const ok = await _reapplyBg().catch(() => false)
  if (!ok) set({ blurEnabled: false, vbgEnabled: false })
}

// 카메라 재활성 등에서 현재 배경 상태를 재적용. 적용 성공 시 true(활성화된 효과가 없어도 true)
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
      if (!ok) return   // 카메라가 꺼져 있으면 상태를 변경하지 않음
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

// 가상배경: 이미지 파일 선택 → object URL → VirtualBackground. 재호출 시 해제.
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

// ─── 내 마이크 트랙 ───
async function _localMicTrack(): Promise<any | null> {
  const room = S().currentRoom
  if (!room) return null
  const pub = room.localParticipant.getTrackPublication(lk().Track.Source.Microphone)
  return (pub?.track as any) || null
}

// ─── 잡음 제거(브라우저 기본 잡음 억제) ───

/**
 * 잡음 제거 토글 — 본인 마이크의 브라우저 잡음 억제(`noiseSuppression`)를 활성화/비활성화한다.
 * 현재 트랙에 제약을 즉시 적용해 보고, 브라우저가 즉시 반영하지 않으면 동일 장치로 트랙을 재획득한다.
 * 두 방법 모두 실패하면 상태를 유지하고 알린다. 마이크가 꺼져 있으면 다음 활성화 시 적용된다.
 */
export const toggleNoiseCancellation = async () => {
  if (S().noiseBusy) return
  const next = !S().noiseEnabled
  const room = S().currentRoom as any
  const defaults = room?.options?.audioCaptureDefaults as Record<string, unknown> | undefined
  const before = defaults?.noiseSuppression
  set({ noiseBusy: true })
  try {
    if (defaults) defaults.noiseSuppression = next          // 마이크 재활성화·장치 변경 시에도 동일 값 적용
    const track = await _localMicTrack()
    const mst = track?.mediaStreamTrack as MediaStreamTrack | undefined
    if (track && mst) {
      let applied = false
      try {
        await mst.applyConstraints({ noiseSuppression: next })
        const now = mst.getSettings?.().noiseSuppression
        applied = now === undefined || now === next
      } catch { /* 이 브라우저는 즉시 변경 불가 — 아래에서 재획득한다 */ }
      if (!applied) {
        await track.restartTrack({ ...(defaults ?? {}), noiseSuppression: next })
        await _watchMicTrack()
      }
    }
    set({ noiseEnabled: next })
  } catch (e) {
    if (defaults) defaults.noiseSuppression = before
    console.warn('[meet] 잡음 제거 전환 실패', e)
    addToast('error', t('meetings.controls.noiseFail'))
  } finally {
    set({ noiseBusy: false })
  }
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
    // 회의 화면은 store.error 를 렌더링하지 않는다 — 실패 사유를 토스트로 즉시 표시한다(이전에는 23초간 대기 후 안내 없이 원복)
    const msg = e?.data?.detail || t('meetings.recordError')
    set({ error: msg })
    addToast('error', msg)
    // 서버 상태가 화면과 달라 실패했을 수 있다(이미 종료된 녹화의 중지 시도 등) — 버튼을 서버 값에 맞춘다
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

export const toggleCamera = async () => {
  const room = S().currentRoom
  if (!room) return
  const enabled = !S().cameraEnabled
  await room.localParticipant.setCameraEnabled(enabled)
  set({ cameraEnabled: enabled })
  // 카메라 재활성화 시 트랙이 새로 생성되므로 배경효과(블러/이미지)가 활성화되어 있었으면 재적용
  if (enabled) await _restoreBg()
  refreshParticipants()
}

export const toggleMic = async () => {
  const room = S().currentRoom
  if (!room) return
  const enabled = !S().micEnabled
  await room.localParticipant.setMicrophoneEnabled(enabled)
  set({ micEnabled: enabled })
  if (enabled) {
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
 * 컨트롤 바의 마이크·카메라·화면 공유 버튼. 토글에서 예외가 발생하면(권한 거부·장치 없음·다른 앱이 사용 중) 사유를 토스트로 알린다 —
 * 이전에는 호출부가 예외를 무시하여 버튼을 눌러도 반응이 없었다. 화면 공유 선택 창을 단순히 닫은 경우는 실패가 아니다.
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
