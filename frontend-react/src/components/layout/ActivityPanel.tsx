/**
 * 활동 패널(Vue components/layout/ActivityPanel.vue · 시안 X1·8-1-3 ②): 벨 → 우측 400(스레드 패널과 같은 폭), z-drawer, 상단바 아래부터, shadow-lg.
 * 헤더 52 = 제목 15/600 · "모두 읽음" · 알림 설정 · 닫기(Esc). 알림 드롭다운은 폐지.
 */
import { useRef } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { navigateTo } from '~/lib/router'
import { useEventListener } from '~/lib/dom'
import { useShell } from '~/composables/useShell'
import { useNotifications } from '~/composables/useNotifications'
import { UiIconButton } from '~/components/ui/IconButton'
import { ShellTransition } from './shellTransition'
import { LayoutActivityList, type ActivityListHandle } from './ActivityList'

export function LayoutActivityPanel() {
  const { t } = useI18n()
  const { activityOpen, closeActivity } = useShell()
  const { unreadCount, markAllAsRead } = useNotifications()
  const listRef = useRef<ActivityListHandle | null>(null)

  useEventListener(typeof document !== 'undefined' ? document : null, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && activityOpen) closeActivity()
  })

  return (
    <ShellTransition
      show={activityOpen}
      enterActive="transition-transform duration-150 ease-out"
      enterFrom="translate-x-full"
      leaveActive="transition-transform duration-100 ease-in"
      leaveTo="translate-x-full"
      enterMs={150}
      leaveMs={100}
    >
      {cls => (
        <aside
          aria-label={t('shell.activity.title')}
          className={cn('absolute bottom-0 right-0 z-drawer flex w-[400px] max-w-full flex-col border-l border-border bg-card shadow-lg', cls)}
          style={{ top: 'calc(56px + env(safe-area-inset-top))' }}
        >
          <div className="flex h-[52px] shrink-0 items-center gap-1 border-b border-border pl-4 pr-2">
            <h2 className="flex-1 text-[15px] font-semibold text-foreground">{t('shell.activity.title')}</h2>
            {unreadCount > 0 && (
              <button
                type="button"
                className="px-2 text-xs font-semibold text-primary hover:underline"
                onClick={() => markAllAsRead()}
              >{t('notifications.markAllRead')}</button>
            )}
            <UiIconButton label={t('shell.activity.notifySettings')} icon="settings" onClick={() => { closeActivity(); void navigateTo('/settings/notifications') }} />
            <UiIconButton label={t('common.close')} icon="close" keys={['Esc']} onClick={closeActivity} />
          </div>
          <LayoutActivityList ref={listRef} onNavigate={closeActivity} />
        </aside>
      )}
    </ShellTransition>
  )
}

export default LayoutActivityPanel
