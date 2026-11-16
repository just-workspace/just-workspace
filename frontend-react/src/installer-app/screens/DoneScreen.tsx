/**
 * 완료 — 접속 주소와 후속 할 일. 설치와 복원의 문구·할 일 목록이 상이하다.
 * 할 일은 해당하는 경우에만 표시한다(임시 인증서로 설치한 경우의 인증서 발급, 불일치하는 메일 레코드가 있는 경우의 등록).
 * 복원은 파일 처리 결과(복원함 · 백업에 없었음 · 동일한 네트워크 저장소를 재연결)를 한 줄 추가한다 —
 * 이 화면은 서버가 잠긴 이후에 표시되므로 서버에 재조회하지 않고, 적용 화면이 마지막으로 수신한 상태를 사용한다.
 * 이 화면은 설치를 완료한 해당 창에서만 표시된다 — 이후 동일 주소로 재진입하면 잠김 화면이 표시된다.
 */
import { UiBadge } from '~/components/ui/Badge'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiInput } from '~/components/ui/Input'
import { useHas, useT } from '../i18n'
import { CenterShell } from '../shell/WizardShell'
import { useWizard, zoneOn } from '../store'
import { recordsPending } from './MailScreen'

/** href 가 없으면 관리 화면에 이동 대상이 없는 할 일(서버 외부에서 수행하는 일) — 클릭할 수 없는 줄로 렌더링 */
interface Todo { icon: string; title: string; desc: string; href?: string; caution?: boolean }

export function DoneScreen() {
  const t = useT()
  const has = useHas()
  const answers = useWizard(s => s.answers)
  const catalog = useWizard(s => s.catalog)
  const appUrl = useWizard(s => s.server?.info.app_url ?? null)
  const records = useWizard(s => s.records.result?.records ?? null)
  const restore = answers.mode === 'restore'
  const outcome = useWizard(s => s.apply?.restore ?? null)

  const url = (appUrl ?? (answers.access.domain ? `https://${answers.access.domain}` : '')).replace(/\/+$/, '')
  const at = (path: string) => `${url}${path}`
  // 복원의 인증서 방식은 서버가 결정함
  const temporary = restore && outcome ? outcome.cert === 'temporary' : answers.access.cert === 'temporary'
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
          {restore && outcome && has(`restore.doneFiles.${outcome.files}`) && <p className="m-0 text-muted-foreground">{t(`restore.doneFiles.${outcome.files}`)}</p>}
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
