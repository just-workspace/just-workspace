/**
 * 요약 — 입력한 값을 전부 다시 보여 주고 항목마다 "고치기"를 둔다. 앞 단계에서 넘긴 주의를 한곳에 모은다.
 * "설치"를 누르기 전에는 서버에 바뀌는 것이 없다. 서버가 이대로는 설치할 수 없다고 하면(오류) 이유와 고칠 곳을 보인다.
 * 빠른 설치에서는 묻지 않은 항목(연결 · 저장 위치 · 구역)을 "기본값"으로 보여 주고 고치기를 두지 않는다.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { UiButton } from '~/components/ui/Button'
import { UiCallout } from '~/components/ui/Callout'
import { UiCard } from '~/components/ui/Card'
import { UiIcon } from '~/components/ui/Icon'
import type { Caution, FieldError, SummaryResponse } from '../api/types'
import { bytesText, isDomain, portsLine, recommendMb, trim1, zoneGb } from '../format'
import { prevStep, stepForField, type RouteId } from '../flow'
import { M, useHas, useLocalized, useT } from '../i18n'
import { hashFor, navigate } from '../router'
import { Heading, WizardShell } from '../shell/WizardShell'
import { effectiveZones, flowOf, QUICK_PRESET, quickLowered, useWizard, useWizardStore } from '../store'
import { recordsPending } from './MailScreen'

/** 사전 점검의 주의 가운데 요약에 다시 모아 보여 줄 것(해결 방법 키) */
const PREFLIGHT_CAUTIONS = ['port_25_in_use', 'disk_low', 'time_not_synchronized', 'internet_unreachable', 'registry_unreachable']

/** 주의 사항 → 보러 갈 화면과 그 이름 */
function cautionLink(key: string): { to: RouteId; label: string } | null {
  if (PREFLIGHT_CAUTIONS.includes(key)) return { to: 'check', label: 'summary.seeCheck' }
  if (key.startsWith('mail_records')) return { to: 'mail', label: 'summary.seeMail' }
  if (key === 'cert_temporary' || key === 'dns_mismatch_cert_will_fail') return { to: 'domain', label: 'summary.seeDomain' }
  if (key === 'nfs_space_low') return { to: 'storage', label: 'summary.seeStorage' }
  if (key === 'meetings_public_ip_unknown') return { to: 'meet', label: 'summary.seeMeet' }
  if (key === 'hairpin_not_configured') return { to: 'proxy', label: 'summary.seeProxy' }
  return null
}

function Row({ name, fix, fixLabel = 'summary.fix', children }: { name: string; fix?: RouteId; fixLabel?: string; children: ReactNode }) {
  const t = useT()
  return (
    <div className="grid grid-cols-[1fr_auto] items-start gap-x-4 gap-y-0.5 border-t border-border px-4 py-2.5 first:border-t-0 sm:grid-cols-[140px_1fr_auto]">
      <dt className="col-span-2 text-muted-foreground sm:col-span-1">{name}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
      {fix
        ? <UiButton as="a" variant="link" size="xs" className="h-auto px-0 py-0.5" href={hashFor(fix, { fix: fix !== 'advanced' })} aria-label={t('summary.fixLabel', { name })}>{t(fixLabel)}</UiButton>
        : <span />}
    </div>
  )
}

export function SummaryScreen() {
  const t = useT()
  const has = useHas()
  const localized = useLocalized()
  const store = useWizardStore()
  const api = useWizard(s => s.api)
  const answers = useWizard(s => s.answers)
  const catalog = useWizard(s => s.catalog)
  const aiChecked = useWizard(s => s.ai.status === 'done' && s.ai.result?.status === 'ok')
  const preflight = useWizard(s => s.preflight)
  const preflightBusy = useWizard(s => s.preflightBusy)
  const records = useWizard(s => s.records)
  const [summary, setSummary] = useState<SummaryResponse | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [starting, setStarting] = useState(false)
  const [startFailed, setStartFailed] = useState(false)

  // 요약은 사전 점검 결과에 기대므로(설치할 수 있는가 · 넘어온 주의), 이 창에서 점검한 적이 없으면 먼저 돌린다.
  // 내장 메일을 쓰면 레코드 상태도 확인해 둔다(주의 목록과 완료 화면의 할 일에 쓰인다).
  useEffect(() => {
    const s = store.getState()
    if (!s.preflight && !s.preflightBusy) void s.runPreflight()
    const a = s.answers
    const mailDomain = a.mail.mail_domain
    if (effectiveZones(a, s.catalog).includes('mail') && a.mail.kind === 'builtin' && mailDomain && s.records.key !== mailDomain) void s.checkRecords(mailDomain)
  }, [store])
  useEffect(() => {
    if (preflightBusy) return
    let alive = true
    api.getSummary().then(s => { if (alive) { setSummary(s); setLoadFailed(false) } }).catch(() => { if (alive) setLoadFailed(true) })
    return () => { alive = false }
  }, [api, preflightBusy, preflight])

  const quick = answers.mode === 'quick'
  const muted = (text: string) => <span className="text-muted-foreground">{text}</span>
  const dflt = quick ? <span className="text-muted-foreground"> · {t('common.defaultValue')}</span> : null
  const a = answers.access
  const zoneIds = summary?.zones ?? [...effectiveZones(answers, catalog), ...answers.addons]
  const isOn = (id: string) => zoneIds.includes(id)
  const zoneNames = catalog ? [localized(catalog.core.name), ...catalog.zones.filter(z => isOn(z.id)).map(z => localized(z.name))] : []
  const addonNames = catalog ? catalog.addons.filter(z => isOn(z.id)).map(z => localized(z.name)) : []
  const needMb = summary?.memory?.need_mb ?? (catalog ? recommendMb(catalog, zoneIds) : null)
  const mailDomain = isOn('mail') && answers.mail.kind === 'builtin' && answers.mail.mail_domain ? answers.mail.mail_domain : (isDomain(a.domain) ? a.domain : '')
  const mailBuiltin = isOn('mail') && answers.mail.kind === 'builtin'
  const pending = mailBuiltin && records.status === 'done' && records.key === answers.mail.mail_domain && records.result ? recordsPending(records.result.records) : null
  const cautions: Caution[] = [
    // 사전 점검에서 넘긴 주의(메일 포트는 내장 메일을 쓸 때만)
    ...(preflight?.items ?? [])
      .filter(i => i.status === 'warn' && i.fix && PREFLIGHT_CAUTIONS.includes(i.fix.key) && (i.fix.key !== 'port_25_in_use' || mailBuiltin))
      .map(i => ({ key: i.fix!.key, vars: i.fix!.vars })),
    ...(pending && pending.total > 0 ? [{ key: 'mail_records_pending', vars: { ...pending } }] : []),
    ...(summary?.cautions ?? []),
    ...(summary?.notes ?? []),
  ]
  const errors: FieldError[] = summary?.errors ?? []
  const prev = prevStep(flowOf(answers, catalog), 'summary')

  const cautionText = (c: Caution) => {
    const vars = { ...(c.vars ?? {}) } as Record<string, unknown>
    let key = c.key
    if (key === 'mail_records_pending') {
      const missing = Number(vars.missing ?? 0)
      const different = Number(vars.different ?? 0)
      if (missing > 0 && different > 0) key = 'mail_records_both'
      else vars.n = vars.n ?? missing + different
    }
    if (Array.isArray(vars.names)) vars.names = vars.names.join(', ')
    if (Array.isArray(vars.ports)) vars.ports = vars.ports.join(', ')
    return has(`summary.caution.${key}`) ? <M k={`summary.caution.${key}`} v={vars} /> : t('summary.caution.other', { key: c.key })
  }
  const errorText = (e: FieldError) => {
    // 목록 항목의 오류('zones.0')는 목록 이름으로 보인다
    const path = e.field.replace(/\.\d+$/, '')
    const named = t(`summary.fields.${path}`)
    const field = named.startsWith('installer.') ? e.field : named
    if (has(`summary.error.${e.code}`)) return t(`summary.error.${e.code}`, { field })
    return t('summary.error.other', { field, code: e.code })
  }

  async function install() {
    setStarting(true)
    setStartFailed(false)
    try {
      store.getState().kickApply(await api.startApply())
      navigate('apply')
    } catch {
      setStartFailed(true)
      setStarting(false)
    }
  }

  const preflightBad = summary?.preflight ? !summary.preflight.ok : summary?.ready === false
  const blocked = preflightBusy
    ? t('summary.reasonPreflightRunning')
    : (!summary
        ? (loadFailed ? t('summary.reasonLoadFailed') : t('summary.reasonLoading'))
        : (errors.length ? t('summary.reasonErrors') : (preflightBad ? t('summary.reasonPreflight') : (startFailed ? t('summary.startFailed') : ''))))
  const canInstall = !!summary && errors.length === 0 && !preflightBad && !preflightBusy && !starting

  const optional = (id: string, step: RouteId, name: string, value: () => ReactNode) => {
    if (quick) return null
    if (!catalog?.zones.some(z => z.id === id)) return null
    return isOn(id)
      ? <Row name={name} fix={step}>{value()}</Row>
      : <Row name={name} fix="zones">{muted(t('common.notSelected'))}</Row>
  }

  return (
    <WizardShell step="summary">
      <Heading title={t('summary.title')} lead={t('summary.lead')} />
      <UiCard className="overflow-hidden">
        <dl className="m-0 text-[13px]">
          <Row name={t('summary.rowAddress')} fix="domain"><span className="break-all font-mono">https://{a.domain}</span></Row>
          <Row name={t('summary.rowNetwork')} fix={quick ? undefined : 'domain'}>
            {t(`summary.network.${a.network}`)} · {t(`summary.cert.${a.cert}`)}
            {a.network === 'proxy' && a.proxy_addresses.length > 0 && <> · <span className="font-mono">{t('summary.proxyFrom', { addresses: a.proxy_addresses.join(', ') })}</span></>}
            {dflt}
          </Row>
          <Row name={t('summary.rowStorage')} fix={quick ? undefined : 'storage'}>
            {answers.storage.kind === 'nfs'
              ? <>{t('summary.storageNfs')} · <span className="break-all font-mono">{answers.storage.server}:{answers.storage.export}</span></>
              : <>{t('summary.storageLocal')} {answers.storage.path ? <span className="break-all font-mono">· {answers.storage.path}</span> : (quick ? null : muted(`· ${t('summary.storageDefaultDir')}`))}</>}
            {dflt}
          </Row>
          <Row name={t('summary.rowZones')} fix={quick ? undefined : 'zones'}>
            <span className="flex flex-col gap-0.5">
              <span>
                {quick && <>{t(`summary.presetLine.${quickLowered(catalog) ? 'minimal' : QUICK_PRESET}`)} · </>}
                {zoneNames.join(', ')}
                {addonNames.length > 0 && <> · {t('summary.zonesAddons', { names: addonNames.join(', ') })}</>}
                {dflt}
              </span>
              <span className="text-xs text-muted-foreground">
                {needMb != null && <M k="summary.zonesMem" v={{ gb: trim1(zoneGb(needMb)) }} />}
                {summary?.download_bytes != null && !quick && <> · <M k="summary.zonesDownload" v={{ size: bytesText(summary.download_bytes) }} /></>}
                {quick && <> · {t('summary.zonesQuickNote')}</>}
              </span>
            </span>
          </Row>
          {isOn('mail')
            ? (
                <Row name={t('summary.rowMail')} fix="mail">
                  {answers.mail.kind === 'builtin'
                    ? <>{t('summary.mailBuiltin')} · <span className="font-mono">{answers.mail.mail_domain}</span></>
                    : <>{t('summary.mailExternal')} · <span className="font-mono">{answers.mail.host}:{answers.mail.port}</span></>}
                </Row>
              )
            : (!quick && catalog?.zones.some(z => z.id === 'mail') ? <Row name={t('summary.rowMail')} fix="zones">{muted(t('common.notSelected'))}</Row> : null)}
          {optional('meetings', 'meet', t('summary.rowMeet'), () => (
            <>{t(answers.meetings.turn ? 'summary.meetRelayOn' : 'summary.meetRelayOff')}{answers.meetings.lossless_audio && <> · {t('summary.meetLosslessOn')}</>}</>
          ))}
          {optional('ai', 'ai', t('summary.rowAi'), () => (
            answers.ai.mode === 'provider'
              ? <>{has(`ai.providers.${answers.ai.provider}`) ? t(`ai.providers.${answers.ai.provider}`) : answers.ai.provider}{aiChecked && <> · {t('summary.aiChecked')}</>}</>
              : t('summary.aiLater')
          ))}
          {optional('git', 'git', t('summary.rowGit'), () => (
            answers.git.version === 'verified'
              ? t('summary.gitVerified')
              : (answers.git.version === 'latest' ? t('summary.gitLatest') : <M k="summary.gitCustom" v={{ version: answers.git.version }} />)
          ))}
          <Row name={t('summary.rowAdmin')} fix="admin">
            <span className="break-all font-mono">{mailDomain ? `${answers.admin.username}@${mailDomain}` : answers.admin.username}</span>
          </Row>
          {summary && (
            <Row name={t('summary.rowPorts')}><span className="font-mono text-xs">{portsLine(summary.ports)}</span></Row>
          )}
          {!quick && (
            <Row name={t('summary.rowAdvanced')} fix="advanced" fixLabel="summary.change">
              <M k={answers.advanced.subnet === '172.28.0.0/24' ? 'summary.advancedDefault' : 'summary.advancedCustom'} v={{ subnet: answers.advanced.subnet }} />
            </Row>
          )}
        </dl>
      </UiCard>

      {errors.length > 0 && (
        <UiCallout tone="danger" role="alert" title={t('summary.errorsTitle')}>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-foreground">
            {errors.map((e, i) => (
              <li key={`${e.field}:${e.code}:${i}`} className="flex flex-wrap items-baseline gap-x-3">
                <span className="min-w-0 flex-1 basis-[220px]">{errorText(e)}</span>
                <a className="text-primary underline-offset-4 hover:underline" href={hashFor(stepForField(e.field), { fix: true })}>{t('summary.fix')}</a>
              </li>
            ))}
          </ul>
        </UiCallout>
      )}

      {summary && !preflightBusy && preflightBad && errors.length === 0 && (
        <UiCallout
          tone="danger"
          role="alert"
          actions={<UiButton as="a" size="sm" variant="secondary" href={hashFor('check', { fix: true })}>{t('summary.seeCheck')}</UiButton>}
        >
          <span className="text-foreground">{t('summary.reasonPreflight')}</span>
        </UiCallout>
      )}

      {cautions.length > 0 && (
        <section aria-labelledby="warn-h" className="flex flex-col gap-2 rounded-xl bg-warning/10 px-4 py-3">
          <h2 id="warn-h" className="m-0 flex items-center gap-2 text-[13.5px] font-semibold leading-5">
            <span className="flex text-warning"><UiIcon name="alert-triangle" aria-hidden="true" className="size-[18px]" /></span>
            <span><M k="summary.cautionsTitle" v={{ n: cautions.length }} /></span>
          </h2>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 pl-[26px] text-[13px]">
            {cautions.map((c, i) => {
              const link = cautionLink(c.key)
              return (
                <li key={`${c.key}:${i}`} className="flex flex-wrap items-baseline gap-x-3">
                  <span className="min-w-0 flex-1 basis-[220px]">{cautionText(c)}</span>
                  {link && <a className="text-primary underline-offset-4 hover:underline" href={hashFor(link.to, { fix: true })}>{t(link.label)}</a>}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <UiButton as="a" variant="outline" size="sm" icon="download" href={api.answersExportUrl()} download="answers.json">{t('summary.download')}</UiButton>
        <span className="min-w-0 flex-1 basis-[200px] text-xs text-muted-foreground">{t('summary.downloadNote')}</span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        {prev && <UiButton type="button" variant="secondary" onClick={() => navigate(prev)}>{t('nav.prev')}</UiButton>}
        <span id="sum-reason" role="status" className={`min-w-0 flex-1 text-right text-[13px] text-muted-foreground ${blocked ? 'basis-[200px]' : 'basis-0'}`}>{blocked}</span>
        <UiButton type="button" size="lg" iconRight="arrow-right" disabled={!canInstall} aria-describedby={blocked ? 'sum-reason' : undefined} onClick={() => { void install() }}>{t('summary.install')}</UiButton>
      </div>
    </WizardShell>
  )
}
