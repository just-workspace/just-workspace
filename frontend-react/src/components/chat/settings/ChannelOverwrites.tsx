/**
 * 채널·카테고리 권한 덮어쓰기(#perm-cat · 모바일 #m-perm).
 * 위 동기화 banner(채널: 카테고리와 다르면 warn + [동기화] · 카테고리: 동기화된 채널 N개에 함께 적용) →
 * 비공개 스위치(@everyone '채널 보기' 거부 — 채널 수정 API 가 type 을 받지 않아 디스코드식 덮어쓰기로) →
 * 대상 목록 220(@everyone · 역할 · 사람) + [+] / 권한 행(UiTriToggle 거부·상속·허용 → putOverwrite 즉시 저장) →
 * 아래 "○○ 님이 할 수 있는 것" 한 줄(선택 대상의 결과 — 채널 멤버 기준).
 * targetId 가 없으면 카테고리 → 채널 고르기 목록을 먼저 보인다.
 *
 * 동기화(우리 엔진): 카테고리 덮어쓰기 → 채널 덮어쓰기 순으로 겹쳐 계산한다. 그래서 "동기화" = 채널 덮어쓰기를 지워
 * 카테고리 것만 먹게 하는 것(복사해 두면 나중에 카테고리를 바꿔도 채널 사본이 덮어써 어긋난다).
 * 모바일: 대상 목록 → 대상 화면(44 정사각 3칸 UiTriToggle size touch).
 */
import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { cn } from '~/lib/utils'
import { useI18n } from '~/i18n'
import { UiIcon } from '~/components/ui/Icon'
import { UiIconButton } from '~/components/ui/IconButton'
import { UiSwitch } from '~/components/ui/Switch'
import { UiAvatar } from '~/components/ui/Avatar'
import { UiTriToggle, type UiTriValue } from '~/components/ui/TriToggle'
import { addToast } from '~/composables/useToast'
import { authStore } from '~/composables/useAuth'
import { chatStore, type Channel } from '~/composables/useChat'
import { openChatSettings } from '~/composables/useChatUi'
import { chatLayoutStore } from '~/composables/useChatLayout'
import {
  PERM, applyTri, deleteOverwrite, fetchOverwrites, hasBit, loadMyChannelPerms, loadUserRoles, putOverwrite, roleColorIndex, triOf,
  useChatRoles, type OverwriteTarget, type PermOverwrite,
} from '~/composables/useChatRoles'
import { SUMMARY_BITS, canGrantBit, channelSynced, effectiveFor, permGroups as buildPermGroups } from './settingsLogic'
import { usePermText } from './PermissionMatrix'
import { UserPicker } from './RoleEditor'
import { MobileHeader, RoleDot, SettingsBanner, SettingsHeader, errorText, statusOf, useSettingsCtx } from './parts'

const ALL_BITS = Object.values(PERM).reduce((a, b) => a + b, 0)
const chanLabel = (c: Pick<Channel, 'name' | 'type'> | undefined) => (c ? (c.type === 'private' ? c.name : `#${c.name}`) : '')

export function ChannelOverwrites({ kind, targetId }: { kind: 'channel' | 'category'; targetId: string | null }) {
  if (!targetId) return <TargetPicker />
  return <OverwriteEditor key={`${kind}:${targetId}`} kind={kind} targetId={targetId} />
}

// ─── 고르기(카테고리 → 채널) ───
function TargetPicker() {
  const { t } = useI18n()
  const { mobile, backToMenu } = useSettingsCtx()
  const channels = useStore(chatStore, s => s.channels)
  const categories = useStore(chatLayoutStore, s => s.categories)
  const list = channels.filter(c => c.type !== 'dm')
  const cats = [...categories].sort((a, b) => a.position - b.position)
  const groups = [
    ...cats.map(c => ({ cat: c, items: list.filter(x => x.category_id === c.id) })),
    { cat: null, items: list.filter(x => !x.category_id || !cats.some(c => c.id === x.category_id)) },
  ].filter(g => g.cat || g.items.length)
  const row = 'flex w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-overlay-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
  const body = (
    <div className="flex flex-col gap-1">
      {groups.map(g => (
        <div key={g.cat?.id ?? '_'} className="flex flex-col">
          {g.cat
            ? (
              <button type="button" className={cn(row, mobile ? 'min-h-14 text-[16px]' : 'h-9 text-[15px] font-semibold')} onClick={() => openChatSettings('category-perm', g.cat!.id)}>
                <UiIcon name="folder" className="h-4 w-4 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{g.cat.name}</span>
                <span className="text-[12px] text-muted-foreground">{t('chat.settings.perm.catPerm')}</span>
                <UiIcon name="chevron-right" className="h-4 w-4 text-muted-foreground" />
              </button>
            )
            : <p className="px-2 pb-1 pt-3 text-[12px] font-semibold text-muted-foreground">{t('chat.settings.perm.uncategorized')}</p>}
          {g.items.map(c => (
            <button key={c.id} type="button" className={cn(row, mobile ? 'min-h-12 pl-8 text-[16px]' : 'h-8 pl-8 text-[15px] text-muted-foreground hover:text-foreground')} onClick={() => openChatSettings('channel-perm', c.id)}>
              <UiIcon name={c.type === 'private' ? 'lock' : c.is_voice ? 'volume-2' : 'hash'} className="h-4 w-4" />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
            </button>
          ))}
        </div>
      ))}
      {!groups.length && <p className="py-6 text-center text-[13px] text-muted-foreground">{t('chat.settings.perm.noChannels')}</p>}
    </div>
  )
  if (mobile) {
    return (
      <div className="flex h-full flex-col">
        <MobileHeader title={t('chat.settings.nav.channelPerm')} onBack={backToMenu} />
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">{body}</div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-5">
      <SettingsHeader title={t('chat.settings.nav.channelPerm')} sub={t('chat.settings.perm.pickSub')} />
      {body}
    </div>
  )
}

// ─── 편집 ───
interface Subject { kind: 'role' | 'user'; id: string }

function OverwriteEditor({ kind, targetId }: { kind: 'channel' | 'category'; targetId: string }) {
  const { t } = useI18n()
  const pt = usePermText()
  const { mobile } = useSettingsCtx()
  const target: OverwriteTarget = kind === 'channel' ? 'channels' : 'categories'
  const roles = useChatRoles(s => s.roles)
  const catalog = useChatRoles(s => s.catalog)
  const myWs = useChatRoles(s => s.myWorkspacePerms)
  const myCh = useChatRoles(s => (kind === 'channel' ? s.myChannelPerms[targetId] : undefined))
  const userRoles = useChatRoles(s => s.userRoles)
  const me = useStore(authStore, s => s.user)
  const isGlobalAdmin = !!me?.is_admin
  const myBits = isGlobalAdmin ? ALL_BITS : (myWs + (myCh ?? 0) - bitsAnd(myWs, myCh ?? 0))
  const channels = useStore(chatStore, s => s.channels)
  const allUsers = useStore(chatStore, s => s.allUsers)
  const categories = useStore(chatLayoutStore, s => s.categories)
  const channel = kind === 'channel' ? channels.find(c => c.id === targetId) : undefined
  const category = kind === 'category' ? categories.find(c => c.id === targetId) : undefined
  const everyone = roles.find(r => r.is_default) ?? null

  const [ows, setOws] = useState<PermOverwrite[] | null>(null)
  const [catOws, setCatOws] = useState<PermOverwrite[]>([])
  const [catId, setCatId] = useState<string | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [pending, setPending] = useState<Subject[]>([])
  const [selKey, setSelKey] = useState<string | null>(null)
  const [picker, setPicker] = useState(false)
  const [mobileTarget, setMobileTarget] = useState(false)
  const [syncedChannels, setSyncedChannels] = useState<Channel[] | null>(null)

  async function reload() {
    try {
      const r = await fetchOverwrites(target, targetId)
      setOws(r.overwrites); setCatOws(r.category_overwrites); setCatId(r.category_id); setLoadErr('')
    } catch (e) {
      setOws([])
      const st = statusOf(e)
      setLoadErr(st === 403 ? t('chat.settings.perm.noPerm') : errorText(e, t('chat.settings.perm.loadFail')))
    }
  }
  useEffect(() => { void reload(); if (kind === 'channel') void loadMyChannelPerms(targetId) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 카테고리판: 동기화된 채널 목록(채널마다 덮어쓰기를 읽어 본다)
  const inCat = useMemo(() => (kind === 'category' ? channels.filter(c => c.category_id === targetId && c.type !== 'dm') : []), [channels, kind, targetId])
  useEffect(() => {
    if (kind !== 'category' || ows === null) return
    let alive = true
    void Promise.all(inCat.map(c => fetchOverwrites('channels', c.id).then(r => (channelSynced(r.overwrites, ows) ? c : null)).catch(() => null)))
      .then(list => { if (alive) setSyncedChannels(list.filter((x): x is Channel => !!x)) })
    return () => { alive = false }
  }, [kind, inCat, ows])

  // 대상 목록: @everyone → 역할(높은 순) → 사람
  const subjects: Subject[] = useMemo(() => {
    const out: Subject[] = []
    if (everyone) out.push({ kind: 'role', id: everyone.id })
    const have = new Set<string>(out.map(s => `${s.kind}:${s.id}`))
    const add = (s: Subject) => { const k = `${s.kind}:${s.id}`; if (!have.has(k)) { have.add(k); out.push(s) } }
    const rs = [...(ows || []), ...pending.map(p => ({ subject_kind: p.kind, subject_id: p.id }))]
    rs.filter(o => o.subject_kind === 'role')
      .map(o => roles.find(r => r.id === o.subject_id))
      .filter((r): r is NonNullable<typeof r> => !!r && !r.is_default)
      .sort((a, b) => b.position - a.position)
      .forEach(r => add({ kind: 'role', id: r.id }))
    rs.filter(o => o.subject_kind === 'user').forEach(o => add({ kind: 'user', id: o.subject_id }))
    return out
  }, [ows, pending, roles, everyone])
  const subKey = (s: Subject) => `${s.kind}:${s.id}`
  const sel = subjects.find(s => subKey(s) === selKey) ?? subjects.find(s => s.kind !== 'role' || s.id !== everyone?.id) ?? subjects[0] ?? null
  const owOf = (s: Subject | null) => (s ? (ows || []).find(o => o.subject_kind === s.kind && o.subject_id === s.id) : undefined)
  const nameOf = (s: Subject) => {
    if (s.kind === 'role') { const r = roles.find(x => x.id === s.id); return r?.is_default ? '@everyone' : r?.name ?? s.id }
    const u = allUsers.find(x => x.id === s.id); return u?.display_name || u?.username || s.id
  }
  useEffect(() => { if (sel?.kind === 'user') void loadUserRoles(sel.id) }, [sel?.kind, sel?.id])

  async function setTri(s: Subject, bit: number, v: UiTriValue) {
    const cur = owOf(s) ?? { allow: 0, deny: 0 }
    const next = applyTri(cur, bit, v)
    const prev = ows
    const others = (ows || []).filter(o => !(o.subject_kind === s.kind && o.subject_id === s.id))
    setOws([...others, { subject_kind: s.kind, subject_id: s.id, ...next }])
    try { await putOverwrite(target, targetId, s.kind, s.id, next.allow, next.deny) } catch (e) {
      setOws(prev)
      addToast('error', errorText(e, t('chat.settings.perm.saveFail')))
    }
  }
  async function removeSubject(s: Subject) {
    setPending(p => p.filter(x => subKey(x) !== subKey(s)))
    if (!owOf(s)) return
    try { await deleteOverwrite(target, targetId, s.kind, s.id); await reload() } catch (e) { addToast('error', errorText(e, t('chat.settings.perm.saveFail'))) }
  }
  async function syncWithCategory() {
    try {
      for (const o of ows || []) await deleteOverwrite('channels', targetId, o.subject_kind, o.subject_id)
      await reload()
      addToast('success', t('chat.settings.perm.syncDone'))
    } catch (e) { addToast('error', errorText(e, t('chat.settings.perm.saveFail'))); void reload() }
  }
  function addSubject(s: Subject) {
    if (!subjects.some(x => subKey(x) === subKey(s))) setPending(p => [...p, s])
    setSelKey(subKey(s)); setPicker(false)
    if (mobile) setMobileTarget(true)
  }

  const groups = buildPermGroups(catalog, 'channel')
  const evOw = everyone ? owOf({ kind: 'role', id: everyone.id }) : undefined
  const isPrivate = !!evOw && hasBit(evOw.deny, PERM.VIEW_CHANNEL)
  const editable = !loadErr
  const catName = categories.find(c => c.id === catId)?.name ?? ''
  const where = kind === 'channel' ? t('chat.settings.perm.whereChannel') : t('chat.settings.perm.whereCategory')

  const title = kind === 'channel' ? t('chat.settings.perm.titleChannel', { name: chanLabel(channel) || targetId }) : t('chat.settings.perm.titleCategory', { name: category?.name ?? '' })
  const sub = kind === 'channel' ? t('chat.settings.perm.subChannel') : t('chat.settings.perm.subCategory')

  const banner = (() => {
    if (loadErr) return <SettingsBanner tone="info" icon="lock">{loadErr}</SettingsBanner>
    if (ows === null) return null
    if (kind === 'channel') {
      if (!catId) return null
      return channelSynced(ows, catOws)
        ? <SettingsBanner tone="info" icon="refresh">{t('chat.settings.perm.synced', { cat: catName })}</SettingsBanner>
        : <SettingsBanner tone="warn" icon="unlock" action={t('chat.settings.perm.sync')} onAction={() => void syncWithCategory()}>{t('chat.settings.perm.notSynced', { cat: catName })}</SettingsBanner>
    }
    if (syncedChannels === null) return null
    const names = syncedChannels.map(c => (c.is_voice ? c.name : chanLabel(c))).join(' · ')
    return <SettingsBanner tone="info" icon="refresh">{syncedChannels.length ? t('chat.settings.perm.catSynced', { n: syncedChannels.length, names }) : t('chat.settings.perm.catSyncedNone')}</SettingsBanner>
  })()

  const privateRow = everyone && (
    <div className="flex items-center gap-3 rounded-lg border border-border p-3">
      <div className="min-w-0 flex-1">
        <p className={mobile ? 'text-[16px]' : 'text-[14px] font-medium'}>{kind === 'channel' ? t('chat.settings.perm.private') : t('chat.settings.perm.privateCat')}</p>
        <p className="text-[12px] text-muted-foreground">{t('chat.settings.perm.privateDesc')}</p>
      </div>
      <UiSwitch
        ariaLabel={kind === 'channel' ? t('chat.settings.perm.private') : t('chat.settings.perm.privateCat')}
        modelValue={isPrivate}
        disabled={!editable || ows === null || !canGrantBit(myBits, PERM.VIEW_CHANNEL, isGlobalAdmin)}
        onUpdateModelValue={v => void setTri({ kind: 'role', id: everyone.id }, PERM.VIEW_CHANNEL, v ? 'deny' : 'inherit')}
      />
    </div>
  )

  // 결과 요약
  const summary = sel && ows && (() => {
    const bits = effectiveFor(
      { kind: sel.kind, id: sel.id, roleIds: sel.kind === 'user' ? userRoles[sel.id] || [] : undefined },
      roles, ows, kind === 'channel' ? catOws : [],
    )
    const items = SUMMARY_BITS.map(b => `${t(`chat.settings.perm.sum.${b.key}`)} ${hasBit(bits, b.bit) ? '✓' : '✕'}`).join(' · ')
    const lead = sel.kind === 'user' ? t('chat.settings.perm.canDoUser', { where }) : t('chat.settings.perm.canDoRole', { where })
    return (
      <p className="mt-3 rounded-lg bg-card px-3 py-2 text-[13px]" aria-live="polite">
        <b className="font-semibold">{nameOf(sel)}</b> <span className="text-muted-foreground">{lead}</span> {items}
      </p>
    )
  })()

  const rows = sel && (
    <div className="flex flex-col">
      {groups.map(g => (
        <section key={g.key}>
          <h4 className={cn('font-semibold text-muted-foreground', mobile ? 'px-1 pb-1 pt-4 text-[13px]' : 'pb-1 pt-3 text-[12px]')}>{pt.group(g.key)}</h4>
          {g.rows.map(r => {
            const warn = r.dangerous ? pt.warn(r.name) : ''
            const wid = `ow-w-${r.name}`
            const grantable = canGrantBit(myBits, r.bit, isGlobalAdmin)
            return (
              <div key={r.name} data-perm={r.name} className={cn('flex items-center gap-4 border-b border-border', mobile ? 'min-h-14 px-1 py-1.5' : 'py-2')}>
                <div className="min-w-0 flex-1">
                  <p className={mobile ? 'text-[16px]' : 'text-[14px] font-medium'}>{pt.name(r.name)}</p>
                  {warn && <p id={wid} className={cn('text-warning', mobile ? 'text-[13px]' : 'text-[12px]')}>{warn}</p>}
                  {!grantable && editable && <p className="text-[12px] text-muted-foreground">{t('chat.settings.matrix.cantGrant')}</p>}
                </div>
                <UiTriToggle
                  size={mobile ? 'touch' : 'md'}
                  ariaLabel={pt.name(r.name)}
                  aria-describedby={warn ? wid : undefined}
                  modelValue={triOf(owOf(sel), r.bit)}
                  disabled={!editable || !grantable}
                  onUpdateModelValue={v => void setTri(sel, r.bit, v)}
                />
              </div>
            )
          })}
        </section>
      ))}
    </div>
  )

  const subjectRow = (s: Subject, isMob: boolean) => {
    const isSel = sel && subKey(s) === subKey(sel)
    const role = s.kind === 'role' ? roles.find(r => r.id === s.id) : undefined
    const u = s.kind === 'user' ? allUsers.find(x => x.id === s.id) : undefined
    const removable = editable && !role?.is_default
    return (
      <div key={subKey(s)} className="group relative">
        <button
          type="button"
          aria-pressed={!isMob ? !!isSel : undefined}
          className={cn(
            'relative flex w-full items-center gap-2 rounded-lg px-2 text-left text-[15px] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
            isMob ? 'min-h-14 border-b border-border text-[16px]' : 'h-9',
            !isMob && isSel ? 'bg-overlay-selected' : 'hover:bg-overlay-hover',
          )}
          onClick={() => { setSelKey(subKey(s)); if (isMob) setMobileTarget(true) }}
        >
          {u ? <UiAvatar src={u.avatar_url} fallback={(u.display_name || u.username).charAt(0)} textSize={10} className="h-6 w-6" /> : <RoleDot index={role?.is_default ? 0 : roleColorIndex(role?.color)} />}
          <span className="min-w-0 flex-1 truncate">{nameOf(s)}</span>
          {isMob && <UiIcon name="chevron-right" className="h-5 w-5 text-muted-foreground" />}
        </button>
        {removable && !isMob && (
          <UiIconButton
            icon="close"
            label={t('chat.settings.perm.removeSubject', { name: nameOf(s) })}
            size="sm"
            className="absolute right-0.5 top-0.5 h-8 w-8 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => void removeSubject(s)}
          />
        )}
      </div>
    )
  }

  const pickerEl = picker && (
    <UserPicker
      title={t('chat.settings.perm.addSubject')}
      exclude={new Set(subjects.filter(s => s.kind === 'user').map(s => s.id))}
      onPick={uid => addSubject({ kind: 'user', id: uid })}
      onClose={() => setPicker(false)}
      extra={q => {
        const rs = roles.filter(r => !r.is_default && !subjects.some(s => s.kind === 'role' && s.id === r.id) && (!q || r.name.toLowerCase().includes(q)))
          .sort((a, b) => b.position - a.position)
        if (!rs.length) return null
        return (
          <ul aria-label={t('chat.settings.picker.roles')} className="flex flex-col border-b border-border pb-2">
            {rs.map(r => (
              <li key={r.id}>
                <button type="button" className="flex min-h-11 w-full items-center gap-3 rounded-md px-2 text-left hover:bg-overlay-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" onClick={() => addSubject({ kind: 'role', id: r.id })}>
                  <RoleDot index={roleColorIndex(r.color)} />
                  <span className="min-w-0 flex-1 truncate text-[14px]">{r.name}</span>
                  <span className="text-[12px] text-muted-foreground">{t('chat.settings.picker.role')}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      }}
    />
  )

  if (mobile) {
    if (mobileTarget && sel) {
      return (
        <div className="flex h-full flex-col">
          <MobileHeader title={`${kind === 'channel' ? chanLabel(channel) : category?.name ?? ''} · ${nameOf(sel)}`} onBack={() => setMobileTarget(false)} />
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            <p className="px-1 pb-1 pt-2 text-[13px] font-semibold text-muted-foreground">{t('chat.settings.perm.legend')}</p>
            {rows}
            {summary}
          </div>
        </div>
      )
    }
    return (
      <div className="flex h-full flex-col">
        <MobileHeader title={title} onBack={() => openChatSettings(kind === 'channel' ? 'channel-perm' : 'category-perm', null)} addLabel={editable ? t('chat.settings.perm.addSubject') : undefined} onAdd={() => setPicker(true)} />
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-2">
          {banner}
          {privateRow}
          <div>{subjects.map(s => subjectRow(s, true))}</div>
        </div>
        {pickerEl}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <SettingsHeader title={title} sub={sub} />
      {banner}
      <div className="flex flex-col gap-4">
        {privateRow}
        <div className="flex gap-6">
          <div className="flex shrink-0 flex-col gap-0.5" style={{ width: 220 }}>
            <div className="flex items-center pb-2">
              <p className="flex-1 text-[12px] font-semibold text-muted-foreground">{t('chat.settings.perm.subjects')}</p>
              <UiIconButton icon="plus" label={t('chat.settings.perm.addSubject')} size="sm" disabled={!editable} onClick={() => setPicker(true)} />
            </div>
            {subjects.map(s => subjectRow(s, false))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            {sel && (
              <p className="pb-2 text-[13px]">
                <b className="font-semibold">{nameOf(sel)}</b> <span className="text-muted-foreground">— {t('chat.settings.perm.paneHead', { where })}</span>
              </p>
            )}
            {ows === null ? <p className="py-6 text-[13px] text-muted-foreground">{t('common.loading')}</p> : rows}
            {summary}
          </div>
        </div>
      </div>
      {pickerEl}
    </div>
  )
}

/** a & b (32비트 넘는 값) */
function bitsAnd(a: number, b: number): number {
  let r = 0
  for (let i = 0, v = 1; i <= 40; i++, v *= 2) if (hasBit(a, v) && hasBit(b, v)) r += v
  return r
}

export default ChannelOverwrites
