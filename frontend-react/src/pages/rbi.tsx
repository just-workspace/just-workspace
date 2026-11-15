/**
 * 워크스페이스 /rbi — 격리 브라우저 런처(옛 링크·북마크용). 격리 브라우저 자체는 전용 출처(RBI_PUBLIC_ORIGIN, 예 https://rbi.example.com)의
 * 단독 앱이 전체 화면으로 연다 — 워크스페이스 출처에는 세션 화면이 실리지 않는다(docs/rbi.md §7).
 *  · [격리 브라우저 열기] → 새 탭(rel=noopener). 대상마다 딥 링크(?target=<key>) — 단독 앱이 그 대상을 미리 고른다(시작은 사용자가).
 *  · 자동으로 창을 띄우지 않는다(팝업 차단·사용자 동작 없는 새 창 금지). 데스크톱 앱은 새 창을 시스템 브라우저로 넘긴다(apps/desktop).
 *  · 워크스페이스 내비게이션에는 없다(useNav NAV_EXCLUDED) — 사용자 메뉴 "격리 브라우저 열기"·직접 주소가 입구.
 * TODO(handover-rbi): 런처 시각(안내 문구·대상 행)은 Claude Design 시안에서. 기존 키트만.
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useBreadcrumb } from '~/composables/useBreadcrumb'
import { usePlatform } from '~/composables/usePlatform'
import { loadRbiLauncher, rbiLauncherUrl, type RbiLauncherInfo } from '~/composables/useRbi'
import { UiButton } from '~/components/ui/Button'
import { UiCard } from '~/components/ui/Card'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiIcon } from '~/components/ui/Icon'
import { UiSkeleton } from '~/components/ui/Skeleton'

export default function RbiLauncherPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: `${t('rbi.title')} · ${appName}` })
  useBreadcrumb(t('rbi.title'))
  const { isModuleEnabled } = usePlatform()
  const [info, setInfo] = useState<RbiLauncherInfo | null>(null)
  const [failed, setFailed] = useState(false)

  async function load() {
    setFailed(false)
    const i = await loadRbiLauncher(true)
    setInfo(i)
  }
  useEffect(() => { void load().catch(() => setFailed(true)) }, [])

  if (!isModuleEnabled('rbi')) {
    return <div className="p-6"><UiEmptyState variant="panel" icon="shield" title={t('rbi.moduleOff')} /></div>
  }
  if (failed) return <div className="p-6"><UiErrorTile placement="card" title={t('rbi.loadError')} onRetry={() => { void load() }} /></div>
  if (!info) return <div className="p-6"><UiSkeleton preset="text" rows={3} /></div>
  if (!info.url) {
    return <div className="p-6"><UiEmptyState variant="panel" icon="shield" title={t('rbi.launcher.notConfigured')} description={t('rbi.launcher.notConfiguredDesc')} /></div>
  }
  const origin = info.url.replace(/\/$/, '')
  const open = (href: string) => window.open(href, '_blank', 'noopener,noreferrer')
  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-foreground">{t('rbi.title')}</h1>
        <p className="text-[13px] text-muted-foreground">{t('rbi.launcher.desc', { origin })}</p>
      </header>
      <div>
        <UiButton icon="external-link" onClick={() => open(info.url!)} data-testid="rbi-launch">{t('rbi.launcher.open')}</UiButton>
      </div>
      {info.targets.length === 0 ? (
        <UiEmptyState variant="panel" icon="shield" title={t('rbi.noTargets')} description={t('rbi.noTargetsDesc')} />
      ) : (
        <section aria-label={t('rbi.targets')} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {info.targets.map(tg => {
            const href = rbiLauncherUrl(origin, tg.key)!
            return (
              <UiCard key={tg.id} className="flex flex-col gap-3 p-4">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <UiIcon name="shield" className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-[15px] font-semibold text-foreground">{tg.name}</h3>
                    <p className="truncate font-mono text-xs text-muted-foreground">{tg.url}</p>
                  </div>
                </div>
                <div>
                  <UiButton size="sm" variant="outline" icon="external-link" onClick={() => open(href)}>{t('rbi.launcher.openTarget', { name: tg.name })}</UiButton>
                </div>
              </UiCard>
            )
          })}
        </section>
      )}
    </div>
  )
}
