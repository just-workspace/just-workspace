// 설정 › AI 연동(MCP) — 기본 화면 · 토큰 만들기·한 번 보기·연결 해제 확인·관리자 쓰기 막음·빈·실패·모바일 390.
//  ① 커넥터 주소: 읽기 전용(우선 연결 대상) · 쓰기 포함(별도 추가 연결, 관리자가 차단하면 "조직에서 막음").
//     주소는 서버가 반환한 값 그대로(전용 포트 https://mcp.<도메인>:8443/… — CP 통제, 3차 결정).
//  ② 연결된 앱: OAuth(claude.ai 등) + 사용된 개인 토큰. [연결 해제] → 해당 앱의 대기 쓰기 요청은 '연결 해제됨' 사유로 거부.
//  ③ 개인 토큰(wsmcp_…): 이름 · 만료(30일·90일·1년, 무기한 없음) · 쓰기 권한(관리자 허용 시). 생성 직후 1회만 표시.
// API: /api/ai-connect/info · /apps · DELETE /apps/{key} · /tokens(GET·POST) · DELETE /tokens/{id}.
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { $fetch } from '~/lib/api'
import { navigateTo } from '~/lib/router'
import { writeClipboard } from '~/lib/clipboard'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useIsMobile } from '~/composables/useIsMobile'
import { addToast } from '~/composables/useToast'
import { NuxtLink } from '~/components/NuxtLink'
import { SettingsHeader } from '~/components/settings/SettingsHeader'
import { SettingsCard } from '~/components/settings/SettingsCard'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiIcon } from '~/components/ui/Icon'
import { UiInput } from '~/components/ui/Input'
import { UiMenu, type UiMenuItem } from '~/components/ui/Menu'
import { UiModal } from '~/components/ui/Modal'
import { UiSelect } from '~/components/ui/Select'
import { UiSkeleton } from '~/components/ui/Skeleton'

interface Info { read_url: string; write_url: string; write_enabled: boolean; token_prefix?: string; token_expiry_days?: number[] }
export interface McpApp {
  key: string
  kind: 'oauth' | 'personal_token'
  name: string
  token_name: string | null
  can_write: boolean
  connected_at: string | null
  last_used_at: string | null
  pending: number
}
interface Token { id: string; name: string; created_at: string; last_used_at: string | null; expires_at: string | null; revoked: boolean; hint?: string | null; can_write?: boolean }

const detailOf = (e: unknown) => {
  const d = (e as { data?: { detail?: unknown } } | null)?.data?.detail
  return typeof d === 'string' ? d : (d as { message?: string } | undefined)?.message
}
const statusOf = (e: unknown) => {
  const x = e as { statusCode?: number; status?: number; response?: { status?: number } } | null
  return x?.statusCode ?? x?.status ?? x?.response?.status
}
const pad = (n: number) => String(n).padStart(2, '0')
function md(s: string | null) { if (!s) return '—'; const d = new Date(s); return Number.isNaN(d.getTime()) ? '—' : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function mdhm(s: string | null) { if (!s) return '—'; const d = new Date(s); return Number.isNaN(d.getTime()) ? '—' : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` }
function ymd(s: string | null) { if (!s) return '—'; const d = new Date(s); return Number.isNaN(d.getTime()) ? '—' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }

export default function Page() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: `${t('settings.mcp.title')} | ${appName}` })
  const isMobile = useIsMobile()

  const [info, setInfo] = useState<Info | null>(null)
  const [infoError, setInfoError] = useState(false)
  const [apps, setApps] = useState<McpApp[] | null>(null)
  const [appsError, setAppsError] = useState<string | null>(null)
  const [tokens, setTokens] = useState<Token[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({ name: '', days: '90', write: false })
  const [saving, setSaving] = useState(false)
  const [issued, setIssued] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<null | { kind: 'app'; app: McpApp } | { kind: 'token'; token: Token; pending: number }>(null)
  const [busy, setBusy] = useState(false)

  async function loadInfo() {
    try { setInfo(await $fetch<Info>('/api/ai-connect/info', { credentials: 'include' })); setInfoError(false) } catch { setInfoError(true) }
  }
  async function loadApps() {
    setAppsError(null)
    try { setApps((await $fetch<{ apps: McpApp[] }>('/api/ai-connect/apps', { credentials: 'include' })).apps || []) } catch (e) {
      setApps(null)
      const d = new Date()
      setAppsError(t('settings.mcp.appsErrorDetail', { status: String(statusOf(e) ?? '—'), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }))
    }
  }
  async function loadTokens() {
    try { setTokens(((await $fetch<{ tokens: Token[] }>('/api/ai-connect/tokens', { credentials: 'include' })).tokens || []).filter(x => !x.revoked)) } catch { setTokens([]) }
  }
  const mounted = useRef(false)
  useEffect(() => {
    if (mounted.current) return
    mounted.current = true
    void loadInfo(); void loadApps(); void loadTokens()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function copy(text: string) {
    try { await writeClipboard(text); addToast('success', t('settings.mcp.copied')) } catch { addToast('error', t('ai.toast.copyFailed')) }
  }

  async function createToken() {
    const name = draft.name.trim()
    if (!name) { addToast('warning', t('settings.apps.tokenNameRequired')); return }
    setSaving(true)
    try {
      const r = await $fetch<{ token: string }>('/api/ai-connect/tokens', {
        method: 'POST', credentials: 'include',
        body: { name, expires_days: Number(draft.days), scope: draft.write && info?.write_enabled ? 'mcp:read mcp:write' : 'mcp:read' },
      })
      setCreating(false)
      setDraft({ name: '', days: '90', write: false })
      setIssued(r.token)
      await loadTokens()
    } catch (e) { addToast('error', detailOf(e) || t('settings.apps.tokenCreateFailed')) } finally { setSaving(false) }
  }

  async function doConfirm() {
    if (!confirm) return
    setBusy(true)
    try {
      const r = confirm.kind === 'app'
        ? await $fetch<{ rejected?: number }>(`/api/ai-connect/apps/${encodeURIComponent(confirm.app.key)}`, { method: 'DELETE', credentials: 'include' })
        : await $fetch<{ rejected?: number }>(`/api/ai-connect/tokens/${encodeURIComponent(confirm.token.id)}`, { method: 'DELETE', credentials: 'include' })
      addToast('success', r?.rejected ? t('settings.mcp.disconnectedWithRejected', { n: String(r.rejected) }) : t('settings.mcp.disconnected'))
      setConfirm(null)
      await Promise.all([loadApps(), loadTokens()])
    } catch (e) { addToast('error', detailOf(e) || t('settings.apps.disconnectFailed')) } finally { setBusy(false) }
  }

  const expOptions = (info?.token_expiry_days?.length ? info.token_expiry_days : [30, 90, 365]).map(d => ({
    value: String(d), label: d === 365 ? t('settings.mcp.exp1y') : t('settings.mcp.expDays', { n: String(d) }),
  }))
  const prefix = info?.token_prefix || 'wsmcp_'
  const permBadge = (w: boolean) => <UiBadge tone={w ? 'warning' : 'neutral'} tint size={18}>{w ? t('settings.mcp.permRW') : t('settings.mcp.permR')}</UiBadge>
  const kindLabel = (a: McpApp) => (a.kind === 'oauth' ? t('settings.mcp.kindOauth') : t('settings.mcp.kindToken', { name: a.token_name || a.name }))

  return (
    <>
      <SettingsHeader title={t('settings.mcp.title')} subtitle={t('settings.mcp.subtitle')} />

      {/* ① 커넥터 주소 */}
      <SettingsCard title={t('settings.mcp.urlsTitle')} aria-label={t('settings.mcp.urlsTitle')}>
        {!info && !infoError ? <UiSkeleton preset="text" />
          : infoError ? <UiErrorTile placement="card" title={t('settings.mcp.infoError')} onRetry={() => void loadInfo()} />
            : info && (
              <div className="flex flex-col gap-5">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-foreground">{t('settings.mcp.read')}</span>
                    <UiBadge tone="neutral" tint size={18}>{t('settings.mcp.readFirst')}</UiBadge>
                  </div>
                  <UiInput aria-label={t('settings.mcp.readUrlLabel')} modelValue={info.read_url} readonly mono copyable size={isMobile ? 'lg' : 'md'} />
                  <span className="text-xs text-muted-foreground">{t('settings.mcp.readDesc')}</span>
                </div>
                <section aria-label={t('settings.mcp.writeSection')} className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-foreground">{t('settings.mcp.write')}</span>
                    {info.write_enabled
                      ? <UiBadge tone="warning" tint size={18}>{t('settings.mcp.writeSeparate')}</UiBadge>
                      : <UiBadge tone="neutral" tint size={18}>{t('settings.mcp.writeBlocked')}</UiBadge>}
                  </div>
                  {info.write_enabled ? (
                    <>
                      <UiInput aria-label={t('settings.mcp.writeUrlLabel')} modelValue={info.write_url} readonly mono copyable size={isMobile ? 'lg' : 'md'} />
                      <div role="note" className="flex gap-2 rounded-lg border border-border bg-secondary px-3 py-2.5 text-[12.5px] leading-[19px] text-foreground">
                        <UiIcon name="shield" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span>
                          {t('settings.mcp.writeNotePre')}
                          <NuxtLink to="/approvals" className="text-primary hover:underline">{t('settings.mcp.approvals')}</NuxtLink>
                          {t('settings.mcp.writeNotePost')}
                        </span>
                      </div>
                    </>
                  ) : (
                    <p className="m-0 text-[13px] leading-5 text-muted-foreground">{t('settings.mcp.writeBlockedDesc')}</p>
                  )}
                </section>
              </div>
            )}
      </SettingsCard>

      {/* ② 연결된 앱 */}
      <SettingsCard
        title={apps ? `${t('settings.mcp.appsTitle')} ${apps.length}` : t('settings.mcp.appsTitle')}
        aria-label={t('settings.mcp.appsTitle')}
        flush
      >
        {apps === null && !appsError
          ? <UiSkeleton preset="list" rows={2} className="border-t border-border" />
          : appsError
            ? <div className="border-t border-border p-4"><UiErrorTile placement="card" title={t('settings.mcp.appsError')} detail={appsError} retryLabel={t('common.retry')} onRetry={() => void loadApps()} /></div>
            : !apps?.length
              ? (
                <div className="border-t border-border">
                  <UiEmptyState
                    variant="panel"
                    icon="plug"
                    title={t('settings.mcp.noApps')}
                    description={t('settings.mcp.noAppsDesc')}
                    actionLabel={info ? t('settings.mcp.copyUrl') : undefined}
                    onAction={() => { if (info) void copy(info.read_url) }}
                  />
                </div>
              )
              : (
                <ul className="m-0 list-none border-t border-border p-0">
                  {apps.map((a) => {
                    const menu: UiMenuItem[] = [
                      ...(a.can_write ? [{ key: 'log', label: t('settings.mcp.recentLog'), icon: 'list' }] : []),
                      { key: 'disconnect', label: t('settings.mcp.disconnect'), icon: 'log-out', danger: true, separated: a.can_write },
                    ]
                    return (
                      <li key={a.key} className="flex min-h-14 items-center gap-3 border-b border-border px-5 py-2.5 last:border-b-0">
                        <UiIcon name={a.kind === 'oauth' ? 'globe' : 'terminal'} className="hidden h-5 w-5 shrink-0 text-muted-foreground md:block" />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="flex min-w-0 items-center gap-2 text-[13.5px] font-semibold text-foreground">
                            <span className="truncate">{a.name}</span>
                            <span className="hidden md:inline-flex">{permBadge(a.can_write)}</span>
                          </span>
                          <span className="hidden text-xs text-muted-foreground md:block">
                            {kindLabel(a)} · {t('settings.mcp.connectedSince')} <span className="font-mono">{md(a.connected_at)}</span> · {t('settings.mcp.lastUsed')} <span className="font-mono">{mdhm(a.last_used_at)}</span>
                          </span>
                          <span className="text-xs text-muted-foreground md:hidden">
                            {a.can_write ? t('settings.mcp.permRW') : t('settings.mcp.permR')} · {a.kind === 'oauth' ? <span className="font-mono">{mdhm(a.last_used_at)}</span> : t('settings.mcp.kindTokenShort', { name: a.token_name || a.name })}
                          </span>
                        </span>
                        {isMobile ? (
                          <UiMenu items={menu} label={t('settings.mcp.appMenu', { name: a.name })} title={a.name} triggerIcon="more-vertical" triggerSize="lg" className="text-muted-foreground"
                            onSelect={(k: string) => (k === 'log' ? void navigateTo('/approvals') : setConfirm({ kind: 'app', app: a }))} />
                        ) : (
                          <>
                            {a.can_write && <NuxtLink to="/approvals" className="shrink-0 text-xs text-primary hover:underline">{t('settings.mcp.recentLog')}</NuxtLink>}
                            <UiButton variant="ghost" size="xs" onClick={() => setConfirm({ kind: 'app', app: a })}>{t('settings.mcp.disconnect')}</UiButton>
                          </>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
      </SettingsCard>

      {/* ③ 개인 토큰 */}
      <SettingsCard
        title={t('settings.mcp.tokensTitle')}
        description={t('settings.mcp.tokensDesc')}
        aria-label={t('settings.mcp.tokensTitle')}
        flush
        header={<UiButton variant="outline" size="sm" icon="plus" className="shrink-0" onClick={() => setCreating(true)}>{t('settings.mcp.newToken')}</UiButton>}
      >
        {tokens === null ? <UiSkeleton preset="list" rows={1} className="border-t border-border" />
          : !tokens.length ? <UiEmptyState variant="inline" inset title={t('settings.mcp.noTokens')} className="border-t border-border" />
            : (
              <ul className="m-0 list-none border-t border-border p-0">
                {tokens.map(tk => (
                  <li key={tk.id} className="flex min-h-14 items-center gap-3 border-b border-border px-5 py-2.5 last:border-b-0">
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-2 text-[13.5px] font-semibold text-foreground"><span className="truncate">{tk.name}</span>{permBadge(!!tk.can_write)}</span>
                      <span className="text-xs text-muted-foreground">
                        <span className="font-mono">{prefix}…{tk.hint || ''}</span> · {t('settings.mcp.expires')} <span className="font-mono">{tk.expires_at ? ymd(tk.expires_at) : t('settings.mcp.noExpiry')}</span>
                      </span>
                    </span>
                    <UiButton variant="ghost" size="xs" onClick={() => setConfirm({ kind: 'token', token: tk, pending: apps?.find(a => a.key === `pat:${tk.id}`)?.pending || 0 })}>{t('settings.apps.revoke')}</UiButton>
                  </li>
                ))}
              </ul>
            )}
      </SettingsCard>

      {/* 토큰 만들기 */}
      {creating && (
        <UiModal
          title={t('settings.mcp.createTitle')}
          size="440"
          onClose={() => setCreating(false)}
          footer={(
            <>
              <UiButton variant="ghost" size="sm" onClick={() => setCreating(false)}>{t('ai.memory.cancel')}</UiButton>
              <UiButton size="sm" disabled={saving || !draft.name.trim()} onClick={() => void createToken()}>{t('settings.mcp.create')}</UiButton>
            </>
          )}
        >
          <UiInput label={t('settings.mcp.tokenName')} modelValue={draft.name} onUpdateModelValue={v => setDraft(d => ({ ...d, name: v }))} hint={t('settings.mcp.tokenNameHint')} placeholder={t('settings.apps.tokenNamePlaceholder')} data-autofocus />
          <UiSelect label={t('settings.mcp.expiry')} modelValue={draft.days} onUpdateModelValue={v => setDraft(d => ({ ...d, days: String(v ?? '90') }))} options={expOptions} hint={t('settings.mcp.expiryHint')} />
          {info?.write_enabled && (
            <UiCheckbox label={t('settings.mcp.withWrite')} description={t('settings.mcp.withWriteDesc')} modelValue={draft.write} onUpdateModelValue={v => setDraft(d => ({ ...d, write: v }))} />
          )}
        </UiModal>
      )}

      {/* 생성 직후 1회 */}
      {issued && (
        <UiModal title={t('settings.mcp.issuedTitle')} size="480" persistent onClose={() => setIssued(null)}
          footer={<UiButton size="sm" onClick={() => setIssued(null)}>{t('settings.mcp.copiedDone')}</UiButton>}>
          <p className="m-0 text-[13px] leading-5 text-muted-foreground">{t('settings.mcp.issuedDesc')}</p>
          <UiInput aria-label={t('settings.mcp.tokenLabel')} modelValue={issued} readonly mono copyable />
        </UiModal>
      )}

      {/* 연결 해제 확인 */}
      {confirm && (
        <UiModal
          confirm
          danger
          ariaLabel={confirm.kind === 'app' ? t('settings.mcp.confirmTitle', { name: confirm.app.name }) : t('settings.apps.revokeTokenTitle')}
          onClose={() => setConfirm(null)}
          footer={(
            <>
              <UiButton variant="ghost" size="sm" onClick={() => setConfirm(null)}>{t('ai.memory.cancel')}</UiButton>
              <UiButton variant="danger" size="sm" disabled={busy} onClick={() => void doConfirm()}>{confirm.kind === 'app' ? t('settings.mcp.confirmDo') : t('settings.apps.revoke')}</UiButton>
            </>
          )}
        >
          <h2 className="m-0 text-base font-semibold text-foreground">{confirm.kind === 'app' ? t('settings.mcp.confirmTitle', { name: confirm.app.name }) : t('settings.apps.revokeTokenTitle')}</h2>
          <p className="m-0 text-[13px] leading-5 text-muted-foreground">
            {confirm.kind === 'app'
              ? (confirm.app.kind === 'oauth' ? t('settings.mcp.confirmBodyOauth') : t('settings.mcp.confirmBodyToken'))
              : t('settings.apps.revokeTokenConfirm')}
            {(confirm.kind === 'app' ? confirm.app.pending : confirm.pending) > 0 && (
              <>
                {' '}{t('settings.mcp.confirmPendingPre')}<span className="font-mono">{confirm.kind === 'app' ? confirm.app.pending : confirm.pending}</span>{t('settings.mcp.confirmPendingPost')}
              </>
            )}
          </p>
        </UiModal>
      )}
    </>
  )
}
