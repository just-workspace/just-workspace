/**
 * 이모지 업로드 대화 상자: 미리보기 128 + `:이름:` mono 입력(파일 이름에서 기본값 도출) ·
 * 파일 정보 한 행 mono 12("ship.gif · 96 KB · 움직임 · 128×128로 맞춤"). 여러 파일 동시 처리 — 파일마다 한 그룹.
 * 오류: 이름 오류(형식·중복)는 해당 입력 아래(role=alert), 파일 오류(크기·형식·한도·권한)는 아래 목록(파일별, danger/10 행).
 * 저장 = 하나씩 업로드하며, 성공한 항목은 목록에서 제거한다. 전부 성공하면 닫는다.
 */
import { useEffect, useMemo, useState } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { UiModal } from '~/components/ui/Modal'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { emojiErrorCode, uploadCustomEmoji, type EmojiErrorCode } from '~/composables/chatApi22'
import { checkEmojiFile, checkEmojiName, emojiErrorKey, emojiNameFromFile, isNameError } from './settingsLogic'

interface Entry {
  id: number
  file: File
  url: string
  name: string
  fileErr: EmojiErrorCode | null
  serverNameErr: EmojiErrorCode | null
  w?: number
  h?: number
}

let seq = 0
export function EmojiUploadDialog({ files, existing, limit, onClose, onUploaded }: {
  files: File[]; existing: string[]; limit: number; onClose: () => void; onUploaded: (n: number) => void
}) {
  const { t } = useI18n()
  const [entries, setEntries] = useState<Entry[]>(() => files.map(f => ({
    id: ++seq, file: f, url: typeof URL.createObjectURL === 'function' ? URL.createObjectURL(f) : '', name: emojiNameFromFile(f.name),
    fileErr: checkEmojiFile(f), serverNameErr: null,
  })))
  const [busy, setBusy] = useState(false)
  useEffect(() => () => { for (const e of entries) if (e.url) URL.revokeObjectURL?.(e.url) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const valid = entries.filter(e => !e.fileErr)
  const rejected = entries.filter(e => e.fileErr)

  const nameErr = useMemo(() => {
    const out: Record<number, EmojiErrorCode | null> = {}
    for (const e of valid) {
      const others = [...existing, ...valid.filter(x => x.id !== e.id).map(x => x.name)]
      out[e.id] = checkEmojiName(e.name, others) ?? e.serverNameErr
    }
    return out
  }, [valid, existing])
  const canSave = !busy && valid.length > 0 && valid.every(e => !nameErr[e.id])

  function patch(id: number, p: Partial<Entry>) { setEntries(es => es.map(e => (e.id === id ? { ...e, ...p } : e))) }
  function drop(id: number) { setEntries(es => es.filter(e => e.id !== id)) }

  async function save() {
    setBusy(true)
    let ok = 0
    const fails = new Map<number, Partial<Entry>>()
    for (const e of valid) {
      try {
        await uploadCustomEmoji(e.file, e.name)
        ok += 1
      } catch (err) {
        const code = emojiErrorCode(err) ?? ('failed' as EmojiErrorCode)
        fails.set(e.id, isNameError(code) ? { serverNameErr: code } : { fileErr: code })
      }
    }
    const remaining = entries.filter(e => e.fileErr || fails.has(e.id)).map(e => ({ ...e, ...fails.get(e.id) }))
    setEntries(remaining)
    setBusy(false)
    if (ok) onUploaded(ok)
    if (!remaining.length) onClose()
  }

  const fileErrText = (e: Entry) => {
    const kb = Math.round(e.file.size / 1024)
    return `${e.file.name} — ${t(emojiErrorKey(e.fileErr), { kb, limit, max: 256 })}`
  }
  const single = valid.length === 1

  return (
    <UiModal
      title={t('chat.settings.emoji.uploadTitle')}
      size="480"
      onClose={onClose}
      footer={(
        <div className="flex justify-end gap-2">
          <UiButton type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</UiButton>
          <UiButton type="button" disabled={!canSave} onClick={() => void save()}>{t('common.save')}</UiButton>
        </div>
      )}
    >
      <div className="flex flex-col gap-4">
        {valid.map(e => {
          const err = nameErr[e.id]
          const inputId = `emoji-name-${e.id}`
          const big = (e.w ?? 0) > 128 || (e.h ?? 0) > 128
          const meta = [
            e.file.name,
            `${Math.max(1, Math.round(e.file.size / 1024))} KB`,
            e.file.type === 'image/gif' ? t('chat.settings.emoji.animated') : '',
            e.w ? (big ? t('chat.settings.emoji.fit') : `${e.w}×${e.h}`) : '',
          ].filter(Boolean).join(' · ')
          return (
            <div key={e.id} className="flex gap-4" data-emoji-entry={e.file.name}>
              <span className={cn('flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-card', single ? 'h-32 w-32' : 'h-16 w-16')}>
                {e.url && <img src={e.url} alt="" className="max-h-full max-w-full object-contain" onLoad={ev => patch(e.id, { w: ev.currentTarget.naturalWidth, h: ev.currentTarget.naturalHeight })} />}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex items-center">
                  <label htmlFor={inputId} className="flex-1 text-[13px] font-medium">{t('chat.settings.emoji.name')}</label>
                  {!single && <UiIconButton icon="close" size="sm" label={t('chat.settings.emoji.dropFile', { name: e.file.name })} onClick={() => drop(e.id)} />}
                </div>
                <div className={cn('flex h-10 items-center rounded-md border-2 bg-background px-3 font-mono text-[15px] focus-within:border-ring', err ? 'border-danger' : 'border-input')}>
                  <span aria-hidden="true" className="text-muted-foreground">:</span>
                  <input
                    id={inputId}
                    className="min-w-0 flex-1 bg-transparent outline-hidden"
                    value={e.name}
                    maxLength={32}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={!!err}
                    aria-describedby={err ? `${inputId}-err` : undefined}
                    onChange={ev => patch(e.id, { name: ev.target.value.toLowerCase(), serverNameErr: null })}
                  />
                  <span aria-hidden="true" className="text-muted-foreground">:</span>
                </div>
                {err && (
                  <p id={`${inputId}-err`} role="alert" className="text-[12px] text-danger">
                    {t(emojiErrorKey(err), { name: `:${e.name}:` })}
                  </p>
                )}
                <p className="truncate font-mono text-[12px] text-muted-foreground">{meta}</p>
              </div>
            </div>
          )
        })}
        {rejected.length > 0 && (
          <ul className="flex flex-col gap-1.5" aria-label={t('chat.settings.emoji.fileErrors')}>
            {rejected.map(e => (
              <li key={e.id} className="flex items-center gap-2 rounded-md bg-danger/10 px-3 py-2 text-[13px]">
                <UiIcon name="alert-circle" className="h-4 w-4 shrink-0 text-danger" />
                <span className="min-w-0 flex-1">{fileErrText(e)}</span>
              </li>
            ))}
          </ul>
        )}
        {!entries.length && <p className="text-[13px] text-muted-foreground">{t('chat.settings.emoji.nothing')}</p>}
      </div>
    </UiModal>
  )
}

export default EmojiUploadDialog
