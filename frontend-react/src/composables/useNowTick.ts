/**
 * 1초(기본)마다 재렌더링을 유발하는 시계 — 카운트다운용. active=false 이면 정지한다.
 * 남은 시간은 반환값이 아니라 렌더 시점의 Date.now() 로 계산해야 정확하다(반환값은 최대 한 주기 지연).
 * 반환값은 클라이언트 Date.now() 이다. 서버 기준 시각은 utils/approvals 의 offset 과 함께 사용한다.
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
