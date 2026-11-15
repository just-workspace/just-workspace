/**
 * 잠김 — 설치가 끝난 뒤 이 주소로 다시 들어왔을 때. 로그인 화면으로 보내고, 다시 설치하는 방법을 조용히 알린다.
 * 주소와 명령은 서버가 알려 준 것만 보인다.
 */
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { josa, M, useT } from '../i18n'
import { CenterShell } from '../shell/WizardShell'
import { useWizard } from '../store'

export function LockedScreen() {
  const t = useT()
  const info = useWizard(s => s.server?.info)
  const command = info?.commands?.reinstall
  return (
    <CenterShell>
      <div className="flex flex-col gap-3">
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"><UiIcon name="lock" aria-hidden="true" className="size-5" /></span>
        <div className="flex flex-col gap-2">
          <h1 className="m-0 text-xl font-bold leading-7">{t('locked.title')}</h1>
          <p className="m-0 text-muted-foreground">{t('locked.lead')}</p>
        </div>
      </div>
      {info?.app_url && <UiButton as="a" size="lg" className="w-full" href={info.app_url}>{t('locked.login')}</UiButton>}
      {command && <p className="m-0 text-xs text-muted-foreground"><M k="locked.reinstall" v={{ command, p: josa(command, '을/를') }} /></p>}
    </CenterShell>
  )
}
