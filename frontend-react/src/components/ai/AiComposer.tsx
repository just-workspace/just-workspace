/**
 * AI 입력.
 *  데스크톱: 10 24 18 여백 · 폭 680 카드(r12) · [첨부 칩] · 입력 15px · 도구 줄 [첨부][화면 캡처] | [임시 대화] … [■ 36] 또는 [보내기 36].
 *  모바일: 상단 선 · 8 8 28 여백 · 한 줄 카드 [입력][첨부 44][보내기 44] — 첨부 칩은 카드 위에 배치.
 * 첨부: 드래그 앤 드롭(드롭 영역 표시 "놓으면 첨부됩니다") · 붙여넣기 · 파일 선택 · 화면 캡처(getDisplayMedia 1장).
 *  업로드·변환은 부모가 담당한다(onFiles). 받아쓰기(마이크)는 범위 밖이므로 버튼을 두지 않는다.
 * 이미지 썸네일(88 · 모바일 64, 카드 내부) · 모델이 이미지 판독을 지원하지 않으면 전송 차단 —
 *  데스크톱: danger 줄 "이 모델(…)은 이미지를 읽지 못합니다…" + [이미지 읽는 모델로 변경](선택 가능한 vision 모델이 있는 경우에만) + [이미지 제거],
 *  도구 줄 "보내기 막힘" + 보내기 disabled. 모바일: 한 줄 "이 모델은 이미지를 읽지 못합니다 · 모델 바꾸기 · 이미지 빼기"(danger) + 보내기 disabled.
 *  모바일 도구 줄: [첨부][사진 찍기] 입력 [보내기].
 */
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type Ref } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { UiIcon } from '~/components/ui/Icon'
import { UiTooltip } from '~/components/ui/Tooltip'
import { UiSwitch } from '~/components/ui/Switch'
import { AiAttachments } from '~/components/ai/AiAttachments'
import { AI_ATTACH_MAX, aiFormatBytes, type AiAttachment } from '~/utils/aiAssist'
import { UiButton } from '~/components/ui/Button'
import { AiPermissionMode } from '~/components/ai/AiPermissionMode'
import { cyclePermissionMode } from '~/composables/usePermissionMode'

export interface AiComposerHandle {
  /** 입력 칸에 포커스 설정 */
  focus: () => void
}

export interface AiComposerProps {
  /** 입력 값(필수) */
  modelValue: string
  /** 입력 값 변경 */
  onUpdateModelValue: (v: string) => void
  /** 답변 수신 중 — 보내기 대신 멈추기 표시, Esc = 멈추기 */
  busy: boolean
  /** 보내기(Enter · 보내기 버튼) */
  onSend?: () => void
  /** 멈추기(■ · 생성 중 Esc) */
  onStop?: () => void
  /** 첨부 칩(업로드 중·변환 중·완료·실패) */
  attachments?: AiAttachment[]
  /** 파일 수신(드래그 앤 드롭·붙여넣기·파일 선택·화면 캡처) — 미지정 시 첨부 기능 숨김 */
  onFiles?: (files: File[]) => void
  /** 첨부 제거 */
  onRemoveAttachment?: (a: AiAttachment) => void
  /** 현재 모델의 이미지 판독 지원 여부 */
  vision?: boolean
  /** 첨부 1개당 최대 바이트 */
  maxBytes?: number
  /** 임시 대화 스위치 — 값과 변경 핸들러(둘 다 지정해야 표시) */
  temporary?: boolean
  onToggleTemporary?: (v: boolean) => void
  /** 입력 안내 문구 대체 */
  placeholder?: string
  /** 현재 모델 이름(이미지 판독 불가 안내용) */
  modelName?: string
  /** 이미지 판독 모델로 전환(선택 가능한 vision 모델이 있는 경우에만 전달) */
  onSwitchVisionModel?: () => void
  /** 첨부 이미지 전체 제거 */
  onRemoveImages?: () => void
  /** 권한 모드 칩 + Shift+Tab 순환(Claude Code 권한 모드) */
  permissionMode?: boolean
  /** 권한 규칙 창의 '이 대화에서 허용' 대상 */
  conversationId?: string | null
  /** { focus } */
  ref?: Ref<AiComposerHandle | null>
}

function dragHasFiles(e: DragEvent) {
  return Array.from(e.dataTransfer?.types || []).includes('Files')
}

/** 화면 1장 캡처 → PNG File. 사용자가 선택을 취소하면 null 반환 */
async function captureScreen(): Promise<File | null> {
  const md = navigator.mediaDevices as MediaDevices & { getDisplayMedia?: (c?: unknown) => Promise<MediaStream> }
  if (!md?.getDisplayMedia) return null
  let stream: MediaStream | null = null
  try {
    stream = await md.getDisplayMedia({ video: true, audio: false })
    const video = document.createElement('video')
    video.srcObject = stream
    video.muted = true
    await video.play()
    await new Promise(r => setTimeout(r, 150))
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')?.drawImage(video, 0, 0)
    const blob: Blob | null = await new Promise(r => canvas.toBlob(r, 'image/png'))
    if (!blob) return null
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    return new File([blob], `screenshot-${ts}.png`, { type: 'image/png' })
  } catch {
    return null
  } finally {
    stream?.getTracks().forEach(tr => tr.stop())
  }
}

export function AiComposer({
  modelValue, onUpdateModelValue, busy, onSend, onStop, attachments = [], onFiles, onRemoveAttachment,
  vision = true, maxBytes = AI_ATTACH_MAX, temporary, onToggleTemporary, placeholder, modelName, onSwitchVisionModel, onRemoveImages, permissionMode, conversationId, ref,
}: AiComposerProps) {
  const { t } = useI18n()
  const el = useRef<HTMLTextAreaElement | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const cameraInput = useRef<HTMLInputElement | null>(null)
  const [dragN, setDragN] = useState<number | null>(null)
  const dragDepth = useRef(0)

  const autoGrow = useCallback(() => {
    const ta = el.current; if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  }, [])
  // 입력 값 변경 시 높이 재조정 — 최초 실행 제외
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    autoGrow()
  }, [modelValue, autoGrow])

  const pending = attachments.some(a => a.status === 'uploading' || a.status === 'converting')
  const readyCount = attachments.filter(a => a.status === 'ready').length
  // 이미지 판독 미지원 모델 + 이미지 첨부 = 전송 차단
  const blocked = !vision && attachments.some(a => a.kind === 'image' && a.status !== 'failed')
  const canSend = !pending && !blocked && (!!modelValue.trim() || readyCount > 0)

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (permissionMode && e.key === 'Tab' && e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      cyclePermissionMode()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (canSend) onSend?.()
    }
  }

  // 생성 중 Esc = 멈추기(모달·메뉴가 먼저 처리하면 해당 처리 우선)
  const live = useRef({ busy, onStop })
  live.current = { busy, onStop }
  useEffect(() => {
    function onWinKey(e: globalThis.KeyboardEvent) {
      if (e.key !== 'Escape' || !live.current.busy || e.defaultPrevented) return
      // 한글 조합을 취소하는 Esc, 그리고 다른 입력 칸(승인 카드 [수정]·질문 카드 '기타'·계획 피드백·질문 수정)에서 입력된 Esc 는
      // 멈춤으로 처리하지 않는다. 승인 대기 중에는 항상 busy 이므로, 여기서 멈추면 답변이 중단되고 카드까지 취소되는 문제가 있었다.
      if (e.isComposing) return
      const tgt = e.target as HTMLElement | null
      if (tgt && tgt !== el.current && typeof tgt.closest === 'function' && tgt.closest('input,textarea,select,[contenteditable="true"]')) return
      live.current.onStop?.()
    }
    window.addEventListener('keydown', onWinKey)
    return () => window.removeEventListener('keydown', onWinKey)
  }, [])

  useImperativeHandle(ref, () => ({ focus: () => el.current?.focus() }), [])

  // ── 첨부 유입 경로 ──
  function onDragEnter(e: DragEvent) {
    if (!onFiles || !dragHasFiles(e)) return
    e.preventDefault()
    dragDepth.current += 1
    setDragN(e.dataTransfer.items ? Array.from(e.dataTransfer.items).filter(i => i.kind === 'file').length : 0)
  }
  function onDragOver(e: DragEvent) {
    if (!onFiles || !dragHasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  function onDragLeave(e: DragEvent) {
    if (!onFiles || !dragHasFiles(e)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (!dragDepth.current) setDragN(null)
  }
  function onDrop(e: DragEvent) {
    if (!onFiles) return
    e.preventDefault()
    dragDepth.current = 0
    setDragN(null)
    const files = Array.from(e.dataTransfer?.files || [])
    if (files.length) onFiles(files)
  }
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (!onFiles) return
    const files = Array.from(e.clipboardData?.files || [])
    if (!files.length) return
    // 엑셀·오피스는 셀·문단 복사 시 텍스트와 함께 이미지(PNG)도 클립보드에 포함한다. 파일 존재만으로 첨부 처리하면
    // 표의 텍스트는 누락되고 스크린샷만 첨부된다. 텍스트가 함께 있으면 텍스트 붙여넣기를 유지한다.
    if ((e.clipboardData?.getData('text/plain') || '').trim()) return
    e.preventDefault()
    onFiles(files)
  }
  async function onCapture() {
    const f = await captureScreen()
    if (f) onFiles?.([f])
  }
  const canCapture = typeof navigator !== 'undefined' && !!(navigator.mediaDevices as { getDisplayMedia?: unknown } | undefined)?.getDisplayMedia

  const toolBtn = 'grid h-11 w-11 shrink-0 place-items-center rounded-lg hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 md:h-8 md:w-8'

  return (
    <div
      className="relative shrink-0 border-t border-border px-2 pb-[calc(28px+env(safe-area-inset-bottom))] pt-2 md:border-t-0 md:px-6 md:pb-[18px] md:pt-2.5"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragN !== null && (
        // 드롭 영역
        <div aria-live="polite" className="pointer-events-none absolute inset-x-2 inset-y-1 z-10 mx-auto flex max-w-[680px] flex-col items-center justify-center gap-1.5 rounded-[14px] border-2 border-dashed border-primary bg-primary/[0.08] md:inset-x-6">
          <UiIcon name="upload" className="h-7 w-7 text-primary" />
          <span className="text-sm font-semibold text-foreground">{t('ai.attach.dropTitle')}</span>
          <span className="text-xs text-muted-foreground">{t('ai.attach.dropDesc', { n: String(dragN || 1), max: aiFormatBytes(maxBytes) })}</span>
        </div>
      )}
      <div className={cn('mx-auto max-w-[680px] rounded-xl border bg-card', blocked ? 'border-input' : 'border-border')}>
        {!!attachments.length && (
          <div className="px-2.5 pt-2.5 md:px-3 md:pt-3">
            <AiAttachments items={attachments} vision={vision} onRemove={onRemoveAttachment} className="hidden md:flex" />
            <AiAttachments items={attachments} vision={vision} onRemove={onRemoveAttachment} compact className="md:hidden" />
          </div>
        )}
        {blocked && (
          <>
            {/* 데스크톱 오류 줄 */}
            <div role="alert" className="mx-3 mt-2.5 hidden flex-wrap items-center gap-2 rounded-lg border border-danger/45 bg-danger/[0.08] px-3 py-2 text-[12.5px] text-foreground md:flex">
              <UiIcon name="alert-circle" className="h-3.5 w-3.5 shrink-0 text-danger" />
              <span className="min-w-0 flex-[1_1_280px]">
                {t('ai.attach.blockedPre')}<span className="font-mono">{modelName || '—'}</span>{t('ai.attach.blockedPost')}
              </span>
              {onSwitchVisionModel && <UiButton variant="outline" size="xs" onClick={() => onSwitchVisionModel()}>{t('ai.attach.switchVision')}</UiButton>}
              <UiButton variant="ghost" size="xs" onClick={() => onRemoveImages?.()}>{t('ai.attach.removeImages')}</UiButton>
            </div>
            {/* 모바일 한 줄 */}
            <p role="alert" className="m-0 px-3 pt-2 text-xs text-danger md:hidden">
              {t('ai.attach.noVision')}
              {onSwitchVisionModel && <> · <button type="button" className="underline" onClick={() => onSwitchVisionModel()}>{t('ai.attach.switchShort')}</button></>}
              {' · '}<button type="button" className="underline" onClick={() => onRemoveImages?.()}>{t('ai.attach.removeImages')}</button>
            </p>
          </>
        )}
      <div className={cn('flex items-center gap-1 p-1 md:block md:p-0', onFiles ? 'pl-1' : 'pl-3')}>
        <label className="contents">
          <span className="sr-only">{t('ai.composer.label')}</span>
          <textarea
            ref={el}
            value={modelValue}
            rows={1}
            autoComplete="off"
            placeholder={placeholder || t('ai.composer.placeholder')}
            className="max-h-[200px] min-w-0 flex-1 resize-none bg-transparent py-2 text-[15px] text-foreground placeholder:text-muted-foreground focus:outline-hidden md:block md:w-full md:px-3.5 md:pb-1 md:pt-3"
            onChange={e => onUpdateModelValue(e.target.value)}
            onKeyDown={onKey}
            onInput={autoGrow}
            onPaste={onPaste}
          />
        </label>
        <div className="contents text-muted-foreground md:flex md:items-center md:gap-0.5 md:px-1.5 md:pb-1.5 md:pt-1">
          {onFiles ? (
            <>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                data-testid="ai-file-input"
                onChange={(e) => {
                  const files = Array.from(e.target.files || [])
                  e.target.value = ''
                  if (files.length) onFiles(files)
                }}
              />
              <UiTooltip text={t('ai.attach.button')}>
                <button type="button" aria-label={t('ai.attach.button')} className={cn(toolBtn, '-order-1 md:order-none')} onClick={() => fileInput.current?.click()}>
                  <UiIcon name="paperclip" className="h-5 w-5 md:h-4 md:w-4" />
                </button>
              </UiTooltip>
              {/* 모바일 사진 찍기 */}
              <input
                ref={cameraInput}
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                data-testid="ai-camera-input"
                onChange={(e) => {
                  const files = Array.from(e.target.files || [])
                  e.target.value = ''
                  if (files.length) onFiles(files)
                }}
              />
              <button type="button" aria-label={t('ai.attach.camera')} className={cn(toolBtn, '-order-1 md:hidden')} onClick={() => cameraInput.current?.click()}>
                <UiIcon name="camera" className="h-5 w-5" />
              </button>
              {canCapture && (
                <UiTooltip text={t('ai.attach.capture')} className="hidden md:inline-flex">
                  <button type="button" aria-label={t('ai.attach.capture')} className={toolBtn} onClick={() => { void onCapture() }}>
                    <UiIcon name="scan" className="h-4 w-4" />
                  </button>
                </UiTooltip>
              )}
            </>
          ) : (
            <UiTooltip text={t('ai.composer.attachSoon')}>
              <button type="button" disabled aria-label={t('ai.composer.attachSoon')} className={toolBtn}>
                <UiIcon name="paperclip" className="h-5 w-5 md:h-4 md:w-4" />
              </button>
            </UiTooltip>
          )}
          {onToggleTemporary && temporary !== undefined && (
            <>
              <span aria-hidden="true" className="mx-1 hidden h-5 w-px bg-border md:block" />
              <span className="hidden md:inline-flex">
                <UiSwitch label={t('ai.temp.switch')} modelValue={temporary} onUpdateModelValue={onToggleTemporary} disabled={busy} />
              </span>
            </>
          )}
          {permissionMode && (
            <span className="ml-1 inline-flex"><AiPermissionMode conversationId={conversationId} /></span>
          )}
          {!blocked && <span className="ml-2 hidden text-xs md:inline">{t(permissionMode ? 'ai.perm.composerHint' : 'ai.composer.hint')}</span>}
          <span className="hidden flex-1 md:block" />
          {blocked && !busy && <span className="mr-2 hidden text-xs md:inline">{t('ai.attach.sendBlocked')}</span>}
          {busy ? (
            <>
              <span className="mr-2 hidden text-xs md:inline" role="status">{t('ai.composer.writing')}</span>
              <UiTooltip text={t('ai.composer.stop')}>
                <button
                  type="button"
                  aria-label={t('ai.composer.stop')}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-[10px] bg-foreground text-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background md:h-9 md:w-9"
                  onClick={() => onStop?.()}
                >
                  <span aria-hidden="true" className="block h-[11px] w-[11px] rounded-sm bg-current" />
                </button>
              </UiTooltip>
            </>
          ) : (
            <button
              type="button"
              aria-label={t('ai.composer.send')}
              title={pending ? t('ai.attach.waiting') : blocked ? t('ai.attach.noVision') : undefined}
              disabled={!canSend}
              className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-[10px] bg-primary text-primary-foreground transition-opacity focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background disabled:opacity-50 md:h-9 md:w-9')}
              onClick={() => onSend?.()}
            >
              <UiIcon name="send" className="h-[18px] w-[18px] md:h-4 md:w-4" />
            </button>
          )}
        </div>
      </div>
      </div>
    </div>
  )
}

export default AiComposer
