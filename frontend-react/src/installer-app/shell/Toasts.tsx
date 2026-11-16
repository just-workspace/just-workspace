/**
 * 짧은 알림 — "복사했습니다" 같은 결과를 화면 하단에 잠시 표시한다.
 * UI 키트의 알림 저장소(useToast)를 그대로 조회하여 렌더링만 수행한다(키트의 UiToast 는 워크스페이스 셸에 종속되어 사용하지 않는다).
 */
import { useStore } from 'zustand'
import { removeToast, toastStore } from '~/composables/useToast'
import { UiIcon } from '~/components/ui/Icon'
import { useT } from '../i18n'

const ICON = { success: 'check-circle', error: 'alert-circle', warning: 'alert-triangle', info: 'info' } as const
const COLOR = { success: 'text-success', error: 'text-danger', warning: 'text-warning', info: 'text-muted-foreground' } as const

export function Toasts() {
  const t = useT()
  const toasts = useStore(toastStore, s => s.toasts)
  return (
    <div role="status" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
      {toasts.map(x => (
        <div key={x.id} className="pointer-events-auto flex max-w-full items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-[13px] shadow-md">
          <span className={`flex shrink-0 ${COLOR[x.type]}`}><UiIcon name={ICON[x.type]} aria-hidden="true" className="size-4" /></span>
          <span className="min-w-0 break-words">{x.message}</span>
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={() => removeToast(x.id)}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <UiIcon name="close" aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
