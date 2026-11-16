/**
 * 컴포저 상단 띠 32.
 * 카드 위에 붙으며(위 모서리만 radius 8, 아래 테두리 없음) 카드는 아래 모서리만 둥글게 처리 — 디스코드 stackedBars.
 * - 답장: reply 아이콘 · "○○ 님에게 답장 중" · @ 켬/끔 스위치(role=switch, 변경 값은 사용자별로 보존 — 부모가 저장) · ✕(Esc)
 * - 수정: edit-3 · "메시지 수정 중" · "Esc 취소 · Enter 저장" · ✕
 * - @everyone/@here 확인: warning 톤 · alert-triangle · "@everyone — 이 채널 멤버 N명에게 알림이 갑니다" · "Enter를 한 번 더 누르면 보냅니다"
 * 모바일: 둥근 muted 띠 40, 스위치·✕ 44 터치.
 */
import { clsx as cn } from 'clsx'
import { useI18n } from '~/i18n'
import { UiIcon } from '~/components/ui/Icon'

export type ComposerBand =
  | { kind: 'reply'; name: string; ping: boolean; onTogglePing: () => void; onClose: () => void }
  | { kind: 'edit'; onClose: () => void }
  | { kind: 'everyone'; which: 'everyone' | 'here'; count: number; onClose: () => void }

export function ChatComposerBar({ band, mobile = false }: { band: ComposerBand; mobile?: boolean }) {
  const { t } = useI18n()
  const warn = band.kind === 'everyone'
  const icon = band.kind === 'reply' ? 'reply' : band.kind === 'edit' ? 'edit-3' : 'alert-triangle'
  const title = band.kind === 'reply' ? t('chat.compose.reply.title', { name: band.name })
    : band.kind === 'edit' ? t('chat.compose.edit.title')
      : t(band.which === 'here' ? 'chat.compose.everyone.titleHere' : 'chat.compose.everyone.title', { n: band.count.toLocaleString() })
  const desc = band.kind === 'edit' ? t('chat.compose.edit.hint') : band.kind === 'everyone' ? t('chat.compose.everyone.hint') : ''
  const closeLabel = band.kind === 'reply' ? t('chat.compose.reply.cancel') : band.kind === 'edit' ? t('chat.compose.edit.cancel') : t('chat.compose.everyone.cancel')

  return (
    <div
      role={warn ? 'alert' : 'status'}
      className={cn(
        'flex items-center gap-2',
        mobile
          ? 'mx-1 mb-1 h-10 rounded-lg px-3 text-[14px] ' + (warn ? 'bg-warning/10 text-warning' : 'bg-muted')
          : 'h-8 rounded-t-lg border border-b-0 px-3 text-[13px] ' + (warn ? 'border-warning/60 bg-warning/10 text-warning' : 'border-border bg-muted text-muted-foreground'),
      )}
    >
      <UiIcon name={icon} className={cn('h-4 w-4 shrink-0', mobile && !warn ? 'text-muted-foreground' : '')} />
      <span className="min-w-0 flex-1 truncate">
        <b className={cn('font-semibold', mobile || warn ? '' : 'text-foreground')}>{title}</b>
        {desc && !mobile && <> <span className={warn ? '' : 'text-muted-foreground'}>{desc}</span></>}
      </span>
      {band.kind === 'reply' && (
        <button
          type="button"
          role="switch"
          aria-checked={band.ping}
          aria-label={t('chat.compose.reply.pingAria')}
          title={band.ping ? t('chat.compose.reply.pingOnTip') : t('chat.compose.reply.pingOffTip')}
          className={cn(
            'flex shrink-0 items-center gap-1 rounded font-semibold hover:bg-overlay-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
            mobile ? 'h-9 px-2 text-[13px]' : 'h-6 px-1.5 text-[12px]',
            band.ping ? 'text-primary' : 'text-muted-foreground',
          )}
          onMouseDown={e => e.preventDefault()}
          onClick={band.onTogglePing}
        >
          <UiIcon name="at-sign" className={mobile ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
          {mobile ? (band.ping ? t('chat.compose.reply.onShort') : t('chat.compose.reply.offShort')) : (band.ping ? t('chat.compose.reply.on') : t('chat.compose.reply.off'))}
        </button>
      )}
      <button
        type="button"
        aria-label={closeLabel}
        title={`${closeLabel} (Esc)`}
        className={cn(
          'flex shrink-0 items-center justify-center rounded hover:bg-overlay-hover hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
          mobile ? '-mr-2 h-11 w-11' : 'h-6 w-6',
          warn ? '' : 'text-muted-foreground',
        )}
        onMouseDown={e => e.preventDefault()}
        onClick={band.onClose}
      >
        <UiIcon name="close" className="h-4 w-4" />
      </button>
    </div>
  )
}

export default ChatComposerBar
