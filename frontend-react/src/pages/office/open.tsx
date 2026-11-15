/**
 * 오피스 새 탭(Vue pages/office/open.vue) — 여는 중(시안 ShellPage variant=officeLoading · 11 답 D6c). 셸 없음(routes.ts layout:false).
 *  머리 40 bg-card: 브랜드 타일 22 · 파일 이름 600 · 폴더 경로(내 파일 › 프로젝트) muted
 *  가운데: 형식 타일 48(시트 success · 문서 primary · 슬라이드 warning /15) → "파일 여는 중…" 16/600 →
 *          진행 220×4 → "문서 편집기를 불러오고 있습니다 · 10초가 넘으면 [미리보기로 열기]" 13 muted.
 *  편집기 세션을 받으면 이 탭이 편집기로 넘어간다(OnlyOffice 는 WOPI 표준대로 access_token 을 POST 폼으로).
 *  미리보기로 열기 = 같은 탭에서 글자 미리보기(/api/files/preview → type office) — 편집기가 끝내 안 뜨는 경우.
 *    미리보기(시안 R12Misc office · 답변서 A7 M2): 머리 48(브랜드 · 형식 아이콘 · 파일명 · "미리보기" 배지 · [편집기 다시 열기][다운로드])
 *    → warning 띠 "글자만 보여 드립니다"(role=status) → bg-paper 종이 760 에 글자, 끝에 "[표 1개 · 이미지 2개 생략됨]"(서버 omitted).
 *  ?path=<가상경로> 또는 ?new=doc|sheet|slide&dir=<폴더>(새 문서를 만들고 연다).
 */
import { useEffect, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { useHead } from '~/lib/head'
import { useRoute } from '~/lib/router'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { openEditor } from '~/composables/useOfficeEditor'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiEmptyState } from '~/components/ui/EmptyState'
import { UiTrans } from '~/components/ui/Trans'
import { UiBadge } from '~/components/ui/Badge'

const TILE = {
  doc: { icon: 'file-doc', cls: 'bg-primary/15 text-primary' },
  sheet: { icon: 'file-sheet', cls: 'bg-success/15 text-success' },
  slide: { icon: 'file-slide', cls: 'bg-warning/15 text-warning' },
}

function postToEditor(url: string, token: string, ttlSec: number) {
  const form = document.createElement('form')
  form.method = 'post'
  form.action = url
  form.style.display = 'none'
  const add = (k: string, v: string) => {
    const i = document.createElement('input')
    i.type = 'hidden'
    i.name = k
    i.value = v
    form.appendChild(i)
  }
  add('access_token', token)
  // access_token_ttl 은 초가 아니라 만료 시각(epoch ms)
  add('access_token_ttl', ttlSec ? String(Date.now() + ttlSec * 1000) : '0')
  document.body.appendChild(form)
  form.submit()
}

export default function OfficeOpenPage() {
  const route = useRoute()
  const { t } = useI18n()
  const { appName, brandLogo } = useSiteConfig()

  // 처음 주소만 읽는다(Vue setup 한 번)
  const [init] = useState(() => {
    const q = route.query
    const newKind = typeof q.new === 'string' && ['doc', 'sheet', 'slide'].includes(q.new) ? q.new as 'doc' | 'sheet' | 'slide' : null
    const newDir = typeof q.dir === 'string' && q.dir ? q.dir : 'my'
    return { path: typeof q.path === 'string' ? q.path : '', newKind, newDir, routePath: route.path }
  })
  const { newKind, newDir } = init
  const [path, setPathState] = useState(init.path)
  const pathRef = useRef(init.path)
  const setPath = (v: string) => { pathRef.current = v; setPathState(v) }

  const name = path.split('/').pop() || (newKind ? t('files.commandBar.newDoc') : '')
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  const kind: 'doc' | 'sheet' | 'slide' = newKind
    ? newKind
    : ['xls', 'xlsx', 'ods', 'csv'].includes(ext) ? 'sheet'
      : ['ppt', 'pptx', 'odp'].includes(ext) ? 'slide'
        : 'doc'
  const folderLabel = (() => {
    const parts = (path || `${newDir}/x`).split('/').slice(0, -1)
    if (!parts.length) return ''
    const root = parts[0] === 'my' ? t('files.sidebar.myFiles') : parts[0] === 'shared' ? t('files.sidebar.sharedFiles') : parts[0]
    return [root, ...parts.slice(1)].join(' › ')
  })()
  const brandInitial = (appName || 'W').trim().charAt(0).toUpperCase()
  useHead({ title: name ? `${name} | ${appName}` : appName })

  // ── 여는 중 ──
  const [phase, setPhaseState] = useState<'opening' | 'preview' | 'error'>('opening')
  const phaseRef = useRef<'opening' | 'preview' | 'error'>('opening')
  const setPhase = (v: 'opening' | 'preview' | 'error') => { phaseRef.current = v; setPhaseState(v) }
  const [errorMsg, setErrorMsg] = useState('')
  const [unsupported, setUnsupported] = useState(false)
  const [slow, setSlow] = useState(false)        // 10초 넘음
  const [barStarted, setBarStarted] = useState(false)  // 진행 막대 — 10초에 걸쳐 90% 까지(편집기 쪽 진행은 알 수 없다)
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function open() {
    setPhase('opening')
    setErrorMsg('')
    setUnsupported(false)
    setSlow(false)
    setBarStarted(false)
    requestAnimationFrame(() => { setBarStarted(true) })
    if (slowTimer.current) clearTimeout(slowTimer.current)
    slowTimer.current = setTimeout(() => { setSlow(true) }, 10_000)
    try {
      if (newKind && !pathRef.current) {
        const made = await $fetch<{ path: string; name: string }>('/api/wopi/new', { method: 'POST', body: { dir: newDir, kind: newKind } })
        setPath(made.path)
        // 새로 고침해도 같은 문서를 열게 주소를 바꿔 둔다
        history.replaceState(history.state, '', `${init.routePath}?path=${encodeURIComponent(made.path)}`)
      }
      if (!pathRef.current) throw new Error(t('office.open.noFile'))
      const session = await openEditor(pathRef.current, 'auto')
      if (phaseRef.current !== 'opening') return   // 그새 미리보기로 바꿨다
      const url = session.editor_url.startsWith('http') ? session.editor_url : window.location.origin + session.editor_url
      if (session.editor === 'onlyoffice') postToEditor(url, session.token, session.token_ttl)
      else window.location.replace(url)
    } catch (e: any) {
      if (phaseRef.current !== 'opening') return
      // 서버 detail(영문 원문)은 보이지 않는다 — 상태 코드로 한국어 안내(검수 P8 K4).
      // 지원하지 않는 형식(400)은 다시 시도해도 같으므로 [다시 시도]를 숨기고 미리보기만 둔다.
      const status = Number(e?.statusCode ?? e?.status ?? e?.response?.status ?? 0)
      setUnsupported(status === 400)
      setErrorMsg(status === 400 ? t('office.open.errUnsupported')
        : status === 403 ? t('office.open.errForbidden')
          : status === 404 ? t('office.open.errNotFound')
            : status === 503 ? t('office.open.errUnavailable')
              : !pathRef.current ? t('office.open.noFile')
                : t('office.open.errGeneric'))
      setPhase('error')
    }
  }

  // ── 미리보기 ──
  const [previewText, setPreviewText] = useState<string | null>(null)
  const [omitted, setOmitted] = useState<{ tables: number; images: number } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  async function openPreview() {
    if (!pathRef.current) return
    setPhase('preview')
    setPreviewLoading(true)
    try {
      const r = await $fetch<{ type: string; content?: string; omitted?: { tables?: number; images?: number } }>('/api/files/preview', { params: { path: pathRef.current } })
      setPreviewText(r.content ?? '')
      setOmitted(r.omitted ? { tables: r.omitted.tables ?? 0, images: r.omitted.images ?? 0 } : null)
    } catch { setPreviewText(''); setOmitted(null) }
    finally { setPreviewLoading(false) }
  }
  const downloadUrl = `/api/files/download?path=${encodeURIComponent(path)}`
  // "[표 1개 · 이미지 2개 생략됨]" — 빠진 것만 이어 붙인다
  const omittedText = (() => {
    if (!omitted) return ''
    const parts = [
      omitted.tables ? t('office.open.omitTables', { n: omitted.tables }) : '',
      omitted.images ? t('office.open.omitImages', { n: omitted.images }) : '',
    ].filter(Boolean)
    return parts.length ? t('office.open.omitted', { items: parts.join(' · ') }) : ''
  })()

  useEffect(() => {
    open()
    return () => { if (slowTimer.current) clearTimeout(slowTimer.current) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      {phase === 'preview'
        ? (
          /* 미리보기 머리 48 */
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
            {brandLogo
              ? <img src={brandLogo} alt="" className="h-6 w-6 rounded-sm object-cover" />
              : <span className="grid h-6 w-6 place-items-center rounded-sm bg-primary text-[11px] font-bold text-primary-foreground" aria-hidden="true">{brandInitial}</span>}
            <UiIcon name={TILE[kind].icon} className={clsx('h-4 w-4 shrink-0', kind === 'sheet' ? 'text-success' : kind === 'slide' ? 'text-warning' : 'text-primary')} />
            <b className="min-w-0 truncate text-[13px] font-semibold">{name}</b>
            <UiBadge tone="neutral" tint size={18} className="shrink-0">{t('office.open.previewBadge')}</UiBadge>
            <span className="flex-1" />
            <UiButton size="xs" className="shrink-0" onClick={open}>{t('office.open.retryEditor')}</UiButton>
            <UiButton as="a" href={downloadUrl} variant="outline" size="xs" icon="download" className="shrink-0">
              {t('common.download')}
            </UiButton>
          </header>
        )
        : (
          /* 머리 40 */
          <header className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border bg-card px-3.5 text-[13px]">
            {brandLogo
              ? <img src={brandLogo} alt="" className="h-[22px] w-[22px] rounded-[6px] object-cover" />
              : <span className="grid h-[22px] w-[22px] place-items-center rounded-[6px] bg-primary text-[11px] font-bold text-primary-foreground" aria-hidden="true">{brandInitial}</span>}
            <b className="min-w-0 truncate font-semibold">{name}</b>
            {folderLabel && <span className="hidden truncate text-muted-foreground sm:inline">{folderLabel}</span>}
          </header>
        )}

      {phase === 'opening'
        ? (
          // 여는 중
          <main aria-busy="true" className="flex flex-1 flex-col items-center justify-center gap-3.5 px-6 text-center">
            <span className={clsx('grid h-12 w-12 place-items-center rounded-lg', TILE[kind].cls)} aria-hidden="true">
              <UiIcon name={TILE[kind].icon} strokeWidth={1.9} className="h-6 w-6" />
            </span>
            <h1 className="text-base font-semibold">{t('office.open.opening', { name })}</h1>
            <div className="h-1 w-[220px] overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={t('office.open.loadingEditor')}>
              <div
                className={clsx('h-full rounded-full bg-primary ease-out', barStarted ? 'w-[90%] transition-[width] duration-[10000ms]' : 'w-[8%]')}
              />
            </div>
            <p className="text-[13px] text-muted-foreground [word-break:keep-all]">
              {t('office.open.loadingEditor')} ·{' '}
              {/* <i18n-t keypath="office.open.slowHint"> — {link} 자리에 버튼 */}
              <UiTrans
                k="office.open.slowHint"
                as="span"
                slots={{
                  link: (
                    <button
                      type="button"
                      className={clsx('font-semibold text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring', slow ? 'underline' : '')}
                      onClick={openPreview}
                    >{t('office.open.openPreview')}</button>
                  ),
                }}
              />
            </p>
          </main>
        )
        : phase === 'error'
          ? (
            // 실패
            <main className="flex flex-1 items-center justify-center px-6">
              <div className="w-full max-w-[420px]">
                <UiErrorTile title={t('files.page.editorOpenError')} detail={errorMsg} noRetry={unsupported} onRetry={open} />
                <div className="mt-3 text-center">
                  {path && <button type="button" className="text-[13px] font-semibold text-primary hover:underline" onClick={openPreview}>{t('office.open.openPreview')}</button>}
                </div>
              </div>
            </main>
          )
          : (
            // 미리보기(글자만) — warning 띠 + 종이
            <>
              <div role="status" className="flex min-h-10 shrink-0 items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-[13px]">
                <UiIcon name="alert-triangle" className="h-4 w-4 shrink-0 text-warning" />
                <UiTrans
                  k="office.open.textOnlyBand"
                  as="span"
                  className="min-w-0 flex-1 [word-break:keep-all]"
                  slots={{ b: (c) => <b className="font-semibold">{c}</b> }}
                />
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{t('office.open.readOnly')}</span>
              </div>
              <main className="min-h-0 flex-1 overflow-y-auto bg-muted/30 px-4 py-8">
                {previewLoading
                  ? <div className="mx-auto max-w-[760px] rounded-sm bg-paper p-6 sm:px-14 sm:py-12"><UiSkeleton preset="text" rows={10} /></div>
                  : !previewText
                    ? (
                      <UiEmptyState
                        variant="full"
                        icon="file-text"
                        title={t('office.open.noPreview')}
                        description={t('office.open.noPreviewHint')}
                      />
                    )
                    : (
                      <article className="mx-auto min-h-[900px] w-full max-w-[760px] rounded-sm bg-paper px-6 py-8 text-paper-foreground shadow-md sm:px-14 sm:py-12">
                        <div className="whitespace-pre-wrap break-words text-[15px] leading-7">{previewText}</div>
                        {omittedText && <p className="mt-4 font-mono text-xs opacity-60">{omittedText}</p>}
                      </article>
                    )}
              </main>
            </>
          )}
    </div>
  )
}
