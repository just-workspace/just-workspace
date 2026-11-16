/**
 * 참가자 타일 하나(영상·아바타·이름·마이크 점·연결 품질·화면 공유 오버레이·원격 오디오).
 */
import { useEffect, useRef } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { UiIcon } from '~/components/ui/Icon'

export interface MeetingsParticipantProps {
  identity: string
  /** 표시 이름(아바타 첫 글자) */
  name: string
  /** LiveKit 카메라 트랙(없으면 아바타) */
  videoTrack: any | null
  /** LiveKit 마이크 트랙(원격만 <audio> 에 연결) */
  audioTrack: any | null
  /** 화면 공유 트랙 — 존재 시 타일 위에 오버레이(object-contain) */
  screenTrack: any | null
  isMuted: boolean
  isLocal: boolean
  /** 발화 중 — 음소거가 아니면 primary 테두리 */
  isSpeaking?: boolean
  /** excellent | good | poor | lost | unknown — poor/lost 만 표시 */
  connectionQuality?: string
  /** 그리드 셀 전체를 채움(aspect-video 대신 부모 높이 적용) */
  fill?: boolean
  className?: string
}

function attachTrack(track: any, el: HTMLMediaElement | null) {
  if (track && el) track.attach(el)
}
function detachTrack(track: any, el: HTMLMediaElement | null) {
  if (track && el) track.detach(el)
}

/** 참가자 타일 */
export function MeetingsParticipant({
  name, videoTrack, audioTrack, screenTrack, isMuted, isLocal, isSpeaking, connectionQuality, fill, className,
}: MeetingsParticipantProps) {
  const { t } = useI18n()
  const videoEl = useRef<HTMLVideoElement | null>(null)
  const screenEl = useRef<HTMLVideoElement | null>(null)
  const audioEl = useRef<HTMLAudioElement | null>(null)

  // videoTrack 변경 시 이전 트랙을 분리하고 새 트랙을 연결한다(최초 포함). 언마운트 시 분리한다.
  useEffect(() => {
    const el = videoEl.current
    attachTrack(videoTrack, el)
    return () => detachTrack(videoTrack, el)
  }, [videoTrack])

  useEffect(() => {
    const el = screenEl.current
    attachTrack(screenTrack, el)
    return () => detachTrack(screenTrack, el)
  }, [screenTrack])

  // 원격만 연결한다.
  useEffect(() => {
    const el = audioEl.current
    if (!isLocal) attachTrack(audioTrack, el)
    return () => { detachTrack(audioTrack, el) }
  }, [audioTrack, isLocal])

  return (
    <div
      className={cn(
        'relative rounded-lg overflow-hidden bg-secondary border border-transparent transition-colors',
        screenTrack ? 'aspect-auto h-full' : fill ? 'h-full w-full min-h-0' : 'aspect-video',
        isSpeaking && !isMuted ? 'border-primary ring-2 ring-primary' : '',
        className,
      )}
    >
      {/* 연결 품질 저하 표시(poor/lost 일 때만) */}
      {(connectionQuality === 'poor' || connectionQuality === 'lost') && (
        <div
          className="absolute top-2 right-2 z-10 flex items-center gap-1 rounded-md bg-scrim px-1.5 py-0.5"
          title={connectionQuality === 'lost' ? t('meetings.participant.connLost') : t('meetings.participant.connPoor')}
        >
          <UiIcon
            name={connectionQuality === 'lost' ? 'wifi-off' : 'signal-low'}
            className={cn('h-3.5 w-3.5', connectionQuality === 'lost' ? 'text-danger' : 'text-warning')}
          />
        </div>
      )}
      {/* 카메라 비디오 */}
      <video
        ref={videoEl}
        autoPlay
        playsInline
        muted={isLocal}
        className={cn('absolute inset-0 w-full h-full object-cover', !videoTrack && 'hidden')}
      />

      {/* 비디오 부재 시 아바타 */}
      {!videoTrack && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-16 w-16 rounded-full bg-primary/20 flex items-center justify-center text-2xl font-bold text-primary">
            {name.charAt(0).toUpperCase()}
          </div>
        </div>
      )}

      {/* 이름 + 마이크 상태 (배지 안의 점) */}
      <div className="absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-md bg-scrim px-2 py-1">
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', isMuted ? 'bg-danger' : 'bg-success')} />
        <span className="truncate text-[11px] font-medium text-white">
          {name}{isLocal ? ` ${t('meetings.participant.me')}` : ''}
        </span>
      </div>

      {/* 화면공유 (별도 오버레이) */}
      {screenTrack && (
        <video
          ref={screenEl}
          autoPlay
          playsInline
          muted
          className="absolute inset-0 w-full h-full object-contain bg-stage"
        />
      )}

      {/* 오디오 (리모트만) */}
      <audio ref={audioEl} autoPlay muted={isLocal} className="hidden" />
    </div>
  )
}

export default MeetingsParticipant
