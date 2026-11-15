/**
 * 업데이트 › 오프라인 업데이트 — 인터넷에 나갈 수 없는 서버를 묶음 파일로 올린다.
 *
 *  1. 묶음 파일을 준다: 브라우저로 올리거나, 서버에 먼저 옮겨 둔 파일의 경로를 알려 준다.
 *  2. 서버가 서명과 버전을 검증한다(올리는 중 → 검증 중 → 검증됨 / 서명 불일치 / 버전 낮음 / 파일 없음).
 *  3. 묶음에 들어 있지 않은 이미지(데이터베이스·캐시·웹 서버 + 켠 구역의 구성 요소)를 줄마다 올린다.
 *  4. 전부 갖춰져야 "적용"이 켜진다 — 막혀 있는 동안에는 그 이유를 버튼 옆에 적는다.
 *
 * 두 방식 모두 같은 검증 결과·같은 차단 규칙을 쓴다.
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useI18n } from '~/i18n'
import { cn } from '~/lib/utils'
import { writeClipboard } from '~/lib/clipboard'
import { addToast } from '~/composables/useToast'
import {
  updateApi, errorCode, formatBytes, jobPath, localized, offlineBlock,
  type ExtraImage, type ExtraImageState, type OfflineState,
} from '~/composables/useSystemUpdate'
import { useDurationText } from '~/components/layout/UpdateCountdownBanner'
import { Row, Mono, Unavailable, useLoad, usePoll } from '~/components/admin/update/parts'
import { UiCard } from '~/components/ui/Card'
import { UiButton } from '~/components/ui/Button'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiIcon } from '~/components/ui/Icon'
import { UiCallout } from '~/components/ui/Callout'
import { UiSegment } from '~/components/ui/Segment'
import { UiInput } from '~/components/ui/Input'
import { UiDropzone } from '~/components/ui/Dropzone'
import { UiProgress } from '~/components/ui/Progress'
import { UiTable } from '~/components/ui/Table'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiTrans } from '~/components/ui/Trans'

const IMAGE_LOOK: Record<ExtraImageState, { icon: string; color: string; spin?: boolean }> = {
  present: { icon: 'check-circle', color: 'text-success' },
  missing: { icon: 'alert-circle', color: 'text-danger' },
  verifying: { icon: 'loader', color: 'text-muted-foreground', spin: true },
  hash_mismatch: { icon: 'alert-triangle', color: 'text-danger' },
  not_needed: { icon: 'minus', color: 'text-muted-foreground' },
}

export function OfflineTab() {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const duration = useDurationText()
  const offline = useLoad(() => updateApi.offline())
  const [way, setWay] = useState<'upload' | 'path' | null>(null)
  const [path, setPath] = useState('')
  const [upload, setUpload] = useState<{ name: string; percent: number } | null>(null)
  const [imageUp, setImageUp] = useState<Record<string, number>>({})
  const [pathBusy, setPathBusy] = useState(false)
  const [applying, setApplying] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const pickFor = useRef<ExtraImage | null>(null)

  const state = offline.data
  const bundle = state?.bundle ?? null
  useEffect(() => () => { abort.current?.abort() }, [])

  const waiting = !!bundle && (bundle.state === 'uploading' || bundle.state === 'verifying')
  usePoll(waiting || !!state?.images.some(i => i.state === 'verifying'), () => offline.reload())

  if (offline.unavailable) return <Unavailable reason={offline.unavailable} />
  if (!state) {
    return offline.error
      ? <UiErrorTile placement="card" title={t('admin.update.offline.loadError')} onRetry={() => { void offline.reload() }} />
      : <UiCard><UiSkeleton preset="list" rows={4} /></UiCard>
  }

  const mode = way ?? bundle?.source ?? 'upload'
  const fail = (e: any, fallback: string) => addToast('error', errorCode(e) === 'busy' ? t('admin.update.busy') : errorCode(e) === 'too_large' ? t('admin.update.offline.tooLarge') : e?.data?.detail || fallback)

  async function sendBundle(file: File) {
    abort.current = new AbortController()
    setUpload({ name: file.name, percent: 0 })
    try {
      offline.set(await updateApi.offlineUpload(file, p => setUpload({ name: file.name, percent: p }), abort.current.signal))
    } catch (e: any) {
      if (!e?.aborted) fail(e, t('admin.update.offline.uploadFailed'))
    } finally { setUpload(null); abort.current = null }
  }
  async function clear() {
    abort.current?.abort()
    try { offline.set(await updateApi.offlineClear()) } catch (e) { fail(e, t('admin.update.offline.clearFailed')) }
  }
  async function checkPath() {
    setPathBusy(true)
    try { offline.set(await updateApi.offlinePath(path.trim())) } catch (e) { fail(e, t('admin.update.offline.pathFailed')) } finally { setPathBusy(false) }
  }
  async function sendImage(image: ExtraImage, file: File) {
    setImageUp(m => ({ ...m, [image.id]: 0 }))
    try {
      offline.set(await updateApi.offlineImage(image.id, file, p => setImageUp(m => ({ ...m, [image.id]: p }))))
    } catch (e) {
      fail(e, t('admin.update.offline.uploadFailed'))
    } finally { setImageUp((m) => { const { [image.id]: _gone, ...rest } = m; return rest }) }
  }
  async function copy(image: ExtraImage) {
    try { await writeClipboard(image.command ?? ''); addToast('success', t('admin.update.offline.copied')) } catch { addToast('error', t('common.copyFailed')) }
  }
  async function apply() {
    setApplying(true)
    try {
      navigate(jobPath(await updateApi.offlineApply()))
    } catch (e) {
      fail(e, t('admin.update.offline.applyFailed'))
      void offline.reload()
      setApplying(false)
    }
  }

  const uploading = !!upload
  const block = offlineBlock(state, uploading)
  // 방식마다 아직 아무것도 주지 않았을 때의 안내가 다르다
  const reason = block === 'empty' && mode === 'path' ? t('admin.update.offline.block.emptyPath') : block ? t(`admin.update.offline.block.${block}`) : ''
  const shown = bundle && !uploading ? bundle : null
  const judged = !!shown && ['verified', 'signature_mismatch', 'version_too_low'].includes(shown.state)
  const verified = shown?.state === 'verified'
  const sigBad = shown?.state === 'signature_mismatch'
  const verBad = shown?.state === 'version_too_low'
  const busyFile = uploading || waiting
  const needed = state.images.filter(i => i.state !== 'not_needed')
  const lacking = needed.filter(i => i.state !== 'present')
  const mismatch = needed.find(i => i.state === 'hash_mismatch')
  const down = duration(shown?.downtime_seconds)
  const contains = [
    shown?.contains?.images ? t('admin.update.offline.contains.images') : '',
    shown?.contains?.apps?.length ? t('admin.update.offline.contains.apps') : '',
  ].filter(Boolean).join(', ')
  const fileNote = uploading ? t('admin.update.offline.uploading', { percent: upload!.percent })
    : shown?.state === 'uploading' ? t('admin.update.offline.uploadingElse')
      : shown?.state === 'verifying' ? t('admin.update.offline.verifying')
        : formatBytes(shown?.size_bytes)

  const alert = sigBad ? 'signature' : verBad ? 'version' : shown?.state === 'invalid' ? 'invalid' : mismatch ? 'image' : null

  return (
    <>
      <p className="text-[13px] text-muted-foreground">
        {t('admin.update.offline.intro')}
        {state.download_url && <>{' '}<UiTrans k="admin.update.offline.introUrl" slots={{ url: <Mono className="break-all text-foreground">{state.download_url}</Mono> }} /></>}
      </p>

      <div className="flex">
        <UiSegment ariaLabel={t('admin.update.offline.wayAria')} modelValue={mode} onUpdateModelValue={v => { if (v != null) setWay(v as 'upload' | 'path') }}
          items={[{ value: 'upload', label: t('admin.update.offline.wayUpload') }, { value: 'path', label: t('admin.update.offline.wayPath') }]} />
      </div>

      {mode === 'path' && (
        <>
          <UiInput mono label={t('admin.update.offline.pathLabel')} hint={t('admin.update.offline.pathHint')} modelValue={path} onUpdateModelValue={setPath}
            error={shown?.source === 'path' && shown.state === 'file_missing' ? t('admin.update.offline.pathMissing') : undefined} />
          <div className="flex flex-wrap items-center gap-3">
            <UiButton variant="outline" icon="refresh" disabled={!path.trim() || pathBusy || waiting} onClick={() => { void checkPath() }}>{t('admin.update.offline.pathCheck')}</UiButton>
            {(pathBusy || (shown?.source === 'path' && waiting)) && (
              <span role="status" className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground" data-testid="offline-path-busy">
                <UiIcon name="loader" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t('admin.update.offline.pathChecking')}
              </span>
            )}
            {shown?.source === 'path' && verified && (
              <span role="status" className="inline-flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-success" data-testid="offline-path-ok">
                <UiIcon name="check-circle" className="h-4 w-4" />{t('admin.update.offline.pathOk')} · <Mono>{shown.filename}</Mono>{formatBytes(shown.size_bytes) && <> · <Mono>{formatBytes(shown.size_bytes)}</Mono></>}
              </span>
            )}
          </div>
        </>
      )}

      {mode === 'upload' && (!shown || shown.source !== 'upload') && !uploading && (
        <UiDropzone data-testid="offline-drop" title={t('admin.update.offline.drop')} buttonLabel={t('admin.update.offline.choose')} buttonIcon="folder" accept={state.accept ?? undefined}
          description={state.accept ? <UiTrans k="admin.update.offline.format" slots={{ ext: <Mono>{state.accept}</Mono> }} /> : undefined}
          onFiles={(files) => { if (files[0]) void sendBundle(files[0]) }} />
      )}
      {mode === 'upload' && (uploading || shown?.source === 'upload') && (
        <UiCard data-testid="offline-file">
          <div className="flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <UiIcon name="file-zip" className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 basis-[200px] flex-col">
                <span className="truncate font-mono text-[13px]">{uploading ? upload!.name : shown?.filename}</span>
                {fileNote && <span className="text-xs text-muted-foreground" role={busyFile ? 'status' : undefined}>{fileNote}</span>}
              </span>
              <UiButton size="sm" variant="outline" onClick={() => { void clear() }}>{busyFile ? t('common.cancel') : t('admin.update.offline.replace')}</UiButton>
            </div>
            {busyFile && <UiProgress size="sm" label={fileNote} value={uploading ? upload!.percent : shown?.percent ?? null} />}
          </div>
        </UiCard>
      )}

      {judged && shown && (
        <UiCard className="overflow-hidden" data-testid="offline-verdict">
          <dl className="flex flex-col text-[13.5px]">
            <Row first label={t('admin.update.offline.sig')}>
              <span className={cn('inline-flex items-center gap-1.5', sigBad ? 'text-danger' : 'text-success')}>
                <UiIcon name={sigBad ? 'alert-circle' : 'check-circle'} className="h-4 w-4" />
                <span className="text-foreground">{sigBad ? t('admin.update.offline.sigBad') : t('admin.update.offline.sigOk')}</span>
              </span>
            </Row>
            <Row label={t('admin.update.notes.version')}>
              {shown.version ? (
                <span className={cn('inline-flex flex-wrap items-center gap-1.5', verBad ? 'text-danger' : 'text-success')}>
                  <UiIcon name={verBad ? 'alert-circle' : 'check-circle'} className="h-4 w-4" />
                  <span className="text-foreground">
                    {verBad ? <><Mono>{shown.version}</Mono> · {t('admin.update.offline.verBad')}</> : <Mono>{[shown.current_version, shown.version].filter(Boolean).join(' → ')}</Mono>}
                  </span>
                </span>
              ) : null}
            </Row>
            <Row label={t('admin.update.offline.containsLabel')}>{verified && contains ? contains : null}</Row>
            <Row label={t('admin.update.notes.downtime')}>{verified && down ? <Mono>{down}</Mono> : null}</Row>
          </dl>
        </UiCard>
      )}

      {verified && state.images.length > 0 && (
        <UiCard className="overflow-hidden" data-testid="offline-images">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
            <h2 className="text-base font-semibold leading-6">{t('admin.update.offline.extra.title')}</h2>
            <span className="text-[13px] text-muted-foreground" data-testid="offline-tally">
              {lacking.length ? <UiTrans k="admin.update.offline.extra.lacking" slots={{ n: <Mono>{lacking.length}</Mono> }} /> : t('admin.update.offline.extra.allPresent')}
            </span>
          </div>
          <UiTable
            className="border-t border-border"
            label={t('admin.update.offline.extra.title')}
            minWidthClass="min-w-[620px]"
            rows={state.images}
            rowKey={r => r.id}
            columns={[
              { key: 'name', header: t('admin.update.offline.extra.name'), cell: r => localized(r.name, locale) || r.id },
              {
                key: 'zone', header: t('admin.update.offline.extra.usedBy'),
                cell: r => (r.reason === 'always' || !r.zone
                  ? t('admin.update.offline.extra.always')
                  : t(r.zone_enabled ? 'admin.update.offline.extra.zoneOn' : 'admin.update.offline.extra.zoneOff', { zone: localized(r.zone.name, locale) || r.zone.id })),
              },
              {
                key: 'state', header: t('admin.update.offline.extra.state'),
                cell: (r) => {
                  const up = imageUp[r.id]
                  const look = IMAGE_LOOK[r.state] ?? IMAGE_LOOK.missing
                  if (up != null) return <span className="inline-flex items-center gap-1.5"><UiIcon name="loader" className="h-4 w-4 animate-spin text-muted-foreground motion-reduce:animate-none" />{t('admin.update.offline.uploading', { percent: up })}</span>
                  return (
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" data-testid={`offline-image-${r.id}`} data-state={r.state}>
                      <UiIcon name={look.icon} className={cn('h-4 w-4', look.color, look.spin && 'animate-spin motion-reduce:animate-none')} />
                      {t(`admin.update.offline.extra.status.${r.state}`)}
                    </span>
                  )
                },
              },
              {
                key: 'act', header: '',
                cell: (r) => {
                  const name = localized(r.name, locale) || r.id
                  if (r.state === 'not_needed') return null
                  return (
                    <div className="-my-1.5 flex justify-end gap-1">
                      {r.command && <UiIconButton icon="copy" label={t('admin.update.offline.extra.copy', { name })} onClick={() => { void copy(r) }} />}
                      <UiIconButton icon="upload" label={t('admin.update.offline.extra.upload', { name })} disabled={imageUp[r.id] != null || r.state === 'verifying'}
                        onClick={() => { pickFor.current = r; fileInput.current?.click() }} />
                    </div>
                  )
                },
              },
            ]}
          />
          <p className="border-t border-border px-4 py-3 text-xs leading-[18px] text-muted-foreground">{t('admin.update.offline.extra.footnote')}</p>
          <input ref={fileInput} type="file" className="hidden" data-testid="offline-image-input" aria-hidden="true" tabIndex={-1}
            onChange={(e) => { const f = e.target.files?.[0]; const target = pickFor.current; e.target.value = ''; if (f && target) void sendImage(target, f) }} />
        </UiCard>
      )}

      {alert && (
        <UiCallout tone="danger" role="alert" data-testid="offline-alert"
          title={alert === 'image' ? t('admin.update.offline.alert.image.title', { name: localized(mismatch!.name, locale) || mismatch!.id }) : t(`admin.update.offline.alert.${alert}.title`)}>
          {alert === 'version'
            ? <UiTrans k="admin.update.offline.alert.version.body" slots={{ bundle: <Mono>{shown?.version}</Mono>, current: <Mono>{shown?.current_version}</Mono> }} />
            : t(`admin.update.offline.alert.${alert}.body`)}
        </UiCallout>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
        <span role="status" className="min-w-0 flex-1 basis-[240px] text-[13px] text-muted-foreground" data-testid="offline-reason">{reason}</span>
        <UiButton icon="arrow-right" disabled={!!block || applying} onClick={() => { void apply() }}>{t('admin.update.offline.apply')}</UiButton>
      </div>
    </>
  )
}

export default OfflineTab
