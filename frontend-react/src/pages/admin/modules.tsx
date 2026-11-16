/**
 * 관리 › 모듈·플러그인.
 * 한 카드 안 행 64 — 타일 36(글자) + 이름(플러그인이면 "플러그인 v" 배지) + 설명 한 줄, 켜짐/꺼짐 글자 + 스위치(즉시 반영) + ⋮.
 * 헤더 1차 = "플러그인 설치"(모달). 설치·삭제 후에는 서버 재시작 대기 모달을 표시한다(/api/health 폴링).
 * 플러그인 이름·설명은 서버 목록을 그대로 표시한다(코드에 개별 플러그인 이름을 기재하지 않는다).
 * 서버가 로드하지 않은 플러그인(목록의 `skipped` — 필요한 구역이 비활성화된 경우)은 카드 아래에 사유와 함께 별도로 표시한다.
 */
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { navigateTo } from '~/lib/router'
import { $fetch } from '~/lib/api'
import { cn } from '~/lib/utils'
import { useAuth } from '~/composables/useAuth'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { usePlatform, fetchModules, toggleModule } from '~/composables/usePlatform'
import { zonesApi, localized } from '~/composables/useSystemZones'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { AdminPageShell } from '~/components/admin/AdminPageShell'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiBadge } from '~/components/ui/Badge'
import { UiSwitch } from '~/components/ui/Switch'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { UiModal } from '~/components/ui/Modal'

interface PluginInfo { id: string; name: string; version: string; description: string; author: string; enabled: boolean; removable?: boolean }
/** 서버가 로드하지 않은 플러그인 — reason 은 현재 zone_not_installed 하나 */
export interface SkippedPlugin { id: string; name: string; reason: string; missing_zones?: string[] }
interface Row { id: string; name: string; desc: string; enabled: boolean; plugin: boolean; version?: string; removable?: boolean }

// 기본 모듈 설명(시안 문구). 플러그인은 서버가 반환한 설명 사용.
const DESC_IDS = ['mail', 'chat', 'files', 'calendar', 'contacts', 'board', 'git', 'ai', 'meetings', 'tasks', 'wiki']
function tile(name: string) { return /^[A-Za-z]{1,3}$/.test(name) ? name : name.charAt(0) }

export default function AdminModulesPage() {
  const { t, locale } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: t('admin.common.headTitle', { page: t('admin.modules.pageTitle'), app: appName }) })
  const { user } = useAuth()
  useEffect(() => { if (user && !user.is_admin) void navigateTo('/') }, [user])

  const { modules } = usePlatform()
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [skipped, setSkipped] = useState<SkippedPlugin[]>([])
  // 구역 id → 이름(구역 목록 조회 가능 시에만 적용. 조회 실패 시 id 그대로 표시)
  const [zoneNames, setZoneNames] = useState<Record<string, Record<string, string>>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [toggling, setToggling] = useState<string | null>(null)

  const DESC: Record<string, string> = Object.fromEntries(DESC_IDS.map(id => [id, t(`admin.modules.desc.${id}`)]))
  const builtin: Row[] = modules
    .filter(m => m.type !== 'plugin')
    .map(m => ({ id: m.id, name: m.name, desc: DESC[m.id] ?? m.route, enabled: m.enabled, plugin: false }))
  const plug: Row[] = plugins.map(p => ({ id: p.id, name: p.name, desc: p.description || (p.author ? `by ${p.author}` : ''), enabled: p.enabled, plugin: true, version: p.version, removable: p.removable }))
  const rows = [...builtin, ...plug]

  async function load() {
    setLoading(true); setLoadError(false)
    try {
      const [, p] = await Promise.all([
        fetchModules(),
        $fetch<{ plugins: PluginInfo[]; skipped?: SkippedPlugin[] }>('/api/admin/plugins'),
      ])
      setPlugins(p.plugins || [])
      setSkipped(p.skipped || [])
      if (p.skipped?.length) {
        zonesApi.list()
          .then(z => setZoneNames(Object.fromEntries([...(z.zones || []), ...(z.addons || [])].map(x => [x.id, x.name]))))
          .catch(() => { /* 이름 없이 id 로 표시 */ })
      }
    } catch { setLoadError(true) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  async function setEnabled(r: Row, v: boolean) {
    setToggling(r.id)
    try {
      if (r.plugin) {
        await $fetch(`/api/admin/plugins/${r.id}`, { method: 'PATCH', body: { enabled: v } })
        setPlugins(list => list.map(x => (x.id === r.id ? { ...x, enabled: v } : x)))
        await fetchModules()
      } else {
        await toggleModule(r.id, v)
      }
    } catch (e: any) { addToast('error', e?.data?.detail || t(v ? 'admin.modules.turnOnFailed' : 'admin.modules.turnOffFailed', { name: r.name })) }
    finally { setToggling(null) }
  }

  function menuItems(r: Row): UiMenuItem[] {
    const items: UiMenuItem[] = [{ key: 'groups', label: t('admin.modules.menuGroups'), icon: 'users', to: '/admin/groups' }]
    if (r.plugin && r.removable) items.push({ key: 'remove', label: t('common.delete'), icon: 'trash', danger: true })
    return items
  }
  async function onMenu(r: Row, key: string) {
    if (key !== 'remove') return
    if (!await confirmBox(t('admin.modules.removeBody'), { title: t('admin.modules.removeTitle', { name: r.name }), confirmLabel: t('common.delete'), danger: true })) return
    try {
      await $fetch(`/api/admin/plugins/${r.id}`, { method: 'DELETE' })
      await waitForRestart()
    } catch (e: any) { addToast('error', t('admin.modules.removeFailed', { err: String(e?.data?.detail || e?.message || e) })) }
  }

  // ── 설치(모달) · 재시작 대기 ──
  const [installOpen, setInstallOpen] = useState(false)
  const [installFile, setInstallFile] = useState<File | null>(null)
  const [installing, setInstalling] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)

  async function waitForRestart() {
    setRestarting(true)
    await new Promise(r => setTimeout(r, 4000))
    for (let i = 0; i < 30; i++) {
      try { await $fetch('/api/health'); break } catch { /* 재시작 중 */ }
      await new Promise(r => setTimeout(r, 2000))
    }
    await load()
    setRestarting(false)
  }
  async function install() {
    if (!installFile || installing) return
    setInstalling(true)
    try {
      const fd = new FormData()
      fd.append('file', installFile)
      await $fetch('/api/admin/plugins/install', { method: 'POST', body: fd })
      setInstallOpen(false)
      setInstallFile(null)
      await waitForRestart()
      addToast('success', t('admin.modules.installedToast'))
    } catch (e: any) {
      addToast('error', t('admin.modules.installFailed', { err: String(e?.data?.detail || e?.message || e) }))
    } finally { setInstalling(false) }
  }

  function skippedReason(p: SkippedPlugin) {
    if (p.reason === 'zone_not_installed') {
      const zones = (p.missing_zones || []).map(id => localized(zoneNames[id], locale) || id).join(', ')
      return t('admin.modules.skipped.zoneNotInstalled', { zones })
    }
    return t('admin.modules.skipped.other', { reason: p.reason })
  }

  if (!user?.is_admin) return null
  return (
    <AdminPageShell
      title={t('admin.modules.pageTitle')}
      subtitle={t('admin.modules.pageSubtitle')}
      width="wide"
      actions={<UiButton icon="upload" onClick={() => setInstallOpen(true)}>{t('admin.modules.installPlugin')}</UiButton>}
    >
      {loading && !rows.length ? (
        <UiSkeleton preset="list" rows={8} framed />
      ) : loadError && !rows.length ? (
        <UiErrorTile placement="panel" title={t('admin.modules.loadError')} onRetry={load} />
      ) : (
        <section className="rounded-lg border border-border bg-card">
          {rows.map(r => (
            <div key={(r.plugin ? 'p:' : 'm:') + r.id} className="flex min-h-16 items-center gap-3.5 border-b border-border px-4 py-2 last:border-b-0 sm:px-[18px]">
              <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted text-[13px] font-bold', r.enabled ? 'text-foreground' : 'text-muted-foreground')}>{tile(r.name)}</span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
                  <span className="truncate">{r.name}</span>
                  {r.plugin && <UiBadge tone="neutral" tint size={18}>{t('admin.modules.pluginBadge')} <span className="ml-1 font-mono">{r.version}</span></UiBadge>}
                </div>
                <div className="truncate text-xs text-muted-foreground">{r.desc}</div>
              </div>
              <span className={cn('hidden text-xs sm:inline', r.enabled ? 'font-semibold text-success' : 'text-muted-foreground')}>{r.enabled ? t('admin.modules.on') : t('admin.modules.off')}</span>
              <UiSwitch
                modelValue={r.enabled}
                ariaLabel={t('admin.modules.useAria', { name: r.name })}
                disabled={toggling === r.id || restarting}
                onUpdateModelValue={v => { void setEnabled(r, v) }}
              />
              <UiMenu triggerIcon="more-vertical" label={t('admin.common.rowMenu', { name: r.name })} items={menuItems(r)} onSelect={key => { void onMenu(r, key) }} />
            </div>
          ))}
        </section>
      )}

      {/* 로드하지 않은 플러그인 — 사유와 함께 표시 */}
      {skipped.length > 0 && (
        <section className="mt-5" aria-labelledby="skipped-plugins-title">
          <h2 id="skipped-plugins-title" className="mb-1 text-sm font-semibold text-foreground">{t('admin.modules.skipped.title')}</h2>
          <p className="mb-2 text-xs text-muted-foreground">{t('admin.modules.skipped.lead')}</p>
          <div className="rounded-lg border border-border bg-card">
            {skipped.map(p => (
              <div key={p.id} data-testid={`skipped-${p.id}`} className="flex min-h-14 items-center gap-3.5 border-b border-border px-4 py-2 last:border-b-0 sm:px-[18px]">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted text-[13px] font-bold text-muted-foreground">{tile(p.name)}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-foreground">{p.name}</div>
                  <div className="text-xs text-muted-foreground">{skippedReason(p)}</div>
                </div>
                <UiBadge tone="warning" tint size={18}>{t('admin.modules.skipped.badge')}</UiBadge>
                {p.reason === 'zone_not_installed' && (
                  <UiButton variant="outline" size="sm" onClick={() => { void navigateTo('/admin/zones') }}>{t('admin.modules.skipped.toZones')}</UiButton>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 플러그인 설치 */}
      {installOpen && (
        <UiModal
          title={t('admin.modules.installPlugin')}
          size="sm"
          onClose={() => setInstallOpen(false)}
          footer={
            <>
              <UiButton variant="outline" size="sm" onClick={() => setInstallOpen(false)}>{t('common.cancel')}</UiButton>
              <UiButton size="sm" disabled={!installFile || installing} onClick={install}>{installing ? t('admin.modules.installing') : t('admin.modules.install')}</UiButton>
            </>
          }
        >
          <p className="text-[13px] text-muted-foreground">{t('admin.modules.installHint')}</p>
          <UiButton variant="outline" className="justify-start" onClick={() => fileInput.current?.click()}>
            <UiIcon name="upload" className="mr-2 h-4 w-4 shrink-0" /><span className="truncate">{installFile?.name || t('admin.modules.pickPackage')}</span>
          </UiButton>
          <input ref={fileInput} type="file" accept=".zip" className="hidden" onChange={e => setInstallFile(e.target.files?.[0] || null)} />
        </UiModal>
      )}

      {/* 재시작 대기 */}
      {restarting && (
        <UiModal confirm persistent ariaLabel={t('admin.modules.restartingAria')} onClose={() => {}}>
          <div className="flex flex-col items-center gap-2 py-2 text-center" role="status">
            <UiIcon name="refresh" className="h-6 w-6 animate-spin text-muted-foreground" />
            <p className="text-[13px] font-semibold text-foreground">{t('admin.modules.restartingTitle')}</p>
            <p className="text-[13px] text-muted-foreground">{t('admin.modules.restartingHint')}</p>
          </div>
        </UiModal>
      )}
    </AdminPageShell>
  )
}
