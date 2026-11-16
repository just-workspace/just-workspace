/**
 * 셸의 안 읽은 메일 수(탭바 메일 칸 7px 점).
 *
 * 데이터: 기존 메일 API `GET /api/mail/mailboxes`(기본 계정) 의 받은편지함 `unread_count` 합.
 * 신규 백엔드 없이 연결한다. 메일 서버(IMAP STATUS)로 전달되는 요청이므로 호출 빈도를 제한한다:
 *   - 로그인 후 1회, 이후 5분마다, 창이 다시 표시될 때(마지막 조회 1분 경과 후부터)
 *   - 메일 화면이 메일함을 조회하거나 읽음 처리로 수를 갱신하면(mailStore) 해당 값을 즉시 반영한다(기본 계정일 때만)
 * 메일 계정이 없거나(404) 모듈이 비활성화되어 있으면 null = 점 없음. 실패 시에도 오류 표시 없이 null.
 *
 * React: const unread = useMailUnread()  (null = 미상·없음)
 */
import { createStore, useStore } from 'zustand'
import { $fetch } from '~/lib/api'
import { authStore } from '~/composables/useAuth'
import { mailStore, mailSelectedAccount, mailTotalUnread, type Mailbox } from '~/composables/useMail'

const POLL_MS = 5 * 60_000
const FOCUS_MIN_GAP_MS = 60_000

export const mailUnreadStore = createStore<{ count: number | null }>()(() => ({ count: null }))

let _started = false
let _timer: ReturnType<typeof setInterval> | null = null
let _last = 0
let _disabled = false // 계정 없음(404) — 다음 로그인까지 조회하지 않음
let _accountsChecked = false // 이번 로그인에서 계정 목록 조회 여부

/** 받은편지함 안 읽음 합(받은편지함이 없으면 0) */
export function inboxUnread(mailboxes: Pick<Mailbox, 'role' | 'unread_count'>[]): number {
  return mailboxes.filter(m => m.role === 'inbox').reduce((n, m) => n + (m.unread_count || 0), 0)
}

/** background = 타이머에 의한 자동 호출 — 서버가 "사용자 활동"으로 집계하지 않도록 표시한다(폴링으로 인해 유휴 로그아웃이 동작하지 않던 문제) */
export async function refreshMailUnread(background = false) {
  if (_disabled || !authStore.getState().user) return
  _last = Date.now()
  try {
    // 메일 계정이 없는 사용자는 /mailboxes 가 항상 404 — 화면마다 콘솔 오류가 1건씩 기록되었다. 계정 목록을 먼저 조회한다.
    if (!_accountsChecked) {
      const accounts = await $fetch<unknown[]>('/api/mail/accounts')
      _accountsChecked = true
      if (!Array.isArray(accounts) || accounts.length === 0) {
        _disabled = true
        mailUnreadStore.setState({ count: null })
        return
      }
    }
    const data = await $fetch<{ mailboxes: Mailbox[] }>('/api/mail/mailboxes', background ? { headers: { 'X-Background': '1' } } : undefined)
    mailUnreadStore.setState({ count: inboxUnread(data.mailboxes || []) })
  } catch (e: any) {
    const status = e?.statusCode ?? e?.response?.status
    if (status === 404 || status === 403) _disabled = true
    mailUnreadStore.setState({ count: null })
  }
}

function onVisible() {
  if (document.visibilityState === 'visible' && Date.now() - _last > FOCUS_MIN_GAP_MS) void refreshMailUnread()
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null }
  mailUnreadStore.setState({ count: null })
}

function start() {
  if (_timer) return
  _disabled = false
  _accountsChecked = false
  void refreshMailUnread()
  _timer = setInterval(() => { void refreshMailUnread(true) }, POLL_MS)
}

/** 셸에서 1회 호출(탭바가 호출). 로그인 감시 + 메일 화면 상태 추종. */
export function ensureMailUnread() {
  if (_started) return
  _started = true
  let uid = authStore.getState().user?.id ?? null
  if (uid) start()
  authStore.subscribe((s) => {
    const next = s.user?.id ?? null
    if (next === uid) return
    uid = next
    stop()
    if (uid) start()
  })
  document.addEventListener('visibilitychange', onVisible)
  // 메일 화면이 기본 계정 메일함을 보유 중이면 해당 수가 최신 값이다(읽음 처리 즉시 반영)
  mailStore.subscribe((s, prev) => {
    if (s.mailboxes === prev.mailboxes || !s.mailboxes.length) return
    const acc = mailSelectedAccount(s)
    if (acc && !acc.is_default) return
    mailUnreadStore.setState({ count: mailTotalUnread(s) })
  })
}

/** 현재 안 읽은 메일 수(null = 미상·계정 없음). enabled=false 이면 감시를 시작하지 않고 null. */
export function useMailUnread(enabled = true): number | null {
  if (enabled) ensureMailUnread()
  const count = useStore(mailUnreadStore, s => s.count)
  return enabled ? count : null
}
