/**
 * AI 결과물 카드(시안 C1 결과물 카드 · C2-6 만드는 중 · C2-7 실패 · L1 묶음·만료·저장·부분 실패·모바일).
 *
 *  파일 하나: 72×92 문서 그림 + 아이콘·이름 14/600 + "Word 문서 · 3쪽 · 24 KB" 12.5 muted + [미리보기][다운로드][내 파일에 저장]
 *            모바일 = 이름 줄 + 2열 큰 버튼 [다운로드][내 파일에].
 *  묶음: 머리(file-zip · "만든 파일 3개 · 4.1 MB" · "링크 23시간 뒤 만료" · [모두 내려받기(zip)]) + 항목 줄(미리보기·내려받기)
 *        + 아래 줄(저장 위치·폴더 열기). 일부 실패 = warning 테두리 블록(항목별 [이것만 다시], "zip에는 만든 n개만").
 *        만드는 중 = 스켈레톤 + 진행 막대 + "n/m개 만드는 중 · 다른 화면으로 가도 계속…".
 *  만료: 이름 muted + [링크 만료] 배지 + 안내 + [다시 만들기][내 파일에서 열기].
 *  저장 중 / 공간 부족(L1-3): 상태 띠 / danger 띠 + [다시].
 *
 * 카드는 스스로 서버 상태를 읽는다(대화를 다시 열면 저장된 스냅샷 → GET 으로 최신화, 작업 중이면 실시간 + 3초 조회).
 */
import { useEffect, useState } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { NuxtLink } from '~/components/NuxtLink'
import { navigateTo } from '~/lib/router'
import { UiIcon } from '~/components/ui/Icon'
import { UiButton } from '~/components/ui/Button'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiBadge } from '~/components/ui/Badge'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiModal } from '~/components/ui/Modal'
import { UiTrans } from '~/components/ui/Trans'
import { useIsMobile } from '~/composables/useIsMobile'
import { putJob, registerJobCard, useAiJob } from '~/composables/useAiArtifacts'
import { aiFormatBytes } from '~/utils/aiAssist'
import {
  aiArtifactError, aiArtifactIcon, aiArtifactUnit, aiArtifactsApi, aiFolderHref, aiHoursLeft,
  type AiArtifact, type AiArtifactJob, type AiArtifactPayload, type AiArtifactPreview,
} from '~/utils/aiArtifacts'

const POLL_MS = 3000
const LIST_MAX = 10
const mono = (v: unknown) => <span className="font-mono">{String(v)}</span>

type SaveState = { phase: 'idle' | 'saving' | 'error'; code?: string; message?: string; room?: number | null }

export interface AiArtifactsProps {
  items: AiArtifactPayload[]
  className?: string
}

/** 결과물 카드 목록 — 메시지 아래 */
export function AiArtifacts({ items, className }: AiArtifactsProps) {
  if (!items?.length) return null
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {items.map(p => (p.type === 'file'
        ? <AiArtifactFileCard key={`f${p.artifact.id}`} initial={p.artifact} />
        : <AiArtifactBundleCard key={`b${p.job.id}`} initial={p.job} />))}
    </div>
  )
}

// ── 공통 조각 ────────────────────────────────────────────────
function DocThumb() {
  return (
    <div aria-hidden="true" className="box-border flex h-[92px] w-[72px] shrink-0 flex-col gap-[5px] rounded-md border border-border bg-background px-2 py-2.5">
      <span className="h-[5px] w-[70%] rounded-sm bg-primary/60" />
      {[100, 100, 80, 100, 60].map((w, i) => <span key={i} className="h-[3px] rounded-sm bg-muted-foreground/40" style={{ width: `${w}%` }} />)}
    </div>
  )
}

function SaveRows({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  const { t } = useI18n()
  if (state.phase === 'saving') {
    return (
      <div role="status" className="flex items-center gap-2 rounded-[10px] border border-border bg-card px-3.5 py-2.5 text-[12.5px]">
        <UiIcon name="loader" className="h-3.5 w-3.5 animate-spin text-primary" />
        <span className="flex-1">{t('ai.artifact.saving')}</span>
      </div>
    )
  }
  if (state.phase === 'error') {
    return (
      <div role="alert" className="flex items-center gap-2 rounded-[10px] border border-danger/45 bg-danger/[0.08] px-3.5 py-2.5 text-[12.5px]">
        <UiIcon name="alert-circle" className="h-3.5 w-3.5 shrink-0 text-danger" />
        <span className="min-w-0 flex-1">
          {state.code === 'quota'
            ? <>{t('ai.artifact.quota')}{state.room != null && <> · <UiTrans k="ai.artifact.quotaRoom" slots={{ size: mono(aiFormatBytes(state.room)) }} /></>}</>
            : (state.message || t('ai.artifact.saveFailed'))}
        </span>
        <UiButton variant="ghost" size="xs" onClick={onRetry}>{t('ai.artifact.again')}</UiButton>
      </div>
    )
  }
  return null
}

function SavedLine({ folder, label }: { folder: string; label?: string | null }) {
  const { t } = useI18n()
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
      <UiIcon name="check-circle" className="h-3.5 w-3.5 shrink-0 text-success" />
      <span className="min-w-0 flex-1">{t('ai.artifact.saved', { folder: label || folder })}</span>
      <NuxtLink to={aiFolderHref(folder)} className="shrink-0 text-primary hover:underline">{t('ai.artifact.openFolder')}</NuxtLink>
    </div>
  )
}

function ExpiredCard({ name, icon, savedFolder, busy, onRebuild, canRebuild }: { name: string; icon: string; savedFolder?: string | null; busy?: boolean; onRebuild: () => void; canRebuild: boolean }) {
  const { t } = useI18n()
  return (
    <section aria-label={t('ai.artifact.expiredLabel')} className="flex flex-col gap-2.5 rounded-xl border border-border bg-card px-4 py-3.5">
      <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-muted-foreground">
        <UiIcon name={icon} className="h-4 w-4 shrink-0" />
        <span className="min-w-0 truncate">{name}</span>
        <UiBadge tone="neutral" tint size={18}>{t('ai.artifact.expired')}</UiBadge>
      </span>
      <span className="text-[12.5px] leading-[19px] text-muted-foreground">
        <UiTrans k="ai.artifact.expiredNote" slots={{ n: mono(24) }} />
      </span>
      <div className="flex flex-wrap gap-2">
        {canRebuild && <UiButton variant="outline" size="sm" icon="refresh" disabled={busy} onClick={onRebuild}>{t('ai.artifact.rebuild')}</UiButton>}
        {savedFolder && <UiButton variant="ghost" size="sm" icon="folder" onClick={() => { void navigateTo(aiFolderHref(savedFolder)) }}>{t('ai.artifact.openInFiles')}</UiButton>}
      </div>
    </section>
  )
}

function useSave<T>(run: () => Promise<T>, onDone: (r: T) => void): [SaveState, () => void] {
  const [st, setSt] = useState<SaveState>({ phase: 'idle' })
  const go = () => {
    setSt({ phase: 'saving' })
    run().then((r) => { setSt({ phase: 'idle' }); onDone(r) }).catch((e) => {
      const er = aiArtifactError(e)
      setSt({ phase: 'error', code: er.code, message: er.message, room: er.room })
    })
  }
  return [st, go]
}

// ── 파일 하나(C1) ────────────────────────────────────────────
export function AiArtifactFileCard({ initial }: { initial: AiArtifact }) {
  const { t, locale } = useI18n()
  const isMobile = useIsMobile()
  const [a, setA] = useState<AiArtifact>(initial)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(false)
  useEffect(() => {
    let alive = true
    aiArtifactsApi.get(initial.id).then((x) => { if (alive) setA(x) }).catch(() => { /* 스냅샷으로 */ })
    return () => { alive = false }
  }, [initial.id])
  const [save, doSave] = useSave(() => aiArtifactsApi.save(a.id), (r) => { if (r.artifact) setA(r.artifact) })

  function rebuild() {
    setBusy(true)
    aiArtifactsApi.rebuild(a.id).then(setA).catch(() => { /* 카드 상태 그대로 */ }).finally(() => setBusy(false))
  }

  const icon = aiArtifactIcon(a.format)
  if (a.status === 'expired') {
    return <ExpiredCard name={a.name} icon={icon} savedFolder={a.saved_folder} busy={busy} onRebuild={rebuild} canRebuild={!!a.can_rebuild} />
  }
  if (a.status === 'failed') {
    const at = a.created_at ? new Date(a.created_at).toLocaleTimeString(locale === 'en' ? 'en-US' : 'ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''
    return (
      <UiErrorTile
        placement="card"
        title={t('ai.artifact.failedTitle')}
        detail={[a.error, at, t('ai.artifact.failedDetail')].filter(Boolean).join(' · ')}
        retryLabel={t('ai.artifact.rebuild')}
        noRetry={busy || !a.can_rebuild}
        onRetry={rebuild}
      />
    )
  }
  const unit = aiArtifactUnit(a)
  const metaParts = [a.label, unit ? t(unit.key, { n: unit.n }) : '', aiFormatBytes(a.size)].filter(Boolean)
  const dl = a.download_url || undefined
  const saved = !!a.saved_path
  return (
    <>
      {isMobile ? (
        <section aria-label={t('ai.artifact.cardLabel')} className="flex flex-col gap-2.5 rounded-xl border border-border bg-card px-3.5 py-3">
          <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
            <UiIcon name={icon} className="h-4 w-4 shrink-0 text-primary" /><span className="min-w-0 truncate">{a.name}</span>
          </span>
          <div className="grid grid-cols-2 gap-2">
            <UiButton as="a" href={dl} download={a.name} variant="outline" size="lg" icon="download">{t('ai.artifact.download')}</UiButton>
            <UiButton size="lg" icon="folder" disabled={saved || save.phase === 'saving'} onClick={doSave}>{t('ai.artifact.saveShort')}</UiButton>
          </div>
          <SaveRows state={save} onRetry={doSave} />
          {saved && a.saved_folder && <SavedLine folder={a.saved_folder} label={a.saved_label} />}
        </section>
      ) : (
        <section aria-label={t('ai.artifact.cardLabel')} className="flex flex-col gap-2.5 rounded-xl border border-border bg-card px-4 py-3.5">
          <div className="flex flex-wrap items-center gap-4">
            <DocThumb />
            <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-1">
              <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                <UiIcon name={icon} className="h-4 w-4 shrink-0 text-primary" /><span className="min-w-0 truncate">{a.name}</span>
              </span>
              <span className="text-[12.5px] text-muted-foreground">
                {metaParts.map((p, i) => <span key={i}>{i > 0 && ' · '}{/\d/.test(String(p)) ? <span className="font-mono">{p}</span> : p}</span>)}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <UiButton variant="ghost" size="sm" icon="eye" onClick={() => setPreview(true)}>{t('ai.artifact.preview')}</UiButton>
              <UiButton as="a" href={dl} download={a.name} variant="outline" size="sm" icon="download">{t('ai.artifact.download')}</UiButton>
              <UiButton size="sm" icon="folder" disabled={saved || save.phase === 'saving'} onClick={doSave}>{t('ai.artifact.save')}</UiButton>
            </div>
          </div>
          <SaveRows state={save} onRetry={doSave} />
          {saved && a.saved_folder && <SavedLine folder={a.saved_folder} label={a.saved_label} />}
        </section>
      )}
      {preview && <AiArtifactPreviewModal artifactId={a.id} name={a.name} downloadUrl={dl} onClose={() => setPreview(false)} />}
    </>
  )
}

// ── 묶음(L1) ─────────────────────────────────────────────────
export function AiArtifactBundleCard({ initial }: { initial: AiArtifactJob }) {
  const { t } = useI18n()
  const isMobile = useIsMobile()
  const live = useAiJob(initial.id)
  const [local, setLocal] = useState<AiArtifactJob>(initial)
  const job = live && (live.done >= local.done || live.status !== 'running') ? live : local
  const [busy, setBusy] = useState(false)
  const [previewId, setPreviewId] = useState<{ id: string; name: string; url?: string } | null>(null)

  useEffect(() => registerJobCard(initial.id), [initial.id])
  // 처음 한 번 + 작업 중이면 3초마다(소켓이 끊겨도 진행이 보이게)
  useEffect(() => {
    let alive = true
    let tm: ReturnType<typeof setTimeout> | undefined
    const tick = () => {
      aiArtifactsApi.job(initial.id).then((j) => {
        if (!alive) return
        setLocal(j); putJob(j)
        if (j.status === 'running') tm = setTimeout(tick, POLL_MS)
      }).catch(() => { if (alive) tm = setTimeout(tick, POLL_MS * 3) })
    }
    tick()
    return () => { alive = false; if (tm) clearTimeout(tm) }
  }, [initial.id, job.status === 'running'])

  const [save, doSave] = useSave(() => aiArtifactsApi.saveJob(job.id), (r) => { if (r.job) { setLocal(r.job); putJob(r.job) } })
  const apply = (j: AiArtifactJob) => { setLocal(j); putJob(j) }
  const retryOne = (i: number) => { setBusy(true); aiArtifactsApi.retryItem(job.id, i).then(apply).catch(() => {}).finally(() => setBusy(false)) }
  const rebuild = () => { setBusy(true); aiArtifactsApi.rebuildJob(job.id).then(apply).catch(() => {}).finally(() => setBusy(false)) }

  const isZip = job.kind === 'files_zip'
  const zip = job.zip
  const icon = 'file-zip'

  if (job.status === 'running') {
    const pct = job.total ? Math.round((job.done / job.total) * 100) : 0
    return (
      <section aria-label={t('ai.artifact.bundle.runningLabel')} className="flex items-center gap-4 rounded-xl border border-border bg-card px-4 py-3.5">
        <div className="w-[72px] shrink-0"><UiSkeleton preset="card" delay={false} /></div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
            <UiIcon name="loader" className="h-4 w-4 shrink-0 animate-spin text-primary" /><span className="min-w-0 truncate">{job.name}</span>
          </span>
          <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t('ai.artifact.bundle.progressLabel')} className="h-1.5 rounded-full bg-border">
            <div className="h-1.5 rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs text-muted-foreground">
            <UiTrans k={isZip ? 'ai.artifact.bundle.zipping' : 'ai.artifact.bundle.making'} slots={{ p: mono(`${job.done}/${job.total}`) }} />
            {' · '}{t('ai.artifact.bundle.keepGoing')}{' · '}{t('ai.artifact.bundle.where')}
          </span>
        </div>
      </section>
    )
  }
  if (job.status === 'failed' || !zip) {
    return (
      <UiErrorTile placement="card" title={t('ai.artifact.bundle.failedTitle')}
        detail={(job.items.find(x => x.error)?.error || '') + (job.items.find(x => x.error) ? ' · ' : '') + t('ai.artifact.failedDetail')}
        retryLabel={t('ai.artifact.rebuild')} noRetry={busy} onRetry={rebuild} />
    )
  }
  const savedFolder = isZip ? (zip.saved_folder || null) : (job.saved_folder || null)
  const savedLabel = isZip ? zip.saved_label : job.saved_label
  if (zip.status === 'expired') {
    return <ExpiredCard name={zip.name} icon={icon} savedFolder={savedFolder} busy={busy} onRebuild={rebuild} canRebuild />
  }

  const okItems = job.items.filter(x => x.status === 'ready')
  const badItems = job.items.filter(x => x.status === 'failed' || x.status === 'forbidden')
  const dupN = job.items.filter(x => x.status === 'deduped').length
  const hours = aiHoursLeft(zip.expires_at)
  const shown = okItems.slice(0, isZip ? 5 : LIST_MAX)
  const moreOk = okItems.length - shown.length + (isZip ? (job.items_more || 0) : 0)
  const titleKey = isZip ? 'ai.artifact.bundle.zipTitle' : 'ai.artifact.bundle.title'
  const dlAll = zip.download_url || undefined

  const itemRow = (it: typeof okItems[number]) => {
    const name = isZip ? (it.arc || it.name) : it.name
    const fIcon = aiArtifactIcon(isZip ? name.split('.').pop() : it.format)
    if (isMobile) {
      return (
        <a key={it.index} href={it.download_url || dlAll} download={isZip ? zip.name : name}
          className="flex min-h-12 items-center gap-2.5 border-t border-border px-3.5 text-foreground no-underline">
          <UiIcon name={fIcon} className="h-4 w-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-[13.5px]">{name}</span>
          <span className="font-mono text-xs text-muted-foreground">{aiFormatBytes(it.size)}</span>
        </a>
      )
    }
    return (
      <li key={it.index} className="flex items-center gap-2.5 border-b border-border px-4 py-2.5">
        <UiIcon name={fIcon} className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-[13.5px]">{name}</span>
        <span className="font-mono text-xs text-muted-foreground">{aiFormatBytes(it.size)}</span>
        {!isZip && it.artifact_id && (
          <>
            <UiIconButton label={t('ai.artifact.previewOf', { name })} icon="eye" size="sm" variant="ghost"
              onClick={() => setPreviewId({ id: it.artifact_id!, name, url: it.download_url || undefined })} />
            {it.download_url
              ? <a href={it.download_url} download={name} aria-label={t('ai.artifact.downloadOf', { name })} title={t('ai.artifact.downloadOf', { name })}
                  className="grid h-8 w-8 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
                  <UiIcon name="download" className="h-[15px] w-[15px]" />
                </a>
              : null}
          </>
        )}
      </li>
    )
  }

  const failBlock = !!badItems.length && (
    <div className="border-t border-warning/45">
      <div className="px-4 py-2.5 text-[13px] font-semibold">
        <UiTrans k="ai.artifact.bundle.partialTitle" slots={{ p: mono(`${job.ok}/${job.total}`) }} />
      </div>
      {badItems.slice(0, LIST_MAX).map(it => (
        <div key={it.index} className="flex items-center gap-2.5 border-t border-border px-4 py-2.5 text-[13px]">
          <UiIcon name="alert-circle" className="h-4 w-4 shrink-0 text-danger" />
          <span className="min-w-0 flex-1 break-words">
            {isZip ? t('ai.artifact.bundle.itemSkipped', { name: it.path || it.name, reason: it.error || '' }) : t('ai.artifact.bundle.itemFailed', { name: it.name })}
          </span>
          <UiButton variant="ghost" size="xs" icon="refresh" disabled={busy} onClick={() => retryOne(it.index)}>{t('ai.artifact.bundle.retryOne')}</UiButton>
        </div>
      ))}
      {badItems.length > LIST_MAX && <p className="m-0 px-4 py-1 text-xs text-muted-foreground">{t('ai.artifact.bundle.more', { n: badItems.length - LIST_MAX })}</p>}
      <p className="m-0 px-4 pb-3 pt-2 text-xs text-muted-foreground"><UiTrans k="ai.artifact.bundle.partialNote" slots={{ n: mono(job.ok) }} /></p>
    </div>
  )

  const footer = (
    <div className="flex flex-col gap-2 px-4 py-2.5">
      {dupN > 0 && <span className="text-xs text-muted-foreground">{t('ai.artifact.bundle.deduped', { n: dupN })}</span>}
      {savedFolder
        ? <SavedLine folder={savedFolder} label={savedLabel} />
        : <div><UiButton size="sm" icon="folder" disabled={save.phase === 'saving'} onClick={doSave}>{t('ai.artifact.save')}</UiButton></div>}
      <SaveRows state={save} onRetry={doSave} />
    </div>
  )

  return (
    <>
      <section aria-label={t(titleKey, { n: job.ok })}
        className={cn('max-w-[760px] overflow-hidden rounded-xl border bg-card', badItems.length ? 'border-warning/45' : 'border-border')}>
        {isMobile ? (
          <div className="flex flex-col gap-0.5 px-3.5 py-3">
            <span className="text-sm font-semibold"><UiTrans k={titleKey} slots={{ n: mono(job.ok) }} /></span>
            <span className="text-xs text-muted-foreground">
              {mono(aiFormatBytes(zip.size))}{' · '}<UiTrans k="ai.artifact.bundle.expiresIn" slots={{ n: mono(hours) }} />
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3">
            <UiIcon name={icon} className="h-[18px] w-[18px] text-primary" />
            <span className="flex-1 text-sm font-semibold">
              <UiTrans k={titleKey} slots={{ n: mono(job.ok) }} />{' · '}{mono(aiFormatBytes(isZip ? zip.size : job.size))}
            </span>
            <span className="text-xs text-muted-foreground"><UiTrans k="ai.artifact.bundle.expiresIn" slots={{ n: mono(hours) }} /></span>
            <UiButton as="a" href={dlAll} download={zip.name} size="sm" icon="download">{t('ai.artifact.bundle.downloadAll')}</UiButton>
          </div>
        )}
        {isMobile ? shown.map(itemRow) : <ul className="m-0 list-none p-0">{shown.map(itemRow)}</ul>}
        {moreOk > 0 && <p className="m-0 border-b border-border px-4 py-2 text-xs text-muted-foreground">{t('ai.artifact.bundle.more', { n: moreOk })}</p>}
        {isMobile && (
          <div className="border-t border-border px-3.5 py-3">
            <UiButton as="a" href={dlAll} download={zip.name} size="lg" icon="download" className="w-full">{t('ai.artifact.bundle.downloadAll')}</UiButton>
          </div>
        )}
        {failBlock}
        {footer}
      </section>
      {previewId && <AiArtifactPreviewModal artifactId={previewId.id} name={previewId.name} downloadUrl={previewId.url} onClose={() => setPreviewId(null)} />}
    </>
  )
}

// ── 미리보기 ─────────────────────────────────────────────────
export function AiArtifactPreviewModal({ artifactId, name, downloadUrl, onClose }: { artifactId: string; name: string; downloadUrl?: string; onClose: () => void }) {
  const { t } = useI18n()
  const [data, setData] = useState<AiArtifactPreview | null | undefined>(undefined)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let alive = true
    aiArtifactsApi.preview(artifactId).then((r) => { if (alive) setData(r.preview) }).catch(() => { if (alive) setErr(true) })
    return () => { alive = false }
  }, [artifactId])

  const table = (header: string[] | undefined, rows: unknown[][] | undefined, more?: number) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12.5px]">
        {!!header?.length && <thead><tr>{header.map((h, i) => <th key={i} className="border border-border bg-muted px-2 py-1 text-left font-semibold">{h}</th>)}</tr></thead>}
        <tbody>{(rows || []).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="border border-border px-2 py-1 align-top">{c == null ? '' : String(c)}</td>)}</tr>)}</tbody>
      </table>
      {!!more && <p className="mt-1 text-xs text-muted-foreground">{t('ai.artifact.moreRows', { n: more })}</p>}
    </div>
  )

  return (
    <UiModal size="680" title={t('ai.artifact.previewOf', { name })} onClose={onClose}
      footer={downloadUrl ? <UiButton as="a" href={downloadUrl} download={name} size="sm" icon="download">{t('ai.artifact.download')}</UiButton> : undefined}>
      <div className="flex max-h-[60dvh] flex-col gap-3 overflow-y-auto text-[14px] leading-[1.65]">
        {data === undefined && !err && <UiSkeleton preset="text" rows={6} />}
        {err && <p className="text-muted-foreground">{t('ai.artifact.previewLoadFailed')}</p>}
        {data === null && <p className="text-muted-foreground">{t('ai.artifact.previewEmpty')}</p>}
        {data && (
          <>
            {data.title && <h2 className="m-0 text-lg font-bold">{data.title}</h2>}
            {data.subtitle && <p className="m-0 text-muted-foreground">{data.subtitle}</p>}
            {data.blocks?.map((b, i) => {
              if (b.type === 'heading') return <h3 key={i} className={cn('m-0 font-semibold', b.level === 1 ? 'text-base' : 'text-[14.5px]')}>{b.text}</h3>
              if (b.type === 'list') {
                const L = b.ordered ? 'ol' : 'ul'
                return <L key={i} className={cn('m-0 pl-5', b.ordered ? 'list-decimal' : 'list-disc')}>{(b.items || []).map((x, j) => <li key={j}>{x}</li>)}</L>
              }
              if (b.type === 'table') return <div key={i}>{table(b.header, b.rows, b.more_rows)}</div>
              if (b.type === 'page_break') return <hr key={i} className="border-dashed border-border" />
              return <p key={i} className="m-0 whitespace-pre-wrap">{b.text}</p>
            })}
            {data.sheets?.map((s, i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <span className="text-[13px] font-semibold">{s.name}</span>
                {table(s.header, s.rows, s.more_rows)}
              </div>
            ))}
            {data.slides?.map((s, i) => (
              <div key={i} className="rounded-lg border border-border p-3">
                <span className="font-mono text-[11px] text-muted-foreground">{t('ai.artifact.slideN', { n: i + 1 })}</span>
                <p className="m-0 font-semibold">{s.title}</p>
                {!!s.bullets?.length && <ul className="m-0 list-disc pl-5">{s.bullets.map((b, j) => <li key={j} style={{ marginLeft: b.level * 16 }}>{b.text}</li>)}</ul>}
                {s.table && table(s.table.header, s.table.rows)}
              </div>
            ))}
          </>
        )}
      </div>
    </UiModal>
  )
}

export default AiArtifacts
