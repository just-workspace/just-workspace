/**
 * 인앱 다이얼로그 호스트 — useDialog() 의 current 를 그린다. App.tsx 루트에 1회 마운트.
 * 시안 G 확인형: UiModal confirm 변형(헤더 없는 소형 max-w-sm), 파괴적은 bg-danger, 포커스는 [취소]에서 시작.
 * 다이얼로그 내기는 alertBox / confirmBox / promptBox / choose(~/composables/useDialog).
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useDialog } from '~/composables/useDialog'
import { UiModal } from './Modal'

const BTN = 'inline-flex h-9 items-center justify-center rounded-md px-3.5 text-[13px] transition-colors ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
const BTN_OUTLINE = `${BTN} border border-border text-foreground hover:bg-accent`
const BTN_PRIMARY = `${BTN} bg-primary px-4 font-semibold text-primary-foreground hover:bg-primary/90`
const BTN_DANGER = `${BTN} bg-danger px-4 font-semibold text-background hover:bg-danger/90`

/**
 * 다이얼로그 호스트(전역 1개).
 * @example <UiDialogHost />  — App.tsx 루트에서만. 쓰는 쪽은 `if (await confirmBox('삭제할까요?', { danger: true })) …`
 */
export function UiDialogHost() {
  const { current } = useDialog()
  const [inputValue, setInputValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  // 프롬프트가 뜨면 기본값을 넣고 입력에 포커스·전체 선택(Vue watch(current) → nextTick)
  const curId = current?.id
  const curKind = current?.kind
  const curDefault = current?.defaultValue
  useEffect(() => {
    if (curId !== undefined && curKind === 'prompt') {
      setInputValue(curDefault ?? '')
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [curId, curKind, curDefault])

  function onConfirm() {
    const d = current
    if (!d) return
    // resolve(wrappedResolve)가 current 를 직접 닫는다.
    if (d.kind === 'prompt') d.resolve(inputValue)
    else d.resolve(true)
  }

  function onCancel() {
    const d = current
    if (!d) return
    d.resolve(d.kind === 'prompt' ? null : d.kind === 'choose' ? null : false)
  }

  function onChoose(key: string) {
    current?.resolve(key)
  }

  function onKeydown(e: KeyboardEvent<HTMLDivElement>) {
    if (!current) return
    if (e.key === 'Enter' && current.kind !== 'prompt' && current.kind !== 'choose') { e.preventDefault(); onConfirm() }
  }

  if (!current) return null

  const footer = current.kind === 'choose'
    ? (
      /* 다중 선택(3버튼 등) */
      <>
        {(current.actions ?? []).map((a, i) => (
          <button
            key={a.key}
            type="button"
            data-autofocus={i === 0 ? '' : undefined}
            className={a.variant === 'danger' ? BTN_DANGER : a.variant === 'ghost' ? BTN_OUTLINE : BTN_PRIMARY}
            onClick={() => onChoose(a.key)}
          >{a.label}</button>
        ))}
      </>
    )
    : (
      <>
        {current.kind !== 'alert' && (
          <button
            type="button"
            data-autofocus=""
            className={BTN_OUTLINE}
            onClick={onCancel}
          >{current.cancelLabel}</button>
        )}
        <button
          type="button"
          data-autofocus={current.kind === 'alert' ? '' : undefined}
          className={current.danger ? BTN_DANGER : BTN_PRIMARY}
          onClick={onConfirm}
        >{current.confirmLabel}</button>
      </>
    )

  return (
    <UiModal
      confirm
      size={current.size}
      danger={current.danger}
      title={current.title}
      ariaLabel={current.title || current.message}
      onClose={onCancel}
      footer={footer}
    >
      <div onKeyDown={onKeydown}>
        <p className="whitespace-pre-line text-[13px] leading-relaxed text-muted-foreground">{current.message}</p>

        {current.kind === 'prompt' && (
          <input
            ref={inputRef}
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            autoComplete="off"
            placeholder={current.placeholder}
            className="mt-3 h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-hidden placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/35"
            // 한글 조합 중 Enter 는 글자 확정 — 그대로 확인으로 넘기지 않는다
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); onConfirm() } }}
          />
        )}
      </div>
    </UiModal>
  )
}

export default UiDialogHost
