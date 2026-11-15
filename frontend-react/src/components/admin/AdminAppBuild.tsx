/**
 * 앱 빌드. 관리 › 설정 › 앱 빌드.
 *  ① 배포 채널 — 서버 주소(읽기 전용 점선 + [복사]) · 앱 이름(글자). 카드 푸터 저장.
 *  ② 빌드 — 행(min 52): Android · Windows(데스크톱) = "MM/DD · 크기" + [내려받기], iOS = "지원 안 함" 배지,
 *     "새 빌드 만들기" = 설명 + [빌드 시작](POST /api/admin/apps/build, 확인 모달 → 5초 간격 상태 폴링).
 *     빌더 미구성이면 [빌드 시작] 비활성 + 사유. 루트는 Fragment(오류면 오류 칸 하나).
 *
 * @example <AdminAppBuild />
 */
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { RUN_STATUS_KEY, RUN_STATUS_TONE } from '~/composables/useAdminOps'
import { SettingsCard } from '~/components/settings/SettingsCard'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiInput } from '~/components/ui/Input'
import { UiButton } from '~/components/ui/Button'
import { UiBadge } from '~/components/ui/Badge'

interface Cfg { target_url: string; app_name: string; build_status: string; build_finished: string; build_error: string; builder_ready: boolean }
interface Artifact { platform: 'android' | 'desktop'; available: boolean; size_bytes: number; modified_at: string | null; download_url: string }

/** 바이트 → "12 MB"(반올림) */
export function fmtAppSize(n: number) {
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${Math.round(v)} ${u[i]}`
}
/** ISO → "MM/DD"(시안 "10/12" — toLocaleDateString(ko) 는 꼬리 점이 붙는다). 파싱 실패 '' */
export function fmtDay(s: string | null) {
  if (!s) return ''
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}
const KIND: Record<string, string> = { android: 'APK', desktop: 'EXE' }

export function AdminAppBuild() {
  const { t } = useI18n()
  const [cfg, setCfg] = useState<Cfg>({ target_url: '', app_name: 'Just Workspace', build_status: 'idle', build_finished: '', build_error: '', builder_ready: false })
  const [origName, setOrigName] = useState('')
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [building, setBuilding] = useState(false)
  const poll = useRef<ReturnType<typeof setInterval> | null>(null)

  async function loadArtifacts() {
    try { setArtifacts((await $fetch<{ artifacts: Artifact[] }>('/api/admin/apps/artifacts', { credentials: 'include' })).artifacts || []) }
    catch { setArtifacts([]) }
  }
  async function load() {
    setLoading(true); setLoadError(false)
    try {
      const c = await $fetch<Cfg>('/api/admin/apps/config', { credentials: 'include' })
      setCfg(prev => ({ ...prev, ...c }))
      setOrigName(c.app_name)
      const b = c.build_status === 'building'
      setBuilding(b)
      if (b) startPoll()
      await loadArtifacts()
    } catch { setLoadError(true) } finally { setLoading(false) }
  }
  useEffect(() => {
    void load()
    return () => { if (poll.current) clearInterval(poll.current) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const changes = Number(cfg.app_name !== origName)
  async function save() {
    setSaving(true)
    try {
      await $fetch('/api/admin/apps/config', { method: 'PUT', credentials: 'include', body: { app_name: cfg.app_name } })
      setOrigName(cfg.app_name)
      setSaved(true); setTimeout(() => { setSaved(false) }, 2000)
    } catch (e: any) { addToast('error', t('adminParts.saveFailed', { error: e?.data?.detail || e?.message || e })) }
    finally { setSaving(false) }
  }

  function startPoll() {
    if (poll.current) clearInterval(poll.current)
    poll.current = setInterval(async () => {
      try {
        const s = await $fetch<{ status: string; finished: string; error: string }>('/api/admin/apps/build', { credentials: 'include' })
        setCfg(c => ({ ...c, build_status: s.status, build_finished: s.finished, build_error: s.error }))
        if (s.status !== 'building') {
          setBuilding(false); if (poll.current) clearInterval(poll.current); poll.current = null
          void loadArtifacts()
        }
      } catch {}
    }, 5000)
  }
  async function build() {
    if (!await confirmBox(t('adminParts.appBuild.buildConfirmBody'), { title: t('adminParts.appBuild.buildConfirmTitle'), confirmLabel: t('adminParts.appBuild.buildStart') })) return
    setBuilding(true); setCfg(c => ({ ...c, build_status: 'building', build_error: '' }))
    try {
      await $fetch('/api/admin/apps/build', { method: 'POST', credentials: 'include' })
      startPoll()
    } catch (e: any) {
      setBuilding(false); setCfg(c => ({ ...c, build_status: 'idle' }))
      addToast('error', t('adminParts.appBuild.buildStartFailed', { error: e?.data?.detail || e?.message || e }))
    }
  }

  const NAME: Record<string, string> = { android: 'Android', desktop: t('adminParts.appBuild.desktop') }
  function artDesc(a: Artifact) {
    return a.available ? `${fmtDay(a.modified_at)} · ${KIND[a.platform]} ${fmtAppSize(a.size_bytes)}` : t('adminParts.appBuild.notUploaded')
  }

  if (loadError) return <UiErrorTile placement="panel" title={t('adminParts.appBuild.loadError')} onRetry={load} />

  return (
    <>
      {/* ① 배포 채널 */}
      <SettingsCard
        title={t('adminParts.appBuild.channelTitle')}
        description={t('adminParts.appBuild.channelDesc')}
        changes={changes}
        saving={saving}
        saved={saved}
        onSave={save}
        onReset={() => setCfg(c => ({ ...c, app_name: origName }))}
      >
        {loading ? (
          <UiSkeleton preset="text" rows={2} />
        ) : (
          <form className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); void save() }}>
            {/* 서버 주소 = 읽기 전용 UiInput(복사 버튼 내장) */}
            <UiInput modelValue={cfg.target_url} readonly mono label={t('adminParts.appBuild.serverUrl')} />
            <UiInput modelValue={cfg.app_name} onUpdateModelValue={v => setCfg(c => ({ ...c, app_name: v }))} label={t('adminParts.appBuild.appName')} />
            <button type="submit" className="hidden" />
          </form>
        )}
      </SettingsCard>

      {/* ② 빌드 */}
      <SettingsCard title={t('adminParts.appBuild.buildsTitle')} description={t('adminParts.appBuild.buildsDesc')} flush>
        {loading ? (
          <UiSkeleton preset="list" rows={3} />
        ) : (
          <>
            {artifacts.map(a => (
              <div key={a.platform} className="flex min-h-[52px] items-center gap-3 border-t border-border px-5 py-2 text-[13px]">
                <span className="min-w-0 flex-1">
                  <b className="block font-semibold text-foreground">{NAME[a.platform]}</b>
                  <span className="block truncate text-xs text-muted-foreground">{artDesc(a)}</span>
                </span>
                {a.available && <UiButton as="a" href={a.download_url} variant="outline" size="xs" className="font-semibold">{t('adminParts.appBuild.download')}</UiButton>}
              </div>
            ))}
            <div className="flex min-h-[52px] items-center gap-3 border-t border-border px-5 py-2 text-[13px]">
              <span className="min-w-0 flex-1">
                <b className="block font-semibold text-foreground">iOS</b>
                <span className="block text-xs text-muted-foreground">{t('adminParts.appBuild.iosDesc')}</span>
              </span>
              <UiBadge tone="neutral" tint>{t('adminParts.appBuild.unsupported')}</UiBadge>
            </div>
            <div className="flex min-h-[52px] flex-wrap items-center gap-3 border-t border-border px-5 py-2 text-[13px]">
              <span className="min-w-0 flex-1">
                <b className="block font-semibold text-foreground">{t('adminParts.appBuild.newBuild')}</b>
                <span className="block text-xs text-muted-foreground">
                  {cfg.builder_ready ? t('adminParts.appBuild.newBuildDesc') : t('adminParts.appBuild.builderNotReady')}
                  {cfg.build_finished && !building && <> · {t('adminParts.appBuild.lastBuilt', { time: fmtDay(cfg.build_finished) })}</>}
                </span>
              </span>
              {cfg.build_status !== 'idle' && (
                <UiBadge tone={RUN_STATUS_TONE[cfg.build_status] ?? 'neutral'} tint>{RUN_STATUS_KEY[cfg.build_status] ? t(RUN_STATUS_KEY[cfg.build_status]) : cfg.build_status}</UiBadge>
              )}
              <UiButton
                variant="outline"
                size="xs"
                className="font-semibold"
                disabled={building || !cfg.builder_ready}
                title={cfg.builder_ready ? undefined : t('adminParts.appBuild.builderNotReadyDetail')}
                onClick={build}
              >{building ? t('adminParts.appBuild.building') : t('adminParts.appBuild.buildStart')}</UiButton>
              {cfg.build_error && <p role="alert" className="w-full break-all font-mono text-xs text-danger">{cfg.build_error}</p>}
            </div>
          </>
        )}
      </SettingsCard>
    </>
  )
}

export default AdminAppBuild
