/**
 * 브랜딩 › 로그인 배경 타일 그리드(답변서 B5) 계산 — 화면(pages/admin/branding.tsx)·테스트 공용.
 */

/** 로그인 배경 최대 장수(백엔드 app/admin/router.py WALLPAPER_MAX_COUNT 와 같음) */
export const WALLPAPER_MAX = 4

/** 순서 바꾸기 — from 을 to 자리로. 범위 밖이거나 같으면 원래 배열 그대로 */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list
  const next = [...list]
  const [x] = next.splice(from, 1)
  next.splice(to, 0, x)
  return next
}
