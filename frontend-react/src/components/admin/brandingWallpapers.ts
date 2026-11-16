/**
 * 브랜딩 › 로그인 배경 타일 그리드 계산 — 화면(pages/admin/branding.tsx)·테스트 공용.
 */

/** 로그인 배경 최대 장수(백엔드 app/admin/router.py WALLPAPER_MAX_COUNT 와 동일) */
export const WALLPAPER_MAX = 4

/** 순서 변경 — from 을 to 위치로 이동. 범위 밖이거나 동일하면 원본 배열을 그대로 반환 */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list
  const next = [...list]
  const [x] = next.splice(from, 1)
  next.splice(to, 0, x)
  return next
}
