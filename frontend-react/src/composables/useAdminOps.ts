/**
 * 관리 운영 요약("운영 요약 4칸" + 좌 내비 보조 글자).
 * 승인 대기 n · 마지막 백업 · SSL D-n · 서비스 n/n 을 GET /api/admin/ops-summary 1회 호출로 수신한다.
 * 해당 엔드포인트가 없는 구 버전 서버이면 기존 방식대로 API 4개를 병렬 호출한다.
 *
 * SSL: 서버가 설치 관리자의 인증서 상태(관리 › 보안의 인증서 카드와 동일한 출처) → 인증서 파일 → 내부 주소 → 공개 주소
 * 순으로 확인한다. 모두 읽기 실패 시 source/days_left 가 null — 화면은 "확인 불가"(unknown). 설치 관리자 없이 구성하였고
 * 헤어핀 NAT 가 없어 서버가 자신의 공개 주소로 접속할 수 없는 환경이 이에 해당한다(서버 설정 SSL_CERT_PATH 또는 SSL_CHECK_HOST 로 해결).
 * temporary = 설치 관리자가 판정한 임시(자체 서명) 인증서.
 *
 * React: const { ops, refresh, ensure } = useAdminOps()   — ops 는 값(읽기 전용으로 사용)
 * 컴포넌트 밖: adminOpsStore.getState().ops · refreshAdminOps() · ensureAdminOps()
 */
import { createStore, useStore } from 'zustand'
import { $fetch } from '~/lib/api'

export interface AdminOps {
  loaded: boolean
  /** 승인 대기(비활성 + 로그인 이력 없음). null = 조회 실패 */
  pending: number | null
  /** 사용자 수(ops-summary). 구 버전 서버이면 null */
  users: { pending: number; active: number; suspended: number; open_invites: number } | null
  backup: { at: string; status: string } | null | undefined
  /** unknown = 서버가 만료일을 확인하지 못함(확인 불가) */
  ssl: { installed: boolean; notAfter: string | null; days: number | null; source: string | null; unknown: boolean; temporary?: boolean } | null
  services: { ok: number; total: number; downNames: string[] } | null
}

interface OpsSummary {
  users: { pending: number; active: number; suspended: number; open_invites: number }
  backup: { status: string; created_at: string | null; last_success_at?: string | null } | null
  ssl: { days_left: number | null; not_after: string | null; source: string | null; temporary?: boolean }
  services: { ok: number; down: number; checking?: number; down_names: string[] }
}

/** ops-summary 응답 → 화면 모델 */
export function fromOpsSummary(r: OpsSummary): AdminOps {
  const sv = r.services || { ok: 0, down: 0, checking: 0, down_names: [] }
  const known = !!r.ssl?.source && r.ssl.days_left != null
  return {
    loaded: true,
    pending: r.users?.pending ?? null,
    users: r.users ?? null,
    backup: r.backup ? (r.backup.created_at ? { at: r.backup.created_at, status: r.backup.status } : null) : null,
    ssl: {
      installed: known,
      notAfter: r.ssl?.not_after ?? null,
      days: known ? r.ssl.days_left : null,
      source: r.ssl?.source ?? null,
      unknown: !known,
      temporary: known && !!r.ssl?.temporary,
    },
    services: { ok: sv.ok, total: sv.ok + sv.down + (sv.checking || 0), downNames: sv.down_names || [] },
  }
}

const EMPTY: AdminOps = { loaded: false, pending: null, users: null, backup: undefined, ssl: null, services: null }
let inflight: Promise<void> | null = null

/** 남은 일수(오늘 = 0). 파싱 실패 null */
export function daysUntil(dateText: string | null | undefined): number | null {
  if (!dateText) return null
  const t = Date.parse(dateText)
  if (Number.isNaN(t)) return null
  return Math.floor((t - Date.now()) / 86_400_000)
}

/** 원시 enum → 한글 */
export const RUN_STATUS_LABEL: Record<string, string> = {
  success: '완료', partial: '일부 실패', running: '진행 중', idle: '대기', failed: '실패', building: '진행 중',
}
/** 원시 enum → i18n 키. 화면에서는 t(RUN_STATUS_KEY[s]) 로 사용한다(RUN_STATUS_LABEL 은 기존 호출부·테스트 호환용) */
export const RUN_STATUS_KEY: Record<string, string> = {
  success: 'admin.runStatus.success', partial: 'admin.runStatus.partial', running: 'admin.runStatus.running',
  idle: 'admin.runStatus.idle', failed: 'admin.runStatus.failed', building: 'admin.runStatus.building',
}
export const RUN_STATUS_TONE: Record<string, 'success' | 'warning' | 'primary' | 'neutral' | 'danger'> = {
  success: 'success', partial: 'warning', running: 'primary', building: 'primary', idle: 'neutral', failed: 'danger',
}

/** 앱 전역 상태: 운영 요약 값 · 수신 시각 */
export const adminOpsStore = createStore<{ ops: AdminOps; fetchedAt: number }>()(() => ({ ops: { ...EMPTY }, fetchedAt: 0 }))

/** 구 버전 서버(ops-summary 없음) — 기존 API 4개를 병렬 호출 */
async function legacy(): Promise<AdminOps> {
  const [users, backups, ssl, svcs] = await Promise.allSettled([
    $fetch<{ is_active: boolean; last_login_at?: string | null }[]>('/api/admin/users/pending'),
    $fetch<{ backups: { created_at: string; status: string }[] }>('/api/admin/backup', { credentials: 'include' }),
    $fetch<{ installed: boolean; not_after?: string }>('/api/admin/settings/ssl'),
    $fetch<{ name: string; status: string }[]>('/api/services/status', { credentials: 'include' }),
  ])
  const next: AdminOps = { ...EMPTY, loaded: true }
  if (users.status === 'fulfilled') next.pending = users.value.filter(u => !u.last_login_at).length
  if (backups.status === 'fulfilled') {
    const list = [...(backups.value.backups || [])].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    next.backup = list[0] ? { at: list[0].created_at, status: list[0].status } : null
  }
  if (ssl.status === 'fulfilled') {
    const na = ssl.value.not_after || null
    const days = daysUntil(na)
    next.ssl = { installed: !!ssl.value.installed, notAfter: na, days, source: ssl.value.installed ? 'local' : null, unknown: days == null }
  }
  if (svcs.status === 'fulfilled') {
    next.services = { ok: svcs.value.filter(s => s.status === 'ok').length, total: svcs.value.length, downNames: svcs.value.filter(s => s.status === 'down').map(s => s.name) }
  }
  return next
}

export async function refreshAdminOps(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    let next: AdminOps
    try {
      next = fromOpsSummary(await $fetch<OpsSummary>('/api/admin/ops-summary'))
    } catch (e: any) {
      const status = e?.statusCode ?? e?.response?.status
      // 엔드포인트가 없는 경우에만 기존 방식 사용 — 권한·서버 오류는 "불러오기 실패" 처리
      next = status === 404 || status === 405 ? await legacy() : { ...EMPTY, loaded: true }
    }
    adminOpsStore.setState({ ops: next, fetchedAt: Date.now() })
  })().finally(() => { inflight = null })
  return inflight
}

/** 60초 이내에 수신한 값이 있으면 재호출하지 않는다(내비가 페이지마다 호출한다) */
export function ensureAdminOps() {
  if (Date.now() - adminOpsStore.getState().fetchedAt < 60_000) return
  void refreshAdminOps()
}

export function useAdminOps() {
  const ops = useStore(adminOpsStore, s => s.ops)
  return { ops, refresh: refreshAdminOps, ensure: ensureAdminOps }
}
