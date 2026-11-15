/**
 * 구역 선택 — 묶음(최소 · 협업 · 전체)으로 한 번에 고르거나 하나씩 고른다.
 * 구역 목록 · 권장 메모리 · 포트 · 필요 관계 · 묶음은 전부 서버가 준 것을 그대로 그린다(화면에 적어 둔 숫자가 없다).
 * 권장 메모리 합계가 서버 메모리를 넘으면 다음으로 갈 수 없다.
 */
import { useState } from 'react'
import { UiCallout } from '~/components/ui/Callout'
import { UiCard } from '~/components/ui/Card'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiDisclosure } from '~/components/ui/Disclosure'
import { UiIcon } from '~/components/ui/Icon'
import { UiProgress } from '~/components/ui/Progress'
import { UiSegment } from '~/components/ui/Segment'
import type { ZoneRow } from '../api/types'
import { matchPreset, portsLine, recommendMb, serverGb, trim1, zoneGb } from '../format'
import { M, useHas, useLocalized, useT } from '../i18n'
import { StepNav, useGoNext } from '../shell/StepNav'
import { Heading, WizardShell } from '../shell/WizardShell'
import { effectiveZones, serverMemoryMb, useWizard } from '../store'

function ZoneLine({ zone, on, onToggle, note }: { zone: ZoneRow; on: boolean; onToggle: (v: boolean) => void; note?: string }) {
  const t = useT()
  const localized = useLocalized()
  const gb = zoneGb(zone.memory_mb.recommend)
  return (
    <div data-zone={zone.id} className="flex flex-col gap-1.5 border-t border-border px-4 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <span className="min-w-0 flex-1 basis-[220px]">
          <UiCheckbox label={localized(zone.name)} description={localized(zone.summary)} modelValue={on} onUpdateModelValue={onToggle} />
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5 pl-[30px] text-xs">
          <span className="font-mono">{gb > 0 ? t('zones.plusGb', { n: trim1(gb) }) : <span className="font-sans text-muted-foreground">{t('zones.noExtra')}</span>}</span>
          {zone.ports.length > 0 && <span className="font-mono text-muted-foreground">{portsLine(zone.ports)}</span>}
        </span>
      </div>
      {note && (
        <span className="flex items-start gap-1.5 pl-[30px] text-xs text-muted-foreground">
          <UiIcon name="info" aria-hidden="true" className="mt-px size-3.5 shrink-0" />{note}
        </span>
      )}
    </div>
  )
}

export function ZonesScreen() {
  const t = useT()
  const has = useHas()
  const localized = useLocalized()
  const answers = useWizard(s => s.answers)
  const catalog = useWizard(s => s.catalog)
  const cap = useWizard(s => serverMemoryMb(s))
  const [zones, setZones] = useState<string[]>(() => effectiveZones(answers, catalog))
  const [addons, setAddons] = useState<string[]>(answers.addons)
  const { goNext } = useGoNext('zones')

  if (!catalog) {
    return (
      <WizardShell step="zones">
        <Heading title={t('zones.title')} lead={t('zones.lead')} />
        <UiCallout tone="danger" role="alert">{t('zones.loadFailed')}</UiCallout>
      </WizardShell>
    )
  }

  const order = (ids: string[], rows: ZoneRow[]) => rows.map(z => z.id).filter(id => ids.includes(id))
  const chosen = [...zones, ...addons]
  const need = recommendMb(catalog, chosen)
  const over = cap != null && need > cap
  const preset = matchPreset(catalog, zones) ?? 'custom'
  const presetItems = [...Object.keys(catalog.presets), 'custom'].map(p => ({ value: p, label: has(`zones.presets.${p}`) ? t(`zones.presets.${p}`) : p }))
  const nameOf = (id: string) => localized([...catalog.zones, ...catalog.addons].find(z => z.id === id)?.name) || id

  /** 함께 골라야 하는데 빠진 구역 */
  const missing = (z: ZoneRow) => z.requires.filter(r => !chosen.includes(r))
  const requiresBroken = [...catalog.zones, ...catalog.addons].some(z => chosen.includes(z.id) && missing(z).length > 0)
  const noteOf = (z: ZoneRow): string => {
    if (!chosen.includes(z.id)) return ''
    const lack = missing(z)
    if (lack.length) return t('zones.requires', { names: lack.map(nameOf).join(', ') })
    // 채팅의 음성 채널은 회의 구역이 있어야 켜진다(없어도 설치는 된다)
    if (z.id === 'chat' && catalog.zones.some(x => x.id === 'meetings') && !zones.includes('meetings')) return t('zones.voiceNeedsMeetings')
    return ''
  }
  const toggle = (list: string[], set: (v: string[]) => void, rows: ZoneRow[], id: string) => (v: boolean) =>
    set(order(v ? [...list, id] : list.filter(x => x !== id), rows))

  const addonNames = catalog.addons.filter(z => addons.includes(z.id)).map(z => localized(z.name))
  const blocked = over ? t('zones.reasonOver') : (requiresBroken ? t('zones.reasonRequires') : '')
  const totalGb = zoneGb(need)
  const capGb = cap != null ? serverGb(cap) : null

  return (
    <WizardShell step="zones" preview={{ zones }}>
      <Heading title={t('zones.title')} lead={t('zones.lead')} />
      <div className="max-w-full overflow-x-auto">
        <UiSegment
          size="lg"
          ariaLabel={t('zones.presetLabel')}
          items={presetItems}
          modelValue={preset}
          onUpdateModelValue={v => { const ids = catalog.presets[String(v)]; if (ids) setZones(order(ids, catalog.zones)) }}
        />
      </div>
      <UiCard className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
          <span className="flex text-muted-foreground"><UiIcon name="lock" aria-hidden="true" className="size-4" /></span>
          <span className="min-w-0 flex-1 basis-[200px]">
            <span className="font-semibold">{localized(catalog.core.name)}</span>
            <span className="text-muted-foreground"> · {localized(catalog.core.summary)} · {t('zones.coreAlways')}</span>
          </span>
          <span className="font-mono text-xs">{t('zones.gb', { n: trim1(zoneGb(catalog.core.memory_mb.recommend)) })}</span>
        </div>
        <div>
          {catalog.zones.map(z => (
            <ZoneLine key={z.id} zone={z} on={zones.includes(z.id)} onToggle={toggle(zones, setZones, catalog.zones, z.id)} note={noteOf(z)} />
          ))}
        </div>
        <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[13px]">
            <span className={over ? 'font-semibold text-danger' : 'text-muted-foreground'}>
              {t('zones.memTitle')} · {capGb == null ? t('zones.memUnknown') : (over ? t('zones.memOver') : t('zones.memLeft', { n: trim1(capGb - totalGb) }))}
            </span>
            <span className="font-mono">
              {t('zones.gb', { n: trim1(totalGb) })}
              {capGb != null && <span className="text-muted-foreground"> / {t('zones.gb', { n: trim1(capGb) })}</span>}
            </span>
          </div>
          {capGb != null && <UiProgress as="meter" label={t('zones.memLabel')} value={totalGb} max={capGb} tone={over ? 'danger' : 'primary'} />}
        </div>
      </UiCard>
      {catalog.addons.length > 0 && (
        <UiDisclosure
          title={<>{t('zones.addonsTitle')} <span className="font-normal text-muted-foreground">· {addonNames.length ? addonNames.join(', ') : t('zones.addonsNone', { names: catalog.addons.map(z => localized(z.name)).join(', ') })}</span></>}
          defaultOpen={addons.length > 0}
        >
          <div className="pb-1">
            {catalog.addons.map(z => (
              <ZoneLine key={z.id} zone={z} on={addons.includes(z.id)} onToggle={toggle(addons, setAddons, catalog.addons, z.id)} note={noteOf(z)} />
            ))}
          </div>
        </UiDisclosure>
      )}
      {over && cap != null && (
        <UiCallout tone="danger" role="alert"><M k="zones.overAlert" v={{ n: trim1(totalGb - serverGb(cap)) }} /></UiCallout>
      )}
      <StepNav step="zones" blocked={blocked} onNext={() => goNext({ zones, addons, preset: null })} />
      <p className="m-0 text-xs text-muted-foreground">{t('zones.thirdParty')}</p>
    </WizardShell>
  )
}
