/**
 * SSL 인증서 올리기 — 관리 › 보안·SSL 카드 헤더 [인증서 올리기].
 * UiModal 520: 인증서 · 개인 키 두 칸(선택한 파일 행 h-48 / 점선 드롭 영역 h-80).
 * 파일 선택 시 서버가 즉시 판독하여(POST /api/admin/settings/ssl/inspect) 도메인·발급·만료를 회색 상자에 표시.
 * 둘 다 존재하고 쌍이 일치하며 도메인이 일치할 때만 [올리고 적용] 활성화. 쌍 불일치·도메인 불일치는 해당 칸 error.
 * 업로드는 기존 POST /api/admin/settings/ssl 사용(서버도 동일한 검사를 재수행).
 */
import { useRef, useState, type DragEvent, type ReactNode } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { formatSize } from '~/lib/files'
import { daysUntil } from '~/composables/useAdminOps'
import { UiModal } from '~/components/ui/Modal'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiTrans } from '~/components/ui/Trans'

/** POST /api/admin/settings/ssl/inspect */
export interface SslInspect {
  cert: { domains: string[]; subject_cn: string | null; issuer: string; not_before: string; not_after: string } | null
  cert_error: string | null
  key_error: string | null
  key_match: boolean | null
  domain: string
  domain_match: boolean | null
  ok: boolean
}

/** 서버 사유 코드 → 칸 오류 문구 키 */
export function sslErrorKey(code: string): string {
  const known = ['cert_invalid', 'domain_mismatch', 'key_invalid', 'key_encrypted', 'key_mismatch']
  return `admin.sslUpload.error.${known.includes(code) ? code : 'read_failed'}`
}

/** 업로드 실패 응답 → 오류 대상 칸 */
export function uploadErrorField(code: string): 'cert' | 'key' {
  return code.startsWith('key_') ? 'key' : 'cert'
}

/** ISO → YYYY-MM-DD(로컬) */
function ymd(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export interface AdminSslUploadModalProps {
  /** 업로드 성공 */
  onUploaded?: () => void
  /** 닫기 */
  onClose: () => void
  /** 모달 본문 끝에 추가할 요소(기존 "인증서 삭제" 줄 등) */
  extra?: ReactNode
}

interface FieldProps {
  label: string
  hint: string
  file: File | null
  error: string
  accept: string
  note?: string
  onPick: (f: File | null) => void
}

/** 파일 칸 — 선택한 파일 행 또는 점선 드롭 영역 + 해당 칸 오류 */
function SslFileField({ label, hint, file, error, accept, note, onPick }: FieldProps) {
  const { t } = useI18n()
  const input = useRef<HTMLInputElement | null>(null)
  function onDrop(e: DragEvent) {
    e.preventDefault()
    const f = e.dataTransfer.files?.[0]
    if (f) onPick(f)
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label} <span className="text-xs font-normal text-muted-foreground">{hint}</span></span>
      {file
        ? (
          <div className={cn('flex h-12 items-center gap-2.5 rounded-md border px-3 text-[13px]', error ? 'border-danger' : 'border-border')}>
            <UiIcon name="file" className="h-4 w-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono">{file.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{formatSize(file.size)}</span>
            <UiIconButton icon="close" size="sm" label={t('admin.sslUpload.remove', { name: file.name })} onClick={() => { onPick(null); if (input.current) input.current.value = '' }} />
          </div>
        )
        : (
          <button
            type="button"
            className={cn(
              'flex h-20 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-[13px] text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
              error ? 'border-danger' : 'border-border',
            )}
            onClick={() => input.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
          >
            <UiTrans k="admin.sslUpload.drop" slots={{ pick: <b className="font-semibold text-primary">{t('admin.sslUpload.pick')}</b> }} />
            {note && <span className="text-xs">{note}</span>}
          </button>
        )}
      <input ref={input} type="file" accept={accept} className="hidden" aria-label={label} onChange={e => onPick(e.target.files?.[0] || null)} />
      {error && (
        <p role="alert" className="flex items-center gap-1.5 text-xs font-medium text-danger">
          <UiIcon name="alert-circle" className="h-[13px] w-[13px]" strokeWidth={2.2} />{error}
        </p>
      )}
    </div>
  )
}

/** SSL 인증서 올리기 모달 */
export function AdminSslUploadModal({ onUploaded, onClose, extra }: AdminSslUploadModalProps) {
  const { t } = useI18n()
  const [cert, setCert] = useState<File | null>(null)
  const [key, setKey] = useState<File | null>(null)
  const [info, setInfo] = useState<SslInspect | null>(null)
  const [checking, setChecking] = useState(false)
  const [certErr, setCertErr] = useState('')
  const [keyErr, setKeyErr] = useState('')
  const [uploading, setUploading] = useState(false)
  const seq = useRef(0)

  async function inspect(c: File | null, k: File | null) {
    const n = ++seq.current
    setCertErr(''); setKeyErr('')
    if (!c && !k) { setInfo(null); setChecking(false); return }
    setChecking(true)
    try {
      const fd = new FormData()
      if (c) fd.append('cert', c)
      if (k) fd.append('key', k)
      const r = await $fetch<SslInspect>('/api/admin/settings/ssl/inspect', { method: 'POST', body: fd })
      if (n !== seq.current) return
      setInfo(r)
      setCertErr(r.cert_error ? t(sslErrorKey(r.cert_error), { domain: r.domain }) : '')
      setKeyErr(r.key_error ? t(sslErrorKey(r.key_error)) : '')
    } catch {
      if (n !== seq.current) return
      setInfo(null)
      setCertErr(c ? t('admin.sslUpload.error.read_failed') : '')
      setKeyErr(!c && k ? t('admin.sslUpload.error.read_failed') : '')
    } finally {
      if (n === seq.current) setChecking(false)
    }
  }

  function pickCert(f: File | null) { setCert(f); void inspect(f, key) }
  function pickKey(f: File | null) { setKey(f); void inspect(cert, f) }

  const canApply = !!cert && !!key && !!info?.ok && !checking && !uploading && !certErr && !keyErr

  async function apply() {
    if (!canApply || !cert || !key) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('cert', cert)
      fd.append('key', key)
      await $fetch('/api/admin/settings/ssl', { method: 'POST', body: fd })
      onUploaded?.()
      onClose()
    } catch (e: any) {
      const d = e?.data?.detail
      const code = d && typeof d === 'object' && typeof d.code === 'string' ? d.code : 'read_failed'
      const msg = t(sslErrorKey(code), { domain: info?.domain || '' })
      if (uploadErrorField(code) === 'key') setKeyErr(msg); else setCertErr(msg)
    } finally {
      setUploading(false)
    }
  }

  const c = info?.cert
  const left = c ? daysUntil(c.not_after) : null

  return (
    <UiModal
      title={t('admin.sslUpload.title')}
      size="520"
      persistent={uploading}
      onClose={onClose}
      footer={(
        <>
          <UiButton variant="outline" size="sm" disabled={uploading} onClick={onClose}>{t('common.cancel')}</UiButton>
          <UiButton size="sm" disabled={!canApply} onClick={() => void apply()}>{uploading ? t('admin.sslUpload.applying') : t('admin.sslUpload.submit')}</UiButton>
        </>
      )}
    >
      <SslFileField
        label={t('admin.sslUpload.cert')}
        hint={t('admin.sslUpload.certHint')}
        file={cert}
        error={certErr}
        accept=".pem,.crt,.cer"
        onPick={pickCert}
      />
      <SslFileField
        label={t('admin.sslUpload.key')}
        hint={t('admin.sslUpload.keyHint')}
        file={key}
        error={keyErr}
        accept=".pem,.key"
        note={t('admin.sslUpload.keyNote')}
        onPick={pickKey}
      />
      {c && (
        <div className="grid gap-x-3 gap-y-1.5 rounded-md bg-muted/40 px-3 py-2.5 text-[13px]" style={{ gridTemplateColumns: '72px 1fr' }}>
          <span className="text-muted-foreground">{t('admin.sslUpload.domain')}</span>
          <span className="min-w-0 break-all font-mono">{c.domains.join(', ') || '—'}</span>
          <span className="text-muted-foreground">{t('admin.sslUpload.issuer')}</span>
          <span>{c.issuer || '—'}</span>
          <span className="text-muted-foreground">{t('admin.sslUpload.expires')}</span>
          <span>
            <span className="font-mono">{ymd(c.not_after)}</span>
            {left != null && <> · {left >= 0 ? t('admin.sslUpload.daysLeft', { n: left }) : t('admin.sslUpload.expired')}</>}
          </span>
        </div>
      )}
      {extra}
    </UiModal>
  )
}

export default AdminSslUploadModal
