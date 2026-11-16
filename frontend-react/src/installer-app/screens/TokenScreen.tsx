/**
 * 설치 토큰 — 주소에 토큰 없이 진입했거나, 토큰이 불일치 또는 만료된 경우의 관문.
 * 입력한 토큰은 세션 생성 요청에만 사용하며 어디에도 저장하지 않는다.
 */
import { useState, type FormEvent } from 'react'
import { UiButton } from '~/components/ui/Button'
import { UiCallout } from '~/components/ui/Callout'
import { UiInput } from '~/components/ui/Input'
import type { SessionStatus } from '../api/types'
import { josa, M, useT } from '../i18n'
import { CenterShell } from '../shell/WizardShell'
import { useWizard } from '../store'

export function TokenScreen() {
  const t = useT()
  const session = useWizard(s => s.server?.session ?? 'none')
  const retryAfter = useWizard(s => s.server?.retry_after)
  const command = useWizard(s => s.server?.info.commands?.reissue_token)
  const submitToken = useWizard(s => s.submitToken)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [networkFailed, setNetworkFailed] = useState(false)
  // 입력 수정을 시작하면 이전 오류는 제거
  const [dirty, setDirty] = useState(false)

  const errorOf = (s: SessionStatus): string | undefined => {
    if (s === 'wrong') return t('token.errorWrong')
    if (s === 'expired') return t('token.errorExpired')
    if (s === 'locked') return retryAfter ? t('token.errorLocked', { sec: retryAfter }) : t('token.errorLockedNoTime')
    return undefined
  }
  const error = networkFailed ? t('token.errorNetwork') : (dirty ? undefined : errorOf(session))

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!value.trim() || busy) return
    setBusy(true)
    setNetworkFailed(false)
    try {
      await submitToken(value.trim())
      setDirty(false)
    } catch {
      setNetworkFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <CenterShell>
      <form className="flex flex-col gap-5" onSubmit={e => { void submit(e) }} noValidate>
        <div className="flex flex-col gap-2">
          <h1 className="m-0 text-xl font-bold leading-7">{t('token.title')}</h1>
          <p className="m-0 text-muted-foreground">{session === 'none' ? t('token.leadNone') : t('token.leadOther')}</p>
        </div>
        <UiInput
          label={t('token.label')}
          size="lg"
          mono
          autoCapitalize="characters"
          spellCheck={false}
          placeholder={t('token.placeholder')}
          modelValue={value}
          onUpdateModelValue={v => { setValue(v); setDirty(true); setNetworkFailed(false) }}
          error={error}
        />
        {session === 'expired' && !dirty
          ? (
              <UiCallout tone="neutral" icon="clock" title={<span className="font-normal text-foreground"><M k="token.expiredTitle" /></span>}>
                {command ? <M k="token.expiredBody" v={{ command, p: josa(command, '을/를') }} /> : t('token.expiredBodyNoCommand')}
              </UiCallout>
            )
          : <p className="m-0 text-[13px] text-muted-foreground"><M k="token.help" /></p>}
        <UiButton type="submit" size="lg" className="w-full" disabled={busy || !value.trim()}>{t('token.submit')}</UiButton>
      </form>
    </CenterShell>
  )
}
