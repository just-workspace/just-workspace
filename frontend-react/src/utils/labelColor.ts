// Gitea 라벨 hex 를 '점' 색으로 정규화한다.
// 밝기가 지나치게 낮으면(어두운 배경에서 식별 불가) 명도만 높인다 — 색상(hue)은 유지.
// oklch relative color 는 최신 크로미움/사파리에서 지원한다.
export function labelDot(hex: string): string {
  const h = (hex || '888888').replace('#', '')
  return `oklch(from #${h} max(l, 0.62) c h)`
}
