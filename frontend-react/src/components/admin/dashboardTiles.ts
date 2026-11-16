/**
 * 관리 › 개요의 운영 요약 4칸·서비스 상태 계산 — tiles·svcState·fmtWhen·mmdd(순수 함수).
 */
import { RUN_STATUS_KEY, type AdminOps } from '~/composables/useAdminOps'

type T = (key: string, params?: any) => string

export type OpsTone = 'warning' | 'success' | 'danger' | 'neutral'

export const TONE_TILE: Record<OpsTone, string> = {
  warning: 'bg-warning/15 text-warning',
  success: 'bg-success/15 text-success',
  danger: 'bg-danger/15 text-danger',
  neutral: 'bg-muted text-muted-foreground',
}

export interface OpsTile {
  key: string
  icon: string
  action: string
  to: string
  value: string
  hint: string | undefined
  tone: OpsTone
}

/** 오늘이면 "오늘 HH:mm", 어제면 "어제 HH:mm", 그 밖 "M/D HH:mm" */
export function fmtWhen(iso: string, t: T, today = new Date()): string {
  const d = new Date(iso)
  const hm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (d.toDateString() === today.toDateString()) return t('admin.dashboard.whenToday', { time: hm })
  const y = new Date(today); y.setDate(today.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return t('admin.dashboard.whenYesterday', { time: hm })
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

export function mmdd(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

/** 운영 요약 4칸(승인 대기 · 마지막 백업 · SSL · 서비스) */
export function buildOpsTiles(o: AdminOps, t: T, today = new Date()): OpsTile[] {
  const pend = o.pending
  const b = o.backup
  const s = o.ssl
  const sv = o.services
  const sslDays = s?.days ?? null
  const failed = t('admin.common.loadFailed')
  return [
    {
      key: t('admin.dashboard.tilePending'), icon: 'user-plus', action: t('admin.dashboard.actionReview'), to: '/admin/users?filter=pending',
      value: pend == null ? (o.loaded ? failed : '…') : t('admin.dashboard.pendingCount', { n: pend }),
      hint: o.users?.open_invites ? t('admin.dashboard.openInvites', { n: o.users.open_invites }) : undefined,
      tone: (pend == null ? 'neutral' : pend > 0 ? 'warning' : 'success') as OpsTone,
    },
    {
      key: t('admin.dashboard.tileBackup'), icon: 'download', action: t('admin.dashboard.actionHistory'), to: '/admin/storage#backup',
      hint: undefined,
      value: b === undefined ? (o.loaded ? failed : '…') : b === null ? t('admin.dashboard.noRecord') : `${fmtWhen(b.at, t, today)} · ${RUN_STATUS_KEY[b.status] ? t(RUN_STATUS_KEY[b.status]) : b.status}`,
      tone: (b == null ? (b === null ? 'warning' : 'neutral') : b.status === 'success' ? 'success' : b.status === 'running' ? 'neutral' : 'warning') as OpsTone,
    },
    {
      key: t('admin.dashboard.tileSsl'), icon: 'shield', action: t('admin.dashboard.actionRenew'), to: '/admin/security',
      // 서버가 인증서를 읽지 못하면(헤어핀 NAT 없이 공개 주소 접속 실패 등) "확인 불가" — 만료로 오인하지 않도록 중립색 사용
      value: !s ? (o.loaded ? failed : '…') : s.unknown || sslDays == null ? t('admin.dashboard.sslUnknown')
        : sslDays < 0 ? t('admin.common.expired')
          : t('admin.dashboard.sslDays', { d: sslDays, date: mmdd(s.notAfter!) }),
      // 임시(자체 서명) 인증서는 만료일과 무관하게 주의 — 관리 › 보안의 인증서 카드와 동일한 판정
      hint: s?.unknown ? t('admin.dashboard.sslUnknownHint') : s?.temporary ? t('admin.dashboard.sslTemporaryHint') : undefined,
      tone: (!s || s.unknown || sslDays == null ? 'neutral' : sslDays < 0 ? 'danger' : sslDays <= 30 || s.temporary ? 'warning' : 'success') as OpsTone,
    },
    {
      key: t('admin.dashboard.tileServices'), icon: 'activity', action: t('admin.dashboard.actionStatus'), to: '/admin/system',
      value: !sv ? (o.loaded ? failed : '…') : t('admin.dashboard.servicesOk', { ok: sv.ok, total: sv.total }),
      hint: sv?.downNames.length ? t('admin.dashboard.servicesDown', { names: sv.downNames.map(n => svcLabel(n, t)).join(', ') }) : undefined,
      tone: (!sv ? 'neutral' : sv.ok === sv.total ? 'success' : 'warning') as OpsTone,
    },
  ]
}

/** 서비스 표시 이름 — 서버가 전달하는 이름 중 제품명이 아닌 일반 명칭(예: "Mail Server")은 화면 언어로 표시한다 */
export function svcLabel(name: string, t: T): string {
  return t(`admin.svc.names.${name}`, name)
}

/** 서비스 한 줄의 상태 점·글자. 응답이 latencyWarnMs 를 초과하면 "느림" */
export function svcState(s: { status: string; response_ms: number | null }, latencyWarnMs: number, t: T): { dot: string; label: string } {
  if (s.status === 'down') return { dot: 'down', label: t('admin.svc.down') }
  if (s.status !== 'ok') return { dot: 'connecting', label: t('admin.svc.checking') }
  if (s.response_ms != null && s.response_ms > latencyWarnMs) return { dot: 'slow', label: t('admin.svc.slow') }
  return { dot: 'ok', label: t('admin.svc.ok') }
}

/** 관리 설정 system.latency_warn_ms(양수) — 없거나 유효하지 않으면 800 */
export function latencyWarnMsOf(config: Record<string, string> | null | undefined): number {
  const v = Number((config?.['system.latency_warn_ms'] ?? '').trim())
  return Number.isFinite(v) && v > 0 ? v : 800
}
