/**
 * 회의 참가 전 화면 — 호스트(room)와 초대 링크 손님(join) 공용.
 *
 *  데스크톱(1024↑): 가운데 묶음(최대 1280) = 왼쪽 1fr [미리보기 16:9 → 상시 3칸 장치 바 → 알림 줄] + 오른쪽 380
 *                  [브랜드 · 방 제목 26 · 방 정보 14 · (손님) 이름·비밀번호 · 참가 버튼 + 아래 한 줄 · (호스트) 취소].
 *  모바일: 머리 56(뒤로 · 제목 · 보조) → 미리보기 4:3 → 장치 바(세로 3행) → 알림 → 입력 → 하단 고정 [참가].
 *  장치 칸 = 왼쪽 토글(44, 아이콘+글자 켜짐/꺼짐 · 스피커는 테스트) + 오른쪽 선택 버튼("종류 · 상태" / 장치 이름 / ▾).
 *  마이크 칸 아래 20칸 레벨. 목록은 칸 위로 열리는 팝오버(listbox) — 모바일은 하단 시트. 마이크 항목마다 레벨 표시.
 *  차단 상태(권한 요청 중 · 거부 · 장치 없음 · 다른 앱 사용 중 · http · 끊김)는 미리보기 위치에 "무엇이 막혔나 + 어떻게 + 버튼 1개"(role=alert) 표시,
 *  해당 칸은 warning 테두리 + 상태 글자. 참가 버튼은 장치 사유로 잠그지 않음(손님 이름 미입력 시에만 잠금) — 아래 한 줄에 입장 방식을 안내.
 *  상태 논리(오류 분류 · 짝 스피커 · 잠금 · 레벨)는 prejoin.ts(순수 함수).
 *
 * React: ref 로 { getSelection, stopPreview } 노출. getSelection 은 실제 사용 가능한 장치만 켜짐으로 전달한다(차단된 장치는 꺼짐).
 */
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { useRoute } from '~/lib/router'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { mediaDevicesStore, useMediaDevices, type NormalizedDevice } from '~/composables/useMediaDevices'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiActionSheet } from '~/components/ui/ActionSheet'
import { UiTrans } from '~/components/ui/Trans'
import {
  acquireInitial, classifyMediaError, detectBrowser, formatElapsed, httpsUrlFor, isInsecureContext,
  joinNoteFor, meterSegments, pairSpeaker, permissionHintKey, rmsLevel, scheduleChime, sinkSelectable, CHIME_SECONDS,
  type BrowserName, type DeviceIssue,
} from './prejoin'

/** 참여 시 전달하는 장치 선택 */
export interface MeetingDeviceSelection {
  cameraEnabled: boolean
  micEnabled: boolean
  selectedCameraId?: string
  selectedMicId?: string
  selectedSpeakerId?: string
}

/** ref 로 노출하는 항목 */
export interface MeetingsDeviceSetupHandle {
  /** 현재 선택값. 게스트 페이지가 승인 시점에 그대로 사용하여 즉시 접속한다. */
  getSelection: () => MeetingDeviceSelection
  /** 미리보기 스트림·레벨 측정 중지 */
  stopPreview: () => void
}

export interface MeetingsDeviceSetupProps {
  /** 방 제목 */
  roomName: string
  /** 참여 버튼 문구(게스트 흐름에서는 "참가 신청"). 기본 "참여하기" */
  joinLabel?: string
  /** 참여 버튼 잠금 — 손님 이름 미입력 시에만 적용. 장치 상태로는 잠그지 않음 */
  joinDisabled?: boolean
  /** 잠금 사유(버튼 바로 아래). 미지정 시 손님 기본 문구 */
  joinDisabledReason?: string
  /** 신청 전송 중 */
  busy?: boolean
  /** busy 일 때 참여 버튼 문구(기본 "신청 중…" — 호스트 화면은 "참여하는 중…") */
  busyLabel?: string
  /** 방 정보 한 줄: "호스트 박민지 · 오늘 15:00–16:00 · 지금 3명 참여 중" */
  meta?: ReactNode
  /** 모바일 머리 보조(meta 가 없을 때) */
  subtitle?: string
  /** 호스트: [취소](데스크톱 버튼 · 모바일 머리 뒤로) */
  cancelable?: boolean
  /** 미리보기 이름표 "하늘 (나) · 좌우 반전" 의 이름(아바타 이니셜에도) */
  selfName?: string
  /** 호출부 입력(손님: 표시 이름 · 비밀번호) */
  children?: ReactNode
  /** 손님 승인 대기 — 참가 버튼 자리에 primary 띠(스피너 · 문구 · 경과 · [취소]) */
  waiting?: boolean
  /** 대기 시작 시각(ms) — 경과 표시 */
  waitingSince?: number | null
  /** 참여 버튼 위치를 대체하는 내용(호환용 — waiting 이 있으면 waiting 우선) */
  status?: ReactNode
  onJoin?: (opts: MeetingDeviceSelection) => void
  onCancel?: () => void
  ref?: Ref<MeetingsDeviceSetupHandle | null>
}

type Phase = 'requesting' | 'ready' | 'denied' | 'insecure'
type Kind = 'mic' | 'cam' | 'spk'

/** 상태 + 동기적으로 읽을 수 있는 최신값(ref) */
function useLive<T>(init: T): [T, (v: T) => void, { current: T }] {
  const [val, setVal] = useState(init)
  const ref = useRef(init)
  const set = (v: T) => { ref.current = v; setVal(v) }
  return [val, set, ref]
}

/** 데스크톱(lg, 1024↑) 여부 — 2단 그리드·팝오버 / 그 외 1열·하단 시트 */
function useDesktop(): boolean {
  const q = '(min-width: 1024px)'
  const [desk, setDesk] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q).matches : true))
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia(q)
    const on = (e: MediaQueryListEvent) => setDesk(e.matches)
    setDesk(mq.matches)
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return desk
}

function stopKind(s: MediaStream | null, kind: 'video' | 'audio') {
  if (!s) return
  const tracks = kind === 'video' ? s.getVideoTracks() : s.getAudioTracks()
  tracks.forEach(tr => tr.stop())
}

/** 트랙 1개만 포함한 스트림(두 트랙을 개별 중지하기 위함). MediaStream 생성자가 없으면 원본 그대로 반환 */
function streamOf(track: MediaStreamTrack | undefined, orig: MediaStream): MediaStream | null {
  if (!track) return null
  if (typeof MediaStream === 'function') { try { return new MediaStream([track]) } catch { /* 폴백 */ } }
  return orig
}

const OK_TG = 'bg-muted text-foreground border border-muted-foreground/40'
const OFF_TG = 'bg-danger text-danger-foreground'
const DIS_TG = 'bg-muted/50 text-muted-foreground'
const TEST_TG = 'bg-primary/15 text-primary border border-primary/50'
const BD = 'border-muted-foreground/40'
const SEG_CLS: Record<'off' | 'on' | 'peak', string> = { off: 'bg-muted-foreground/45', on: 'bg-success', peak: 'bg-warning' }

interface Cell {
  key: Kind
  label: string
  st: string
  stCls: string
  name: string
  tgIc: string
  tgTxt: string
  tgCls: string
  tgAria: string
  tgDisabled: boolean
  /** aria-pressed(마이크·카메라). 스피커는 undefined */
  pressed?: boolean
  selAria: string
  selDisabled: boolean
  selCls: string
  bd: string
  meter: boolean
  level: number
  open: boolean
}

interface Option {
  id: string
  label: string
  tag: string
  selected: boolean
  /** 마이크 항목 레벨(0~100). null = 레벨 없음 */
  level: number | null
}

/** 회의 입장 전 장치 확인 화면 */
export function MeetingsDeviceSetup({
  roomName, joinLabel, joinDisabled, joinDisabledReason, busy, busyLabel, meta, subtitle, cancelable, selfName, children,
  waiting, waitingSince, status, onJoin, onCancel, ref,
}: MeetingsDeviceSetupProps) {
  const { t } = useI18n()
  const desk = useDesktop()

  // ── 상태 ──
  const [phase, setPhase, phaseRef] = useLive<Phase>('requesting')
  const [camIssue, setCamIssue, camIssueRef] = useLive<DeviceIssue | null>(null)
  const [micIssue, setMicIssue, micIssueRef] = useLive<DeviceIssue | null>(null)
  const [debugInfo, setDebugInfo] = useState('')

  const {
    cameras, microphones, speakers,
    refresh: refreshDevices, pairedSpeakerFor, startListening, stopListening,
  } = useMediaDevices()
  const [selectedCameraId, setSelectedCameraId, camIdRef] = useLive('')
  const [selectedMicId, setSelectedMicId, micIdRef] = useLive('')
  const [selectedSpeakerId, setSelectedSpeakerId, spkIdRef] = useLive('')
  const speakerTouched = useRef(false)
  // 블루투스 짝 스피커로 연동 전환한 경우(복원용)
  const [paired, setPaired] = useState<{ previousSpeakerId: string; name: string } | null>(null)

  const [cameraOn, setCameraOn, cameraOnRef] = useLive(true)
  const [micOn, setMicOn, micOnRef] = useLive(true)
  const [camStream, setCamStream, camStreamRef] = useLive<MediaStream | null>(null)
  const [, setMicStream, micStreamRef] = useLive<MediaStream | null>(null)
  const videoEl = useRef<HTMLVideoElement | null>(null)

  // 레벨: 현재 마이크 + (목록이 열린 경우) 다른 마이크
  const [micLevel, setMicLevel] = useState(0)
  const [probeLevels, setProbeLevels] = useState<Record<string, number>>({})
  const audioCtx = useRef<AudioContext | null>(null)
  const analyser = useRef<AnalyserNode | null>(null)
  const probes = useRef(new Map<string, { stream: MediaStream; analyser: AnalyserNode }>())

  const [openList, setOpenList] = useState<Kind | null>(null)
  const [testing, setTesting] = useState(false)
  const [browser, setBrowser] = useState<BrowserName>('')
  // 지연 도착한 결과(이전 요청)를 폐기하기 위한 순번
  const seq = useRef({ init: 0, cam: 0, mic: 0 })
  /** 진행 중인 장치 요청을 전부 무효화 — 지연 도착한 스트림은 수신 측이 즉시 중지 */
  const invalidatePending = () => { seq.current.init++; seq.current.cam++; seq.current.mic++ }

  // 출력 장치 선택: 브라우저 지원 여부(미지원이면 "선택할 수 없음") / 현재 선택 가능 여부(목록까지 있어야 함)
  const mediaProto = typeof HTMLMediaElement !== 'undefined' ? HTMLMediaElement.prototype : undefined
  const sinkSupported = !!mediaProto && 'setSinkId' in mediaProto
  const sinkOk = sinkSelectable(mediaProto, speakers.length)
  const insecure = phase === 'insecure'

  // ── 오디오 분석 ──
  function ctx(): AudioContext | null {
    if (typeof AudioContext === 'undefined') return null
    if (!audioCtx.current) audioCtx.current = new AudioContext()
    void audioCtx.current.resume?.()?.catch?.(() => {})
    return audioCtx.current
  }
  function analyserFor(stream: MediaStream): AnalyserNode | null {
    const c = ctx()
    if (!c) return null
    const an = c.createAnalyser()
    an.fftSize = 256
    c.createMediaStreamSource(stream).connect(an)
    return an
  }
  function startMicLevel(stream: MediaStream) {
    analyser.current = analyserFor(stream)
  }
  function stopMicLevel() {
    analyser.current = null
    setMicLevel(0)
  }
  // 10fps 로 현재 마이크 + 다른 마이크의 레벨 측정
  useEffect(() => {
    const id = setInterval(() => {
      const an = analyser.current
      if (an) {
        const buf = new Uint8Array(an.frequencyBinCount)
        an.getByteTimeDomainData(buf)
        const lv = rmsLevel(buf)
        setMicLevel(prev => (prev === lv ? prev : lv))
      }
      if (probes.current.size) {
        const next: Record<string, number> = {}
        probes.current.forEach((p, k) => {
          const buf = new Uint8Array(p.analyser.frequencyBinCount)
          p.analyser.getByteTimeDomainData(buf)
          next[k] = rmsLevel(buf)
        })
        setProbeLevels(prev => (Object.keys(prev).length === Object.keys(next).length && Object.keys(next).every(k => prev[k] === next[k]) ? prev : next))
      }
    }, 100)
    return () => clearInterval(id)
  }, [])

  function stopProbes() {
    probes.current.forEach(p => p.stream.getTracks().forEach(tr => tr.stop()))
    probes.current.clear()
    setProbeLevels({})
  }

  // ── 장치 획득 ──
  function watchEnded(stream: MediaStream, kind: 'video' | 'audio') {
    const tr = kind === 'video' ? stream.getVideoTracks()[0] : stream.getAudioTracks()[0]
    if (!tr?.addEventListener) return
    tr.addEventListener('ended', () => {
      if (kind === 'video') {
        if (camStreamRef.current !== stream) return
        setCamStream(null)
        setCamIssue('lost')
      } else {
        if (micStreamRef.current !== stream) return
        setMicStream(null)
        stopMicLevel()
        setMicIssue('lost')
      }
    })
  }
  function takeCam(stream: MediaStream) {
    stopKind(camStreamRef.current, 'video')
    setCamStream(stream)
    setCamIssue(null)
    watchEnded(stream, 'video')
    const id = stream.getVideoTracks()[0]?.getSettings?.()?.deviceId
    if (id && mediaDevicesStore.getState().cameras.some(c => c.deviceId === id)) setSelectedCameraId(id)
  }
  function takeMic(stream: MediaStream) {
    stopKind(micStreamRef.current, 'audio')
    setMicStream(stream)
    setMicIssue(null)
    startMicLevel(stream)
    watchEnded(stream, 'audio')
    const id = stream.getAudioTracks()[0]?.getSettings?.()?.deviceId
    if (id && mediaDevicesStore.getState().microphones.some(m => m.deviceId === id)) setSelectedMicId(id)
  }
  /** 카메라 1개 재획득(장치 변경 · 다시 시도 · 다시 연결 · 켜기) */
  async function acquireCamera(id = camIdRef.current) {
    const my = ++seq.current.cam
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: id ? { deviceId: { exact: id } } : true })
      if (my !== seq.current.cam || phaseRef.current !== 'ready' || !cameraOnRef.current) { s.getTracks().forEach(tr => tr.stop()); return }
      takeCam(s)
    } catch (e) {
      if (my !== seq.current.cam) return
      setCamStream(null)
      setCamIssue(classifyMediaError(e))
    }
  }
  async function acquireMic(id = micIdRef.current) {
    const my = ++seq.current.mic
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: id ? { deviceId: { exact: id } } : true })
      if (my !== seq.current.mic || phaseRef.current !== 'ready' || !micOnRef.current) { s.getTracks().forEach(tr => tr.stop()); return }
      takeMic(s)
    } catch (e) {
      if (my !== seq.current.mic) return
      setMicStream(null)
      stopMicLevel()
      setMicIssue(classifyMediaError(e))
    }
  }

  async function enumerate() {
    await refreshDevices()
    const { cameras: cams, microphones: mics, speakers: spks } = mediaDevicesStore.getState()
    if (!camIdRef.current || !cams.some(c => c.deviceId === camIdRef.current)) setSelectedCameraId(cams[0]?.deviceId || '')
    if (!micIdRef.current || !mics.some(m => m.deviceId === micIdRef.current)) setSelectedMicId(mics[0]?.deviceId || '')
    if (!spkIdRef.current || !spks.some(s => s.deviceId === spkIdRef.current)) setSelectedSpeakerId(spks[0]?.deviceId || '')
  }

  /** 1단계: 권한 요청(둘 다 → 오디오만 → 비디오만) */
  async function requestPermissions() {
    stopPreview()
    const my = ++seq.current.init
    setPhase('requesting')
    setCamIssue(null)
    setMicIssue(null)
    setDebugInfo('')

    if (typeof window !== 'undefined' && isInsecureContext(window)) {
      setPhase('insecure')
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      // 보안 컨텍스트이나 장치 API 가 없음 — 둘 다 "장치 없음"으로 처리
      setDebugInfo('no mediaDevices')
      setCamIssue('none')
      setMicIssue('none')
      setPhase('ready')
      return
    }

    const r = await acquireInitial(c => navigator.mediaDevices.getUserMedia(c))
    if (my !== seq.current.init) { r.stream?.getTracks().forEach(tr => tr.stop()); return }
    setDebugInfo(`camera=${r.camera ?? 'ok'} mic=${r.mic ?? 'ok'}`)
    // 권한이 없어도 목록은 조회(이름 없는 항목이라도 스피커 칸을 채움)
    await enumerate()
    if (my !== seq.current.init) { r.stream?.getTracks().forEach(tr => tr.stop()); return }
    if (r.denied) {
      setCamIssue('denied')
      setMicIssue('denied')
      setPhase('denied')
      return
    }
    if (my !== seq.current.init) { r.stream?.getTracks().forEach(tr => tr.stop()); return }
    // 먼저 ready 로 전환 — takeCam/takeMic 가 "지금 켜짐" 조건을 확인함
    setPhase('ready')
    if (r.stream) {
      const v = streamOf(r.stream.getVideoTracks()[0], r.stream)
      const a = streamOf(r.stream.getAudioTracks()[0], r.stream)
      if (v) takeCam(v)
      if (a) takeMic(a)
    }
    if (r.camera) setCamIssue(r.camera)
    if (r.mic) setMicIssue(r.mic)
  }

  function stopPreview() {
    // 수신 대기 중인 getUserMedia 결과도 폐기한다. 생략 시 화면이 내려간 후(참여·취소) 도착한 스트림이
    // 중지되지 않은 채 남아, 회의에서는 "카메라 꺼짐"인데 카메라 표시등이 켜진 상태가 발생했다.
    invalidatePending()
    stopKind(camStreamRef.current, 'video')
    stopKind(micStreamRef.current, 'audio')
    setCamStream(null)
    setMicStream(null)
    if (videoEl.current) videoEl.current.srcObject = null
    stopMicLevel()
    stopProbes()
  }

  // 미리보기 video 에 스트림 연결
  const showVideo = phase === 'ready' && cameraOn && !camIssue && !!camStream
  useLayoutEffect(() => {
    const el = videoEl.current
    if (!el) return
    if (showVideo && camStream) { if (el.srcObject !== camStream) el.srcObject = camStream }
    else el.srcObject = null
  }, [showVideo, camStream])

  // ── 사용자 조작 ──
  function toggleCamera() {
    const on = !cameraOnRef.current
    setCameraOn(on)
    if (phaseRef.current !== 'ready') return
    if (on) void acquireCamera()
    else { stopKind(camStreamRef.current, 'video'); setCamStream(null) }
  }
  function toggleMic() {
    const on = !micOnRef.current
    setMicOn(on)
    if (phaseRef.current !== 'ready') return
    if (on) void acquireMic()
    else { stopKind(micStreamRef.current, 'audio'); setMicStream(null); stopMicLevel() }
  }
  function pickCamera(id: string) {
    setOpenList(null)
    if (id === camIdRef.current && !camIssueRef.current) return
    setSelectedCameraId(id)
    if (phaseRef.current === 'ready' && cameraOnRef.current) void acquireCamera(id)
  }
  function pickMic(id: string) {
    setOpenList(null)
    const changed = id !== micIdRef.current
    setSelectedMicId(id)
    if (changed || micIssueRef.current) { if (phaseRef.current === 'ready' && micOnRef.current) void acquireMic(id) }
    applyPairing(id)
  }
  /** 블루투스 헤드셋처럼 마이크·스피커가 일체형인 장치이면 스피커도 연동 전환 */
  function applyPairing(micId: string) {
    if (!sinkOk) return
    const r = pairSpeaker(micId, spkIdRef.current, speakerTouched.current, pairedSpeakerFor)
    if (!r) return
    setSelectedSpeakerId(r.speakerId)
    setPaired({ previousSpeakerId: r.previousSpeakerId, name: r.name })
  }
  function undoPairing() {
    if (!paired) return
    setSelectedSpeakerId(paired.previousSpeakerId)
    speakerTouched.current = true
    setPaired(null)
  }
  function pickSpeaker(id: string) {
    setOpenList(null)
    setSelectedSpeakerId(id)
    speakerTouched.current = true
    setPaired(null)
  }
  /** 최초 선택된 마이크가 헤드셋이면 스피커도 연동(초기값에도 적용) */
  const pairedOnce = useRef(false)
  useEffect(() => {
    if (phase !== 'ready' || pairedOnce.current || !selectedMicId) return
    pairedOnce.current = true
    applyPairing(selectedMicId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, selectedMicId])

  /** 미리보기 위치 버튼: 권한 요청 중·거부 = 처음부터 재시도, 다른 앱 사용 중·끊김 = 카메라만 재시도 */
  function retry() {
    if (phaseRef.current === 'ready') {
      if (camIssueRef.current) void acquireCamera()
      if (micIssueRef.current && micIssueRef.current !== 'none') void acquireMic()
      return
    }
    void requestPermissions()
  }
  function openHttps() {
    window.location.href = httpsUrlFor(window.location)
  }

  /** 스피커 테스트 — 1초 차임. 선택한 출력 장치가 있으면 setSinkId */
  async function testSpeaker() {
    if (testing || typeof AudioContext === 'undefined') return
    setTesting(true)
    const c = new AudioContext()
    let el: HTMLAudioElement | null = null
    try {
      const sink = sinkOk && spkIdRef.current
      if (sink && typeof Audio !== 'undefined') {
        const dest = c.createMediaStreamDestination()
        scheduleChime(c, dest)
        el = new Audio()
        el.srcObject = dest.stream
        try { await (el as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> }).setSinkId(spkIdRef.current) } catch { /* 기본 출력 사용 */ }
        await el.play().catch(() => {})
      } else {
        scheduleChime(c, c.destination)
      }
      await c.resume?.()?.catch?.(() => {})
    } catch { /* 소리 재생 불가 */ }
    setTimeout(() => {
      el?.pause()
      void c.close().catch(() => {})
      setTesting(false)
    }, (CHIME_SECONDS + 0.15) * 1000)
  }

  // ── 장치 변경(연결·분리) ──
  useEffect(() => {
    if (phase !== 'ready') return
    if (camIssue === 'none' && cameras.length) void acquireCamera(cameras[0].deviceId)
    if (camIdRef.current && cameras.length && !cameras.some(c => c.deviceId === camIdRef.current)) setSelectedCameraId(cameras[0].deviceId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameras])
  useEffect(() => {
    if (phase !== 'ready') return
    if (micIssue === 'none' && microphones.length) void acquireMic(microphones[0].deviceId)
    if (micIdRef.current && microphones.length && !microphones.some(m => m.deviceId === micIdRef.current)) setSelectedMicId(microphones[0].deviceId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [microphones])
  useEffect(() => {
    if (spkIdRef.current && speakers.length && !speakers.some(s => s.deviceId === spkIdRef.current)) setSelectedSpeakerId(speakers[0].deviceId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speakers])

  // ── 마이크 목록이 열리면 다른 마이크도 일시 획득하여 레벨 측정 ──
  useEffect(() => {
    if (openList !== 'mic' || phase !== 'ready' || !navigator.mediaDevices?.getUserMedia) return
    let alive = true
    const others = microphones.filter(m => m.deviceId !== selectedMicId)
    for (const m of others) {
      navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: m.deviceId } } }).then((s) => {
        if (!alive) { s.getTracks().forEach(tr => tr.stop()); return }
        const an = analyserFor(s)
        if (!an) { s.getTracks().forEach(tr => tr.stop()); return }
        probes.current.set(m.deviceId, { stream: s, analyser: an })
      }).catch(() => { /* 이 마이크는 레벨 없음 */ })
    }
    return () => { alive = false; stopProbes() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openList, phase, selectedMicId])

  /** 현재 선택값 — 차단된 장치는 꺼짐으로 처리 */
  function getSelection(): MeetingDeviceSelection {
    const ready = phaseRef.current === 'ready'
    return {
      cameraEnabled: ready && cameraOnRef.current && !camIssueRef.current,
      micEnabled: ready && micOnRef.current && !micIssueRef.current,
      selectedCameraId: camIdRef.current || undefined,
      selectedMicId: micIdRef.current || undefined,
      selectedSpeakerId: spkIdRef.current || undefined,
    }
  }
  function handleJoin() {
    // 미리보기는 여기서 중지하지 않음. 호스트는 언마운트로 정리하고, 게스트는 승인 대기 동안 유지함.
    onJoin?.(getSelection())
  }

  const latest = useRef({ stopPreview, getSelection })
  latest.current = { stopPreview, getSelection }

  useEffect(() => {
    startListening()
    setBrowser(detectBrowser(navigator.userAgent))
    void requestPermissions()
    return () => {
      stopListening()
      latest.current.stopPreview()
      if (audioCtx.current) { void audioCtx.current.close().catch(() => {}); audioCtx.current = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useImperativeHandle(ref, () => ({
    getSelection: () => latest.current.getSelection(),
    stopPreview: () => latest.current.stopPreview(),
  }), [])

  // 승인 대기 경과
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    if (!waiting) return
    setNowTick(Date.now())
    const id = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [waiting])
  const elapsed = formatElapsed(waitingSince ? nowTick - waitingSince : 0)

  // 팝오버 바깥 클릭
  const barRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!openList || !desk) return
    const onDown = (e: PointerEvent) => {
      const root = barRef.current
      if (root && !root.contains(e.target as Node)) setOpenList(null)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [openList, desk])

  // ── 화면용 ──
  const route = useRoute()
  const { appName, brandLogo, loaded: brandLoaded } = useSiteConfig()
  const brandInitial = (appName || '').trim().charAt(0).toUpperCase()
  const showDebug = route.query.debug === '1'

  const label = (d: NormalizedDevice | undefined, withDefault: boolean) => d
    ? `${d.label}${d.isBluetooth ? ` (${t('meetings.device.bluetooth')})` : ''}${withDefault && d.isDefault ? ` · ${t('meetings.prejoin.tagDefault')}` : ''}`
    : ''
  const curCam = cameras.find(c => c.deviceId === selectedCameraId)
  const curMic = microphones.find(m => m.deviceId === selectedMicId)
  const curSpk = speakers.find(s => s.deviceId === selectedSpeakerId)

  const blocked = (c: Cell, st: string): Cell => ({
    ...c, pressed: c.key === 'spk' ? undefined : false, st, stCls: 'text-warning', tgCls: DIS_TG, tgDisabled: true,
    tgTxt: c.key === 'spk' ? t('meetings.prejoin.tgTest') : t('meetings.prejoin.tgNone'), meter: false, bd: 'border-warning/60',
  })
  const issueText = (i: DeviceIssue) => i === 'denied' ? t('meetings.prejoin.stNoPerm') : i === 'inuse' ? t('meetings.prejoin.stInUse') : i === 'lost' ? t('meetings.prejoin.stLost') : t('meetings.prejoin.stNoDevice')

  let mic: Cell = {
    key: 'mic', label: t('meetings.device.mic'), st: t('meetings.prejoin.stOnSpeak'), stCls: 'text-muted-foreground', name: label(curMic, true) || t('meetings.prejoin.nameNone'),
    tgIc: 'mic-on', tgTxt: t('meetings.prejoin.tgOn'), tgCls: OK_TG, tgAria: t('meetings.prejoin.ariaMicOff'), tgDisabled: false, pressed: true,
    selAria: t('meetings.prejoin.ariaMicSelect'), selDisabled: false, selCls: '', bd: BD, meter: true, level: micLevel, open: openList === 'mic',
  }
  let cam: Cell = {
    key: 'cam', label: t('meetings.device.camera'), st: t('meetings.prejoin.stOn'), stCls: 'text-muted-foreground', name: label(curCam, true) || t('meetings.prejoin.nameNone'),
    tgIc: 'video', tgTxt: t('meetings.prejoin.tgOn'), tgCls: OK_TG, tgAria: t('meetings.prejoin.ariaCamOff'), tgDisabled: false, pressed: true,
    selAria: t('meetings.prejoin.ariaCamSelect'), selDisabled: false, selCls: '', bd: BD, meter: false, level: 0, open: openList === 'cam',
  }
  let spk: Cell = {
    key: 'spk', label: t('meetings.device.speaker'), st: curSpk?.isDefault ? t('meetings.prejoin.stDefault') : '', stCls: 'text-muted-foreground', name: label(curSpk, false),
    tgIc: 'audio-lines', tgTxt: t('meetings.prejoin.tgTest'), tgCls: OK_TG, tgAria: t('meetings.prejoin.ariaSpkTest'), tgDisabled: false,
    selAria: t('meetings.prejoin.ariaSpkSelect'), selDisabled: false, selCls: '', bd: BD, meter: false, level: 0, open: openList === 'spk',
  }
  if (phase === 'requesting') {
    const chk = { st: t('meetings.prejoin.stChecking'), name: t('meetings.prejoin.nameNone'), tgDisabled: true, selDisabled: true }
    mic = { ...mic, ...chk, meter: false }
    cam = { ...cam, ...chk }
    spk = { ...spk, ...chk }
  } else if (phase === 'denied') {
    mic = { ...blocked(mic, t('meetings.prejoin.stNoPerm')), tgIc: 'mic-off', name: t('meetings.prejoin.nameNoPerm'), selDisabled: true }
    cam = { ...blocked(cam, t('meetings.prejoin.stNoPerm')), tgIc: 'video-slash', name: t('meetings.prejoin.nameNoPerm'), selDisabled: true }
  } else if (phase === 'ready') {
    if (micIssue) {
      mic = { ...blocked(mic, issueText(micIssue)), tgIc: 'mic-off', name: micIssue === 'none' ? t('meetings.prejoin.nameNoMic') : micIssue === 'denied' ? t('meetings.prejoin.nameNoPerm') : label(curMic, true) || t('meetings.prejoin.nameNone'), selDisabled: micIssue === 'none' && microphones.length === 0 }
    } else if (!micOn) {
      mic = { ...mic, pressed: false, st: t('meetings.prejoin.stOff'), tgIc: 'mic-off', tgTxt: t('meetings.prejoin.tgOff'), tgCls: OFF_TG, tgAria: t('meetings.prejoin.ariaMicOn'), level: 0 }
    }
    if (camIssue) {
      cam = { ...blocked(cam, issueText(camIssue)), tgIc: 'video-slash', name: camIssue === 'none' ? t('meetings.prejoin.nameNoCamera') : camIssue === 'denied' ? t('meetings.prejoin.nameNoPerm') : label(curCam, true) || t('meetings.prejoin.nameNone'), selDisabled: camIssue === 'none' && cameras.length === 0 }
    } else if (!cameraOn) {
      cam = { ...cam, pressed: false, st: t('meetings.prejoin.stOff'), tgIc: 'video-slash', tgTxt: t('meetings.prejoin.tgOff'), tgCls: OFF_TG, tgAria: t('meetings.prejoin.ariaCamOn') }
    }
  }
  if (phase !== 'requesting') {
    if (!sinkSupported) {
      spk = { ...spk, name: t('meetings.prejoin.nameSystemDefault'), st: t('meetings.prejoin.stNoSink'), selCls: 'opacity-60', selDisabled: true }
    } else if (!curSpk) {
      spk = { ...spk, name: t('meetings.prejoin.nameSystemDefault'), st: t('meetings.prejoin.stDefault'), selDisabled: speakers.length === 0 }
    } else if (paired) {
      spk = { ...spk, st: t('meetings.prejoin.stPaired'), stCls: 'text-primary', bd: 'border-primary/60' }
    }
    if (testing) spk = { ...spk, tgCls: TEST_TG, tgTxt: t('meetings.prejoin.tgPlaying') }
  }
  if (openList) {
    if (openList === 'mic') mic = { ...mic, bd: 'border-primary' }
    if (openList === 'cam') cam = { ...cam, bd: 'border-primary' }
    if (openList === 'spk') spk = { ...spk, bd: 'border-primary' }
  }
  const cells: Cell[] = [mic, cam, spk]

  // 목록 항목
  const options: Option[] = openList === 'mic'
    ? microphones.map(m => ({ id: m.deviceId, label: label(m, false), tag: m.isDefault ? t('meetings.prejoin.tagDefault') : '', selected: m.deviceId === selectedMicId, level: m.deviceId === selectedMicId ? (micOn && !micIssue ? micLevel : 0) : (m.deviceId in probeLevels ? probeLevels[m.deviceId] : null) }))
    : openList === 'cam'
      ? cameras.map(c => ({ id: c.deviceId, label: label(c, false), tag: c.isDefault ? t('meetings.prejoin.tagDefault') : '', selected: c.deviceId === selectedCameraId, level: null }))
      : openList === 'spk'
        ? speakers.map(s => ({ id: s.deviceId, label: label(s, false), tag: s.isDefault ? t('meetings.prejoin.tagDefault') : '', selected: s.deviceId === selectedSpeakerId, level: null }))
        : []
  const pickOption = (id: string) => { if (openList === 'mic') pickMic(id); else if (openList === 'cam') pickCamera(id); else if (openList === 'spk') pickSpeaker(id) }
  const listTitle = openList === 'mic' ? t('meetings.device.mic') : openList === 'cam' ? t('meetings.device.camera') : t('meetings.device.speaker')
  const listAria = openList === 'mic' ? mic.selAria : openList === 'cam' ? cam.selAria : spk.selAria

  // 미리보기
  type Overlay = { ic: string; icc: string; title: string; desc: string; short: string; addr?: string; btn: string; btnV: 'default' | 'outline'; onBtn: () => void }
  let overlay: Overlay | null = null
  let avatarText = ''
  if (phase === 'requesting') {
    overlay = { ic: 'loader', icc: 'animate-spin text-white', title: t('meetings.prejoin.req.title'), desc: t('meetings.prejoin.req.desc'), short: t('meetings.prejoin.req.desc'), btn: t('common.retry'), btnV: 'outline', onBtn: retry }
  } else if (phase === 'denied') {
    overlay = { ic: 'lock', icc: 'text-warning', title: t('meetings.prejoin.denied.title'), desc: t(permissionHintKey(browser, 'long')), short: t(permissionHintKey(browser, 'short')), btn: t('common.retry'), btnV: 'default', onBtn: retry }
  } else if (phase === 'insecure') {
    overlay = { ic: 'lock', icc: 'text-warning', title: t('meetings.prejoin.http.title'), desc: t('meetings.prejoin.http.desc'), short: t('meetings.prejoin.http.short'), addr: typeof window !== 'undefined' ? httpsUrlFor(window.location) : '', btn: t('meetings.prejoin.http.open'), btnV: 'default', onBtn: openHttps }
  } else if (camIssue === 'inuse') {
    overlay = { ic: 'video-slash', icc: 'text-warning', title: t('meetings.prejoin.inuse.title'), desc: t('meetings.prejoin.inuse.desc'), short: t('meetings.prejoin.inuse.short'), btn: t('common.retry'), btnV: 'default', onBtn: retry }
  } else if (camIssue === 'lost') {
    overlay = { ic: 'video-slash', icc: 'text-warning', title: t('meetings.prejoin.lost.title'), desc: t('meetings.prejoin.lost.desc'), short: t('meetings.prejoin.lost.short'), btn: t('meetings.prejoin.lost.reconnect'), btnV: 'default', onBtn: retry }
  } else if (camIssue) {
    avatarText = t('meetings.prejoin.noCameraAvatar')
  } else if (!cameraOn) {
    avatarText = t('meetings.prejoin.cameraOff')
  }
  const showAvatar = phase === 'ready' && !overlay && !showVideo
  const micBadge = phase === 'ready' ? (micIssue === 'none' ? t('meetings.prejoin.micNoneBadge') : (!micOn && !micIssue) ? t('meetings.prejoin.micOffBadge') : '') : ''
  const selfInitial = (selfName || '').trim().charAt(0) || t('meetings.participant.me').replace(/[()]/g, '').charAt(0) || '?'
  const selfTag = selfName?.trim() ? t('meetings.prejoin.selfTag', { name: selfName.trim() }) : t('meetings.prejoin.selfTagAnon')

  // 알림 줄
  const notice: { text: string; link?: string; onLink?: () => void } | null = !insecure && paired
    ? { text: t('meetings.prejoin.bt.notice', { name: paired.name }), link: t('meetings.prejoin.bt.undo'), onLink: undoPairing }
    : (!insecure && phase !== 'requesting' && !sinkSupported ? { text: t('meetings.prejoin.nosink.notice') } : null)

  // 참가 버튼 + 아래 한 줄
  // 잠금은 손님 이름 미입력(호출부 guestJoinLock)에만 적용 — 사유는 버튼 바로 아래에 표시
  const lockReason = joinDisabled ? (joinDisabledReason || t('meetings.prejoin.guestNameLock')) : ''
  const note = joinNoteFor({ phase, cameraOn, micOn, camera: camIssue, mic: micIssue })
  const joinNote = lockReason ? { text: lockReason, cls: 'text-muted-foreground', ic: 'info' } : note ? { text: t(note.key), cls: note.tone === 'warning' ? 'text-warning' : 'text-muted-foreground', ic: note.tone === 'warning' ? 'alert-triangle' : 'info' } : null
  const joinText = busy ? (busyLabel || t('meetings.join.requesting')) : (joinLabel || t('meetings.device.joinDefault'))
  const hasStatus = status != null && status !== false

  const waitingBand = (compact: boolean) => (
    <div role="status" className={cn('flex items-center gap-3 rounded-lg border border-primary/50 bg-primary/10 text-[14px]', compact ? 'px-3 py-2.5' : 'px-4 py-3.5')}>
      <UiIcon name="loader" className="h-5 w-5 shrink-0 animate-spin text-primary" />
      {compact
        ? <span className="flex-1">{t('meetings.prejoin.waiting.short')} · <span className="font-mono">{elapsed}</span></span>
        : (
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">{t('meetings.prejoin.waiting.title')}</span>
            <span className="block text-[13px] text-muted-foreground"><UiTrans k="meetings.prejoin.waiting.since" slots={{ t: <span className="font-mono">{elapsed}</span> }} /></span>
          </span>
        )}
      <UiButton variant="ghost" size={compact ? 'lg' : 'sm'} className="shrink-0" onClick={() => onCancel?.()}>{t('common.cancel')}</UiButton>
    </div>
  )

  const joinArea = (compact: boolean) => (
    waiting ? waitingBand(compact) : hasStatus ? status : (
      <>
        <UiButton size="lg" className="w-full" disabled={!!joinDisabled || !!busy} onClick={handleJoin}>{joinText}</UiButton>
        {joinNote && (
          <p className={cn('flex items-center gap-1.5 text-[13px]', compact && 'justify-center', joinNote.cls)}>
            {!compact && <UiIcon name={joinNote.ic} className="h-4 w-4 shrink-0" />}
            {joinNote.text}
          </p>
        )}
        {/* 접속 중에도 취소 가능 — 화면이 내려가며 진행 중인 입장을 취소함(cancelPendingJoin) */}
        {!compact && cancelable && <UiButton variant="ghost" size="default" className="w-full" onClick={() => onCancel?.()}>{t('common.cancel')}</UiButton>}
      </>
    )
  )

  const debugBox = showDebug && debugInfo
    ? <p className="max-w-full break-all rounded-sm bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">{debugInfo}</p>
    : null

  // 미리보기 안
  const previewInner = (compact: boolean) => (
    <>
      {showVideo && (
        <>
          <video ref={videoEl} autoPlay playsInline muted className="absolute inset-0 h-full w-full object-cover" style={{ transform: 'scaleX(-1)' }} />
          {!compact && <span className="absolute bottom-3 left-3 rounded-md bg-black/60 px-2.5 py-1 text-[13px] text-white">{selfTag}</span>}
        </>
      )}
      {showAvatar && (
        <div className={cn('absolute inset-0 flex flex-col items-center justify-center', compact ? 'gap-2' : 'gap-3')}>
          <UiAvatar fallback={selfInitial} textSize={compact ? 28 : 36} className={compact ? 'h-20 w-20' : 'h-24 w-24'} />
          <span className="flex items-center gap-1.5 text-[14px] text-white/80"><UiIcon name="video-slash" className="h-4 w-4" />{avatarText}</span>
        </div>
      )}
      {overlay && (
        <div role="alert" className={cn('absolute inset-0 flex flex-col items-center justify-center overflow-hidden bg-black/55 text-center text-white', compact ? 'gap-2 px-5' : 'gap-2.5 px-8 py-4')}>
          <UiIcon name={overlay.ic} className={cn(compact ? 'h-7 w-7' : 'h-8 w-8', overlay.icc)} />
          <h2 className={cn('font-semibold', compact ? 'text-[16px]' : 'text-[18px]')}>{overlay.title}</h2>
          <p className={cn('text-[14px] text-white/85', compact ? 'leading-snug' : 'max-w-[520px] leading-relaxed')}>{compact ? overlay.short : overlay.desc}</p>
          {overlay.addr && <span className="max-w-full truncate whitespace-nowrap rounded-md border border-white/30 bg-black/40 px-3 py-1.5 font-mono text-[13px]">{overlay.addr}</span>}
          <UiButton variant={overlay.btnV} size={compact ? 'lg' : 'default'} className={cn('px-5 font-semibold', compact ? 'text-[15px]' : 'text-[14px]', overlay.btnV === 'outline' && 'border-white/40 bg-transparent text-white hover:bg-white/10 hover:text-white')} onClick={overlay.onBtn}>{overlay.btn}</UiButton>
          {debugBox}
        </div>
      )}
      {micBadge && (
        <span className={cn('absolute flex items-center gap-1.5 rounded-md bg-danger text-[13px] text-danger-foreground', compact ? 'left-2 top-2 px-2 py-1' : 'left-3 top-3 px-2.5 py-1 font-medium')}>
          <UiIcon name="mic-off" className="h-4 w-4" />{micBadge}
        </span>
      )}
    </>
  )

  const noticeRow = (compact: boolean) => notice && (
    <div role="status" className={cn('flex gap-2 text-[14px]', compact ? 'items-start' : 'items-center px-1')}>
      <UiIcon name="info" className={cn('h-4 w-4 shrink-0 text-primary', compact && 'mt-0.5')} />
      <span className="min-w-0 flex-1">{notice.text}</span>
      {notice.link && <button type="button" className="shrink-0 text-[13px] text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring rounded-sm" onClick={notice.onLink}>{notice.link}</button>}
    </div>
  )

  const brand = (
    <div className="flex h-7 items-center gap-2 text-[14px] font-semibold">
      {brandLoaded && (
        brandLogo
          ? <img src={brandLogo} alt="" className="h-7 w-7 rounded-md object-cover" />
          : <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-[13px] text-primary-foreground" aria-hidden="true">{brandInitial}</span>
      )}
      {brandLoaded && <span>{appName}</span>}
    </div>
  )

  // ── 데스크톱 ──
  if (desk) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background px-10 py-8 text-foreground">
        <div className="grid w-full items-start gap-10" style={{ maxWidth: 1280, gridTemplateColumns: 'minmax(0,1fr) 380px' }}>
          <div className="flex min-w-0 flex-col gap-3">
            <div className="relative overflow-hidden rounded-xl border border-muted-foreground/30 bg-stage" style={{ aspectRatio: '16/9' }}>
              {previewInner(false)}
            </div>
            {!insecure
              ? (
                <div ref={barRef} role="group" aria-label={t('meetings.prejoin.group')} className="grid gap-3" style={{ gridTemplateColumns: 'repeat(3,minmax(0,1fr))' }}>
                  {cells.map(c => (
                    <DeviceCell
                      key={c.key} c={c} compact={false}
                      onToggle={c.key === 'mic' ? toggleMic : c.key === 'cam' ? toggleCamera : () => void testSpeaker()}
                      onOpen={() => setOpenList(openList === c.key ? null : c.key)}
                    >
                      {c.open && (
                        <OptionList
                          options={options} ariaLabel={listAria} compact={false} onPick={pickOption}
                          onClose={(focusTrigger) => { setOpenList(null); if (focusTrigger) barRef.current?.querySelector<HTMLElement>(`[data-sel="${c.key}"]`)?.focus() }}
                          footer={c.key === 'spk' && testing ? 'playing' : null}
                        />
                      )}
                    </DeviceCell>
                  ))}
                </div>
              )
              : (
                <div className="flex h-14 items-center gap-3 rounded-lg border border-muted-foreground/40 bg-card px-4 text-[14px]">
                  <UiIcon name="lock" className="h-5 w-5 text-warning" />
                  <span className="flex-1">{t('meetings.prejoin.http.bar')}</span>
                </div>
              )}
            {noticeRow(false)}
          </div>
          <div className="flex flex-col gap-5 pt-2">
            {brand}
            <div>
              <h1 className="text-[26px] font-bold leading-tight tracking-tight">{roomName}</h1>
              <p className="mt-2 text-[14px] text-muted-foreground">{meta || subtitle || t('meetings.device.subtitle')}</p>
            </div>
            {children != null && children !== false && <div className="flex flex-col gap-4">{children}</div>}
            <div className="flex flex-col gap-2">{joinArea(false)}</div>
          </div>
        </div>
      </div>
    )
  }

  // ── 모바일 ──
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        {cancelable && <UiIconButton icon="arrow-left" label={t('common.back')} size="md" onClick={() => onCancel?.()} />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-semibold">{roomName}</div>
          {(meta || subtitle) && <div className="truncate text-[13px] text-muted-foreground">{meta || subtitle}</div>}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4 pt-4">
        <div className="relative shrink-0 overflow-hidden rounded-xl border border-muted-foreground/30 bg-stage" style={{ aspectRatio: '4/3' }}>
          {previewInner(true)}
        </div>
        {!insecure
          ? (
            <div ref={barRef} role="group" aria-label={t('meetings.prejoin.group')} className="flex shrink-0 flex-col overflow-hidden rounded-lg border border-muted-foreground/40 bg-card">
              {cells.map(c => (
                <DeviceCell
                  key={c.key} c={c} compact
                  onToggle={c.key === 'mic' ? toggleMic : c.key === 'cam' ? toggleCamera : () => void testSpeaker()}
                  onOpen={() => setOpenList(c.key)}
                />
              ))}
            </div>
          )
          : (
            <div className="flex items-center gap-2 rounded-lg border border-muted-foreground/40 bg-card px-3 py-3 text-[14px]">
              <UiIcon name="lock" className="h-5 w-5 shrink-0 text-warning" />
              {t('meetings.prejoin.http.barShort')}
            </div>
          )}
        {noticeRow(true)}
        {children != null && children !== false && <div className="flex flex-col gap-4">{children}</div>}
      </div>
      <div className="flex shrink-0 flex-col gap-1.5 border-t border-border bg-background px-4 pt-3" style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}>
        {joinArea(true)}
      </div>
      {openList && (
        <UiActionSheet label={listTitle} onClose={() => setOpenList(null)}>
          <div className="flex h-12 items-center px-4 text-[16px] font-semibold">
            <span className="flex-1">{listTitle}</span>
            <UiIconButton icon="close" label={t('common.close')} size="md" onClick={() => setOpenList(null)} />
          </div>
          <OptionList options={options} ariaLabel={listAria} compact onPick={pickOption} onClose={() => setOpenList(null)} footer={openList === 'spk' && testing ? 'playing' : null} />
        </UiActionSheet>
      )}
    </div>
  )
}

/** 장치 칸 하나(데스크톱 카드 · 모바일 행). children = 팝오버(데스크톱) */
function DeviceCell({ c, compact, onToggle, onOpen, children }: { c: Cell; compact: boolean; onToggle: () => void; onOpen: () => void; children?: ReactNode }) {
  const segs = meterSegments(c.level, 20)
  const toggleCls = 'shrink-0 rounded-md transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default'
  const selCls = 'flex min-w-0 flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default'
  if (compact) {
    return (
      <div className="flex flex-col gap-1.5 border-b border-border px-3 py-2 last:border-b-0">
        <div className="flex items-center gap-3">
          <button type="button" aria-label={c.tgAria} aria-pressed={c.pressed} disabled={c.tgDisabled} className={cn(toggleCls, 'flex h-11 w-11 items-center justify-center', c.tgCls)} onClick={onToggle}>
            <UiIcon name={c.tgIc} className="h-5 w-5" />
          </button>
          <button type="button" data-sel={c.key} aria-label={c.selAria} aria-haspopup="listbox" disabled={c.selDisabled} className={cn(selCls, 'min-h-11', c.selCls)} onClick={onOpen}>
            <span className="min-w-0 flex-1">
              <span className={cn('block text-[13px]', c.stCls)}>{c.label}{c.st ? ` · ${c.st}` : ''}</span>
              <span className="block truncate text-[14px] font-medium">{c.name}</span>
            </span>
            <UiIcon name="chevron-right" className="h-5 w-5 text-muted-foreground" />
          </button>
        </div>
        {c.meter && (
          <div aria-hidden="true" className="flex gap-[3px] pl-14">
            {segs.map((g, i) => <span key={i} className={cn('h-2 flex-1 rounded-sm', SEG_CLS[g])} />)}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="relative min-w-0">
      <div className={cn('flex flex-col gap-2 rounded-lg border bg-card px-3 py-2.5', c.bd)}>
        <div className="flex items-center gap-3">
          <button type="button" aria-label={c.tgAria} aria-pressed={c.pressed} disabled={c.tgDisabled} className={cn(toggleCls, 'flex h-11 items-center gap-1.5 px-2.5 text-[13px] font-medium', c.tgCls)} onClick={onToggle}>
            <UiIcon name={c.tgIc} className="h-5 w-5" />{c.tgTxt}
          </button>
          <button type="button" data-sel={c.key} aria-label={c.selAria} aria-haspopup="listbox" aria-expanded={c.open} disabled={c.selDisabled} className={cn(selCls, 'px-1.5 py-1 hover:bg-accent/60', c.selCls)} onClick={onOpen}>
            <span className="min-w-0 flex-1">
              <span className={cn('block text-[13px]', c.stCls)}>{c.label}{c.st ? ` · ${c.st}` : ''}</span>
              <span className="block truncate text-[14px] font-medium">{c.name}</span>
            </span>
            <UiIcon name="chevron-down" className="h-5 w-5 shrink-0 text-muted-foreground" />
          </button>
        </div>
        {c.meter && (
          <div aria-hidden="true" className="flex gap-[3px] px-0.5">
            {segs.map((g, i) => <span key={i} className={cn('h-2 flex-1 rounded-sm', SEG_CLS[g])} />)}
          </div>
        )}
      </div>
      {children}
    </div>
  )
}

/**
 * 장치 목록(listbox/option). 데스크톱 = 칸 위로 열리는 팝오버(칸 폭, 최소 340) · 모바일 = 시트 내부 행(56).
 * ↑↓ 이동 · Enter/Space 선택 · Esc 닫기(연 버튼으로 포커스 이동) · Tab 닫기. 마이크 항목은 12칸 레벨.
 */
function OptionList({ options, ariaLabel, compact, onPick, onClose, footer }: {
  options: Option[]; ariaLabel: string; compact: boolean; onPick: (id: string) => void; onClose: (focusTrigger: boolean) => void; footer: 'playing' | null
}) {
  const { t } = useI18n()
  const root = useRef<HTMLDivElement | null>(null)
  const items = () => Array.from(root.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
  useEffect(() => {
    if (compact) return
    const els = items()
    ;(els.find(el => el.getAttribute('aria-selected') === 'true') ?? els[0])?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const els = items()
    const i = els.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); els[(i + 1) % els.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus() }
    else if (e.key === 'Home') { e.preventDefault(); els[0]?.focus() }
    else if (e.key === 'End') { e.preventDefault(); els[els.length - 1]?.focus() }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(true) }
    else if (e.key === 'Tab' && !compact) { onClose(true) }
  }
  const rows = options.map(o => (
    <div
      key={o.id} role="option" aria-selected={o.selected} tabIndex={-1}
      className={cn(
        'flex cursor-pointer items-center gap-3 outline-hidden hover:bg-accent/60 focus-visible:bg-accent',
        compact ? 'min-h-14 px-4 py-2 text-[15px]' : 'min-h-12 px-3 py-1.5 text-[14px]',
        o.selected && 'bg-primary/10',
      )}
      onClick={() => onPick(o.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(o.id) } }}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-primary">{o.selected && <UiIcon name="check" className="h-4 w-4" strokeWidth={2.4} />}</span>
      <span className="min-w-0 flex-1">
        <span className={cn('block', !compact && 'truncate', o.selected && 'font-semibold')}>{o.label}</span>
        {o.level !== null && (
          <span className="mt-1 flex gap-[2px]" aria-hidden="true">
            {meterSegments(o.level, 12).map((g, i) => <span key={i} className={cn('h-1.5 w-3 rounded-sm', SEG_CLS[g])} />)}
          </span>
        )}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{o.tag}</span>
    </div>
  ))
  if (compact) {
    return (
      <div ref={root} role="listbox" aria-label={ariaLabel} onKeyDown={onKey}>
        {rows}
        {footer === 'playing' && (
          <div className="mx-4 mt-2 flex h-11 items-center justify-center gap-1.5 rounded-md bg-primary/15 text-[14px] font-medium text-primary">{t('meetings.prejoin.sheetPlaying')}</div>
        )}
      </div>
    )
  }
  return (
    <div
      ref={root} role="listbox" aria-label={ariaLabel} onKeyDown={onKey}
      className="absolute bottom-full left-0 z-dropdown mb-2 flex w-full flex-col rounded-lg border border-muted-foreground/40 bg-popover py-1.5 shadow-md"
      style={{ minWidth: 340 }}
    >
      {rows}
      {footer === 'playing' && (
        <div className="mt-1 flex items-center gap-2 border-t border-border px-3 pt-2 text-[13px]">
          <span className="flex h-9 items-center gap-1.5 rounded-md bg-primary/15 px-3 font-medium text-primary"><UiIcon name="audio-lines" className="h-4 w-4" />{t('meetings.prejoin.playingDots')}</span>
          <span className="text-muted-foreground">{t('meetings.prejoin.listenHint')}</span>
        </div>
      )}
    </div>
  )
}

export default MeetingsDeviceSetup
