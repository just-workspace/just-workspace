/**
 * 관리자 계정 — 이름 · 아이디 · 비밀번호(두 번). 이 워크스페이스의 첫 계정이다.
 * 비밀번호는 화면 상태에만 보관하고 다음 단계로 이동할 때 서버로 송신한다. 서버가 이미 보유한 경우(이어 하기) 비워 둘 수 있다.
 */
import { useState } from 'react'
import { UiInput } from '~/components/ui/Input'
import { UiPasswordInput } from '~/components/ui/PasswordInput'
import { isDomain, isUsername } from '../format'
import { josa, M, useT } from '../i18n'
import { StepNav, useGoNext } from '../shell/StepNav'
import { Heading, WizardShell } from '../shell/WizardShell'
import { useWizard, zoneOn } from '../store'

export const PASSWORD_MIN = 12

export function AdminScreen() {
  const t = useT()
  const answers = useWizard(s => s.answers)
  const catalog = useWizard(s => s.catalog)
  const kept = useWizard(s => !!s.secretsOnServer['admin.password'])
  const password = useWizard(s => s.adminPassword)
  const setSecret = useWizard(s => s.setSecret)
  const info = useWizard(s => s.server?.info)
  const [name, setName] = useState(answers.admin.name)
  const [username, setUsername] = useState(answers.admin.username)
  const [again, setAgain] = useState(password)
  const { goNext } = useGoNext('admin')

  const uid = username.trim()
  const uidBad = uid !== '' && !isUsername(uid)
  const usingKept = kept && password === '' && again === ''
  const short = password !== '' && password.length < PASSWORD_MIN
  const mismatch = !short && again !== '' && again !== password

  // 메일 주소의 도메인 — 내장 메일 서버 사용 시 메일 도메인, 그 외 접속 주소
  const mailOn = zoneOn(answers, catalog, 'mail') && answers.mail.kind === 'builtin' && !!answers.mail.mail_domain
  const mailDomain = mailOn ? answers.mail.mail_domain! : (isDomain(answers.access.domain) ? answers.access.domain : '')
  const address = uid && !uidBad && mailDomain ? `${uid}@${mailDomain}` : ''

  let blocked = ''
  if (name.trim() === '') blocked = t('admin.reasonName')
  else if (uid === '') blocked = t('admin.reasonUsernameEmpty')
  else if (uidBad) blocked = t('admin.reasonUsername')
  else if (!usingKept) {
    if (password === '') blocked = t('admin.reasonPasswordEmpty')
    else if (short) blocked = t('admin.reasonPasswordShort', { min: PASSWORD_MIN })
    else if (again !== password) blocked = t('admin.reasonPasswordMismatch')
  }

  // 재설정 명령은 아이디를 덧붙여 사용 — 아이디가 확정된 경우에만 표시
  const reset = info?.commands?.reset_admin && uid && !uidBad ? `${info.commands.reset_admin} ${uid}` : null
  return (
    <WizardShell step="admin">
      <Heading title={t('admin.title')} lead={t('admin.lead')} />
      <div className="flex max-w-[440px] flex-col gap-5">
        <UiInput label={t('admin.name')} required autocomplete="name" modelValue={name} onUpdateModelValue={setName} />
        <UiInput
          label={t('admin.username')}
          required
          mono
          autocomplete="username"
          autoCapitalize="none"
          spellCheck={false}
          modelValue={username}
          onUpdateModelValue={setUsername}
          error={uidBad ? (info?.username_rule ? t('admin.usernameErrorRule', { rule: info.username_rule }) : t('admin.usernameError')) : undefined}
          hint={address ? t('admin.usernameHint', { address, p: josa(address, '이/가') }) : undefined}
        />
        <UiPasswordInput
          label={t('admin.password')}
          autocomplete="new-password"
          modelValue={password}
          onUpdateModelValue={v => setSecret('adminPassword', v)}
          error={short ? t('admin.passwordShort', { min: PASSWORD_MIN, n: password.length }) : undefined}
          hint={usingKept ? t('admin.passwordKept') : t('admin.passwordHint', { min: PASSWORD_MIN })}
        />
        <UiPasswordInput
          label={t('admin.password2')}
          autocomplete="new-password"
          modelValue={again}
          onUpdateModelValue={setAgain}
          error={mismatch ? t('admin.passwordMismatch') : undefined}
        />
      </div>
      <StepNav
        step="admin"
        blocked={blocked}
        onNext={() => goNext({ admin: { name: name.trim(), username: uid, ...(password ? { password } : {}) } })}
      />
      {reset && <p className="m-0 text-xs text-muted-foreground"><M k="admin.resetNote" v={{ command: reset }} /></p>}
    </WizardShell>
  )
}
