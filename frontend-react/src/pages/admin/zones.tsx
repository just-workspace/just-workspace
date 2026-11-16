/**
 * 관리 › 구역 — 설치 후 구역(메일·채팅·회의…)과 선택 애드온을 활성화·비활성화한다.
 *
 *  · 맨 위: 권장 메모리 합계(활성화된 구역과 애드온 기준) / 서버 메모리.
 *  · 구역 카드 · 선택 애드온 카드: 행마다 상태와 스위치. 활성화는 대화상자(설정 → 메모리·포트 확인)를 거치고,
 *    대화상자가 닫히면 받기·설정·연결 진행이 해당 행 안에서 계속된다. 비활성화는 확인 대화상자를 거친다.
 *  · 진행 상태는 작업을 1.5초마다 재조회한다. 화면 이탈 시 중지하고, 복귀 시 목록이 반환한 진행 중 작업을 이어서 추적한다.
 *  · 구역이 변경되면 서버가 재기동된다 — 그동안 조회가 실패하면 "다시 연결 중"으로 표시하고, 복구되면 모듈 목록과
 *    설치된 구역을 다시 수신하여 메뉴에 반영한다.
 *  · 활성화돼 있으나 로그인 연동이 보류된 구역은 "연동 보류"로 표시되고, [다시 연결]로 해당 연결만 재시도한다.
 *  · 설치 관리자 없이 구성한 설치에서는 현재 활성화된 구역만 읽기 전용으로 표시한다.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { navigateTo } from '~/lib/router'
import { useAuth } from '~/composables/useAuth'
import { useSiteConfig, refetchAppConfig } from '~/composables/useSiteConfig'
import { fetchModules } from '~/composables/usePlatform'
import { addToast } from '~/composables/useToast'
import {
  zonesApi, errorCode, localized, recommendGb, gb, isActive,
  type ZoneJob, type ZoneListing, type ZoneRow, type ZoneSettings,
} from '~/composables/useSystemZones'
import { AdminPageShell } from '~/components/admin/AdminPageShell'
import { ZoneRowView } from '~/components/admin/zones/ZoneRowView'
import { ZoneDialog } from '~/components/admin/zones/ZoneDialog'
import { UiCard } from '~/components/ui/Card'
import { UiCallout } from '~/components/ui/Callout'
import { UiButton } from '~/components/ui/Button'
import { UiModal } from '~/components/ui/Modal'
import { UiProgress } from '~/components/ui/Progress'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSkeleton } from '~/components/ui/Skeleton'

/** 진행 상태 재조회 간격 */
export const zonesTiming = { pollMs: 1500 }

export default function AdminZonesPage() {
  const { t, locale } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: t('admin.common.headTitle', { page: t('admin.zones.title'), app: appName }) })
  const { user } = useAuth()
  useEffect(() => { if (user && !user.is_admin) void navigateTo('/') }, [user])

  const [data, setData] = useState<ZoneListing | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [dialog, setDialog] = useState<{ zone: ZoneRow; mode: 'enable' | 'settings' } | null>(null)
  const [offAsk, setOffAsk] = useState<ZoneRow | null>(null)
  const [offBusy, setOffBusy] = useState(false)
  const lastSettings = useRef<Record<string, ZoneSettings | null>>({})
  const alive = useRef(true)

  const load = useCallback(async () => {
    try {
      const r = await zonesApi.list()
      if (!alive.current) return true
      setData(r); setLoadError(false); setReconnecting(false)
      return true
    } catch {
      if (alive.current) setLoadError(true)
      return false
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    return () => { alive.current = false }
  }, [load])

  const rows = data ? [...data.zones, ...data.addons] : []
  const activeIds = rows.filter(r => isActive(r.job)).map(r => `${r.id}:${r.job!.id}`).join(',')

  const setJob = useCallback((zoneId: string, job: ZoneJob | null) => {
    setData(d => d && {
      ...d,
      zones: d.zones.map(z => (z.id === zoneId ? { ...z, job } : z)),
      addons: d.addons.map(z => (z.id === zoneId ? { ...z, job } : z)),
    })
  }, [])

  // 진행 중인 작업을 재조회한다 — 화면 이탈(언마운트) 시 중지한다
  useEffect(() => {
    if (!activeIds) return
    const pairs = activeIds.split(',').map(x => x.split(':') as [string, string])
    let stopped = false
    let running = false
    const tick = async () => {
      if (running || stopped) return
      running = true
      let finished = false
      for (const [zoneId, jobId] of pairs) {
        try {
          const job = await zonesApi.job(jobId)
          if (stopped) return
          setReconnecting(false)
          setJob(zoneId, job)
          if (!isActive(job)) finished = true
        } catch {
          if (!stopped) setReconnecting(true)      // 서버 재기동 중일 수 있음 — 조회 계속
        }
      }
      running = false
      if (finished && !stopped) {
        // 활성화된 구역 변경 시 목록, 모듈, 설치된 구역을 다시 수신하여 메뉴에 반영한다
        await load()
        void fetchModules()
        void refetchAppConfig()
      }
    }
    const id = setInterval(() => { void tick() }, zonesTiming.pollMs)
    return () => { stopped = true; clearInterval(id) }
  }, [activeIds, load, setJob])

  async function startDisable(zone: ZoneRow) {
    setOffBusy(true)
    try {
      setJob(zone.id, await zonesApi.disable(zone.id))
      setOffAsk(null)
    } catch (e: any) {
      addToast('error', errorCode(e) === 'busy' ? t('admin.zones.dialog.busy') : e?.data?.detail || t('admin.zones.dialog.failed'))
    } finally { setOffBusy(false) }
  }

  async function reconnect(zone: ZoneRow) {
    try {
      setJob(zone.id, await zonesApi.reconnect(zone.id))
    } catch (e: any) {
      const code = errorCode(e)
      if (code === 'not_pending') { await load(); return }      // 그사이 연결 완료 — 목록만 갱신
      addToast('error', code === 'busy' ? t('admin.zones.dialog.busy') : e?.data?.detail || t('admin.zones.dialog.failed'))
    }
  }

  async function retry(zone: ZoneRow) {
    const kind = zone.job?.kind
    if (kind === 'reconnect') { await reconnect(zone); return }
    if (kind === 'disable') { setOffAsk(zone); return }
    if (kind === 'update') { setDialog({ zone, mode: 'settings' }); return }
    // 직전에 입력한 설정이 남아 있으면 그대로 재시도, 없으면(화면을 다시 연 경우) 대화상자부터 표시
    if (zone.has_settings && !(zone.id in lastSettings.current)) { setDialog({ zone, mode: 'enable' }); return }
    try {
      setJob(zone.id, await zonesApi.enable(zone.id, lastSettings.current[zone.id] ?? null))
    } catch (e: any) {
      if (errorCode(e) === 'busy') addToast('error', t('admin.zones.dialog.busy'))
      else setDialog({ zone, mode: 'enable' })
    }
  }

  async function dismiss(zone: ZoneRow) {
    setJob(zone.id, null)
    try { await zonesApi.dismissJob(zone.id) } catch { /* 다음 목록 조회 시 다시 표시됨 */ }
  }

  if (!user?.is_admin) return null

  const title = t('admin.zones.title')
  if (!data) {
    return (
      <AdminPageShell title={title} width="wide">
        {loadError
          ? <UiErrorTile placement="card" title={t('admin.zones.loadError')} onRetry={() => { void load() }} />
          : <UiCard><UiSkeleton preset="list" rows={6} /></UiCard>}
      </AdminPageShell>
    )
  }

  const readOnly = !data.installer.available
  const locked = rows.some(r => isActive(r.job))
  const need = data.memory.need_mb ?? 0
  const serverMb = data.memory.nominal_mb ?? data.memory.have_mb
  const group = (list: ZoneRow[]) => list.map(z => (
    <ZoneRowView
      key={z.id}
      zone={z}
      readOnly={readOnly}
      locked={locked && !isActive(z.job)}
      reconnecting={reconnecting}
      onToggle={on => { if (on) setDialog({ zone: z, mode: 'enable' }); else setOffAsk(z) }}
      onSettings={() => setDialog({ zone: z, mode: 'settings' })}
      onRetry={() => { void retry(z) }}
      onDismiss={() => { void dismiss(z) }}
      onReconnect={() => { void reconnect(z) }}
    />
  ))

  return (
    <AdminPageShell title={title} width="wide">
      {readOnly && (
        <UiCallout
          tone={data.installer.reason === 'not_configured' ? 'neutral' : 'warning'}
          role="status"
          data-testid="zones-readonly"
          title={data.installer.reason === 'not_configured' ? t('admin.zones.noInstaller.title') : t('admin.zones.unreachable.title')}
          actions={data.installer.reason === 'not_configured' ? undefined : <UiButton variant="outline" size="sm" icon="refresh" onClick={() => { void load() }}>{t('admin.zones.unreachable.retry')}</UiButton>}
        >
          {data.installer.reason === 'not_configured' ? t('admin.zones.noInstaller.body') : t('admin.zones.unreachable.body')}
        </UiCallout>
      )}
      {reconnecting && (
        <UiCallout tone="info" icon="loader" spin role="status" data-testid="zones-reconnecting">{t('admin.zones.reconnecting')}</UiCallout>
      )}

      <UiCard>
        <div className="flex flex-col gap-2 p-4">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="min-w-0 flex-1 basis-[200px] text-[13px] text-muted-foreground">{t('admin.zones.memory.label')}</span>
            <span className="font-mono text-lg font-medium" data-testid="zones-memory">
              {recommendGb(need)} GB{serverMb ? <span className="text-[13px] font-normal text-muted-foreground"> / {gb(serverMb)} GB</span> : null}
            </span>
          </div>
          {serverMb ? <UiProgress as="meter" label={t('admin.zones.memory.aria')} value={need} max={serverMb} tone={need > serverMb ? 'danger' : 'primary'} /> : null}
        </div>
      </UiCard>

      <UiCard className="overflow-hidden">
        <h2 className="px-4 py-2.5 text-base font-semibold">{t('admin.zones.zonesTitle')}</h2>
        {group(data.zones)}
      </UiCard>

      {data.addons.length > 0 && (
        <UiCard className="overflow-hidden">
          <h2 className="px-4 py-2.5 text-base font-semibold">{t('admin.zones.addonsTitle')}</h2>
          {group(data.addons)}
        </UiCard>
      )}

      <p className="text-xs leading-[18px] text-muted-foreground">{t('admin.zones.footnote')}</p>

      {dialog && (
        <ZoneDialog
          zone={dialog.zone}
          mode={dialog.mode}
          memory={data.memory}
          verifiedVersion={dialog.zone.id === 'git' ? data.git_verified_version : null}
          onClose={() => setDialog(null)}
          onStarted={(job, settings) => {
            lastSettings.current[dialog.zone.id] = settings
            setJob(dialog.zone.id, job)
            setDialog(null)
          }}
        />
      )}

      {offAsk && (
        <UiModal
          confirm
          danger
          size="440"
          title={t('admin.zones.off.title', { name: localized(offAsk.name, locale) })}
          onClose={() => { if (!offBusy) setOffAsk(null) }}
          footer={
            <>
              <UiButton variant="outline" size="sm" disabled={offBusy} onClick={() => setOffAsk(null)}>{t('common.cancel')}</UiButton>
              <UiButton variant="danger" size="sm" disabled={offBusy} onClick={() => { void startDisable(offAsk) }}>{t('admin.zones.off.confirm')}</UiButton>
            </>
          }
        >
          <p className="text-[13.5px] text-muted-foreground" data-testid="zones-off-body">
            {offAsk.menu && <>{t('admin.zones.off.menu')}{' '}</>}
            {offAsk.recommend_mb > 0 && <>{t('admin.zones.off.memoryBefore')}<span className="font-mono">{recommendGb(offAsk.recommend_mb)} GB</span>{t('admin.zones.off.memoryAfter')}{' '}</>}
            {t('admin.zones.off.data')}
          </p>
        </UiModal>
      )}
    </AdminPageShell>
  )
}
