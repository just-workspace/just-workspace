/**
 * 백업 파일 올리기 — 복원 흐름의 첫 화면. 파일을 올리거나(끌어다 놓기 · 고르기), 서버에 이미 있는 파일의 경로를 알려 준다.
 *  - 다 올라간 뒤에도 서버가 파일을 확인(형식 · 해시)하는 동안은 응답이 오지 않는다 — 그동안 "확인 중"을 보인다.
 *  - 올려 둔 백업은 서버가 기억한다. 화면에 다시 들어오면(이어 하기 · 뒤로 가기) 서버에 물어 그 상태를 그대로 보인다.
 *  - 설정이 암호로 보호된 백업이면 암호를 받아 다시 확인한다.
 *  - 서버가 복원을 지원하지 않으면(501) 그 사실을 알리고 시작 방식으로 돌아가게 한다.
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
import { M, useHas, useT } from '../i18n'
import { navigate } from '../router'
import { StepNav, useGoNext } from '../shell/StepNav'
import { Heading, WizardShell } from '../shell/WizardShell'
import { useWizard } from '../store'

const RECHECK_MS = 2000

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

type Way = 'upload' | 'path'
/** 서버가 확인을 마친 백업 하나 — 어느 방법으로 준 것인지와 같이 둔다 */
interface Shown { way: Way; path: string; info: RestoreFileInfo }
/** 요청 자체가 실패했다(파일 상태가 아니라 HTTP 오류) */
interface Failure { way: Way; code: string; vars: Record<string, unknown> }

/** 서버가 아직 올리는 중이거나 확인하는 중인가 */
const working = (info: RestoreFileInfo) => info.state === 'uploading' || info.state === 'checking'
const needsPassword = (info: RestoreFileInfo | null | undefined) => info?.status === 'password_required' || info?.status === 'password_wrong'

export function RestoreFileScreen() {
  const t = useT()
  const has = useHas()
  const api = useWizard(s => s.api)
  const format = useWizard(s => s.server?.info.backup_file_format ?? null)
  const [way, setWay] = useState<Way>('upload')
  const [shown, setShown] = useState<Shown | null>(null)
  const [upload, setUpload] = useState<{ name: string; percent: number } | null>(null)
  /** 다른 창에서 올렸거나 새로 고친 뒤 — 서버가 아직 확인하는 중 */
  const [serverBusy, setServerBusy] = useState(false)
  const [path, setPath] = useState('')
  const [pathChecking, setPathChecking] = useState(false)
  const [password, setPassword] = useState('')
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const abort = useRef<AbortController | null>(null)
  /** 이 화면에서 무언가를 시작했다 — 그 뒤에 도착한 "들어올 때의 상태"는 버린다 */
  const touched = useRef(false)
  const { goNext } = useGoNext('file')

  useEffect(() => () => abort.current?.abort(), [])

  // 들어올 때: 서버가 이미 가지고 있는 백업의 상태를 그대로 보인다
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const read = () => {
      api.restoreFile().then(info => {
        if (!alive || touched.current) return
        const from: Way = info.source === 'path' ? 'path' : 'upload'
        if (working(info)) {
          setWay(from)
          setServerBusy(true)
          timer = setTimeout(read, RECHECK_MS)
          return
        }
        setServerBusy(false)
        if (info.status === 'none') return
        setWay(from)
        if (from === 'path') setPath(info.path ?? '')
        setShown({ way: from, path: info.path ?? '', info })
      }).catch(e => {
        if (!alive) return
        setServerBusy(false)
        if (e instanceof ApiError && e.notImplemented) setUnsupported(true)
      })
    }
    read()
    return () => { alive = false; if (timer != null) clearTimeout(timer) }
  }, [api])

  function fail(from: Way, e: unknown) {
    if (e instanceof ApiError && e.notImplemented) setUnsupported(true)
    setFailure({ way: from, code: e instanceof ApiError ? (e.code ?? '') : '', vars: e instanceof ApiError ? e.vars : {} })
  }

  function begin() {
    touched.current = true
    setServerBusy(false)
    setFailure(null)
  }

  async function send(file: File) {
    begin()
    abort.current?.abort()
    const ctl = new AbortController()
    abort.current = ctl
    setShown(null)
    setPassword('')
    setUpload({ name: file.name, percent: 0 })
    try {
      const info = await api.restoreUpload(file, percent => { if (abort.current === ctl) setUpload({ name: file.name, percent }) }, ctl.signal)
      if (abort.current !== ctl) return
      setShown({ way: 'upload', path: '', info: { ...info, name: info.name ?? file.name } })
    } catch (e) {
      if (abort.current !== ctl) return
      if (!(e instanceof ApiError && e.code === 'aborted')) fail('upload', e)
    }
    setUpload(null)
  }

  async function checkPath() {
    const p = path.trim()
    begin()
    setShown(null)
    setPassword('')
    setPathChecking(true)
    try {
      setShown({ way: 'path', path: p, info: await api.restoreCheckPath(p) })
    } catch (e) {
      fail('path', e)
    }
    setPathChecking(false)
  }

  async function sendPassword() {
    if (!shown || !password) return
    begin()
    setPasswordBusy(true)
    try {
      const info = await api.restorePassword(password)
      setShown({ ...shown, info: { ...info, name: info.name ?? shown.info.name, size_bytes: info.size_bytes ?? shown.info.size_bytes } })
    } catch (e) {
      fail(shown.way, e)
    }
    setPassword('')
    setPasswordBusy(false)
  }

  async function discard() {
    begin()
    try { await api.restoreDiscard() } catch { /* 새 파일을 올리면 서버가 어차피 바꾼다 */ }
    setShown(null)
    setPassword('')
  }

  // 지금 보고 있는 방법으로 준 백업만 그 자리에 보인다(경로는 확인한 그 경로일 때만)
  const cur = shown && shown.way === way && (way === 'upload' || shown.path === path.trim()) ? shown.info : null
  const failed = failure && failure.way === way && !unsupported ? failure : null
  const good = cur?.status === 'ok'
  const locked = needsPassword(cur)
  const pathMissing = way === 'path' && (cur?.status === 'not_found' || (cur?.status === 'invalid' && cur.reason === 'path_invalid'))
  const bad = cur != null && !good && !locked && !pathMissing
  const uploading = way === 'upload' && upload != null
  const verifying = uploading && upload.percent >= 100
  const waiting = serverBusy && !uploading && !pathChecking

  const badKey = cur ? `restore.bad.${cur.status === 'invalid' ? (cur.reason ?? '') : cur.status}` : ''
  const failText = failed
    ? (has(`restore.uploadError.${failed.code}`)
        ? t(`restore.uploadError.${failed.code}`, {
            need: typeof failed.vars.need_bytes === 'number' ? bytesText(failed.vars.need_bytes) : '',
            free: typeof failed.vars.free_bytes === 'number' ? bytesText(failed.vars.free_bytes) : '',
          })
        : t(failed.way === 'upload' ? 'restore.uploadFailed' : 'common.probeFailed'))
    : ''

  let blocked = ''
  if (unsupported) blocked = t('common.notSupported')
  else if (waiting) blocked = t('restore.reasonChecking')
  else if (locked) blocked = t('restore.reasonPassword')
  else if (way === 'upload') {
    if (verifying) blocked = t('restore.reasonChecking')
    else if (uploading) blocked = t('restore.reasonUploading')
    else if (!cur) blocked = t('restore.reasonEmpty')
    else if (bad) blocked = t('restore.reasonBad')
  } else if (pathChecking) blocked = t('restore.reasonPathChecking')
  else if (pathMissing || bad || failed) blocked = t('restore.reasonPathBad')
  else if (!cur) blocked = t('restore.reasonPathEmpty')

  const discardButton = <UiButton type="button" size="sm" variant="outline" onClick={() => { void discard() }}>{t('restore.discard')}</UiButton>
  return (
    <WizardShell step="file">
      <Heading title={t('restore.fileTitle')} lead={t('restore.fileLead')} />
      {unsupported && <RestoreUnsupported />}
      <div className="max-w-full overflow-x-auto">
        <UiSegment
          ariaLabel={t('restore.wayLabel')}
          items={[{ value: 'upload', label: t('restore.wayUpload') }, { value: 'path', label: t('restore.wayPath') }]}
          modelValue={way}
          onUpdateModelValue={v => { if (v != null) setWay(v as Way) }}
        />
      </div>
      {waiting && <UiCallout variant="plain" tone="neutral" icon="loader" spin role="status" title={t('restore.checkingTitle')}>{t('restore.checkingBody')}</UiCallout>}
      {way === 'upload' && !waiting && !uploading && !cur && (
        <>
          <UiDropzone
            title={t('restore.dropTitle')}
            buttonLabel={t('restore.choose')}
            buttonIcon="folder"
            accept={format ?? undefined}
            description={format ? <M k="restore.format" v={{ format }} /> : undefined}
            onFiles={f => { void send(f[0]) }}
          />
          {failed && <UiCallout tone="danger" role="alert">{failText}</UiCallout>}
        </>
      )}
      {uploading && (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex shrink-0 text-muted-foreground"><UiIcon name="file-zip" aria-hidden="true" className="size-[18px]" /></span>
            <span className="flex min-w-0 flex-1 basis-40 flex-col">
              <span className="break-all font-mono text-[13px] font-semibold leading-5">{upload.name}</span>
              <span role="status" className="text-xs leading-4 text-muted-foreground">{verifying ? t('restore.verifying') : t('restore.uploading', { n: upload.percent })}</span>
            </span>
            <UiButton type="button" variant="outline" size="sm" onClick={() => abort.current?.abort()}>{t('restore.cancel')}</UiButton>
          </div>
          <UiProgress size="sm" label={t(verifying ? 'restore.checkingTitle' : 'restore.uploadingLabel')} value={verifying ? null : upload.percent} />
        </div>
      )}
      {way === 'upload' && !uploading && cur && (
        <UiDropzone
          layout="row"
          filled
          icon="file-zip"
          title={<span className="break-all font-mono text-[13px]">{cur.name}</span>}
          description={cur.size_bytes != null ? <span className="font-mono">{bytesText(cur.size_bytes)}</span> : undefined}
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
              error={pathMissing ? t('restore.pathError') : (failed ? failText : undefined)}
              hint={t('restore.pathHint')}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <UiButton type="button" variant="outline" size="sm" icon="refresh" disabled={pathChecking || waiting || !path.trim().startsWith('/')} onClick={() => { void checkPath() }}>{t('restore.pathCheck')}</UiButton>
            {pathChecking && <UiCallout variant="plain" tone="neutral" icon="loader" spin role="status" className="flex-1">{t('restore.pathChecking')}</UiCallout>}
          </div>
        </>
      )}
      {good && <UiCallout variant="plain" tone="success" role="status" title={t('restore.good')} actions={discardButton}>{t('restore.goodBody')}</UiCallout>}
      {locked && (
        <UiCallout tone="warning" title={t('restore.passwordTitle')}>
          <span>{t('restore.passwordBody')}</span>
          <form className="mt-3 flex max-w-[400px] flex-col gap-3 text-foreground" onSubmit={e => { e.preventDefault(); void sendPassword() }}>
            <UiInput
              label={t('restore.passwordLabel')}
              type="password"
              autocomplete="off"
              modelValue={password}
              onUpdateModelValue={setPassword}
              error={cur?.status === 'password_wrong' && !passwordBusy && password === '' ? t('restore.passwordWrong') : (failed ? failText : undefined)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <UiButton type="submit" size="sm" disabled={passwordBusy || password === ''}>{t(passwordBusy ? 'restore.passwordChecking' : 'restore.passwordConfirm')}</UiButton>
              {discardButton}
            </div>
          </form>
        </UiCallout>
      )}
      {bad && (
        <UiCallout tone="danger" role="alert" title={t('restore.badTitle')} actions={discardButton}>
          {has(badKey) ? t(badKey) : t('restore.badBody')}
        </UiCallout>
      )}
      <StepNav step="file" blocked={blocked} onNext={() => goNext()} />
    </WizardShell>
  )
}
