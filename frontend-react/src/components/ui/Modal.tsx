/**
 * 모달 하나(시안 G): 제목 15/600 · 헤더 48 · 푸터 56 · 버튼 h-9 [취소][확인] 오른쪽 · ✕ 는 아이콘 버튼 aria-label="닫기".
 * confirm 변형 = 헤더 없는 소형(max-w-sm, p-5) — UiDialogHost 가 쓴다.
 * 모바일(sm 미만)은 바텀시트: rounded-sheet 상단 + 핸들 36×4. Esc 닫기, 포커스 트랩, 닫으면 연 요소로 포커스 복귀.
 * 폭: sm 384 · md 448 · lg 512 · '440'(확인형 넓게 — 회의 "예약됨") · '480'(이동) · '520'(일정·연락처·공유 폼) ·
 *     '680'(목록 + 미리보기 두 열이 넓은 고르기 창) · wide(960 × 90dvh — PDF·이미지 미리보기).
 * 확인형(confirm)도 size 를 받는다(답변서 C2) — 기본 sm 384, '400'(반복 일정 삭제 등) · '440' · md · lg 도 그대로.
 * 확인형에서 쓸 수 없는 것: wide(→ 384) · '480' · '520' · '680' 은 폼형 폭이라 확인형에선 그대로 적용되긴 하지만 권장하지 않는다.
 * 모바일: sheet(바텀시트, 기본) · full(전체 화면 시트 — 트리·긴 목록·미리보기). 헤더 오른쪽 actions(닫기 앞), flush = 본문 여백 없음.
 * 마운트 = 열림. 부모가 조건부로 그렸다 뗀다(onClose 에서 상태를 내린다). body 로 포털.
 * 처음 포커스: 안에 data-autofocus 가 있으면 그것, 없으면 첫 포커스 가능 요소.
 */
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { UiIconButton } from './IconButton'
import { FOCUSABLE } from './internal'

export interface UiModalProps {
  /**
   * 폭 — sm 384 · md 448 · lg 512 · '400' · '440' · '480' · '520' · '680'(목록 + 미리보기 고르기 창) · wide 960×90dvh.
   * 기본: 폼형 md, 확인형(confirm) sm(384). 확인형은 wide 를 무시하고 384.
   */
  size?: 'sm' | 'md' | 'lg' | '400' | '440' | '480' | '520' | '680' | 'wide'
  /** 모바일 표시 — sheet(바텀시트, 기본) · full(전체 화면) */
  mobile?: 'sheet' | 'full'
  /** 본문 여백·간격 없음(iframe·이미지 미리보기) */
  flush?: boolean
  /** 제목 문자열(titleSlot 대신) */
  title?: string
  /** 확인형(헤더 없음, max-w-sm). 파괴적이면 danger 와 함께 */
  confirm?: boolean
  /** role=alertdialog(파괴적 확인) */
  danger?: boolean
  /** 바깥 클릭으로 닫지 않기 */
  persistent?: boolean
  /** 접근성 이름(제목이 titleSlot 일 때) */
  ariaLabel?: string
  /** 닫기(✕ · Esc · 바깥 클릭) */
  onClose?: () => void
  /** 제목 자리 내용(Vue #title 슬롯) — title 이 없을 때 */
  titleSlot?: ReactNode
  /** 헤더 오른쪽 닫기 앞 버튼들(Vue #actions 슬롯) — 폼형만 */
  actions?: ReactNode
  /** 푸터(Vue #footer 슬롯) — 버튼 h-9 [취소][확인] 오른쪽 정렬 */
  footer?: ReactNode
  /** 본문 */
  children?: ReactNode
}

/**
 * 모달.
 * 확인형은 confirm(헤더 없음, 기본 384) — 폭은 size 로: 반복 일정 삭제 = confirm size="400".
 * @example {open && <UiModal confirm size="400" title="반복 일정 삭제" onClose={close} footer={…}><UiRadioCard layout="row" …/></UiModal>}
 * @example 고르기 창(왼쪽 목록 + 오른쪽 미리보기): {open && <UiModal title="템플릿 고르기" size="680" onClose={close} footer={…}><div className="grid grid-cols-[240px_1fr] gap-4">…</div></UiModal>}
 * @example {open && <UiModal title="새 폴더" size="sm" onClose={() => setOpen(false)} footer={<><UiButton variant="outline" size="sm" onClick={…}>취소</UiButton><UiButton size="sm">만들기</UiButton></>}>…</UiModal>}
 */
export function UiModal({ size, mobile = 'sheet', flush = false, title, confirm = false, danger = false, persistent = false, ariaLabel, onClose, titleSlot, actions, footer, children }: UiModalProps) {
  const { t } = useI18n()
  const full = mobile === 'full' && !confirm
  const widths = {
    sm: 'sm:max-w-sm', md: 'sm:max-w-md', lg: 'sm:max-w-lg', '400': 'sm:max-w-[400px]', '440': 'sm:max-w-[440px]',
    '480': 'sm:max-w-[480px]', '520': 'sm:max-w-[520px]', '680': 'sm:max-w-[680px]', wide: 'sm:max-w-[960px]',
  } as const
  const effSize = size ?? (confirm ? 'sm' : 'md')
  const widthClass = confirm && effSize === 'wide' ? widths.sm : widths[effSize]

  const panelRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  // 안에서 누르기 시작해(입력 글자를 끌어 고르는 등) 스크림에서 뗀 것은 "바깥 클릭" 이 아니다 —
  // 그 경우에도 click 은 공통 조상인 스크림에서 나서, 예전에는 모달이 닫히고 입력이 사라졌다.
  const downInside = useRef(false)

  function focusables(): HTMLElement[] {
    return Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(el => el.offsetParent !== null)
  }
  function onKeydown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') { e.stopPropagation(); closeRef.current?.(); return }
    if (e.key !== 'Tab') return
    const els = focusables()
    if (!els.length) { e.preventDefault(); return }
    const first = els[0], last = els[els.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    // 확인형은 [취소]부터(시안 G). data-autofocus 가 있으면 그것, 없으면 첫 포커스 가능 요소.
    const pref = panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')
    ;(pref ?? focusables()[0] ?? panelRef.current)?.focus()
    return () => { opener?.focus?.() }
  }, [])

  return createPortal(
    <div
      className={cn('fixed inset-0 z-modal flex justify-center bg-scrim sm:items-center sm:p-4', full ? 'items-stretch' : 'items-end')}
      onMouseDown={(e) => { downInside.current = e.target !== e.currentTarget }}
      onClick={(e) => {
        const dragged = downInside.current
        downInside.current = false
        if (e.target === e.currentTarget && !dragged && !persistent) closeRef.current?.()
      }}
      onKeyDown={onKeydown}
    >
      <div
        ref={panelRef}
        role={danger ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-label={ariaLabel || title}
        tabIndex={-1}
        className={cn(
          'flex w-full flex-col overflow-hidden bg-card pb-[env(safe-area-inset-bottom)] shadow-xl outline-hidden sm:rounded-lg sm:border sm:border-border sm:pb-0',
          full ? 'h-dvh pt-[env(safe-area-inset-top)] sm:pt-0' : 'max-h-[90dvh] rounded-t-sheet',
          effSize === 'wide' && !confirm ? 'sm:h-[90dvh] sm:max-h-[90dvh]' : 'sm:h-auto sm:max-h-[90dvh]',
          widthClass,
        )}
      >
        {/* 모바일 핸들(바텀시트만) */}
        {!full && <div className="mx-auto mt-2.5 h-1 w-9 shrink-0 rounded-full bg-muted sm:hidden" aria-hidden="true" />}

        {confirm
          ? (
            /* 확인형: 헤더 없음, 본문 p-5, 푸터는 본문 아래 */
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-5">
              {title && <p className="text-[15px] font-semibold text-foreground">{title}</p>}
              {titleSlot}
              {children}
              {footer != null && (
                <div className="mt-3 flex justify-end gap-2">
                  {footer}
                </div>
              )}
            </div>
          )
          : (
            /* 폼형 */
            <>
              <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border pl-5 pr-2.5">
                {title
                  ? <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-foreground">{title}</h2>
                  : <div className="min-w-0 flex-1 [&>*]:text-[15px] [&>*]:font-semibold">{titleSlot}</div>}
                {actions}
                <UiIconButton label={t('common.close')} icon="close" keys={['Esc']} onClick={() => closeRef.current?.()} />
              </div>
              <div className={cn('flex min-h-0 flex-1 flex-col', flush ? '' : 'gap-4 overflow-y-auto p-5')}>{children}</div>
              {footer != null && (
                <div className="flex h-14 shrink-0 items-center justify-end gap-2 border-t border-border px-5">
                  {footer}
                </div>
              )}
            </>
          )}
      </div>
    </div>,
    document.body,
  )
}

export default UiModal
