/**
 * LiveKit 트랙 하나를 <video>/<audio> 하나에 붙인다(미니 통화 창). Vue 판 components/meetings/MeetingsTrackMedia.vue 그대로.
 * 회의 화면(MeetingsParticipant)이 내려가면 거기 붙어 있던 요소가 떨어지므로, 미니 창은 이걸로 따로 붙인다.
 * 같은 트랙을 요소 여러 개에 붙여도 된다(LiveKit attach 는 요소마다 따로 관리).
 */
import { useEffect, useRef } from 'react'
import { cn } from '~/lib/utils'

export interface MeetingsTrackMediaProps {
  /** LiveKit Track(attach/detach 를 가진 것). null 이면 빈 요소 */
  track: any | null
  /** 'video' 는 <video>(늘 음소거), 'audio' 는 숨은 <audio> */
  kind: 'video' | 'audio'
  /** 내 영상·화면 공유처럼 소리가 없어야 하는 요소 */
  muted?: boolean
  /** 화면 공유는 잘리지 않게(contain), 카메라는 꽉 차게(cover) */
  contain?: boolean
}

/** LiveKit 트랙 하나를 미디어 요소 하나에 붙인다 */
export function MeetingsTrackMedia({ track, kind, muted, contain }: MeetingsTrackMediaProps) {
  const el = useRef<HTMLMediaElement | null>(null)

  // Vue: watch(track, (n, o) => { detach(o); attach(n) }) + onMounted(attach) + onBeforeUnmount(detach)
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
