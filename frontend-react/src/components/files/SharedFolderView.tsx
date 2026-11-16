/**
 * 폴더 공유 링크 손님 화면(OneDrive식 보기 전용) — pages/s/[token] 이 폴더 링크일 때 표시한다.
 *
 * 상단 띠(브랜드 · 폴더 이름 · 공유자/만료 · 권한 배지 · [이 폴더 zip]) → 경로(처음 / 하위 / …) → 목록.
 * 목록: GET /api/files/shared/{token}/list?sub=(횟수 미집계). 폴더 행 = 진입, 파일 행 = 미리보기(지원 형식) 또는 내려받기.
 * 받기: GET /api/files/shared/{token}?sub=<파일|폴더>(폴더는 zip). 미리보기는 ?inline=1(서버가 집계하지 않음).
 * 내려받기 막힘 링크는 미리보기만 제공(이미지·PDF·텍스트), 내려받기 버튼 없음.
 * 브라우저 뒤로 가기로 상위 폴더로 복귀하도록 ?p= 를 history 에 기록한다.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { cn } from '~/lib/utils'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { fileKind, formatSize, formatStamp, KIND_META } from '~/lib/files'
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiModal } from '~/components/ui/Modal'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEmptyState } from '~/components/ui/EmptyState'

export interface SharedFolderItem {
  name: string
  path: string
  is_dir: boolean
  size: number
  modified_at: string | null
  mime_type: string | null
  preview: 'image' | 'pdf' | 'text' | null
}

interface ListResp { name: string; sub: string; allow_download: boolean; items: SharedFolderItem[]; truncated: boolean }

export interface SharedFolderViewProps {
  token: string
  /** 비밀번호 링크의 접근 키(없으면 null) */
  access: string | null
  /** 상단 보조 줄(공유자 · 만료 · 남은 횟수) */
  meta?: string
  /** 목록을 더 이상 열 수 없는 상태(만료·횟수 초과·없음) → 결과 화면으로 전환. 처리한 경우 true 반환 */
  onBlocked?: (e: unknown) => boolean
  /** 비밀번호 접근 키가 만료됨(401) */
  onLocked?: () => void
}

function readSub(): string {
  try { return new URLSearchParams(window.location.search).get('p') || '' } catch { return '' }
}

export function SharedFolderView({ token, access, meta, onBlocked, onLocked }: SharedFolderViewProps) {
  const { t } = useI18n()
  const { appName, brandLogo } = useSiteConfig()
  const [sub, setSub] = useState<string>(readSub)
  const [data, setData] = useState<ListResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<null | { item: SharedFolderItem; text?: string; loading?: boolean }>(null)

  const q = useCallback((extra: Record<string, string>) => {
    const p = new URLSearchParams(extra)
    if (access) p.set('access', access)
    return p.toString()
  }, [access])
  const fileHref = (path: string, inline = false) => `/api/files/shared/${token}?${q(inline ? { sub: path, inline: '1' } : { sub: path })}`
  // 받기는 주소 이동으로 처리(서버가 attachment 로 응답) — 아이콘 버튼이 <a> 가 아니기 때문
  const dl = (href: string) => { window.location.href = href }
  const zipHref = (path: string) => (path ? fileHref(path) : `/api/files/shared/${token}${access ? `?${q({})}` : ''}`)

  // 폴더를 빠르게 이동하면 지연 도착한 이전 응답이 현재 폴더 목록을 덮어쓴다 — 가장 최근 요청만 반영
  const loadSeq = useRef(0)
  const load = useCallback(async (s: string) => {
    const seq = ++loadSeq.current
    setLoading(true)
    setError('')
    try {
      const r = await $fetch<ListResp>(`/api/files/shared/${token}/list?${q({ sub: s })}`)
      if (seq !== loadSeq.current) return
      setData(r)
    } catch (e: any) {
      if (seq !== loadSeq.current) return
      const status = e?.statusCode || e?.status || 0
      if (status === 401) { onLocked?.(); return }
      if (status === 404 && s) { setError(t('share.folder.notFound')); setData(null); return }
      if (onBlocked?.(e)) return
      setError(t('share.openFailed'))
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [token, q, onBlocked, onLocked, t])

  useEffect(() => { void load(sub) }, [sub]) // eslint-disable-line react-hooks/exhaustive-deps

  // 뒤로 가기 = 상위 폴더
  useEffect(() => {
    const onPop = () => setSub(readSub())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  function go(next: string) {
    if (next === sub) return
    try {
      const u = new URL(window.location.href)
      if (next) u.searchParams.set('p', next)
      else u.searchParams.delete('p')
      window.history.pushState(null, '', u.pathname + u.search)
    } catch { /* noop */ }
    setSub(next)
  }

  async function openPreview(item: SharedFolderItem) {
    if (item.preview !== 'text') { setPreview({ item }); return }
    setPreview({ item, loading: true })
    try {
      const r = await fetch(fileHref(item.path, true), { credentials: 'same-origin' })
      if (!r.ok) throw new Error(String(r.status))
      const ct = r.headers.get('content-type') || ''
      // 내려받기 막힌 링크는 {type:'text', content} JSON, 아니면 파일 본문 그대로
      const text = ct.includes('application/json') ? String((await r.json())?.content ?? '') : await r.text()
      setPreview({ item, text })
    } catch {
      setPreview({ item, text: t('share.folder.previewFailed') })
    }
  }

  const allowDownload = data ? data.allow_download : true
  const rootName = data?.name || ''
  const crumbs = sub ? sub.split('/') : []
  const initial = (appName || 'W').trim().charAt(0).toUpperCase()

  function onRow(item: SharedFolderItem) {
    if (item.is_dir) go(item.path)
    else if (item.preview) void openPreview(item)
    else if (allowDownload) dl(fileHref(item.path))
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      {/* 상단 띠 */}
      <header className="flex items-center gap-3 border-b border-border bg-card px-4 py-3 sm:px-6">
        {brandLogo
          ? <img src={brandLogo} alt="" className="h-8 w-8 shrink-0 rounded-sm object-cover" />
          : <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-primary text-[15px] font-bold text-primary-foreground">{initial}</span>}
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-warning/15 text-warning">
          <UiIcon name="folder-open" className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold text-foreground">{rootName || t('share.folder.title')}</h1>
          {meta && <p className="truncate text-xs text-muted-foreground">{meta}</p>}
        </div>
        <UiBadge tone={allowDownload ? 'primary' : 'warning'} className="hidden sm:inline-flex">
          {allowDownload ? t('share.folder.viewDownload') : t('share.previewOnly')}
        </UiBadge>
        {allowDownload && (
          <UiButton as="a" href={zipHref(sub)} size="sm" variant="outline" icon="download" className="shrink-0">
            <span className="hidden sm:inline">{sub ? t('share.folder.zipHere') : t('share.folder.zipAll')}</span>
            <span className="sm:hidden">zip</span>
          </UiButton>
        )}
      </header>

      <main className="mx-auto flex w-full max-w-[960px] flex-1 flex-col gap-3 px-4 py-4 sm:px-6">
        {/* 경로 */}
        <nav aria-label={t('share.folder.path')} className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
          <button
            type="button"
            onClick={() => go('')}
            className={cn('max-w-[220px] truncate rounded px-1.5 py-0.5 hover:bg-muted', crumbs.length ? 'text-muted-foreground' : 'font-semibold text-foreground')}
            aria-current={crumbs.length ? undefined : 'page'}
          >{rootName || t('share.folder.title')}</button>
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1
            return (
              <span key={i} className="flex min-w-0 items-center gap-1">
                <UiIcon name="chevron-right" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <button
                  type="button"
                  onClick={() => go(crumbs.slice(0, i + 1).join('/'))}
                  className={cn('max-w-[220px] truncate rounded px-1.5 py-0.5 hover:bg-muted', last ? 'font-semibold text-foreground' : 'text-muted-foreground')}
                  aria-current={last ? 'page' : undefined}
                >{c}</button>
              </span>
            )
          })}
        </nav>

        {loading
          ? <UiSkeleton preset="text" rows={6} />
          : error
            ? (
              <UiEmptyState
                title={error}
                icon="alert-circle"
                actionLabel={sub ? t('share.folder.toRoot') : t('common.retry')}
                onAction={() => (sub ? go('') : void load(sub))}
              />
            )
            : !data || data.items.length === 0
              ? <UiEmptyState title={t('share.folder.empty')} icon="folder" />
              : (
                <div className="overflow-hidden rounded-lg border border-border bg-card">
                  <div className="hidden grid-cols-[1fr_96px_112px_72px] gap-3 border-b border-border px-4 py-2 text-xs font-medium text-muted-foreground sm:grid">
                    <span>{t('share.folder.colName')}</span>
                    <span className="text-right">{t('share.folder.colSize')}</span>
                    <span>{t('share.folder.colModified')}</span>
                    <span />
                  </div>
                  <ul role="list" aria-label={t('share.folder.listLabel')}>
                    {data.items.map(item => {
                      const kind = fileKind(item)
                      const km = KIND_META[kind]
                      return (
                        <li
                          key={item.path}
                          className="group grid grid-cols-[1fr_auto] items-center gap-3 border-b border-border px-4 py-2 last:border-b-0 hover:bg-muted/50 sm:grid-cols-[1fr_96px_112px_72px]"
                        >
                          <button
                            type="button"
                            onClick={() => onRow(item)}
                            disabled={!item.is_dir && !item.preview && !allowDownload}
                            className="flex min-w-0 items-center gap-2.5 text-left disabled:cursor-default"
                          >
                            <UiIcon name={km.icon} className={cn('h-5 w-5 shrink-0', km.tone)} aria-label={t(km.labelKey)} />
                            <span className="min-w-0">
                              <span className="block truncate text-sm text-foreground">{item.name}</span>
                              <span className="block truncate text-xs text-muted-foreground sm:hidden">
                                {item.is_dir ? t(km.labelKey) : `${formatSize(item.size)} · ${formatStamp(item.modified_at)}`}
                              </span>
                              {!item.is_dir && !item.preview && !allowDownload && (
                                <span className="sr-only">{t('share.noPreviewBlocked', '이 형식은 미리 볼 수 없고 다운로드가 막혀 있습니다.')}</span>
                              )}
                            </span>
                          </button>
                          <span className="hidden text-right text-xs tabular-nums text-muted-foreground sm:block">{item.is_dir ? '—' : formatSize(item.size)}</span>
                          <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">{formatStamp(item.modified_at)}</span>
                          <span className="flex justify-end gap-0.5">
                            {item.is_dir
                              ? (allowDownload && (
                                <UiIconButton onClick={() => dl(zipHref(item.path))} icon="download" size="sm" label={t('share.folder.zipOf', { name: item.name })} />
                              ))
                              : (
                                <>
                                  {item.preview && (
                                    <UiIconButton icon="eye" size="sm" label={t('share.folder.previewOf', { name: item.name })} onClick={() => void openPreview(item)} />
                                  )}
                                  {allowDownload && (
                                    <UiIconButton onClick={() => dl(fileHref(item.path))} icon="download" size="sm" label={t('share.folder.downloadOf', { name: item.name })} />
                                  )}
                                  {/* 미리보기 불가 형식 + 내려받기 막힘 = 가능한 동작이 없는 줄 — 사유를 표시한다 */}
                                  {!item.preview && !allowDownload && (
                                    <span className="whitespace-nowrap text-[11px] text-muted-foreground" title={t('share.noPreviewBlocked', '이 형식은 미리 볼 수 없고 다운로드가 막혀 있습니다.')}>
                                      {t('share.folder.noPreview', '미리보기 불가')}
                                    </span>
                                  )}
                                </>
                              )}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
        {data?.truncated && <p className="text-xs text-muted-foreground">{t('share.folder.truncated')}</p>}
      </main>

      {preview && (
        <UiModal
          size="wide"
          mobile="full"
          flush={preview.item.preview !== 'text'}
          title={preview.item.name}
          onClose={() => setPreview(null)}
          actions={allowDownload
            ? <UiIconButton onClick={() => dl(fileHref(preview.item.path))} icon="download" size="sm" label={t('share.download')} />
            : undefined}
        >
          {preview.item.preview === 'image'
            ? <img src={fileHref(preview.item.path, true)} alt={preview.item.name} className="mx-auto max-h-[80dvh] max-w-full object-contain" />
            : preview.item.preview === 'pdf'
              ? <iframe src={fileHref(preview.item.path, true)} title={preview.item.name} className="h-[80dvh] w-full border-0" />
              : preview.loading
                ? <UiSkeleton preset="text" rows={8} />
                : <pre className="max-h-[75dvh] overflow-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground">{preview.text}</pre>}
        </UiModal>
      )}
    </div>
  )
}

export default SharedFolderView
