/**
 * 개방 포트 표 — 포트 · 종류 · 용도 (· 구역). 용도와 구역이 동일한 포트는 한 줄로 병합한다('465 · 587').
 * 포트 목록은 서버가 전달한 구역 선언에서 가져온다. 용도 문구만 번역 파일에 있으며, 알 수 없는 포트는 용도를 비워 둔다.
 */
import { UiCard } from '~/components/ui/Card'
import { UiTable, type UiTableColumn } from '~/components/ui/Table'
import type { PortRow } from '../format'
import { useHas, useT } from '../i18n'
import { SubHeading } from '../shell/WizardShell'
import { CopyButton } from './CopyButton'

export interface PortLine { ports: string; proto: string; use: string; zone: string }

export function groupPorts(rows: PortRow[], purposeOf: (spec: string) => string, zoneName: (id: string) => string): PortLine[] {
  const out: PortLine[] = []
  for (const r of rows) {
    const use = purposeOf(r.spec)
    const proto = r.proto.toUpperCase()
    const zone = zoneName(r.zone)
    const same = out.find(o => o.proto === proto && o.use === use && o.zone === zone && use !== '')
    if (same) same.ports += ` · ${r.port}`
    else out.push({ ports: r.port, proto, use, zone })
  }
  return out
}

export function PortTable({ title, rows, zoneName, showZone = true }: { title: string; rows: PortRow[]; zoneName: (id: string) => string; showZone?: boolean }) {
  const t = useT()
  const has = useHas()
  const lines = groupPorts(rows, spec => (has(`ports.use.${spec}`) ? t(`ports.use.${spec}`) : ''), zoneName)
  const columns: UiTableColumn<PortLine>[] = [
    { key: 'port', header: t('ports.colPort'), mono: true, cell: r => r.ports, className: 'whitespace-nowrap' },
    { key: 'proto', header: t('ports.colProto'), mono: true, cell: r => r.proto },
    { key: 'use', header: t('ports.colUse'), cell: r => r.use },
    ...(showZone ? [{ key: 'zone', header: t('ports.colZone'), cell: (r: PortLine) => r.zone }] : []),
  ]
  const text = lines.map(l => `${l.proto} ${l.ports}${l.use ? `  ${l.use}` : ''}`).join('\n')
  return (
    <UiCard className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
        <SubHeading>{title}</SubHeading>
        <CopyButton text={text} label={t('ports.copy')} />
      </div>
      <UiTable label={title} columns={columns} rows={lines} rowKey={r => `${r.proto}:${r.ports}`} minWidthClass={showZone ? 'min-w-[520px]' : 'min-w-[380px]'} />
    </UiCard>
  )
}
