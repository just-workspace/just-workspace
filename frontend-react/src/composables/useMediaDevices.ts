/**
 * 미디어 장치 목록 — 열거·정리·짝짓기.
 *
 * 브라우저가 주는 목록은 그대로 쓰기 어렵다. Windows 는 같은 장치를
 * "Default - ...", "Communications - ...", 그리고 실제 항목까지 세 번 내놓고,
 * 라벨 끝에는 USB ID 가 붙는다. 블루투스 헤드셋은 마이크와 스피커가 따로
 * 잡히지만 실제로는 한 몸이라 하나를 고르면 나머지도 따라가야 한다.
 *
 * React: const { cameras, microphones, speakers, audioOutputSupported, refresh, pairedSpeakerFor, startListening, stopListening } = useMediaDevices()
 * 컴포넌트 밖: mediaDevicesStore.getState() / refreshMediaDevices() / mediaDevicesApi()
 */
import { useState } from 'react'
import { createStore, useStore } from 'zustand'
import { i18n } from '~/i18n'

export interface NormalizedDevice {
  deviceId: string
  groupId: string
  label: string        // 화면에 보일 이름
  rawLabel: string     // 브라우저 원문
  isBluetooth: boolean
  isDefault: boolean   // 브라우저가 기본으로 잡은 항목
}

const VIRTUAL_PREFIX = /^(default|communications|기본값|통신)\s*[-–—]\s*/i
const USB_ID_SUFFIX = /\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i
const BT_HINT = /bluetooth|블루투스|\bbt\b|hands-?free|headset|buds|airpods|galaxy buds|wf-|wh-/i

export function normalizeLabel(raw: string): string {
  return (raw || '')
    .replace(VIRTUAL_PREFIX, '')
    .replace(USB_ID_SUFFIX, '')
    .trim()
}

function isVirtualId(id: string): boolean {
  return id === 'default' || id === 'communications'
}

/** 같은 실제 장치를 가리키는 항목을 하나로 접는다. default/communications 보다 실제 항목 우선. */
export function normalizeDeviceList(devices: MediaDeviceInfo[], fallbackName: string): NormalizedDevice[] {
  const out: NormalizedDevice[] = []
  const byKey = new Map<string, number>()

  for (const d of devices) {
    const rawLabel = d.label || ''
    const label = normalizeLabel(rawLabel)
    // groupId 가 없는 브라우저(구형 Safari)는 정규화한 라벨을 키로 쓴다
    const key = d.groupId || label || d.deviceId
    const entry: NormalizedDevice = {
      deviceId: d.deviceId,
      groupId: d.groupId || '',
      label: label || `${fallbackName} ${out.length + 1}`,
      rawLabel,
      isBluetooth: BT_HINT.test(rawLabel),
      isDefault: isVirtualId(d.deviceId) || VIRTUAL_PREFIX.test(rawLabel),
    }
    const seen = byKey.get(key)
    if (seen === undefined) {
      byKey.set(key, out.length)
      out.push(entry)
      continue
    }
    const kept = out[seen]
    // 실제 deviceId 를 가진 쪽을 남기되, 기본 장치라는 사실은 물려준다
    if (isVirtualId(kept.deviceId) && !isVirtualId(entry.deviceId)) {
      out[seen] = { ...entry, isDefault: kept.isDefault || entry.isDefault }
    } else {
      kept.isDefault = kept.isDefault || entry.isDefault
    }
  }
  return out
}

/** 앱 전역 장치 목록: 카메라 · 마이크 · 스피커 */
export const mediaDevicesStore = createStore<{ cameras: NormalizedDevice[]; microphones: NormalizedDevice[]; speakers: NormalizedDevice[] }>()(() => ({
  cameras: [],
  microphones: [],
  speakers: [],
}))

/**
 * 스피커 선택 가능 여부. iOS Safari 는 setSinkId 가 없고 audiooutput 도 안 내놓는다.
 * 이 값이 false 면 스피커 선택 UI 를 아예 감춘다.
 */
function isAudioOutputSupported(speakers: NormalizedDevice[]): boolean {
  const canSink = typeof HTMLMediaElement !== 'undefined'
    && 'setSinkId' in HTMLMediaElement.prototype
  return canSink && speakers.length > 0
}

export async function refreshMediaDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return
  try {
    const list = await navigator.mediaDevices.enumerateDevices()
    mediaDevicesStore.setState({
      cameras: normalizeDeviceList(list.filter(d => d.kind === 'videoinput'), i18n.t('meetings.device.camera')),
      microphones: normalizeDeviceList(list.filter(d => d.kind === 'audioinput'), i18n.t('meetings.device.mic')),
      speakers: normalizeDeviceList(list.filter(d => d.kind === 'audiooutput'), i18n.t('meetings.device.speaker')),
    })
  } catch { /* 권한 전이면 빈 목록 */ }
}

/** 이 마이크와 한 몸인 스피커(같은 groupId). 블루투스 헤드셋을 고를 때 쓴다. */
export function pairedSpeakerFor(micId: string): NormalizedDevice | null {
  const { microphones, speakers } = mediaDevicesStore.getState()
  const mic = microphones.find(m => m.deviceId === micId)
  if (!mic?.groupId) return null
  return speakers.find(s => s.groupId === mic.groupId) || null
}

/**
 * devicechange 감시. `listening` 은 인스턴스별이다 —
 * 인스턴스(hook 하나·mediaDevicesApi() 하나)마다 자기 시작/중지.
 */
function makeListener() {
  let listening = false
  const startListening = () => {
    if (listening || !navigator.mediaDevices) return
    navigator.mediaDevices.addEventListener?.('devicechange', refreshMediaDevices)
    listening = true
  }
  const stopListening = () => {
    if (!listening || !navigator.mediaDevices) return
    navigator.mediaDevices.removeEventListener?.('devicechange', refreshMediaDevices)
    listening = false
  }
  return { startListening, stopListening }
}

/** 컴포넌트 밖(useMeetings 등)에서 쓰는 객체(목록은 mediaDevicesStore) */
export function mediaDevicesApi() {
  return { refresh: refreshMediaDevices, pairedSpeakerFor, ...makeListener() }
}

export function useMediaDevices() {
  const cameras = useStore(mediaDevicesStore, s => s.cameras)
  const microphones = useStore(mediaDevicesStore, s => s.microphones)
  const speakers = useStore(mediaDevicesStore, s => s.speakers)
  const [listener] = useState(makeListener)
  return {
    cameras, microphones, speakers,
    audioOutputSupported: isAudioOutputSupported(speakers),
    refresh: refreshMediaDevices, pairedSpeakerFor,
    startListening: listener.startListening, stopListening: listener.stopListening,
  }
}
