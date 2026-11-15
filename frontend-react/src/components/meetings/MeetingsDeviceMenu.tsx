/**
 * 회의 중 장치 전환 팝오버. 컨트롤 바의 "장치" 버튼이 연다. Vue 판 components/meetings/MeetingsDeviceMenu.vue 그대로.
 * 기존 폼 토큰(label + select)만 쓴다 — 시안이 오면 이 자리를 갈아끼운다.
 */
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { useMeetings } from '~/composables/useMeetings'
import { mediaDevicesStore, useMediaDevices } from '~/composables/useMediaDevices'
import { addToast } from '~/composables/useToast'
import { UiIcon } from '~/components/ui/Icon'

export interface MeetingsDeviceMenuProps {
  /** 닫기(✕) */
  onClose?: () => void
}

type Kind = 'videoinput' | 'audioinput' | 'audiooutput'

const selectClass = 'w-full text-sm px-2 py-1.5 rounded-md border border-border bg-background focus:outline-hidden focus:ring-2 focus:ring-ring truncate disabled:opacity-50'

/** 회의 중 카메라·마이크·스피커 전환 팝오버(컨트롤 바 위) */
export function MeetingsDeviceMenu({ onClose }: MeetingsDeviceMenuProps) {
  const { t } = useI18n()
  const { switchActiveDevice, getActiveDevice, micEnabled, cameraEnabled } = useMeetings()
  const {
    cameras, microphones, speakers, audioOutputSupported,
    refresh, pairedSpeakerFor, startListening, stopListening,
  } = useMediaDevices()

  const [camId, setCamId] = useState('')
  const [micId, setMicId] = useState('')
  const [spkId, setSpkId] = useState('')
  const [busy, setBusy] = useState<'' | Kind>('')
  const speakerTouched = useRef(false)
  const [pairedNotice, setPairedNotice] = useState('')

  // onMounted: 감시 시작 → 목록 갱신 → 지금 쓰는 장치(없으면 첫 장치)로 채운다. 채우는 것도 아래 "바뀌면 적용"을 탄다(Vue watch 와 같음).
  useEffect(() => {
    startListening()
    void (async () => {
      await refresh()
      const s = mediaDevicesStore.getState()
      setCamId(getActiveDevice('videoinput') || s.cameras[0]?.deviceId || '')
      setMicId(getActiveDevice('audioinput') || s.microphones[0]?.deviceId || '')
      setSpkId(getActiveDevice('audiooutput') || s.speakers[0]?.deviceId || '')
    })()
    return () => stopListening()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 실패해서 되돌린 값 — 되돌리며 다시 "바뀌면 적용"을 타지 않게 한 번 건너뛴다
  const reverted = useRef<Partial<Record<Kind, string>>>({})
  async function apply(kind: Kind, id: string) {
    if (!id) return
    if (reverted.current[kind] === id) { delete reverted.current[kind]; return }
    setBusy(kind)
    try {
      await switchActiveDevice(kind, id)
    } catch (e) {
      console.error('[meet] 장치 전환 실패', kind, e)
      // 예전엔 콘솔에만 남겨, 목록은 새 장치를 가리키는데 실제로는 예전 장치가 쓰이고 있었다
      addToast('error', t('meetings.device.switchFail', '장치를 바꾸지 못했습니다. 연결을 확인해 주세요'))
      const prev = getActiveDevice(kind)
      if (prev && prev !== id) {
        reverted.current[kind] = prev
        ;(kind === 'videoinput' ? setCamId : kind === 'audioinput' ? setMicId : setSpkId)(prev)
      }
    } finally {
      setBusy('')
    }
  }

  // Vue: watch(camId) / watch(spkId) / watch(micId) — 값이 바뀔 때마다 적용
  const spkRef = useRef(spkId)
  spkRef.current = spkId
  const outSupportedRef = useRef(audioOutputSupported)
  outSupportedRef.current = audioOutputSupported

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void apply('videoinput', camId) }, [camId])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void apply('audiooutput', spkId) }, [spkId])
  useEffect(() => {
    void (async () => {
      await apply('audioinput', micId)
      if (!micId || speakerTouched.current || !outSupportedRef.current) return
      const paired = pairedSpeakerFor(micId)
      if (paired && paired.deviceId !== spkRef.current) {
        setSpkId(paired.deviceId)
        setPairedNotice(paired.label)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micId])

  return (
    <div
      className="absolute bottom-full right-2 mb-2 z-drawer w-72 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-card p-3 shadow-lg space-y-3"
      onClick={e => e.stopPropagation()}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{t('meetings.controls.devices')}</span>
        <button onClick={() => onClose?.()} className="text-muted-foreground hover:text-foreground" title={t('common.close')}>
          <UiIcon name="close" className="h-4 w-4" />
        </button>
      </div>

      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1">{t('meetings.device.camera')}</label>
        <select
          value={camId}
          onChange={e => setCamId(e.target.value)}
          className={selectClass}
          disabled={cameras.length === 0 || !cameraEnabled || busy === 'videoinput'}
        >
          {cameras.length === 0 && <option value="">{t('meetings.device.noCamera')}</option>}
          {cameras.map(c => (
            <option key={c.deviceId} value={c.deviceId}>
              {c.label}{c.isBluetooth ? ` (${t('meetings.device.bluetooth')})` : ''}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1">{t('meetings.device.mic')}</label>
        <select
          value={micId}
          onChange={e => setMicId(e.target.value)}
          className={selectClass}
          disabled={microphones.length === 0 || !micEnabled || busy === 'audioinput'}
        >
          {microphones.length === 0 && <option value="">{t('meetings.device.noMic')}</option>}
          {microphones.map(m => (
            <option key={m.deviceId} value={m.deviceId}>
              {m.label}{m.isBluetooth ? ` (${t('meetings.device.bluetooth')})` : ''}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1">{t('meetings.device.speaker')}</label>
        {!audioOutputSupported
          ? <p className="text-xs text-muted-foreground">{t('meetings.device.speakerUnsupported')}</p>
          : (
            <select
              value={spkId}
              onChange={(e) => { setSpkId(e.target.value); speakerTouched.current = true }}
              className={selectClass}
              disabled={speakers.length === 0 || busy === 'audiooutput'}
            >
              {speakers.map(s => (
                <option key={s.deviceId} value={s.deviceId}>
                  {s.label}{s.isBluetooth ? ` (${t('meetings.device.bluetooth')})` : ''}
                </option>
              ))}
            </select>
          )}
        {pairedNotice && (
          <p className="text-xs text-primary mt-1">
            {t('meetings.device.pairedSpeaker', { name: pairedNotice })}
          </p>
        )}
      </div>
    </div>
  )
}

export default MeetingsDeviceMenu
