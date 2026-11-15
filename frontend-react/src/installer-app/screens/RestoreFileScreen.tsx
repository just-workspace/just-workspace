/**
 * 백업 파일 올리기 — 복원 흐름의 첫 화면. 파일을 올리거나(끌어다 놓기 · 고르기), 서버에 이미 있는 파일의 경로를 알려 준다.
 * 서버가 복원을 아직 지원하지 않으면(501) 그 사실을 알리고 시작 방식으로 돌아가게 한다.
 */
import { useEffect, useRef, useState } from 'react'
import { UiButton } from '~/components/ui/Button'
import { UiCallout } from '~/components/ui/Callout'
import { UiDropzone } from '~/components/ui/Dropzone'
import { UiIcon } from '~/components/ui/Icon'
import { UiInput } from '~/components/ui/Input'
import { UiProgress } from '~/components/ui/Progress'
import { UiSegment } from '~/components/ui/Segment'
import { ApiError, type RestoreFileInfo } from '../api/types'
import { bytesText } from '../format'
import { M, useT } from '../i18n'
import { navigate } from '../router'
import { StepNav, useGoNext } from '../shell/StepNav'
import { Heading, WizardShell } from '../shell/WizardShell'
import { useWizard } from '../store'

/** 복원을 아직 지원하지 않는 서버에서 보이는 안내 */
export function RestoreUnsupported() {
  const t = useT()
  return (
    <UiCallout
      tone="warning"
      role="alert"
      title={t('common.notSupported')}
      actions={<UiButton type="button" size="sm" variant="secondary" onClick={() => navigate('start')}>{t('common.backToStart')}</UiButton>}
    >
      {t('common.notSupportedBody')}
    </UiCallout>
  )
}

type Upload =
  | { state: 'empty' }
  | { state: 'uploading'; name: string; percent: number }
  | { state: 'done'; info: RestoreFileInfo }
  | { state: 'failed'; name: string }
type PathCheck = { state: 'idle' | 'checking' | 'failed' } | { state: 'done'; path: string; info: RestoreFileInfo }

export function RestoreFileScreen() {
  const t = useT()
  const api = useWizard(s => s.api)
  const format = useWizard(s => s.server?.info.backup_file_format ?? null)
  const [way, setWay] = useState<'upload' | 'path'>('upload')
  const [upload, setUpload] = useState<Upload>({ state: 'empty' })
  const [path, setPath] = useState('')
  const [check, setCheck] = useState<PathCheck>({ state: 'idle' })
  const [unsupported, setUnsupported] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const { goNext } = useGoNext('file')

  useEffect(() => () => abort.current?.abort(), [])

  async function send(file: File) {
    abort.current?.abort()
    const ctl = new AbortController()
    abort.current = ctl
    setUpload({ state: 'uploading', name: file.name, percent: 0 })
    try {
      const info = await api.restoreUpload(file, percent => setUpload({ state: 'uploading', name: file.name, percent }), ctl.signal)
      setUpload({ state: 'done', info: { ...info, name: info.name ?? file.name } })
    } catch (e) {
      if (e instanceof ApiError && e.notImplemented) setUnsupported(true)
      if (e instanceof ApiError && e.code === 'aborted') setUpload({ state: 'empty' })
      else setUpload({ state: 'failed', name: file.name })
    }
  }

  async function checkPath() {
    const p = path.trim()
    setCheck({ state: 'checking' })
    try {
      setCheck({ state: 'done', path: p, info: await api.restoreCheckPath(p) })
    } catch (e) {
      if (e instanceof ApiError && e.notImplemented) setUnsupported(true)
      setCheck({ state: 'failed' })
    }
  }

  const pathInfo = check.state === 'done' && check.path === path.trim() ? check.info : null
  const good = way === 'upload' ? upload.state === 'done' && upload.info.status === 'ok' : pathInfo?.status === 'ok'
  const bad = way === 'upload' && upload.state === 'done' && upload.info.status !== 'ok'
  const pathBad = way === 'path' && ((pathInfo != null && pathInfo.status !== 'ok') || check.state === 'failed')

  let blocked = ''
  if (unsupported) blocked = t('common.notSupported')
  else if (way === 'upload') {
    if (upload.state === 'empty' || upload.state === 'failed') blocked = t('restore.reasonEmpty')
    else if (upload.state === 'uploading') blocked = t('restore.reasonUploading')
    else if (bad) blocked = t('restore.reasonBad')
  } else if (check.state === 'checking') blocked = t('restore.reasonPathChecking')
  else if (pathBad) blocked = t('restore.reasonPathBad')
  else if (!pathInfo) blocked = t('restore.reasonPathEmpty')

  return (
    <WizardShell step="file">
      <Heading title={t('restore.fileTitle')} lead={t('restore.fileLead')} />
      {unsupported && <RestoreUnsupported />}
      <div className="max-w-full overflow-x-auto">
        <UiSegment
          ariaLabel={t('restore.wayLabel')}
          items={[{ value: 'upload', label: t('restore.wayUpload') }, { value: 'path', label: t('restore.wayPath') }]}
          modelValue={way}
          onUpdateModelValue={v => { if (v != null) setWay(v as 'upload' | 'path') }}
        />
      </div>
      {way === 'upload' && (upload.state === 'empty' || upload.state === 'failed') && (
        <>
          <UiDropzone
            title={t('restore.dropTitle')}
            buttonLabel={t('restore.choose')}
            buttonIcon="folder"
            accept={format ?? undefined}
            description={format ? <M k="restore.format" v={{ format }} /> : undefined}
            onFiles={f => { void send(f[0]) }}
          />
          {upload.state === 'failed' && !unsupported && <UiCallout tone="danger" role="alert">{t('restore.uploadFailed')}</UiCallout>}
        </>
      )}
      {way === 'upload' && upload.state === 'uploading' && (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex shrink-0 text-muted-foreground"><UiIcon name="file-zip" aria-hidden="true" className="size-[18px]" /></span>
            <span className="flex min-w-0 flex-1 basis-40 flex-col">
              <span className="break-all font-mono text-[13px] font-semibold leading-5">{upload.name}</span>
              <span className="text-xs leading-4 text-muted-foreground">{t('restore.uploading', { n: upload.percent })}</span>
            </span>
            <UiButton type="button" variant="outline" size="sm" onClick={() => abort.current?.abort()}>{t('restore.cancel')}</UiButton>
          </div>
          <UiProgress size="sm" label={t('restore.uploadingLabel')} value={upload.percent} />
        </div>
      )}
      {way === 'upload' && upload.state === 'done' && (
        <UiDropzone
          layout="row"
          filled
          icon="file-zip"
          title={<span className="break-all font-mono text-[13px]">{upload.info.name}</span>}
          description={upload.info.size_bytes != null ? <span className="font-mono">{bytesText(upload.info.size_bytes)}</span> : undefined}
          buttonLabel={t('restore.replace')}
          accept={format ?? undefined}
          onFiles={f => { void send(f[0]) }}
        />
      )}
      {way === 'path' && (
        <>
          <div className="max-w-[520px]">
            <UiInput
              label={t('restore.pathLabel')}
              mono
              placeholder={t('restore.pathPlaceholder')}
              modelValue={path}
              onUpdateModelValue={setPath}
              error={pathBad && !unsupported ? t('restore.pathError') : undefined}
              hint={t('restore.pathHint')}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <UiButton type="button" variant="outline" size="sm" icon="refresh" disabled={check.state === 'checking' || !path.trim().startsWith('/')} onClick={() => { void checkPath() }}>{t('restore.pathCheck')}</UiButton>
            {check.state === 'checking' && <UiCallout variant="plain" tone="neutral" icon="loader" spin role="status" className="flex-1">{t('restore.pathChecking')}</UiCallout>}
          </div>
        </>
      )}
      {good && <UiCallout variant="plain" tone="success" role="status" title={t('restore.good')}>{t('restore.goodBody')}</UiCallout>}
      {bad && <UiCallout tone="danger" role="alert" title={t('restore.badTitle')}>{t('restore.badBody')}</UiCallout>}
      <StepNav step="file" blocked={blocked} onNext={() => goNext()} />
    </WizardShell>
  )
}
