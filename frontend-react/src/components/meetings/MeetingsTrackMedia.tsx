/**
 * LiveKit 트랙 하나를 <video>/<audio> 하나에 연결한다(미니 통화 창).
 * 회의 화면(MeetingsParticipant)이 언마운트되면 해당 화면에 연결된 요소가 분리되므로, 미니 창은 본 컴포넌트로 별도 연결한다.
 * 동일 트랙을 여러 요소에 연결할 수 있다(LiveKit attach 는 요소별로 개별 관리).
 */
import { useEffect, useRef } from 'react'
import { cn } from '~/lib/utils'

export interface MeetingsTrackMediaProps {
  /** LiveKit Track(attach/detach 보유 객체). null 이면 빈 요소 */
  track: any | null
  /** 'video' 는 <video>(항상 음소거), 'audio' 는 숨김 <audio> */
  kind: 'video' | 'audio'
  /** 본인 영상·화면 공유처럼 무음이어야 하는 요소 */
  muted?: boolean
  /** 화면 공유는 잘림 없이(contain), 카메라는 영역을 채움(cover) */
  contain?: boolean
}

/** LiveKit 트랙 하나를 미디어 요소 하나에 연결 */
export function MeetingsTrackMedia({ track, kind, muted, contain }: MeetingsTrackMediaProps) {
  const el = useRef<HTMLMediaElement | null>(null)

  // track 변경 시 이전 트랙을 분리하고 새 트랙을 연결한다. 마운트 시 연결하고 언마운트 시 분리한다.
  useEffect(() => {
    const node = el.current
    if (track && node) { try { track.attach(node) } catch { /* noop */ } }
    return () => {
      if (track && node) { try { track.detach(node) } catch { /* noop */ } }
    }
  }, [track, kind])

  if (kind === 'video') {
    return (
      <video
        ref={el as React.RefObject<HTMLVideoElement>}
        autoPlay
        playsInline
        muted
        className={cn('absolute inset-0 h-full w-full', contain ? 'object-contain' : 'object-cover')}
      />
    )
  }
  return <audio ref={el as React.RefObject<HTMLAudioElement>} autoPlay muted={muted} className="hidden" />
}

export default MeetingsTrackMedia
