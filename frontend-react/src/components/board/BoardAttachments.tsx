/**
 * 글 첨부 — Vue 판 components/board/BoardAttachments.vue 이식.
 * 첨부마다 카드 1장 — 테두리 · rounded 10 · card 바탕 · 안쪽 10/12,
 * 유형 칩 32×36(PDF danger 틴트 등, 파일 모듈 유형 색과 같은 규칙) · 이름 600 + 크기 mono 11 · 오른쪽 "열기"(primary 600).
 * 시안의 "미리보기"는 앱 안 미리보기 모달이 게시판 첨부(공유 링크)를 열 수 없어 새 탭 "열기"로 두었다(보고서).
 */
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { fileKind, fileSize } from '~/utils/boardFormat'

export interface BoardAttachmentsProps {
  attachments: ReadonlyArray<{ name: string; url: string; size?: number }>
}

const TONE: Record<string, string> = {
  danger: 'bg-danger/[0.12] text-danger',
  primary: 'bg-primary/[0.12] text-primary',
  success: 'bg-success/[0.12] text-success',
  warning: 'bg-warning/[0.12] text-warning',
  muted: 'bg-muted text-muted-foreground',
}

/** 첨부 카드 목록 */
export function BoardAttachments({ attachments }: BoardAttachmentsProps) {
  const { t } = useI18n()
  return (
    <ul className="flex flex-col gap-2" aria-label={t('board.attachments.listLabel')}>
      {attachments.map((att, i) => (
        <li key={i}>
          <a
            href={att.url || undefined}
            target="_blank"
            rel="noopener"
            className={cn('flex items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-2.5 text-[13px] transition-colors hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring', att.url ? '' : 'pointer-events-none opacity-60')}
          >
            <span className={cn('grid h-9 w-8 shrink-0 place-items-center rounded-[6px] text-[10px] font-bold', TONE[fileKind(att.name).tone])} aria-hidden="true">{fileKind(att.name).label}</span>
            <span className="min-w-0 flex-1 truncate">
              <b className="font-semibold text-foreground">{att.name}</b>
              {att.size ? <span className="ml-1 font-mono text-[11px] text-muted-foreground">{fileSize(att.size)}</span> : null}
            </span>
            <span className="shrink-0 text-xs font-semibold text-primary">{att.url ? t('board.attachments.open') : t('board.attachments.noUrl')}</span>
          </a>
        </li>
      ))}
    </ul>
  )
}

export default BoardAttachments
