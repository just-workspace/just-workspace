/**
 * 플로팅 작성 창 묶음. 화면 오른쪽 아래에 여러 개를 오른쪽부터 나란히 배치한다.
 * 앱 루트(App.tsx)에 1회 배치한다 — 모든 화면에서 표시되며, 화면·레이아웃이 전환되어도 창(작성 중인 내용)이 유지된다.
 * 펼친 창 580×640(오른쪽 24, 아래 0), 최소화 시 제목 줄 44 만 표시한다. "크게 보기" 는 창 하나를 화면 중앙에 확대 표시한다.
 * 창 사이 간격·최소화 줄 폭은 시안에 수치가 없어 Gmail 관례(간격 12, 최소화 폭 280)를 적용했다.
 * 겹침: 작성 창 z 40(z-compose), 미니 통화 창 z 45. 통화 창이 표시 중이면 작성 창 묶음을 (통화 창 폭 + 16)만큼 왼쪽으로 이동한다.
 * 모바일은 통화 띠가 상단에 있어 충돌이 없다(모바일에서는 작성이 /mail/compose 페이지이므로 창이 없다).
 */
import { useMailCompose } from '~/composables/useMailCompose'
import { useIsMobile } from '~/composables/useIsMobile'
import { useShell } from '~/composables/useShell'
import { MailComposeWindow } from '~/components/mail/MailComposeWindow'

const CALL_GAP = 16
const GAP = 12
const MIN_W = 280
const WIN_W = 580

/** 플로팅 메일 작성 창 호스트(props 없음) */
export function MailComposeHost() {
  const { windows } = useMailCompose()
  const isMobile = useIsMobile()
  const { miniCallWidth } = useShell()

  if (isMobile || !windows.length) return null

  /** 오른쪽부터 배치한 각 창의 right 오프셋 */
  const offsets: Record<string, number> = {}
  let right = 24 + (miniCallWidth > 0 ? miniCallWidth + CALL_GAP : 0)
  for (const w of [...windows].reverse()) {
    if (w.maximized) continue
    offsets[w.id] = right
    right += (w.minimized ? MIN_W : WIN_W) + GAP
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-compose overflow-hidden">
      {windows.map(w => (
        <MailComposeWindow
          key={w.id}
          win={w}
          right={offsets[w.id] ?? 24}
          width={w.minimized ? MIN_W : WIN_W}
        />
      ))}
    </div>
  )
}

export default MailComposeHost
