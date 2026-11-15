/**
 * 설정 › 일반 "로그인 방식" — Vue components/admin/AdminLoginMethods.vue.
 * 로컬 계정 · LDAP · SSO 의 순서와 사용 여부를 한 카드에(기존 "인증 우선순위"와 LDAP "사용" 체크를 통합).
 * 행 48(rounded-md bg-background) = 끌기 손잡이 + 순번 mono + 이름·설명 + "설정" + 스위치. 순서·스위치는 즉시 저장 + "저장됨 ✓".
 * 아래 "LDAP 연결" 카드(텍스트 필드)는 카드별 저장(되돌리기/저장) + 연결 시험.
 * ★ 백엔드 갭: 로컬 계정 끄기 API 없음(항상 켜짐) · SSO(OIDC) 없음 → 둘 다 스위치 비활성.
 * 루트가 카드 둘(Fragment)이다.
 *
 * @example <AdminLoginMethods />
 */
import { useEffect, useState, type KeyboardEvent } from 'react'
import { useI18n } from '~/i18n'
import { $fetch } from '~/lib/api'
import { cn } from '~/lib/utils'
import { addToast } from '~/composables/useToast'
import { NuxtLink } from '~/components/NuxtLink'
import { SettingsCard } from '~/components/settings/SettingsCard'
import { UiSkeleton } from '~/components/ui/Skeleton'
import { UiErrorTile } from '~/components/ui/ErrorTile'
import { UiIcon } from '~/components/ui/Icon'
import { UiSwitch } from '~/components/ui/Switch'
import { UiInput } from '~/components/ui/Input'
import { UiCheckbox } from '~/components/ui/Checkbox'
import { UiPasswordInput } from '~/components/ui/PasswordInput'
import { UiButton } from '~/components/ui/Button'

/** 로그인 방식 출처 */
export type AuthSrc = 'local' | 'ldap' | 'sso'

const LDAP_EMPTY = {
  enabled: false, host: '', port: 389 as number | string, use_ssl: false, bind_dn: '', bind_password: '',
  base_dn: '', user_filter: '(sAMAccountName={username})', attr_email: 'mail',
  attr_name: 'displayName', auto_provision: true, has_bind_password: false,
}
/** LDAP 설정(서버 /api/admin/auth/ldap 모양) */
export type LdapCfg = typeof LDAP_EMPTY
const LDAP_FIELDS: (keyof LdapCfg)[] = ['host', 'port', 'use_ssl', 'bind_dn', 'bind_password', 'base_dn', 'user_filter', 'attr_email', 'attr_name', 'auto_provision']

/** LDAP 연결 카드 변경 건수(비밀번호는 입력했으면 1, enabled 는 스위치라 제외) */
export function ldapChangeCount(ldap: LdapCfg, orig: LdapCfg): number {
  return LDAP_FIELDS.filter(k => k === 'bind_password' ? !!ldap.bind_password : String(ldap[k]) !== String(orig[k])).length
}

/** 서버 순서(local/ldap 만) → 화면 순서(빠진 것은 뒤에 붙이고 sso 는 맨 끝) */
export function normalizeAuthOrder(order: string[] | undefined): AuthSrc[] {
  const o = (order || []).filter((x): x is AuthSrc => x === 'local' || x === 'ldap')
  if (!o.includes('local')) o.push('local')
  if (!o.includes('ldap')) o.push('ldap')
  return [...o, 'sso']
}

/** 끌어 놓기 결과 순서(sso 는 끝에 고정). 바뀌지 않으면 null */
export function dropOrder(order: AuthSrc[], src: AuthSrc | null, target: AuthSrc): AuthSrc[] | null {
  if (!src || src === target || src === 'sso' || target === 'sso') return null
  const arr = order.filter(s => s !== 'sso' && s !== src)
  arr.splice(arr.indexOf(target) + (order.indexOf(src) < order.indexOf(target) ? 1 : 0), 0, src)
  return [...arr, 'sso']
}

/** 키보드 ↑↓ 이동 결과 순서(sso 는 움직이지 않음). 범위 밖이면 null */
export function moveOrder(order: AuthSrc[], src: AuthSrc, delta: number): AuthSrc[] | null {
  if (src === 'sso') return null
  const arr = order.filter(s => s !== 'sso')
  const i = arr.indexOf(src), j = i + delta
  if (j < 0 || j >= arr.length) return null
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
  return [...arr, 'sso']
}

export function AdminLoginMethods() {
  const { t } = useI18n()
  const [order, setOrder] = useState<AuthSrc[]>(['local', 'ldap', 'sso'])
  const [orderSaved, setOrderSaved] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [ldap, setLdap] = useState<LdapCfg>({ ...LDAP_EMPTY })
  const [ldapOrig, setLdapOrig] = useState<LdapCfg>({ ...LDAP_EMPTY })
  const [ldapSaving, setLdapSaving] = useState(false)
  const [ldapSaved, setLdapSaved] = useState(false)
  const [dragging, setDragging] = useState<AuthSrc | null>(null)
  const [test, setTest] = useState({ username: '', password: '', running: false, ok: null as boolean | null, message: '' })

  function flash(set: (v: boolean) => void) { set(true); setTimeout(() => { set(false) }, 2000) }
  const setL = <K extends keyof LdapCfg>(k: K, v: LdapCfg[K]) => setLdap(l => ({ ...l, [k]: v }))

  async function load() {
    setLoading(true); setLoadError(false)
    try {
      const [a, c] = await Promise.all([
        $fetch<{ order: string[] }>('/api/setup/auth-order'),
        $fetch<Partial<LdapCfg>>('/api/admin/auth/ldap', { credentials: 'include' }),
      ])
      setOrder(normalizeAuthOrder(a.order))
      const next = { ...LDAP_EMPTY, ...c, bind_password: '' }
      setLdap(next)
      setLdapOrig({ ...next })
    } catch { setLoadError(true) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const ROWS: Record<AuthSrc, { name: string; desc: () => string }> = {
    local: { name: t('adminParts.loginMethods.local'), desc: () => t('adminParts.loginMethods.localDesc') },
    ldap: { name: 'LDAP', desc: () => ldap.host ? `${ldap.host}${ldap.base_dn ? ` · ${ldap.base_dn}` : ''}` : t('adminParts.loginMethods.notConnected') },
    sso: { name: 'SSO (OIDC)', desc: () => t('adminParts.loginMethods.notConnected') },
  }

  // ── 순서(즉시 저장) ──
  async function saveOrder(next: AuthSrc[]) {
    const prev = order
    setOrder(next)
    try {
      await $fetch('/api/setup/auth-order', { method: 'PATCH', body: { order: next.filter(s => s !== 'sso') } })
      flash(setOrderSaved)
    } catch (e: any) {
      setOrder(prev)
      addToast('error', e?.data?.detail || t('adminParts.loginMethods.orderSaveError'))
    }
  }
  function onDrop(target: AuthSrc) {
    const src = dragging
    setDragging(null)
    const next = dropOrder(order, src, target)
    if (next) void saveOrder(next)
  }
  function onHandleKey(e: KeyboardEvent, src: AuthSrc) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const next = moveOrder(order, src, e.key === 'ArrowUp' ? -1 : 1)
    if (next) void saveOrder(next)
  }

  // ── LDAP 사용 스위치(즉시 저장) ──
  async function setLdapEnabled(v: boolean) {
    try {
      // 스위치는 사용 여부만 보낸다(편집 중인 텍스트 필드는 카드 저장으로). 백엔드는 보낸 키만 바꾼다.
      const c = await $fetch<Partial<LdapCfg>>('/api/admin/auth/ldap', { method: 'PUT', credentials: 'include', body: { enabled: v } })
      const en = !!c.enabled
      setLdap(l => ({ ...l, enabled: en }))
      setLdapOrig(o => ({ ...o, enabled: en }))
      flash(setOrderSaved)
    } catch (e: any) { addToast('error', e?.data?.detail || t('adminParts.loginMethods.ldapToggleError')) }
  }

  // ── LDAP 연결 카드(카드별 저장) ──
  function ldapBody(over: Partial<LdapCfg> = {}) {
    const body: Record<string, unknown> = { ...ldap, ...over }
    delete body.has_bind_password
    if (!body.bind_password) delete body.bind_password
    return body
  }
  const ldapChanges = ldapChangeCount(ldap, ldapOrig)
  function resetLdap() { setLdap({ ...ldapOrig, bind_password: '' }) }
  async function saveLdap() {
    setLdapSaving(true)
    try {
      const c = await $fetch<Partial<LdapCfg>>('/api/admin/auth/ldap', { method: 'PUT', credentials: 'include', body: ldapBody({ port: Number(ldap.port) || 389 }) })
      const next = { ...LDAP_EMPTY, ...c, bind_password: '' }
      setLdap(next)
      setLdapOrig({ ...next })
      flash(setLdapSaved)
    } catch (e: any) { addToast('error', e?.data?.detail || t('adminParts.loginMethods.ldapSaveError')) }
    finally { setLdapSaving(false) }
  }

  async function runTest() {
    setTest(s => ({ ...s, running: true, ok: null, message: '' }))
    let ok = false, message = ''
    try {
      const r = await $fetch<any>('/api/admin/auth/ldap/test', { method: 'POST', credentials: 'include', body: { username: test.username, password: test.password } })
      ok = !!r.ok
      message = r.ok ? `${r.name || ''} <${r.email || ''}> ${r.dn ? `(${r.dn})` : ''}`.trim() : (r.message || t('adminParts.loginMethods.failed'))
    } catch (e: any) { ok = false; message = e?.data?.detail || e?.message || t('adminParts.loginMethods.failed') }
    setTest(s => ({ ...s, running: false, ok, message }))
  }

  function scrollToLdap() { document.getElementById('ldap')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
  // Nuxt 라우터는 같은 페이지 #해시 이동 때 그 요소로 스크롤한다 — React Router 는 하지 않아 여기서 맞춘다
  function scrollToGeneral() { setTimeout(() => document.getElementById('general')?.scrollIntoView({ block: 'start' }), 0) }

  return (
    <>
      <SettingsCard title={t('adminParts.loginMethods.title')} description={t('adminParts.loginMethods.desc')} saved={orderSaved}>
        {loading ? (
          <UiSkeleton preset="list" rows={3} />
        ) : loadError ? (
          <UiErrorTile placement="card" title={t('adminParts.loginMethods.loadError')} onRetry={load} />
        ) : (
          <ol className="flex flex-col gap-2" aria-label={t('adminParts.loginMethods.orderLabel')}>
            {order.map((src, i) => (
              <li
                key={src}
                className={cn('flex min-h-12 items-center gap-3 rounded-md border border-border bg-background px-3 text-[13px]', dragging === src ? 'opacity-50' : '')}
                onDragOver={e => e.preventDefault()}
                onDrop={() => onDrop(src)}
              >
                {src !== 'sso' ? (
                  <button
                    type="button"
                    draggable="true"
                    aria-label={t('adminParts.loginMethods.dragHandle')}
                    title={t('adminParts.loginMethods.dragHandleTitle')}
                    className="-m-2 grid h-10 w-8 cursor-grab place-items-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    onDragStart={() => setDragging(src)}
                    onDragEnd={() => setDragging(null)}
                    onKeyDown={e => onHandleKey(e, src)}
                  >
                    <UiIcon name="grip" className="h-4 w-4" />
                  </button>
                ) : (
                  <span className="-m-2 w-8" aria-hidden="true" />
                )}
                <b className={cn('w-[18px] font-mono text-xs font-semibold', src === 'sso' ? 'text-muted-foreground' : '')}>{i + 1}</b>
                <span className="min-w-0 flex-1 truncate">
                  <b className="font-semibold text-foreground">{ROWS[src].name}</b>
                  <span className="ml-1.5 text-muted-foreground">{ROWS[src].desc()}</span>
                </span>
                {src === 'local' ? (
                  <NuxtLink to="#general" className="shrink-0 text-xs font-semibold text-primary hover:underline" onClick={scrollToGeneral}>{t('adminParts.loginMethods.configure')}</NuxtLink>
                ) : src === 'ldap' ? (
                  <button type="button" className="shrink-0 text-xs font-semibold text-primary hover:underline" onClick={scrollToLdap}>{t('adminParts.loginMethods.configure')}</button>
                ) : (
                  <span className="shrink-0 text-xs font-semibold text-muted-foreground" title={t('adminParts.loginMethods.ssoUnsupported')}>{t('adminParts.loginMethods.configure')}</span>
                )}
                {src === 'local' ? (
                  <UiSwitch modelValue disabled ariaLabel={t('adminParts.loginMethods.useLocal')} title={t('adminParts.loginMethods.localAlwaysOn')} />
                ) : src === 'ldap' ? (
                  <UiSwitch modelValue={ldap.enabled} onUpdateModelValue={v => void setLdapEnabled(v)} ariaLabel={t('adminParts.loginMethods.useLdap')} />
                ) : (
                  <UiSwitch modelValue={false} disabled ariaLabel={t('adminParts.loginMethods.useSso')} title={t('adminParts.loginMethods.ssoUnsupported')} />
                )}
              </li>
            ))}
          </ol>
        )}
      </SettingsCard>

      <SettingsCard
        id="ldap"
        title={t('adminParts.loginMethods.ldapTitle')}
        description={t('adminParts.loginMethods.ldapDesc')}
        changes={ldapChanges}
        saving={ldapSaving}
        saved={ldapSaved}
        className="scroll-mt-4"
        onSave={saveLdap}
        onReset={resetLdap}
      >
        {loading ? (
          <UiSkeleton preset="text" rows={4} />
        ) : (
          <form className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); void saveLdap() }}>
            <UiInput modelValue={ldap.host} onUpdateModelValue={v => setL('host', v)} label={t('admin.settings.smtp.host')} placeholder="ad.example.com" mono />
            <div className="flex items-end gap-3">
              <UiInput modelValue={ldap.port} onUpdateModelValue={v => setL('port', v)} type="number" label={t('admin.settings.smtp.port')} mono className="flex-1" />
              <UiCheckbox modelValue={ldap.use_ssl} onUpdateModelValue={v => setL('use_ssl', v)} label="SSL" />
            </div>
            <UiInput modelValue={ldap.bind_dn} onUpdateModelValue={v => setL('bind_dn', v)} label={t('adminParts.loginMethods.bindDn')} placeholder="CN=svc,OU=...,DC=example,DC=com" mono className="sm:col-span-2" />
            <UiPasswordInput modelValue={ldap.bind_password} onUpdateModelValue={v => setL('bind_password', v)} label={t('adminParts.loginMethods.bindPassword')} placeholder={ldap.has_bind_password ? t('adminParts.secretKeepPlaceholder') : ''} autocomplete="new-password" className="sm:col-span-2" />
            <UiInput modelValue={ldap.base_dn} onUpdateModelValue={v => setL('base_dn', v)} label="Base DN" placeholder="DC=example,DC=com" mono className="sm:col-span-2" />
            <UiInput modelValue={ldap.user_filter} onUpdateModelValue={v => setL('user_filter', v)} label={t('adminParts.loginMethods.userFilter')} hint={t('adminParts.loginMethods.userFilterHint')} mono className="sm:col-span-2" />
            <UiInput modelValue={ldap.attr_email} onUpdateModelValue={v => setL('attr_email', v)} label={t('adminParts.loginMethods.attrEmail')} mono />
            <UiInput modelValue={ldap.attr_name} onUpdateModelValue={v => setL('attr_name', v)} label={t('adminParts.loginMethods.attrName')} mono />
            <UiCheckbox modelValue={ldap.auto_provision} onUpdateModelValue={v => setL('auto_provision', v)} label={t('adminParts.loginMethods.autoProvision')} className="sm:col-span-2" />
            <button type="submit" className="hidden" />
          </form>
        )}

        {!loading && (
          <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
            <div className="text-[13px] font-semibold text-foreground">{t('adminParts.loginMethods.testTitle')}</div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <UiInput modelValue={test.username} onUpdateModelValue={v => setTest(s => ({ ...s, username: v }))} label={t('adminParts.loginMethods.testUsername')} className="flex-1" />
              <UiPasswordInput modelValue={test.password} onUpdateModelValue={v => setTest(s => ({ ...s, password: v }))} label={t('fields.password')} autocomplete="new-password" className="flex-1" />
              <UiButton variant="outline" className="sm:mt-[22px]" disabled={test.running || !test.username} onClick={runTest}>{test.running ? t('adminParts.loginMethods.testing') : t('adminParts.loginMethods.test')}</UiButton>
            </div>
            {test.ok !== null && (
              <p role="status" className={cn('flex items-center gap-1.5 text-xs', test.ok ? 'text-success' : 'text-danger')}>
                <UiIcon name={test.ok ? 'check-circle' : 'alert-circle'} className="h-3.5 w-3.5 shrink-0" />
                <span className="break-all">{test.ok ? t('common.success') : t('adminParts.loginMethods.failed')} — {test.message}</span>
              </p>
            )}
          </div>
        )}
      </SettingsCard>
    </>
  )
}

export default AdminLoginMethods
