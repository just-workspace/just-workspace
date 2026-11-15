/**
 * 백업 카드 — Vue components/admin/AdminBackup.vue(시안 AdminPage variant=backup · Review11 D2d). 관리 › 저장소·백업.
 * 맨 위 행 = "자동 백업" + "매일 HH:00 · 대상" · 시각(한국 시간으로 고르고 UTC 로 저장) · 스위치(답변서 B5),
 * 그 아래 2열 칸: 대상(서버 경로, 읽기 전용 mono) · 보관(선택).
 * 기록 행(min 52: 시각 600 + "결과 · 크기" 12 muted, 오른쪽 상태 틴트 배지 + ⋮ 받기·삭제), 최근 10개.
 * 푸터 = [지금 백업](확인 모달 → POST /api/admin/backup/run, 3초 간격 최대 6번 다시 읽기) [되돌리기] [저장].
 * 스위치·시각·보관은 카드 저장([되돌리기][저장])으로 반영.
 *
 * @example <AdminBackup id="backup" className="scroll-mt-4" />
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { refreshAdminOps, RUN_STATUS_KEY, RUN_STATUS_TONE } from '~/composables/useAdminOps'
import { SettingsCard } from '~/components/settings/SettingsCard'
import { UiSwitch } from '~/components/ui/Switch'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiInput } from '~/components/ui/Input'
import { UiSelect } from '~/components/ui/Select'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiBadge } from '~/components/ui/Badge'
import { UiMenu } from '~/components/ui/Menu'
import { UiButton } from '~/components/ui/Button'

interface Backup { id: string; created_at: string; status: string; kind: string; components: Record<string, string>; size_bytes: number; error: string }
interface Sched { enabled: boolean; hour_utc: number | string; retention_days: number | string; target?: string }

/** 바이트 → "1.5 MB"(0 이면 빈 글자) */
export function fmtBackupSize(n: number) {
  if (!n) return ''
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(1)} ${u[i]}`
}
/** UTC 시 → 한국 시(문자열 "0"~"23") */
export function kstFromUtc(hourUtc: number | string) { return String(((Number(hourUtc) || 0) + 9) % 24) }
/** 한국 시 → UTC 시 */
export function utcFromKst(kst: number | string) { return (Number(kst) + 24 - 9) % 24 }

const SCHED_KEYS = ['enabled', 'hour_utc', 'retention_days'] as const
const hourOptions = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }))

export interface AdminBackupProps {
  /** 루트 카드 id(딥링크 #backup) */
  id?: string
  /** 루트 카드에 더할 클래스 */
  className?: string
}

export function AdminBackup({ id, className }: AdminBackupProps) {
  const { t, locale } = useI18n()
  const [backups, setBackups] = useState<Backup[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [running, setRunning] = useState(false)
  const [sched, setSched] = useState<Sched>({ enabled: false, hour_utc: 18, retention_days: 30 })
  const [schedOrig, setSchedOrig] = useState<Sched>({ enabled: false, hour_utc: 18, retention_days: 30 })
  const [target, setTarget] = useState('')
  const [schedSaving, setSchedSaving] = useState(false)
  const [schedSaved, setSchedSaved] = useState(false)

  function fmtWhen(iso: string) {
    return new Date(iso).toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  }
  function compSummary(c: Record<string, string>) {
    const e = Object.entries(c || {})
    const fail = e.filter(([, v]) => !v.startsWith('ok') && !v.startsWith('skip')).map(([k]) => k)
    return fail.length ? t('adminParts.backup.failedComponents', { list: fail.join(', ') }) : ''
  }
  function rowDesc(b: Backup) {
    const parts = [RUN_STATUS_KEY[b.status] ? t(RUN_STATUS_KEY[b.status]) : b.status]
    const fail = b.error || compSummary(b.components)
    if (fail) parts.push(fail)
    if (b.size_bytes) parts.push(fmtBackupSize(b.size_bytes))
    if (b.kind === 'manual') parts.push(t('adminParts.backup.kindManual'))
    return parts.join(' · ')
  }

  /** 읽은 기록 목록을 돌려준다(지금 백업 폴링이 "지금" 값을 봐야 해서) */
  async function load(): Promise<Backup[]> {
    setLoading(true); setLoadError(false)
    try {
      const [b, s] = await Promise.all([
        $fetch<{ backups: Backup[] }>('/api/admin/backup', { credentials: 'include' }),
        $fetch<Sched>('/api/admin/backup/schedule/config', { credentials: 'include' }),
      ])
      const list = [...(b.backups || [])].sort((x, y) => (y.created_at || '').localeCompare(x.created_at || ''))
      setBackups(list)
      const next = { enabled: s.enabled, hour_utc: s.hour_utc, retention_days: s.retention_days }
      setSched(next)
      setTarget(s.target || '')
      setSchedOrig({ ...next })
      return list
    } catch { setLoadError(true); return [] } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  async function runNow() {
    if (!await confirmBox(t('adminParts.backup.runConfirmBody'), { title: t('adminParts.backup.runConfirmTitle'), confirmLabel: t('adminParts.backup.runNow') })) return
    setRunning(true)
    try {
      await $fetch('/api/admin/backup/run', { method: 'POST', credentials: 'include' })
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 3000))
        const list = await load()
        if (!list.some(x => x.status === 'running')) break
      }
      void refreshAdminOps()
    } catch (e: any) {
      addToast('error', t('adminParts.backup.runFailed', { error: e?.data?.detail || e?.message || e }))
    } finally { setRunning(false) }
  }

  async function remove(b: Backup) {
    if (!await confirmBox(t('adminParts.backup.deleteConfirm', { when: fmtWhen(b.created_at) }), { title: t('adminParts.backup.deleteTitle'), confirmLabel: t('common.delete'), danger: true })) return
    try {
      await $fetch(`/api/admin/backup/${b.id}`, { method: 'DELETE', credentials: 'include' })
      setBackups(list => list.filter(x => x.id !== b.id))
      void refreshAdminOps()
    } catch (e: any) { addToast('error', t('adminParts.deleteFailed', { error: e?.data?.detail || e?.message || e })) }
  }
  function download(bid: string) { window.open(`/api/admin/backup/${bid}/download`, '_blank') }
  function onMenu(b: Backup, key: string) { if (key === 'download') download(b.id); else if (key === 'delete') void remove(b) }

  const schedChanges = SCHED_KEYS.filter(k => String(sched[k]) !== String(schedOrig[k])).length
  function resetSched() { setSched({ ...schedOrig }) }
  async function saveSched() {
    setSchedSaving(true)
    try {
      await $fetch('/api/admin/backup/schedule/config', {
        method: 'PUT', credentials: 'include',
        body: { enabled: sched.enabled, hour_utc: Number(sched.hour_utc), retention_days: Number(sched.retention_days) },
      })
      setSchedOrig({ ...sched })
      setSchedSaved(true); setTimeout(() => { setSchedSaved(false) }, 2000)
    } catch (e: any) { addToast('error', t('adminParts.saveFailed', { error: e?.data?.detail || e?.message || e })) }
    finally { setSchedSaving(false) }
  }

  // 시각은 한국 시간으로 고르고 UTC 로 저장한다
  const kstHour = kstFromUtc(sched.hour_utc)
  const retention = [7, 14, 30, 60, 90, 180, 365].map(d => ({ value: String(d), label: t('adminParts.backup.keepDays', { n: d }) }))
  if (!retention.some(o => o.value === String(sched.retention_days))) retention.push({ value: String(sched.retention_days), label: t('adminParts.backup.keepDays', { n: sched.retention_days }) })
  const desc = sched.enabled
    ? t('adminParts.backup.descOn', { time: `${kstHour.padStart(2, '0')}:00`, target: target || '—' })
    : t('adminParts.backup.descOff')

  return (
    <SettingsCard
      id={id}
      className={className}
      title={t('adminParts.backup.cardTitle')}
      saved={schedSaved}
      flush
    >
      {loading && !backups.length ? (
        <UiSkeleton preset="list" rows={3} className="px-5" />
      ) : loadError ? (
        <UiErrorTile placement="card" title={t('adminParts.backup.loadError')} className="mx-5 mb-4" onRetry={load} />
      ) : (
        <>
          {/* 맨 위 행 — 자동 백업 스위치 · 시각(답변서 B5) */}
          <div className="flex min-h-[52px] flex-wrap items-center gap-3 border-t border-border px-5 py-2 text-[13px]">
            <span className="min-w-0 flex-1">
              <b className="block font-semibold text-foreground">{t('adminParts.backup.title')}</b>
              <span className="block truncate text-xs text-muted-foreground">{desc}</span>
            </span>
            <UiSelect modelValue={kstHour} onUpdateModelValue={v => setSched(s => ({ ...s, hour_utc: utcFromKst(v ?? 0) }))} options={hourOptions} size="sm" className="w-28" aria-label={t('adminParts.backup.time')} disabled={!sched.enabled} />
            <UiSwitch modelValue={sched.enabled} onUpdateModelValue={v => setSched(s => ({ ...s, enabled: v }))} ariaLabel={t('adminParts.backup.scheduleDaily')} />
          </div>
          <div className="grid gap-x-4 gap-y-3.5 border-t border-border px-5 py-4 sm:grid-cols-2">
            <UiInput modelValue={target} readonly mono label={t('adminParts.backup.target')} />
            <UiSelect modelValue={String(sched.retention_days)} onUpdateModelValue={v => setSched(s => ({ ...s, retention_days: Number(v) }))} options={retention} label={t('adminParts.backup.retention')} disabled={!sched.enabled} />
          </div>

          {!backups.length && <UiEmptyState variant="inline" inset title={t('adminParts.backup.empty')} className="border-t border-border" />}
          {backups.slice(0, 10).map(b => (
            <div key={b.id} className="flex min-h-[52px] items-center gap-3 border-t border-border px-5 py-2 text-[13px]">
              <span className="min-w-0 flex-1">
                <b className="block font-mono font-semibold text-foreground">{fmtWhen(b.created_at)}</b>
                <span className="block truncate text-xs text-muted-foreground" title={b.error || JSON.stringify(b.components)}>{rowDesc(b)}</span>
              </span>
              <UiBadge tone={RUN_STATUS_TONE[b.status] ?? 'neutral'} tint>{RUN_STATUS_KEY[b.status] ? t(RUN_STATUS_KEY[b.status]) : b.status}</UiBadge>
              <UiMenu
                triggerIcon="more-vertical"
                label={t('adminParts.backup.rowMenu', { when: fmtWhen(b.created_at) })}
                items={[{ key: 'download', label: t('adminParts.backup.download'), icon: 'download', disabled: b.status === 'running' }, { key: 'delete', label: t('common.delete'), icon: 'trash', danger: true }]}
                onSelect={key => onMenu(b, key)}
              />
            </div>
          ))}

          <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-border px-5 py-3">
            <span className="mr-auto text-xs text-muted-foreground">{schedChanges ? t('settingsCard.changes', { n: schedChanges }) : ''}</span>
            <UiButton variant="outline" size="sm" disabled={running} onClick={runNow}>{running ? t('adminParts.backup.running') : t('adminParts.backup.runNow')}</UiButton>
            <UiButton variant="outline" size="sm" disabled={!schedChanges || schedSaving} onClick={resetSched}>{t('settingsCard.reset')}</UiButton>
            <UiButton size="sm" disabled={!schedChanges || schedSaving} className={schedChanges ? '' : 'opacity-50'} onClick={saveSched}>{schedSaving ? t('settingsCard.saving') : t('settingsCard.save')}</UiButton>
          </div>
        </>
      )}
    </SettingsCard>
  )
}

export default AdminBackup
