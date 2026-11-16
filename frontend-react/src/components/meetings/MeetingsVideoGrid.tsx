/**
 * 참가자 비디오 영역. 호스트 룸 페이지와 게스트 참여 페이지가 동일한 마크업을
 * 각각 보유하던 것을 하나로 통합하였다. 화면공유 중이면 공유 화면을 크게, 나머지는
 * 아래 썸네일 스트립으로 표시한다.
 */
import { useState } from 'react'
import type { ParticipantTrack } from '~/composables/useMeetings'
import { useGridLayout } from '~/composables/useGridLayout'
import { MeetingsParticipant } from '~/components/meetings/MeetingsParticipant'

export interface MeetingsVideoGridProps {
  /** useMeetings().participants */
  participants: ParticipantTrack[]
}

/** 참가자 그리드(화면 공유면 스포트라이트 + 썸네일 줄) */
export function MeetingsVideoGrid({ participants }: MeetingsVideoGridProps) {
  const screenSharer = participants.find(p => p.screenTrack)
  const otherParticipants = participants.filter(p => p !== screenSharer)

  const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null)
  const { style: gridStyle } = useGridLayout(gridEl, participants.length, 8)

  return (
    <div className="flex-1 min-w-0 min-h-0 overflow-hidden p-2 sm:p-4 bg-stage">
      {screenSharer
        ? (
          /* 화면공유 spotlight */
          <div className="grid gap-2 h-full min-h-0" style={{ gridTemplateRows: 'minmax(0, 1fr) auto' }}>
            <MeetingsParticipant {...screenSharer} className="w-full min-h-0" />
            {otherParticipants.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {otherParticipants.map(p => (
                  <div key={p.identity} className="w-40 shrink-0">
                    <MeetingsParticipant {...p} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )
        : (
          /* 일반 그리드: 열·행을 컨테이너 크기에 맞춰 계산 */
          <div ref={setGridEl} className="grid gap-2 h-full w-full min-h-0" style={gridStyle}>
            {participants.map(p => <MeetingsParticipant key={p.identity} {...p} fill />)}
          </div>
        )}
    </div>
  )
}

export default MeetingsVideoGrid
