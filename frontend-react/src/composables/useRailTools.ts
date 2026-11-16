/**
 * 레일 '도구' 묶음 — 외부 출처를 새 탭에서 여는 항목들.
 * 순서: 격리 브라우저(사용 가능한 대상 + rbi 출처가 있을 때) → 네트워크 랩(NETLAB_URL 이 https 일 때).
 * 둘 다 키트 UiAppRail 의 external 항목(target=_blank · 오른쪽 external-link · 툴팁 "새 탭에서 열기 · 이름").
 * 항목이 없으면 묶음을 생성하지 않는다. 모바일 탭·명령 팔레트(useNav)에는 포함하지 않는다 — 라우터 경로가 아니기 때문.
 */
import { useMemo } from 'react'
import { useI18n } from '~/i18n'
import { useRbiLauncher } from '~/composables/useRbiLauncher'
import { useNetLabUrl } from '~/composables/useNetLab'
import type { UiAppRailGroup, UiAppRailItem } from '~/components/ui/AppRail'

export function railToolItems(opts: { rbiUrl: string | null; netlabUrl: string | null; rbiLabel: string; netlabLabel: string }): UiAppRailItem[] {
  const out: UiAppRailItem[] = []
  if (opts.rbiUrl) out.push({ id: 'rbi', label: opts.rbiLabel, icon: 'shield', to: opts.rbiUrl, external: true })
  if (opts.netlabUrl) out.push({ id: 'netlab', label: opts.netlabLabel, icon: 'server', to: opts.netlabUrl, external: true })
  return out
}

export function useRailTools(): UiAppRailGroup | null {
  const { t } = useI18n()
  const rbiUrl = useRbiLauncher()
  const netlabUrl = useNetLabUrl()
  return useMemo(() => {
    const items = railToolItems({ rbiUrl, netlabUrl, rbiLabel: t('nav.rbi'), netlabLabel: t('nav.netlab') })
    return items.length ? { key: 'tools', label: t('shell.navGroup.tools'), items } : null
  }, [rbiUrl, netlabUrl, t])
}
