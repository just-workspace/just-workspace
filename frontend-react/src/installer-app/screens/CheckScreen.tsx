/**
 * 사전 점검 — 이 서버의 설치 가능 여부를 확인한다. 실패가 하나라도 있으면 다음으로 진행할 수 없으며, 주의는 그대로 두고 진행할 수 있다.
 * 항목과 상태는 서버가 전달한 그대로 렌더링한다. 이름·값 표기·해결 방법 문구만 번역 파일에서 조회한다(알 수 없는 항목은 id 를 그대로 표시한다).
 */
import { useEffect } from 'react'
import { UiButton } from '~/components/ui/Button'
import type { PreflightItem } from '../api/types'
import { serverGb, trim1, zoneGb } from '../format'
import { useHas, useT, type Translate } from '../i18n'
import { CheckList, type CheckRow } from '../parts/CheckList'
import { StepNav, useGoNext } from '../shell/StepNav'
import { Heading, WizardShell } from '../shell/WizardShell'
import { useWizard } from '../store'

/** 응답 대기 중 표시할 항목 순서 */
const KNOWN = ['docker_engine', 'docker_compose', 'cpu', 'memory', 'arch', 'disk', 'time_sync', 'port_80', 'port_443', 'port_25', 'subnet', 'internet', 'registry', 'selinux']

export function preflightValue(item: PreflightItem, t: Translate, has: (k: string) => boolean): string {
  const v = item.value
  if (v == null || v === '') return ''
  const word = (s: string) => (has(`check.values.${s}`) ? t(`check.values.${s}`) : s)
  switch (item.id) {
    case 'cpu': return typeof v === 'number' ? t('check.values.cores', { n: v }) : String(v)
    case 'memory': return typeof v === 'number' ? t('check.values.gb', { n: trim1(serverGb(v)) }) : String(v)
    case 'disk': {
      const free = typeof v === 'object' ? (v as { free_gb?: number }).free_gb : v
      return free == null ? '' : t('check.values.gb', { n: trim1(Number(free)) })
    }
    case 'subnet': return t(item.status === 'fail' ? 'check.values.conflict' : 'check.values.noConflict', { subnet: String(v) })
    default: return typeof v === 'string' ? word(v) : (typeof v === 'object' ? '' : String(v))
  }
}

function fixVars(item: PreflightItem): Record<string, unknown> {
  const vars = { ...(item.fix?.vars ?? {}) }
  if (typeof vars.min_mb === 'number') vars.gb = trim1(serverGb(vars.min_mb))
  if (typeof vars.need_mb === 'number') vars.gb = trim1(zoneGb(vars.need_mb))
  return vars
}

export function CheckScreen() {
  const t = useT()
  const has = useHas()
  const preflight = useWizard(s => s.preflight)
  const busy = useWizard(s => s.preflightBusy)
  const failed = useWizard(s => s.preflightFailed)
  const run = useWizard(s => s.runPreflight)
  const { goNext } = useGoNext('check')

  useEffect(() => { void run() }, [run])

  const items: PreflightItem[] = preflight?.items ?? (busy ? KNOWN.map(id => ({ id, status: 'checking' as const, value: null, fix: null })) : [])
  const rows: CheckRow[] = items.map(item => {
    const label = has(`check.items.${item.id}`) ? t(`check.items.${item.id}`) : item.id
    let detail = ''
    if (item.status === 'warn' || item.status === 'fail') {
      const key = item.fix?.key ?? 'unknown'
      detail = has(`check.fix.${key}`) ? t(`check.fix.${key}`, fixVars(item)) : t('check.fix.unknown')
    } else if (item.status === 'pass' && has(`check.ok.${item.id}`)) {
      detail = t(`check.ok.${item.id}`)
    }
    return { id: item.id, label, value: preflightValue(item, t, has), state: item.status, detail: detail || undefined }
  })

  const checking = busy || rows.some(r => r.state === 'checking')
  const anyFail = rows.some(r => r.state === 'fail')
  const anyWarn = rows.some(r => r.state === 'warn')
  const blocked = checking
    ? t('check.reasonRunning')
    : (failed || !preflight ? t('check.reasonError') : (anyFail ? t('check.reasonFailed') : ''))

  return (
    <WizardShell step="check">
      <Heading title={t('check.title')} lead={t('check.lead')} />
      <CheckList title={t('check.cardTitle')} rows={rows} />
      <StepNav
        step="check"
        noPrev
        blocked={blocked}
        note={anyWarn ? t('check.reasonWarn') : ''}
        onNext={() => goNext()}
        extra={<UiButton type="button" variant="secondary" icon="refresh" disabled={busy} onClick={() => { void run() }}>{t('common.recheck')}</UiButton>}
      />
    </WizardShell>
  )
}
