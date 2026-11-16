/**
 * 인증서 올리기 — 가진 인증서를 골랐을 때만 나온다. 파일 두 개(인증서 · 개인 키)를 올리면 서버가 바로 검사한다.
 * 셋째 칸 "CA 인증서(선택)"은 사설 CA 가 내준 인증서일 때만 쓴다 — 인증서 파일에 발급 CA 가 이어 붙어 있지 않으면,
 * 그 CA 를 따로 올려야 이 서버의 코드 저장소가 접속 주소의 인증서를 믿는다(로그인 연동).
 * 검사 결과는 접속 주소 · 메일 호스트 이름 · 개인 키 · 만료일 · 발급자 · 발급 CA 여섯 줄로 보인다.
 * 실패가 있으면 다음으로 갈 수 없고, 주의(메일 이름 빠짐 · 발급 CA 없음 등)는 그대로 갈 수 있다.
 */
import { useState } from 'react'
import { UiCallout } from '~/components/ui/Callout'
import { UiCard } from '~/components/ui/Card'
import { UiDropzone } from '~/components/ui/Dropzone'
import { UiIcon } from '~/components/ui/Icon'
import type { CertCheck, CertProbe } from '../api/types'
import { josa, useHas, useLocale, useT } from '../i18n'
import { StepNav, useGoNext } from '../shell/StepNav'
import { Heading, WizardShell } from '../shell/WizardShell'
import { useWizard } from '../store'

const find = (r: CertProbe | null, id: string): CertCheck | undefined => r?.checks.find(c => c.id === id)

function Cell({ check, good, bad }: { check: CertCheck | undefined; good: string; bad: string }) {
  if (!check) return <span className="text-muted-foreground">—</span>
  const look = check.status === 'pass'
    ? { icon: 'check-circle', color: 'text-success' }
    : (check.status === 'warn' ? { icon: 'alert-triangle', color: 'text-warning' } : { icon: 'alert-circle', color: 'text-danger' })
  return (
    <span className="inline-flex items-start gap-1.5">
      <span className={`mt-0.5 flex shrink-0 ${look.color}`}><UiIcon name={look.icon} aria-hidden="true" className="size-4" /></span>
      <span className="min-w-0 break-words">{check.status === 'pass' ? good : bad}</span>
    </span>
  )
}

export function CertScreen() {
  const t = useT()
  const has = useHas()
  const { locale } = useLocale()
  const domain = useWizard(s => s.answers.access.domain)
  const probe = useWizard(s => s.cert)
  const names = useWizard(s => s.certFiles)
  const checkCert = useWizard(s => s.checkCert)
  const [cert, setCert] = useState<File | null>(null)
  const [key, setKey] = useState<File | null>(null)
  const [ca, setCa] = useState<File | null>(null)
  const { goNext } = useGoNext('cert')

  function take(kind: 'cert' | 'key' | 'ca', file: File | null) {
    const c = kind === 'cert' ? file : cert
    const k = kind === 'key' ? file : key
    const a = kind === 'ca' ? file : ca
    if (kind === 'cert') setCert(file)
    else if (kind === 'key') setKey(file)
    else setCa(file)
    if (c && k) void checkCert(c, k, a)
  }

  const result = probe.status === 'done' ? probe.result : null
  const checking = probe.status === 'checking'
  const certName = cert?.name ?? names.cert
  const keyName = key?.name ?? names.key
  const caName = ca?.name ?? names.ca
  const date = (iso: unknown) => {
    const d = typeof iso === 'string' ? new Date(iso) : null
    return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(locale === 'ko' ? 'ko-KR' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : ''
  }

  // 올린 파일에서 걸린 것 — 실패가 있으면 그것 하나, 없으면 주의를 모두 보인다
  const issues = (result?.checks ?? []).filter(c => c.status !== 'pass')
  const failure = issues.find(c => c.status === 'fail')
  const shownList = failure ? [failure] : issues
  const mailHost = String(find(result, 'mail_host_covered')?.value ?? '')
  const chain = find(result, 'chain')
  const caIssues = find(result, 'ca_issues_cert')

  const blocked = !certName || !keyName
    ? t('cert.reasonEmpty')
    : (checking
        ? t('cert.reasonChecking')
        : (probe.status === 'error' || !result
            ? t('cert.reasonOther')
            : (failure ? (has(`cert.reason.${failure.fix?.key}`) ? t(`cert.reason.${failure.fix?.key}`) : t('cert.reason.other')) : '')))

  const domainCheck = find(result, 'domain_covered')
  const validity = find(result, 'validity')
  const otherName = Array.isArray(domainCheck?.value) ? String((domainCheck?.value as unknown[])[0] ?? '') : ''
  const row = 'grid grid-cols-1 gap-x-4 gap-y-0.5 border-t border-border px-4 py-2.5 first:border-t-0 sm:grid-cols-[140px_1fr]'

  return (
    <WizardShell step="cert">
      <Heading title={t('cert.title')} lead={t('cert.lead')} />
      <div className="flex flex-col gap-3">
        <UiDropzone layout="row" filled={!!certName} title={t('cert.certSlot')} description={certName ?? t('cert.certEmpty')} buttonLabel={certName ? t('cert.replace') : t('cert.choose')} buttonIcon="upload" accept=".pem,.crt,.cer" onFiles={f => take('cert', f[0])} />
        <UiDropzone layout="row" filled={!!keyName} title={t('cert.keySlot')} description={keyName ?? t('cert.keyEmpty')} buttonLabel={keyName ? t('cert.replace') : t('cert.choose')} buttonIcon="upload" accept=".pem,.key" onFiles={f => take('key', f[0])} />
        <UiDropzone layout="row" filled={!!caName} title={t('cert.caSlot')} description={caName ?? t('cert.caEmpty')} buttonLabel={caName ? t('cert.replace') : t('cert.choose')} buttonIcon="upload" accept=".pem,.crt,.cer" onFiles={f => take('ca', f[0])} />
        <p className="m-0 text-xs leading-[18px] text-muted-foreground" data-testid="cert-ca-note">
          {t('cert.caNote')}
          {ca && <>{' '}<button type="button" className="underline underline-offset-2" onClick={() => take('ca', null)}>{t('cert.caRemove')}</button></>}
        </p>
      </div>
      {checking && <UiCallout variant="plain" tone="neutral" icon="loader" spin role="status">{t('cert.checking')}</UiCallout>}
      {probe.status === 'error' && <UiCallout tone="danger" role="alert">{t('common.probeFailed')}</UiCallout>}
      {result && (
        <UiCard className="overflow-hidden">
          <dl className="m-0 text-[13px]">
            <div className={row}>
              <dt className="text-muted-foreground">{t('cert.rowDomain')}</dt>
              <dd className="m-0"><Cell check={domainCheck} good={t('cert.domainOk', { name: domain })} bad={otherName ? t('cert.domainBad', { name: otherName }) : t('cert.domainBadNoName')} /></dd>
            </div>
            {find(result, 'mail_host_covered') && (
              <div className={row}>
                <dt className="text-muted-foreground">{t('cert.rowMail')}</dt>
                <dd className="m-0"><Cell check={find(result, 'mail_host_covered')} good={t('cert.mailOk', { name: mailHost })} bad={t('cert.mailBad', { name: mailHost })} /></dd>
              </div>
            )}
            <div className={row}>
              <dt className="text-muted-foreground">{t('cert.rowKey')}</dt>
              <dd className="m-0"><Cell check={find(result, 'key_matches')} good={t('cert.keyOk')} bad={t('cert.keyBad')} /></dd>
            </div>
            <div className={row}>
              <dt className="text-muted-foreground">{t('cert.rowExpiry')}</dt>
              <dd className="m-0">
                <Cell
                  check={validity}
                  good={date(result.not_after) ? t('cert.expiryOk', { date: date(result.not_after) }) : t('cert.expiryOkNoDate')}
                  bad={validity?.fix?.key === 'cert_expired'
                    ? (date(validity.value) ? t('cert.expiryBad', { date: date(validity.value) }) : t('cert.expiryBadNoDate'))
                    : (date(result.not_after) ? t('cert.expiryOk', { date: date(result.not_after) }) : t('cert.expiryOkNoDate'))}
                />
              </dd>
            </div>
            {result.issuer && (
              <div className={row}>
                <dt className="text-muted-foreground">{t('cert.rowIssuer')}</dt>
                <dd className="m-0 break-words font-mono text-xs">{result.issuer}</dd>
              </div>
            )}
            {(chain || caIssues) && (
              <div className={row} data-testid="cert-row-ca">
                <dt className="text-muted-foreground">{t('cert.rowCa')}</dt>
                <dd className="m-0"><Cell check={caIssues ?? chain} good={t('cert.caOk')} bad={caIssues ? t('cert.caBad') : t('cert.caMissing')} /></dd>
              </div>
            )}
          </dl>
        </UiCard>
      )}
      {shownList.map((shown) => {
        const shownKey = shown.fix?.key ?? ''
        const msgKey = has(`cert.msg.${shownKey}.title`) ? shownKey : 'other'
        const msgVars = { domain, p: josa(domain, '이/가'), host: mailHost, code: shownKey, ...(shown.fix?.vars ?? {}) }
        return (
          <UiCallout key={shown.id} data-check={shown.id} tone={shown.status === 'fail' ? 'danger' : 'warning'} role={shown.status === 'fail' ? 'alert' : undefined} title={t(`cert.msg.${msgKey}.title`, msgVars)}>
            {t(`cert.msg.${msgKey}.body`, msgVars)}
          </UiCallout>
        )
      })}
      <StepNav step="cert" blocked={blocked} onNext={() => goNext({ access: { cert: 'upload' } })} />
      <p className="m-0 text-xs text-muted-foreground">{t('cert.footnote')}</p>
    </WizardShell>
  )
}
