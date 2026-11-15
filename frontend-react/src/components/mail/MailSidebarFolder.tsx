/**
 * 메일 폴더 한 줄 — Vue 판 components/mail/MailSidebarFolder.vue: 34 · rounded-sm · 아이콘 16 · 개수 mono 12.
 * 고른 폴더 = primary/13 + 600. 모바일(드로어)은 터치 타깃 40. 플랫 목록·다계정 트리 공용.
 * 표시+선택만 담당하고 폴더 메뉴는 actions(Vue #actions 슬롯).
 */
import type { ReactNode } from 'react'
import { useI18n } from '~/i18n'
// Vue 의 class 묶음처럼 그냥 잇는다(tailwind-merge 를 쓰는 cn 은 leading-[1.35]+text-xl 같은 짝을 지워 Vue 와 달라진다)
import { clsx as cx } from 'clsx'
import { MAILBOX_ROLE_KEYS } from '~/utils/mailQuery'
import { UiIcon } from '~/components/ui/Icon'

const ICON: Record<string, string> = {
  inbox: 'inbox', sent: 'send', drafts: 'file', trash: 'trash', junk: 'alert-triangle', archive: 'archive', flagged: 'star',
  scheduled: 'clock',
}

export interface MailSidebarFolderProps {
  /** 메일함(id·name·role·unread_count·total_count) */
  mb: any
  /** 고른 폴더 */
  active: boolean
  /** 다계정 트리 들여쓰기 */
  indent?: boolean
  /** 고름 */
  onSelect?: () => void
  /** 오른쪽 폴더 메뉴(Vue #actions 슬롯) */
  actions?: ReactNode
  /** 루트에 덧붙일 클래스 */
  className?: string
}

/** 메일 폴더 줄 */
export function MailSidebarFolder({ mb, active, indent, onSelect, actions, className }: MailSidebarFolderProps) {
  const { t } = useI18n()
  const label = mb.role && MAILBOX_ROLE_KEYS[mb.role] ? t(MAILBOX_ROLE_KEYS[mb.role]) : mb.name
  const glyph = ICON[mb.role || ''] || 'folder'
  // 임시보관함·예약함은 안 읽음이 의미 없어 전체 수(시안 "임시보관함 3")
  const n = mb.role === 'drafts' || mb.role === 'scheduled' ? mb.total_count : mb.unread_count
  const count = n > 0 ? (n > 999 ? '999+' : String(n)) : ''

  return (
    <div className={cx('group relative flex items-center', className ?? '')}>
      <button
        type="button"
        aria-current={active ? 'page' : undefined}
        className={cx(
          'flex h-10 w-full min-w-0 items-center gap-2.5 rounded-sm px-2 text-left text-[13.5px] transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:h-[34px]',
          active ? 'bg-primary/[0.13] font-semibold text-foreground' : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
          indent ? 'pl-6' : '',
          actions ? 'pr-9' : '',
        )}
        onClick={() => onSelect?.()}
      >
        <UiIcon name={glyph} className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count && <span className={cx('shrink-0 font-mono text-xs', mb.role === 'inbox' && !active ? 'text-foreground' : '')}>{count}</span>}
      </button>
      {actions && (
        <div className="absolute right-0.5 top-1/2 -translate-y-1/2">
          {actions}
        </div>
      )}
    </div>
  )
}

export default MailSidebarFolder
