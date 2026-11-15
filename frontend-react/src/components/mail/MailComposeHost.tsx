/**
 * 떠 있는 작성 창 묶음. 화면 오른쪽 아래, 여러 개를 오른쪽부터 나란히.
 * 앱 루트(App.tsx)에 한 번 둔다 — 어느 화면에서든 뜨고, 화면·레이아웃을 옮겨도 창(쓰던 내용)이 살아 있다.
 * 펼친 창 580×640(오른쪽 24, 아래 0), 최소화하면 제목 줄 44 만 남는다. "크게 보기" 는 창 하나를 화면 가운데 크게.
 * 창 사이 간격·최소화 줄 폭은 시안에 수치가 없어 Gmail 관례(간격 12, 최소화 폭 280)로 두었다.
 * 겹침: 작성 창 z 40(z-compose), 미니 통화 창 z 45. 통화 창이 떠 있으면 작성 창 묶음을 (통화 창 폭 + 16)만큼 왼쪽으로.
 * 모바일은 통화 띠가 상단이라 충돌 없음(모바일에서는 작성이 /mail/compose 페이지라 창이 없다).
 */
import { useMailCompose } from '~/composables/useMailCompose'
import { useIsMobile } from '~/composables/useIsMobile'
import { useShell } from '~/composables/useShell'
import { MailComposeWindow } from '~/components/mail/MailComposeWindow'

const CALL_GAP = 16
const GAP = 12
const MIN_W = 280
const WIN_W = 580

/** 떠 있는 메일 작성 창 호스트(props 없음) */
export function MailComposeHost() {
  const { windows } = useMailCompose()
  const isMobile = useIsMobile()
  const { miniCallWidth } = useShell()

  if (isMobile || !windows.length) return null

  /** 오른쪽부터 쌓은 각 창의 right 오프셋 */
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
