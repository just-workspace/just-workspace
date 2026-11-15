/**
 * 업데이트 예고 띠 — 카운트다운 동안 앱 어디서든 상단바 아래에 붙는다("하던 일을 저장하세요").
 * 관리자에게만 "지금 바로 시작"·"취소"가 보인다. 일반 사용자에게는 관리 메뉴도 이름도 그리지 않는다.
 * 남은 시간 숫자는 화면 낭독기에 읽히지 않는다(매초 바뀐다) — 낭독되는 것은 분 단위로 바뀌는 문장뿐이다.
 */
import { useState } from 'react'
import { useI18n } from '~/i18n'
import { useAuth } from '~/composables/useAuth'
import { useNowTick } from '~/composables/useNowTick'
import { addToast } from '~/composables/useToast'
import { useUpdateNotice, handleUpdateEvent } from '~/composables/useUpdateNotice'
import { updateApi, clock, splitDuration } from '~/composables/useSystemUpdate'
import { UiIcon } from '~/components/ui/Icon'
import { UiButton } from '~/components/ui/Button'

/** 예상 중단 시간 문구 — "4분" · "40초" · "4분 30초" */
export function useDurationText() {
  const { t } = useI18n()
  return (seconds: number | null | undefined): string => {
    const d = splitDuration(seconds)
    if (!d) return ''
    if (!d.m) return t('shell.update.seconds', { s: d.s })
    return d.s ? t('shell.update.minutesSeconds', { m: d.m, s: d.s }) : t('shell.update.minutes', { m: d.m })
  }
}

export function LayoutUpdateCountdownBanner() {
  const { t } = useI18n()
  const { user } = useAuth()
  const notice = useUpdateNotice()
  const active = notice.state === 'countdown' && !!notice.endsAt
  const now = useNowTick(active)
  const duration = useDurationText()
  const [busy, setBusy] = useState(false)
  if (!active) return null

  const left = Math.max(0, Math.ceil((notice.endsAt! - now) / 1000))
  const minutes = Math.ceil(left / 60)
  const restore = notice.kind === 'restore'
  const title = left <= 60
    ? t(restore ? 'shell.update.countdown.soonRestore' : 'shell.update.countdown.soon')
    : t(restore ? 'shell.update.countdown.titleRestore' : 'shell.update.countdown.title', { n: minutes })
  const expected = duration(notice.expectedSeconds)
  const admin = !!user?.is_admin && !!notice.job

  async function act(action: 'start_now' | 'cancel') {
    if (!notice.job) return
    setBusy(true)
    try {
      await updateApi.jobAction(notice.job, action)
      // 소켓 이벤트를 기다리지 않고 이 화면부터 바꾼다
      if (action === 'cancel') handleUpdateEvent({ type: 'system.update_cancelled', job: notice.job })
    } catch (e: any) {
      addToast('error', e?.data?.detail || t('shell.update.countdown.failed'))
    } finally { setBusy(false) }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-warning/10 px-4 py-2.5 text-[13.5px] text-foreground" data-testid="update-countdown">
      <UiIcon name="clock" className="h-[18px] w-[18px] shrink-0 text-warning" />
      <span className="min-w-0 flex-1 basis-[240px]">
        <span role="status" aria-live="polite" className="font-semibold">{title}</span>
        {expected && <>{' '}<span className="text-muted-foreground">{t('shell.update.countdown.sub', { time: expected })}</span></>}
      </span>
      <span aria-hidden="true" className="font-mono text-base font-medium" data-testid="update-countdown-clock">{clock(left)}</span>
      {admin && (
        <span className="flex flex-wrap items-center gap-2">
          <UiButton size="xs" disabled={busy} onClick={() => { void act('start_now') }}>{t('shell.update.countdown.startNow')}</UiButton>
          <UiButton size="xs" variant="outline" disabled={busy} onClick={() => { void act('cancel') }}>{t('common.cancel')}</UiButton>
        </span>
      )}
    </div>
  )
}

export default LayoutUpdateCountdownBanner
