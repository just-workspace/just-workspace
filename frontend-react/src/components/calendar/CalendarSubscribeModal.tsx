/**
 * 캘린더 구독 추가(답변서 13 A2 · 시안 R13 #ics · #icsErr) — 캘린더 왼쪽 목록 "+ 구독 추가"와 설정 › 캘린더 [+ 구독 추가]가 같이 쓴다.
 * UiModal 480: .ics 주소(mono) → 칸을 벗어나면 서버가 바로 읽어(POST /api/calendar/subscriptions/preview)
 * "읽음 · 일정 n개 … 2026–2027" 확인 줄 + 이름 자동 채움 → 이름 · 색 8개(cat-1~8, 원형 28, 고른 것 ring).
 * 못 읽으면 주소 칸 error, [구독 추가] 비활성(#icsErr — 이름·색 칸 없이 주소 칸만).
 * 받기 규칙(SSRF 방지·5MB·20초)은 서버 app/calendar/subscriptions.py 와 같다.
 */
import { useRef, useState, type FormEvent } from 'react'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { CAT_HEX, CAT_COUNT, catForIndex, catNameKey } from '~/utils/categoryColor'
import { UiModal } from '~/components/ui/Modal'
import { UiInput } from '~/components/ui/Input'
import { UiButton } from '~/components/ui/Button'
import { UiIcon } from '~/components/ui/Icon'
import { UiTrans } from '~/components/ui/Trans'

/** POST /api/calendar/subscriptions/preview */
export interface SubscriptionPreview {
  url: string
  name: string | null
  count: number
  first_year: number | null
  last_year: number | null
}

/** 만들어진 구독(POST /api/calendar/subscriptions 응답) — 설정 화면 목록 줄과 같은 모양 */
export interface CreatedSubscription {
  id: string
  name: string
  color: string | null
  url: string
  fetched_at: string | null
  checked_at: string | null
  error: string | null
  is_visible?: boolean
}

// 시안 색 견본 — Tailwind 가 찾도록 글자 그대로
const SWATCH = ['bg-cat-1', 'bg-cat-2', 'bg-cat-3', 'bg-cat-4', 'bg-cat-5', 'bg-cat-6', 'bg-cat-7', 'bg-cat-8'] as const

/** 서버 오류 → 서버 이유 코드 */
export function subscribeErrorCode(e: unknown): string {
  const d = (e as { data?: { detail?: unknown } } | null)?.data?.detail
  if (d && typeof d === 'object' && 'code' in d) return String((d as { code: unknown }).code)
  return 'network'
}

/** 이유 코드 → 주소 칸 문구 키. 주소를 못 읽은 경우는 모두 시안 문구 하나로 */
export function subscribeErrorKey(code: string): string {
  if (code === 'duplicate') return 'calendar.subscribe.duplicate'
  if (code === 'too_many') return 'calendar.subscribe.tooMany'
  if (code === 'scheme' || code === 'invalid_url') return 'calendar.subscribe.invalidUrl'
  return 'calendar.subscribe.readError'
}

/** 확인 줄 오른쪽 연도 — "2026–2027" · 한 해면 "2026" · 없으면 '' */
export function yearRange(p: Pick<SubscriptionPreview, 'first_year' | 'last_year'>): string {
  if (!p.first_year) return ''
  if (!p.last_year || p.last_year === p.first_year) return String(p.first_year)
  return `${p.first_year}–${p.last_year}`
}

export interface CalendarSubscribeModalProps {
  /** 이미 있는 구독 수 — 기본 색을 순번(범주 1→8)으로 */
  existingCount?: number
  /** 추가됨 */
  onAdded?: (row: CreatedSubscription) => void
  /** 닫기 */
  onClose: () => void
}

/** 캘린더 구독 추가 모달 */
export function CalendarSubscribeModal({ existingCount = 0, onAdded, onClose }: CalendarSubscribeModalProps) {
  const { t } = useI18n()
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const nameTouched = useRef(false)
  const [cat, setCat] = useState(() => catForIndex(existingCount).cat)
  const [preview, setPreview] = useState<SubscriptionPreview | null>(null)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // 마지막으로 읽은(읽는 중인) 주소 — 같은 주소로 칸을 다시 벗어나면 또 읽지 않는다. 늦게 온 옛 응답은 버린다.
  const readFor = useRef('')

  async function read(raw: string) {
    const u = raw.trim()
    if (!u || u === readFor.current) return
    readFor.current = u
    setReading(true)
    setError('')
    setPreview(null)
    try {
      const p = await $fetch<SubscriptionPreview>('/api/calendar/subscriptions/preview', { method: 'POST', body: { url: u } })
      if (readFor.current !== u) return
      setPreview(p)
      if (!nameTouched.current) {
        let host = ''
        try { host = new URL(p.url).hostname } catch { /* 이름 없음 */ }
        setName(p.name || host)
      }
    } catch (e) {
      if (readFor.current !== u) return
      setError(t(subscribeErrorKey(subscribeErrorCode(e))))
    } finally {
      if (readFor.current === u) setReading(false)
    }
  }

  function onUrl(v: string) {
    setUrl(v)
    if (v.trim() !== readFor.current) {
      // 주소를 고치면 확인 결과·오류는 다시 읽을 때까지 무효
      readFor.current = ''
      setPreview(null)
      setError('')
      setReading(false)
    }
  }

  const canSubmit = !!preview && !reading && !busy && !error

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    if (!canSubmit || !preview) return
    setBusy(true)
    try {
      const row = await $fetch<CreatedSubscription>('/api/calendar/subscriptions', {
        method: 'POST',
        body: { url: preview.url, name: name.trim() || null, color: CAT_HEX[cat - 1] },
      })
      onAdded?.(row)
      onClose()
    } catch (err) {
      setError(t(subscribeErrorKey(subscribeErrorCode(err))))
      setPreview(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <UiModal
      title={t('calendar.subscribe.title')}
      size="480"
      persistent={busy}
      onClose={onClose}
      footer={(
        <>
          <UiButton variant="outline" size="sm" disabled={busy} onClick={onClose}>{t('common.cancel')}</UiButton>
          <UiButton type="submit" form="cal-subscribe-form" size="sm" disabled={!canSubmit}>
            {busy ? t('calendar.subscribe.adding') : t('calendar.subscribe.submit')}
          </UiButton>
        </>
      )}
    >
      <form id="cal-subscribe-form" className="flex flex-col gap-4" noValidate onSubmit={submit}>
        <UiInput
          label={t('calendar.subscribe.url')}
          mono
          type="url"
          placeholder="https://…/calendar.ics"
          modelValue={url}
          onUpdateModelValue={onUrl}
          onBlur={() => void read(url)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !preview) { e.preventDefault(); void read(url) } }}
          hint={t('calendar.subscribe.urlHint')}
          error={error}
          data-autofocus
        />

        {/* 확인 줄 — 읽는 동안에도 같은 자리·같은 상자(같은 높이)에 스피너 + "읽는 중…"(핸드오프 15-3), 읽으면 ✓ 읽음 · 일정 n개 */}
        {(reading || (preview && !error)) && (
          <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[13px]" role="status" aria-busy={reading || undefined}>
            {reading || !preview
              ? (
                <>
                  <UiIcon name="refresh" className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                  <span className="flex-1 text-muted-foreground">{t('calendar.subscribe.reading')}</span>
                </>
              )
              : (
                <>
                  <UiIcon name="check-circle" className="h-4 w-4 shrink-0 text-success" />
                  <UiTrans k="calendar.subscribe.read" className="flex-1" slots={{ n: <span className="font-mono">{preview.count}</span> }} />
                  {yearRange(preview) && <span className="text-xs text-muted-foreground">{yearRange(preview)}</span>}
                </>
              )}
          </div>
        )}

        {preview && !error && !reading && (
          <>
            <UiInput
              label={t('calendar.subscribe.name')}
              modelValue={name}
              onUpdateModelValue={(v) => { nameTouched.current = true; setName(v) }}
              hint={t('calendar.subscribe.nameHint')}
              maxLength={100}
            />
            <div className="flex flex-col gap-1.5">
              <span id="cal-subscribe-color" className="text-sm font-medium">{t('calendar.subscribe.color')}</span>
              <div role="radiogroup" aria-labelledby="cal-subscribe-color" className="flex gap-2">
                {Array.from({ length: CAT_COUNT }, (_, i) => i + 1).map(n => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={cat === n}
                    aria-label={t(catNameKey(n))}
                    title={t(catNameKey(n))}
                    className={cn(
                      'h-7 w-7 rounded-full focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card',
                      SWATCH[n - 1],
                      cat === n ? 'ring-2 ring-foreground ring-offset-2 ring-offset-card' : '',
                    )}
                    onClick={() => setCat(n)}
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </form>
    </UiModal>
  )
}

export default CalendarSubscribeModal
