// Vue 원본: frontend/pages/settings/apps.vue
// 설정 › 연결된 앱(시안 SettingsPage section=apps · Review11 D1b).
//  ① 연결된 앱 — OAuth 동의로 내 계정에 접근하는 앱(GET /api/auth/me/apps).
//  ② 앱 비밀번호 — 메일 앱·CalDAV 처럼 로그인 화면이 없는 프로그램용(GET/POST/DELETE /api/auth/me/app-passwords).
//  ③ AI 커넥터(MCP) URL·개인 액세스 토큰 — 설정 › AI 연동(MCP)(pages/settings/ai-mcp.tsx, 시안 H1)으로 옮기고 여기엔 바로가기만.
import { useEffect, useRef, useState } from 'react'
import { navigateTo } from '~/lib/router'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { $fetch } from '~/lib/api'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiButton } from '~/components/ui/Button'
import { SettingsHeader } from '~/components/settings/SettingsHeader'
import { SettingsCard } from '~/components/settings/SettingsCard'
import { UiTrans } from '~/components/ui/Trans'
import {
  SettingsAppPasswordIssuedModal, SettingsAppPasswordNewModal, SettingsAppPasswordRow, SettingsConnectedAppRow,
  type AppPasswordDraft,
} from '~/components/settings/SettingsAppsParts'

interface App { client_id: string; name: string; scopes: string[]; scope_labels: string[]; connected_at: string | null; last_used_at: string | null }
interface AppPw { id: string; name: string; scopes: string[]; created_at: string; last_used_at: string | null }

const detailOf = (e: unknown) => (e as { data?: { detail?: string } } | null)?.data?.detail

export default function SettingsAppsPage() {
  const { t, locale } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: `${t('settings.apps.title')} | ${appName}` })

  function fmtDay(s: string | null) {
    if (!s) return '—'
    const d = new Date(s)
    if (Number.isNaN(d.getTime())) return '—'
    const now = new Date()
    const days = Math.floor((now.getTime() - d.getTime()) / 86400000)
    if (d.toDateString() === now.toDateString()) return t('settings.apps.today')
    if (days < 2) return t('settings.sessions.yesterday')
    if (d.getFullYear() !== now.getFullYear()) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    return d.toLocaleDateString(locale === 'ko' ? 'ko-KR' : 'en-US', { month: '2-digit', day: '2-digit' })
  }

  // ── ① 연결된 앱 ──
  const [apps, setApps] = useState<App[] | null>(null)
  const [appsError, setAppsError] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  async function loadApps() {
    setAppsError(false)
    try { setApps((await $fetch<{ apps: App[] }>('/api/auth/me/apps')).apps) }
    catch { setAppsError(true) }
  }
  async function disconnect(a: App) {
    if (!await confirmBox(t('settings.apps.disconnectBody', { name: a.name }), { title: t('settings.apps.disconnectTitle'), confirmLabel: t('settings.apps.disconnect'), danger: true })) return
    setBusy(a.client_id)
    try {
      await $fetch(`/api/auth/me/apps/${encodeURIComponent(a.client_id)}`, { method: 'DELETE' })
      setApps(list => (list || []).filter(x => x.client_id !== a.client_id))
    } catch (e) { addToast('error', detailOf(e) || t('settings.apps.disconnectFailed')) }
    finally { setBusy(null) }
  }

  // ── ② 앱 비밀번호 ──
  const [pws, setPws] = useState<AppPw[] | null>(null)
  const [pwsError, setPwsError] = useState(false)
  async function loadPws() {
    setPwsError(false)
    try { setPws((await $fetch<{ app_passwords: AppPw[] }>('/api/auth/me/app-passwords')).app_passwords) }
    catch { setPwsError(true) }
  }
  const SCOPE_LABEL: Record<string, string> = { mail: t('settings.appPw.scopeMail'), dav: t('settings.appPw.scopeDav') }
  function pwMeta(p: AppPw) {
    return [...p.scopes.map(s => SCOPE_LABEL[s] ?? s), t('settings.appPw.createdOn', { date: fmtDay(p.created_at) })].join(' · ')
  }
  const [, setCreating] = useState(false)
  const [newPw, setNewPw] = useState<AppPasswordDraft & { open: boolean }>({ open: false, name: '', mail: true, dav: true, error: '', saving: false })
  const [issued, setIssued] = useState<{ name: string; password: string } | null>(null)
  function openNew() { setNewPw({ open: true, name: '', mail: true, dav: true, error: '', saving: false }) }
  async function createPw() {
    if (!newPw.name.trim()) { setNewPw(p => ({ ...p, error: t('settings.appPw.nameRequired') })); return }
    const scopes = [newPw.mail && 'mail', newPw.dav && 'dav'].filter(Boolean)
    if (!scopes.length) { setNewPw(p => ({ ...p, error: t('settings.appPw.scopeRequired') })); return }
    setNewPw(p => ({ ...p, saving: true })); setCreating(true)
    try {
      const r = await $fetch<AppPw & { password: string }>('/api/auth/me/app-passwords', { method: 'POST', body: { name: newPw.name.trim(), scopes } })
      setNewPw(p => ({ ...p, open: false }))
      setIssued({ name: r.name, password: r.password })
      await loadPws()
    } catch (e) { setNewPw(p => ({ ...p, error: detailOf(e) || t('settings.appPw.createFailed') })) }
    finally { setNewPw(p => ({ ...p, saving: false })); setCreating(false) }
  }
  async function removePw(p: AppPw) {
    if (!await confirmBox(t('settings.appPw.deleteBody', { name: p.name }), { title: t('settings.appPw.deleteTitle'), confirmLabel: t('common.delete'), danger: true })) return
    setBusy(p.id)
    try {
      await $fetch(`/api/auth/me/app-passwords/${encodeURIComponent(p.id)}`, { method: 'DELETE' })
      setPws(list => (list || []).filter(x => x.id !== p.id))
    } catch (e) { addToast('error', detailOf(e) || t('settings.appPw.deleteFailed')) }
    finally { setBusy(null) }
  }

  const mounted = useRef(false)
  useEffect(() => {
    if (mounted.current) return
    mounted.current = true
    void loadApps(); void loadPws()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <SettingsHeader title={t('settings.apps.title')} subtitle={t('settings.apps.subtitle')} />

      {/* ① 연결된 앱 */}
      <SettingsCard title={t('settings.apps.title')} description={t('settings.apps.desc')} flush>
        {apps === null && !appsError
          ? <UiSkeleton preset="list" rows={2} className="border-t border-border" />
          : appsError
            ? <UiErrorTile placement="panel" title={t('settings.apps.loadError')} className="border-t border-border" onRetry={() => void loadApps()} />
            : !apps?.length
              ? <UiEmptyState variant="inline" inset title={t('settings.apps.noConnections')} className="border-t border-border" />
              : apps.map(a => (
                <SettingsConnectedAppRow
                  key={a.client_id}
                  name={a.name}
                  scopeLabels={a.scope_labels}
                  since={(
                    <UiTrans
                      k="settings.apps.since"
                      as="span"
                      slots={{
                        since: <span className="font-mono">{fmtDay(a.connected_at)}</span>,
                        last: <span className="font-mono">{fmtDay(a.last_used_at)}</span>,
                      }}
                    />
                  )}
                  disabled={busy !== null}
                  onDisconnect={() => void disconnect(a)}
                />
              ))}
      </SettingsCard>

      {/* ② 앱 비밀번호 */}
      <SettingsCard
        title={t('settings.appPw.title')}
        description={t('settings.appPw.desc')}
        flush
        header={<UiButton size="xs" className="shrink-0 font-semibold" onClick={openNew}>{t('settings.appPw.new')}</UiButton>}
      >
        {pws === null && !pwsError
          ? <UiSkeleton preset="list" rows={1} className="border-t border-border" />
          : pwsError
            ? <UiErrorTile placement="panel" title={t('settings.appPw.loadError')} className="border-t border-border" onRetry={() => void loadPws()} />
            : !pws?.length
              ? <UiEmptyState variant="inline" inset title={t('settings.appPw.empty')} className="border-t border-border" />
              : pws.map(p => (
                <SettingsAppPasswordRow
                  key={p.id}
                  name={p.name}
                  meta={pwMeta(p)}
                  lastUsed={p.last_used_at ? fmtDay(p.last_used_at) : undefined}
                  disabled={busy !== null}
                  onDelete={() => void removePw(p)}
                />
              ))}
      </SettingsCard>

      {/* ③ AI 커넥터(MCP)는 설정 › AI 연동(MCP)으로 옮겼다(시안 H1) */}
      <SettingsCard title={t('settings.apps.mcpTitle')} description={t('settings.apps.mcpMoved')}
        header={<UiButton variant="outline" size="xs" className="shrink-0" onClick={() => void navigateTo('/settings/ai/mcp')}>{t('settings.apps.mcpOpen')}</UiButton>} />

      {/* 새 앱 비밀번호 */}
      {newPw.open && (
        <SettingsAppPasswordNewModal
          draft={newPw}
          onChange={patch => setNewPw(p => ({ ...p, ...patch }))}
          onCreate={() => void createPw()}
          onClose={() => setNewPw(p => ({ ...p, open: false }))}
        />
      )}

      {/* 발급된 앱 비밀번호(한 번만) */}
      {issued && <SettingsAppPasswordIssuedModal name={issued.name} password={issued.password} onClose={() => setIssued(null)} />}
    </>
  )
}
