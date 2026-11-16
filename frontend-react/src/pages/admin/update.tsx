/**
 * 관리 › 업데이트 — 현황 · 설정 · 되돌림 · 앱 배포 · 기록 · 오프라인 업데이트.
 *
 * 탭은 경로에 대응한다: /admin/update(현황) · /settings · /rollback · /apps · /history · /offline.
 * 현황 탭 안의 화면: /notes(새 버전 안내) · /apply/<작업>(적용 진행) · /changes/<버전>(적용된 버전의 변경 내용).
 * 롤백·복원의 진행은 /rollback/<작업>.
 *
 * 업데이트의 실제 수행 주체는 설치 관리자다(docs/update-api.md). 설치 관리자 없이 구성했거나 해당 설치 관리자가
 * 업데이트를 지원하지 않으면, 탭 대신 해당 사유의 안내만 표시한다.
 */
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { useRoute, navigateTo } from '~/lib/router'
import { useAuth } from '~/composables/useAuth'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { updateApi, isLive, unavailableReason, viewFromPath, UPDATE_BASE, type UpdateStatus } from '~/composables/useSystemUpdate'
import { AdminPageShell } from '~/components/admin/AdminPageShell'
import { Unavailable, usePoll } from '~/components/admin/update/parts'
import { HomeTab } from '~/components/admin/update/HomeTab'
import { NotesView } from '~/components/admin/update/NotesView'
import { ChangesView } from '~/components/admin/update/ChangesView'
import { JobView, JobRedirect } from '~/components/admin/update/JobView'
import { SettingsTab } from '~/components/admin/update/SettingsTab'
import { RollbackTab } from '~/components/admin/update/RollbackTab'
import { OfflineTab } from '~/components/admin/update/OfflineTab'
import { AppsTab } from '~/components/admin/update/AppsTab'
import { HistoryTab } from '~/components/admin/update/HistoryTab'
import { UiTabs } from '~/components/ui/Tabs'
import { UiCard } from '~/components/ui/Card'
import { UiButton } from '~/components/ui/Button'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSkeleton } from '~/components/ui/Skeleton'

export { updateTiming } from '~/components/admin/update/parts'

export default function AdminUpdatePage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: t('admin.common.headTitle', { page: t('admin.update.title'), app: appName }) })
  const { user } = useAuth()
  useEffect(() => { if (user && !user.is_admin) void navigateTo('/') }, [user])
  const route = useRoute()
  const navigate = useNavigate()
  const { view, arg } = viewFromPath(route.path)

  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [error, setError] = useState<unknown>(null)
  const load = useCallback(async () => {
    try {
      setStatus(await updateApi.status())
      setError(null)
    } catch (e) { setError(e) }
  }, [])
  useEffect(() => { if (user?.is_admin) void load() }, [load, user?.is_admin])
  // "지금 확인"이 종료될 때까지 재조회한다
  usePoll(status?.check.state === 'checking', load)

  if (!user?.is_admin) return null

  const title = t('admin.update.title')
  const reason = error ? unavailableReason(error) : null
  if (reason) {
    return <AdminPageShell title={title} width="wide"><Unavailable reason={reason} /></AdminPageShell>
  }

  const inner = view === 'notes' || view === 'apply' || view === 'changes'
  const tabs = [
    { key: 'home', label: t('admin.update.tabs.home'), to: UPDATE_BASE, exact: true, activeOn: [`${UPDATE_BASE}/notes`, `${UPDATE_BASE}/apply`, `${UPDATE_BASE}/changes`] },
    { key: 'settings', label: t('admin.update.tabs.settings'), to: `${UPDATE_BASE}/settings` },
    { key: 'rollback', label: t('admin.update.tabs.rollback'), to: `${UPDATE_BASE}/rollback` },
    { key: 'apps', label: t('admin.update.tabs.apps'), to: `${UPDATE_BASE}/apps` },
    { key: 'history', label: t('admin.update.tabs.history'), to: `${UPDATE_BASE}/history` },
    { key: 'offline', label: t('admin.update.tabs.offline'), to: `${UPDATE_BASE}/offline` },
  ]
  // 현황·새 버전 안내는 상태가 있어야 렌더링한다. 나머지 탭은 각자 필요한 데이터를 조회한다
  const needsStatus = view === 'home' || view === 'notes' || ((view === 'apply' || view === 'changes') && !arg)
  const waiting = needsStatus && !status
  const liveJob = isLive(status?.job) ? status!.job! : null

  return (
    <AdminPageShell title={title} width="wide"
      actions={inner ? <UiButton variant="ghost" size="sm" icon="arrow-left" onClick={() => navigate(UPDATE_BASE)}>{t('admin.update.toHome')}</UiButton> : undefined}>
      <UiTabs ariaLabel={title} items={tabs} flush />
      <div className="flex flex-col gap-4 pt-1" data-testid={`update-view-${view}`}>
        {waiting ? (
          error
            ? <UiErrorTile placement="card" title={t('admin.update.loadError')} onRetry={() => { void load() }} />
            : <UiCard><UiSkeleton preset="list" rows={5} /></UiCard>
        ) : (
          <>
            {view === 'home' && <HomeTab status={status!} onReload={() => { void load() }} onChecked={setStatus} />}
            {view === 'notes' && <NotesView status={status!} onReload={() => { void load() }} />}
            {view === 'apply' && (arg
              ? <JobView key={arg} jobId={arg} onFinished={() => { void load() }} />
              : <JobRedirect job={liveJob && liveJob.kind === 'update' ? liveJob : null} fallback={UPDATE_BASE} />)}
            {view === 'changes' && <ChangesView version={arg ?? status?.current.version ?? ''} />}
            {view === 'settings' && <SettingsTab status={status} onSaved={() => { void load() }} />}
            {view === 'rollback' && (arg ? <JobView key={arg} jobId={arg} onFinished={() => { void load() }} /> : <RollbackTab status={status} />)}
            {view === 'offline' && <OfflineTab />}
            {view === 'apps' && <AppsTab />}
            {view === 'history' && <HistoryTab />}
          </>
        )}
      </div>
    </AdminPageShell>
  )
}
