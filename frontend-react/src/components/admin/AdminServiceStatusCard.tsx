import { useI18n } from '~/i18n'
import { NuxtLink } from '~/components/NuxtLink'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiStatusDot } from '~/components/ui/StatusDot'
import type { ServiceStatus } from '~/composables/useServices'
import { svcState } from './dashboardTiles'

export interface AdminServiceStatusCardProps {
  /** 서비스 상태 목록(useServices) */
  services: ServiceStatus[]
  /** 불러오는 중(목록이 비었을 때만 스켈레톤) */
  loading: boolean
  /** 이 ms 를 넘으면 "느림"(관리 설정 system.latency_warn_ms, 기본 800) */
  latencyWarnMs: number
}

/**
 * 서비스 상태 카드 — 머리(제목 + [관리] 링크) · 서비스마다 40 행(상태 점 · 이름 · 상태 글자 · 응답 ms).
 * Vue 판 dashboard.vue 의 오른쪽 section.
 */
export function AdminServiceStatusCard({ services, loading, latencyWarnMs }: AdminServiceStatusCardProps) {
  const { t } = useI18n()
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center border-b border-border px-[18px] py-3.5">
        <h3 className="flex-1 text-[13px] font-semibold text-foreground">{t('admin.common.serviceStatus')}</h3>
        <NuxtLink to="/admin/system" className="text-xs font-semibold text-primary hover:underline">{t('admin.dashboard.manage')}</NuxtLink>
      </div>
      {loading && !services.length
        ? <UiSkeleton preset="list" rows={6} />
        : !services.length
          ? <UiEmptyState variant="panel" icon="server" title={t('admin.common.noServices')} />
          : services.map((s) => {
            const st = svcState(s, latencyWarnMs, t)
            return (
              <div key={s.name} className="flex h-10 items-center gap-2.5 border-b border-border px-[18px] text-[13px] last:border-b-0">
                <UiStatusDot status={st.dot} label={st.label} />
                <span className="min-w-0 flex-1 truncate text-foreground">{s.name}</span>
                <span className="text-xs text-muted-foreground">{st.label}</span>
                <span className="w-14 text-right font-mono text-[11px] text-muted-foreground">{s.response_ms != null ? `${s.response_ms} ms` : '—'}</span>
              </div>
            )
          })}
    </section>
  )
}


export default AdminServiceStatusCard
