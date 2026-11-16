/**
 * 파일 저장 위치 — 이 서버의 디스크(기본) 또는 네트워크 저장소(NFS). 설치 후 이전이 어려운 결정이므로 독립 단계로 둔다.
 *  - 이 서버의 디스크: 사전 준비 사항이 없다. 필요 시 저장 폴더를 지정하며, 지정한 경우 해당 폴더를 확인해야 한다.
 *  - 네트워크 저장소: 서버 주소와 공유 경로를 입력하고 "연결 확인"을 눌러 1~4번 검사를 통과해야 한다.
 */
import { useState } from 'react'
import { UiButton } from '~/components/ui/Button'
import { UiCallout } from '~/components/ui/Callout'
import { UiCard } from '~/components/ui/Card'
import { UiDisclosure } from '~/components/ui/Disclosure'
import { UiInput } from '~/components/ui/Input'
import { UiRadioCard } from '~/components/ui/RadioCard'
import type { StorageKind } from '../api/types'
import { isHostPath, trim1 } from '../format'
import { useHas, useT } from '../i18n'
import { CheckList } from '../parts/CheckList'
import { NfsFields, nfsRows, nfsView } from '../parts/NfsCheck'
import { StepNav, useGoNext } from '../shell/StepNav'
import { Heading, WizardShell } from '../shell/WizardShell'
import { useWizard } from '../store'

export function StorageScreen() {
  const t = useT()
  const has = useHas()
  const saved = useWizard(s => s.answers.storage)
  const defaultPath = useWizard(s => s.server?.info.default_storage_path ?? null)
  const freeGb = useWizard(s => {
    const disk = s.preflight?.items.find(i => i.id === 'disk')?.value as { free_gb?: number } | null | undefined
    return disk?.free_gb ?? s.server?.facts.disk_free_gb ?? null
  })
  const nfs = useWizard(s => s.nfs)
  const local = useWizard(s => s.localPath)
  const checkLocalPath = useWizard(s => s.checkLocalPath)
  const [kind, setKind] = useState<StorageKind>(saved.kind)
  const [path, setPath] = useState(saved.path ?? '')
  const [server, setServer] = useState(saved.server ?? '')
  const [exportPath, setExportPath] = useState(saved.export ?? '')
  const { goNext } = useGoNext('storage')

  const dir = path.trim()
  const dirFormatBad = dir !== '' && !isHostPath(dir)
  // 이전에 저장한 폴더는 이미 확인을 거친 것으로 간주
  const dirKnownGood = dir !== '' && dir === (saved.path ?? '') && saved.kind === 'local'
  const dirResult = local.key === dir && local.status === 'done' ? local.result : null
  const dirChecking = local.key === dir && local.status === 'checking'
  const dirOk = dirKnownGood || dirResult?.status === 'ok'
  const view = nfsView(nfs, server, exportPath)
  // 이전에 확인 후 저장한 공유를 변경하지 않았으면 재확인 불필요
  const nfsKnownGood = saved.kind === 'nfs' && server.trim() !== '' && server.trim() === (saved.server ?? '') && exportPath.trim() === (saved.export ?? '')

  let blocked = ''
  if (kind === 'nfs') {
    if (view === 'input') blocked = nfsKnownGood ? '' : t('storage.reasonInput')
    else if (view === 'error') blocked = t('storage.reasonInput')
    else if (view === 'checking') blocked = t('storage.reasonChecking')
    else if (view === 'failed') blocked = t('storage.reasonFailed')
  } else if (dir !== '') {
    if (dirFormatBad || (dirResult && dirResult.status !== 'ok')) blocked = t('storage.reasonDirBad')
    else if (!dirOk) blocked = dirChecking ? t('storage.reasonChecking') : t('storage.reasonDir')
  }

  const dirError = dirFormatBad
    ? t('storage.dirFormat')
    : (dirResult && dirResult.status !== 'ok'
        ? t(dirResult.status === 'not_found' ? 'storage.dirNotFound' : (dirResult.status === 'not_writable' ? 'storage.dirNotWritable' : 'storage.dirError'))
        : (local.key === dir && local.status === 'error' ? t('common.probeFailed') : undefined))
  const pick = (v: string | number | null) => { if (v != null) setKind(v as StorageKind) }

  return (
    <WizardShell step="storage">
      <Heading title={t('storage.title')} lead={t('storage.lead')} />
      <div role="radiogroup" aria-label={t('storage.groupLabel')} className="flex flex-col gap-2">
        <UiRadioCard className="w-full" layout="row" value="local" title={t('storage.localTitle')} description={freeGb != null ? t('storage.localDescFree', { gb: trim1(freeGb) }) : t('storage.localDesc')} modelValue={kind} onUpdateModelValue={pick} />
        <UiRadioCard className="w-full" layout="row" value="nfs" title={t('storage.nfsTitle')} description={t('storage.nfsDesc')} modelValue={kind} onUpdateModelValue={pick} />
      </div>
      {kind === 'local' && (
        <UiDisclosure
          title={t('storage.dirTitle')}
          defaultOpen={dir !== ''}
          description={dir
            ? <span>{t('storage.dirDescCustom', { path: dir })}</span>
            : (defaultPath ? <span>{t('storage.dirDescDefault', { path: defaultPath })}</span> : t('storage.dirDescDefaultNoPath'))}
        >
          <div className="flex flex-col gap-3 px-4 pb-4 pt-1">
            <div className="max-w-[440px]">
              <UiInput label={t('storage.dirLabel')} mono placeholder={defaultPath ?? '/srv/workspace/files'} modelValue={path} onUpdateModelValue={setPath} error={dirError} hint={t('storage.dirHint')} />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <UiButton type="button" variant="outline" size="sm" icon="refresh" disabled={dir === '' || dirFormatBad || dirChecking} onClick={() => { void checkLocalPath(dir) }}>{t('storage.dirCheck')}</UiButton>
              {dirChecking && <UiCallout variant="plain" tone="neutral" icon="loader" spin role="status" className="flex-1">{t('status.checking')}</UiCallout>}
              {dirResult?.status === 'ok' && (
                <UiCallout variant="plain" tone="success" role="status" className="flex-1">
                  {dirResult.free_gb != null ? t('storage.dirOkFree', { gb: trim1(dirResult.free_gb) }) : t('storage.dirOk')}
                </UiCallout>
              )}
            </div>
          </div>
        </UiDisclosure>
      )}
      {kind === 'nfs' && (
        <>
          <UiCard className="p-4">
            <NfsFields server={server} exportPath={exportPath} onServer={setServer} onExport={setExportPath} hint={t('storage.checkHint')} />
          </UiCard>
          {view === 'error' && <UiCallout tone="danger" role="alert">{t('common.probeFailed')}</UiCallout>}
          {(view === 'checking' || view === 'ok' || view === 'failed') && (
            <CheckList title={t('storage.resultTitle')} rows={nfsRows(view, nfs.result, server, exportPath, t, has)} />
          )}
        </>
      )}
      <UiCallout variant="plain" tone="info">{t('storage.fixedNote')}</UiCallout>
      <StepNav
        step="storage"
        blocked={blocked}
        onNext={() => goNext({
          storage: kind === 'nfs'
            ? { kind: 'nfs', server: server.trim(), export: exportPath.trim(), path: null }
            : { kind: 'local', path: dir || null, server: null, export: null },
        })}
      />
    </WizardShell>
  )
}
