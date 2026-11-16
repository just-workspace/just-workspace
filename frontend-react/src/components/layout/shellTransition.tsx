/**
 * 셸 내부용 — 진입·이탈 시 클래스를 교체하는 전환을 Tailwind 클래스로 구현한다(애니메이션 라이브러리 추가 없음).
 * 순서: 진입 시 [enterActive + enterFrom] → 다음 프레임 [enterActive + enterTo] → 종료 후 클래스 없음.
 *       이탈 시 [leaveActive + leaveFrom] → 다음 프레임 [leaveActive + leaveTo] → duration 경과 후 언마운트.
 * children 은 현재 적용할 전환 클래스를 전달받아 요소 하나를 렌더링하는 함수이다.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface ShellTransitionProps {
  show: boolean
  enterActive?: string
  enterFrom?: string
  enterTo?: string
  leaveActive?: string
  leaveFrom?: string
  leaveTo?: string
  /** 진입 시간(ms) */
  enterMs: number
  /** 이탈 시간(ms) — 해당 시간만큼 대기 후 언마운트 */
  leaveMs: number
  children: (transitionClass: string) => ReactNode
}

type Phase = 'hidden' | 'enter-from' | 'enter-to' | 'shown' | 'leave-from' | 'leave-to'

export function ShellTransition(p: ShellTransitionProps) {
  const [phase, setPhase] = useState<Phase>(p.show ? 'shown' : 'hidden')
  const timers = useRef<{ raf: number; t: ReturnType<typeof setTimeout> | null }>({ raf: 0, t: null })
  const first = useRef(true)

  useEffect(() => {
    if (first.current) { first.current = false; return }
    const tm = timers.current
    cancelAnimationFrame(tm.raf)
    if (tm.t) clearTimeout(tm.t)
    if (p.show) {
      setPhase('enter-from')
      tm.raf = requestAnimationFrame(() => {
        tm.raf = requestAnimationFrame(() => setPhase('enter-to'))
      })
      tm.t = setTimeout(() => setPhase('shown'), p.enterMs + 34)
    } else {
      setPhase(ph => (ph === 'hidden' ? 'hidden' : 'leave-from'))
      tm.raf = requestAnimationFrame(() => {
        tm.raf = requestAnimationFrame(() => setPhase(ph => (ph === 'hidden' ? 'hidden' : 'leave-to')))
      })
      tm.t = setTimeout(() => setPhase('hidden'), p.leaveMs + 34)
    }
    // 길이·클래스는 고정값이므로 show 만 의존성으로 지정
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.show])

  useEffect(() => () => {
    cancelAnimationFrame(timers.current.raf)
    if (timers.current.t) clearTimeout(timers.current.t)
  }, [])

  if (phase === 'hidden') return null
  const j = (...c: (string | undefined)[]) => c.filter(Boolean).join(' ')
  const cls = {
    'enter-from': j(p.enterActive, p.enterFrom),
    'enter-to': j(p.enterActive, p.enterTo),
    shown: '',
    'leave-from': j(p.leaveActive, p.leaveFrom),
    'leave-to': j(p.leaveActive, p.leaveTo),
  }[phase]
  return <>{p.children(cls)}</>
}
