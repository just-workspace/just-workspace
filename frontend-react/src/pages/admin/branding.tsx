/**
 * 관리 › 설정 › 브랜딩 — Vue pages/admin/branding.vue. 폼 720, 카드 2장.
 *  ① 기본(맨 위) — 워크스페이스 이름 · 태그라인 · 기본 테마 UiSegment(카드 푸터 저장) /
 *     로고 · 파비콘(이미지 칸 64, 고르는 즉시 올림, 지우기 = 칸의 ✕ 아이콘 버튼).
 *  ② 강조 색 — 색 라디오 32 원 5개 + 직접 입력(#hex)·대비 표시. 푸터 저장.
 *     로그인 배경 = 타일 그리드(4장까지) + "+ 추가" 타일, 타일마다 ✕, 끌어서(또는 Alt+←/→) 순서 — 바로 저장.
 *  강조 색은 본문 바탕 대비 4.5:1 미만(두 테마 모두)이면 고를 수 없다(저장 막음).
 */
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode, type RefObject } from 'react'
import { useI18n } from '~/i18n'
import { useHead } from '~/lib/head'
import { navigateTo } from '~/lib/router'
import { $fetch } from '~/lib/api'
import { cn } from '~/lib/utils'
import { useAuth } from '~/composables/useAuth'
import { useSiteConfig, refetchAppConfig } from '~/composables/useSiteConfig'
import { addToast } from '~/composables/useToast'
import { confirmBox } from '~/composables/useDialog'
import { UiTrans } from '~/components/ui/Trans'
import { brandContrast, contrastBlocked as isBlocked, isHexColor } from '~/components/admin/brandingContrast'
import { AdminPageShell } from '~/components/admin/AdminPageShell'
import { SettingsCard } from '~/components/settings/SettingsCard'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiInput } from '~/components/ui/Input'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiSegment } from '~/components/ui/Segment'
import { moveItem, WALLPAPER_MAX } from '~/components/admin/brandingWallpapers'

interface Branding { site_name: string; primary_color: string; default_theme: string; logo_url: string; favicon_url: string }
type Kind = 'logo' | 'favicon' | 'wallpaper'
const B_DEFAULT: Branding = { site_name: '', primary_color: '#3B82F6', default_theme: 'system', logo_url: '', favicon_url: '' }

function fileName(url: string) { return url ? decodeURIComponent(url.split('?')[0].split('/').pop() || '') : '' }

/**
 * 이미지 칸(점선 64) — 미리보기 44 + 파일 이름 + ✕ 아이콘 버튼(있을 때) + [바꾸기/올리기] + 숨은 파일 입력.
 * 브랜딩 페이지 안에서만 쓴다(로고·파비콘·로그인 배경).
 */
function BrandingImageField({ preview, name, removable, removeLabel, busy, actionLabel, accept, inputRef, onRemove, onPick }: {
  /** 미리보기 칸 전체(44 상자) */
  preview: ReactNode
  /** 파일 이름 글자 */
  name: string
  /** ✕(지우기) 표시 여부 */
  removable: boolean
  /** ✕ 버튼 이름(aria-label·툴팁) */
  removeLabel: string
  /** 올리기·삭제 진행 중 */
  busy: boolean
  /** 오른쪽 버튼 글자 */
  actionLabel: string
  /** 파일 입력 accept */
  accept: string
  inputRef: RefObject<HTMLInputElement | null>
  onRemove: () => void
  onPick: (e: ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <div className="flex h-16 items-center gap-3 rounded-[10px] border border-dashed border-input px-3 text-xs text-muted-foreground">
      {preview}
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {removable && (
        <UiIconButton icon="close" size="sm" label={removeLabel} disabled={busy} onClick={onRemove} />
      )}
      <button type="button" className="relative shrink-0 font-semibold text-primary hover:underline after:absolute after:-inset-3 after:content-[''] disabled:opacity-50" disabled={busy} onClick={() => inputRef.current?.click()}>{actionLabel}</button>
      <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={onPick} />
    </div>
  )
}

export default function AdminBrandingPage() {
  const { t } = useI18n()
  const { appName } = useSiteConfig()
  useHead({ title: t('admin.common.headTitle', { page: t('admin.settings.branding.title'), app: appName }) })
  const { user } = useAuth()
  useEffect(() => { if (user && !user.is_admin) void navigateTo('/') }, [user])

  const [b, setB] = useState<Branding>({ ...B_DEFAULT })
  const [orig, setOrig] = useState<Branding>({ ...B_DEFAULT })
  const [tagline, setTagline] = useState('')
  const [origTagline, setOrigTagline] = useState('')
  const [wallpapers, setWallpapers] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved1, setSaved1] = useState(false)
  const [saved2, setSaved2] = useState(false)
  const [busy, setBusy] = useState<Kind | null>(null)

  function flash(set: (v: boolean) => void) { set(true); setTimeout(() => { set(false) }, 2000) }

  async function load() {
    setLoading(true); setLoadError(false)
    try {
      const [br, ac, wp] = await Promise.all([
        $fetch<Branding>('/api/admin/settings/branding'),
        $fetch<{ values: Record<string, string> }>('/api/admin/settings/appconfig'),
        $fetch<{ wallpapers: string[] }>('/api/admin/settings/appconfig/wallpapers'),
      ])
      const next = { ...B_DEFAULT, ...br }
      setB(next)
      setOrig({ ...next })
      const tl = ac.values?.['brand.tagline'] || ''
      setTagline(tl)
      setOrigTagline(tl)
      setWallpapers(wp.wallpapers || [])
    } catch { setLoadError(true) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  // ── 색 ──
  const SWATCHES = [
    { hex: '#3B82F6', name: t('admin.branding.colorBlue') },
    { hex: '#29A376', name: t('admin.branding.colorGreen') },
    { hex: '#8C56D2', name: t('admin.branding.colorPurple') },
    { hex: '#CA6A16', name: t('admin.branding.colorOrange') },
    { hex: '#1F9AAD', name: t('admin.branding.colorTeal') },
  ]
  const colorError = isHexColor(b.primary_color) ? '' : t('admin.branding.colorFormat')
  const contrast = colorError ? null : brandContrast(b.primary_color)
  const contrastBlocked = isBlocked(contrast)
  const colorFieldError = colorError || (contrastBlocked ? t('admin.branding.contrastBlocked') : '')

  // ── 저장(카드별) ──
  const changes1 = Number(b.site_name !== orig.site_name) + Number(tagline !== origTagline) + Number(b.default_theme !== orig.default_theme)
  const changes2 = Number(b.primary_color.toLowerCase() !== orig.primary_color.toLowerCase())
  function reset1() { setB(x => ({ ...x, site_name: orig.site_name, default_theme: orig.default_theme })); setTagline(origTagline) }
  function reset2() { setB(x => ({ ...x, primary_color: orig.primary_color })) }
  async function save1() {
    setSaving(true)
    try {
      await Promise.all([
        $fetch('/api/admin/settings/branding', { method: 'PATCH', body: { site_name: b.site_name, default_theme: b.default_theme } }),
        tagline !== origTagline
          ? $fetch('/api/admin/settings/appconfig', { method: 'PATCH', body: { values: { 'brand.tagline': tagline } } })
          : Promise.resolve(),
      ])
      setOrig(o => ({ ...o, site_name: b.site_name, default_theme: b.default_theme }))
      setOrigTagline(tagline)
      await refetchAppConfig()
      flash(setSaved1)
    } catch (e: any) { addToast('error', e?.data?.detail || t('error.genericError')) }
    finally { setSaving(false) }
  }
  async function save2() {
    if (colorFieldError) return
    setSaving(true)
    try {
      await $fetch('/api/admin/settings/branding', { method: 'PATCH', body: { primary_color: b.primary_color } })
      setOrig(o => ({ ...o, primary_color: b.primary_color }))
      await refetchAppConfig()
      flash(setSaved2)
    } catch (e: any) { addToast('error', e?.data?.detail || t('error.genericError')) }
    finally { setSaving(false) }
  }

  // ── 이미지(즉시 올림) ──
  const logoInput = useRef<HTMLInputElement | null>(null)
  const favInput = useRef<HTMLInputElement | null>(null)
  const wpInput = useRef<HTMLInputElement | null>(null)
  async function upload(kind: Kind, e: ChangeEvent<HTMLInputElement>) {
    const input = e.target
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    setBusy(kind)
    try {
      const form = new FormData()
      form.append('file', file)
      if (kind === 'wallpaper') {
        await $fetch('/api/admin/settings/appconfig/wallpaper', { method: 'POST', body: form })
        setWallpapers((await $fetch<{ wallpapers: string[] }>('/api/admin/settings/appconfig/wallpapers')).wallpapers || [])
        flash(setSaved2)
      } else {
        const res = await $fetch<Record<string, string>>(`/api/admin/settings/branding/${kind}`, { method: 'POST', body: form })
        const key = kind === 'logo' ? 'logo_url' : 'favicon_url'
        const v = res[key] ?? ''
        setB(x => ({ ...x, [key]: v }))
        setOrig(o => ({ ...o, [key]: v }))
        flash(setSaved1)
      }
      await refetchAppConfig()
    } catch (err: any) { addToast('error', err?.data?.detail || t('error.genericError')) }
    finally { setBusy(null) }
  }
  async function remove(kind: Kind, wpUrl?: string) {
    const title = kind === 'logo' ? t('admin.settings.branding.deleteLogoConfirm') : kind === 'favicon' ? t('admin.settings.branding.deleteFaviconConfirm') : t('admin.branding.deleteOneWallpaperTitle')
    const body = kind === 'wallpaper' ? (wallpapers.length > 1 ? t('admin.branding.deleteOneWallpaperBody') : t('admin.branding.deleteWallpaperBody')) : t('admin.branding.revertBody')
    if (!await confirmBox(body, { title, confirmLabel: t('common.delete'), danger: true })) return
    setBusy(kind)
    try {
      if (kind === 'wallpaper') {
        await $fetch('/api/admin/settings/appconfig/wallpaper', { method: 'DELETE', query: { name: fileName(wpUrl || '') } })
        setWallpapers((await $fetch<{ wallpapers: string[] }>('/api/admin/settings/appconfig/wallpapers')).wallpapers || [])
        flash(setSaved2)
      } else {
        await $fetch(`/api/admin/settings/branding/${kind}`, { method: 'DELETE' })
        setB(x => ({ ...x, [kind === 'logo' ? 'logo_url' : 'favicon_url']: '' }))
        flash(setSaved1)
      }
      await refetchAppConfig()
    } catch (err: any) { addToast('error', err?.data?.detail || t('error.genericError')) }
    finally { setBusy(null) }
  }

  /** 끌어 놓기 · Alt+←/→ — 순서를 바로 저장(파일 이름 번호 재부여) */
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  async function reorder(from: number, to: number) {
    const next = moveItem(wallpapers, from, to)
    if (next === wallpapers) return
    const prev = wallpapers
    setWallpapers(next)
    setBusy('wallpaper')
    try {
      const r = await $fetch<{ wallpapers: string[] }>('/api/admin/settings/appconfig/wallpapers/order', { method: 'PUT', body: { names: next.map(fileName) } })
      setWallpapers(r.wallpapers || next)
      await refetchAppConfig()
      flash(setSaved2)
    } catch (err: any) { setWallpapers(prev); addToast('error', err?.data?.detail || t('error.genericError')) }
    finally { setBusy(null) }
  }

  const THEMES = [
    { value: 'system', label: t('admin.settings.branding.themeSystem') },
    { value: 'light', label: t('admin.settings.branding.themeLight') },
    { value: 'dark', label: t('admin.settings.branding.themeDark') },
  ]

  if (!user?.is_admin) return null
  return (
    <AdminPageShell title={t('admin.branding.pageTitle')} subtitle={t('admin.branding.subtitle')} width="form">
      {loadError ? (
        <UiErrorTile placement="panel" title={t('admin.branding.loadError')} onRetry={load} />
      ) : (
        <>
          {/* ① 이름·로고 */}
          <SettingsCard title={t('admin.branding.basicTitle')} description={t('admin.branding.nameDesc')} changes={changes1} saving={saving} saved={saved1} onSave={save1} onReset={reset1}>
            {loading ? (
              <UiSkeleton preset="text" rows={4} />
            ) : (
              <form className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); void save1() }}>
                <UiInput modelValue={b.site_name} onUpdateModelValue={v => setB(x => ({ ...x, site_name: v }))} label={t('admin.branding.siteName')} />
                <UiInput modelValue={tagline} onUpdateModelValue={setTagline} label={t('admin.branding.tagline')} maxLength={60} />
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold text-muted-foreground">{t('admin.branding.logoLabel')}</span>
                  <BrandingImageField
                    preview={
                      <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-[10px] bg-muted">
                        {b.logo_url ? <img src={b.logo_url} alt={t('admin.branding.currentLogo')} className="max-h-full max-w-full object-contain" /> : <UiIcon name="image" className="h-5 w-5" />}
                      </span>
                    }
                    name={b.logo_url ? fileName(b.logo_url) : t('admin.branding.none')}
                    removable={!!b.logo_url}
                    removeLabel={t('admin.branding.removeLogo')}
                    busy={busy === 'logo'}
                    actionLabel={busy === 'logo' ? t('admin.branding.uploading') : t('admin.branding.replace')}
                    accept="image/png,image/jpeg,image/svg+xml,image/webp"
                    inputRef={logoInput}
                    onRemove={() => { void remove('logo') }}
                    onPick={e => { void upload('logo', e) }}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold text-muted-foreground">{t('admin.settings.branding.favicon')}</span>
                  <BrandingImageField
                    preview={
                      <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-[10px] bg-muted">
                        {b.favicon_url ? <img src={b.favicon_url} alt={t('admin.branding.currentFavicon')} className="h-7 w-7 object-contain" /> : <UiIcon name="globe" className="h-5 w-5" />}
                      </span>
                    }
                    name={b.favicon_url ? fileName(b.favicon_url) : t('admin.branding.none')}
                    removable={!!b.favicon_url}
                    removeLabel={t('admin.branding.removeFavicon')}
                    busy={busy === 'favicon'}
                    actionLabel={busy === 'favicon' ? t('admin.branding.uploading') : t('admin.branding.replace')}
                    accept=".ico,.png,.svg,image/x-icon,image/png,image/svg+xml"
                    inputRef={favInput}
                    onRemove={() => { void remove('favicon') }}
                    onPick={e => { void upload('favicon', e) }}
                  />
                </div>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <span className="text-xs font-semibold text-muted-foreground">{t('admin.settings.branding.defaultTheme')}</span>
                  <UiSegment className="self-start" ariaLabel={t('admin.settings.branding.defaultTheme')} modelValue={b.default_theme} items={THEMES} onUpdateModelValue={v => setB(x => ({ ...x, default_theme: String(v) }))} />
                </div>
                <button type="submit" className="hidden" />
              </form>
            )}
          </SettingsCard>

          {/* ② 강조 색 · 로그인 배경 */}
          <SettingsCard title={t('admin.branding.colorTitle')} description={t('admin.branding.colorDesc')} changes={changes2} saving={saving} saved={saved2} onSave={save2} onReset={reset2}>
            {loading ? (
              <UiSkeleton preset="text" rows={3} />
            ) : (
              <div className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <span id="brand-primary-label" className="text-xs font-semibold text-muted-foreground">primary</span>
                  <div role="radiogroup" aria-labelledby="brand-primary-label" className="flex flex-wrap gap-2">
                    {SWATCHES.map(s => {
                      const on = b.primary_color.toLowerCase() === s.hex.toLowerCase()
                      return (
                        <button
                          key={s.hex}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          aria-label={s.name}
                          className={cn("relative h-8 w-8 rounded-full after:absolute after:-inset-1 after:content-['']", on ? 'shadow-[0_0_0_2px_hsl(var(--card)),0_0_0_4px_hsl(var(--foreground))]' : '')}
                          style={{ background: s.hex }}
                          onClick={() => setB(x => ({ ...x, primary_color: s.hex }))}
                        />
                      )
                    })}
                  </div>
                  <span className="text-xs text-muted-foreground">{t('admin.branding.contrastHint')}</span>
                  <div className="mt-1 flex items-end gap-2">
                    <UiInput modelValue={b.primary_color} onUpdateModelValue={v => setB(x => ({ ...x, primary_color: v }))} label={t('admin.branding.customColor')} error={colorFieldError} maxLength={7} mono className="flex-1" />
                    {contrast !== null && (
                      <span className={cn('pb-2.5 font-mono text-xs', contrastBlocked ? 'text-danger' : 'text-muted-foreground')}>{t('admin.branding.contrastBoth', { l: contrast.light, d: contrast.dark })}</span>
                    )}
                  </div>
                  {/* 자동 조정된 테마는 실제로 쓰는 값을 보여 준다 */}
                  {contrast?.lightAdjusted && <UiTrans k="admin.branding.adjustedLight" className="text-xs text-muted-foreground" slots={{ hex: <span className="font-mono">{contrast.lightAdjusted}</span> }} />}
                  {contrast?.darkAdjusted && <UiTrans k="admin.branding.adjustedDark" className="text-xs text-muted-foreground" slots={{ hex: <span className="font-mono">{contrast.darkAdjusted}</span> }} />}
                </div>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <span id="brand-wp-label" className="text-xs font-semibold text-muted-foreground">{t('admin.branding.loginBg')}</span>
                  <ul aria-labelledby="brand-wp-label" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {wallpapers.map((url, i) => (
                      <li
                        key={url}
                        draggable={busy !== 'wallpaper'}
                        tabIndex={0}
                        aria-label={t('admin.branding.wallpaperTile', { n: i + 1, total: wallpapers.length })}
                        aria-description={t('admin.branding.wallpaperMoveHint')}
                        className={cn(
                          'group relative aspect-video cursor-grab overflow-hidden rounded-[10px] border border-input bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                          dragFrom === i ? 'opacity-50' : '',
                        )}
                        onDragStart={(e) => { setDragFrom(i); e.dataTransfer.effectAllowed = 'move' }}
                        onDragEnd={() => setDragFrom(null)}
                        onDragOver={(e) => { if (dragFrom !== null) e.preventDefault() }}
                        onDrop={(e) => { e.preventDefault(); if (dragFrom !== null) void reorder(dragFrom, i); setDragFrom(null) }}
                        onKeyDown={(e) => {
                          if (!e.altKey) return
                          if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); void reorder(i, i - 1) }
                          if (e.key === 'ArrowRight' && i < wallpapers.length - 1) { e.preventDefault(); void reorder(i, i + 1) }
                        }}
                      >
                        {/\.(mp4|webm)$/i.test(url)
                          ? <video src={url} muted preload="metadata" className="pointer-events-none h-full w-full object-cover" />
                          : <img src={url} alt="" draggable={false} className="pointer-events-none h-full w-full object-cover" />}
                        <span className="absolute left-1.5 top-1.5 rounded-sm bg-background/80 px-1 font-mono text-[11px] text-foreground">{i + 1}</span>
                        <UiIconButton
                          icon="close"
                          size="sm"
                          variant="muted"
                          label={t('admin.branding.removeWallpaper', { n: i + 1 })}
                          disabled={busy === 'wallpaper'}
                          className="absolute right-1 top-1"
                          onClick={() => { void remove('wallpaper', url) }}
                        />
                      </li>
                    ))}
                    {wallpapers.length < WALLPAPER_MAX && (
                      <li>
                        <button
                          type="button"
                          className="grid aspect-video w-full place-items-center rounded-[10px] border border-dashed border-input text-xs font-semibold text-muted-foreground hover:bg-accent/40 disabled:opacity-50"
                          disabled={busy === 'wallpaper'}
                          onClick={() => wpInput.current?.click()}
                        >{busy === 'wallpaper' ? t('admin.branding.uploading') : t('admin.branding.addTile')}</button>
                      </li>
                    )}
                  </ul>
                  <input ref={wpInput} type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm" className="hidden" onChange={e => { void upload('wallpaper', e) }} />
                  <span className="text-xs text-muted-foreground">{t('admin.branding.loginBgHint4')}</span>
                </div>
              </div>
            )}
          </SettingsCard>
        </>
      )}
    </AdminPageShell>
  )
}
