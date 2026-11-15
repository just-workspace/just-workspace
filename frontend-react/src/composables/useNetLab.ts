/**
 * 네트워크 랩(NetLab — 별도 출처 lab.<도메인>) 런처 — handover-netlab 답 §5.10 (a) 화면 14·15.
 * 주소는 백엔드 NETLAB_URL → /api/health netlab_url(https 만) → useSiteConfig().netlabUrl.
 * 비어 있으면 레일 '도구' 항목·대시보드 카드 둘 다 숨긴다. 열기는 늘 새 탭(워크스페이스 화면은 그대로).
 */
import { useSiteConfig } from '~/composables/useSiteConfig'

/** 쓸 수 있는 NetLab 주소(https 만, 끝 / 제거) — 없으면 null */
export function netlabLaunchUrl(raw: string | null | undefined): string | null {
  const url = (raw ?? '').trim().replace(/\/+$/, '')
  return /^https:\/\/[^/\s]+/i.test(url) ? url : null
}

/** 카드 부제(mono) — 주소의 호스트(lab.example.com) */
export function netlabHost(url: string): string {
  try { return new URL(url).host } catch { return url.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') }
}

export function useNetLabUrl(): string | null {
  const { netlabUrl } = useSiteConfig()
  return netlabLaunchUrl(netlabUrl)
}
