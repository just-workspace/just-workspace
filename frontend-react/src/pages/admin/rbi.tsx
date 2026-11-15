/**
 * 관리 › 격리 브라우저 — 임시 기능 화면(시안은 Claude Design — TODO(handover-rbi)). 기존 관리 카드 규격(AdminPageShell + SettingsCard)만 쓴다.
 * 대상은 여기서만 더하고 고친다 — 저장하면 출구(허용 목적지)가 검증·고정되고 netfilter 사이드카가 한 주기(5초) 안에 건다(.env 수정·재시작 없음).
 *  1) 격리 규칙 상태: 사이드카 하트비트(적용/미확인·나이) · 지금 걸린 허용 목록 · 원하는데 아직 안 걸린 것 · 사이드카가 거부한 줄 ·
 *     고정 허용(RBI_ALLOW)·상한(RBI_ALLOW_CEILING) · 전용 출처 · 이미지 · 네트워크 · 활성 세션 n/max
 *  2) 대상: 목록(이름·주소·사용 스위치·화면 방식·정책·출구) + [대상 추가] → 인라인 폼(식별자·이름·주소·화면 방식·허용 호스트·추가 포트·
 *     정책 스위치·유휴/수명·CPU/메모리·허용 그룹/사용자 ID·강제) — 거부 사유는 서버 문구 그대로, 강제 저장은 경고 토스트
 *  3) 활성 세션: 사용자·대상·시작·마지막 활동 + [강제 종료](확인)
 * API: GET /api/admin/rbi · POST /api/admin/rbi/targets · PUT/DELETE /api/admin/rbi/targets/{id} · DELETE /api/admin/rbi/sessions/{id}
 */
import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { navigateTo } from '~/lib/router'
import { $fetch } from '~/lib/api'
import { useAuth } from '~/composables/useAuth'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { fmtRbiTime, rbiPolicyKeys, type RbiAdminOverview, type RbiAdminTarget, type RbiMode, type RbiSession } from '~/composables/useRbi'
import { AdminPageShell } from '~/components/admin/AdminPageShell'
import { SettingsCard } from '~/components/settings/SettingsCard'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiInput } from '~/components/ui/Input'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiSwitch } from '~/components/ui/Switch'
import { UiSelect } from '~/components/ui/Select'
import { UiErrorTile } from '~/components/ui/ErrorTile'

interface Form {
  key: string
  name: string
  url: string
  mode: RbiMode
  allowed_hosts: string
  enabled: boolean
  clipboard_to_browser: boolean
  clipboard_from_browser: boolean
  downloads: boolean
  uploads: boolean
  idle_minutes: string
  max_hours: string
  cpu: string
  memory_mb: string
  allowed_group_ids: string
  allowed_user_ids: string
  extra_ports: string
  force: boolean
}

const EMPTY: Form = {
  key: '', name: '', url: '', mode: 'pixel', allowed_hosts: '', enabled: true,
  clipboard_to_browser: true, clipboard_from_browser: true, downloads: false, uploads: false,
  idle_minutes: '15', max_hours: '8', cpu: '2', memory_mb: '2048', allowed_group_ids: '', allowed_user_ids: '',
  extra_ports: '', force: false,
}

function toForm(t: RbiAdminTarget): Form {
  return {
    key: t.key, name: t.name, url: t.url, mode: t.mode ?? 'pixel', allowed_hosts: t.allowed_hosts.filter(h => h !== t.host && h !== `${t.host}`).join(', '),
    enabled: t.enabled,
    clipboard_to_browser: t.policy.clipboard_to_browser, clipboard_from_browser: t.policy.clipboard_from_browser,
    downloads: t.policy.downloads, uploads: t.policy.uploads,
    idle_minutes: String(t.policy.idle_minutes), max_hours: String(t.policy.max_hours),
    cpu: String(t.cpu), memory_mb: String(t.memory_mb),
    allowed_group_ids: t.allowed_group_ids.join(', '), allowed_user_ids: t.allowed_user_ids.join(', '),
    extra_ports: (t.extra_ports ?? []).join(', '), force: !!t.egress_forced,
  }
}

const list = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean)

function toBody(f: Form): Record<string, unknown> {
  return {
    key: f.key.trim(), name: f.name.trim(), url: f.url.trim(), mode: f.mode, allowed_hosts: list(f.allowed_hosts), enabled: f.enabled,
    clipboard_to_browser: f.clipboard_to_browser, clipboard_from_browser: f.clipboard_from_browser,
    downloads: f.downloads, uploads: f.uploads,
    idle_minutes: Number(f.idle_minutes), max_hours: Number(f.max_hours), cpu: Number(f.cpu), memory_mb: Number(f.memory_mb),
    allowed_group_ids: list(f.allowed_group_ids), allowed_user_ids: list(f.allowed_user_ids),
    extra_ports: list(f.extra_ports).map(Number), force: f.force,
  }
}

/** 대상 폼 — TODO(handover-rbi): 그룹/사용자 선택은 ID 입력(임시). 시안에서 피커로 */
function TargetForm({ initial, saving, onSave, onCancel }: { initial: Form; saving: boolean; onSave: (f: Form) => void; onCancel: () => void }) {
  const { t } = useI18n()
  const [f, setF] = useState<Form>(initial)
  const set = <K extends keyof Form>(k: K) => (v: Form[K]) => setF(prev => ({ ...prev, [k]: v }))
  const A = 'rbi.admin.'
  return (
    <form className="grid gap-x-4 gap-y-3.5 rounded-md border border-border p-4 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); onSave(f) }} aria-label={t(A + 'editTarget')}>
      <UiInput modelValue={f.key} onUpdateModelValue={set('key')} label={t(A + 'key')} hint={t(A + 'keyHint')} placeholder="portal" mono required />
      <UiInput modelValue={f.name} onUpdateModelValue={set('name')} label={t(A + 'name')} placeholder="Intranet Portal" required />
      <UiInput modelValue={f.url} onUpdateModelValue={set('url')} label={t(A + 'url')} hint={t(A + 'urlHint')} placeholder="http://192.168.10.70" mono required className="sm:col-span-2" />
      {/* TODO(handover-rbi): 화면 방식 고르기 규격(셀렉트/세그먼트)은 시안에서 */}
      <UiSelect modelValue={f.mode} onUpdateModelValue={v => set('mode')((v === 'mirror' ? 'mirror' : 'pixel') as RbiMode)} label={t(A + 'mode')} hint={t(A + 'modeHint')} native className="sm:col-span-2"
        options={[{ value: 'pixel', label: t('rbi.mode.pixel') }, { value: 'mirror', label: t('rbi.mode.mirror') }]} />
      <UiInput modelValue={f.allowed_hosts} onUpdateModelValue={set('allowed_hosts')} label={t(A + 'allowedHosts')} hint={t(A + 'allowedHostsHint')} mono className="sm:col-span-2" />
      <UiInput modelValue={f.extra_ports} onUpdateModelValue={set('extra_ports')} label={t(A + 'extraPorts')} hint={t(A + 'extraPortsHint')} placeholder="8080, 8443" mono className="sm:col-span-2" />
      <div className="flex flex-col gap-2.5 sm:col-span-2">
        <UiSwitch modelValue={f.enabled} onUpdateModelValue={set('enabled')} label={t(A + 'enabled')} />
        <UiSwitch modelValue={f.clipboard_to_browser} onUpdateModelValue={set('clipboard_to_browser')} label={t(A + 'clipboardToBrowser')} />
        <UiSwitch modelValue={f.clipboard_from_browser} onUpdateModelValue={set('clipboard_from_browser')} label={t(A + 'clipboardFromBrowser')} />
        <UiSwitch modelValue={f.downloads} onUpdateModelValue={set('downloads')} label={t(A + 'downloads')} />
        <UiSwitch modelValue={f.uploads} onUpdateModelValue={set('uploads')} label={t(A + 'uploads')} />
        {/* 워크스페이스 자신(RP·앱 호스트·게이트웨이)을 여는 위험한 선택 — 기본 꺼짐, 켜면 경고와 감사 */}
        <UiSwitch modelValue={f.force} onUpdateModelValue={set('force')} label={t(A + 'force')} />
        <p className="text-xs text-muted-foreground">{t(A + 'forceHint')}</p>
      </div>
      <UiInput modelValue={f.idle_minutes} onUpdateModelValue={set('idle_minutes')} label={t(A + 'idle')} type="number" mono />
      <UiInput modelValue={f.max_hours} onUpdateModelValue={set('max_hours')} label={t(A + 'maxHours')} type="number" mono />
      <UiInput modelValue={f.cpu} onUpdateModelValue={set('cpu')} label={t(A + 'cpu')} type="number" mono />
      <UiInput modelValue={f.memory_mb} onUpdateModelValue={set('memory_mb')} label={t(A + 'memory')} type="number" mono />
      <UiInput modelValue={f.allowed_group_ids} onUpdateModelValue={set('allowed_group_ids')} label={t(A + 'allowedGroups')} hint={t(A + 'allowedIdsHint')} mono className="sm:col-span-2" />
      <UiInput modelValue={f.allowed_user_ids} onUpdateModelValue={set('allowed_user_ids')} label={t(A + 'allowedUsers')} hint={t(A + 'allowedIdsHint')} mono className="sm:col-span-2" />
      <div className="flex gap-2 sm:col-span-2">
        <UiButton type="submit" size="sm" disabled={saving}>{t(A + 'save')}</UiButton>
        <UiButton type="button" variant="outline" size="sm" onClick={onCancel}>{t(A + 'cancel')}</UiButton>
      </div>
    </form>
  )
}

export default function AdminRbiPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: t('admin.common.headTitle', { page: t('rbi.title'), app: appName }) })
  const { user } = useAuth()
  useEffect(() => { if (user && !user.is_admin) void navigateTo('/') }, [user])

  const [data, setData] = useState<RbiAdminOverview | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [editing, setEditing] = useState<{ id: string | null; form: Form } | null>(null)
  const [saving, setSaving] = useState(false)
  const A = 'rbi.admin.'

  const load = useCallback(async () => {
    setLoadError(false)
    try { setData(await $fetch<RbiAdminOverview>('/api/admin/rbi')) } catch { setLoadError(true) }
  }, [])
  useEffect(() => { void load() }, [load])

  async function save(f: Form) {
    if (!editing) return
    setSaving(true)
    try {
      const r = editing.id
        ? await $fetch<{ warnings?: string[] }>(`/api/admin/rbi/targets/${editing.id}`, { method: 'PUT', body: toBody(f) })
        : await $fetch<{ warnings?: string[] }>('/api/admin/rbi/targets', { method: 'POST', body: toBody(f) })
      addToast('success', t(A + 'saved'))
      for (const w of r?.warnings ?? []) addToast('warning', w)
      setEditing(null)
      await load()
    } catch (e: any) {
      addToast('error', e?.data?.detail || t(A + 'saveFailed'))
    } finally { setSaving(false) }
  }

  async function remove(tg: RbiAdminTarget) {
    if (!(await confirmBox(t(A + 'deleteConfirm', { name: tg.name }), { title: t(A + 'delete'), confirmLabel: t(A + 'delete'), danger: true }))) return
    try { await $fetch(`/api/admin/rbi/targets/${tg.id}`, { method: 'DELETE' }); await load() } catch (e: any) { addToast('error', e?.data?.detail || t(A + 'saveFailed')) }
  }

  async function toggle(tg: RbiAdminTarget, on: boolean) {
    try { await $fetch(`/api/admin/rbi/targets/${tg.id}`, { method: 'PUT', body: { enabled: on } }); await load() } catch (e: any) { addToast('error', e?.data?.detail || t(A + 'saveFailed')) }
  }

  async function forceStop(s: RbiSession) {
    if (!(await confirmBox(t(A + 'forceStopConfirm', { name: s.target_name }), { title: t(A + 'forceStop'), confirmLabel: t(A + 'forceStop'), danger: true }))) return
    try { await $fetch(`/api/admin/rbi/sessions/${s.id}`, { method: 'DELETE' }); await load() } catch (e: any) { addToast('error', e?.data?.detail || t(A + 'saveFailed')) }
  }

  if (!user?.is_admin) return null
  const st = data?.status
  return (
    <AdminPageShell title={t('rbi.title')} subtitle={t(A + 'pageSubtitle')} width="wide">
      <SettingsCard title={t(A + 'statusCard')} description={t(A + 'statusDesc')} footer={false}>
        {loadError ? (
          <UiErrorTile placement="card" title={t(A + 'loadError')} onRetry={() => { void load() }} />
        ) : !st ? <UiSkeleton preset="text" rows={3} /> : (
          <dl className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{t(A + 'statusCard')}</dt>
            <dd className="flex flex-wrap items-center gap-2" role="status">
              <UiIcon name={st.guard.ok ? 'check-circle' : 'alert-circle'} className={st.guard.ok ? 'h-4 w-4 text-success' : 'h-4 w-4 text-danger'} />
              <span className={st.guard.ok ? 'font-semibold text-success' : 'font-semibold text-danger'}>{st.guard.ok ? t(A + 'guardOk') : t(A + 'guardBad')}</span>
              {st.guard.age != null && <span className="text-muted-foreground">· {t(A + 'guardAge', { age: st.guard.age })}</span>}
              {!st.guard.ok && <span className="font-mono text-xs text-muted-foreground">{st.guard.reason}</span>}
            </dd>
            <dt className="text-muted-foreground">{t(A + 'guardAllow')}</dt>
            <dd className="font-mono text-xs" data-testid="rbi-allow-applied">{(st.guard.allow ?? []).join(', ') || '—'}</dd>
            {st.egress && (
              <>
                <dt className="text-muted-foreground">{t(A + 'allowDesired')}</dt>
                <dd className="font-mono text-xs">{st.egress.desired.join(', ') || '—'}</dd>
                {st.egress.pending.length > 0 && (
                  <>
                    <dt className="text-muted-foreground">{t(A + 'allowPending')}</dt>
                    <dd className="flex flex-wrap items-center gap-1.5" data-testid="rbi-allow-pending">
                      <UiBadge tone="warning" tint size={18}>{t(A + 'allowPendingBadge')}</UiBadge>
                      <span className="font-mono text-xs">{st.egress.pending.join(', ')}</span>
                    </dd>
                  </>
                )}
                {(st.guard.rejected ?? []).length > 0 && (
                  <>
                    <dt className="text-muted-foreground">{t(A + 'allowRejected')}</dt>
                    <dd className="flex flex-col gap-0.5 font-mono text-xs text-danger" data-testid="rbi-allow-rejected">
                      {(st.guard.rejected ?? []).map(r => <span key={r}>{r}</span>)}
                    </dd>
                  </>
                )}
                <dt className="text-muted-foreground">{t(A + 'allowStatic')}</dt>
                <dd className="font-mono text-xs">{st.egress.static.join(', ') || '—'}</dd>
                <dt className="text-muted-foreground">{t(A + 'allowCeiling')}</dt>
                <dd className="font-mono text-xs">{st.egress.ceiling}{st.egress.protected ? ` · ${t(A + 'protected')} ${st.egress.protected}` : ''}</dd>
              </>
            )}
            <dt className="text-muted-foreground">{t(A + 'publicOrigin')}</dt>
            <dd className="font-mono text-xs">{st.public_origin || t(A + 'publicOriginUnset')}</dd>
            <dt className="text-muted-foreground">{t(A + 'image')}</dt>
            <dd className="font-mono text-xs">{st.image}</dd>
            <dt className="text-muted-foreground">{t(A + 'mirrorImage')}</dt>
            <dd className="font-mono text-xs">{st.mirror_image}</dd>
            <dt className="text-muted-foreground">{t(A + 'network')}</dt>
            <dd className="font-mono text-xs">{st.network} · {st.subnet} · {st.bridge} → {st.publish_ip}</dd>
            <dt className="text-muted-foreground">{t('rbi.admin.sessionsCard')}</dt>
            <dd>{t(A + 'activeSessions', { n: st.active_sessions, max: st.max_sessions })}</dd>
          </dl>
        )}
      </SettingsCard>

      <SettingsCard
        title={t(A + 'targetsCard')} description={t(A + 'targetsDesc')} footer={false}
        header={<UiButton size="xs" icon="plus" onClick={() => setEditing({ id: null, form: EMPTY })}>{t(A + 'addTarget')}</UiButton>}
      >
        {!data ? <UiSkeleton preset="list" rows={2} /> : (
          <div className="flex flex-col gap-3">
            {editing && !editing.id && <TargetForm initial={editing.form} saving={saving} onSave={f => { void save(f) }} onCancel={() => setEditing(null)} />}
            {data.targets.length === 0 && !editing && <p className="text-[13px] text-muted-foreground">{t('rbi.noTargets')}</p>}
            <ul className="flex flex-col divide-y divide-border">
              {data.targets.map(tg => (
                <li key={tg.id} className="flex flex-col gap-2 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{tg.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">{tg.key}</span>
                    <span className="font-mono text-xs">{tg.url}</span>
                    <UiSwitch modelValue={tg.enabled} onUpdateModelValue={v => { void toggle(tg, v) }} ariaLabel={t(A + 'enableTarget', { name: tg.name })} />
                    <UiBadge tone={tg.private_ip ? 'neutral' : 'warning'} tint size={18}>{tg.private_ip ? t(A + 'privateIp') : t(A + 'publicIp')}</UiBadge>
                    <UiBadge tone={tg.mode === 'mirror' ? 'primary' : 'neutral'} tint size={18}>{t(A + 'mode')}: {t(`rbi.mode.${tg.mode ?? 'pixel'}`)}</UiBadge>
                    <span className="ml-auto flex gap-1.5">
                      <UiButton variant="outline" size="xs" onClick={() => setEditing({ id: tg.id, form: toForm(tg) })}>{t(A + 'editTarget')}</UiButton>
                      <UiButton variant="ghost" size="xs" icon="trash" onClick={() => { void remove(tg) }}>{t(A + 'delete')}</UiButton>
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {rbiPolicyKeys(tg.policy).map(k => <UiBadge key={k} tone="neutral" tint size={18}>{t(k)}</UiBadge>)}
                    <UiBadge tone="neutral" tint size={18}>{tg.policy.idle_minutes}m / {tg.policy.max_hours}h · {tg.cpu}cpu / {tg.memory_mb}MB</UiBadge>
                    <UiBadge tone="neutral" tint size={18}>{t(A + 'allowedGroups')} {tg.allowed_group_ids.length} · {t(A + 'allowedUsers')} {tg.allowed_user_ids.length}</UiBadge>
                    {tg.egress_forced && <UiBadge tone="warning" tint size={18}>{t(A + 'forcedBadge')}</UiBadge>}
                  </div>
                  {/* 출구(허용 목적지) — 이름은 저장 때 고정한 IP 와 함께 */}
                  <p className="font-mono text-xs text-muted-foreground" data-testid={`rbi-egress-${tg.key}`}>
                    {t(A + 'egress')}: {(tg.egress ?? []).map(e => (e.host === e.ip ? `${e.ip}:${e.port}` : `${e.host} → ${e.ip}:${e.port}`)).join(', ') || '—'}
                  </p>
                  {editing?.id === tg.id && <TargetForm initial={editing.form} saving={saving} onSave={f => { void save(f) }} onCancel={() => setEditing(null)} />}
                </li>
              ))}
            </ul>
          </div>
        )}
      </SettingsCard>

      <SettingsCard title={t(A + 'sessionsCard')} description={t(A + 'sessionsDesc')} footer={false}>
        {!data ? <UiSkeleton preset="list" rows={1} /> : data.sessions.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t(A + 'noSessions')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border text-[13px]">
            {data.sessions.map(s => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                <UiBadge tone={s.status === 'running' ? 'success' : 'warning'} tint size={18}>{t(`rbi.status.${s.status}`)}</UiBadge>
                <span className="font-mono text-xs">{s.id.slice(0, 8)}</span>
                <span>{s.target_name}</span>
                <span className="font-mono text-xs text-muted-foreground">{t(A + 'user')} {s.user_id}</span>
                <span className="text-muted-foreground">{t(A + 'started')} {fmtRbiTime(s.started_at)} · {t(A + 'lastSeen')} {fmtRbiTime(s.last_seen_at)}</span>
                <UiButton variant="outline" size="xs" className="ml-auto" onClick={() => { void forceStop(s) }}>{t(A + 'forceStop')}</UiButton>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
    </AdminPageShell>
  )
}
