/**
 * 완료 — 접속 주소와 다음에 할 일. 설치와 복원의 문구·할 일 목록이 다르다.
 * 할 일은 해당할 때만 보인다(임시 인증서로 설치했을 때의 인증서 발급, 맞지 않는 메일 레코드가 있을 때의 등록).
 * 이 화면은 설치를 끝낸 그 창에서만 보인다 — 나중에 같은 주소로 다시 들어오면 잠김 화면이 뜬다.
 */
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiInput } from '~/components/ui/Input'
import { useT } from '../i18n'
import { CenterShell } from '../shell/WizardShell'
import { useWizard, zoneOn } from '../store'
import { recordsPending } from './MailScreen'

/** href 가 없으면 관리 화면에 갈 곳이 없는 할 일(서버 밖에서 하는 일) — 누를 수 없는 줄로 그린다 */
interface Todo { icon: string; title: string; desc: string; href?: string; caution?: boolean }

export function DoneScreen() {
  const t = useT()
  const answers = useWizard(s => s.answers)
  const catalog = useWizard(s => s.catalog)
  const appUrl = useWizard(s => s.server?.info.app_url ?? null)
  const records = useWizard(s => s.records.result?.records ?? null)
  const restore = answers.mode === 'restore'

  const url = (appUrl ?? (answers.access.domain ? `https://${answers.access.domain}` : '')).replace(/\/+$/, '')
  const at = (path: string) => `${url}${path}`
  const temporary = answers.access.cert === 'temporary'
  const pending = records && zoneOn(answers, catalog, 'mail') && answers.mail.kind === 'builtin' ? recordsPending(records).total : 0

  const todos: Todo[] = []
  if (temporary) todos.push({ icon: 'shield', title: t('done.certTitle'), desc: t('done.certDesc'), caution: true })
  if (restore) {
    todos.push(
      { icon: 'globe', title: t('restore.moveTitle'), desc: t('restore.moveDesc') },
      { icon: 'mail', title: t('restore.recordsTitle'), desc: t('restore.recordsDesc'), href: at('/admin/mail') },
      { icon: 'database', title: t('restore.backupTitle'), desc: t('restore.backupDesc'), href: at('/admin/storage') },
      { icon: 'server', title: t('restore.oldTitle'), desc: t('restore.oldDesc') },
    )
  } else {
    todos.push(
      { icon: 'user-plus', title: t('done.inviteTitle'), desc: t('done.inviteDesc'), href: at('/admin/users') },
      { icon: 'database', title: t('done.backupTitle'), desc: t('done.backupDesc'), href: at('/admin/storage') },
    )
    if (pending > 0) todos.push({ icon: 'mail', title: t('done.recordsTitle'), desc: t('done.recordsDesc', { n: pending }), href: at('/admin/mail'), caution: true })
  }

  return (
    <CenterShell width={520}>
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-success/10 text-success"><UiIcon name="check" aria-hidden="true" strokeWidth={2.4} className="size-5" /></span>
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="m-0 text-xl font-bold leading-7">{restore ? t('restore.doneTitle') : t('done.title')}</h1>
          <p className="m-0 text-muted-foreground">{restore ? t('restore.doneLead') : t('done.lead')}</p>
        </div>
      </div>
      {url && (
        <>
          <UiInput label={t('done.address')} readonly mono modelValue={url} />
          <UiButton as="a" size="lg" className="w-full" iconRight="external-link" href={url}>{t('done.open')}</UiButton>
        </>
      )}
      <div className="flex flex-col gap-2">
        <h2 className="m-0 text-base font-semibold leading-6">{t('done.todoTitle')}</h2>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {todos.map(todo => {
            const body = (
              <>
                <span className="flex shrink-0 text-muted-foreground"><UiIcon name={todo.icon} aria-hidden="true" className="size-[18px]" /></span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[13px] font-semibold">{todo.title}</span>
                  <span className="text-xs text-muted-foreground">{todo.desc}</span>
                </span>
                {todo.caution && <UiBadge tone="warning" tint size={18}><UiIcon name="alert-triangle" aria-hidden="true" />{t('done.caution')}</UiBadge>}
              </>
            )
            const frame = 'flex items-center gap-3 rounded-lg border border-border px-3.5 py-2.5'
            return (
              <li key={todo.title}>
                {todo.href
                  ? (
                      <a href={todo.href} className={`${frame} text-foreground no-underline transition-colors hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background`}>
                        {body}
                        <span className="flex shrink-0 text-muted-foreground"><UiIcon name="chevron-right" aria-hidden="true" className="size-4" /></span>
                      </a>
                    )
                  : <div className={frame}>{body}</div>}
              </li>
            )
          })}
        </ul>
      </div>
    </CenterShell>
  )
}
