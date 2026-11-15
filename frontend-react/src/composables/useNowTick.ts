/**
 * 1초(기본)마다 다시 그리게 하는 시계 — 카운트다운용. active=false 면 멈춘다.
 * 남은 시간은 돌려준 값이 아니라 그릴 때의 Date.now() 로 세는 게 정확하다(값은 최대 한 칸 늦다).
 * 돌려주는 값은 클라이언트 Date.now() 이다. 서버 기준 시각은 utils/approvals 의 offset 과 함께 쓴다.
 */
import { useEffect, useState } from 'react'

export function useNowTick(active = true, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [active, intervalMs])
  return now
}
