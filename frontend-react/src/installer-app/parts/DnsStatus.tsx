/**
 * 접속 주소 확인 결과 한 줄 — 확인 중 · 일치 · 불일치(가리키는 대상) · 확인 불가.
 * 접속 주소가 변경되면 잠시 대기한 뒤 재확인한다(입력마다 조회하지 않는다).
 */
import { useEffect } from 'react'
import { UiButton } from '~/components/ui/Button'
import { UiCallout } from '~/components/ui/Callout'
import type { DnsProbe } from '../api/types'
import { isAccessAddress, isIpv4 } from '../format'
import { josa, M, useT } from '../i18n'
import { useWizard, type Probe } from '../store'

const DEBOUNCE_MS = 600

export type DnsView = 'idle' | 'invalid' | 'checking' | 'match' | 'mismatch' | 'unknown'

/** 현재 입력값에 대한 확인 결과 — 다른 값을 확인한 결과는 사용하지 않음 */
export function dnsView(domain: string, probe: Probe<DnsProbe>): DnsView {
  const d = domain.trim()
  if (!d) return 'idle'
  if (!isAccessAddress(d)) return 'invalid'
  if (probe.key !== d || probe.status === 'idle' || probe.status === 'checking') return 'checking'
  if (probe.status === 'error' || !probe.result) return 'unknown'
  return probe.result.status
}

/** 접속 주소 변경 시 재확인 */
export function useDnsCheck(domain: string): DnsView {
  const probe = useWizard(s => s.dns)
  const checkDns = useWizard(s => s.checkDns)
  const d = domain.trim()
  const stale = probe.key !== d
  useEffect(() => {
    if (!d || !isAccessAddress(d) || !stale) return
    const timer = setTimeout(() => { void checkDns(d) }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [d, stale, checkDns])
  return dnsView(domain, probe)
}

export function DnsStatus({ domain }: { domain: string }) {
  const t = useT()
  const probe = useWizard(s => s.dns)
  const checkDns = useWizard(s => s.checkDns)
  const view = dnsView(domain, probe)
  const r = probe.key === domain.trim() ? probe.result : null
  const again = <UiButton type="button" variant="outline" size="xs" icon="refresh" onClick={() => { void checkDns(domain) }}>{t('common.recheck')}</UiButton>

  if (view === 'idle') return <p className="m-0 text-[13px] text-muted-foreground">{t('dns.idle')}</p>
  if (view === 'invalid') return <UiCallout variant="plain" tone="danger" role="status">{t('dns.invalid')}</UiCallout>
  if (view === 'checking') return <UiCallout variant="plain" tone="neutral" icon="loader" spin role="status" title={t('dns.checking')}>{t('dns.checkingBody')}</UiCallout>
  if (view === 'match') {
    const ip = r?.public_ip ?? r?.addresses[0] ?? ''
    return (
      <UiCallout variant="plain" tone="success" role="status" title={t('dns.match')}>
        {isIpv4(domain.trim()) ? <M k="dns.matchIp" v={{ ip }} /> : <M k="dns.matchBody" v={{ ip, p: josa(ip, '을/를') }} />}
      </UiCallout>
    )
  }
  if (view === 'mismatch') {
    const found = r?.addresses.join(', ') ?? ''
    return (
      <UiCallout variant="plain" tone="danger" role="status" title={t('dns.mismatch')} actions={again}>
        {!found
          ? <M k="dns.mismatchNoRecord" v={{ ip: r?.public_ip ?? '' }} />
          : (r?.public_ip
              ? <M k="dns.mismatchBody" v={{ found, ip: r.public_ip, p: josa(found, '을/를') }} />
              : <M k="dns.mismatchNoIp" v={{ found, p: josa(found, '을/를') }} />)}
      </UiCallout>
    )
  }
  return (
    <UiCallout variant="plain" tone="warning" role="status" title={t('dns.unknown')} actions={again}>
      {probe.status === 'error' ? t('common.probeFailed') : (r?.reason === 'public_ip_unknown' ? t('dns.unknownNoPublicIp') : t('dns.unknownBody'))}
    </UiCallout>
  )
}
