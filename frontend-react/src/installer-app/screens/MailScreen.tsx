/**
 * 메일 — 내장 메일 서버(도메인에 레코드 다섯 개 등록) 또는 외부 발신 서버(SMTP).
 *  - 내장: 메일 도메인을 입력하면 등록할 레코드와 현재 상태를 표시한다. 레코드가 누락되어도 다음으로 진행할 수 있다(결과만 명확히 안내한다).
 *  - 외부: 서버 주소 · 포트 · 계정 · 비밀번호를 입력하고 "연결 확인"을 통과해야 다음으로 진행한다.
 * 비밀번호는 화면 상태에만 보관하고, 확인 시와 다음 단계 이동 시에만 서버로 송신한다.
 */
import { useEffect, useState } from 'react'
import { UiButton } from '~/components/ui/Button'
import { UiCallout } from '~/components/ui/Callout'
import { UiCard } from '~/components/ui/Card'
import { UiIcon } from '~/components/ui/Icon'
import { UiInput } from '~/components/ui/Input'
import { UiPasswordInput } from '~/components/ui/PasswordInput'
import { UiRadioCard } from '~/components/ui/RadioCard'
import { UiSegment } from '~/components/ui/Segment'
import { UiTable, type UiTableColumn } from '~/components/ui/Table'
import type { MailKind, MailRecord, MailSecurity, RecordStatus, SmtpProbeRequest } from '../api/types'
import { defaultMailDomain, isDomain, isHostname } from '../format'
import { M, useHas, useT } from '../i18n'
import { CopyButton } from '../parts/CopyButton'
import { StepNav, useGoNext } from '../shell/StepNav'
import { Heading, SubHeading, WizardShell } from '../shell/WizardShell'
import { smtpKey, useWizard } from '../store'

const DEBOUNCE_MS = 600
const LONG = 48

const RECORD_LOOK: Record<RecordStatus, { icon: string; color: string }> = {
  ok: { icon: 'check-circle', color: 'text-success' },
  missing: { icon: 'alert-triangle', color: 'text-warning' },
  different: { icon: 'alert-circle', color: 'text-danger' },
  unknown: { icon: 'alert-triangle', color: 'text-muted-foreground' },
}

/** 불일치 레코드 수(없음 + 값 상이) */
export function recordsPending(records: MailRecord[]): { missing: number; different: number; total: number } {
  const missing = records.filter(r => r.status === 'missing').length
  const different = records.filter(r => r.status === 'different').length
  return { missing, different, total: missing + different }
}

function RecordValue({ record }: { record: MailRecord }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const long = record.expected.length > LONG
  const shown = long && !open ? `${record.expected.slice(0, LONG)}…` : record.expected
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-1.5">
        <span className="min-w-0 break-all pt-1.5 font-mono text-xs">{shown}</span>
        <CopyButton text={record.expected} label={t('mail.copyValue', { name: record.name })} />
        {long && (
          <UiButton type="button" variant="link" size="xs" className="px-1" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? t('common.collapse') : t('common.expand')}
          </UiButton>
        )}
      </div>
      {record.status === 'different' && record.current.length > 0 && (
        <div className="text-xs text-muted-foreground">{t('mail.currentValue')} <span className="break-all font-mono">{record.current.join(' · ')}</span></div>
      )}
    </div>
  )
}

export function MailScreen() {
  const t = useT()
  const has = useHas()
  const saved = useWizard(s => s.answers.mail)
  const domain = useWizard(s => s.answers.access.domain)
  const records = useWizard(s => s.records)
  const smtp = useWizard(s => s.smtp)
  const checkRecords = useWizard(s => s.checkRecords)
  const checkSmtp = useWizard(s => s.checkSmtp)
  const password = useWizard(s => s.mailPassword)
  const setSecret = useWizard(s => s.setSecret)
  const [kind, setKind] = useState<MailKind>(saved.kind)
  const [mailDomain, setMailDomain] = useState(saved.mail_domain ?? defaultMailDomain(domain))
  const [host, setHost] = useState(saved.host ?? '')
  const [port, setPort] = useState(String(saved.port ?? 587))
  const [security, setSecurity] = useState<MailSecurity>(saved.security ?? 'starttls')
  const [username, setUsername] = useState(saved.username ?? '')
  const { goNext } = useGoNext('mail')

  const md = mailDomain.trim()
  const mdValid = isDomain(md)
  const stale = records.key !== md
  useEffect(() => {
    if (kind !== 'builtin' || !mdValid || !stale) return
    const timer = setTimeout(() => { void checkRecords(md) }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [kind, md, mdValid, stale, checkRecords])

  const recs = records.key === md && records.status === 'done' && records.result ? records.result.records : null
  const recChecking = mdValid && (stale || records.status === 'checking' || records.status === 'idle')
  const pending = recs ? recordsPending(recs) : null

  const req: SmtpProbeRequest = { host: host.trim(), port: Number(port) || 0, security, username: username.trim(), password }
  const smtpCurrent = smtp.key === smtpKey(req)
  const smtpOk = smtpCurrent && smtp.status === 'done' && smtp.result?.status === 'ok'
  const smtpBad = smtpCurrent && (smtp.status === 'error' || (smtp.status === 'done' && smtp.result?.status !== 'ok'))
  const smtpChecking = smtpCurrent && smtp.status === 'checking'
  const smtpCause = smtp.status === 'error' ? '' : (smtp.result?.status ?? '')
  const canTest = isHostname(req.host) && req.port > 0 && req.port < 65536 && req.username !== '' && password !== ''

  const blocked = kind === 'builtin'
    ? (mdValid ? '' : t('mail.reasonDomain'))
    : (smtpOk ? '' : t('mail.reasonSmtp'))

  const columns: UiTableColumn<MailRecord>[] = [
    { key: 'type', header: t('mail.colType'), mono: true, cell: r => r.type },
    { key: 'name', header: t('mail.colName'), mono: true, cell: r => <span className="break-all">{r.name}</span>, className: 'min-w-[150px]' },
    { key: 'value', header: t('mail.colValue'), cell: r => <RecordValue record={r} />, className: 'min-w-[220px] py-1' },
    {
      key: 'status', header: t('mail.colStatus'), className: 'whitespace-nowrap',
      cell: r => (
        <span className="inline-flex items-center gap-1.5">
          <span className={`flex ${RECORD_LOOK[r.status].color}`}><UiIcon name={RECORD_LOOK[r.status].icon} aria-hidden="true" className="size-4" /></span>
          {t(`mail.recordStatus.${r.status}`)}
        </span>
      ),
    },
  ]
  const pickKind = (v: string | number | null) => { if (v != null) setKind(v as MailKind) }

  return (
    <WizardShell step="mail">
      <Heading title={t('mail.title')} lead={t('mail.lead')} />
      <div role="radiogroup" aria-label={t('mail.groupLabel')} className="flex flex-col gap-2">
        <UiRadioCard className="w-full" layout="row" value="builtin" title={t('mail.builtinTitle')} description={t('mail.builtinDesc')} modelValue={kind} onUpdateModelValue={pickKind} />
        <UiRadioCard className="w-full" layout="row" value="external" title={t('mail.externalTitle')} description={t('mail.externalDesc')} modelValue={kind} onUpdateModelValue={pickKind} />
      </div>
      {kind === 'builtin' && (
        <>
          <div className="max-w-[400px]">
            <UiInput
              label={t('mail.domainLabel')}
              mono
              placeholder="example.com"
              modelValue={mailDomain}
              onUpdateModelValue={setMailDomain}
              error={md !== '' && !mdValid ? t('mail.domainError') : undefined}
              hint={mdValid ? t('mail.domainHint', { example: `${t('mail.domainHintName')}@${md}` }) : undefined}
            />
          </div>
          <UiCard className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
              <SubHeading>{t('mail.recordsTitle')}</SubHeading>
              <UiButton type="button" variant="secondary" size="sm" icon="refresh" disabled={!mdValid || records.status === 'checking'} onClick={() => { void checkRecords(md) }}>{t('common.recheck')}</UiButton>
            </div>
            {recs
              ? <UiTable label={t('mail.recordsTitle')} columns={columns} rows={recs} rowKey={r => r.id} minWidthClass="min-w-[640px]" />
              : (
                  <div className="border-t border-border px-4 py-4">
                    {!mdValid
                      ? <span className="text-[13px] text-muted-foreground">{t('mail.recordsIdle')}</span>
                      : (records.status === 'error' && !stale
                          ? <UiCallout variant="plain" tone="danger" role="alert">{t('common.probeFailed')}</UiCallout>
                          : <UiCallout variant="plain" tone="neutral" icon="loader" spin={recChecking} role="status">{t('mail.recordsChecking')}</UiCallout>)}
                  </div>
                )}
          </UiCard>
          {pending && pending.total > 0 && (
            <UiCallout tone="warning" title={<M k="mail.recordsWarnTitle" v={{ n: pending.total }} />}><M k="mail.recordsWarnBody" /></UiCallout>
          )}
          {pending && pending.total === 0 && recs?.every(r => r.status === 'ok') && (
            <UiCallout variant="plain" tone="success" role="status">{t('mail.recordsOk')}</UiCallout>
          )}
        </>
      )}
      {kind === 'external' && (
        <UiCard className="p-4">
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <UiInput label={t('mail.hostLabel')} mono placeholder={t('mail.hostPlaceholder')} modelValue={host} onUpdateModelValue={setHost} />
              <UiInput label={t('mail.portLabel')} mono inputMode="numeric" modelValue={port} onUpdateModelValue={setPort} hint={t('mail.portHint')} />
              <UiInput label={t('mail.userLabel')} mono autocomplete="off" modelValue={username} onUpdateModelValue={setUsername} />
              <UiPasswordInput
                label={t('mail.passwordLabel')}
                autocomplete="new-password"
                placeholder={t('mail.passwordPlaceholder')}
                modelValue={password}
                onUpdateModelValue={v => setSecret('mailPassword', v)}
                error={smtpBad && smtpCause === 'auth_failed' ? t('mail.smtpPasswordError') : undefined}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-muted-foreground">{t('mail.securityLabel')}</span>
              <div className="max-w-full overflow-x-auto">
                <UiSegment
                  ariaLabel={t('mail.securityLabel')}
                  items={(['starttls', 'ssl', 'none'] as MailSecurity[]).map(v => ({ value: v, label: t(`mail.security.${v}`) }))}
                  modelValue={security}
                  onUpdateModelValue={v => { if (v != null) setSecurity(v as MailSecurity) }}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <UiButton type="button" variant="outline" size="sm" icon="refresh" disabled={!canTest || smtpChecking} onClick={() => { void checkSmtp(req) }}>{t('common.testConnection')}</UiButton>
              {smtpChecking && <UiCallout variant="plain" tone="neutral" icon="loader" spin role="status" className="flex-1">{t('status.checking')}</UiCallout>}
              {smtpOk && <UiCallout variant="plain" tone="success" role="status" title={t('mail.smtpOk')} className="flex-1">{t('mail.smtpOkBody')}</UiCallout>}
              {smtpBad && (
                <UiCallout variant="plain" tone="danger" role="alert" title={t('mail.smtpFail')} className="flex-1">
                  {smtpCause && has(`mail.smtp.${smtpCause}`) ? t(`mail.smtp.${smtpCause}`) : t('common.probeFailed')}
                </UiCallout>
              )}
            </div>
          </div>
        </UiCard>
      )}
      <StepNav
        step="mail"
        blocked={blocked}
        onNext={() => goNext({
          mail: kind === 'builtin'
            ? { kind: 'builtin', mail_domain: md }
            : { kind: 'external', host: req.host, port: req.port, security, username: req.username, password },
        })}
      />
    </WizardShell>
  )
}
