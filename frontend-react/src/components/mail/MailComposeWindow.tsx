/**
 * 떠 있는 작성 창 하나 — Vue 판 components/mail/MailComposeWindow.vue: 580×640, 위 모서리 12, 아래 테두리 없음, 그림자 0 -8 40 scrim/55.
 * 제목 줄 44(secondary): 제목 · 최소화(—) · 크게 보기 · 닫기(임시보관함에 저장). 최소화하면 제목 줄만.
 * 최소화해도 작성기는 살아 있다(Vue v-show → MailComposer show=false).
 */
import { useRef, type KeyboardEvent } from 'react'
import { useI18n } from '~/i18n'
// Vue 의 class 묶음처럼 그냥 잇는다(tailwind-merge 를 쓰는 cn 은 leading-[1.35]+text-xl 같은 짝을 지워 Vue 와 달라진다)
import { clsx as cx } from 'clsx'
import { closeCompose, setComposeMinimized, toggleComposeMaximized, setComposeTitle, type ComposeWindow } from '~/composables/useMailCompose'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiIcon } from '~/components/ui/Icon'
import { MailComposer, type MailComposerHandle } from '~/components/mail/MailComposer'

export interface MailComposeWindowProps {
  /** 창 상태(useMailCompose windows 의 한 항목) */
  win: ComposeWindow
  /** 화면 오른쪽에서 떨어진 거리 px */
  right: number
  /** 창 폭 px(최소화 280 · 펼침 580) */
  width: number
}

/** 데스크톱 떠 있는 작성 창 */
export function MailComposeWindow({ win, right, width }: MailComposeWindowProps) {
  const { t } = useI18n()
  const composer = useRef<MailComposerHandle | null>(null)

  function onTitleBarClick() { if (win.minimized) setComposeMinimized(win.id, false) }
  async function requestClose() {
    // 최소화돼 있어도 컴포저는 살아 있다(v-show) — 저장 후 닫는다
    if (composer.current) await composer.current.close()
    else closeCompose(win.id)
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && win.maximized) { e.stopPropagation(); toggleComposeMaximized(win.id) }
  }

  return (
    <div
      role="dialog"
      aria-label={win.title}
      className={cx(
        'pointer-events-auto absolute flex flex-col overflow-hidden border border-border bg-card shadow-[0_-8px_40px_hsl(var(--scrim)/0.55)]',
        win.maximized
          ? 'inset-x-[8%] bottom-0 top-[6%] rounded-t-lg'
          : 'bottom-0 rounded-t-lg border-b-0',
      )}
      style={win.maximized ? undefined : { right: `${right}px`, width: `${width}px`, height: win.minimized ? '44px' : 'min(640px, calc(100% - 16px))' }}
      onKeyDown={onKey}
    >
      <div
        className={cx('flex h-11 shrink-0 items-center bg-secondary pl-4 pr-1.5 text-[13px] font-semibold', win.minimized ? 'cursor-pointer' : '')}
        onClick={(e) => { if (e.target === e.currentTarget) onTitleBarClick() }}
      >
        <span className="min-w-0 flex-1 truncate" onClick={onTitleBarClick}>{win.title}</span>
        <UiIconButton label={win.minimized ? t('mail.window.expand') : t('mail.window.minimize')} onClick={() => setComposeMinimized(win.id, !win.minimized)}><UiIcon name="minus" /></UiIconButton>
        <UiIconButton label={win.maximized ? t('mail.window.restore') : t('mail.window.maximize')} pressed={win.maximized} onClick={() => toggleComposeMaximized(win.id)}><UiIcon name="maximize" /></UiIconButton>
        <UiIconButton label={t('mail.window.closeSave')} icon="close" onClick={requestClose} />
      </div>
      <MailComposer
        show={!win.minimized}
        ref={composer}
        variant="window"
        mode={win.mode}
        msgId={win.msgId}
        draftId={win.draftId}
        original={win.original}
        to={win.to}
        aiDraft={win.aiDraft}
        onTitle={title => setComposeTitle(win.id, title)}
        onClose={() => closeCompose(win.id)}
      />
    </div>
  )
}

export default MailComposeWindow
