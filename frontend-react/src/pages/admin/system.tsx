/**
 * 관리 › 시스템 › 서비스 상태 — Vue pages/admin/system.vue(관리 1: /admin/system 을 "서비스 상태"로 흡수).
 * 행 규격은 시안 개요의 서비스 상태 카드(행 40 · 상태 점 + 이름 + 상태 글자 + ms mono).
 * 컨테이너 재시작은 같은 카드 문법의 두 번째 카드(확인 모달 → POST /api/setup/services/{svc}/restart).
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { navigateTo } from '~/lib/router'
import { $fetch } from '~/lib/api'
import { useAuth } from '~/composables/useAuth'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useServices, fetchServices } from '~/composables/useServices'
import { refreshAdminOps } from '~/composables/useAdminOps'
import { confirmBox } from '~/composables/useDialog'
import { addToast } from '~/composables/useToast'
import { AdminPageShell } from '~/components/admin/AdminPageShell'
import { UiButton } from '~/components/ui/Button'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiStatusDot } from '~/components/ui/StatusDot'

interface Container { service: string; present: boolean; running: boolean; status: string }

/** 느림 기준 ms — appcfg system.latency_warn_ms(양수) 아니면 800 */
function latencyWarnMsFrom(config: Record<string, string> | undefined): number {
  const v = Number((config?.['system.latency_warn_ms'] ?? '').trim())
  return Number.isFinite(v) && v > 0 ? v : 800
}

export default function AdminSystemPage() {
  const { t } = useI18n()
  const { appName, config } = useSiteConfig()
  useHead({ title: t('admin.common.headTitle', { page: t('admin.common.serviceStatus'), app: appName }) })
  const { user } = useAuth()
  useEffect(() => { if (user && !user.is_admin) void navigateTo('/') }, [user])

  const { services, loading: svcLoading } = useServices()

  const latencyWarnMs = latencyWarnMsFrom(config)
  function svcState(s: { status: string; response_ms: number | null }) {
    if (s.status === 'down') return { dot: 'down', label: t('admin.svc.down') }
    if (s.status !== 'ok') return { dot: 'connecting', label: t('admin.svc.checking') }
    if (s.response_ms != null && s.response_ms > latencyWarnMs) return { dot: 'slow', label: t('admin.svc.slow') }
    return { dot: 'ok', label: t('admin.svc.ok') }
  }

  const [containers, setContainers] = useState<Container[]>([])
  const [cLoading, setCLoading] = useState(true)
  const [cError, setCError] = useState(false)
  const [restarting, setRestarting] = useState<string | null>(null)

  async function loadContainers() {
    setCLoading(true); setCError(false)
    try {
      const s = await $fetch<{ services: Container[] }>('/api/setup/services')
      setContainers(s.services || [])
    } catch { setCError(true) } finally { setCLoading(false) }
  }

  async function restart(svc: string) {
    if (!await confirmBox(t('admin.system.restartBody'), { title: t('admin.system.restartTitle', { name: svc }), confirmLabel: t('admin.system.restart') })) return
    setRestarting(svc)
    try {
      await $fetch(`/api/setup/services/${svc}/restart`, { method: 'POST' })
      addToast('success', t('admin.system.restarted', { name: svc }))
      setTimeout(() => { void loadContainers(); void fetchServices(); void refreshAdminOps() }, 2000)
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('admin.system.restartFailed'))
    } finally { setRestarting(null) }
  }

  function containerDot(c: Container) { return c.running ? 'ok' : c.present ? 'down' : 'off' }
  function containerLabel(c: Container) { return c.running ? t('admin.system.running') : c.present ? t('admin.system.stopped') : t('admin.system.missing') }

  function reloadAll() { void fetchServices(); void loadContainers(); void refreshAdminOps() }
  useEffect(reloadAll, [])

  if (!user?.is_admin) return null
  return (
    <AdminPageShell
      title={t('admin.common.serviceStatus')}
      subtitle={t('admin.system.subtitle')}
      width="wide"
      actions={<UiButton variant="outline" size="sm" icon="refresh" onClick={reloadAll}>{t('admin.system.reload')}</UiButton>}
    >
      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center border-b border-border px-[18px] py-3.5">
          <h3 className="flex-1 text-[13px] font-semibold text-foreground">{t('admin.system.services')}</h3>
          <span className="text-xs text-muted-foreground">{t('admin.system.slowThreshold')} <span className="font-mono">{latencyWarnMs} ms</span></span>
        </div>
        {svcLoading && !services.length ? (
          <UiSkeleton preset="list" rows={6} />
        ) : !services.length ? (
          <UiEmptyState variant="panel" icon="server" title={t('admin.common.noServices')} />
        ) : services.map(s => {
          const st = svcState(s)
          return (
            <div key={s.name} className="flex h-10 items-center gap-2.5 border-b border-border px-[18px] text-[13px] last:border-b-0">
              <UiStatusDot status={st.dot} label={st.label} />
              <span className="min-w-0 flex-1 truncate text-foreground">{s.name}</span>
              <span className="text-xs text-muted-foreground">{st.label}</span>
              <span className="w-16 text-right font-mono text-[11px] text-muted-foreground">{s.response_ms != null ? `${s.response_ms} ms` : '—'}</span>
            </div>
          )
        })}
      </section>

      <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-[18px] py-3.5">
          <h3 className="text-[13px] font-semibold text-foreground">{t('admin.system.containers')}</h3>
          <p className="mt-1 text-[13px] text-muted-foreground">{t('admin.system.containersHint')}</p>
        </div>
        {cLoading ? (
          <UiSkeleton preset="list" rows={5} />
        ) : cError ? (
          <UiErrorTile placement="panel" title={t('admin.system.containersLoadError')} onRetry={loadContainers} />
        ) : !containers.length ? (
          <UiEmptyState variant="panel" icon="server" title={t('admin.system.noContainers')} />
        ) : containers.map(c => (
          <div key={c.service} className="flex min-h-12 items-center gap-2.5 border-b border-border px-[18px] text-[13px] last:border-b-0">
            <UiStatusDot status={containerDot(c)} label={containerLabel(c)} />
            <span className="w-32 shrink-0 truncate font-medium text-foreground">{c.service}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.status || containerLabel(c)}</span>
            {c.present && (
              <UiButton variant="outline" size="xs" disabled={restarting === c.service} onClick={() => restart(c.service)}>
                {restarting === c.service ? t('admin.system.restarting') : t('admin.system.restart')}
              </UiButton>
            )}
          </div>
        ))}
      </section>
    </AdminPageShell>
  )
}
