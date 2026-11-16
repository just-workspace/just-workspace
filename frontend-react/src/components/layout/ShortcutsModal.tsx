/**
 * 단축키 도움말(Ctrl /). 키캡은 UiKeycap 20 단일 규격.
 * 모듈 묶음은 각 페이지가 usePageShortcuts('메일', [...]) 로 등록한다 — 현재 화면의 묶음이 최상단에 표시된다.
 */
import { useI18n } from '~/i18n'
import { useShell } from '~/composables/useShell'
import { usePageShortcutGroups } from '~/composables/useShortcuts'
import { UiModal } from '~/components/ui/Modal'
import { UiKeycap } from '~/components/ui/Keycap'

export function LayoutShortcutsModal() {
  const { shortcutsOpen, setShortcutsOpen } = useShell()
  const pageGroups = usePageShortcutGroups()
  const { t } = useI18n()

  if (!shortcutsOpen) return null

  const GLOBAL_GROUPS = [
    { title: t('shell.shortcuts.anywhere'), items: [
      { keys: ['Ctrl', 'K'], label: t('shell.shortcuts.palette') },
      { keys: ['>'], label: t('shell.shortcuts.commandMode') },
      { keys: ['@'], label: t('shell.shortcuts.findPerson') },
      { keys: ['#'], label: t('shell.shortcuts.findChannel') },
      { keys: ['Ctrl', '\\'], label: t('shell.shortcuts.pinSidebar') },
      { keys: ['Ctrl', '/'], label: t('shell.shortcuts.help') },
      { keys: ['Esc'], label: t('shell.shortcuts.closePanel') },
    ] },
    { title: t('shell.shortcuts.list'), items: [
      { keys: ['↑', '↓'], label: t('shell.shortcuts.moveRow') },
      { keys: ['↵'], label: t('shell.shortcuts.open') },
      { keys: ['Ctrl', '↵'], label: t('shell.shortcuts.openNewTab') },
    ] },
  ]
  const groups = [...pageGroups, ...GLOBAL_GROUPS]

  return (
    <UiModal title={t('shell.shortcuts.title')} size="md" onClose={() => setShortcutsOpen(false)}>
      <div className="flex flex-col gap-4">
        {groups.map(g => (
          <section key={g.title}>
            <h3 className="mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">{g.title}</h3>
            <ul className="divide-y divide-border">
              {g.items.map(s => (
                <li key={s.label} className="flex h-9 items-center gap-3 text-[13px]">
                  <span className="flex-1 text-foreground">{s.label}</span>
                  <span className="flex gap-0.5">{s.keys.map((k, ki) => <UiKeycap key={ki}>{k}</UiKeycap>)}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </UiModal>
  )
}

export default LayoutShortcutsModal
