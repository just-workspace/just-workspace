/**
 * 설정 › 메일 › 계정 — "메일 앱 연결" 카드. 아웃룩·애플 메일·삼성 메일 등 외부 앱에 내장 메일 계정을 등록하는 안내.
 * API: GET /api/mail/client-setup(서버·포트·아이디), GET /api/mail/client-setup/apple.mobileconfig(애플 구성 프로필).
 * 내장 메일 계정이 없으면(404) 카드를 표시하지 않는다.
 */
import { useEffect, useState } from 'react'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { addToast } from '~/composables/useToast'
import { UiIconButton } from '~/components/ui/IconButton'
import { SettingsCard } from './SettingsCard'

type Setup = {
  email: string
  username: string
  imap: { host: string; port: number; security: string }
  smtp: { host: string; port: number; security: string; alt_port: number; alt_security: string }
}

/** copy = 복사할 값(서버 행은 호스트 이름만) */
function Row({ label, value, copy: copyValue, copyLabel }: { label: string; value: string; copy?: string; copyLabel: string }) {
  const { t } = useI18n()
  async function copy() {
    try { await navigator.clipboard.writeText(copyValue ?? value); addToast('success', t('settings.mail.clientCopied')) } catch { /* 권한 없음 — 무시 */ }
  }
  return (
    <div className="flex items-center gap-3 border-t border-border px-5 py-2 text-[13px]">
      <div className="w-28 shrink-0 text-muted-foreground">{label}</div>
      <div className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{value}</div>
      <UiIconButton icon="copy" size="sm" label={`${copyLabel} ${label}`} onClick={() => void copy()} />
    </div>
  )
}

export function SettingsMailClientSetup() {
  const { t } = useI18n()
  const [setup, setSetup] = useState<Setup | null>(null)
  useEffect(() => {
    $fetch<Setup>('/api/mail/client-setup').then(setSetup).catch(() => setSetup(null))
  }, [])
  if (!setup) return null

  const sec = (s: string) => (s === 'ssl' ? 'SSL/TLS' : 'STARTTLS')
  const copyLabel = t('common.copy')
  return (
    <SettingsCard title={t('settings.mail.clientTitle')} description={t('settings.mail.clientDesc')} flush>
      <Row label={t('settings.mail.clientUsername')} value={setup.username} copyLabel={copyLabel} />
      <Row label={t('settings.mail.clientImap')} value={`${setup.imap.host} · ${setup.imap.port} · ${sec(setup.imap.security)}`} copy={setup.imap.host} copyLabel={copyLabel} />
      <Row label={t('settings.mail.clientSmtp')} value={`${setup.smtp.host} · ${setup.smtp.port} · ${sec(setup.smtp.security)}`} copy={setup.smtp.host} copyLabel={copyLabel} />
      <Row label={t('settings.mail.clientSmtpAlt')} value={`${setup.smtp.host} · ${setup.smtp.alt_port} · ${sec(setup.smtp.alt_security)}`} copy={setup.smtp.host} copyLabel={copyLabel} />
      <div className="flex flex-col gap-2 border-t border-border px-5 py-3 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href="/api/mail/client-setup/apple.mobileconfig"
            download
            className="inline-flex h-8 items-center rounded-md border border-border px-3 text-[13px] font-semibold text-foreground hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >{t('settings.mail.clientAppleProfile')}</a>
          <span>{t('settings.mail.clientAppleHint')}</span>
        </div>
        <p>{t('settings.mail.clientPassword')}</p>
        <p>{t('settings.mail.clientAuto')}</p>
        <p>{t('settings.mail.clientPush')}</p>
      </div>
    </SettingsCard>
  )
}
