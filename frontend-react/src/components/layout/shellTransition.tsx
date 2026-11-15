/**
 * 셸 내부용 — Vue `<Transition enter-*-class leave-*-class>` 를 같은 Tailwind 클래스로 흉내 낸다(새 애니메이션 라이브러리 없이).
 * Vue 와 같은 순서: 들어올 때 [enterActive + enterFrom] → 다음 프레임 [enterActive + enterTo] → 끝나면 클래스 없음.
 *                  나갈 때 [leaveActive + leaveFrom] → 다음 프레임 [leaveActive + leaveTo] → duration 뒤 언마운트.
 * children 은 지금 붙일 전환 클래스를 받아 요소 하나를 그리는 함수.
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
  /** 들어올 때(ms) */
  enterMs: number
  /** 나갈 때(ms) — 이만큼 기다렸다가 언마운트 */
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
    // 길이·클래스는 고정값 — show 만 본다
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
