/**
 * 네트워크 저장소 연결 확인 — 입력 두 칸(서버 주소 · 공유 경로)과 "연결 확인", 그리고 검사 다섯 가지의 결과.
 * 파일 저장 위치 화면과 복원의 내용 확인 화면이 같이 쓴다.
 * 1~4번(닿는가 · 붙는가 · 쓰기 · 잠금)이 통과해야 진행할 수 있다. 5번(여유 공간)은 보여 주기만 한다.
 */
import { UiButton } from '~/components/ui/Button'
import { UiInput } from '~/components/ui/Input'
import type { NfsProbe } from '../api/types'
import { isHostname, trim1 } from '../format'
import { useT, type Translate } from '../i18n'
import { nfsKey, useWizard, type Probe } from '../store'
import type { CheckRow, CheckState } from './CheckList'

export const NFS_STEPS = ['reach', 'mount', 'write', 'lock', 'space'] as const

/** input = 아직 확인 전(또는 확인한 뒤 값을 바꿨다) · error = 확인 요청 자체가 실패 */
export type NfsView = 'input' | 'checking' | 'ok' | 'failed' | 'error'

export function nfsView(probe: Probe<NfsProbe>, server: string, exportPath: string): NfsView {
  if (probe.key !== nfsKey(server, exportPath) || probe.status === 'idle') return 'input'
  if (probe.status === 'checking') return 'checking'
  if (probe.status === 'error' || !probe.result) return 'error'
  return probe.result.ok ? 'ok' : 'failed'
}

export function nfsInputValid(server: string, exportPath: string): boolean {
  return isHostname(server) && exportPath.trim().startsWith('/') && exportPath.trim().length > 1
}

/** 원인별 해결 문구 */
export function nfsCauseText(cause: string | null | undefined, t: Translate, has: (k: string) => boolean): string {
  const key = cause ?? ''
  return has(`storage.cause.${key}`) ? t(`storage.cause.${key}`) : t('storage.cause.other', { cause: key })
}

/** 실패한 검사의 번호(1부터). 없으면 0 */
export function nfsFailedIndex(result: NfsProbe | null): number {
  if (!result) return 0
  const i = NFS_STEPS.findIndex(id => result.steps.find(s => s.id === id)?.status === 'fail')
  return i + 1
}

export function nfsRows(view: NfsView, result: NfsProbe | null, server: string, exportPath: string, t: Translate, has: (k: string) => boolean): CheckRow[] {
  return NFS_STEPS.map((id, i) => {
    const step = result?.steps.find(s => s.id === id)
    let state: CheckState = 'wait'
    let detail = ''
    let value = id === 'reach' ? server.trim() : (id === 'mount' ? exportPath.trim() : (has(`storage.stepNotes.${id}`) ? t(`storage.stepNotes.${id}`) : ''))
    if (view === 'checking') state = i === 0 ? 'checking' : 'wait'
    else if (step) {
      state = step.status === 'skipped' ? 'skipped' : step.status
      if (step.status === 'fail') detail = nfsCauseText(result?.cause, t, has)
      if (id === 'space') {
        value = typeof step.value === 'number' ? t('storage.spaceValue', { gb: trim1(step.value) }) : ''
        if (step.status === 'warn') detail = typeof step.value === 'number' ? t('storage.spaceLow') : t('storage.spaceUnknown')
      }
    }
    return { id, label: `${i + 1}. ${t(`storage.steps.${id}`)}`, value, state, detail: detail || undefined }
  })
}

export function NfsFields({ server, exportPath, onServer, onExport, hint }: {
  server: string
  exportPath: string
  onServer: (v: string) => void
  onExport: (v: string) => void
  hint?: string
}) {
  const t = useT()
  const probe = useWizard(s => s.nfs)
  const checkNfs = useWizard(s => s.checkNfs)
  const view = nfsView(probe, server, exportPath)
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <UiInput label={t('storage.serverLabel')} required mono placeholder={t('storage.serverPlaceholder')} modelValue={server} onUpdateModelValue={onServer} />
        <UiInput label={t('storage.exportLabel')} required mono placeholder={t('storage.exportPlaceholder')} modelValue={exportPath} onUpdateModelValue={onExport} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <UiButton type="button" variant="outline" size="sm" icon="refresh" disabled={view === 'checking' || !nfsInputValid(server, exportPath)} onClick={() => { void checkNfs(server, exportPath) }}>
          {t('common.testConnection')}
        </UiButton>
        {hint && <span className="min-w-0 flex-1 basis-[200px] text-xs text-muted-foreground">{hint}</span>}
      </div>
    </div>
  )
}
